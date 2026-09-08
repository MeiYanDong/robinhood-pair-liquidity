import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  encodePacked,
  formatUnits,
  getAddress,
  http,
  keccak256,
  padHex,
  parseAbi,
  parseAbiItem,
  toHex,
} from 'viem'
import {
  dedupeFeeClaims,
  deriveImplicitIncreaseFees,
  deriveLpInventoryConversion,
  hasFeeClaim,
  isDirectExternalTokenTransfer,
  reconcilePurchaseBatch,
  sumAmounts,
  toCsv,
  valueAmounts,
} from '../lib/fund-accounting.mjs'
import { positionTokenAmounts } from '../dashboard/lib/collector.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CONFIG_PATH = path.join(ROOT, 'dashboard', 'config', 'pair-spy.json')
const PORTFOLIO_MANIFEST_PATH = path.join(ROOT, 'dashboard', 'config', 'lp-portfolio-ledger.json')
const ASSERTIONS_PATH = path.join(ROOT, 'config', 'pair-fund-accounting-assertions.json')
const OUTPUT_DIR = path.join(ROOT, 'reports', 'accounting')
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'pair-fund-audit-latest.json')
const OUTPUT_MARKDOWN = path.join(OUTPUT_DIR, 'pair-fund-audit-latest.md')
const OUTPUT_CAPITAL_CSV = path.join(OUTPUT_DIR, 'external-capital.csv')
const OUTPUT_ACQUISITIONS_CSV = path.join(OUTPUT_DIR, 'pair-acquisitions.csv')
const OUTPUT_FEES_CSV = path.join(OUTPUT_DIR, 'fee-claims.csv')
const OUTPUT_INCREASE_FEES_CSV = path.join(OUTPUT_DIR, 'positive-increase-fee-reconciliation.csv')
const OUTPUT_CONVERSIONS_CSV = path.join(OUTPUT_DIR, 'lp-inventory-conversions.csv')
const OUTPUT_EXCEPTIONS_CSV = path.join(OUTPUT_DIR, 'exceptions.csv')
const BLOCKSCOUT_BASE = process.env.RH_BLOCKSCOUT_API_URL || 'https://robinhoodchain.blockscout.com/api/v2'
const BLOCKSCOUT_SITE = 'https://robinhoodchain.blockscout.com'
const COINGECKO_ETH_RANGE = 'https://api.coingecko.com/api/v3/coins/ethereum/market_chart/range'
const DUST_NATIVE_THRESHOLD_WEI = 100_000_000_000_000n

const MODIFY_LIQUIDITY_EVENT = parseAbiItem(
  'event ModifyLiquidity(bytes32 indexed id,address indexed sender,int24 tickLower,int24 tickUpper,int256 liquidityDelta,bytes32 salt)',
)
const ERC20_TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')
const V4_SWAP_EVENT = parseAbiItem(
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
)
const V3_SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
)
const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getPositionInfo(bytes32 poolId,bytes32 positionId) view returns (uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128)',
  'function getFeeGrowthInside(bytes32 poolId,int24 tickLower,int24 tickUpper) view returns (uint256 feeGrowthInside0X128,uint256 feeGrowthInside1X128)',
])
const POSITION_MANAGER_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
])
const V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
])
const ERC20_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)'])
const Q128 = 1n << 128n
const UINT256_MODULUS = 1n << 256n
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function json(value) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), 2)
}

function lower(value) {
  return String(value || '').toLowerCase()
}

function numeric(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function retry(label, operation, attempts = 5) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        const throttled = /429|too many requests/iu.test(String(error?.message || error))
        await sleep((throttled ? 1_500 : 300) * attempt)
      }
    }
  }
  throw new Error(`${label}: ${lastError?.message || lastError}`)
}

async function fetchJson(url, label = url) {
  return retry(label, async () => {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 PAIR-fund-audit/1.0',
        referer: `${BLOCKSCOUT_SITE}/`,
      },
      signal: AbortSignal.timeout(45_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  })
}

async function fetchBlockscoutPages(relativePath) {
  const base = new URL(`${BLOCKSCOUT_BASE}${relativePath}`)
  let url = base.toString()
  const items = []
  const seen = new Set()
  while (url) {
    if (seen.has(url)) throw new Error(`Blockscout pagination loop at ${url}`)
    seen.add(url)
    const page = await fetchJson(url, `Blockscout ${relativePath}`)
    items.push(...(page.items || []))
    const next = page.next_page_params
    if (!next) {
      url = null
      continue
    }
    const nextUrl = new URL(base)
    for (const [key, value] of Object.entries(next)) nextUrl.searchParams.set(key, String(value))
    url = nextUrl.toString()
  }
  return items
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

function human(raw, decimals) {
  return Number(formatUnits(BigInt(raw || 0), decimals))
}

function amountShape() {
  return { eth: 0, spy: 0, pair: 0, usdg: 0, one: 0 }
}

function pricesForValue(mark = {}) {
  return {
    eth: mark.ethUsdg ?? null,
    spy: mark.spyUsdg ?? null,
    pair: mark.pairUsdg ?? null,
    usdg: 1,
    one: mark.oneUsdg ?? null,
  }
}

function pairPriceAtTick(spyUsdg, tick) {
  return spyUsdg / Math.pow(1.0001, tick)
}

function directPriceAtTick(tick) {
  return Math.pow(10, 12) / Math.pow(1.0001, tick)
}

function v3SpyUsdgAtSqrt(sqrtPriceX96) {
  return Math.pow(Number(sqrtPriceX96) / 2 ** 96, 2) * Math.pow(10, 12)
}

function positionStateId(positionManager, tokenId, tickLower, tickUpper) {
  const salt = padHex(toHex(BigInt(tokenId)), { size: 32 })
  return keccak256(
    encodePacked(['address', 'int24', 'int24', 'bytes32'], [positionManager, tickLower, tickUpper, salt]),
  )
}

function wrappingSub(left, right) {
  return (left - right + UINT256_MODULUS) % UINT256_MODULUS
}

function poolAssetLayout(poolKind) {
  if (poolKind === 'pair-spy') return { asset0: 'spy', decimals0: 18, asset1: 'pair', decimals1: 18 }
  if (poolKind === 'pair-usdg') return { asset0: 'usdg', decimals0: 6, asset1: 'pair', decimals1: 18 }
  if (poolKind === 'one-usdg') return { asset0: 'usdg', decimals0: 6, asset1: 'one', decimals1: 18 }
  throw new Error(`不支持的池类型：${poolKind}`)
}

function rangeAtCurrentMarks(position, spyUsdg) {
  const at =
    position.poolKind === 'pair-spy' ? (tick) => pairPriceAtTick(spyUsdg, tick) : (tick) => directPriceAtTick(tick)
  const left = at(position.tickLower)
  const right = at(position.tickUpper)
  return { low: Math.min(left, right), high: Math.max(left, right), quality: 'same_safe_block_tick_math' }
}

async function buildSafeBlockPortfolio({ client, config, manifest, cutoff, cutoffTime, ethUsdg, closingBalanceWei }) {
  const blockNumber = BigInt(cutoff)
  const wallet = getAddress(config.wallet)
  const stateView = getAddress(config.contracts.stateView)
  const positionManager = getAddress(config.contracts.positionManager)

  const poolStateEntries = await mapLimit(configuredPools, 2, async (pool) => {
    const slot0 = await retry(`pool slot0 ${pool.poolKind}`, () =>
      client.readContract({
        address: stateView,
        abi: STATE_VIEW_ABI,
        functionName: 'getSlot0',
        args: [pool.poolId],
        blockNumber,
      }),
    )
    return [pool.poolKind, { pool, slot0 }]
  })
  const poolStateByKind = new Map(poolStateEntries)
  const spySlot0 = await retry('SPY/USDG slot0', () =>
    client.readContract({
      address: getAddress(config.contracts.spyUsdgV3Pool),
      abi: V3_POOL_ABI,
      functionName: 'slot0',
      blockNumber,
    }),
  )
  const spyUsdg = v3SpyUsdgAtSqrt(spySlot0[0])
  const pairSpyState = poolStateByKind.get('pair-spy')
  const pairUsdgState = poolStateByKind.get('pair-usdg')
  const oneUsdgState = poolStateByKind.get('one-usdg')
  const poolMarks = {
    'pair-spy': {
      spyUsdg,
      pairUsdg: pairPriceAtTick(spyUsdg, Number(pairSpyState.slot0[1])),
    },
    'pair-usdg': {
      usdg: 1,
      pairUsdg: directPriceAtTick(Number(pairUsdgState.slot0[1])),
    },
    'one-usdg': {
      usdg: 1,
      oneUsdg: directPriceAtTick(Number(oneUsdgState.slot0[1])),
    },
  }
  const prices = {
    ethUsdg,
    spyUsdg,
    pairUsdg: poolMarks['pair-spy'].pairUsdg,
    pairUsdgDirect: poolMarks['pair-usdg'].pairUsdg,
    oneUsdg: poolMarks['one-usdg'].oneUsdg,
  }

  const tokenBalanceEntries = await mapLimit(Object.entries(tokenMetaByAsset), 2, async ([asset, metadata]) => {
    const atomic = await retry(`wallet ${asset} balance`, () =>
      client.readContract({
        address: getAddress(metadata.address),
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [wallet],
        blockNumber,
      }),
    )
    return [asset, { atomic: atomic.toString(), amount: human(atomic, metadata.decimals) }]
  })
  const walletBalances = {
    ...amountShape(),
    eth: human(closingBalanceWei, 18),
    ...Object.fromEntries(tokenBalanceEntries.map(([asset, balance]) => [asset, balance.amount])),
  }
  const walletBalancesAtomic = Object.fromEntries(
    tokenBalanceEntries.map(([asset, balance]) => [asset, balance.atomic]),
  )

  const positions = await mapLimit(manifest.positions, 2, async (position) => {
    const tokenId = BigInt(position.tokenId)
    const poolState = poolStateByKind.get(position.poolKind)
    if (!poolState) throw new Error(`NFT #${position.tokenId} 缺少池配置 ${position.poolKind}`)
    const [owner, managerLiquidity] = await Promise.all([
      retry(`ownerOf ${position.tokenId}`, () =>
        client.readContract({
          address: positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: 'ownerOf',
          args: [tokenId],
          blockNumber,
        }),
      ),
      retry(`liquidity ${position.tokenId}`, () =>
        client.readContract({
          address: positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: 'getPositionLiquidity',
          args: [tokenId],
          blockNumber,
        }),
      ),
    ])
    const owned = lower(owner) === walletAddress
    const active = owned && managerLiquidity > 0n
    const currentTick = Number(poolState.slot0[1])
    const layout = poolAssetLayout(position.poolKind)
    const rawPrincipal = active
      ? positionTokenAmounts(managerLiquidity, poolState.slot0[0], position.tickLower, position.tickUpper)
      : { amount0: 0n, amount1: 0n }
    const principal = {
      ...amountShape(),
      [layout.asset0]: human(rawPrincipal.amount0, layout.decimals0),
      [layout.asset1]: human(rawPrincipal.amount1, layout.decimals1),
    }

    let stateViewLiquidity = 0n
    let rawFee0 = 0n
    let rawFee1 = 0n
    if (active) {
      const id = positionStateId(positionManager, position.tokenId, position.tickLower, position.tickUpper)
      const [[liquidity, last0, last1], [inside0, inside1]] = await Promise.all([
        retry(`position fee state ${position.tokenId}`, () =>
          client.readContract({
            address: stateView,
            abi: STATE_VIEW_ABI,
            functionName: 'getPositionInfo',
            args: [position.poolId, id],
            blockNumber,
          }),
        ),
        retry(`inside fee growth ${position.tokenId}`, () =>
          client.readContract({
            address: stateView,
            abi: STATE_VIEW_ABI,
            functionName: 'getFeeGrowthInside',
            args: [position.poolId, position.tickLower, position.tickUpper],
            blockNumber,
          }),
        ),
      ])
      stateViewLiquidity = liquidity
      rawFee0 = (liquidity * wrappingSub(inside0, last0)) / Q128
      rawFee1 = (liquidity * wrappingSub(inside1, last1)) / Q128
    }
    const unclaimedFees = {
      ...amountShape(),
      [layout.asset0]: human(rawFee0, layout.decimals0),
      [layout.asset1]: human(rawFee1, layout.decimals1),
    }
    const positionPrices =
      position.poolKind === 'pair-usdg'
        ? { pair: poolMarks['pair-usdg'].pairUsdg, usdg: 1 }
        : position.poolKind === 'one-usdg'
          ? { one: poolMarks['one-usdg'].oneUsdg, usdg: 1 }
          : { pair: poolMarks['pair-spy'].pairUsdg, spy: spyUsdg }
    const currentPrincipalUsdg = valueAmounts(principal, positionPrices).valueUsdg
    const status = active ? 'active' : owned ? 'empty' : 'owner_mismatch'
    const exitInventory = position.exit?.principalAmounts || null
    const inventory = active ? principal : exitInventory
    const inventoryQuality = active
      ? managerLiquidity === stateViewLiquidity
        ? 'VERIFIED'
        : 'PARTIAL'
      : exitInventory
        ? String(position.exit?.amountQuality || 'DERIVED').toUpperCase()
        : 'UNKNOWN'
    const endpointMark = active ? poolMarks[position.poolKind] : position.exit?.mark || {}
    const supplied = (position.supplyEvents || []).reduce(
      (total, event) => sumAmounts(total, event.amounts || {}),
      amountShape(),
    )
    return {
      ...position,
      status,
      owner,
      liquidity: managerLiquidity.toString(),
      stateViewLiquidity: stateViewLiquidity.toString(),
      inRange: active && currentTick >= position.tickLower && currentTick < position.tickUpper,
      currentRange: rangeAtCurrentMarks(position, spyUsdg),
      supplied,
      principal,
      unclaimedFees,
      accounting: { currentPrincipalUsdg },
      priceLedger: {
        inventory: { amounts: inventory, quality: inventoryQuality },
        endpoint: {
          spyUsdg: endpointMark.spyUsdg ?? null,
          pairUsdg: endpointMark.pairUsdg ?? null,
          oneUsdg: endpointMark.oneUsdg ?? null,
        },
      },
      dataQuality:
        owned && (!active || managerLiquidity === stateViewLiquidity)
          ? 'verified_same_safe_block'
          : owned
            ? 'liquidity_mismatch'
            : 'owner_mismatch',
    }
  })

  const activePositions = positions.filter((position) => position.status === 'active')
  return {
    runtime: {
      status: 'LIVE',
      ready: true,
      source: 'verified local NFT ledger + canonical safe-block RPC reads',
      blockNumber: String(cutoff),
      blockTime: cutoffTime,
    },
    portfolio: {
      asOfBlock: String(cutoff),
      asOfTime: cutoffTime,
      prices,
      positions,
      feeClaims: manifest.feeClaims || [],
      transactions: manifest.transactions || [],
      totals: {
        walletBalances,
        walletBalancesAtomic,
        activePrincipal: activePositions.reduce(
          (total, position) => sumAmounts(total, position.principal),
          amountShape(),
        ),
        unclaimedFees: activePositions.reduce(
          (total, position) => sumAmounts(total, position.unclaimedFees),
          amountShape(),
        ),
      },
    },
  }
}

function amountsFromRaw(raw) {
  const result = amountShape()
  for (const [asset, atomic] of Object.entries(raw || {})) {
    const meta = tokenMetaByAsset[asset]
    if (!meta) continue
    result[asset] = human(atomic, meta.decimals)
  }
  return result
}

let tokenMetaByAsset = {}
let tokenMetaByAddress = new Map()

function configureTokens(config) {
  tokenMetaByAsset = {
    spy: config.tokens.spy,
    pair: config.tokens.pair,
    usdg: config.tokens.usdg,
    one: config.tokens.one,
  }
  tokenMetaByAddress = new Map(
    Object.entries(tokenMetaByAsset).map(([asset, metadata]) => [lower(metadata.address), { asset, ...metadata }]),
  )
}

function normalizeTransactions(items, wallet, cutoff) {
  return items
    .filter((item) => Number(item.block_number || 0) <= cutoff)
    .map((item) => ({
      hash: lower(item.hash),
      blockNumber: Number(item.block_number || 0),
      timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : null,
      from: lower(item.from?.hash),
      fromIsContract: Boolean(item.from?.is_contract),
      to: lower(item.to?.hash),
      toIsContract: Boolean(item.to?.is_contract || item.created_contract),
      status: item.status,
      success: item.status === 'ok' || item.result === 'success',
      valueWei: BigInt(item.value || 0),
      feeWei: BigInt(item.fee?.value || item.transaction_burnt_fee || 0),
      method: item.method || null,
      nonce: item.nonce,
      direction: lower(item.from?.hash) === wallet ? 'out' : lower(item.to?.hash) === wallet ? 'in' : 'related',
      explorer: `${BLOCKSCOUT_SITE}/tx/${item.hash}`,
    }))
    .sort((left, right) => left.blockNumber - right.blockNumber || numeric(left.nonce) - numeric(right.nonce))
}

function normalizeTokenTransfers(items, wallet, cutoff) {
  return items
    .filter((item) => Number(item.block_number || 0) <= cutoff)
    .flatMap((item) => {
      const metadata = tokenMetaByAddress.get(lower(item.token?.address_hash))
      if (!metadata) return []
      const from = lower(item.from?.hash)
      const to = lower(item.to?.hash)
      if (from !== wallet && to !== wallet) return []
      return [
        {
          transactionHash: lower(item.transaction_hash),
          blockNumber: Number(item.block_number || 0),
          timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : null,
          logIndex: Number(item.log_index || 0),
          asset: metadata.asset,
          decimals: metadata.decimals,
          atomic: BigInt(item.total?.value || 0),
          amount: human(item.total?.value || 0, metadata.decimals),
          from,
          fromIsContract: Boolean(item.from?.is_contract),
          to,
          toIsContract: Boolean(item.to?.is_contract),
          direction: to === wallet ? 'in' : 'out',
          counterparty: to === wallet ? from : to,
          counterpartyIsContract: to === wallet ? Boolean(item.from?.is_contract) : Boolean(item.to?.is_contract),
        },
      ]
    })
    .sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex)
}

