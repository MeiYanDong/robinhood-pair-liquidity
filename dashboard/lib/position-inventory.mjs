const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * @typedef {Record<string, any>} JsonObject
 * @typedef {{tokenId:string,owned:boolean,state?:JsonObject|null}} InventorySeed
 * @typedef {{transactionHash:string,logIndex:number,transactionIndex:number,blockNumber:number,blockHash:string,from:string,to:string,tokenId:string}} InventoryTransfer
 * @typedef {{tokenId:string,owner?:string|null,liquidity?:string|null,status:string,tickLower?:number|null,tickUpper?:number|null,poolKind?:string,poolId?:string|null,poolLabel?:string,poolKey?:JsonObject,dataQuality:string}} InventoryState
 * @typedef {{number:string|number|bigint,hash:string}} SafeBlock
 */

/** @param {unknown} value */
function normalizedAddress(value) {
  return String(value || '').toLowerCase()
}

/** @param {unknown} value */
function json(value) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item))
}

/** @param {string|number|bigint} value */
export function signed24(value) {
  const masked = Number(BigInt(value) & 0xffffffn)
  return masked >= 0x800000 ? masked - 0x1000000 : masked
}

/** @param {{seeds?:InventorySeed[],transfers?:InventoryTransfer[],wallet:string}} input */
export function deriveOwnedTokenIds({ seeds = [], transfers = [], wallet }) {
  const account = normalizedAddress(wallet)
  const ownership = new Map(seeds.map((seed) => [String(seed.tokenId), Boolean(seed.owned)]))
  const ordered = [...transfers].sort(
    (left, right) =>
      Number(left.blockNumber) - Number(right.blockNumber) ||
      Number(left.transactionIndex || 0) - Number(right.transactionIndex || 0) ||
      Number(left.logIndex) - Number(right.logIndex),
  )
  for (const transfer of ordered) {
    const tokenId = String(transfer.tokenId)
    if (normalizedAddress(transfer.to) === account) ownership.set(tokenId, true)
    if (normalizedAddress(transfer.from) === account) ownership.set(tokenId, false)
  }
  return [...ownership.entries()]
    .filter(([, owned]) => owned)
    .map(([tokenId]) => tokenId)
    .sort((left, right) => {
      const a = BigInt(left)
      const b = BigInt(right)
      return a < b ? -1 : a > b ? 1 : 0
    })
}

/**
 * @param {{tokenId:string|number|bigint,owner:string,liquidity:string|number|bigint,poolKey:JsonObject,info:string|number|bigint,registry?:JsonObject[],wallet:string}} input
 */
export function decodePositionInfo({ tokenId, owner, liquidity, poolKey, info, registry = [], wallet }) {
  const prefix = (BigInt(info) >> 56n).toString(16).padStart(50, '0').toLowerCase()
  const pool = registry.find((candidate) =>
    String(candidate.poolId || '')
      .slice(2)
      .toLowerCase()
      .startsWith(prefix),
  )
  const owned = normalizedAddress(owner) === normalizedAddress(wallet)
  const amount = BigInt(liquidity)
  return {
    tokenId: String(tokenId),
    owner,
    liquidity: amount.toString(),
    status: owned ? (amount > 0n ? 'active' : 'empty') : 'owner_mismatch',
    tickLower: signed24(BigInt(info) >> 8n),
    tickUpper: signed24(BigInt(info) >> 32n),
    poolKind: pool?.poolKind || 'unknown',
    poolId: pool?.poolId || `prefix:${prefix}`,
    poolLabel: pool?.label || 'UNKNOWN POOL',
    poolKey: {
      currency0: poolKey.currency0,
      currency1: poolKey.currency1,
      feePips: Number(poolKey.fee),
      tickSpacing: Number(poolKey.tickSpacing),
      hooks: poolKey.hooks,
    },
    dataQuality: 'verified_same_safe_block',
  }
}

/**
 * @param {{expectedBalance:string|number|bigint,ownedTokenIds:string[],states:InventoryState[],safeBlock:SafeBlock}} input
 */
