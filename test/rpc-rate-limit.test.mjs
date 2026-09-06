import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRpcRequestGate, PairDashboardCollector } from '../dashboard/lib/collector.mjs'

const CONFIG_PATH = fileURLToPath(new URL('../dashboard/config/pair-spy.json', import.meta.url))

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

test('collector batches concurrent JSON-RPC methods into one HTTP request', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-rpc-batch-'))
  const requests = []
  const rpcFetchFn = async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push(body)
    const items = Array.isArray(body) ? body : [body]
    const responses = items.map((item) => ({ jsonrpc: '2.0', id: item.id, result: '0x1' }))
    return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    })
  }
  const collector = new PairDashboardCollector({
    configPath: CONFIG_PATH,
    databasePath: path.join(temporaryDirectory, 'history.sqlite'),
    rpcUrl: 'https://rpc.invalid.example',
    rpcMinimumIntervalMs: 0,
    rpcBatchSize: 20,
    rpcBatchWaitMs: 5,
    rpcFetchFn,
  })

  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => collector.client.request({ method: 'eth_blockNumber' })),
    )
    assert.deepEqual(results, Array(8).fill('0x1'))
    assert.equal(requests.length, 1)
    assert.equal(requests[0].length, 8)
  } finally {
    collector.close()
    fs.rmSync(temporaryDirectory, { force: true, recursive: true })
  }
})

test('lifecycle audit fills one RPC batch without exceeding its method budget', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-rpc-lifecycle-'))
  const collector = new PairDashboardCollector({
    configPath: CONFIG_PATH,
    databasePath: path.join(temporaryDirectory, 'history.sqlite'),
    rpcUrl: 'https://rpc.invalid.example',
    rpcBatchSize: 20,
  })
  collector.portfolioManifest = {
    positions: Array.from({ length: 10 }, (_, index) => ({ tokenId: String(index + 1) })),
  }
  let outstanding = 0
  let maximumOutstanding = 0
  collector.client = {
    async readContract({ functionName }) {
      outstanding += 1
      maximumOutstanding = Math.max(maximumOutstanding, outstanding)
      await new Promise((resolve) => setTimeout(resolve, 5))
      outstanding -= 1
      return functionName === 'ownerOf' ? collector.wallet : 1n
    },
  }

  try {
    const states = await collector.readPortfolioChainStates([], 1n)
    assert.equal(states.length, 10)
    assert.equal(
      states.every((state) => state.status === 'active'),
      true,
    )
    assert.equal(maximumOutstanding, 20)
  } finally {
    collector.close()
    fs.rmSync(temporaryDirectory, { force: true, recursive: true })
  }
})