function transferNetByTransaction(transfers) {
  const result = new Map()
  for (const transfer of transfers) {
    const current = result.get(transfer.transactionHash) || amountShape()
    current[transfer.asset] += transfer.direction === 'in' ? transfer.amount : -transfer.amount
    result.set(transfer.transactionHash, current)
  }
  return result
}

function tokenTransferKey(transfer) {
  return `${transfer.transactionHash}:${transfer.logIndex}:${transfer.asset}:${transfer.direction}`
}

function summarizeTokenConservation(transfers, closingBalancesAtomic, externalTransferKeys) {
  const result = {}
  for (const [asset, metadata] of Object.entries(tokenMetaByAsset)) {
    const rows = transfers.filter((transfer) => transfer.asset === asset)
    const buckets = {
      externalIn: 0n,
      externalOut: 0n,
      contractIn: 0n,
      contractOut: 0n,
    }
    for (const transfer of rows) {
      const external = externalTransferKeys.has(tokenTransferKey(transfer))
      const bucket =
        transfer.direction === 'in'
          ? external
            ? 'externalIn'
            : 'contractIn'
          : external
            ? 'externalOut'
            : 'contractOut'
      buckets[bucket] += transfer.atomic
    }
    const netAtomic = buckets.externalIn + buckets.contractIn - buckets.externalOut - buckets.contractOut
    const closingAtomic = BigInt(closingBalancesAtomic?.[asset] || 0)
    const residualAtomic = closingAtomic - netAtomic
    const net = human(netAtomic, metadata.decimals)
    const closing = human(closingAtomic, metadata.decimals)
    result[asset] = {
      externalIn: human(buckets.externalIn, metadata.decimals),
      externalOut: human(buckets.externalOut, metadata.decimals),
      contractIn: human(buckets.contractIn, metadata.decimals),
      contractOut: human(buckets.contractOut, metadata.decimals),
      netClosingBalance: net,
      chainClosingBalance: closing,
      chainDifference: closing - net,
      exactAtomicResidual: residualAtomic.toString(),
      quality: residualAtomic === 0n ? 'VERIFIED' : 'MISMATCH',
    }
  }
  return result
}

async function classifyExternalTokenTransfers(transfers, transactionByHash, cutoff, wallet) {
  const candidates = transfers.filter((transfer) => !transfer.counterpartyIsContract)
  const missingHashes = [
    ...new Set(candidates.map((transfer) => transfer.transactionHash).filter((hash) => !transactionByHash.has(hash))),
  ]
  const missingTransactions = await mapLimit(missingHashes, 3, async (hash) => {
    const payload = await fetchJson(`${BLOCKSCOUT_BASE}/transactions/${hash}`, `Blockscout transaction ${hash}`)
    return normalizeTransactions([payload], wallet, cutoff)[0] || null
  })
  for (const transaction of missingTransactions.filter(Boolean)) {
    transactionByHash.set(transaction.hash, transaction)
  }
  return candidates.filter((transfer) => {
    const transaction = transactionByHash.get(transfer.transactionHash)
    const token = tokenMetaByAsset[transfer.asset]
    return isDirectExternalTokenTransfer(transaction, token?.address || '')
  })
}

function summarizeNative(transactions, wallet, closingBalanceWei) {
  const outgoing = transactions.filter((transaction) => transaction.from === wallet)
  const incoming = transactions.filter((transaction) => transaction.to === wallet && transaction.success)
  const gasWei = outgoing.reduce((total, transaction) => total + transaction.feeWei, 0n)
  const contractSpendWei = outgoing
    .filter((transaction) => transaction.success && (transaction.toIsContract || !transaction.to))
    .reduce((total, transaction) => total + transaction.valueWei, 0n)
  const eoaOutWei = outgoing
    .filter((transaction) => transaction.success && transaction.to && !transaction.toIsContract)
    .reduce((total, transaction) => total + transaction.valueWei, 0n)
  const incomingWei = incoming.reduce((total, transaction) => total + transaction.valueWei, 0n)
  const residualWei = incomingWei - contractSpendWei - eoaOutWei - gasWei - closingBalanceWei
  return {
    incomingWei,
    contractSpendWei,
    eoaOutWei,
    gasWei,
    closingBalanceWei,
    residualWei,
    incomingEth: human(incomingWei, 18),
    contractSpendEth: human(contractSpendWei, 18),
    eoaOutEth: human(eoaOutWei, 18),
    gasEth: human(gasWei, 18),
    closingBalanceEth: human(closingBalanceWei, 18),
    residualEth: human(residualWei, 18),
    quality: residualWei === 0n ? 'VERIFIED' : 'MISMATCH',
  }
}

