import assert from 'node:assert/strict'
import test from 'node:test'
import { createRpcRequestGate } from '../dashboard/lib/collector.mjs'

test('RPC gate spaces requests that were queued concurrently', async () => {
  let clock = 1_000
  const waits = []
  const starts = []
  const gate = createRpcRequestGate({
    minimumIntervalMs: 150,
    now: () => clock,
    wait: async (milliseconds) => {
      waits.push(milliseconds)
      clock += milliseconds
    },
  })

  await Promise.all([
    gate(async () => starts.push(clock)),
    gate(async () => starts.push(clock)),
    gate(async () => starts.push(clock)),
  ])

  assert.deepEqual(starts, [1_000, 1_150, 1_300])
  assert.deepEqual(waits, [150, 150])
})

test('a failed RPC operation does not block the next queued request', async () => {
  let clock = 0
  const gate = createRpcRequestGate({
    minimumIntervalMs: 25,
    now: () => clock,
    wait: async (milliseconds) => {
      clock += milliseconds
    },
  })

  await assert.rejects(
    gate(async () => {
      throw new Error('expected failure')
    }),
  )
  const startedAt = await gate(async () => clock)

  assert.equal(startedAt, 25)
})
