/**
 * @typedef {object} SequencePosition
 * @property {string} tokenId
 * @property {number} tickLower
 * @property {number} tickUpper
 * @property {string|number|bigint} liquidity
 * @property {boolean} inRange
 */

/**
 * @typedef {object} SequenceSample
 * @property {string} observedAt
 * @property {string|number|bigint} blockNumber
 * @property {number} currentTick
 * @property {number} pairUsdg
 * @property {string|number|bigint} ourActiveLiquidity
 * @property {SequencePosition[]} positions
 */

/**
 * @typedef {object} ActiveBreakout
 * @property {number} boundaryTick
 * @property {string[]} crossedTokenIds
 * @property {string} firstObservedAt
 * @property {string} firstBlockNumber
 * @property {number} confirmationBlocks
 * @property {string} initialActiveLiquidity
 * @property {number} skippedBands
 */

/**
 * @typedef {object} TrendSequenceState
 * @property {number} schemaVersion
 * @property {string} poolId
 * @property {SequenceSample|null} lastSample
 * @property {ActiveBreakout|null} activeBreakout
 */

/** @param {unknown} value @param {string} label */
function bigintNonNegative(value, label) {
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(String(value))
    if (parsed < 0n) throw new Error('negative')
    return parsed
  } catch {
    throw new TypeError(`${label} must be a non-negative integer`)
  }
}

/** @param {unknown} value @param {string} label */
function dateMilliseconds(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be an ISO timestamp`)
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} must be an ISO timestamp`)
  return milliseconds
}

/** @param {SequenceSample} sample */
function normalizeSample(sample) {
  if (!Number.isFinite(sample.currentTick)) throw new TypeError('sample.currentTick must be finite')
  if (!Number.isFinite(sample.pairUsdg) || sample.pairUsdg <= 0) {
    throw new TypeError('sample.pairUsdg must be positive and finite')
  }
  const blockNumber = bigintNonNegative(sample.blockNumber, 'sample.blockNumber')
  dateMilliseconds(sample.observedAt, 'sample.observedAt')
  const positions = sample.positions.map((position) => ({
    tokenId: String(position.tokenId),
    tickLower: Number(position.tickLower),
    tickUpper: Number(position.tickUpper),
    liquidity: String(bigintNonNegative(position.liquidity, `position ${position.tokenId} liquidity`)),
    inRange: position.inRange === true,
  }))
  if (positions.some((position) => !Number.isFinite(position.tickLower) || !Number.isFinite(position.tickUpper))) {
    throw new TypeError('position ticks must be finite')
  }
  return {
    observedAt: sample.observedAt,
    blockNumber: String(blockNumber),
    currentTick: sample.currentTick,
    pairUsdg: sample.pairUsdg,
    ourActiveLiquidity: String(bigintNonNegative(sample.ourActiveLiquidity, 'sample.ourActiveLiquidity')),
    positions,
  }
}

/** @param {TrendSequenceState|null|undefined} state @param {string} poolId */
export function initialTrendSequenceState(state, poolId) {
  if (
    !state ||
    state.schemaVersion !== 1 ||
    state.poolId?.toLowerCase() !== poolId.toLowerCase() ||
    (state.lastSample !== null && typeof state.lastSample !== 'object')
  ) {
    return { schemaVersion: 1, poolId, lastSample: null, activeBreakout: null }
  }
  return state
}

/**
 * Advance only from trusted samples. A PAIR price rise moves currentTick lower.
 * Crossing a position's tickLower is therefore an upward exit.
 *
 * @param {{state:TrendSequenceState|null|undefined,poolId:string,sample:SequenceSample,trusted:boolean}} input
 */