function parsePositionReceipt(receipt, wallet, poolById) {
  const operations = []
  let current = null
  for (const log of [...receipt.logs].sort((left, right) => Number(left.logIndex - right.logIndex))) {
    try {
      const decoded = decodeEventLog({ abi: [MODIFY_LIQUIDITY_EVENT], data: log.data, topics: log.topics })
      current = {
        transactionHash: lower(receipt.transactionHash),
        blockNumber: Number(receipt.blockNumber),
        logIndex: Number(log.logIndex),
        tokenId: BigInt(decoded.args.salt).toString(),
        poolId: lower(decoded.args.id),
        poolKind: poolById.get(lower(decoded.args.id)) || 'unknown',
        tickLower: Number(decoded.args.tickLower),
        tickUpper: Number(decoded.args.tickUpper),
        liquidityDelta: BigInt(decoded.args.liquidityDelta),
        rawWalletFlow: {},
      }
      operations.push(current)
      continue
    } catch {
      // The receipt also contains unrelated PositionManager and pool logs.
    }
    if (!current) continue
    const metadata = tokenMetaByAddress.get(lower(log.address))
    if (!metadata) continue
    try {
      const decoded = decodeEventLog({ abi: [ERC20_TRANSFER_EVENT], data: log.data, topics: log.topics })
      const from = lower(decoded.args.from)
      const to = lower(decoded.args.to)
      if (from !== wallet && to !== wallet) continue
      const signed = to === wallet ? BigInt(decoded.args.value) : -BigInt(decoded.args.value)
      current.rawWalletFlow[metadata.asset] = BigInt(current.rawWalletFlow[metadata.asset] || 0) + signed
    } catch {
      // Not every token-address log in the receipt is an ERC-20 transfer.
    }
  }
  return operations.map((operation) => ({
    ...operation,
    amounts: amountsFromRaw(operation.rawWalletFlow),
  }))
}

async function fetchReceipts(client, transactions, positionManager) {
  const targets = transactions.filter(
    (transaction) => transaction.from === walletAddress && transaction.to === positionManager && transaction.success,
  )
  return mapLimit(targets, 4, async (transaction) =>
    retry(`receipt ${transaction.hash}`, () => client.getTransactionReceipt({ hash: transaction.hash })),
  )
}

async function fetchEthSeries(fromTime, toTime) {
  const from = Math.floor(new Date(fromTime).getTime() / 1000) - 3_600
  const to = Math.ceil(new Date(toTime).getTime() / 1000) + 3_600
  const url = `${COINGECKO_ETH_RANGE}?vs_currency=usd&from=${from}&to=${to}`
  try {
    const payload = await fetchJson(url, 'CoinGecko ETH history')
    return (payload.prices || []).map(([timestamp, price]) => ({ timestamp, price: Number(price) }))
  } catch (error) {
    console.warn(`ETH 历史价格不可用: ${error.message}`)
    return []
  }
}

function nearestSeriesPrice(series, timestamp) {
  if (!series.length || !timestamp) return null
  const target = new Date(timestamp).getTime()
  return series.reduce((best, point) =>
    Math.abs(point.timestamp - target) < Math.abs(best.timestamp - target) ? point : best,
  ).price
}

function priorAuditMarkSeeds(audit) {
  const seeds = new Map()
  function add(poolKind, blockNumber, mark) {
    if (!poolKind || !Number(blockNumber) || !mark) return
    const key = `${poolKind}:${Number(blockNumber)}`
    seeds.set(key, { ...(seeds.get(key) || {}), ...mark })
  }
  for (const claim of audit?.fees?.claims || []) add(claim.poolKind, claim.blockNumber, claim.mark)
  for (const acquisition of audit?.capital?.pairAcquisitions || []) {
    if (acquisition.mark) add('pair-spy', acquisition.blockNumber, acquisition.mark)
  }
  for (const event of audit?.capital?.boundaryEvents || []) {
    const asset = String(event.asset || '').toLowerCase()
    const poolKind = asset === 'one' ? 'one-usdg' : 'pair-spy'
    const field = asset === 'one' ? 'oneUsdg' : asset === 'pair' ? 'pairUsdg' : asset === 'spy' ? 'spyUsdg' : null
    if (!field) continue
    add(poolKind, event.blockNumber, {
      [field]: event.eventPriceUsdg,
      quality: 'reused_prior_audit_canonical_history_mark',
    })
  }
  return seeds
}

function makeMarketMarker(client, config, seedMarks = new Map()) {
  const poolManager = getAddress(config.contracts.poolManager)
  const spyPool = getAddress(config.contracts.spyUsdgV3Pool)
  const poolByKind = new Map(configuredPools.map((pool) => [pool.poolKind, pool]))
  const cache = new Map([...seedMarks].map(([key, mark]) => [key, Promise.resolve(mark)]))
  let lastHistoricalRequestAt = 0

  async function throttleHistoricalRequest() {
    const minimumInterval = Math.max(350, Number(config.chain.rpcMinimumIntervalMs || 250))
    const wait = Math.max(0, minimumInterval - (Date.now() - lastHistoricalRequestAt))
    if (wait) await sleep(wait)
    lastHistoricalRequestAt = Date.now()
  }

  async function lastLog({ address, event, args, blockNumber }) {
    const toBlock = BigInt(blockNumber)
    for (let offset = 0n; offset < 80_000n; offset += 8_000n) {
      const high = toBlock > offset ? toBlock - offset : 0n
      const low = high > 7_999n ? high - 7_999n : 0n
      const logs = await retry(
        'historical price logs',
        async () => {
          await throttleHistoricalRequest()
          return client.getLogs({
            address,
            event,
            args,
            fromBlock: low,
            toBlock: high,
          })
        },
        8,
      )
      if (logs.length) return logs.at(-1)
      if (low === 0n) break
      await sleep(120)
    }
    return null
  }

  return async function markAtBlock(blockNumber, poolKind = 'pair-spy') {
    const key = `${poolKind}:${blockNumber}`
    if (cache.has(key)) return cache.get(key)
    const promise = (async () => {
      if (poolKind === 'one-usdg') {
        const pool = poolByKind.get(poolKind)
        const event = await lastLog({
          address: poolManager,
          event: V4_SWAP_EVENT,
          args: { id: pool.poolId },
          blockNumber,
        })
        return event
          ? {
              oneUsdg: directPriceAtTick(Number(event.args.tick)),
              quality: 'nearest_prior_canonical_swap',
            }
          : { oneUsdg: null, quality: 'UNKNOWN' }
      }
      const spyEvent = await lastLog({ address: spyPool, event: V3_SWAP_EVENT, args: {}, blockNumber })
      const spyUsdg = spyEvent ? v3SpyUsdgAtSqrt(spyEvent.args.sqrtPriceX96) : null
      if (poolKind === 'pair-usdg') {
        const pool = poolByKind.get(poolKind)
        const pairEvent = await lastLog({
          address: poolManager,
          event: V4_SWAP_EVENT,
          args: { id: pool.poolId },
          blockNumber,
        })
        return {
          spyUsdg,
          pairUsdg: pairEvent ? directPriceAtTick(Number(pairEvent.args.tick)) : null,
          quality: pairEvent ? 'nearest_prior_canonical_swap' : 'UNKNOWN',
        }
      }
      const pool = poolByKind.get('pair-spy')
      const pairEvent = await lastLog({
        address: poolManager,
        event: V4_SWAP_EVENT,
        args: { id: pool.poolId },
        blockNumber,
      })
      return {
        spyUsdg,
        pairUsdg: pairEvent && spyUsdg ? pairPriceAtTick(spyUsdg, Number(pairEvent.args.tick)) : null,
        quality: pairEvent && spyUsdg ? 'nearest_prior_canonical_pool_swaps' : 'UNKNOWN',
      }
    })()
    cache.set(key, promise)
    return promise
  }
}

function claimPoolKind(claim, positionById) {
  const kinds = [
    ...new Set((claim.sourceTokenIds || []).map((id) => positionById.get(String(id))?.poolKind).filter(Boolean)),
  ]
  return kinds.length === 1 ? kinds[0] : 'unknown'
}

function terminalFeeClaimsFromPositions(positions, existingClaims) {
  return positions.flatMap((position) => {
    const exit = position.exit
    const amounts = exit?.terminalFeeAmounts || null
    if (!exit?.transactionHash || !amounts) return []
    if (!Object.values(amounts).some((amount) => Number(amount) > 0)) return []
    if (hasFeeClaim(existingClaims, exit.transactionHash, position.tokenId)) return []
    return [
      {
        id: `chain-terminal-fee-${position.tokenId}-${exit.blockNumber}`,
        sourceTokenIds: [String(position.tokenId)],
        targetTokenIds: [],
        at: exit.at || null,
        blockNumber: String(exit.blockNumber || ''),
        transactionHash: lower(exit.transactionHash),
        amounts,
        poolKind: position.poolKind,
        mark: exit.mark || null,
        source: 'ledger_exit_principal_and_terminal_fee_separation',
        allocationQuality: exit.amountQuality || 'derived_exit_allocation',
        disposition: 'withdrawn_with_principal',
        evidenceRank: 4,
      },
    ]
  })
}

