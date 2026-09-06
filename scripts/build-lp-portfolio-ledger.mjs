import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createPublicClient, defineChain, formatUnits, getAddress, http, parseAbi, parseAbiItem } from 'viem'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONFIG_PATH = path.join(ROOT, 'dashboard', 'config', 'pair-spy.json')
const OVERRIDES_PATH = path.join(ROOT, 'dashboard', 'config', 'lp-portfolio-overrides.json')
const OUTPUT_PATH = path.join(ROOT, 'dashboard', 'config', 'lp-portfolio-ledger.json')
const HISTORY_DB = path.join(ROOT, 'runs', 'pair-dashboard', 'history.sqlite')
const FEES_TO_PAIR_HISTORY_DIR = path.join(ROOT, 'runs', 'pair-fees-to-pair-history')
const POSITION_INCREASE_HISTORY_DIR = path.join(ROOT, 'runs', 'pair-position-pair-increase-history')
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)')
const POSITION_MANAGER_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)',
])

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readOptionalJson(filePath) {
  return fs.existsSync(filePath) ? readJson(filePath) : null
}

function readFeesToPairStates() {
  const states = new Map()
  if (fs.existsSync(FEES_TO_PAIR_HISTORY_DIR)) {
    for (const name of fs
      .readdirSync(FEES_TO_PAIR_HISTORY_DIR)
      .filter((item) => item.endsWith('.json'))
      .sort()) {
      const state = readJson(path.join(FEES_TO_PAIR_HISTORY_DIR, name))
      if (state?.operationId) states.set(state.operationId, state)
    }
  }
  for (const currentName of ['pair-fees-to-pair-live.json', 'pair-fees-collect-live.json']) {
    const current = readOptionalJson(path.join(ROOT, 'runs', currentName))
    if (current?.operationId) states.set(current.operationId, current)
  }
  return [...states.values()].sort((left, right) =>
    String(left.createdAt || '').localeCompare(String(right.createdAt || '')),
  )
}