export function advanceTrendSequence({ state: rawState, poolId, sample: rawSample, trusted }) {
  const state = initialTrendSequenceState(rawState, poolId)
  const sample = normalizeSample(rawSample)
  if (!trusted) {
    return {
      state,
      signals: {
        advanced: false,
        reason: 'untrusted_sample',
        crossedUpper: false,
        breakoutPct: 0,
        confirmationBlocks: 0,
        secondsAboveUpper: 0,
        activeCoverageLossPct: 0,
        existingHigherBandCoverage: false,
        skippedBands: 0,
      },
    }
  }

  const previous = state.lastSample
  const currentBlock = BigInt(sample.blockNumber)
  const previousBlock = previous ? BigInt(previous.blockNumber) : null
  if (previousBlock !== null && currentBlock <= previousBlock) {
    return {
      state,
      signals: {
        advanced: false,
        reason: 'non_increasing_block',
        crossedUpper: state.activeBreakout !== null && sample.currentTick < state.activeBreakout.boundaryTick,
        breakoutPct: 0,
        confirmationBlocks: state.activeBreakout?.confirmationBlocks ?? 0,
        secondsAboveUpper: 0,
        activeCoverageLossPct: 0,
        existingHigherBandCoverage: sample.positions.some((position) => position.inRange),
        skippedBands: state.activeBreakout?.skippedBands ?? 0,
      },
    }
  }

  /** @type {ActiveBreakout|null} */
  let activeBreakout = state.activeBreakout
  if (activeBreakout && sample.currentTick >= activeBreakout.boundaryTick) activeBreakout = null

  if (!activeBreakout && previous && sample.currentTick < previous.currentTick) {
    const crossed = sample.positions.filter(
      (position) =>
        BigInt(position.liquidity) > 0n &&
        previous.currentTick >= position.tickLower &&
        sample.currentTick < position.tickLower,
    )
    if (crossed.length > 0) {
      const boundaryTick = Math.max(...crossed.map((position) => position.tickLower))
      const crossedTokenIds = crossed.map((position) => position.tokenId).sort()
      activeBreakout = {
        boundaryTick,
        crossedTokenIds,
        firstObservedAt: sample.observedAt,
        firstBlockNumber: sample.blockNumber,
        confirmationBlocks: 1,
        initialActiveLiquidity: String(previous.ourActiveLiquidity),
        skippedBands: new Set(crossed.map((position) => position.tickLower)).size,
      }
    }
  } else if (activeBreakout && sample.currentTick < activeBreakout.boundaryTick) {
    activeBreakout = { ...activeBreakout, confirmationBlocks: activeBreakout.confirmationBlocks + 1 }
  }

  const nextState = { schemaVersion: 1, poolId, lastSample: sample, activeBreakout }
  if (!activeBreakout || sample.currentTick >= activeBreakout.boundaryTick) {
    return {
      state: nextState,
      signals: {
        advanced: true,
        reason: previous ? 'no_active_breakout' : 'baseline_seeded',
        crossedUpper: false,
        breakoutPct: 0,
        confirmationBlocks: 0,
        secondsAboveUpper: 0,
        activeCoverageLossPct: 0,
        existingHigherBandCoverage: false,
        skippedBands: 0,
      },
    }
  }

  const firstObservedMs = dateMilliseconds(activeBreakout.firstObservedAt, 'activeBreakout.firstObservedAt')
  const currentObservedMs = dateMilliseconds(sample.observedAt, 'sample.observedAt')
  const initialActiveLiquidity = BigInt(activeBreakout.initialActiveLiquidity)
  const currentActiveLiquidity = BigInt(sample.ourActiveLiquidity)
  const lostLiquidity =
    initialActiveLiquidity > currentActiveLiquidity ? initialActiveLiquidity - currentActiveLiquidity : 0n
  const activeCoverageLossPct =
    initialActiveLiquidity > 0n ? (Number(lostLiquidity) / Number(initialActiveLiquidity)) * 100 : 0
  return {
    state: nextState,
    signals: {
      advanced: true,
      reason: activeBreakout.confirmationBlocks === 1 ? 'upward_boundary_crossed' : 'upward_breakout_persisting',
      boundaryTick: activeBreakout.boundaryTick,
      crossedTokenIds: activeBreakout.crossedTokenIds,
      crossedUpper: true,
      breakoutPct: (Math.pow(1.0001, activeBreakout.boundaryTick - sample.currentTick) - 1) * 100,
      confirmationBlocks: activeBreakout.confirmationBlocks,
      secondsAboveUpper: Math.max(0, (currentObservedMs - firstObservedMs) / 1000),
      activeCoverageLossPct,
      existingHigherBandCoverage: currentActiveLiquidity > 0n,
      skippedBands: activeBreakout.skippedBands,
    },
  }
}
