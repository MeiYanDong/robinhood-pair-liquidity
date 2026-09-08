import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { evaluateTrendDecision } from '../lib/trend-lp-policy.mjs'

const fixturePath = fileURLToPath(new URL('./fixtures/trend-lp-breakout-scenarios.json', import.meta.url))
const shadowScriptPath = fileURLToPath(new URL('../scripts/pair-trend-shadow.mjs', import.meta.url))
const scenarios = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

const baseObservation = Object.freeze({
  portfolioComplete: true,
  snapshotFresh: true,
  rpcConsistent: true,
  receiptUnknown: false,
  pendingNonce: false,
  cooldownActive: false,
  nearUpper: false,
  crossedUpper: true,
  breakoutPct: 1.2,
  confirmationBlocks: 3,
  secondsAboveUpper: 60,
  volumeMultiple: 1.7,
  netBuySharePct: 60,
  activeCoverageLossPct: 55,
  existingHigherBandCoverage: false,
  targetQualified: true,
  skippedBands: 0,
  reversalConfirmed: false,
  gasUsdg: 3,
  frictionUsdg: 1,
  exitPriceImpactPct: 0,
  withdrawGasUsdg: 0,
})

test('normal gas variation never delays a qualified roll', () => {
  for (const gasUsdg of [0.5, 1, 5, 12, 24.99]) {
    const decision = evaluateTrendDecision({ ...baseObservation, gasUsdg })
    assert.equal(decision.action, 'NORMAL_ROLL')
    assert.ok(decision.reasons.includes('do_not_wait_for_cheaper_gas'))
  }
  assert.equal(evaluateTrendDecision({ ...baseObservation, gasUsdg: 25.01 }).action, 'WAIT_GAS')
})

test('breakout and reversal scenario matrix is deterministic and fail-closed', async (t) => {
  assert.ok(scenarios.length >= 20, 'at least twenty market scenarios are required')
  for (const scenario of scenarios) {
    await t.test(scenario.id, () => {
      const decision = evaluateTrendDecision({ ...baseObservation, ...scenario.overrides })
      assert.equal(decision.action, scenario.expectedAction)
      assert.equal(decision.executionAuthorized, false)
      assert.equal(decision.mayBuyAdditionalPair, false)
      assert.ok(decision.reasons.length > 0)
      assert.ok(decision.recommendedCapitalBps >= 0 && decision.recommendedCapitalBps <= 2_500)
    })
  }
})

test('invalid monetary and policy inputs are rejected', () => {
  assert.throws(() => evaluateTrendDecision({ ...baseObservation, gasUsdg: -1 }), /non-negative/)
  assert.throws(() => evaluateTrendDecision(baseObservation, { maximumCapitalPerRollBps: 10_001 }), /exceeds 100%/)
})

test('shadow observer contains no wallet, signing, broadcasting, or Keychain primitives', () => {
  const source = fs.readFileSync(shadowScriptPath, 'utf8')
  assert.doesNotMatch(
    source,
    /createWalletClient|privateKeyToAccount|sendTransaction|writeContract|find-generic-password|PAIR_PRIVATE_KEY/,
  )
})
