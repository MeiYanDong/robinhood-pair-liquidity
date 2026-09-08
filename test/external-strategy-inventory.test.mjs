import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { normalizeExternalStrategies, PairDashboardCollector } from '../dashboard/lib/collector.mjs'

const CONFIG_PATH = fileURLToPath(new URL('../dashboard/config/pair-spy.json', import.meta.url))
const ZERO = '0x0000000000000000000000000000000000000000'

function encodedPositionInfo(poolId, tickLower, tickUpper) {
  const uint24 = (value) => BigInt(value < 0 ? value + 0x1000000 : value)
  const prefix = BigInt(`0x${poolId.slice(2, 52)}`)
  return (prefix << 56n) | (uint24(tickUpper) << 32n) | (uint24(tickLower) << 8n)
}

test('external strategy configuration rejects unsafe ids, duplicates, and unknown pools', () => {
  const poolId = `0x${'11'.repeat(32)}`
  const wallet = `0x${'22'.repeat(20)}`
  const base = {
    comparison: { pools: [{ id: 'pool', poolId }] },
    externalStrategies: [{ id: 'strategy-1', wallet, poolId, scanFromBlock: '100', expectedActivePositions: 5 }],
  }
  const [normalized] = normalizeExternalStrategies(base)
  assert.equal(normalized.id, 'strategy-1')
  assert.equal(normalized.scanFromBlock, 100n)
  assert.equal(normalized.expectedActivePositions, 5)

  assert.throws(
    () => normalizeExternalStrategies({ ...base, externalStrategies: [{ ...base.externalStrategies[0], id: '../x' }] }),
    /id is invalid/u,
  )
  assert.throws(
    () =>
      normalizeExternalStrategies({
        ...base,
        externalStrategies: [base.externalStrategies[0], base.externalStrategies[0]],
      }),
    /duplicated/u,
  )
  assert.throws(
    () =>
      normalizeExternalStrategies({
        ...base,
        externalStrategies: [{ ...base.externalStrategies[0], poolId: `0x${'33'.repeat(32)}` }],
      }),
    /unknown comparison pool/u,
  )
})

test('external strategy inventory discovers an unconfigured NFT and reconciles it at one safe block', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-external-strategy-'))
  const collector = new PairDashboardCollector({
    configPath: CONFIG_PATH,
    databasePath: path.join(temporaryDirectory, 'history.sqlite'),
    rpcUrl: 'https://rpc.invalid.example',
    rpcMinimumIntervalMs: 0,
  })
  const tracker = collector.externalStrategyTrackers[0]
  const tokenId = 9_001n
  const tickLower = 320_000
  const tickUpper = 321_000
  const safeBlock = {
    number: tracker.scanFromBlock + 2n,
    hash: `0x${'44'.repeat(32)}`,
  }
  const transfer = {
    transactionHash: `0x${'55'.repeat(32)}`,
    logIndex: 0n,
    transactionIndex: 0n,
    blockNumber: tracker.scanFromBlock,
    blockHash: `0x${'66'.repeat(32)}`,
    args: { from: ZERO, to: tracker.wallet, tokenId },
  }
  collector.getLogs = async (_address, _event, _fromBlock, _toBlock, args) => (args.to ? [transfer] : [])
  collector.getBlock = async ({ blockNumber }) => ({
    number: blockNumber,
    hash: blockNumber === safeBlock.number ? safeBlock.hash : `0x${'77'.repeat(32)}`,
  })
  let balanceAttempts = 0
  collector.client = {
    async readContract({ functionName }) {
      if (functionName === 'balanceOf') {
        balanceAttempts += 1
        if (balanceAttempts === 1) throw new Error('temporary balanceOf failure')
        return 1n
      }
      if (functionName === 'ownerOf') return tracker.wallet
      if (functionName === 'getPositionLiquidity') return 123n
      if (functionName === 'getPoolAndPositionInfo') {
        return [
          {
            currency0: collector.usdg,
            currency1: collector.config.tokens.pair.address,
            fee: tracker.pool.feePips,
            tickSpacing: tracker.pool.tickSpacing,
            hooks: tracker.pool.hooks,
          },
          encodedPositionInfo(tracker.pool.poolId, tickLower, tickUpper),
        ]
      }
      throw new Error(`unexpected function ${functionName}`)
    },
  }

  try {
    const result = await collector.syncExternalStrategyInventory(tracker, safeBlock)
    assert.equal(result.audit.status, 'VERIFIED')
    assert.equal(result.audit.expectedBalance, 1)
    assert.equal(result.audit.inferredOwnedNfts, 1)
    assert.equal(result.states[0].tokenId, tokenId.toString())
    assert.equal(result.states[0].poolId, tracker.pool.poolId)
    assert.equal(result.states[0].tickLower, tickLower)
    assert.equal(result.states[0].tickUpper, tickUpper)
    assert.equal(balanceAttempts, 2)
    assert.equal(tracker.positionInventory.cursor(), safeBlock.number)
  } finally {
    collector.close()
    fs.rmSync(temporaryDirectory, { force: true, recursive: true })
  }
})