function readPositionIncreaseStates() {
  const states = new Map()
  if (fs.existsSync(POSITION_INCREASE_HISTORY_DIR)) {
    for (const name of fs
      .readdirSync(POSITION_INCREASE_HISTORY_DIR)
      .filter((item) => item.endsWith('.json'))
      .sort()) {
      const state = readJson(path.join(POSITION_INCREASE_HISTORY_DIR, name))
      if (state?.operationId) states.set(state.operationId, state)
    }
  }
  const current = readOptionalJson(path.join(ROOT, 'runs', 'pair-position-pair-increase-live.json'))
  if (current?.operationId) states.set(current.operationId, current)
  return [...states.values()].sort((left, right) =>
    String(left.createdAt || '').localeCompare(String(right.createdAt || '')),
  )
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function humanAmounts(raw = {}) {
  return {
    eth: Number(raw.eth || 0),
    spy: Number(raw.spy || 0),
    pair: Number(raw.pair || 0),
    usdg: Number(raw.usdg ?? raw.usdgToken ?? 0),
    one: Number(raw.one || 0),
  }
}

function subtractAmounts(left = {}, right = {}) {
  const result = mergeAmounts(left)
  for (const field of Object.keys(result)) {
    result[field] = Math.max(0, result[field] - Number(right?.[field] || 0))
  }
  return result
}

function preflightSource(record = {}) {
  return record.sourcePosition || record.source || null
}

function pairMarkFromPreflight(record = {}) {
  record = record || {}
  const pool = record.pool || {}
  let pairUsdg = Number(pool.currentPairPriceUsdg)
  let spyUsdg = Number(pool.spyPriceUsdg)
  if (!Number.isFinite(pairUsdg)) {
    const range =
      pool.approximatePairPriceRangeUsdg ||
      record.satellite?.approximatePairPriceRangeUsdg ||
      record.target?.priceRangeUsdg
    const currentTick = Number(pool.currentTick ?? record.satellite?.currentTick)
    const tickLower = Number(
      pool.targetTickLower ??
        record.satellite?.tickLower ??
        record.target?.tickLower ??
        preflightSource(record)?.tickLower,
    )
    const rangePrices = [Number(range?.lower ?? range?.low), Number(range?.upper ?? range?.high)].filter(
      (value) => Number.isFinite(value) && value > 0,
    )
    if (Number.isFinite(currentTick) && Number.isFinite(tickLower) && rangePrices.length) {
      const highAtLowerTick = Math.max(...rangePrices)
      pairUsdg = highAtLowerTick / Math.pow(1.0001, currentTick - tickLower)
    }
  }
  if (!Number.isFinite(pairUsdg) && record.newPrincipal) {
    const targetUsdg = Number(record.newPrincipal.targetPerSideUsdg)
    const pairAmount = Number(record.newPrincipal.pair)
    if (targetUsdg > 0 && pairAmount > 0) pairUsdg = targetUsdg / pairAmount
    const spyAmount = Number(record.newPrincipal.spy)
    if (targetUsdg > 0 && spyAmount > 0) spyUsdg = targetUsdg / spyAmount
  }
  const currentTick = Number(pool.currentTick ?? pool.tick ?? record.satellite?.currentTick)
  if (!Number.isFinite(spyUsdg) && Number.isFinite(pairUsdg) && Number.isFinite(currentTick)) {
    spyUsdg = pairUsdg * Math.pow(1.0001, currentTick)
  }
  if (!Number.isFinite(pairUsdg) || pairUsdg <= 0) return null
  return {
    ...(Number.isFinite(spyUsdg) && spyUsdg > 0 ? { spyUsdg } : {}),
    pairUsdg,
    quality: record.newPrincipal ? 'target_notional_implied' : 'operation_preflight_snapshot',
  }
}

function latestPreflight(records, { tokenId, beforeBlock, eventNames = null }) {
  const maximumBlock = Number(beforeBlock || Number.MAX_SAFE_INTEGER)
  const allowed = eventNames ? new Set(eventNames) : null
  return (
    records
      .filter((record) => {
        if (!String(record.event || '').endsWith('_preflight') && record.event !== 'preflight') return false
        if (allowed && !allowed.has(record.event)) return false
        if (Number(record.blockNumber || 0) > maximumBlock) return false
        if (!tokenId) return true
        const sourceTokenId = preflightSource(record)?.tokenId || record.tokenId
        return String(sourceTokenId || '') === String(tokenId)
      })
      .sort((left, right) => Number(left.blockNumber || 0) - Number(right.blockNumber || 0))
      .at(-1) || null
  )
}

function decimal(raw, decimals = 18) {
  if (raw == null) return 0
  return Number(formatUnits(BigInt(raw), decimals))
}

function amounts(raw = {}) {
  return {
    eth: decimal(raw.ethWei),
    spy: decimal(raw.spyWei),
    pair: decimal(raw.pairWei),
    usdg: decimal(raw.usdgAtomic, 6),
    one: decimal(raw.oneAtomic),
  }
}

function mergeAmounts(...items) {
  return items.reduce(
    (total, item) => ({
      eth: total.eth + Number(item?.eth || 0),
      spy: total.spy + Number(item?.spy || 0),
      pair: total.pair + Number(item?.pair || 0),
      usdg: total.usdg + Number(item?.usdg || 0),
      one: total.one + Number(item?.one || 0),
    }),
    { eth: 0, spy: 0, pair: 0, usdg: 0, one: 0 },
  )
}

function classifyAction(label = '') {
  if (/撤出|撤空|remove/iu.test(label)) return 'remove'
  if (/配平|换入|换成|兑换|swap/iu.test(label)) return 'swap'
  if (/领取|collect/iu.test(label)) return 'fee_claim'
  if (/铸造|重建.*(?:LP|单边)|mint/iu.test(label)) return 'mint'
  if (/增加|追加|increase/iu.test(label)) return 'increase'
  if (/买入|buy/iu.test(label)) return 'fund_swap'
  if (/授权|approve/iu.test(label)) return 'approval'
  return 'other'
}

function buildTransactions(jsonlPaths, overrides) {
  const transactions = new Map()
  for (const filePath of jsonlPaths) {
    const records = readJsonl(filePath)
    const pendingByLabel = new Map()
    const preparedByHash = new Map()
    for (const record of records) {
      if (record.event === 'transaction_prepared') {
        pendingByLabel.set(record.label, record)
        continue
      }
      if (record.event === 'broadcast' && record.hash) {
        const prepared = pendingByLabel.get(record.label)
        if (prepared) preparedByHash.set(record.hash.toLowerCase(), prepared)
        continue
      }
      if (!['receipt_success', 'receipt_reverted'].includes(record.event) || !record.hash) continue
      const prepared = preparedByHash.get(record.hash.toLowerCase()) || pendingByLabel.get(record.label) || {}
      const valueWei = prepared.valueWei || '0'
      const action = classifyAction(record.label)
      transactions.set(record.hash.toLowerCase(), {
        at: record.at,
        blockNumber: String(record.blockNumber || ''),
        hash: record.hash,
        label: record.label,
        status: record.event === 'receipt_success' ? 'success' : 'reverted',
        gasUsed: String(record.gasUsed || ''),
        effectiveGasPrice: String(record.effectiveGasPrice || ''),
        gasCostWei: String(record.gasCostWei || '0'),
        valueEth: decimal(valueWei),
        action,
        capitalFlow: BigInt(valueWei) > 0n && ['fund_swap', 'swap'].includes(action) ? 'lp_directed' : null,
        evidence: 'local_receipt_record',
        evidenceRank: 3,
      })
    }
  }
  for (const transaction of overrides.manualTransactions || []) {
    transactions.set(transaction.hash.toLowerCase(), {
      ...transaction,
      valueEth: Number(transaction.valueEth || 0),
      evidence: 'canonical_receipt_readback',
      evidenceRank: 4,
    })
  }
  return [...transactions.values()].sort((left, right) => Number(left.blockNumber) - Number(right.blockNumber))
}

function makeMarkReader(databasePath) {
  if (!fs.existsSync(databasePath)) return () => null
  const database = new DatabaseSync(databasePath, { readOnly: true })
  const pair = database.prepare(`
    SELECT tick FROM pair_swaps
    WHERE block_number <= ?
    ORDER BY block_number DESC, transaction_index DESC, log_index DESC
    LIMIT 1
  `)
  const spy = database.prepare(`
    SELECT spy_usdg FROM spy_marks
    WHERE block_number <= ?
    ORDER BY block_number DESC, transaction_index DESC, log_index DESC
    LIMIT 1
  `)
  const firstPair = database.prepare('SELECT MIN(block_number) AS block_number FROM pair_swaps').get()
  const read = (blockNumber) => {
    if (!blockNumber || Number(blockNumber) < Number(firstPair?.block_number || Infinity)) return null
    const pairRow = pair.get(Number(blockNumber))
    const spyRow = spy.get(Number(blockNumber))
    if (!pairRow || !spyRow) return null
    const spyUsdg = Number(spyRow.spy_usdg)
    return {
      spyUsdg,
      pairUsdg: spyUsdg / Math.pow(1.0001, Number(pairRow.tick)),
      quality: 'nearest_prior_canonical_swap',
    }
  }
  read.close = () => database.close()
  return read
}

function txContext(transactions) {
  return new Map(transactions.map((transaction) => [transaction.hash.toLowerCase(), transaction]))
}

function eventContext({ id, kind, transactionHash, at, blockNumber, amountValues, raw, mark, source, quality, note }) {
  return {
    id,
    kind,
    at: at || null,
    blockNumber: blockNumber ? String(blockNumber) : null,
    transactionHash: transactionHash || null,
    amounts: amountValues || amounts(raw),
    mark: mark || null,
    source,
    quality,
    note: note || null,
  }
}

function buildLocalModel({
  pairState,
  directState,
  oneState,
  feesToPairStates,
  singleRollState,
  positionIncreaseStates,
  overrides,
  transactions,
  markAt,
  pairRecords,
}) {
  const positions = new Map()
  const txs = txContext(transactions)
  const singleRollMark = singleRollState?.postAudit?.mintMark
    ? {
        spyUsdg: Number(singleRollState.postAudit.mintMark.spyUsdg),
        pairUsdg: Number(singleRollState.postAudit.mintMark.pairUsdg),
        quality: singleRollState.postAudit.mintMark.quality || 'same_block_pool_readback',
      }
    : null
  const markForPositionIncrease = (increase) => {
    const blockNumber = increase.result?.blockNumber || increase.steps?.increase_target?.blockNumber
    const fallback = markAt(blockNumber)
    const spyUsdg = Number(fallback?.spyUsdg)
    const buildTick = Number(increase.mintPlan?.buildTick)
    if (!Number.isFinite(spyUsdg) || spyUsdg <= 0 || !Number.isFinite(buildTick)) return fallback
    return {
      spyUsdg,
      pairUsdg: spyUsdg / Math.pow(1.0001, buildTick),
      quality: 'operation_build_tick_plus_nearest_spy_mark',
    }
  }

  function upsertPosition(position, poolKind, source) {
    if (!position?.tokenId) return
    const tokenId = String(position.tokenId)
    const previous = positions.get(tokenId) || { tokenId, supplyEvents: [] }
    const metadata = overrides.positionMetadata?.[tokenId] || {}
    const mintBlock = position.mintBlock || position.minted?.blockNumber || ''
    const mintTransaction = position.mintTransaction || position.minted?.transaction || null
    positions.set(tokenId, {
      ...previous,
      tokenId,
      label: metadata.label || position.label || previous.label || `NFT ${tokenId}`,
      role: metadata.role || position.role || previous.role || 'historical',
      poolKind: previous.poolKind || poolKind,
      tickLower: Number(position.tickLower ?? previous.tickLower),
      tickUpper: Number(position.tickUpper ?? previous.tickUpper),
      mint: previous.mint || {
        blockNumber: String(mintBlock),
        transactionHash: mintTransaction,
        at: position.enteredAt || position.completedAt || null,
        source,
      },
      localState: {
        status: position.status || previous.localState?.status || null,
        source: position.source || previous.localState?.source || null,
      },
    })
  }

  for (const position of pairState.retiredPositions || [])
    upsertPosition(position, 'pair-spy', 'pair-lp retiredPositions')
  for (const position of pairState.satellites || []) upsertPosition(position, 'pair-spy', 'pair-lp satellites')
  upsertPosition(pairState.position, 'pair-spy', 'pair-lp reconciled position')
  upsertPosition(directState.position, 'pair-usdg', 'pair-usdg position')
  upsertPosition(oneState.position, 'one-usdg', 'one-usdg position')
  for (const position of overrides.manualPositions || []) {
    upsertPosition(position, position.poolKind || 'pair-spy', 'audited manual position override')
  }
  if (singleRollState?.status === 'complete' && singleRollState.result?.targetTokenId) {
    upsertPosition(
      {
        ...singleRollState.source,
        tokenId: singleRollState.result.sourceTokenId,
        status: 'empty',
      },
      'pair-spy',
      'single-sided roll source',
    )
    upsertPosition(
      {
        tokenId: singleRollState.result.targetTokenId,
        tickLower: singleRollState.result.targetTickLower,
        tickUpper: singleRollState.result.targetTickUpper,
        status: 'active',
        mintTransaction: singleRollState.steps?.mint_target?.hash,
        mintBlock: singleRollState.steps?.mint_target?.blockNumber,
        enteredAt: singleRollState.completedAt,
      },
      'pair-spy',
      'single-sided roll target',
    )
  }
  for (const increase of positionIncreaseStates || []) {
    if (increase.status !== 'complete' || !increase.result?.targetTokenId) continue
    upsertPosition(
      {
        tokenId: increase.result.targetTokenId,
        tickLower: increase.result.tickLower,
        tickUpper: increase.result.tickUpper,
        status: 'active',
      },
      'pair-spy',
      'existing-position increase target',
    )
  }

  function addSupply(tokenId, event) {
    const position = positions.get(String(tokenId))
    if (!position) throw new Error(`Supply event references unknown NFT ${tokenId}`)
    position.supplyEvents.push(event)
  }

  const initialMintTx = pairState.retiredPositions?.find((item) => String(item.tokenId) === '1548977')?.mintTransaction
  const initialMintContext = initialMintTx ? txs.get(initialMintTx.toLowerCase()) : null
  addSupply(
    '1548977',
    eventContext({
      id: 'genesis-mint-1548977',
      kind: 'mint',
      transactionHash: initialMintTx,
      at: initialMintContext?.at,
      blockNumber: initialMintContext?.blockNumber,
      raw: { spyWei: pairState.entry.lpAmount0DesiredWei, pairWei: pairState.entry.lpAmount1DesiredWei },
      source: 'local_execution_record',
      quality: 'desired_amounts_near_actual',
      note: 'Initial operation was funded by 0.05 ETH; token amounts are the saved mint desires.',
    }),
  )
  for (const increase of pairState.increases || []) {
    const hash = increase.transactions?.at(-1)
    const context = hash ? txs.get(hash.toLowerCase()) : null
    addSupply(
      '1548977',
      eventContext({
        id: increase.id,
        kind: 'increase',
        transactionHash: hash,
        at: increase.completedAt || context?.at,
        blockNumber: context?.blockNumber,
        raw: increase.principalDesired,
        source: 'local_execution_record',
        quality: 'desired_amounts_with_fee_compound',
      }),
    )
  }

  const satellite164 = pairState.satellites?.find((item) => String(item.tokenId) === '1643016')
  if (satellite164)
    addSupply(
      '1643016',
      eventContext({
        id: satellite164.id,
        kind: 'mint',
        transactionHash: satellite164.mintTransaction,
        at: satellite164.completedAt,
        blockNumber: satellite164.mintBlock,
        raw: { spyWei: satellite164.minted?.underlyingSpyWei, pairWei: satellite164.minted?.underlyingPairWei },
        mark: markAt(satellite164.mintBlock),
        source: 'local_execution_record',
        quality: 'underlying_after_mint',
      }),
    )
  const migration = pairState.migrations?.[0]
  if (migration?.target)
    addSupply(
      migration.target.tokenId,
      eventContext({
        id: migration.id,
        kind: 'increase',
        transactionHash: migration.target.increaseTransaction,
        at: migration.completedAt,
        blockNumber: txs.get(migration.target.increaseTransaction.toLowerCase())?.blockNumber,
        raw: migration.target.desiredIncrease,
        mark: markAt(txs.get(migration.target.increaseTransaction.toLowerCase())?.blockNumber),
        source: 'local_execution_record',
        quality: 'desired_amounts_with_fee_compound',
      }),
    )

  for (const satellite of pairState.satellites || []) {
    const tokenId = String(satellite.tokenId)
    if (tokenId === '1643016' || ['1772811', '1773157'].includes(tokenId)) continue
    if (!satellite.minted) continue
    const mintTransaction = satellite.mintTransaction || satellite.minted?.transaction || null
    const mintBlock = satellite.mintBlock || satellite.minted?.blockNumber || null
    const mark = satellite.priceSnapshot
      ? {
          spyUsdg: Number(satellite.priceSnapshot.spyPriceUsdg),
          pairUsdg: Number(satellite.priceSnapshot.currentPairPriceUsdg),
          quality: 'operation_snapshot',
        }
      : markAt(mintBlock)
    addSupply(
      tokenId,
      eventContext({
        id: satellite.id,
        kind: 'mint',
        transactionHash: mintTransaction,
        at: satellite.completedAt,
        blockNumber: mintBlock,
        raw: { spyWei: satellite.minted.underlyingSpyWei, pairWei: satellite.minted.underlyingPairWei },
        mark,
        source: 'local_execution_record',
        quality: 'underlying_after_mint',
      }),
    )
    for (const [index, sweep] of (satellite.residualSweeps || []).entries()) {
      addSupply(
        tokenId,
        eventContext({
          id: `${satellite.id}-residual-${index + 1}`,
          kind: 'increase',
          transactionHash: sweep.transaction,
          at: sweep.completedAt,
          blockNumber: sweep.blockNumber,
          raw: { spyWei: sweep.addedUnderlyingSpyWei, pairWei: sweep.addedUnderlyingPairWei },
          mark: markAt(sweep.blockNumber),
          source: 'local_execution_record',
          quality: 'underlying_after_increase',
        }),
      )
    }
    for (const [index, increase] of (satellite.externalIncreases || []).entries()) {
      addSupply(
        tokenId,
        eventContext({
          id: `${satellite.id}-external-increase-${index + 1}`,
          kind: 'increase',
          transactionHash: increase.transaction,
          at: increase.executedAt,
          blockNumber: increase.blockNumber,
          raw: {
            spyWei: increase.addedUnderlyingSpyWei,
            pairWei: increase.addedUnderlyingPairWei,
          },
          mark: increase.priceSnapshot
            ? {
                spyUsdg: Number(increase.priceSnapshot.spyPriceUsdg),
                pairUsdg: Number(increase.priceSnapshot.currentPairPriceUsdg),
                quality: increase.priceSnapshot.quality || 'operation_snapshot',
              }
            : markAt(increase.blockNumber),
          source: increase.source || 'external_wallet_operation',
          quality: 'decoded_calldata_receipt_and_tick_math',
        }),
      )
    }
  }

  const compound = pairState.compounds?.[0]
  if (compound?.targetTokenId) {
    addSupply(
      compound.targetTokenId,
      eventContext({
        id: compound.id,
        kind: 'increase',
        transactionHash: compound.increaseTransaction,
        at: compound.completedAt,
        blockNumber: compound.increaseBlock,
        raw: {
          spyWei: compound.increase?.addedUnderlyingSpyWei,
          pairWei: compound.increase?.addedUnderlyingPairWei,
        },
        mark: {
          spyUsdg: Number(compound.priceSnapshot?.spyPriceUsdg),
          pairUsdg: Number(compound.priceSnapshot?.currentPairPriceUsdg),
          quality: 'operation_snapshot',
        },
        source: 'local_execution_record',
        quality: 'underlying_after_increase',
      }),
    )
    for (const [index, sweep] of (compound.residualSweeps || []).entries()) {
      addSupply(
        compound.targetTokenId,
        eventContext({
          id: `${compound.id}-residual-${index + 1}`,
          kind: 'increase',
          transactionHash: sweep.transaction,
          at: sweep.completedAt,
          blockNumber: sweep.blockNumber,
          raw: { spyWei: sweep.addedUnderlyingSpyWei, pairWei: sweep.addedUnderlyingPairWei },
          mark: markAt(sweep.blockNumber),
          source: 'local_execution_record',
          quality: 'underlying_after_increase',
        }),
      )
    }
  }

  const mainRoll = pairState.mainRolls?.[0]
  if (mainRoll?.target)
    addSupply(
      mainRoll.target.tokenId,
      eventContext({
        id: mainRoll.id,
        kind: 'mint',
        transactionHash: mainRoll.target.mintTransaction,
        at: mainRoll.completedAt,
        blockNumber: mainRoll.target.mintBlock,
        raw: { spyWei: mainRoll.target.underlyingSpyWei, pairWei: mainRoll.target.underlyingPairWei },
        mark: {
          spyUsdg: Number(mainRoll.priceSnapshot?.spyPriceUsdg),
          pairUsdg: Number(mainRoll.priceSnapshot?.currentPairPriceUsdg),
          quality: 'operation_snapshot',
        },
        source: 'local_execution_record',
        quality: 'underlying_after_mint',
      }),
    )

  if (singleRollState?.status === 'complete' && singleRollState.result?.targetTokenId) {
    addSupply(
      singleRollState.result.targetTokenId,
      eventContext({
        id: singleRollState.operationId,
        kind: 'mint',
        transactionHash: singleRollState.steps?.mint_target?.hash,
        at: singleRollState.completedAt,
        blockNumber: singleRollState.steps?.mint_target?.blockNumber,
        raw: { pairWei: singleRollState.result.mintedPairWei, spyWei: '0' },
        mark: singleRollMark || markAt(singleRollState.steps?.mint_target?.blockNumber),
        source: 'local_execution_record',
        quality: 'actual_wallet_spent',
        note: 'Migrated source principal plus newly claimed fees; do not count as fresh external capital.',
      }),
    )
  }

  for (const increase of positionIncreaseStates || []) {
    if (increase.status !== 'complete' || !increase.result?.targetTokenId || !increase.mintPlan) continue
    addSupply(
      increase.result.targetTokenId,
      eventContext({
        id: increase.operationId,
        kind: 'increase',
        transactionHash: increase.result.transactionHash || increase.steps?.increase_target?.hash,
        at: increase.completedAt,
        blockNumber: increase.result.blockNumber || increase.steps?.increase_target?.blockNumber,
        raw: {
          spyWei: increase.mintPlan.desiredSpyWei,
          pairWei: increase.mintPlan.desiredPairWei,
        },
        mark: markForPositionIncrease(increase),
        source: 'local_execution_record',
        quality: 'actual_wallet_delta_plus_compounded_fee_growth',
        note: `Gross liquidity input includes wallet spend plus fees compounded from NFT ${increase.result.targetTokenId}.`,
      }),
    )
  }

  for (const manual of overrides.manualSupplyEvents || []) addSupply(manual.tokenId, manual)

  addSupply(
    directState.position.tokenId,
    eventContext({
      id: directState.operationId,
      kind: 'mint',
      transactionHash: directState.position.mintTransaction,
      at: directState.position.enteredAt,
      blockNumber: directState.position.mintBlock,
      raw: {
        usdgAtomic: directState.result?.mint?.actualUsdgAtomic,
        pairWei: directState.result?.mint?.actualPairWei,
      },
      mark: { pairUsdg: Number(directState.result?.finalPool?.pairPriceUsdg), quality: 'post_mint_pool_readback' },
      source: 'local_execution_record',
      quality: 'actual_wallet_spent',
    }),
  )
  addSupply(
    oneState.position.tokenId,
    eventContext({
      id: 'one-usdg-entry',
      kind: 'mint',
      transactionHash: oneState.position.mintTransaction,
      at: oneState.entry?.enteredAt,
      blockNumber: oneState.position.mintBlock,
      amountValues: {
        eth: 0,
        spy: 0,
        pair: 0,
        usdg: Number(oneState.entry?.actualUsdgSpent || 0),
        one: Number(oneState.entry?.actualOneSpent || 0),
      },
      mark: { oneUsdg: Number(oneState.entry?.priceOneUsdg), quality: 'entry_record' },
      source: 'local_execution_record',
      quality: 'actual_wallet_spent',
    }),
  )

  const exits = new Map()
  function addExit(tokenId, exit) {
    const blockNumber = exit.blockNumber ? String(exit.blockNumber) : null
    const preflight = latestPreflight(pairRecords, { tokenId, beforeBlock: blockNumber })
    const gross = exit.grossAmounts || (exit.grossRaw ? amounts(exit.grossRaw) : null)
    const terminalFees =
      exit.terminalFeeAmounts ||
      (exit.terminalFeeRaw ? amounts(exit.terminalFeeRaw) : null) ||
      (preflightSource(preflight)?.accruedFees ? humanAmounts(preflightSource(preflight).accruedFees) : null)
    const principal = exit.principalAmounts || (gross && terminalFees ? subtractAmounts(gross, terminalFees) : null)
    const amountQuality =
      exit.amountQuality ||
      (principal && gross && terminalFees
        ? 'derived_gross_wallet_delta_minus_preflight_fee_growth'
        : gross
          ? 'partial_gross_includes_unallocated_fees'
          : 'unknown')
    exits.set(String(tokenId), {
      ...exit,
      blockNumber,
      mark: exit.mark || pairMarkFromPreflight(preflight) || markAt(blockNumber),
      grossAmounts: gross,
      terminalFeeAmounts: terminalFees,
      principalAmounts: principal,
      amountQuality,
    })
  }
  if (migration?.source)
    addExit(migration.source.tokenId, {
      at: migration.completedAt,
      blockNumber: txs.get(migration.source.removalTransaction.toLowerCase())?.blockNumber,
      transactionHash: migration.source.removalTransaction,
      grossRaw: migration.source.walletReceived,
      terminalFeeRaw: migration.source.accruedFeesAtPreflight,
      source: 'local_execution_record',
      quality: 'confirmed_receipt_and_liquidity_zero',
    })
  if (mainRoll?.source)
    addExit(mainRoll.source.tokenId, {
      at: mainRoll.completedAt,
      blockNumber: txs.get(mainRoll.source.removalTransaction.toLowerCase())?.blockNumber,
      transactionHash: mainRoll.source.removalTransaction,
      grossRaw: {
        spyWei: mainRoll.source.withdrawnSpyWei,
        pairWei: mainRoll.source.withdrawnPairWei,
      },
      terminalFeeRaw: mainRoll.source.accruedFeesAtPreflight,
      source: 'local_execution_record',
      quality: 'confirmed_receipt_and_liquidity_zero',
    })
  if (singleRollState?.status === 'complete' && singleRollState.result?.sourceTokenId) {
    addExit(singleRollState.result.sourceTokenId, {
      at: singleRollState.completedAt,
      blockNumber: singleRollState.steps?.withdraw_source?.blockNumber,
      transactionHash: singleRollState.steps?.withdraw_source?.hash,
      grossRaw: singleRollState.result.withdrawn,
      terminalFeeRaw: { spyWei: '0', pairWei: '0' },
      source: 'local_execution_record',
      quality: 'confirmed_receipt_and_liquidity_zero',
      note: 'Fees were collected in the preceding batch transaction before this principal-only withdrawal.',
      mark: singleRollMark,
    })
  }
  for (const target of pairState.satellites || []) {
    if (!target.sourcePosition?.removalTransaction) continue
    addExit(target.sourcePosition.tokenId, {
      at: target.completedAt,
      blockNumber: txs.get(target.sourcePosition.removalTransaction.toLowerCase())?.blockNumber,
      transactionHash: target.sourcePosition.removalTransaction,
      grossRaw: {
        spyWei: target.sourcePosition.withdrawnSpyWei,
        pairWei: target.sourcePosition.withdrawnPairWei,
      },
      source: 'local_execution_record',
      quality: 'confirmed_receipt_and_liquidity_zero',
    })
  }
  for (const target of pairState.satellites || []) {
    for (const sourcePosition of target.sources || []) {
      if (!sourcePosition.removalTransaction) continue
      const context = txs.get(sourcePosition.removalTransaction.toLowerCase())
      addExit(sourcePosition.tokenId, {
        at: target.completedAt,
        blockNumber: context?.blockNumber,
        transactionHash: sourcePosition.removalTransaction,
        grossRaw: {
          spyWei: sourcePosition.removedSpyWei,
          pairWei: sourcePosition.removedPairWei,
        },
        terminalFeeRaw: { spyWei: '0', pairWei: '0' },
        source: 'local_execution_record',
        quality: 'confirmed_receipt_and_liquidity_zero',
      })
    }
  }
  for (const retirement of pairState.retirements || []) {
    if (!retirement.removalTransaction) continue
    addExit(retirement.tokenId, {
      at: retirement.completedAt,
      blockNumber: retirement.blockNumber,
      transactionHash: retirement.removalTransaction,
      grossRaw: retirement.grossAmounts,
      terminalFeeRaw: retirement.accruedFeesAtPreflight,
      mark: retirement.priceSnapshotAtPreflight
        ? {
            spyUsdg: Number(retirement.priceSnapshotAtPreflight.spyUsdg),
            pairUsdg: Number(retirement.priceSnapshotAtPreflight.pairUsdg),
            quality: retirement.priceSnapshotAtPreflight.quality || 'operation_preflight',
          }
        : null,
      source: 'local_execution_record',
      quality: 'confirmed_receipt_and_liquidity_zero',
    })
  }
  if (directState.externalExit?.transaction)
    addExit(directState.position.tokenId, {
      at: directState.externalExit.executedAt,
      blockNumber: directState.externalExit.blockNumber,
      transactionHash: directState.externalExit.transaction,
      grossRaw: {
        usdgAtomic: directState.externalExit.receivedUsdgAtomic,
        pairWei: directState.externalExit.receivedPairWei,
      },
      terminalFeeRaw: {
        usdgAtomic: directState.externalExit.terminalFeeUsdgAtomic,
        pairWei: directState.externalExit.terminalFeePairWei,
      },
      source: directState.externalExit.source || 'external_wallet_operation',
      quality: 'decoded_calldata_receipt_and_liquidity_zero',
      note: directState.externalExit.note,
    })
  for (const manual of overrides.manualExits || []) addExit(manual.tokenId, manual)
  for (const [tokenId, exit] of exits) {
    if (positions.has(tokenId)) positions.get(tokenId).exit = exit
  }

  for (const position of positions.values()) {
    position.supplyEvents.sort((left, right) => Number(left.blockNumber || 0) - Number(right.blockNumber || 0))
    for (const event of position.supplyEvents) {
      if (event.mark) continue
      let eventNames = []
      let tokenId = position.tokenId
      if (String(event.id || '').startsWith('increase-')) eventNames = ['increase_preflight']
      else if (String(event.id || '').startsWith('satellite-')) {
        eventNames = ['satellite_preflight']
        tokenId = null
      } else if (String(event.id || '').startsWith('migration-')) {
        eventNames = ['migration_preflight']
        tokenId = null
      }
      if (!eventNames.length) continue
      event.mark = pairMarkFromPreflight(
        latestPreflight(pairRecords, {
          tokenId,
          beforeBlock: event.blockNumber,
          eventNames,
        }),
      )
    }
    const source = pairState.satellites?.find((item) => String(item.tokenId) === position.tokenId)
    if (source?.priceSnapshot) {
      position.entryRange = {
        low: Number(source.priceSnapshot.actualPairPriceLowUsdg),
        high: Number(source.priceSnapshot.actualPairPriceHighUsdg),
        quality: 'operation_snapshot',
      }
    } else if (position.tokenId === String(directState.position.tokenId)) {
      position.entryRange = {
        low: Number(directState.target.executablePriceLowUsdg),
        high: Number(directState.target.executablePriceHighUsdg),
        quality: 'operation_snapshot',
      }
    }
  }

  const feeClaims = []
  function addClaim({
    id,
    sourceTokenIds,
    targetTokenIds = [],
    at,
    blockNumber,
    transactionHash,
    raw,
    amountValues,
    mark,
    source,
    allocationQuality,
    disposition,
  }) {
    feeClaims.push({
      id,
      sourceTokenIds: sourceTokenIds.map(String),
      targetTokenIds: targetTokenIds.map(String),
      at: at || txs.get(transactionHash?.toLowerCase())?.at || null,
      blockNumber: String(blockNumber || txs.get(transactionHash?.toLowerCase())?.blockNumber || ''),
      transactionHash: transactionHash || null,
      amounts: amountValues || amounts(raw),
      mark: mark || markAt(blockNumber || txs.get(transactionHash?.toLowerCase())?.blockNumber),
      source,
      allocationQuality,
      disposition,
    })
  }

  for (const increase of pairState.increases || []) {
    const hash = increase.transactions?.at(-1)
    addClaim({
      id: `${increase.id}-implicit-fees`,
      sourceTokenIds: ['1548977'],
      targetTokenIds: ['1548977'],
      at: increase.completedAt,
      transactionHash: hash,
      raw: increase.accruedFeesBeforeIncrease,
      source: 'local_fee_growth_record',
      allocationQuality: 'preflight_fee_growth_then_compounded',
      disposition: 'reinvested_same_nft',
    })
  }
  if (satellite164?.collectedFees)
    addClaim({
      id: `${satellite164.id}-claim`,
      sourceTokenIds: ['1548977'],
      targetTokenIds: ['1643016'],
      at: satellite164.completedAt,
      transactionHash: satellite164.transactions?.[0],
      raw: satellite164.collectedFees,
      source: 'local_wallet_delta_record',
      allocationQuality: 'single_position_exact',
      disposition: 'reinvested_new_nft',
    })
  if (migration?.source?.accruedFeesAtPreflight)
    addClaim({
      id: `${migration.id}-source-fees`,
      sourceTokenIds: [migration.source.tokenId],
      targetTokenIds: [migration.target.tokenId],
      at: migration.completedAt,
      transactionHash: migration.source.removalTransaction,
      raw: migration.source.accruedFeesAtPreflight,
      source: 'local_fee_growth_record',
      allocationQuality: 'preflight_fee_growth_then_removed',
      disposition: 'reinvested_migration',
    })
  if (migration?.target?.accruedFeesCompounded)
    addClaim({
      id: `${migration.id}-target-fees`,
      sourceTokenIds: [migration.target.tokenId],
      targetTokenIds: [migration.target.tokenId],
      at: migration.completedAt,
      transactionHash: migration.target.increaseTransaction,
      raw: migration.target.accruedFeesCompounded,
      source: 'local_fee_growth_record',
      allocationQuality: 'preflight_fee_growth_then_compounded',
      disposition: 'reinvested_same_nft',
    })
  const feeBand = pairState.satellites?.find((item) => String(item.tokenId) === '1726507')
  for (const item of feeBand?.collectedFees?.positions || [])
    addClaim({
      id: `${feeBand.id}-claim-${item.tokenId}`,
      sourceTokenIds: [item.tokenId],
      targetTokenIds: [feeBand.tokenId],
      at: feeBand.completedAt,
      transactionHash: item.transaction,
      raw: item,
      mark: {
        spyUsdg: Number(feeBand.priceSnapshot?.spyPriceUsdg),
        pairUsdg: Number(feeBand.priceSnapshot?.currentPairPriceUsdg),
        quality: 'operation_snapshot',
      },
      source: 'local_wallet_delta_record',
      allocationQuality: 'single_position_exact',
      disposition: 'reinvested_new_nft',
    })
  for (const item of compound?.collectedFees?.positions || [])
    addClaim({
      id: `${compound.id}-claim-${item.tokenId}`,
      sourceTokenIds: [item.tokenId],
      targetTokenIds: [compound.targetTokenId],
      at: compound.completedAt,
      transactionHash: item.transaction,
      raw: item,
      mark: {
        spyUsdg: Number(compound.priceSnapshot?.spyPriceUsdg),
        pairUsdg: Number(compound.priceSnapshot?.currentPairPriceUsdg),
        quality: 'operation_snapshot',
      },
      source: 'local_wallet_delta_record',
      allocationQuality: 'single_position_exact',
      disposition: 'reinvested_existing_nft',
    })
  if (mainRoll?.source?.accruedFeesAtPreflight)
    addClaim({
      id: `${mainRoll.id}-source-fees`,
      sourceTokenIds: [mainRoll.source.tokenId],
      targetTokenIds: [mainRoll.target.tokenId],
      at: mainRoll.completedAt,
      transactionHash: mainRoll.source.removalTransaction,
      raw: mainRoll.source.accruedFeesAtPreflight,
      mark: {
        spyUsdg: Number(mainRoll.priceSnapshot?.spyPriceUsdg),
        pairUsdg: Number(mainRoll.priceSnapshot?.currentPairPriceUsdg),
        quality: 'operation_snapshot',
      },
      source: 'local_fee_growth_record',
      allocationQuality: 'preflight_fee_growth_then_removed',
      disposition: 'reinvested_migration',
    })
  for (const claim of overrides.manualFeeClaims || []) feeClaims.push(claim)

  const batch = directState.result?.collectedFees
  const batchSources = directState.sourcePositions || []
  if (batch && batchSources.length) {
    const totalEstimatedSpy = batchSources.reduce((sum, item) => sum + BigInt(item.estimatedFeeSpyWei || 0), 0n)
    const totalEstimatedPair = batchSources.reduce((sum, item) => sum + BigInt(item.estimatedFeePairWei || 0), 0n)
    const exactSpy = BigInt(batch.spyWei || 0)
    const exactPair = BigInt(batch.pairWei || 0)
    let assignedSpy = 0n
    let assignedPair = 0n
    batchSources.forEach((item, index) => {
      const final = index === batchSources.length - 1
      const spy = final
        ? exactSpy - assignedSpy
        : totalEstimatedSpy > 0n
          ? (exactSpy * BigInt(item.estimatedFeeSpyWei)) / totalEstimatedSpy
          : 0n
      const pair = final
        ? exactPair - assignedPair
        : totalEstimatedPair > 0n
          ? (exactPair * BigInt(item.estimatedFeePairWei)) / totalEstimatedPair
          : 0n
      assignedSpy += spy
      assignedPair += pair
      addClaim({
        id: `${directState.operationId}-batch-${item.tokenId}`,
        sourceTokenIds: [item.tokenId],
        targetTokenIds: [directState.position.tokenId],
        at: directState.completedAt,
        transactionHash: directState.steps.collect_batch.hash,
        blockNumber: directState.steps.collect_batch.blockNumber,
        raw: { spyWei: spy.toString(), pairWei: pair.toString() },
        source: 'exact_batch_wallet_delta_allocated_by_preflight_fee_growth',
        allocationQuality: 'pro_rata_from_exact_batch_total',
        disposition: 'reinvested_pair_usdg',
      })
    })
  }

  function proportionalAllocation(total, entries, weightKey) {
    const weighted = entries.filter((entry) => BigInt(entry[weightKey] || 0) > 0n)
    const totalWeight = weighted.reduce((sum, entry) => sum + BigInt(entry[weightKey]), 0n)
    const result = new Map(entries.map((entry) => [String(entry.tokenId), 0n]))
    if (BigInt(total || 0) === 0n || totalWeight === 0n) return result
    let assigned = 0n
    weighted.forEach((entry, index) => {
      const amount =
        index === weighted.length - 1
          ? BigInt(total) - assigned
          : (BigInt(total) * BigInt(entry[weightKey])) / totalWeight
      assigned += amount
      result.set(String(entry.tokenId), amount)
    })
    return result
  }

  if (
    singleRollState?.status === 'complete' &&
    singleRollState.result?.collected &&
    singleRollState.steps?.collect_all_fees?.hash
  ) {
    const sources = singleRollState.pairPositions || []
    const collected = singleRollState.result.collected
    const spyByToken = proportionalAllocation(collected.spyWei, sources, 'estimatedFeeSpyWei')
    const pairByToken = proportionalAllocation(collected.pairWei, sources, 'estimatedFeePairWei')
    const targetTokenId = String(singleRollState.result.targetTokenId)
    for (const sourcePosition of sources) {
      const tokenId = String(sourcePosition.tokenId)
      const spyWei = spyByToken.get(tokenId) || 0n
      const pairWei = pairByToken.get(tokenId) || 0n
      if (spyWei === 0n && pairWei === 0n) continue
      addClaim({
        id: `${singleRollState.operationId}-claim-${tokenId}`,
        sourceTokenIds: [tokenId],
        targetTokenIds: [targetTokenId],
        at: singleRollState.completedAt,
        transactionHash: singleRollState.steps.collect_all_fees.hash,
        blockNumber: singleRollState.steps.collect_all_fees.blockNumber,
        raw: { spyWei: spyWei.toString(), pairWei: pairWei.toString(), usdgAtomic: '0' },
        mark: singleRollMark,
        source: 'exact_batch_wallet_delta_allocated_by_preflight_fee_growth',
        allocationQuality: 'pro_rata_from_exact_batch_total',
        disposition: 'converted_and_reinvested_new_nft',
      })
    }
  }

  for (const increase of positionIncreaseStates || []) {
    if (increase.status !== 'complete' || !increase.result?.targetTokenId || !increase.result?.accruedFeesAtBuild)
      continue
    addClaim({
      id: `${increase.operationId}-implicit-fees`,
      sourceTokenIds: [increase.result.targetTokenId],
      targetTokenIds: [increase.result.targetTokenId],
      at: increase.completedAt,
      transactionHash: increase.result.transactionHash || increase.steps?.increase_target?.hash,
      blockNumber: increase.result.blockNumber || increase.steps?.increase_target?.blockNumber,
      raw: increase.result.accruedFeesAtBuild,
      mark: markForPositionIncrease(increase),
      source: 'local_fee_growth_record',
      allocationQuality: 'preflight_fee_growth_then_compounded',
      disposition: 'reinvested_same_nft',
    })
  }

  for (const sweep of feesToPairStates || []) {
    if (sweep.status !== 'complete' || !sweep.result?.collected || !sweep.steps?.collect_all_fees?.hash) continue
    const sources = [...(sweep.pairPositions || []), sweep.directPosition].filter(Boolean)
    const collected = sweep.result.collected
    const spyByToken = proportionalAllocation(collected.spyWei, sources, 'estimatedFeeSpyWei')
    const pairByToken = proportionalAllocation(collected.pairWei, sources, 'estimatedFeePairWei')
    const usdgByToken = proportionalAllocation(collected.usdgAtomic, sources, 'estimatedFeeUsdgAtomic')
    for (const sourcePosition of sources) {
      const tokenId = String(sourcePosition.tokenId)
      const spyWei = spyByToken.get(tokenId) || 0n
      const pairWei = pairByToken.get(tokenId) || 0n
      const usdgAtomic = usdgByToken.get(tokenId) || 0n
      if (spyWei === 0n && pairWei === 0n && usdgAtomic === 0n) continue
      addClaim({
        id: `${sweep.operationId}-claim-${tokenId}`,
        sourceTokenIds: [tokenId],
        at: sweep.completedAt,
        transactionHash: sweep.steps.collect_all_fees.hash,
        blockNumber: sweep.steps.collect_all_fees.blockNumber,
        raw: { spyWei: spyWei.toString(), pairWei: pairWei.toString(), usdgAtomic: usdgAtomic.toString() },
        source: 'exact_batch_wallet_delta_allocated_by_preflight_fee_growth',
        allocationQuality: 'pro_rata_from_exact_batch_total',
        disposition: sweep.operationType === 'fees_collect' ? 'held_in_wallet' : 'converted_to_wallet_pair',
      })
    }
  }

  feeClaims.sort((left, right) => Number(left.blockNumber || 0) - Number(right.blockNumber || 0))
  return { positions, feeClaims }
}

function signed24(value) {
  const masked = value & 0xffffffn
  return Number((masked & 0x800000n) !== 0n ? masked - 0x1000000n : masked)
}

async function retry(label, operation, attempts = 8) {
  let lastError
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (index === attempts - 1) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(12_000, 500 * 2 ** index)))
    }
  }
  throw new Error(`${label}: ${lastError?.shortMessage || lastError?.message || lastError}`)
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      output[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return output
}

