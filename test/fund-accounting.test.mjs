import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dedupeFeeClaims,
  deriveImplicitIncreaseFees,
  deriveLpInventoryConversion,
  hasFeeClaim,
  isDirectExternalTokenTransfer,
  reconcilePurchaseBatch,
  sumAmounts,
  toCsv,
  valueAmounts,
} from '../lib/fund-accounting.mjs'

test('amount aggregation and valuation preserve unknown non-zero assets', () => {
  const amounts = sumAmounts({ eth: 0.1, pair: 100 }, { spy: 0.25, pair: -20 })
  assert.deepEqual(amounts, { eth: 0.1, spy: 0.25, pair: 80, usdg: 0, one: 0 })

  const valued = valueAmounts(amounts, { eth: 2_500, spy: 800, pair: null })
  assert.equal(valued.valueUsdg, 450)
  assert.deepEqual(valued.unknownAssets, ['pair'])
})

test('fee claims deduplicate only the same transaction and source NFT', () => {
  const claims = dedupeFeeClaims([
    { id: 'weak', transactionHash: '0xABC', sourceTokenIds: ['1'], evidenceRank: 1 },
    { id: 'strong', transactionHash: '0xabc', sourceTokenIds: ['1'], evidenceRank: 5 },
    { id: 'other-nft', transactionHash: '0xabc', sourceTokenIds: ['2'], evidenceRank: 1 },
  ])
  assert.deepEqual(
    claims.map((claim) => claim.id),
    ['other-nft', 'strong'],
  )
  assert.equal(hasFeeClaim(claims, '0xAbC', 1), true)
  assert.equal(hasFeeClaim(claims, '0xAbC', 3), false)
})

test('owner purchase reconciliation keeps assertions separate from chain execution', () => {
  const transferByTransaction = new Map([
    ['0xa', { spy: -0.5, pair: 10_000 }],
    ['0xb', { usdg: -100, pair: 2_000 }],
  ])
  const result = reconcilePurchaseBatch({
    transactionHashes: ['0xA', '0xB'],
    transferByTransaction,
    gasEthByTransaction: new Map([
      ['0xa', 0.001],
      ['0xb', 0.002],
    ]),
    costUsdgByTransaction: new Map([
      ['0xa', 400],
      ['0xb', 100],
    ]),
    assertedNotionalUsdg: 550,
    assertedAveragePairUsdg: 0.05,
  })
  assert.equal(result.pairBought, 12_000)
  assert.equal(result.observedCostUsdg, 500)
  assert.equal(result.observedAveragePairUsdg, 500 / 12_000)
  assert.equal(result.assertedPairQuantity, 11_000)
  assert.ok(Math.abs(result.pairQuantityDifferencePct - 9.0909090909) < 1e-9)
  assert.equal(result.gasEth, 0.003)
})

test('only direct token transfers cross the external-capital boundary', () => {
  const token = '0x0000000000000000000000000000000000000001'
  assert.equal(
    isDirectExternalTokenTransfer({ success: true, to: token, method: 'transfer' }, token.toUpperCase()),
    true,
  )
  assert.equal(
    isDirectExternalTokenTransfer(
      { success: true, to: '0x0000000000000000000000000000000000000002', method: 'dagSwapTo' },
      token,
    ),
    false,
  )
  assert.equal(isDirectExternalTokenTransfer({ success: false, to: token, method: 'transfer' }, token), false)
})

test('LP inventory conversion derives buys and sells without counting fees', () => {
  const buy = deriveLpInventoryConversion({
    supplied: { spy: 1, pair: 100 },
    endpointInventory: { spy: 0.5, pair: 200 },
    quoteAsset: 'spy',
    quoteUsdg: 800,
    complete: true,
  })
  assert.equal(buy.side, 'BUY')
  assert.equal(buy.pairDelta, 100)
  assert.equal(buy.priceInQuote, 0.005)
  assert.equal(buy.pairUsdg, 4)

  const sell = deriveLpInventoryConversion({
    supplied: { usdg: 100, pair: 100 },
    endpointInventory: { usdg: 125, pair: 50 },
    quoteAsset: 'usdg',
    quoteUsdg: 1,
    complete: true,
  })
  assert.equal(sell.side, 'SELL')
  assert.equal(sell.pairUsdg, 0.5)

  assert.deepEqual(
    deriveLpInventoryConversion({
      supplied: {},
      endpointInventory: null,
      quoteAsset: 'spy',
      quoteUsdg: 800,
      complete: false,
    }),
    { side: 'UNKNOWN', quality: 'UNKNOWN', reason: 'incomplete_principal_or_supply_evidence' },
  )
})

test('liquidity increase separates wallet spend from implicitly compounded fees', () => {
  const result = deriveImplicitIncreaseFees({
    totalUnderlying: { spy: 0.001355194754208997, pair: 489.52612767177783 },
    walletFlow: { spy: -0.00129772064939777, pair: -487.12533886647975 },
    assets: ['spy', 'pair'],
  })
  assert.equal(result.walletSpend.spy, 0.00129772064939777)
  assert.ok(Math.abs(result.implicitFees.spy - 0.00005747410481122704) < 1e-18)
  assert.ok(Math.abs(result.implicitFees.pair - 2.4007888052980775) < 1e-12)

  const roundingOnly = deriveImplicitIncreaseFees({
    totalUnderlying: { pair: 10.0000000001 },
    walletFlow: { pair: -10 },
    assets: ['pair'],
  })
  assert.equal(roundingOnly.implicitFees.pair, 0)
})

test('CSV export escapes commas, quotes and newlines', () => {
  assert.equal(toCsv([{ id: 1, note: 'a,"b"\nc' }], ['id', 'note']), 'id,note\n1,"a,""b""\nc"\n')
})
