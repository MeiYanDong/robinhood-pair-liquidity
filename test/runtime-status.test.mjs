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

test('a failed refresh stays available but visibly degraded while its snapshot is fresh', () => {
  assert.deepEqual(
    evaluateRuntimeStatus({
      status: 'STALE',
      generatedAt: '2026-09-06T00:00:30.000Z',
      refreshMs: 60_000,
      nowMs,
    }),
    { status: 'DEGRADED', ready: true, ageSeconds: 30, staleAfterSeconds: 180 },
  )
})

test('a restarted process is not ready until it has produced its own successful snapshot', () => {
  assert.deepEqual(
    evaluateRuntimeStatus({
      status: 'STALE',
      generatedAt: '2026-09-06T00:00:50.000Z',
      refreshMs: 60_000,
      hasSucceededSinceStart: false,
      nowMs,
    }),
    { status: 'DEGRADED', ready: false, ageSeconds: 10, staleAfterSeconds: 180 },
  )
})