async function scanTransfers(client, positionManager, wallet, fromBlock, toBlock) {
  const incoming = []
  const outgoing = []
  const configuredChunk = process.env.PAIR_PORTFOLIO_LOG_CHUNK || '500000'
  if (!/^\d+$/.test(configuredChunk) || BigInt(configuredChunk) <= 0n) {
    throw new Error(`PAIR_PORTFOLIO_LOG_CHUNK 必须是正整数，收到 ${configuredChunk}`)
  }
  const chunk = BigInt(configuredChunk)
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n
    process.stdout.write(`[portfolio] scan PositionManager Transfer ${start}-${end}\n`)
    const [received, sent] = await Promise.all([
      retry('incoming NFT transfers', () =>
        client.getLogs({
          address: positionManager,
          event: TRANSFER_EVENT,
          args: { to: wallet },
          fromBlock: start,
          toBlock: end,
        }),
      ),
      retry('outgoing NFT transfers', () =>
        client.getLogs({
          address: positionManager,
          event: TRANSFER_EVENT,
          args: { from: wallet },
          fromBlock: start,
          toBlock: end,
        }),
      ),
    ])
    incoming.push(...received)
    outgoing.push(...sent)
  }
  return { incoming, outgoing }
}

function poolRegistry(config, oneState) {
  return [
    {
      poolKind: 'pair-spy',
      poolId: config.pool.poolId,
      label: 'PAIR / SPY',
      currency0: config.tokens.spy.address,
      currency1: config.tokens.pair.address,
      feePips: config.pool.fee,
      tickSpacing: config.pool.tickSpacing,
      hooks: config.pool.hooks,
    },
    ...(config.comparison?.pools || [])
      .filter((pool) => pool.id === 'pair-usdg-1')
      .map((pool) => ({
        poolKind: 'pair-usdg',
        poolId: pool.poolId,
        label: 'PAIR / USDG',
        currency0: config.tokens.usdg.address,
        currency1: config.tokens.pair.address,
        feePips: pool.feePips,
        tickSpacing: pool.tickSpacing,
        hooks: pool.hooks,
      })),
    {
      poolKind: 'one-usdg',
      poolId: oneState.pool.poolId,
      label: '$1 / USDG',
      currency0: oneState.pool.currency0,
      currency1: oneState.pool.currency1,
      feePips: oneState.pool.fee,
      tickSpacing: oneState.pool.tickSpacing,
      hooks: oneState.pool.hooks,
    },
  ]
}

