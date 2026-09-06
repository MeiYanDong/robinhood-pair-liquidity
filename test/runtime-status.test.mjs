import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateRuntimeStatus } from '../dashboard/lib/runtime-status.mjs'

const nowMs = Date.parse('2026-09-06T00:01:00.000Z')

test('a fresh snapshot stays ready while a refresh is in progress', () => {
  assert.deepEqual(
    evaluateRuntimeStatus({
      status: 'REFRESHING',
      generatedAt: '2026-09-06T00:00:50.000Z',
      refreshMs: 15_000,
      nowMs,
    }),
    { status: 'REFRESHING', ready: true, ageSeconds: 10, staleAfterSeconds: 45 },
  )
})

test('an old snapshot is stale and not ready even if the last state said LIVE', () => {
  assert.deepEqual(
    evaluateRuntimeStatus({
      status: 'LIVE',
      generatedAt: '2026-09-06T00:00:00.000Z',
      refreshMs: 15_000,
      nowMs,
    }),
    { status: 'STALE', ready: false, ageSeconds: 60, staleAfterSeconds: 45 },
  )
})