function implicitIncreaseFeeClaims({ positions, operations, transferNet, existingClaims }) {
  const operationsByTransaction = new Map()
  for (const operation of operations) {
    const hash = lower(operation.transactionHash)
    const current = operationsByTransaction.get(hash) || []
    current.push(operation)
    operationsByTransaction.set(hash, current)
  }

  const claims = []
  const reconciliations = []
  const allowedSupplyQualities = new Set([
    'underlying_after_increase',
    'actual_wallet_delta_plus_compounded_fee_growth',
    'decoded_calldata_receipt_and_tick_math',
    'derived_total_underlying_added',
  ])

  for (const position of positions) {
    for (const supply of position.supplyEvents || []) {
      if (supply.kind !== 'increase' || !supply.transactionHash) continue
      const transactionHash = lower(supply.transactionHash)
      const transactionOperations = operationsByTransaction.get(transactionHash) || []
      const positiveOperations = transactionOperations.filter((operation) => operation.liquidityDelta > 0n)
      const negativeOperations = transactionOperations.filter((operation) => operation.liquidityDelta < 0n)
      const matchingOperation = positiveOperations.find(
        (operation) => String(operation.tokenId) === String(position.tokenId),
      )
      const exactTransactionShape =
        positiveOperations.length === 1 && negativeOperations.length === 0 && Boolean(matchingOperation)
      const supportedSupply = allowedSupplyQualities.has(String(supply.quality || ''))
      const flow = transferNet.get(transactionHash) || amountShape()
      const layout = poolAssetLayout(position.poolKind)
      const assets = [layout.asset0, layout.asset1]
      const { walletSpend, implicitFees } = deriveImplicitIncreaseFees({
        totalUnderlying: supply.amounts || {},
        walletFlow: flow,
        assets,
      })
      const matchingClaims = existingClaims.filter(
        (claim) =>
          lower(claim.transactionHash) === transactionHash &&
          (claim.sourceTokenIds || []).map(String).includes(String(position.tokenId)),
      )
      const recordedAmounts = matchingClaims.reduce(
        (total, claim) => sumAmounts(total, claim.amounts || {}),
        amountShape(),
      )
      const hasImplicitFees = assets.some((asset) => implicitFees[asset] > 0)
      let status = 'UNRESOLVED'
      if (matchingClaims.length) status = 'RECORDED'
      else if (exactTransactionShape && supportedSupply && hasImplicitFees) status = 'DERIVED_AND_ADDED'
      else if (exactTransactionShape && supportedSupply) status = 'VERIFIED_NO_IMPLICIT_FEE'

      if (status === 'DERIVED_AND_ADDED') {
        claims.push({
          id: `chain-increase-fee-credit-${position.tokenId}-${supply.blockNumber}`,
          sourceTokenIds: [String(position.tokenId)],
          targetTokenIds: [String(position.tokenId)],
          at: supply.at || null,
          blockNumber: String(supply.blockNumber || ''),
          transactionHash,
          amounts: implicitFees,
          poolKind: position.poolKind,
          mark: supply.mark || null,
          source: 'increase_total_underlying_minus_exact_wallet_net_flow',
          allocationQuality: 'derived_single_positive_modify_liquidity_transaction',
          disposition: 'reinvested_same_nft',
          evidenceRank: 4,
        })
      }

      reconciliations.push({
        tokenId: String(position.tokenId),
        poolKind: position.poolKind,
        blockNumber: String(supply.blockNumber || ''),
        transactionHash,
        supplyQuality: supply.quality || null,
        positiveOperations: positiveOperations.length,
        negativeOperations: negativeOperations.length,
        totalUnderlying: supply.amounts || amountShape(),
        walletSpend,
        implicitFees,
        recordedAmounts,
        status,
        quality:
          status === 'RECORDED'
            ? 'EXISTING_FEE_RECORD'
            : status === 'DERIVED_AND_ADDED'
              ? 'DERIVED_FROM_CHAIN_WALLET_FLOW_AND_LIQUIDITY_UNDERLYING'
              : status === 'VERIFIED_NO_IMPLICIT_FEE'
                ? 'VERIFIED_NO_POSITIVE_DIFFERENCE'
                : 'PARTIAL',
      })
    }
  }
  return { claims, reconciliations }
}

async function enrichFeeClaims(claims, markAtBlock, positionById) {
  return mapLimit(claims, 1, async (claim) => {
    const poolKind = claim.poolKind || claimPoolKind(claim, positionById)
    const mark =
      claim.mark?.quality && Object.values(claim.mark).some((value) => Number.isFinite(Number(value)))
        ? claim.mark
        : await markAtBlock(Number(claim.blockNumber), poolKind)
    const valuation = valueAmounts(claim.amounts || {}, pricesForValue(mark))
    return {
      ...claim,
      poolKind,
      mark,
      eventValueUsdg: valuation.unknownAssets.length ? null : valuation.valueUsdg,
      eventValueKnownAssetsUsdg: valuation.valueUsdg,
      eventValueUnknownAssets: valuation.unknownAssets,
      evidenceRank: claim.evidenceRank || (String(claim.source || '').startsWith('chain_') ? 5 : 3),
    }
  })
}

function summarizeFeeClaims(claims, currentPrices) {
  const amounts = claims.reduce((total, claim) => sumAmounts(total, claim.amounts || {}), amountShape())
  const eventMarkedKnownUsdg = claims.reduce((total, claim) => total + Number(claim.eventValueKnownAssetsUsdg || 0), 0)
  const unknownEventValueRecords = claims.filter((claim) => claim.eventValueUsdg == null).length
  return {
    records: claims.length,
    amounts,
    eventMarkedKnownUsdg,
    unknownEventValueRecords,
    currentReplacementUsdg: valueAmounts(amounts, currentPrices).valueUsdg,
  }
}

function markdownTable(columns, rows) {
  const header = `| ${columns.map((column) => column.label).join(' | ')} |`
  const divider = `| ${columns.map(() => '---').join(' | ')} |`
  const body = rows.map(
    (row) => `| ${columns.map((column) => String(column.value(row) ?? '').replaceAll('|', '\\|')).join(' | ')} |`,
  )
  return [header, divider, ...body].join('\n')
}

