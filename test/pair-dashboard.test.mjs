import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allocateDirectSwapToBins,
  allocateSwapToBins,
  currentPairPositionConfigs,
  directLiquidityForCapital,
  directPairMarketHistory,
  optimizeDirectRange,
  pairSpyMarketHistory,
  directPairPriceAtTick,
  evaluateComparisonDecision,
  feeVelocity,
  pairPriceAtTick,
  positionTokenAmounts,
  snapshotWindow,
  sqrtRatioAtTick,
  v3HumanPriceFromSqrt,
} from '../dashboard/lib/collector.mjs'
import {
  buildPortfolioView,
  portfolioInternals,
  timeWeightedPrice,
  totalGasWei,
  uniqueTransactions,
} from '../dashboard/lib/portfolio.mjs'

const Q96 = 1n << 96n

test('current pair positions come from the manifest while config only overrides presentation', () => {
  const positions = currentPairPositionConfigs(
    [
      { tokenId: '10', label: 'configured active', role: 'coverage', tickLower: 1, tickUpper: 2 },
      { tokenId: '11', label: 'retired config', role: 'base', tickLower: 3, tickUpper: 4 },
    ],
    {
      positions: [
        {
          tokenId: '10',
          label: 'manifest active',
          role: 'historical',
          poolKind: 'pair-spy',
          tickLower: 100,
          tickUpper: 200,
          lastKnownLiquidity: '1',
        },
        {
          tokenId: '11',
          label: 'manifest empty',
          role: 'base',
          poolKind: 'pair-spy',
          tickLower: 300,
          tickUpper: 400,
          lastKnownLiquidity: '0',
        },
        {
          tokenId: '12',
          label: 'chain-discovered active',
          role: 'unclassified',
          poolKind: 'pair-spy',
          tickLower: 500,
          tickUpper: 600,
          lastKnownLiquidity: '2',
        },
        {
          tokenId: '13',
          label: 'other pool',
          role: 'direct',
          poolKind: 'pair-usdg',
          tickLower: 700,
          tickUpper: 800,
          lastKnownLiquidity: '3',
        },
      ],
    },
  )
  assert.deepEqual(positions, [
    { tokenId: '10', label: 'configured active', role: 'coverage', tickLower: 100, tickUpper: 200 },
    { tokenId: '12', label: 'chain-discovered active', role: 'unclassified', tickLower: 500, tickUpper: 600 },
  ])
})

test('missing historical marks stay unknown instead of becoming zero-priced capital', () => {
  const missing = portfolioInternals.valueSupplyEvent(
    {
      amounts: { pair: 100 },
      valueUsdg: null,
      mark: { pairUsdg: null },
    },
    { pairUsdg: 0.01 },
  )
  assert.equal(missing.value, 1)
  assert.equal(missing.quality, 'current_replacement_not_cost')

  const marked = portfolioInternals.valueSupplyEvent(
    {
      amounts: { pair: 100 },
      valueUsdg: null,
      mark: { pairUsdg: 0.008 },
    },
    { pairUsdg: 0.01 },
  )
  assert.equal(marked.value, 0.8)
  assert.equal(marked.quality, 'event_mark')
})

test('PAIR/SPY current range uses the live SPY mark, not its historical entry range', () => {
  const range = portfolioInternals.rangeFor(
    {
      poolKind: 'pair-spy',
      tickLower: 0,
      tickUpper: 200,
      entryRange: { low: 1, high: 2, quality: 'recorded_at_entry' },
    },
    { spyUsdg: 100 },
  )
  assert.equal(range.quality, 'live_spy_mark')
  assert.equal(range.high, 100)
  assert.ok(range.low < range.high)
})

test('time-weighted price reports full and partial lifecycle coverage', () => {
  const history = {
    fromTime: '2026-09-05T00:00:00.000Z',
    toTime: '2026-09-05T00:00:20.000Z',
    points: [
      { at: '2026-09-05T00:00:00.000Z', pairUsdg: 1 },
      { at: '2026-09-05T00:00:10.000Z', pairUsdg: 3 },
    ],
  }
  const full = timeWeightedPrice(history, history.fromTime, history.toTime)
  assert.equal(full.pairUsdg, 2)
  assert.equal(full.quality, 'DERIVED')
  assert.equal(full.coveragePct, 100)

  const partial = timeWeightedPrice(history, '2026-09-04T23:59:50.000Z', history.toTime)
  assert.equal(partial.pairUsdg, 2)
  assert.equal(partial.quality, 'PARTIAL')
  assert.ok(Math.abs(partial.coveragePct - 66.6666666667) < 1e-6)
})

