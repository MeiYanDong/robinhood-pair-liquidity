export const TREND_ACTION = Object.freeze({
  HOLD: 'HOLD',
  PREPARE_UNSIGNED_PLAN: 'PREPARE_UNSIGNED_PLAN',
  WAIT_CONFIRMATION: 'WAIT_CONFIRMATION',
  HOLD_COVERED: 'HOLD_COVERED',
  HOLD_COOLDOWN: 'HOLD_COOLDOWN',
  RESCAN_NO_TRADE: 'RESCAN_NO_TRADE',
  NORMAL_ROLL: 'NORMAL_ROLL',
  URGENT_ROLL: 'URGENT_ROLL',
  ONE_WIDE_CATCH_UP_TRANCHE: 'ONE_WIDE_CATCH_UP_TRANCHE',
  WAIT_GAS: 'WAIT_GAS',
  RISK_EXIT: 'RISK_EXIT',
  WITHDRAW_THEN_DEPTH_AWARE_EXIT: 'WITHDRAW_THEN_DEPTH_AWARE_EXIT',
  WAIT_ALERT: 'WAIT_ALERT',
  RECONCILE_ONLY: 'RECONCILE_ONLY',
  DEGRADED_HALT_NEW_RISK: 'DEGRADED_HALT_NEW_RISK',
})

/**
 * @typedef {object} TrendPolicy
 * @property {number} gasAnomalyCapUsdg
 * @property {number} maximumExitPriceImpactPct
 * @property {number} maximumCapitalPerRollBps
 * @property {number} nearUpperDistancePct
 * @property {number} normalBreakoutPct
 * @property {number} normalConfirmationBlocks
 * @property {number} normalSecondsAboveUpper
 * @property {number} normalVolumeMultiple
 * @property {number} normalNetBuySharePct
 * @property {number} strongBreakoutPct
 * @property {number} strongConfirmationBlocks
 * @property {number} strongVolumeMultiple
 * @property {number} strongNetBuySharePct
 * @property {number} urgentCoverageLossPct
 */

/** @type {Readonly<TrendPolicy>} */
export const DEFAULT_TREND_POLICY = Object.freeze({
  gasAnomalyCapUsdg: 25,
  maximumExitPriceImpactPct: 3,
  maximumCapitalPerRollBps: 2_500,
  nearUpperDistancePct: 3,
  normalBreakoutPct: 1,
  normalConfirmationBlocks: 3,
  normalSecondsAboveUpper: 45,
  normalVolumeMultiple: 1.5,
  normalNetBuySharePct: 58,
  strongBreakoutPct: 3,
  strongConfirmationBlocks: 1,
  strongVolumeMultiple: 2.5,
  strongNetBuySharePct: 65,
  urgentCoverageLossPct: 50,
})

/**
 * @typedef {object} TrendObservation
 * @property {string} [id]
 * @property {boolean} [portfolioComplete]
 * @property {boolean} [snapshotFresh]
 * @property {boolean} [rpcConsistent]
 * @property {boolean} [receiptUnknown]
 * @property {boolean} [pendingNonce]
 * @property {boolean} [cooldownActive]
 * @property {boolean} [nearUpper]
 * @property {boolean} [crossedUpper]
 * @property {number} [breakoutPct]
 * @property {number} [confirmationBlocks]
 * @property {number} [secondsAboveUpper]
 * @property {number} [volumeMultiple]
 * @property {number} [netBuySharePct]
 * @property {number} [activeCoverageLossPct]
 * @property {boolean} [existingHigherBandCoverage]
 * @property {boolean} [targetQualified]
 * @property {number} [skippedBands]
 * @property {boolean} [reversalConfirmed]
 * @property {number} [gasUsdg]
 * @property {number} [frictionUsdg]
 * @property {number} [exitPriceImpactPct]
 * @property {number} [withdrawGasUsdg]
 */

/**
 * @typedef {object} TrendDecision
 * @property {string} action
 * @property {'observe'|'normal'|'urgent'|'risk'|'reconcile'|'degraded'} lane
 * @property {string[]} reasons
 * @property {boolean} executionAuthorized
 * @property {number} recommendedCapitalBps
 * @property {boolean} mayBuyAdditionalPair
 * @property {{gasUsdg:number, frictionUsdg:number, totalCostUsdg:number, gasCapUsdg:number}} economics
 * @property {{normalConfirmed:boolean, strongConfirmed:boolean}} signals
 */

