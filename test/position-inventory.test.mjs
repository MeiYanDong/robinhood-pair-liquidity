import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  PositionInventoryRepository,
  decodePositionInfo,
  deriveOwnedTokenIds,
  inventoryAudit,
  mergeRuntimePortfolioManifest,
} from '../dashboard/lib/position-inventory.mjs'

const WALLET = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const ZERO = '0x0000000000000000000000000000000000000000'

function transfer(tokenId, blockNumber, from, to, logIndex = 0) {
  return {
    transactionHash: `0x${String(tokenId).padStart(64, '0')}`,
    logIndex,
    transactionIndex: 0,
    blockNumber,
    blockHash: `0x${String(blockNumber).padStart(64, '0')}`,
    from,
    to,
    tokenId: String(tokenId),
  }
}

test('inventory ownership follows ordered incoming and outgoing ERC721 transfers', () => {
  const owned = deriveOwnedTokenIds({
    wallet: WALLET,
    seeds: [
      { tokenId: '1', owned: true },
      { tokenId: '2', owned: true },
    ],
    transfers: [
      transfer(3, 12, ZERO, WALLET),
      transfer(1, 11, WALLET, OTHER),
      transfer(1, 13, OTHER, WALLET),
      transfer(2, 14, WALLET, OTHER),
    ],
  })
  assert.deepEqual(owned, ['1', '3'])
})

test('position info decoder resolves signed ticks and a registry pool prefix', () => {
  const poolId = `0x${'ab'.repeat(25)}${'cd'.repeat(7)}`
  const tickLower = -400
  const tickUpper = 800
  const uint24 = (value) => BigInt(value < 0 ? value + 0x1000000 : value)
  const prefix = BigInt(`0x${poolId.slice(2, 52)}`)
  const info = (prefix << 56n) | (uint24(tickUpper) << 32n) | (uint24(tickLower) << 8n)
  const decoded = decodePositionInfo({
    tokenId: '9',
    owner: WALLET,
    wallet: WALLET,
    liquidity: 123n,
    info,
    registry: [{ poolId, poolKind: 'pair-spy', label: 'PAIR / SPY' }],
    poolKey: {
      currency0: WALLET,
      currency1: OTHER,
      fee: 10_000,
      tickSpacing: 200,
      hooks: ZERO,
    },
  })
  assert.equal(decoded.tickLower, tickLower)
  assert.equal(decoded.tickUpper, tickUpper)
  assert.equal(decoded.poolId, poolId)
  assert.equal(decoded.status, 'active')
})

test('runtime manifest overlays known positions and adds chain-discovered positions without inventing basis', () => {
  const audit = inventoryAudit({
    expectedBalance: 2n,
    ownedTokenIds: ['1', '2'],
    safeBlock: { number: 99n, hash: '0xsafe' },
    states: [
      { tokenId: '1', status: 'empty', dataQuality: 'verified_same_safe_block' },
      { tokenId: '2', status: 'active', dataQuality: 'verified_same_safe_block' },
    ],
  })
  const runtime = mergeRuntimePortfolioManifest({
    manifest: {
      schemaVersion: 1,
      positions: [
        {
          tokenId: '1',
          owner: WALLET,
          poolKind: 'pair-spy',
          poolId: '0xpool',
          poolLabel: 'PAIR / SPY',
          tickLower: 1,
          tickUpper: 2,
          lastKnownLiquidity: '9',
          supplyEvents: [],
        },
      ],
      audit: {},
      transactions: [],
    },
    audit,
    states: [
      {
        tokenId: '1',
        owner: WALLET,
        liquidity: '0',
        status: 'empty',
        tickLower: 10,
        tickUpper: 20,
        poolKind: 'pair-spy',
        poolId: '0xpool',
        poolLabel: 'PAIR / SPY',
        dataQuality: 'verified_same_safe_block',
      },
      {
        tokenId: '2',
        owner: WALLET,
        liquidity: '10',
        status: 'active',
        tickLower: 30,
        tickUpper: 40,
        poolKind: 'pair-usdg',
        poolId: '0xdirect',
        poolLabel: 'PAIR / USDG',
        dataQuality: 'verified_same_safe_block',
      },
    ],
  })
  assert.equal(runtime.positions[0].lastKnownLiquidity, '0')
  assert.equal(runtime.positions[1].role, 'external-unclassified')
  assert.equal(runtime.positions[1].accountingBoundary, 'UNKNOWN_EXTERNAL_ORIGIN')
  assert.deepEqual(runtime.positions[1].supplyEvents, [])
  assert.equal(runtime.audit.inventoryStatus, 'verified_complete_at_safe_block')
  assert.deepEqual(runtime.audit.missingLocally, ['2'])
})

test('inventory audit fails closed when ERC721 balance and inferred ownership diverge', () => {
  const audit = inventoryAudit({
    expectedBalance: 2n,
    ownedTokenIds: ['1'],
    safeBlock: { number: 99n, hash: '0xsafe' },
    states: [{ tokenId: '1', status: 'active', dataQuality: 'verified_same_safe_block' }],
  })
  assert.equal(audit.status, 'PARTIAL')
  assert.equal(audit.balanceMatches, false)
  assert.equal(audit.inventoryStatus, 'partial_inventory_reconciliation')
})

test('SQLite inventory cursor is idempotent and survives repository recreation', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const manifest = {
    audit: { safeBlock: '10', safeBlockHash: '0x10', scanFromBlock: '1' },
    positions: [{ tokenId: '1', owner: WALLET }],
  }
  let repository = new PositionInventoryRepository(db)
  repository.initializeFromManifest({ manifest, wallet: WALLET })
  const log = {
    transactionHash: '0xabc',
    logIndex: 0n,
    transactionIndex: 0n,
    blockNumber: 11n,
    blockHash: '0x11',
    args: { from: ZERO, to: WALLET, tokenId: 2n },
  }
  repository.commitTransfers({ logs: [log, log], cursorBlock: 11n, cursorHash: '0x11' })
  assert.deepEqual(repository.ownedTokenIds(WALLET), ['1', '2'])
  assert.equal(repository.transfers().length, 1)

  repository = new PositionInventoryRepository(db)
  assert.equal(repository.cursor(), 11n)
  assert.deepEqual(repository.ownedTokenIds(WALLET), ['1', '2'])
  assert.equal(repository.getMeta('schema_version'), '1')
  db.close()
})