test('market histories preserve pair and quote-token price changes', () => {
  const pairSpy = pairSpyMarketHistory({
    pairSwaps: [{ block_number: 2, transaction_index: 0, log_index: 0, timestamp: 10, tick: 100 }],
    marks: [{ block_number: 3, transaction_index: 0, log_index: 0, timestamp: 20, spy_usdg: 200 }],
    anchorTime: 0,
    anchorPairSqrt: Q96.toString(),
    anchorSpyUsdg: 100,
    toTime: 30,
  })
  assert.equal(pairSpy.points[0].pairUsdg, 100)
  assert.ok(pairSpy.points[1].pairUsdg < 100)
  assert.ok(pairSpy.points[2].pairUsdg > 190)

  const direct = directPairMarketHistory({
    swaps: [{ timestamp: 10, tick: 100, block_number: 2, transaction_index: 0, log_index: 0 }],
    anchorTime: 0,
    anchorSqrt: Q96.toString(),
    toTime: 20,
    token0Decimals: 18,
    token1Decimals: 18,
  })
  assert.equal(direct.points[0].pairUsdg, 1)
  assert.ok(direct.points[1].pairUsdg < 1)
})

test('direct range optimizer trades volume coverage against market-liquidity competition', () => {
  const currentTick = 325_000
  const spacing = 100
  const ticks = Array.from({ length: 61 }, (_, index) => 322_000 + index * spacing)
  const baseBins = ticks.map((tickLower) => ({
    tickLower,
    tickUpper: tickLower + spacing,
    priceLowUsdg: directPairPriceAtTick(tickLower + spacing),
    priceHighUsdg: directPairPriceAtTick(tickLower),
    priceMidUsdg: directPairPriceAtTick(tickLower + spacing / 2),
    marketLiquidity: String(tickLower >= 324_600 && tickLower <= 325_000 ? 10n ** 20n : 10n ** 18n),
  }))
  const makeWindow = (id, hours) => ({
    id,
    effectiveFromTime: new Date(Date.now() - hours * 3_600_000).toISOString(),
    toTime: new Date().toISOString(),
    bins: baseBins.map((bin) => ({
      ...bin,
      volumeUsdg: bin.tickLower >= 324_000 && bin.tickLower < 326_000 ? 100 : 1,
      grossFeeUsdg: bin.tickLower >= 324_000 && bin.tickLower < 326_000 ? 1 : 0.01,
    })),
  })
  const result = optimizeDirectRange({
    currentTick,
    pairUsdg: directPairPriceAtTick(currentTick),
    tickSpacing: spacing,
    capitalUsdg: 170,
    baseBins,
    windows: { '1h': makeWindow('1h', 1), '6h': makeWindow('6h', 6) },
    minSpanTicks: 2_000,
    maxSpanTicks: 3_000,
  })
  assert.ok(result.recommendation)
  assert.ok(result.recommendation.tickLower <= currentTick)
  assert.ok(result.recommendation.tickUpper > currentTick)
  assert.ok(result.recommendation.metrics['6h'].volumeCoveragePct > 50)
  assert.equal(result.topVolumeBins6h.length, 8)
})

test('PAIR/USDG price follows inverse PAIR/SPY tick convention', () => {
  assert.equal(pairPriceAtTick(750, 0), 750)
  assert.ok(pairPriceAtTick(750, 110_000) < pairPriceAtTick(750, 109_800))
})

test('V3 sqrt price converts raw 18/6 decimals to human SPY/USDG', () => {
  const oneUsdgPerSpy = Q96 / 1_000_000n
  assert.ok(Math.abs(v3HumanPriceFromSqrt(oneUsdgPerSpy) - 1) < 0.000001)
})

test('integer TickMath and position amounts cover below, inside and above range', () => {
  assert.equal(sqrtRatioAtTick(0), Q96)
  assert.throws(() => sqrtRatioAtTick(887_273), RangeError)

  const liquidity = 10n ** 18n
  const below = positionTokenAmounts(liquidity, sqrtRatioAtTick(-201), -200, 200)
  const inside = positionTokenAmounts(liquidity, sqrtRatioAtTick(0), -200, 200)
  const above = positionTokenAmounts(liquidity, sqrtRatioAtTick(201), -200, 200)
  assert.ok(below.amount0 > 0n)
  assert.equal(below.amount1, 0n)
  assert.ok(inside.amount0 > 0n)
  assert.ok(inside.amount1 > 0n)
  assert.equal(above.amount0, 0n)
  assert.ok(above.amount1 > 0n)
})