test('external strategy refresh failure degrades only that strategy and redacts its RPC URL', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-external-strategy-failure-'))
  const collector = new PairDashboardCollector({
    configPath: CONFIG_PATH,
    databasePath: path.join(temporaryDirectory, 'history.sqlite'),
    rpcUrl: 'https://rpc.invalid.example',
    rpcMinimumIntervalMs: 0,
  })
  const tracker = collector.externalStrategyTrackers[0]
  let attempts = 0
  collector.syncExternalStrategyInventory = async () => {
    attempts += 1
    throw new Error('request failed at https://credential.example/path')
  }

  try {
    await collector.syncExternalStrategyInventories({ number: tracker.scanFromBlock, hash: `0x${'88'.repeat(32)}` })
    assert.equal(attempts, 2)
    assert.equal(tracker.positionInventorySnapshot.audit.status, 'PARTIAL')
    assert.equal(tracker.positionInventorySnapshot.audit.inventoryStatus, 'external_strategy_refresh_failed')
    assert.match(tracker.lastError, /\[RPC\]/u)
    assert.doesNotMatch(tracker.lastError, /credential\.example/u)
  } finally {
    collector.close()
    fs.rmSync(temporaryDirectory, { force: true, recursive: true })
  }
})

test('external strategy inventory retries one transient failure before publishing a partial state', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-external-strategy-retry-'))
  const collector = new PairDashboardCollector({
    configPath: CONFIG_PATH,
    databasePath: path.join(temporaryDirectory, 'history.sqlite'),
    rpcUrl: 'https://rpc.invalid.example',
    rpcMinimumIntervalMs: 0,
  })
  const tracker = collector.externalStrategyTrackers[0]
  let attempts = 0
  collector.syncExternalStrategyInventory = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('temporary RPC failure')
    tracker.lastError = null
    tracker.positionInventorySnapshot = {
      states: [],
      audit: { status: 'VERIFIED', inventoryStatus: 'verified_complete_at_safe_block' },
    }
  }

  try {
    await collector.syncExternalStrategyInventories({ number: tracker.scanFromBlock, hash: `0x${'89'.repeat(32)}` })
    assert.equal(attempts, 2)
    assert.equal(tracker.positionInventorySnapshot.audit.status, 'VERIFIED')
    assert.equal(tracker.lastError, null)
  } finally {
    collector.close()
    fs.rmSync(temporaryDirectory, { force: true, recursive: true })
  }
})

test('external strategy snapshot values one safe-block position without importing a cost basis', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-external-strategy-view-'))
  const collector = new PairDashboardCollector({
    configPath: CONFIG_PATH,
    databasePath: path.join(temporaryDirectory, 'history.sqlite'),
    rpcUrl: 'https://rpc.invalid.example',
    rpcMinimumIntervalMs: 0,
  })
  const tracker = collector.externalStrategyTrackers[0]
  tracker.expectedActivePositions = 1
  tracker.lastSuccessBlock = '123'
  tracker.positionInventorySnapshot = {
    states: [
      {
        tokenId: '9001',
        owner: tracker.wallet,
        liquidity: '123',
        status: 'active',
        tickLower: 320_000,
        tickUpper: 321_000,
        poolId: tracker.pool.poolId,
        dataQuality: 'verified_same_safe_block',
      },
    ],
    audit: {
      status: 'VERIFIED',
      inventoryStatus: 'verified_complete_at_safe_block',
      expectedBalance: 1,
      inferredOwnedNfts: 1,
      verifiedOwnedNfts: 1,
      balanceMatches: true,
      cursorBlock: '123',
      cursorHash: `0x${'99'.repeat(32)}`,
      failedTokenIds: [],
    },
  }
  tracker.positionInventory.firstTransfers = () => new Map()
  collector.readDirectPosition = async (_pool, position) => ({
    ...position,
    owner: tracker.wallet,
    status: 'active',
    liquidity: '123',
    inRange: true,
    priceLowUsdg: 0.01,
    priceHighUsdg: 0.011,
    principal: { usdg: 10, usdgToken: 4, pair: 600 },
    accruedFees: { usdg: 0.2, usdgToken: 0.1, pair: 10 },
    dataQuality: 'verified',
  })
  collector.readExternalStrategyWalletBalances = async () => ({ eth: 0.01, usdg: 2, pair: 100 })
  const comparisonStates = collector.comparisonPools.map((pool) =>
    pool.poolId === tracker.pool.poolId ? [[1n << 96n, 320_500, 0, tracker.pool.feePips], 10_000n] : null,
  )

  try {
    const [strategy] = await collector.buildExternalStrategySnapshots({
      safeBlock: { number: 123n, hash: `0x${'aa'.repeat(32)}` },
      comparisonStates,
      ethQuote: { status: 'verified_quote', ethUsdg: 2_000 },
    })
    assert.equal(strategy.status, 'VERIFIED')
    assert.equal(strategy.positions[0].bandLabel, 'B1')
    assert.equal(strategy.totals.principalUsdg, 10)
    assert.equal(strategy.totals.accruedFeesUsdg, 0.2)
    assert.ok(strategy.totals.idleUsdgValue > 2)
    assert.equal(strategy.totals.gasReserveUsdg, 20)
    assert.equal(strategy.evidence.costBasis, 'UNKNOWN_NOT_IN_PUBLIC_LEDGER')
    assert.equal(strategy.evidence.keeperRuntime, 'NOT_OBSERVED_BY_DASHBOARD')

    collector.readExternalStrategyWalletBalances = async () => {
      throw new Error('wallet read failed at https://private-rpc.example/key')
    }
    const [degraded] = await collector.buildExternalStrategySnapshots({
      safeBlock: { number: 124n, hash: `0x${'bb'.repeat(32)}` },
      comparisonStates,
      ethQuote: null,
    })
    assert.equal(degraded.status, 'PARTIAL')
    assert.deepEqual(degraded.warnings, ['STRATEGY_SNAPSHOT_BUILD_FAILED'])
    assert.match(degraded.evidence.refreshError, /\[RPC\]/u)
    assert.doesNotMatch(degraded.evidence.refreshError, /private-rpc\.example/u)
  } finally {
    collector.close()
    fs.rmSync(temporaryDirectory, { force: true, recursive: true })
  }
})