function fixed(value, digits = 4) {
  if (value == null || !Number.isFinite(Number(value))) return 'UNKNOWN'
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

function signedFixed(value, digits = 4) {
  if (value == null || !Number.isFinite(Number(value))) return 'UNKNOWN'
  return `${Number(value) >= 0 ? '+' : ''}${fixed(value, digits)}`
}

function assetSummary(amounts) {
  return (
    [
      amounts.eth ? `${fixed(amounts.eth, 8)} ETH` : null,
      amounts.spy ? `${fixed(amounts.spy, 8)} SPY` : null,
      amounts.pair ? `${fixed(amounts.pair, 4)} PAIR` : null,
      amounts.usdg ? `${fixed(amounts.usdg, 6)} USDG` : null,
      amounts.one ? `${fixed(amounts.one, 4)} $1` : null,
    ]
      .filter(Boolean)
      .join(' + ') || '0'
  )
}

function buildMarkdown(audit) {
  const capitalRows = audit.capital.boundaryEvents
  const batchRows = audit.ownerPurchaseBatches
  const fee = audit.fees
  const positionRows = audit.positions
  const conversionRows = audit.lpInventoryConversions
  const acquisitionRows = audit.capital.pairAcquisitionSummary
  const backupPurchases = acquisitionRows.find((row) => row.classification === 'USER_ASSERTED_BACKUP_FUNDS')
  const unresolvedPurchases = acquisitionRows.find(
    (row) => row.classification === 'OWNER_OR_RECYCLED_PRINCIPAL_UNRESOLVED',
  )
  const acquisitionLabels = {
    USER_ASSERTED_BACKUP_FUNDS: '用户确认的后备资金',
    LP_FEE_FUNDED: '明确标注的手续费资金',
    OWNER_OR_RECYCLED_PRINCIPAL_UNRESOLVED: '自有/回收本金混合，未唯一归因',
  }
  const lines = [
    '# PAIR LP 全历史资金审计',
    '',
    `- 生成时间：${audit.generatedAt}`,
    `- 统一截止区块：${audit.asOfBlock}（${audit.asOfTime}）`,
    `- 钱包：\`${audit.wallet}\``,
    `- 运行时：${audit.runtime.status}；账本结论：${audit.quality.overall}`,
    '',
    '## 先看结论',
    '',
    `- 外部毛投入（钱包边界）：${fixed(audit.capital.grossExternalContributions.nativeEth, 9)} ETH + ${fixed(audit.capital.grossExternalContributions.pair, 4)} PAIR。交易时点市值约 **${fixed(audit.capital.grossExternalContributions.eventMarkUsdg, 2)} USDG**；这是市值口径，不是转入 PAIR 的原始法币成本。`,
    `- 外部转出/回款：${fixed(audit.capital.externalDistributions.nativeEth, 9)} ETH + ${fixed(audit.capital.externalDistributions.spy, 8)} SPY + ${fixed(audit.capital.externalDistributions.pair, 4)} PAIR。转出不等于亏损；它只是离开本审计钱包边界。`,
    `- 当前 PAIR 主策略资产（LP 本金 + 未领费 + 钱包 ETH/SPY/PAIR/USDG，不含 $1）：约 **${fixed(audit.currentAssets.mainStrategyUsdg, 2)} USDG**。`,
    `- 两笔用户确认的追高批次，链上合计成本 **${fixed(backupPurchases.costKnownUsdg, 2)} USDG**，买入 ${fixed(backupPurchases.pairBought, 4)} PAIR，链上加权均价 **${fixed(backupPurchases.averagePairUsdg, 6)}**。若假设这些 PAIR 从未进入 LP、从未转出，当前替代价值为 ${fixed(backupPurchases.currentReplacementUsdg, 2)} USDG、差额 ${signedFixed(backupPurchases.replacementDeltaUsdg, 2)} USDG；这只是静态 lot 对照，不是实际组合亏损。`,
    `- PAIR 主策略累计已领取手续费：${assetSummary(fee.mainStrategyClaimed.amounts)}，按各次领取时点计价约 **${fixed(fee.mainStrategyClaimed.eventMarkedKnownUsdg, 2)} USDG**；另有未领取 ${assetSummary(fee.unclaimed.amounts)}。$1/USDG 附录手续费单列为 ${assetSummary(fee.oneUsdgAppendixClaimed.amounts)}（时点价值 ${fixed(fee.oneUsdgAppendixClaimed.eventMarkedKnownUsdg, 2)} USDG）。`,
    `- 全钱包实际 gas：${fixed(audit.gas.totalEth, 9)} ETH；按交易时点 ETH 价格约 **${fixed(audit.gas.eventMarkUsdg, 2)} USDG**，按当前价格约 ${fixed(audit.gas.currentMarkUsdg, 2)} USDG。`,
    `- LP 被动换币（手续费剔除）：各 NFT 生命周期累计买入 ${fixed(audit.lpConversionSummary.pairBought, 4)} PAIR、累计卖出 ${fixed(audit.lpConversionSummary.pairSold, 4)} PAIR；${audit.lpConversionSummary.unknownPositions ? `${audit.lpConversionSummary.unknownPositions} 个 PAIR 仓位仍不完整` : '所有 PAIR 仓位均已有可计算端点'}。这是跨多次迁移的累计库存周转，不是当前持仓，也不是“净卖出”数量。`,
    `- 钱包边界“当前资产 + 历史转出 − 历史投入”的异时点市值桥为 ${signedFixed(audit.capital.walletBoundaryMarketValueBridge.currentAssetsPlusDistributionsMinusContributionsUsdg, 2)} USDG。它不是收益率：外部转入 PAIR 的原始买入成本未知，且每笔流入/流出使用各自交易时点市价。`,
    '',
    '> 重要：累计手续费是“收入归因”，其中相当一部分已复投或兑换；不能再与当前资产相加，否则会重复计算。',
    '',
    '## 1. 外部本金与回款',
    '',
    markdownTable(
      [
        { label: '时间', value: (row) => row.timestamp },
        { label: '方向', value: (row) => row.direction },
        { label: '资产', value: (row) => row.asset },
        { label: '数量', value: (row) => fixed(row.amount, 9) },
        { label: '时点市值 USDG', value: (row) => fixed(row.eventValueUsdg, 2) },
        { label: '证据', value: (row) => row.quality },
        { label: '交易', value: (row) => `[${row.blockNumber}](${row.explorer})` },
      ],
      capitalRows,
    ),
    '',
    '口径：外部地址 → 本钱包为投入；本钱包 → 外部地址为回款/转出。合约交互、LP 迁移、手续费复投均不重复计作外部投入。小于 0.0001 ETH 的一笔回流单列为 dust/refund，不计入毛投入。',
    '',
    '## 2. 后备资金追高批次对账',
    '',
    markdownTable(
      [
        { label: '批次', value: (row) => row.label },
        {
          label: '口述',
          value: (row) => `${fixed(row.assertedNotionalUsdg, 0)}U @ ${fixed(row.assertedAveragePairUsdg, 6)}`,
        },
        { label: '链上 SPY 支出', value: (row) => fixed(-row.reconciliation.flows.spy, 9) },
        { label: '链上 PAIR 买入', value: (row) => fixed(row.reconciliation.pairBought, 4) },
        { label: '链上成本 USDG', value: (row) => fixed(row.reconciliation.observedCostUsdg, 2) },
        { label: '链上均价', value: (row) => fixed(row.reconciliation.observedAveragePairUsdg, 6) },
        { label: '数量差', value: (row) => `${signedFixed(row.reconciliation.pairQuantityDifferencePct, 2)}%` },
        { label: '质量', value: (row) => row.quality },
      ],
      batchRows,
    ),
    '',
    '这里把“用户确认的资金来源”和“链上可验证的成交数量/均价”分开保存。口述 550U/600U 不会覆盖链上事实。',
    '',
    '## 3. 所有 SPY/USDG → PAIR 买入的来源分层',
    '',
    markdownTable(
      [
        { label: '来源', value: (row) => acquisitionLabels[row.classification] || row.classification },
        { label: '交易数', value: (row) => row.transactions },
        { label: 'SPY 支出', value: (row) => fixed(row.spySpent, 9) },
        { label: 'USDG 支出', value: (row) => fixed(row.usdgSpent, 6) },
        { label: 'PAIR 买入', value: (row) => fixed(row.pairBought, 4) },
        { label: '已知成本 USDG', value: (row) => fixed(row.costKnownUsdg, 2) },
        { label: '加权均价', value: (row) => fixed(row.averagePairUsdg, 6) },
        { label: '静态当前替代差额', value: (row) => signedFixed(row.replacementDeltaUsdg, 2) },
      ],
      acquisitionRows,
    ),
    '',
    `只有 \`USER_ASSERTED_BACKUP_FUNDS\` 是用户已确认的新增后备资金；\`LP_FEE_FUNDED\` 只包含标签与领取流水能明确闭环的下限；其余 ${unresolvedPurchases.transactions} 笔混有原始本金、撤仓回款、LP 卖出回来的 SPY 与手续费，保持 UNRESOLVED，不能擅自算成新增投入。逐笔明细见 \`pair-acquisitions.csv\`。`,
    '',
    '## 4. 手续费收入（与本金分开）',
    '',
    `- 原账本记录：${fee.recordedRecords} 条；审计补发现：${fee.addedChainRecords} 条（零流动性领取 ${fee.addedZeroDeltaRecords} 条、退池末次手续费 ${fee.addedExitTerminalRecords} 条、加仓隐含复投 ${fee.addedIncreaseFeeCreditRecords} 条）；去重后：${fee.claimed.records} 条。`,
    `- PAIR 主策略已领取：${assetSummary(fee.mainStrategyClaimed.amounts)}；时点价值 ${fixed(fee.mainStrategyClaimed.eventMarkedKnownUsdg, 2)} USDG。`,
    `- $1/USDG 附录已领取：${assetSummary(fee.oneUsdgAppendixClaimed.amounts)}；时点价值 ${fixed(fee.oneUsdgAppendixClaimed.eventMarkedKnownUsdg, 2)} USDG。`,
    `- 已领取手续费时点价值减去本钱包全部历史 gas：${fixed(fee.claimed.eventMarkedKnownAfterAllWalletGasUsdg, 2)} USDG。这是保守的费用净额桥，不是 LP 总利润；全部 gas 还包含建仓、调仓、兑换和失败交易。`,
    `- 已领取手续费的当前替代市值：${fixed(fee.claimed.currentReplacementUsdg, 2)} USDG。此数是假设仍持有领取时的原币种，不代表复投后的真实余额。`,
    `- 当前未领：${assetSummary(fee.unclaimed.amounts)}，现值 ${fixed(fee.unclaimed.currentMarkUsdg, 2)} USDG。`,
    `- 正向加仓：共 ${fee.positiveIncreaseReconciliation.operations} 次，已有记录 ${fee.positiveIncreaseReconciliation.recorded} 次，本次从“底层实际增加 − 钱包净支出”补出 ${fee.positiveIncreaseReconciliation.derivedAndAdded} 次，无隐含 fee credit ${fee.positiveIncreaseReconciliation.verifiedNoImplicitFee} 次，未闭环 ${fee.positiveIncreaseReconciliation.unresolved} 次。`,
    `- 退池拆分：${fee.exitAllocation.separatedPositions}/${fee.exitAllocation.exitedPositions} 个已撤空 NFT 已拆为本金与末次手续费；${fee.exitAllocation.unresolvedTokenIds.length ? `仍未闭环 NFT ${fee.exitAllocation.unresolvedTokenIds.join(', ')}` : '当前没有未拆分退池'}。`,
    `- 手续费代币数量完整性：**${fee.claimed.quality}**。这表示在当前钱包和已核验的 NFT 全集内已闭环，不等于税务成本或个人所有钱包层面的完整 PnL。`,
    '',
    '## 5. LP 被动换成 PAIR / SPY',
    '',
    markdownTable(
      [
        { label: 'NFT', value: (row) => row.tokenId },
        { label: '状态', value: (row) => row.status },
        { label: '方向', value: (row) => row.side },
        { label: 'PAIR 变化', value: (row) => signedFixed(row.pairDelta, 4) },
        { label: '报价币变化', value: (row) => signedFixed(row.quoteDelta, 8) },
        { label: '隐含 PAIR 均价', value: (row) => fixed(row.pairUsdg, 6) },
        { label: '质量', value: (row) => row.quality },
      ],
      conversionRows,
    ),
    '',
    '这张表只描述每个 NFT 生命周期内由 LP 曲线造成的库存变化，不把手续费当成低买高卖，也不把迁移到新 NFT 当作新增本金。多个相继仓位可能反复处理同一批资金，因此汇总是累计周转量，不是唯一代币数量。',
    '',
    '## 6. 所有 LP（含已撤仓）',
    '',
    markdownTable(
      [
        { label: 'NFT', value: (row) => row.tokenId },
        { label: '池', value: (row) => row.poolKind },
        { label: '角色', value: (row) => row.role },
        { label: '状态', value: (row) => row.status },
        { label: 'Tick 区间', value: (row) => `${row.tickLower} → ${row.tickUpper}` },
        {
          label: '当前价格区间',
          value: (row) =>
            row.currentRange ? `${fixed(row.currentRange.low, 8)} → ${fixed(row.currentRange.high, 8)}` : 'UNKNOWN',
        },
        { label: '当前本金 USDG', value: (row) => fixed(row.currentPrincipalUsdg, 2) },
        { label: '已识别手续费', value: (row) => assetSummary(row.knownClaimedFees) },
        { label: '数据质量', value: (row) => row.dataQuality },
      ],
      positionRows,
    ),
    '',
    '## 7. 守恒校验',
    '',
    `- ETH：流入 ${fixed(audit.reconciliation.native.incomingEth, 12)} − 合约支出 ${fixed(audit.reconciliation.native.contractSpendEth, 12)} − 外部转出 ${fixed(audit.reconciliation.native.eoaOutEth, 12)} − gas ${fixed(audit.reconciliation.native.gasEth, 12)} = 余额 ${fixed(audit.reconciliation.native.closingBalanceEth, 12)}；残差 ${audit.reconciliation.native.residualEth} ETH（${audit.reconciliation.native.quality}）。`,
    ...Object.entries(audit.reconciliation.tokens).map(
      ([asset, row]) =>
        `- ${asset.toUpperCase()}：外部流入 ${fixed(row.externalIn, 9)} + 合约流入 ${fixed(row.contractIn, 9)} − 外部流出 ${fixed(row.externalOut, 9)} − 合约流出 ${fixed(row.contractOut, 9)} = ${fixed(row.netClosingBalance, 9)}；与同区块链上余额差 ${row.chainDifference}，原子单位残差 ${row.exactAtomicResidual}（${row.quality}）。`,
    ),
    '',
    '## 8. 尚未闭环',
    '',
    ...audit.exceptions.map((item) => `- **${item.priority} / ${item.code}**：${item.impact}（${item.nextStep}）`),
    '',
    '## 口径与证据层级',
    '',
    '- `VERIFIED`：交易回执、事件、余额或严格守恒可直接核验。',
    '- `DERIVED`：由已验证数量与同时点链上价格计算。',
    '- `USER_ASSERTED`：用户确认资金属性，成交数量仍以链上为准。',
    '- `PARTIAL`：已知部分可计算，但至少有一类本金/手续费拆分缺口。',
    '- `UNKNOWN`：现有公开链上证据不足以唯一还原。',
    '',
    `链上来源：[Blockscout 地址页](${BLOCKSCOUT_SITE}/address/${audit.wallet})；ETH 历史价格：[CoinGecko API](https://www.coingecko.com/en/coins/ethereum)。`,
    '',
  ]
  return lines.join('\n')
}

const config = readJson(CONFIG_PATH)
const assertions = readJson(ASSERTIONS_PATH)
configureTokens(config)
const walletAddress = lower(config.wallet)
const portfolioManifest = readJson(PORTFOLIO_MANIFEST_PATH)
const configuredPools = portfolioManifest.pools

async function main() {
  const manifestCutoff = Number(portfolioManifest.audit.safeBlock)
  if (
    !Number.isSafeInteger(manifestCutoff) ||
    portfolioManifest.audit.inventoryStatus !== 'verified_complete_at_safe_block'
  ) {
    throw new Error('本地 NFT 账本没有通过统一安全区块完整性校验')
  }
  const chain = defineChain({
    id: config.chain.id,
    name: config.chain.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.chain.defaultRpcUrl] } },
  })
  const client = createPublicClient({
    chain,
    transport: http(process.env.RH_RPC_URL || config.chain.defaultRpcUrl, { timeout: 30_000, retryCount: 0 }),
  })

  const head = await retry('audit chain head', () => client.getBlock(), 8)
  const confirmations = BigInt(config.chain.confirmations || 128)
  const safeNumber = head.number > confirmations ? head.number - confirmations : head.number
  await sleep(config.chain.rpcMinimumIntervalMs || 250)
  const safeBlock = await retry('audit safe block', () => client.getBlock({ blockNumber: safeNumber }), 8)
  const cutoff = Number(safeNumber)
  const cutoffTime = new Date(Number(safeBlock.timestamp) * 1_000).toISOString()

  console.log(`先冻结统一截止区块 ${cutoff} 的余额、LP 本金与未领手续费…`)
  const closingBalanceWei = await retry('wallet ETH balance', () =>
    client.getBalance({
      address: getAddress(config.wallet),
      blockNumber: BigInt(cutoff),
    }),
  )
  const dashboardPayload = await buildSafeBlockPortfolio({
    client,
    config,
    manifest: portfolioManifest,
    cutoff,
    cutoffTime,
    ethUsdg: null,
    closingBalanceWei,
  })

  console.log('读取完整公开链上流水…')
  const transactionItems = await fetchBlockscoutPages(`/addresses/${config.wallet}/transactions`)
  const transferItems = await fetchBlockscoutPages(`/addresses/${config.wallet}/token-transfers?type=ERC-20`)
  const transactions = normalizeTransactions(transactionItems, walletAddress, cutoff)
  const ledgerDrift = transactions.filter(
    (transaction) =>
      transaction.success &&
      transaction.from === walletAddress &&
      transaction.to === lower(config.contracts.positionManager) &&
      transaction.blockNumber > manifestCutoff,
  )
  if (ledgerDrift.length) {
    throw new Error(
      `账本截止后发现 ${ledgerDrift.length} 笔 PositionManager 交易；请先重建 portfolio ledger：${ledgerDrift.map((transaction) => transaction.hash).join(', ')}`,
    )
  }
  const transfers = normalizeTokenTransfers(transferItems, walletAddress, cutoff)
  const transactionByHash = new Map(transactions.map((transaction) => [transaction.hash, transaction]))
  const transferNet = transferNetByTransaction(transfers)
  const externalTokenTransfers = await classifyExternalTokenTransfers(
    transfers,
    transactionByHash,
    cutoff,
    walletAddress,
  )
  const externalTransferKeys = new Set(externalTokenTransfers.map(tokenTransferKey))
  const times = transactions.map((transaction) => transaction.timestamp).filter(Boolean)
  const ethSeries = await fetchEthSeries(times[0], times.at(-1))
  const currentEthUsdg = nearestSeriesPrice(ethSeries, cutoffTime)
  const portfolio = dashboardPayload.portfolio
  portfolio.prices.ethUsdg = currentEthUsdg
  const labelByHash = new Map(
    (portfolio.transactions || []).map((transaction) => [lower(transaction.hash), transaction]),
  )
  const native = summarizeNative(transactions, walletAddress, closingBalanceWei)
  const tokenConservation = summarizeTokenConservation(
    transfers,
    portfolio.totals.walletBalancesAtomic,
    externalTransferKeys,
  )

  console.log('解析 PositionManager 回执，补齐直接领取与缺失增加事件…')
  const positionManager = lower(config.contracts.positionManager)
  const poolById = new Map(configuredPools.map((pool) => [lower(pool.poolId), pool.poolKind]))
  const positionById = new Map(portfolio.positions.map((position) => [String(position.tokenId), position]))
  const receipts = await fetchReceipts(client, transactions, positionManager)
  const positionOperations = receipts.flatMap((receipt) => parsePositionReceipt(receipt, walletAddress, poolById))
  const recordedClaims = portfolio.feeClaims || []
  const exitTerminalClaims = terminalFeeClaimsFromPositions(portfolio.positions, recordedClaims)
  const increaseFeeAudit = implicitIncreaseFeeClaims({
    positions: portfolio.positions,
    operations: positionOperations,
    transferNet,
    existingClaims: recordedClaims,
  })
  const zeroDeltaClaims = positionOperations.flatMap((operation) => {
    if (operation.liquidityDelta !== 0n) return []
    const positive = Object.values(operation.amounts).some((amount) => Number(amount) > 0)
    if (
      !positive ||
      hasFeeClaim([...recordedClaims, ...exitTerminalClaims], operation.transactionHash, operation.tokenId)
    ) {
      return []
    }
    const transaction = transactionByHash.get(operation.transactionHash)
    return [
      {
        id: `chain-zero-delta-${operation.tokenId}-${operation.blockNumber}`,
        sourceTokenIds: [operation.tokenId],
        targetTokenIds: [],
        at: transaction?.timestamp || null,
        blockNumber: String(operation.blockNumber),
        transactionHash: operation.transactionHash,
        amounts: operation.amounts,
        poolKind: operation.poolKind,
        mark: null,
        source: 'chain_zero_delta_modify_liquidity_and_wallet_transfers',
        allocationQuality: 'exact_single_position_receipt_adjacency',
        disposition: 'wallet_or_later_activity',
        evidenceRank: 5,
      },
    ]
  })
  const addedClaims = [...exitTerminalClaims, ...zeroDeltaClaims, ...increaseFeeAudit.claims]
  const claimsBeforeMarks = dedupeFeeClaims([...recordedClaims, ...addedClaims])
  const priorAudit = fs.existsSync(OUTPUT_JSON) ? readJson(OUTPUT_JSON) : null
  const markAtBlock = makeMarketMarker(client, config, priorAuditMarkSeeds(priorAudit))
  const claims = await enrichFeeClaims(claimsBeforeMarks, markAtBlock, positionById)

  const supplyGaps = positionOperations.flatMap((operation) => {
    if (operation.liquidityDelta <= 0n) return []
    const position = positionById.get(operation.tokenId)
    const found = position?.supplyEvents?.some((event) => lower(event.transactionHash) === operation.transactionHash)
    if (found) return []
    return [
      {
        tokenId: operation.tokenId,
        blockNumber: operation.blockNumber,
        transactionHash: operation.transactionHash,
        liquidityDelta: operation.liquidityDelta.toString(),
        walletAmounts: Object.fromEntries(
          Object.entries(operation.amounts).map(([asset, amount]) => [asset, -Number(amount)]),
        ),
        impact: 'position supply / implicit LP conversion may be understated',
        quality: 'VERIFIED_GAP',
      },
    ]
  })
  const supplyGapIds = new Set(supplyGaps.map((gap) => gap.tokenId))

  const currentPrices = {
    eth: portfolio.prices.ethUsdg,
    spy: portfolio.prices.spyUsdg,
    pair: portfolio.prices.pairUsdg,
    usdg: 1,
    one: portfolio.prices.oneUsdg,
  }

  console.log('按钱包边界重建外部本金、回款与用户确认的追高批次…')
  const boundaryEvents = []
  for (const transaction of transactions) {
    if (!transaction.success || transaction.valueWei === 0n) continue
    if (transaction.to === walletAddress && !transaction.fromIsContract) {
      const amount = human(transaction.valueWei, 18)
      const isDust = transaction.valueWei < DUST_NATIVE_THRESHOLD_WEI
      const ethUsdg = nearestSeriesPrice(ethSeries, transaction.timestamp)
      boundaryEvents.push({
        timestamp: transaction.timestamp,
        blockNumber: transaction.blockNumber,
        transactionHash: transaction.hash,
        explorer: transaction.explorer,
        direction: isDust ? 'DUST_OR_REFUND_IN' : 'EXTERNAL_CAPITAL_IN',
        asset: 'ETH',
        amount,
        eventPriceUsdg: ethUsdg,
        eventValueUsdg: ethUsdg ? amount * ethUsdg : null,
        quality: ethUsdg ? 'DERIVED' : 'PARTIAL',
      })
    }
    if (transaction.from === walletAddress && transaction.to && !transaction.toIsContract) {
      const amount = human(transaction.valueWei, 18)
      const ethUsdg = nearestSeriesPrice(ethSeries, transaction.timestamp)
      boundaryEvents.push({
        timestamp: transaction.timestamp,
        blockNumber: transaction.blockNumber,
        transactionHash: transaction.hash,
        explorer: transaction.explorer,
        direction: 'EXTERNAL_DISTRIBUTION_OUT',
        asset: 'ETH',
        amount,
        eventPriceUsdg: ethUsdg,
        eventValueUsdg: ethUsdg ? amount * ethUsdg : null,
        quality: ethUsdg ? 'DERIVED' : 'PARTIAL',
      })
    }
  }
  for (const transfer of externalTokenTransfers) {
    const transaction = transactionByHash.get(transfer.transactionHash)
    const poolKind = transfer.asset === 'one' ? 'one-usdg' : 'pair-spy'
    const mark = transfer.asset === 'usdg' ? { usdg: 1 } : await markAtBlock(transfer.blockNumber, poolKind)
    const price =
      transfer.asset === 'usdg'
        ? 1
        : transfer.asset === 'pair'
          ? mark.pairUsdg
          : transfer.asset === 'spy'
            ? mark.spyUsdg
            : mark.oneUsdg
    boundaryEvents.push({
      timestamp: transfer.timestamp,
      blockNumber: transfer.blockNumber,
      transactionHash: transfer.transactionHash,
      explorer: transaction?.explorer || `${BLOCKSCOUT_SITE}/tx/${transfer.transactionHash}`,
      direction: transfer.direction === 'in' ? 'EXTERNAL_CAPITAL_IN' : 'EXTERNAL_DISTRIBUTION_OUT',
      asset: transfer.asset.toUpperCase(),
      amount: transfer.amount,
      eventPriceUsdg: price,
      eventValueUsdg: Number(price) > 0 ? transfer.amount * Number(price) : null,
      quality: Number(price) > 0 ? 'DERIVED' : 'PARTIAL',
    })
  }
  boundaryEvents.sort((left, right) => left.blockNumber - right.blockNumber)

  const contributionEvents = boundaryEvents.filter((event) => event.direction === 'EXTERNAL_CAPITAL_IN')
  const distributionEvents = boundaryEvents.filter((event) => event.direction === 'EXTERNAL_DISTRIBUTION_OUT')
  const capitalAmounts = amountShape()
  const distributionAmounts = amountShape()
  for (const event of contributionEvents) capitalAmounts[event.asset.toLowerCase()] += event.amount
  for (const event of distributionEvents) distributionAmounts[event.asset.toLowerCase()] += event.amount
  const contributionKnownValue = contributionEvents.reduce(
    (total, event) => total + Number(event.eventValueUsdg || 0),
    0,
  )
  const distributionKnownValue = distributionEvents.reduce(
    (total, event) => total + Number(event.eventValueUsdg || 0),
    0,
  )

  const gasEthByTransaction = new Map(
    transactions.map((transaction) => [transaction.hash, human(transaction.feeWei, 18)]),
  )
  const costUsdgByTransaction = new Map()
  for (const batch of assertions.purchaseBatches) {
    for (const hashValue of batch.transactionHashes) {
      const hash = lower(hashValue)
      if (costUsdgByTransaction.has(hash)) continue
      const transaction = transactionByHash.get(hash)
      const flow = transferNet.get(hash) || amountShape()
      const mark = transaction ? await markAtBlock(transaction.blockNumber, 'pair-spy') : {}
      const ethUsdg = transaction ? nearestSeriesPrice(ethSeries, transaction.timestamp) : null
      const cost =
        Math.max(0, -flow.spy) * Number(mark.spyUsdg || 0) +
        Math.max(0, -flow.usdg) +
        human(transaction?.valueWei || 0n, 18) * Number(ethUsdg || 0)
      costUsdgByTransaction.set(hash, cost > 0 ? cost : null)
    }
  }
  const ownerPurchaseBatches = assertions.purchaseBatches.map((batch) => {
    const reconciliation = reconcilePurchaseBatch({
      transactionHashes: batch.transactionHashes,
      transferByTransaction: transferNet,
      gasEthByTransaction,
      costUsdgByTransaction,
      assertedNotionalUsdg: batch.assertedNotionalUsdg,
      assertedAveragePairUsdg: batch.assertedAveragePairUsdg,
    })
    return {
      ...batch,
      transactionHashes: batch.transactionHashes.map(lower),
      reconciliation,
      quality: reconciliation.unknownCostTransactions ? 'PARTIAL' : 'USER_ASSERTED_PROVENANCE_CHAIN_VERIFIED_EXECUTION',
    }
  })

  const assertedHashes = new Map(
    ownerPurchaseBatches.flatMap((batch) => batch.transactionHashes.map((hash) => [hash, batch.id])),
  )
  const pairAcquisitions = []
  for (const [hash, flow] of transferNet.entries()) {
    if (flow.pair <= 0 || (flow.spy >= 0 && flow.usdg >= 0)) continue
    const transaction = transactionByHash.get(hash)
    if (!transaction) continue
    const label = labelByHash.get(hash)?.label || null
    const mark = await markAtBlock(transaction.blockNumber, 'pair-spy')
    const costUsdg = Math.max(0, -flow.spy) * Number(mark.spyUsdg || 0) + Math.max(0, -flow.usdg)
    const classification = assertedHashes.has(hash)
      ? 'USER_ASSERTED_BACKUP_FUNDS'
      : /手续费|仅将本次领取|fee/iu.test(label || '')
        ? 'LP_FEE_FUNDED'
        : 'OWNER_OR_RECYCLED_PRINCIPAL_UNRESOLVED'
    pairAcquisitions.push({
      timestamp: transaction.timestamp,
      blockNumber: transaction.blockNumber,
      transactionHash: hash,
      explorer: transaction.explorer,
      label,
      classification,
      batchId: assertedHashes.get(hash) || null,
      spySpent: Math.max(0, -flow.spy),
      usdgSpent: Math.max(0, -flow.usdg),
      pairBought: flow.pair,
      costUsdg: costUsdg || null,
      averagePairUsdg: costUsdg > 0 ? costUsdg / flow.pair : null,
      mark: {
        spyUsdg: mark.spyUsdg ?? null,
        pairUsdg: mark.pairUsdg ?? null,
        quality: mark.quality || 'UNKNOWN',
      },
      evidence:
        classification === 'USER_ASSERTED_BACKUP_FUNDS' ? 'USER_ASSERTED + CHAIN_VERIFIED' : 'CHAIN_VERIFIED_FLOW',
    })
  }

  const pairAcquisitionSummary = [
    'USER_ASSERTED_BACKUP_FUNDS',
    'LP_FEE_FUNDED',
    'OWNER_OR_RECYCLED_PRINCIPAL_UNRESOLVED',
  ].map((classification) => {
    const rows = pairAcquisitions.filter((item) => item.classification === classification)
    const pairBought = rows.reduce((total, item) => total + item.pairBought, 0)
    const costKnownUsdg = rows.reduce((total, item) => total + Number(item.costUsdg || 0), 0)
    const unknownCostTransactions = rows.filter((item) => item.costUsdg == null).length
    const currentReplacementUsdg = pairBought * currentPrices.pair
    return {
      classification,
      transactions: rows.length,
      spySpent: rows.reduce((total, item) => total + item.spySpent, 0),
      usdgSpent: rows.reduce((total, item) => total + item.usdgSpent, 0),
      pairBought,
      costKnownUsdg,
      unknownCostTransactions,
      averagePairUsdg: pairBought > 0 && !unknownCostTransactions ? costKnownUsdg / pairBought : null,
      currentReplacementUsdg,
      replacementDeltaUsdg: unknownCostTransactions ? null : currentReplacementUsdg - costKnownUsdg,
      replacementDeltaPct:
        !unknownCostTransactions && costKnownUsdg > 0
          ? ((currentReplacementUsdg - costKnownUsdg) / costKnownUsdg) * 100
          : null,
      warning:
        'Current replacement assumes every acquired PAIR lot was never spent, transferred, or converted inside LP; it is not actual portfolio PnL.',
    }
  })

  const claimsBySinglePosition = new Map()
  for (const claim of claims) {
    if ((claim.sourceTokenIds || []).length !== 1) continue
    const tokenId = String(claim.sourceTokenIds[0])
    claimsBySinglePosition.set(tokenId, sumAmounts(claimsBySinglePosition.get(tokenId) || {}, claim.amounts || {}))
  }
  const positions = portfolio.positions.map((position) => ({
    tokenId: String(position.tokenId),
    poolKind: position.poolKind,
    label: position.label,
    role: position.role,
    status: position.status,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    currentRange: position.currentRange || null,
    supplied: position.supplied || amountShape(),
    currentPrincipal: position.principal || amountShape(),
    currentPrincipalUsdg: position.accounting?.currentPrincipalUsdg ?? null,
    unclaimedFees: position.unclaimedFees || amountShape(),
    knownClaimedFees: claimsBySinglePosition.get(String(position.tokenId)) || amountShape(),
    dataQuality: supplyGapIds.has(String(position.tokenId)) ? 'PARTIAL_MISSING_SUPPLY_EVENT' : position.dataQuality,
    mint: position.mint,
    exit: position.exit || null,
  }))

  const lpInventoryConversions = portfolio.positions.map((position) => {
    const tokenId = String(position.tokenId)
    if (!['pair-spy', 'pair-usdg'].includes(position.poolKind)) {
      return {
        tokenId,
        poolKind: position.poolKind,
        status: position.status,
        side: 'NOT_APPLICABLE',
        quality: 'VERIFIED',
        reason: 'PAIR inventory accounting excludes the separate $1/USDG appendix',
        source: 'scope_exclusion',
      }
    }
    const inventory = position.priceLedger?.inventory?.amounts || null
    const quoteAsset = position.poolKind === 'pair-usdg' ? 'usdg' : 'spy'
    const quoteUsdg = quoteAsset === 'usdg' ? 1 : position.priceLedger?.endpoint?.spyUsdg || portfolio.prices.spyUsdg
    const conversion = deriveLpInventoryConversion({
      supplied: position.supplied || {},
      endpointInventory: inventory,
      quoteAsset,
      quoteUsdg,
      complete: !supplyGapIds.has(tokenId) && position.priceLedger?.inventory?.quality !== 'UNKNOWN',
    })
    return {
      tokenId,
      poolKind: position.poolKind,
      status: position.status,
      ...conversion,
      source: 'net_principal_inventory_change_fees_excluded',
    }
  })
  const knownConversions = lpInventoryConversions.filter(
    (row) => ['BUY', 'SELL'].includes(row.side) && row.quality !== 'UNKNOWN',
  )
  const lpConversionSummary = {
    pairBought: knownConversions
      .filter((row) => row.side === 'BUY')
      .reduce((total, row) => total + Number(row.pairDelta || 0), 0),
    pairSold: -knownConversions
      .filter((row) => row.side === 'SELL')
      .reduce((total, row) => total + Number(row.pairDelta || 0), 0),
    spySpentBuying: -knownConversions
      .filter((row) => row.side === 'BUY' && row.quoteAsset === 'spy')
      .reduce((total, row) => total + Number(row.quoteDelta || 0), 0),
    spyReceivedSelling: knownConversions
      .filter((row) => row.side === 'SELL' && row.quoteAsset === 'spy')
      .reduce((total, row) => total + Number(row.quoteDelta || 0), 0),
    unknownPositions: lpInventoryConversions.filter((row) => row.quality === 'UNKNOWN').length,
    quality: lpInventoryConversions.some((row) => row.quality === 'UNKNOWN') ? 'PARTIAL' : 'DERIVED',
    meaning:
      'Cumulative NFT-local inventory turnover across successive ranges; it is not unique PAIR quantity, current holdings, or external capital.',
  }

  const allClaimedFees = summarizeFeeClaims(claims, currentPrices)
  const mainStrategyClaimedFees = summarizeFeeClaims(
    claims.filter((claim) => claim.poolKind !== 'one-usdg'),
    currentPrices,
  )
  const oneUsdgClaimedFees = summarizeFeeClaims(
    claims.filter((claim) => claim.poolKind === 'one-usdg'),
    currentPrices,
  )
  const feeAmounts = allClaimedFees.amounts
  const feeEventKnown = allClaimedFees.eventMarkedKnownUsdg
  const feeEventUnknownRecords = allClaimedFees.unknownEventValueRecords
  const feeCurrent = allClaimedFees.currentReplacementUsdg
  const unclaimed = portfolio.totals.unclaimedFees || amountShape()
  const unclaimedCurrent = valueAmounts(unclaimed, currentPrices).valueUsdg

  let gasEventMarkUsdg = 0
  let gasUnknownTransactions = 0
  for (const transaction of transactions.filter((item) => item.from === walletAddress)) {
    const ethUsdg = nearestSeriesPrice(ethSeries, transaction.timestamp)
    if (!ethUsdg) gasUnknownTransactions += 1
    else gasEventMarkUsdg += human(transaction.feeWei, 18) * ethUsdg
  }

  const mainAssets = sumAmounts(portfolio.totals.activePrincipal || {}, portfolio.totals.unclaimedFees || {}, {
    eth: portfolio.totals.walletBalances.eth,
    spy: portfolio.totals.walletBalances.spy,
    pair: portfolio.totals.walletBalances.pair,
    usdg: portfolio.totals.walletBalances.usdg,
  })
  const appendixAssets = { one: portfolio.totals.walletBalances.one, usdg: 0 }
  const mainAssetValuation = valueAmounts(mainAssets, currentPrices)
  const appendixAssetValuation = valueAmounts(appendixAssets, currentPrices)
  const walletBoundaryMarketValueBridgeUsdg =
    mainAssetValuation.valueUsdg + appendixAssetValuation.valueUsdg + distributionKnownValue - contributionKnownValue

  const exitedPositions = portfolio.positions.filter((position) => position.status === 'empty')
  const exitAllocationGaps = exitedPositions.filter((position) => {
    const exit = position.exit
    return (
      !exit?.principalAmounts ||
      !exit?.terminalFeeAmounts ||
      /partial|unknown/iu.test(String(exit.amountQuality || 'unknown'))
    )
  })
  const unresolvedIncreaseFeeCredits = increaseFeeAudit.reconciliations.filter((row) => row.status === 'UNRESOLVED')
  const feeAmountsQuality =
    exitAllocationGaps.length || unresolvedIncreaseFeeCredits.length
      ? 'PARTIAL_KNOWN_LOWER_BOUND'
      : 'DERIVED_COMPLETE_WITHIN_AUDITED_WALLET_AND_NFT_SET'

  const exceptions = [
    ...supplyGaps.map((gap) => ({
      priority: 'P0',
      code: 'MISSING_SUPPLY_EVENT',
      tokenId: gap.tokenId,
      transactionHash: gap.transactionHash,
      impact: `NFT #${gap.tokenId} 的增加流动性未进入原生命周期账本，隐含买卖均价不能可靠计算`,
      nextStep: '用该回执的实际 liquidity delta、手续费 credit 与钱包支出重建 supply event',
    })),
    ...exitAllocationGaps.map((position) => ({
      priority: 'P0',
      code: 'EXIT_BUNDLED_FEE_UNKNOWN',
      tokenId: String(position.tokenId),
      transactionHash: position.exit?.transactionHash || null,
      impact: `NFT #${position.tokenId} 的撤仓本金与末次手续费尚未唯一拆分`,
      nextStep: '按撤仓前区块的 liquidity/tick/feeGrowth 与回执钱包流逐仓回放',
    })),
    ...unresolvedIncreaseFeeCredits.map((row) => ({
      priority: 'P1',
      code: 'POSITIVE_INCREASE_FEE_CREDIT_COVERAGE',
      tokenId: row.tokenId,
      transactionHash: row.transactionHash,
      impact: `NFT #${row.tokenId} 的正向加仓无法用单一正向 ModifyLiquidity、底层投入和钱包净支出唯一对账`,
      nextStep: '逐日志回放该交易的 ModifyLiquidity、Swap 与 Settlement 顺序',
    })),
    {
      priority: 'P1',
      code: 'MIXED_SPY_PROVENANCE',
      impact: '钱包 SPY 同时来自 ETH 买入、LP 卖出 PAIR、撤仓回款和手续费，非指定批次无法唯一判断是否后备资金',
      nextStep: '以用户确认批次为锚，其他 SPY→PAIR 保持 unresolved，避免误计新增本金',
    },
    {
      priority: 'P1',
      code: 'EXTERNAL_DISTRIBUTION_OWNERSHIP_BOUNDARY',
      impact: '转到另一个外部地址的资产在本钱包账内视为回款，但若仍由用户持有，不能据此计算个人总资产 PnL',
      nextStep: '若要个人级 PnL，需要把收款地址纳入审计范围或提供处置结果',
    },
    ...(feeEventUnknownRecords
      ? [
          {
            priority: 'P1',
            code: 'FEE_EVENT_MARK_UNKNOWN',
            impact: `${feeEventUnknownRecords} 条手续费记录缺少完整交易时点价格，只能计算已知资产价值和当前替代市值`,
            nextStep: '扩大历史价格回溯或使用归档节点补齐同时点市场价格',
          },
        ]
      : []),
  ]

  const audit = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    wallet: config.wallet,
    chainId: config.chain.id,
    asOfBlock: String(cutoff),
    asOfTime: portfolio.asOfTime,
    runtime: dashboardPayload.runtime,
    sources: {
      portfolioManifest: path.relative(ROOT, PORTFOLIO_MANIFEST_PATH),
      portfolioManifestSafeBlock: String(manifestCutoff),
      blockscoutApi: BLOCKSCOUT_BASE,
      rpc: config.chain.defaultRpcUrl,
      ethHistoricalPrice: COINGECKO_ETH_RANGE,
      userAssertions: path.relative(ROOT, ASSERTIONS_PATH),
    },
    quality: {
      overall: exceptions.length ? 'PARTIAL' : 'DERIVED',
      chainConservation:
        native.quality === 'VERIFIED' && Object.values(tokenConservation).every((row) => row.quality === 'VERIFIED')
          ? 'VERIFIED'
          : 'MISMATCH',
      capital: 'PARTIAL_MARKET_VALUE_NOT_TAX_COST_BASIS',
      fees: feeAmountsQuality,
      lpInventoryConversion: lpConversionSummary.quality,
    },
    currentPrices,
    currentAssets: {
      mainStrategyAmounts: mainAssets,
      mainStrategyUsdg: mainAssetValuation.valueUsdg,
      mainStrategyUnknownAssets: mainAssetValuation.unknownAssets,
      oneUsdgAppendixAmounts: appendixAssets,
      oneUsdgAppendixUsdg: appendixAssetValuation.valueUsdg,
      oneUsdgAppendixUnknownAssets: appendixAssetValuation.unknownAssets,
      note: 'Claimed fees are not added again; they are already reinvested, converted, withdrawn, or in wallet balances.',
    },
    capital: {
      grossExternalContributions: {
        nativeEth: capitalAmounts.eth,
        pair: capitalAmounts.pair,
        spy: capitalAmounts.spy,
        usdg: capitalAmounts.usdg,
        eventMarkUsdg: contributionKnownValue,
        unknownEventValueCount: contributionEvents.filter((event) => event.eventValueUsdg == null).length,
        quality: 'DERIVED_MARKET_VALUE_NOT_ORIGINAL_COST_BASIS',
      },
      externalDistributions: {
        nativeEth: distributionAmounts.eth,
        pair: distributionAmounts.pair,
        spy: distributionAmounts.spy,
        usdg: distributionAmounts.usdg,
        eventMarkUsdg: distributionKnownValue,
        unknownEventValueCount: distributionEvents.filter((event) => event.eventValueUsdg == null).length,
        quality: 'DERIVED_WALLET_BOUNDARY_ONLY',
      },
      dustOrRefundNativeEth: boundaryEvents
        .filter((event) => event.direction === 'DUST_OR_REFUND_IN')
        .reduce((total, event) => total + event.amount, 0),
      boundaryEvents,
      pairAcquisitions,
      pairAcquisitionSummary,
      walletBoundaryMarketValueBridge: {
        netExternalContributionsAtEventMarksUsdg: contributionKnownValue - distributionKnownValue,
        currentAssetsPlusDistributionsMinusContributionsUsdg: walletBoundaryMarketValueBridgeUsdg,
        quality: 'DERIVED_MARKET_VALUE_BRIDGE_NOT_INVESTMENT_PNL',
        warning:
          'Contributions and distributions are marked at different transaction times; externally transferred PAIR original acquisition cost is unknown.',
      },
    },
    ownerPurchaseBatches,
    fees: {
      recordedRecords: recordedClaims.length,
      addedChainRecords: addedClaims.length,
      addedZeroDeltaRecords: zeroDeltaClaims.length,
      addedExitTerminalRecords: exitTerminalClaims.length,
      addedIncreaseFeeCreditRecords: increaseFeeAudit.claims.length,
      positiveIncreaseReconciliation: {
        operations: increaseFeeAudit.reconciliations.length,
        recorded: increaseFeeAudit.reconciliations.filter((row) => row.status === 'RECORDED').length,
        derivedAndAdded: increaseFeeAudit.reconciliations.filter((row) => row.status === 'DERIVED_AND_ADDED').length,
        verifiedNoImplicitFee: increaseFeeAudit.reconciliations.filter(
          (row) => row.status === 'VERIFIED_NO_IMPLICIT_FEE',
        ).length,
        unresolved: unresolvedIncreaseFeeCredits.length,
        quality: unresolvedIncreaseFeeCredits.length ? 'PARTIAL' : 'DERIVED_COMPLETE',
      },
      exitAllocation: {
        exitedPositions: exitedPositions.length,
        separatedPositions: exitedPositions.length - exitAllocationGaps.length,
        unresolvedTokenIds: exitAllocationGaps.map((position) => String(position.tokenId)),
        quality: exitAllocationGaps.length ? 'PARTIAL' : 'VERIFIED_OR_DERIVED_COMPLETE',
      },
      claimed: {
        records: claims.length,
        amounts: feeAmounts,
        eventMarkedKnownUsdg: feeEventKnown,
        eventMarkedKnownAfterAllWalletGasUsdg: feeEventKnown - gasEventMarkUsdg,
        unknownEventValueRecords: feeEventUnknownRecords,
        currentReplacementUsdg: feeCurrent,
        quality: feeAmountsQuality,
      },
      mainStrategyClaimed: {
        ...mainStrategyClaimedFees,
        quality: feeAmountsQuality,
      },
      oneUsdgAppendixClaimed: {
        ...oneUsdgClaimedFees,
        quality: feeAmountsQuality,
      },
      unclaimed: {
        amounts: unclaimed,
        currentMarkUsdg: unclaimedCurrent,
        quality: 'VERIFIED_AT_CANONICAL_SAFE_BLOCK',
      },
      claims,
      warning: 'Never add cumulative claimed fees to current assets; doing so double counts reinvested or held assets.',
    },
    gas: {
      transactions: transactions.filter((transaction) => transaction.from === walletAddress).length,
      totalEth: native.gasEth,
      eventMarkUsdg: gasUnknownTransactions ? null : gasEventMarkUsdg,
      eventMarkedKnownUsdg: gasEventMarkUsdg,
      unknownPriceTransactions: gasUnknownTransactions,
      currentMarkUsdg: native.gasEth * currentPrices.eth,
      scope: 'all wallet-originated transactions, including failed transactions',
    },
    lpConversionSummary,
    lpInventoryConversions,
    positiveIncreaseFeeReconciliations: increaseFeeAudit.reconciliations,
    positions,
    chainOperations: {
      positionManagerReceipts: receipts.length,
      modifyLiquidityEvents: positionOperations.length,
      positive: positionOperations.filter((operation) => operation.liquidityDelta > 0n).length,
      zero: positionOperations.filter((operation) => operation.liquidityDelta === 0n).length,
      negative: positionOperations.filter((operation) => operation.liquidityDelta < 0n).length,
      missingSupplyEvents: supplyGaps,
    },
    reconciliation: {
      native,
      tokens: tokenConservation,
    },
    exceptions,
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  fs.writeFileSync(OUTPUT_JSON, `${json(audit)}\n`)
  fs.writeFileSync(OUTPUT_MARKDOWN, buildMarkdown(audit))
  fs.writeFileSync(
    OUTPUT_CAPITAL_CSV,
    toCsv(boundaryEvents, [
      'timestamp',
      'blockNumber',
      'direction',
      'asset',
      'amount',
      'eventPriceUsdg',
      'eventValueUsdg',
      'quality',
      'transactionHash',
      'explorer',
    ]),
  )
  fs.writeFileSync(
    OUTPUT_ACQUISITIONS_CSV,
    toCsv(pairAcquisitions, [
      'timestamp',
      'blockNumber',
      'classification',
      'batchId',
      'label',
      'spySpent',
      'usdgSpent',
      'pairBought',
      'costUsdg',
      'averagePairUsdg',
      'mark',
      'evidence',
      'transactionHash',
      'explorer',
    ]),
  )
  fs.writeFileSync(
    OUTPUT_FEES_CSV,
    toCsv(
      claims.map((claim) => ({
        id: claim.id,
        at: claim.at,
        blockNumber: claim.blockNumber,
        transactionHash: claim.transactionHash,
        sourceTokenIds: (claim.sourceTokenIds || []).join(';'),
        poolKind: claim.poolKind,
        spy: claim.amounts?.spy || 0,
        pair: claim.amounts?.pair || 0,
        usdg: claim.amounts?.usdg || 0,
        one: claim.amounts?.one || 0,
        eventValueUsdg: claim.eventValueUsdg,
        eventValueUnknownAssets: (claim.eventValueUnknownAssets || []).join(';'),
        source: claim.source,
        allocationQuality: claim.allocationQuality,
        disposition: claim.disposition,
      })),
      [
        'id',
        'at',
        'blockNumber',
        'transactionHash',
        'sourceTokenIds',
        'poolKind',
        'spy',
        'pair',
        'usdg',
        'one',
        'eventValueUsdg',
        'eventValueUnknownAssets',
        'source',
        'allocationQuality',
        'disposition',
      ],
    ),
  )
  fs.writeFileSync(
    OUTPUT_INCREASE_FEES_CSV,
    toCsv(increaseFeeAudit.reconciliations, [
      'tokenId',
      'poolKind',
      'blockNumber',
      'transactionHash',
      'supplyQuality',
      'positiveOperations',
      'negativeOperations',
      'totalUnderlying',
      'walletSpend',
      'implicitFees',
      'recordedAmounts',
      'status',
      'quality',
    ]),
  )
  fs.writeFileSync(
    OUTPUT_CONVERSIONS_CSV,
    toCsv(lpInventoryConversions, [
      'tokenId',
      'poolKind',
      'status',
      'side',
      'pairDelta',
      'quoteDelta',
      'quoteAsset',
      'priceInQuote',
      'pairUsdg',
      'quality',
      'reason',
      'source',
    ]),
  )
  fs.writeFileSync(
    OUTPUT_EXCEPTIONS_CSV,
    toCsv(exceptions, ['priority', 'code', 'tokenId', 'transactionHash', 'impact', 'nextStep']),
  )

  console.log(`审计完成：${OUTPUT_MARKDOWN}`)
  console.log(`截止区块：${audit.asOfBlock}`)
  console.log(`外部毛投入时点市值：${fixed(audit.capital.grossExternalContributions.eventMarkUsdg, 2)} USDG`)
  console.log(`已识别手续费时点价值：${fixed(audit.fees.claimed.eventMarkedKnownUsdg, 2)} USDG`)
  console.log(`全钱包 gas：${fixed(audit.gas.totalEth, 9)} ETH`)
  console.log(`守恒：${audit.quality.chainConservation}`)
  console.log(`结论质量：${audit.quality.overall}`)
}

await main()