async function chainAudit({ config, oneState, positions, transactions, rpcUrl, receiptRpcUrl = rpcUrl }) {
  const chain = defineChain({
    id: config.chain.id,
    name: config.chain.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 30_000, retryCount: 3 }) })
  const receiptClient =
    receiptRpcUrl === rpcUrl
      ? client
      : createPublicClient({ chain, transport: http(receiptRpcUrl, { timeout: 30_000, retryCount: 3 }) })
  const wallet = getAddress(config.wallet)
  const positionManager = getAddress(config.contracts.positionManager)
  const head = await retry('chain head', () => client.getBlock())
  const confirmations = BigInt(config.chain.confirmations || 128)
  const safeNumber = head.number > confirmations ? head.number - confirmations : head.number
  const safeBlock = await retry('safe block', () => client.getBlock({ blockNumber: safeNumber }))
  const localMintBlocks = [...positions.values()].map((position) => BigInt(position.mint?.blockNumber || safeNumber))
  const firstMint = localMintBlocks.reduce((minimum, value) => (value < minimum ? value : minimum), safeNumber)
  const scanFrom = firstMint > 100_000n ? firstMint - 100_000n : 0n
  const transfers = await scanTransfers(client, positionManager, wallet, scanFrom, safeNumber)
  const allLogs = [...transfers.incoming, ...transfers.outgoing].sort(
    (left, right) => Number(left.blockNumber - right.blockNumber) || Number(left.logIndex - right.logIndex),
  )
  const tokenIds = [...new Set(allLogs.map((log) => log.args.tokenId.toString()))]
  const registry = poolRegistry(config, oneState)
  // Robinhood public RPC regularly rate-limits bursty historical reads. Keep
  // this audit deliberately low-concurrency so a complete manifest is more
  // valuable than a fast, partially verified one.
  const states = await mapLimit(tokenIds, 2, async (tokenId) => {
    const [owner, liquidity, poolAndInfo] = await Promise.all([
      retry(`ownerOf ${tokenId}`, () =>
        client.readContract({
          address: positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: 'ownerOf',
          args: [BigInt(tokenId)],
          blockNumber: safeNumber,
        }),
      ),
      retry(`liquidity ${tokenId}`, () =>
        client.readContract({
          address: positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(tokenId)],
          blockNumber: safeNumber,
        }),
      ),
      retry(`pool info ${tokenId}`, () =>
        client.readContract({
          address: positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: 'getPoolAndPositionInfo',
          args: [BigInt(tokenId)],
          blockNumber: safeNumber,
        }),
      ),
    ])
    const [poolKey, info] = poolAndInfo
    const prefix = (info >> 56n).toString(16).padStart(50, '0').toLowerCase()
    const pool = registry.find((item) => item.poolId.slice(2).toLowerCase().startsWith(prefix))
    const related = allLogs.filter((log) => log.args.tokenId.toString() === tokenId)
    const mintLog =
      related.find((log) => log.args.from.toLowerCase() === ZERO_ADDRESS) ||
      transfers.incoming.find((log) => log.args.tokenId.toString() === tokenId)
    const mintBlock = mintLog
      ? await retry(`mint block ${tokenId}`, () => client.getBlock({ blockNumber: mintLog.blockNumber }))
      : null
    return {
      tokenId,
      owner,
      liquidity: liquidity.toString(),
      status: owner.toLowerCase() === wallet.toLowerCase() ? (liquidity > 0n ? 'active' : 'empty') : 'owner_mismatch',
      tickLower: signed24(info >> 8n),
      tickUpper: signed24(info >> 32n),
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
      mint: mintLog
        ? {
            blockNumber: mintLog.blockNumber.toString(),
            transactionHash: mintLog.transactionHash,
            at: new Date(Number(mintBlock.timestamp) * 1_000).toISOString(),
            source: 'PositionManager Transfer mint',
          }
        : null,
      dataQuality: 'verified_same_safe_block',
    }
  })
  process.stdout.write(`[portfolio] audit ${transactions.length} transaction receipts\n`)
  // The public Robinhood RPC intermittently rate-limits parallel historical
  // receipt reads. Keep this audit sequential so a transient throttle cannot
  // prevent an otherwise canonical ledger rebuild.
  const auditedTransactions = await mapLimit(transactions, 1, async (transaction) => {
    const [chainTransaction, receipt] = await Promise.all([
      retry(`transaction ${transaction.hash}`, () => receiptClient.getTransaction({ hash: transaction.hash })),
      retry(`receipt ${transaction.hash}`, () => receiptClient.getTransactionReceipt({ hash: transaction.hash })),
    ])
    const gasCostWei = receipt.gasUsed * receipt.effectiveGasPrice
    const valueEth = decimal(chainTransaction.value)
    return {
      ...transaction,
      at: transaction.at,
      blockNumber: receipt.blockNumber.toString(),
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      gasCostWei: gasCostWei.toString(),
      valueEth,
      from: chainTransaction.from,
      to: chainTransaction.to,
      nonce: Number(chainTransaction.nonce),
      capitalFlow: valueEth > 0 && ['fund_swap', 'swap'].includes(transaction.action) ? 'lp_directed' : null,
      evidence: 'canonical_transaction_and_receipt_readback',
      evidenceRank: 5,
      reconciliation: {
        localStatus: transaction.status,
        localBlockNumber: transaction.blockNumber,
        localGasCostWei: transaction.gasCostWei,
        matches:
          transaction.status === receipt.status &&
          String(transaction.blockNumber) === receipt.blockNumber.toString() &&
          (!transaction.gasCostWei ||
            transaction.gasCostWei === '0' ||
            transaction.gasCostWei === gasCostWei.toString()),
      },
    }
  })
  return {
    states,
    transactions: auditedTransactions,
    audit: {
      safeBlock: safeNumber.toString(),
      safeBlockHash: safeBlock.hash,
      safeBlockTime: new Date(Number(safeBlock.timestamp) * 1_000).toISOString(),
      scanFromBlock: scanFrom.toString(),
      incomingTransfers: transfers.incoming.length,
      outgoingTransfers: transfers.outgoing.length,
      uniqueNfts: tokenIds.length,
      source: 'PositionManager Transfer logs plus ownerOf/getPositionLiquidity/getPoolAndPositionInfo',
    },
  }
}