test('swap allocation preserves input notional and fee for a one-bin swap', () => {
  const bins = new Map()
  const ending = allocateSwapToBins(
    {
      sqrt_price: Q96.toString(),
      amount0: (10n * 10n ** 18n).toString(),
      amount1: (-20n * 10n ** 18n).toString(),
      tick: 0,
      fee: 10_000,
    },
    Number(Q96),
    200,
    2,
    bins,
  )

  assert.equal(ending, Number(Q96))
  assert.equal(bins.size, 1)
  const item = [...bins.values()][0]
  assert.ok(Math.abs(item.volumeUsdg - 20) < 1e-9)
  assert.ok(Math.abs(item.grossFeeUsdg - 0.2) < 1e-9)
  assert.equal(item.spyInput, 10)
  assert.equal(item.pairInput, 0)
})

test('direct USDG/PAIR price and same-capital liquidity preserve decimal orientation', () => {
  const tick = 321_700
  const pairUsdg = directPairPriceAtTick(tick)
  assert.ok(pairUsdg > 0.009 && pairUsdg < 0.012)
  assert.ok(directPairPriceAtTick(tick + 100) < pairUsdg)

  const position = directLiquidityForCapital({
    capitalUsdg: 100,
    pairUsdg,
    priceLowUsdg: pairUsdg * 0.8,
    priceHighUsdg: pairUsdg * 1.2,
    currentTick: tick,
    tickSpacing: 100,
  })
  assert.equal(position.tickLower % 100, 0)
  assert.equal(position.tickUpper % 100, 0)
  assert.ok(position.inRange)
  assert.ok(position.liquidity > 0)
  assert.ok(Math.abs(position.amount0 + position.amount1 * pairUsdg - 100) < 1e-8)
})

test('direct-pool swap allocation values USDG input and normalizes fee', () => {
  const bins = new Map()
  allocateDirectSwapToBins(
    {
      sqrt_price: Q96.toString(),
      amount0: (10n * 10n ** 6n).toString(),
      amount1: (-1n).toString(),
      tick: 0,
      fee: 30_000,
    },
    Number(Q96),
    300,
    bins,
  )
  const item = [...bins.values()][0]
  assert.ok(Math.abs(item.volumeUsdg - 10) < 1e-9)
  assert.ok(Math.abs(item.grossFeeUsdg - 0.3) < 1e-9)
})

test('fee velocity annualizes the observed window without relabeling it realized APR', () => {
  const metric = feeVelocity({
    estimatedFeeUsdg: 1,
    capitalUsdg: 100,
    fromTime: '2026-09-04T00:00:00.000Z',
    toTime: '2026-09-04T06:00:00.000Z',
  })
  assert.equal(metric.durationSeconds, 21_600)
  assert.equal(metric.hourlyFeeUsdg, 1 / 6)
  assert.equal(metric.dailyRatePct, 4)
  assert.equal(metric.annualizedGrossPct, 1_460)
})

test('decision gate never promotes an incomplete window to a test', () => {
  const metric = (hourlyFeeUsdg, relativeLeadPct, partialBeforeAnchor = false) => ({
    label: '窗口',
    hourlyFeeUsdg,
    relativeLeadPct,
    partialBeforeAnchor,
  })
  const baseRow = { windows: { '6h': metric(10, null), '24h': metric(10, null, true) } }
  const candidateRows = [
    {
      id: 'candidate',
      poolId: '0x1',
      label: 'PAIR / USDG',
      feeLabel: '1%',
      windows: { '6h': metric(14, 40), '24h': metric(15, 50, true) },
    },
  ]
  const decision = evaluateComparisonDecision({
    baseRow,
    candidateRows,
    confirmationWindows: ['6h', '24h'],
    minimumLeadPct: 30,
    maximumBreakEvenHours: 8,
    testFraction: 0.2,
    migrationCostUsdg: 1,
  })
  assert.equal(decision.signal, 'BUILDING_EVIDENCE')
})