/** @param {unknown} value @param {number} fallback */
function finiteNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** @param {number} value @param {string} label */
function requireNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative finite number`)
  return value
}

/** @param {Partial<TrendPolicy>} overrides */
function policyWith(overrides = {}) {
  const policy = /** @type {TrendPolicy} */ ({ ...DEFAULT_TREND_POLICY, ...overrides })
  for (const [key, value] of Object.entries(policy)) requireNonNegative(value, `policy.${key}`)
  if (policy.maximumCapitalPerRollBps > 10_000) throw new Error('maximumCapitalPerRollBps exceeds 100%')
  return policy
}

/** @param {TrendObservation} observation @param {TrendPolicy} policy */
function breakoutSignals(observation, policy) {
  const crossedUpper = observation.crossedUpper === true
  const breakoutPct = finiteNumber(observation.breakoutPct)
  const confirmationBlocks = finiteNumber(observation.confirmationBlocks)
  const secondsAboveUpper = finiteNumber(observation.secondsAboveUpper)
  const volumeMultiple = finiteNumber(observation.volumeMultiple)
  const netBuySharePct = finiteNumber(observation.netBuySharePct)
  const normalConfirmed =
    crossedUpper &&
    breakoutPct >= policy.normalBreakoutPct &&
    confirmationBlocks >= policy.normalConfirmationBlocks &&
    secondsAboveUpper >= policy.normalSecondsAboveUpper &&
    volumeMultiple >= policy.normalVolumeMultiple &&
    netBuySharePct >= policy.normalNetBuySharePct
  const strongConfirmed =
    crossedUpper &&
    breakoutPct >= policy.strongBreakoutPct &&
    confirmationBlocks >= policy.strongConfirmationBlocks &&
    volumeMultiple >= policy.strongVolumeMultiple &&
    netBuySharePct >= policy.strongNetBuySharePct
  return { normalConfirmed, strongConfirmed }
}

/**
 * The policy engine is intentionally pure and cannot sign or broadcast. Gas
 * is only an anomaly fuse: it never waits for a cheaper normal transaction and
 * no fee-payback forecast is part of the decision path.
 *
 * @param {TrendObservation} observation
 * @param {Partial<TrendPolicy>} [overrides]
 * @returns {TrendDecision}
 */
export function evaluateTrendDecision(observation, overrides = {}) {
  const policy = policyWith(overrides)
  const gasUsdg = requireNonNegative(finiteNumber(observation.gasUsdg), 'gasUsdg')
  const frictionUsdg = requireNonNegative(finiteNumber(observation.frictionUsdg), 'frictionUsdg')
  const signals = breakoutSignals(observation, policy)
  const base = {
    executionAuthorized: false,
    recommendedCapitalBps: 0,
    mayBuyAdditionalPair: false,
    economics: {
      gasUsdg,
      frictionUsdg,
      totalCostUsdg: gasUsdg + frictionUsdg,
      gasCapUsdg: policy.gasAnomalyCapUsdg,
    },
    signals,
  }
  /** @param {string} action @param {TrendDecision['lane']} lane @param {string[]} reasons @param {number} [capitalBps] */
  const result = (action, lane, reasons, capitalBps = 0) => ({
    ...base,
    action,
    lane,
    reasons,
    recommendedCapitalBps: capitalBps,
  })

  if (observation.receiptUnknown || observation.pendingNonce) {
    return result(TREND_ACTION.RECONCILE_ONLY, 'reconcile', [
      observation.receiptUnknown ? 'receipt_unknown' : 'pending_nonce',
      'no_new_nonce_until_reconciled',
    ])
  }
  if (
    observation.portfolioComplete === false ||
    observation.snapshotFresh === false ||
    observation.rpcConsistent === false
  ) {
    return result(TREND_ACTION.DEGRADED_HALT_NEW_RISK, 'degraded', [
      observation.portfolioComplete === false ? 'portfolio_incomplete' : 'market_read_untrusted',
      'fail_closed',
    ])
  }

  if (observation.reversalConfirmed) {
    const exitPriceImpactPct = requireNonNegative(finiteNumber(observation.exitPriceImpactPct), 'exitPriceImpactPct')
    const withdrawGasUsdg = requireNonNegative(finiteNumber(observation.withdrawGasUsdg, gasUsdg), 'withdrawGasUsdg')
    if (exitPriceImpactPct > policy.maximumExitPriceImpactPct) {
      if (withdrawGasUsdg <= policy.gasAnomalyCapUsdg) {
        return result(TREND_ACTION.WITHDRAW_THEN_DEPTH_AWARE_EXIT, 'risk', [
          'exit_price_impact_too_high',
          'withdraw_first_then_requote',
          'do_not_wait_for_cheaper_gas',
        ])
      }
      return result(TREND_ACTION.WAIT_ALERT, 'risk', ['exit_price_impact_too_high', 'withdraw_gas_anomaly'])
    }
    if (gasUsdg <= policy.gasAnomalyCapUsdg) {
      return result(TREND_ACTION.RISK_EXIT, 'risk', [
        'reversal_confirmed',
        'gas_not_anomalous',
        'do_not_wait_for_cheaper_gas',
      ])
    }
    return result(TREND_ACTION.WAIT_ALERT, 'risk', ['reversal_confirmed', 'gas_anomaly_requires_operator_alert'])
  }

  if (observation.cooldownActive) {
    return result(TREND_ACTION.HOLD_COOLDOWN, 'observe', ['cooldown_active', 'prevent_churn'])
  }
  if (!observation.crossedUpper) {
    if (observation.nearUpper) {
      return result(TREND_ACTION.PREPARE_UNSIGNED_PLAN, 'observe', ['near_upper_boundary', 'prepare_without_signing'])
    }
    return result(TREND_ACTION.HOLD, 'observe', ['no_confirmed_breakout'])
  }
  if (!signals.normalConfirmed && !signals.strongConfirmed) {
    return result(TREND_ACTION.WAIT_CONFIRMATION, 'observe', ['upper_cross_unconfirmed', 'filter_wick'])
  }
  const coverageLoss = requireNonNegative(finiteNumber(observation.activeCoverageLossPct), 'activeCoverageLossPct')
  if (observation.existingHigherBandCoverage && coverageLoss < policy.urgentCoverageLossPct) {
    return result(TREND_ACTION.HOLD_COVERED, 'observe', [
      'existing_higher_band_active',
      'portfolio_coverage_sufficient',
    ])
  }
  if (observation.targetQualified !== true) {
    return result(TREND_ACTION.RESCAN_NO_TRADE, 'observe', ['no_volume_and_liquidity_qualified_target'])
  }

  const skippedBands = requireNonNegative(finiteNumber(observation.skippedBands), 'skippedBands')
  if (skippedBands >= 2) {
    if (gasUsdg <= policy.gasAnomalyCapUsdg) {
      return result(
        TREND_ACTION.ONE_WIDE_CATCH_UP_TRANCHE,
        'urgent',
        ['multiple_bands_skipped', 'skip_obsolete_intermediate_ranges', 'do_not_wait_for_cheaper_gas'],
        policy.maximumCapitalPerRollBps,
      )
    }
    return result(TREND_ACTION.WAIT_GAS, 'urgent', ['multiple_bands_skipped', 'gas_anomaly_requires_operator_alert'])
  }
  if (signals.strongConfirmed && coverageLoss >= policy.urgentCoverageLossPct) {
    if (gasUsdg <= policy.gasAnomalyCapUsdg) {
      return result(
        TREND_ACTION.URGENT_ROLL,
        'urgent',
        ['strong_breakout', 'portfolio_coverage_lost', 'do_not_wait_for_cheaper_gas'],
        policy.maximumCapitalPerRollBps,
      )
    }
    return result(TREND_ACTION.WAIT_GAS, 'urgent', ['strong_breakout', 'gas_anomaly_requires_operator_alert'])
  }
  if (gasUsdg <= policy.gasAnomalyCapUsdg) {
    return result(
      TREND_ACTION.NORMAL_ROLL,
      'normal',
      ['breakout_confirmed', 'gas_not_anomalous', 'do_not_wait_for_cheaper_gas'],
      policy.maximumCapitalPerRollBps,
    )
  }
  return result(TREND_ACTION.WAIT_GAS, 'normal', ['breakout_confirmed', 'gas_anomaly_requires_operator_alert'])
}