export function inventoryAudit({ expectedBalance, ownedTokenIds, states, safeBlock }) {
  const expected = Number(expectedBalance)
  const stateById = new Map(states.map((state) => [String(state.tokenId), state]))
  const failedTokenIds = ownedTokenIds.filter((tokenId) => {
    const state = stateById.get(String(tokenId))
    return !state || state.dataQuality !== 'verified_same_safe_block' || state.status === 'read_failed'
  })
  const verifiedOwned = states.filter(
    (state) => state.dataQuality === 'verified_same_safe_block' && ['active', 'empty'].includes(state.status),
  ).length
  const balanceMatches = Number.isSafeInteger(expected) && expected === ownedTokenIds.length
  const complete = balanceMatches && failedTokenIds.length === 0 && verifiedOwned === ownedTokenIds.length
  return {
    status: complete ? 'VERIFIED' : 'PARTIAL',
    inventoryStatus: complete ? 'verified_complete_at_safe_block' : 'partial_inventory_reconciliation',
    safeBlock: String(safeBlock.number),
    safeBlockHash: safeBlock.hash,
    expectedBalance: Number.isSafeInteger(expected) ? expected : null,
    inferredOwnedNfts: ownedTokenIds.length,
    verifiedOwnedNfts: verifiedOwned,
    balanceMatches,
    failedTokenIds,
    method: 'PositionManager Transfer cursor plus same-safe-block balanceOf/ownerOf/liquidity/pool-info reconciliation',
  }
}

/** @param {InventoryState} state @param {InventoryTransfer|null} firstTransfer */
function externalPosition(state, firstTransfer = null) {
  return {
    tokenId: String(state.tokenId),
    supplyEvents: [],
    label: `链上发现 NFT #${state.tokenId}`,
    role: 'external-unclassified',
    poolKind: state.poolKind,
    tickLower: state.tickLower,
    tickUpper: state.tickUpper,
    mint: firstTransfer
      ? {
          blockNumber: String(firstTransfer.blockNumber),
          transactionHash: firstTransfer.transactionHash,
          at: null,
          source: 'PositionManager Transfer auto-discovery',
        }
      : null,
    localState: {
      status: 'chain_discovered_unclassified',
      source: 'automatic_position_inventory',
    },
    poolId: state.poolId,
    poolLabel: state.poolLabel,
    poolKey: state.poolKey,
    lastKnownStatus: state.status,
    lastKnownLiquidity: state.liquidity,
    owner: state.owner,
    chainDataQuality: state.dataQuality,
    accountingBoundary: 'UNKNOWN_EXTERNAL_ORIGIN',
  }
}

/**
 * @param {{manifest:JsonObject|null,states?:InventoryState[],audit:JsonObject,firstTransfers?:Map<string,InventoryTransfer>}} input
 */
export function mergeRuntimePortfolioManifest({ manifest, states = [], audit, firstTransfers = new Map() }) {
  if (!manifest) return null
  /** @type {JsonObject[]} */
  const manifestPositions = manifest.positions
  const stateById = new Map(states.map((state) => [String(state.tokenId), state]))
  const existingIds = new Set(manifestPositions.map((position) => String(position.tokenId)))
  const positions = manifestPositions.map((position) => {
    const state = stateById.get(String(position.tokenId))
    if (!state) return position
    return {
      ...position,
      poolKind: state.poolKind === 'unknown' ? position.poolKind : state.poolKind,
      poolId: state.poolKind === 'unknown' ? position.poolId : state.poolId,
      poolLabel: state.poolKind === 'unknown' ? position.poolLabel : state.poolLabel,
      poolKey: state.poolKey || position.poolKey,
      tickLower: Number.isInteger(state.tickLower) ? state.tickLower : position.tickLower,
      tickUpper: Number.isInteger(state.tickUpper) ? state.tickUpper : position.tickUpper,
      lastKnownStatus: state.status,
      lastKnownLiquidity: state.liquidity,
      owner: state.owner || position.owner,
      chainDataQuality: state.dataQuality,
    }
  })
  for (const state of states) {
    const tokenId = String(state.tokenId)
    if (existingIds.has(tokenId)) continue
    positions.push(externalPosition(state, firstTransfers.get(tokenId)))
  }
  positions.sort((left, right) => {
    const a = BigInt(left.tokenId)
    const b = BigInt(right.tokenId)
    return a < b ? -1 : a > b ? 1 : 0
  })
  return {
    ...manifest,
    positions,
    audit: {
      ...manifest.audit,
      ...audit,
      localIds: positions.map((position) => String(position.tokenId)),
      chainIds: states.map((state) => String(state.tokenId)),
      missingOnChain: positions
        .filter((position) => !stateById.has(String(position.tokenId)))
        .map((position) => String(position.tokenId)),
      missingLocally: states
        .filter((state) => !existingIds.has(String(state.tokenId)))
        .map((state) => String(state.tokenId)),
      source: audit?.method || manifest.audit?.source,
    },
  }
}