test('decision gate requires both sustained lead and migration payback', () => {
  const metric = (hourlyFeeUsdg, relativeLeadPct) => ({
    label: '窗口',
    hourlyFeeUsdg,
    relativeLeadPct,
    partialBeforeAnchor: false,
  })
  const baseRow = { windows: { '6h': metric(10, null), '24h': metric(10, null) } }
  const candidateRows = [
    {
      id: 'candidate',
      poolId: '0x1',
      label: 'PAIR / USDG',
      feeLabel: '1%',
      windows: { '6h': metric(14, 40), '24h': metric(13.5, 35) },
    },
  ]
  const eligible = evaluateComparisonDecision({
    baseRow,
    candidateRows,
    confirmationWindows: ['6h', '24h'],
    minimumLeadPct: 30,
    maximumBreakEvenHours: 8,
    testFraction: 0.2,
    migrationCostUsdg: 1,
  })
  assert.equal(eligible.signal, 'TEST_ELIGIBLE')

  const expensive = evaluateComparisonDecision({
    baseRow,
    candidateRows,
    confirmationWindows: ['6h', '24h'],
    minimumLeadPct: 30,
    maximumBreakEvenHours: 8,
    testFraction: 0.2,
    migrationCostUsdg: 10,
  })
  assert.equal(expensive.signal, 'HOLD_SPY')
})

test('snapshot API emits one selected window and compact window summaries', () => {
  const snapshot = {
    generatedAt: '2026-09-04T00:00:00.000Z',
    windows: {
      '24h': {
        id: '24h',
        label: '24 小时',
        effectiveFromTime: '2026-09-03T00:00:00.000Z',
        partialBeforeAnchor: false,
        swapEvents: 3,
        totals: { volumeUsdg: 42 },
        bins: [{ tickLower: 1 }],
      },
      '7d': {
        id: '7d',
        label: '7 天',
        effectiveFromTime: '2026-09-01T00:00:00.000Z',
        partialBeforeAnchor: true,
        swapEvents: 5,
        totals: { volumeUsdg: 88 },
        bins: [{ tickLower: 2 }],
      },
    },
  }

  const selected = snapshotWindow(snapshot, '7d')
  assert.equal(selected.selectedWindow, '7d')
  assert.deepEqual(selected.analytics.bins, [{ tickLower: 2 }])
  assert.equal(selected.windows, undefined)
  assert.equal(selected.windowSummaries['24h'].bins, undefined)

  assert.equal(snapshotWindow(snapshot, 'not-a-window').selectedWindow, '24h')
})

test('portfolio transaction ledger deduplicates by canonical hash before summing gas', () => {
  const transactions = [
    { hash: '0xaaa', status: 'success', gasCostWei: '100', evidenceRank: 1, label: 'local' },
    { hash: '0xAAA', status: 'success', gasCostWei: '125', evidenceRank: 5, label: 'canonical' },
    { hash: '0xbbb', status: 'reverted', gasCostWei: '25', evidenceRank: 5 },
  ]
  const unique = uniqueTransactions(transactions)
  assert.equal(unique.length, 2)
  assert.equal(unique.find((item) => item.hash.toLowerCase() === '0xaaa').label, 'canonical')
  assert.equal(totalGasWei(transactions), 150n)
})

test('portfolio keeps cumulative fees separate from current principal after reinvestment', () => {
  const manifest = {
    schemaVersion: 1,
    generatedAt: '2026-09-05T00:00:00.000Z',
    audit: { inventoryStatus: 'verified_complete_at_safe_block', localIds: ['1', '2'], chainIds: ['1', '2'] },
    coverage: { claimedFees: 'partial' },
    positions: [
      {
        tokenId: '1',
        label: 'active',
        poolKind: 'pair-spy',
        poolLabel: 'PAIR / SPY',
        tickLower: 0,
        tickUpper: 200,
        supplyEvents: [{ amounts: { spy: 1, pair: 10 }, valueUsdg: 110 }],
      },
      {
        tokenId: '2',
        label: 'retired',
        poolKind: 'pair-spy',
        poolLabel: 'PAIR / SPY',
        tickLower: 0,
        tickUpper: 200,
        supplyEvents: [],
      },
    ],
    feeClaims: [{ id: 'fee', sourceTokenIds: ['1'], amounts: { pair: 5 } }],
    transactions: [
      { hash: '0x1', status: 'success', gasCostWei: '1000000000000000', valueEth: 0.1, capitalFlow: 'lp_directed' },
    ],
    lineages: [],
  }
  const view = buildPortfolioView({
    manifest,
    detailedPositions: [
      {
        tokenId: '1',
        status: 'active',
        owner: '0x1',
        liquidity: '1',
        dataQuality: 'verified',
        inRange: true,
        principal: { spy: 0.5, pair: 60, usdg: 110 },
        accruedFees: { spy: 0, pair: 2, usdg: 2 },
      },
    ],
    chainStates: [
      { tokenId: '1', status: 'active', owner: '0x1', liquidity: '1', dataQuality: 'verified' },
      { tokenId: '2', status: 'empty', owner: '0x1', liquidity: '0', dataQuality: 'verified' },
    ],
    prices: { spyUsdg: 100, pairUsdg: 1, ethUsdg: 2_000, oneUsdg: 0.01 },
    walletBalances: { eth: 0.01, spy: 0, pair: 0, usdg: 0, one: 0 },
    safeBlock: { number: 10n, time: '2026-09-05T00:00:00.000Z' },
  })
  assert.equal(view.totals.lifecycleNfts, 2)
  assert.equal(view.totals.activeNfts, 1)
  assert.equal(view.totals.emptyNfts, 1)
  assert.equal(view.totals.activePrincipalUsdg, 110)
  assert.equal(view.totals.recordedClaimedFeesCurrentMarkUsdg, 5)
  assert.equal(view.totals.unclaimedFeesUsdg, 2)
  assert.equal(view.totals.recordedLifetimeFeesCurrentMarkUsdg, 7)
  assert.equal(view.totals.gasEth, 0.001)
  assert.equal(view.accountingBoundary.aggregateCashInvested, 'PARTIAL')
})