function enrichWithAudit(localModel, chain, config, oneState, overrides) {
  const positions = localModel.positions
  const originalLocalIds = new Set(positions.keys())
  for (const state of chain.states) {
    const local = positions.get(state.tokenId) || {
      tokenId: state.tokenId,
      label: overrides.positionMetadata?.[state.tokenId]?.label || `未归档 NFT ${state.tokenId}`,
      role: overrides.positionMetadata?.[state.tokenId]?.role || 'unclassified',
      supplyEvents: [],
      localState: { status: null, source: null },
    }
    positions.set(state.tokenId, {
      ...local,
      poolKind: state.poolKind,
      poolId: state.poolId,
      poolLabel: state.poolLabel,
      poolKey: state.poolKey,
      tickLower: state.tickLower,
      tickUpper: state.tickUpper,
      mint: state.mint || local.mint,
      lastKnownStatus: state.status,
      lastKnownLiquidity: state.liquidity,
      owner: state.owner,
      chainDataQuality: state.dataQuality,
    })
  }
  const localIds = [...positions.keys()].sort((a, b) => Number(a) - Number(b))
  const chainIds = chain.states.map((state) => state.tokenId).sort((a, b) => Number(a) - Number(b))
  const missingOnChain = localIds.filter((tokenId) => !chainIds.includes(tokenId))
  const missingLocally = chainIds.filter((tokenId) => !originalLocalIds.has(tokenId))
  const registry = poolRegistry(config, oneState)
  return {
    positions: [...positions.values()].sort((left, right) => Number(left.tokenId) - Number(right.tokenId)),
    pools: registry,
    audit: {
      ...chain.audit,
      inventoryStatus:
        missingOnChain.length || missingLocally.length ? 'partial_mismatch' : 'verified_complete_at_safe_block',
      localIds,
      chainIds,
      missingOnChain,
      missingLocally,
    },
  }
}

