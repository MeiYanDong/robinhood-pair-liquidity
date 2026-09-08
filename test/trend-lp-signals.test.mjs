import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveFlowSignals, selectUpwardRange } from '../lib/trend-lp-signals.mjs'

function bins(volumes, marketLiquidity = '100000000000000000000000') {
  return volumes.map((volumeUsdg, index) => ({
    tickLower: 99_000 + index * 200,
    tickUpper: 99_200 + index * 200,
    volumeUsdg,
    grossFeeUsdg: volumeUsdg * 0.01,
    marketLiquidity,
  }))
}

function pricedBins(volumes, marketLiquidity) {
  const spyUsdg = 1_000
  return bins(volumes, marketLiquidity).map((bin) => ({
    ...bin,
    priceMidUsdg: spyUsdg / Math.pow(1.0001, (bin.tickLower + bin.tickUpper) / 2),
  }))
}

test('flow signals value SPY input as PAIR buying and compare 1h with six-hour hourly baseline', () => {
  const signals = deriveFlowSignals({
    oneHourTotals: { volumeUsdg: 120, spyInput: 0.08, pairInput: 10 },
    sixHourTotals: { volumeUsdg: 300, spyInput: 0.3, pairInput: 100 },
    spyUsdg: 1_000,
    pairUsdg: 2,
  })
  assert.equal(signals.dataComplete, true)
  assert.equal(signals.volumeMultiple, 2.4)
  assert.equal(signals.oneHourPairBuySharePct, 80)
  assert.equal(signals.sixHourPairBuySharePct, 60)
})

test('range selector aligns ticks, keeps spot inside, and reserves more room for PAIR upside', () => {
  const result = selectUpwardRange({
    currentTick: 100_150,
    tickSpacing: 200,
    spyUsdg: 1_000,
    oneHourBins: bins([0, 5, 10, 20, 50, 80, 50, 20, 10, 5, 0, 0]),
    sixHourBins: bins([5, 10, 20, 30, 80, 100, 80, 50, 30, 20, 10, 5]),
    referenceAddedLiquidity: '1000000000000000000000',
  })
  assert.ok(result.selected)
  assert.equal(result.selected.tickLower % 200, 0)
  assert.equal(result.selected.tickUpper % 200, 0)
  assert.ok(result.selected.tickLower <= 100_150)
  assert.ok(result.selected.tickUpper > 100_150)
  assert.ok(result.selected.currentTickPositionPct > 50)
  assert.ok(result.selected.actualPriceWidthUsdg >= 0.0075)
  assert.ok(result.selected.actualPriceWidthUsdg <= 0.0125)
  assert.ok(result.candidates.every((candidate) => candidate.actualPriceWidthUsdg >= 0.0075))
  assert.deepEqual(result.preferredPriceWidthBandUsdg, { low: 0.008, high: 0.012 })
  assert.ok(result.selected.oneHour.coveragePct > 0)
  assert.equal(result.anyQualified, true)
  assert.ok(result.activeTarget)
  assert.equal(result.nextTarget.status, 'PREPARE_ONLY')
  assert.equal(result.nextTarget.gapFromActiveTargetUsdg, 0)
})

test('same-volume lower-competition bins produce higher modeled fee capture', () => {
  const lowCompetition = selectUpwardRange({
    currentTick: 100_150,
    tickSpacing: 200,
    spyUsdg: 1_000,
    oneHourBins: bins([10, 20, 40, 80, 100, 80, 40, 20], '10000000000000000000000'),
    sixHourBins: bins([10, 20, 40, 80, 100, 80, 40, 20], '10000000000000000000000'),
    referenceAddedLiquidity: '1000000000000000000000',
  })
  const highCompetition = selectUpwardRange({
    currentTick: 100_150,
    tickSpacing: 200,
    spyUsdg: 1_000,
    oneHourBins: bins([10, 20, 40, 80, 100, 80, 40, 20], '1000000000000000000000000'),
    sixHourBins: bins([10, 20, 40, 80, 100, 80, 40, 20], '1000000000000000000000000'),
    referenceAddedLiquidity: '1000000000000000000000',
  })
  assert.ok(
    lowCompetition.selected.oneHour.modeledFeeCaptureUsdg > highCompetition.selected.oneHour.modeledFeeCaptureUsdg,
  )
})

test('a price-floor candidate can extend about $0.01 upward from $0.015143', () => {
  const spyUsdg = 1_000
  const lowerPriceUsdg = 0.015143
  const currentTick = Math.log(spyUsdg / lowerPriceUsdg) / Math.log(1.0001)
  const result = selectUpwardRange({
    currentTick,
    tickSpacing: 200,
    spyUsdg,
    oneHourBins: bins([1, 1, 1]),
    sixHourBins: bins([1, 1, 1]),
    referenceAddedLiquidity: '1000000000000000000000',
    widthMultipliers: [1],
    upsideRoomShares: [1],
  })
  assert.ok(result.selected)
  assert.ok(Math.abs(result.selected.requestedPriceLowUsdg - lowerPriceUsdg) < 1e-10)
  assert.ok(Math.abs(result.selected.requestedPriceHighUsdg - 0.025143) < 1e-10)
  assert.ok(result.selected.priceLowUsdg <= lowerPriceUsdg)
  assert.ok(result.selected.priceHighUsdg >= 0.025143)
})

test('volume hot-zone boundaries become candidate anchors instead of only affecting the final score', () => {
  const volumes = [0, 0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0]
  const result = selectUpwardRange({
    currentTick: 100_150,
    tickSpacing: 200,
    spyUsdg: 1_000,
    oneHourBins: pricedBins(volumes),
    sixHourBins: pricedBins(volumes),
    referenceAddedLiquidity: '1000000000000000000000',
  })
  assert.ok(result.candidates.some((candidate) => candidate.anchorSources.includes('1h_volume_p10_floor')))
  assert.ok(result.candidates.every((candidate) => candidate.qualificationChecks))
  assert.ok(result.candidates.every((candidate) => Array.isArray(candidate.rejectionReasons)))
})

test('zero volume cannot qualify a target range', () => {
  const result = selectUpwardRange({
    currentTick: 100_150,
    tickSpacing: 200,
    spyUsdg: 1_000,
    oneHourBins: bins([0, 0, 0, 0]),
    sixHourBins: bins([0, 0, 0, 0]),
    referenceAddedLiquidity: '1000000000000000000000',
  })
  assert.equal(result.anyQualified, false)
  assert.equal(result.selected.qualified, false)
  assert.equal(result.status, 'RESCAN_NO_TRADE')
  assert.equal(result.activeTarget, null)
  assert.equal(result.nextTarget, null)
  assert.ok(result.selected.rejectionReasons.includes('oneHourVolumeCoverage'))
})
