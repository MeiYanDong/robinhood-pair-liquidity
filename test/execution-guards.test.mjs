import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPairOnlyBoundary,
  authorizedPairBudget,
  protectedPairFloor,
  verifyAuthorizedPairSpend,
} from '../lib/execution-guards.mjs'

test('an explicit PAIR cap preserves the pre-existing wallet balance', () => {
  const wallet = 10_000n
  const budget = authorizedPairBudget(wallet, 4_000n)
  assert.equal(budget, 4_000n)
  assert.equal(protectedPairFloor(wallet, budget), 6_000n)
  assert.deepEqual(
    verifyAuthorizedPairSpend({ baselinePairWei: wallet, finalPairWei: 6_000n, authorizedBudgetWei: budget }),
    { spentWei: 4_000n, floorWei: 6_000n },
  )
})

test('PAIR spend rejects both an authorization breach and low utilization', () => {
  assert.throws(
    () => verifyAuthorizedPairSpend({ baselinePairWei: 10_000n, finalPairWei: 5_999n, authorizedBudgetWei: 4_000n }),
    /exceeded authorization/,
  )
  assert.throws(
    () => verifyAuthorizedPairSpend({ baselinePairWei: 10_000n, finalPairWei: 6_100n, authorizedBudgetWei: 4_000n }),
    /below minimum/,
  )
})

test('PAIR-only execution requires price to remain below the target range', () => {
  assert.doesNotThrow(() => assertPairOnlyBoundary(97_400, 97_400))
  assert.throws(() => assertPairOnlyBoundary(97_399, 97_400), /not PAIR-only/)
})