test('closed LP price ledger separates entry, TWAP, implicit sale and fee-adjusted result', () => {
  const manifest = {
    schemaVersion: 1,
    generatedAt: '2026-09-05T00:00:20.000Z',
    audit: { inventoryStatus: 'verified_complete_at_safe_block', localIds: ['9'], chainIds: ['9'] },
    coverage: { claimedFees: 'partial' },
    positions: [
      {
        tokenId: '9',
        label: 'closed',
        poolKind: 'pair-usdg',
        poolId: '0xpool',
        poolLabel: 'PAIR / USDG',
        tickLower: 0,
        tickUpper: 200,
        supplyEvents: [
          {
            at: '2026-09-05T00:00:00.000Z',
            amounts: { pair: 10, usdg: 10 },
            mark: { pairUsdg: 1, quality: 'canonical_entry_mark' },
          },
        ],
        exit: {
          at: '2026-09-05T00:00:20.000Z',
          transactionHash: '0xexit',
          mark: { pairUsdg: 2, quality: 'canonical_exit_mark' },
          grossAmounts: { pair: 0, usdg: 20 },
          principalAmounts: { pair: 0, usdg: 20 },
          terminalFeeAmounts: { pair: 0, usdg: 0 },
          amountQuality: 'verified_receipt_delta',
        },
      },
    ],
    feeClaims: [
      {
        id: 'fee',
        sourceTokenIds: ['9'],
        at: '2026-09-05T00:00:10.000Z',
        transactionHash: '0xfee',
        amounts: { usdg: 2 },
        mark: { pairUsdg: 1.5, quality: 'canonical_mark' },
      },
    ],
    transactions: [],
    lineages: [],
  }
  const view = buildPortfolioView({
    manifest,
    chainStates: [{ tokenId: '9', status: 'empty', owner: '0x1', liquidity: '0', dataQuality: 'verified' }],
    prices: { pairUsdg: 2, spyUsdg: 100 },
    marketHistories: {
      '0xpool': {
        fromTime: '2026-09-05T00:00:00.000Z',
        toTime: '2026-09-05T00:00:20.000Z',
        points: [
          { at: '2026-09-05T00:00:00.000Z', pairUsdg: 1 },
          { at: '2026-09-05T00:00:10.000Z', pairUsdg: 2 },
        ],
      },
    },
    safeBlock: { number: 10n, time: '2026-09-05T00:00:20.000Z' },
  })
  const ledger = view.positions[0].priceLedger
  assert.equal(ledger.entry.pairUsdg, 1)
  assert.equal(ledger.holding.pairUsdg, 1.5)
  assert.equal(ledger.endpoint.pairUsdg, 2)
  assert.equal(ledger.implicitExecution.side, 'SELL')
  assert.equal(ledger.implicitExecution.pairUsdg, 1)
  assert.equal(ledger.implicitExecution.feeAdjustedPairUsdg, 1.2)
  assert.equal(ledger.implicitExecution.feeAdjustedQuality, 'PARTIAL')
  assert.equal(ledger.markedResult.pnlUsdg, 2)
  assert.equal(ledger.markedResult.pnlPct, 10)
})
