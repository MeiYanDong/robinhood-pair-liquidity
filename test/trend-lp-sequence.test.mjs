import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceTrendSequence } from '../lib/trend-lp-sequence.mjs'

const poolId = '0xabc'
const positions = [
  { tokenId: '1', tickLower: 100_000, tickUpper: 102_000, liquidity: '100', inRange: true },
  { tokenId: '2', tickLower: 98_000, tickUpper: 100_500, liquidity: '200', inRange: false },
]

function sample(blockNumber, observedAt, currentTick, inRangeIds = ['1']) {
  return {
    blockNumber,
    observedAt,
    currentTick,
    pairUsdg: 1 / Math.pow(1.0001, currentTick),
    ourActiveLiquidity: inRangeIds.reduce(
      (total, id) => total + BigInt(positions.find((position) => position.tokenId === id)?.liquidity || 0),
      0n,
    ),
    positions: positions.map((position) => ({ ...position, inRange: inRangeIds.includes(position.tokenId) })),
  }
}

test('trusted sequence seeds a baseline then confirms a persistent upward boundary crossing', () => {
  let advanced = advanceTrendSequence({
    state: null,
    poolId,
    sample: sample(10, '2026-09-08T00:00:00Z', 100_500),
    trusted: true,
  })
  assert.equal(advanced.signals.reason, 'baseline_seeded')
  assert.equal(advanced.signals.crossedUpper, false)

  advanced = advanceTrendSequence({
    state: advanced.state,
    poolId,
    sample: sample(11, '2026-09-08T00:00:01Z', 99_900, []),
    trusted: true,
  })
  assert.equal(advanced.signals.reason, 'upward_boundary_crossed')
  assert.equal(advanced.signals.crossedUpper, true)
  assert.equal(advanced.signals.confirmationBlocks, 1)
  assert.equal(advanced.signals.activeCoverageLossPct, 100)

  advanced = advanceTrendSequence({
    state: advanced.state,
    poolId,
    sample: sample(12, '2026-09-08T00:00:46Z', 99_800, []),
    trusted: true,
  })
  assert.equal(advanced.signals.confirmationBlocks, 2)
  assert.equal(advanced.signals.secondsAboveUpper, 45)
  assert.ok(advanced.signals.breakoutPct > 0)
})

test('returning through the boundary clears an active breakout as a filtered wick', () => {
  const baseline = advanceTrendSequence({
    state: null,
    poolId,
    sample: sample(20, '2026-09-08T00:00:00Z', 100_500),
    trusted: true,
  })
  const crossed = advanceTrendSequence({
    state: baseline.state,
    poolId,
    sample: sample(21, '2026-09-08T00:00:01Z', 99_900, []),
    trusted: true,
  })
  const returned = advanceTrendSequence({
    state: crossed.state,
    poolId,
    sample: sample(22, '2026-09-08T00:00:02Z', 100_100, ['1']),
    trusted: true,
  })
  assert.equal(returned.state.activeBreakout, null)
  assert.equal(returned.signals.crossedUpper, false)
})

test('a multi-band jump counts crossed boundaries and recognizes remaining coverage', () => {
  const baseline = advanceTrendSequence({
    state: null,
    poolId,
    sample: sample(30, '2026-09-08T00:00:00Z', 102_500, []),
    trusted: true,
  })
  const jumpedSample = sample(31, '2026-09-08T00:00:01Z', 97_900, ['2'])
  const jumped = advanceTrendSequence({ state: baseline.state, poolId, sample: jumpedSample, trusted: true })
  assert.equal(jumped.signals.crossedUpper, true)
  assert.equal(jumped.signals.skippedBands, 2)
  assert.equal(jumped.signals.existingHigherBandCoverage, true)
})

test('untrusted and repeated-block samples do not advance persistent confirmation', () => {
  const baseline = advanceTrendSequence({
    state: null,
    poolId,
    sample: sample(40, '2026-09-08T00:00:00Z', 100_500),
    trusted: true,
  })
  const untrusted = advanceTrendSequence({
    state: baseline.state,
    poolId,
    sample: sample(41, '2026-09-08T00:00:01Z', 99_900, []),
    trusted: false,
  })
  assert.equal(untrusted.signals.advanced, false)
  assert.equal(untrusted.state.lastSample.blockNumber, '40')

  const repeated = advanceTrendSequence({
    state: baseline.state,
    poolId,
    sample: sample(40, '2026-09-08T00:00:02Z', 99_900, []),
    trusted: true,
  })
  assert.equal(repeated.signals.advanced, false)
  assert.equal(repeated.state.lastSample.blockNumber, '40')
})