export class PositionInventoryRepository {
  /** @param {any} db */
  constructor(db) {
    /** @type {any} */
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS position_inventory_seed (
        token_id TEXT PRIMARY KEY,
        owned INTEGER NOT NULL,
        state_json TEXT
      );
      CREATE TABLE IF NOT EXISTS position_inventory_transfers (
        transaction_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        transaction_index INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        token_id TEXT NOT NULL,
        PRIMARY KEY (transaction_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS position_inventory_transfers_block_idx
        ON position_inventory_transfers(block_number, transaction_index, log_index);
      CREATE TABLE IF NOT EXISTS position_inventory_states (
        token_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS position_inventory_snapshots (
        token_id TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        state_json TEXT NOT NULL,
        PRIMARY KEY (token_id, block_number)
      );
      CREATE INDEX IF NOT EXISTS position_inventory_snapshots_block_idx
        ON position_inventory_snapshots(block_number, token_id);
    `)
    this.insertSeed = this.db.prepare(
      'INSERT OR REPLACE INTO position_inventory_seed (token_id, owned, state_json) VALUES (?, ?, ?)',
    )
    this.insertTransfer = this.db.prepare(`
      INSERT OR REPLACE INTO position_inventory_transfers
      (transaction_hash, log_index, transaction_index, block_number, block_hash, from_address, to_address, token_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.insertState = this.db.prepare(`
      INSERT OR REPLACE INTO position_inventory_states
      (token_id, state_json, block_number, block_hash) VALUES (?, ?, ?, ?)
    `)
    this.insertSnapshot = this.db.prepare(`
      INSERT OR REPLACE INTO position_inventory_snapshots
      (token_id, block_number, block_hash, state_json) VALUES (?, ?, ?, ?)
    `)
    if (!this.getMeta('schema_version')) this.setMeta('schema_version', '1')
  }

  /** @param {string} key */
  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`inventory:${key}`)?.value ?? null
  }

  /** @param {string} key @param {string|number|bigint} value */
  setMeta(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`inventory:${key}`, String(value))
  }

  initialized() {
    return this.getMeta('initialized') === '1'
  }

  /** @param {{manifest:JsonObject,wallet:string,positionManager?:string}} input */
  initializeFromManifest({ manifest, wallet, positionManager = '' }) {
    const blockNumber = BigInt(manifest.audit.safeBlock)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.clearTables()
      for (const position of manifest.positions) {
        const owned = normalizedAddress(position.owner) === normalizedAddress(wallet)
        this.insertSeed.run(String(position.tokenId), Number(owned), json(position))
      }
      this.setMeta('initialized', '1')
      this.setMeta('schema_version', '1')
      this.setMeta('mode', 'manifest_seed')
      this.setMeta('wallet', normalizedAddress(wallet))
      this.setMeta('position_manager', normalizedAddress(positionManager))
      this.setMeta('seed_block', blockNumber)
      this.setMeta('seed_hash', manifest.audit.safeBlockHash)
      this.setMeta('scan_from_block', manifest.audit.scanFromBlock)
      this.setMeta('cursor_block', blockNumber)
      this.setMeta('cursor_hash', manifest.audit.safeBlockHash)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** @param {{scanFromBlock:string|number|bigint,wallet?:string,positionManager?:string}} input */
  initializeFullScan({ scanFromBlock, wallet = '', positionManager = '' }) {
    const cursor = BigInt(scanFromBlock) - 1n
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.clearTables()
      this.setMeta('initialized', '1')
      this.setMeta('schema_version', '1')
      this.setMeta('mode', 'full_scan')
      this.setMeta('wallet', normalizedAddress(wallet))
      this.setMeta('position_manager', normalizedAddress(positionManager))
      this.setMeta('seed_block', cursor)
      this.setMeta('seed_hash', '')
      this.setMeta('scan_from_block', scanFromBlock)
      this.setMeta('cursor_block', cursor)
      this.setMeta('cursor_hash', '')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  clearTables() {
    this.db.prepare('DELETE FROM position_inventory_seed').run()
    this.db.prepare('DELETE FROM position_inventory_transfers').run()
    this.db.prepare('DELETE FROM position_inventory_states').run()
    this.db.prepare('DELETE FROM position_inventory_snapshots').run()
    this.db.prepare("DELETE FROM meta WHERE key LIKE 'inventory:%'").run()
  }

  cursor() {
    return BigInt(this.getMeta('cursor_block'))
  }

  cursorHash() {
    return this.getMeta('cursor_hash') || ''
  }

  scanFromBlock() {
    return BigInt(this.getMeta('scan_from_block'))
  }

  /** @param {{logs:JsonObject[],cursorBlock:string|number|bigint,cursorHash:string}} input */
  commitTransfers({ logs, cursorBlock, cursorHash }) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const log of logs) {
        this.insertTransfer.run(
          log.transactionHash,
          Number(log.logIndex),
          Number(log.transactionIndex || 0),
          Number(log.blockNumber),
          log.blockHash,
          log.args.from,
          log.args.to,
          log.args.tokenId.toString(),
        )
      }
      this.setMeta('cursor_block', cursorBlock)
      this.setMeta('cursor_hash', cursorHash)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  seeds() {
    return this.db
      .prepare('SELECT token_id, owned, state_json FROM position_inventory_seed')
      .all()
      .map((/** @type {any} */ row) => ({
        tokenId: row.token_id,
        owned: Boolean(row.owned),
        state: row.state_json ? JSON.parse(row.state_json) : null,
      }))
  }

  transfers() {
    return this.db
      .prepare(
        `
        SELECT transaction_hash, log_index, transaction_index, block_number, block_hash,
               from_address, to_address, token_id
        FROM position_inventory_transfers
        ORDER BY block_number, transaction_index, log_index
      `,
      )
      .all()
      .map((/** @type {any} */ row) => ({
        transactionHash: row.transaction_hash,
        logIndex: row.log_index,
        transactionIndex: row.transaction_index,
        blockNumber: row.block_number,
        blockHash: row.block_hash,
        from: row.from_address,
        to: row.to_address,
        tokenId: row.token_id,
      }))
  }

  /** @param {string} wallet */
  ownedTokenIds(wallet) {
    return deriveOwnedTokenIds({ seeds: this.seeds(), transfers: this.transfers(), wallet })
  }

  firstTransfers() {
    const first = new Map()
    for (const transfer of this.transfers()) {
      if (normalizedAddress(transfer.to) === ZERO_ADDRESS) continue
      if (!first.has(transfer.tokenId)) first.set(transfer.tokenId, transfer)
    }
    return first
  }

  /** @param {{states:InventoryState[],safeBlock:SafeBlock,audit:JsonObject}} input */
  saveStates({ states, safeBlock, audit }) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const state of states) {
        const serialized = json(state)
        this.insertState.run(String(state.tokenId), serialized, Number(safeBlock.number), safeBlock.hash)
        this.insertSnapshot.run(String(state.tokenId), Number(safeBlock.number), safeBlock.hash, serialized)
      }
      this.setMeta('state_block', safeBlock.number)
      this.setMeta('state_hash', safeBlock.hash)
      this.setMeta('audit', json(audit))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  states() {
    return this.db
      .prepare('SELECT state_json FROM position_inventory_states ORDER BY CAST(token_id AS INTEGER)')
      .all()
      .map((/** @type {any} */ row) => JSON.parse(row.state_json))
  }
}