async function main() {
  const offline = process.argv.includes('--offline')
  const config = readJson(CONFIG_PATH)
  const overrides = readJson(OVERRIDES_PATH)
  const pairState = readJson(path.join(ROOT, 'runs', 'pair-lp-live-one.json'))
  const directState = readJson(path.join(ROOT, 'runs', 'pair-usdg-narrow-live-one.json'))
  const oneState = readJson(path.join(ROOT, 'runs', 'one-usdg-live-one.json'))
  const feesToPairStates = readFeesToPairStates()
  const singleRollState = readOptionalJson(path.join(ROOT, 'runs', 'pair-single-sided-roll-live.json'))
  const positionIncreaseStates = readPositionIncreaseStates()
  const pairJsonlPath = path.join(ROOT, 'runs', 'pair-lp-live-one.jsonl')
  const pairRecords = readJsonl(pairJsonlPath)
  const jsonlPaths = [
    pairJsonlPath,
    path.join(ROOT, 'runs', 'pair-usdg-narrow-live-one.jsonl'),
    path.join(ROOT, 'runs', 'one-usdg-live-one.jsonl'),
    path.join(ROOT, 'runs', 'pair-fees-to-pair-live.jsonl'),
    path.join(ROOT, 'runs', 'pair-fees-collect-live.jsonl'),
    path.join(ROOT, 'runs', 'pair-single-sided-roll-live.jsonl'),
    path.join(ROOT, 'runs', 'pair-position-pair-increase-live.jsonl'),
  ]
  const transactions = buildTransactions(jsonlPaths, overrides)
  const markAt = makeMarkReader(HISTORY_DB)
  const localModel = buildLocalModel({
    pairState,
    directState,
    oneState,
    feesToPairStates,
    singleRollState,
    positionIncreaseStates,
    overrides,
    transactions,
    markAt,
    pairRecords,
  })
  markAt.close?.()

  let inventory
  if (offline) {
    inventory = {
      positions: [...localModel.positions.values()].sort((left, right) => Number(left.tokenId) - Number(right.tokenId)),
      pools: poolRegistry(config, oneState),
      audit: {
        inventoryStatus: 'local_only_not_chain_audited',
        safeBlock: null,
        localIds: [...localModel.positions.keys()].sort((a, b) => Number(a) - Number(b)),
        chainIds: [],
      },
    }
  } else {
    const rpcUrl = process.env.RH_RPC_URL || config.chain.defaultRpcUrl
    const receiptRpcUrl = process.env.RH_RECEIPT_RPC_URL || rpcUrl
    const chain = await chainAudit({
      config,
      oneState,
      positions: localModel.positions,
      transactions,
      rpcUrl,
      receiptRpcUrl,
    })
    inventory = enrichWithAudit(localModel, chain, config, oneState, overrides)
    transactions.splice(0, transactions.length, ...chain.transactions)
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    wallet: config.wallet,
    chainId: config.chain.id,
    explorerTxBaseUrl: 'https://robinhoodchain.blockscout.com/tx/',
    audit: inventory.audit,
    pools: inventory.pools,
    positions: inventory.positions,
    lineages: overrides.lineages || [],
    feeClaims: localModel.feeClaims,
    transactions,
    coverage: {
      nftInventory: inventory.audit.inventoryStatus,
      receipts: 'all local executor receipts plus canonical manual-operation receipts listed in overrides',
      claimedFees:
        'partial: recorded executor feeGrowth/wallet deltas and audited manual claims; exit-bundled fees without allocation remain unknown',
      capital:
        'partial: LP-directed native-value swaps are recorded; all external wallet top-ups and pre-existing token lots are not fully attributable',
    },
    caveats: [
      'A migrated or fee-funded child NFT reuses capital from its parent; per-NFT entry values must not be summed as fresh cash investment.',
      'Claimed-fee totals are cumulative production, not idle wallet value; reinvested fees already appear inside current principal.',
      'Event marks use the nearest preceding canonical pool swap when available. Current-replacement value is not historical cost.',
      '$1/USDG is included in the wallet NFT inventory even though its current on-chain liquidity is zero.',
      'Aggregate cash invested remains PARTIAL until all native-ETH top-ups and pre-existing token lots are reconciled.',
    ],
  }
  const temporary = `${OUTPUT_PATH}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  fs.renameSync(temporary, OUTPUT_PATH)
  process.stdout.write(`[portfolio] wrote ${OUTPUT_PATH}\n`)
  process.stdout.write(
    `[portfolio] ${manifest.positions.length} NFTs, ${manifest.transactions.length} receipts, ${manifest.feeClaims.length} fee records, inventory=${manifest.audit.inventoryStatus}\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`[portfolio] ${error.stack || error.message || error}\n`)
  process.exitCode = 1
})
