import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createPublicClient,
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
import { buildPortfolioView, loadPortfolioManifest } from './portfolio.mjs'

const Q96_NUMBER = 2 ** 96
const Q96 = 1n << 96n
const Q32 = 1n << 32n
const Q128 = 1n << 128n
const UINT256_MODULUS = 1n << 256n
const UINT256_MAX = UINT256_MODULUS - 1n
const LOG_CHUNK = 10_000n
const BLOCK_BATCH = 20
const BLOCK_FETCH_ATTEMPTS = 9
const BLOCK_BATCH_PAUSE_MS = 600
const RPC_READ_ATTEMPTS = 6
const SYNC_CHUNK_PAUSE_MS = 250

function finiteSetting(value, fallback, minimum, integer = false) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < minimum) return fallback
  return integer ? Math.trunc(numeric) : numeric
}

export function createRpcRequestGate({
  minimumIntervalMs = 0,
  now = () => Date.now(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const interval = Math.max(0, Number(minimumIntervalMs) || 0)
  let schedule = Promise.resolve()
  let nextStartAt = 0

  return function gate(operation) {
    const ready = schedule.then(async () => {
      const waitMs = Math.max(0, nextStartAt - now())
      if (waitMs > 0) await wait(waitMs)
      nextStartAt = now() + interval
    })
    schedule = ready.catch(() => {})
    return ready.then(operation)
  }
}

const TICK_MULTIPLIERS = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
]

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
  'function getTickBitmap(bytes32 poolId,int16 wordPosition) view returns (uint256 tickBitmap)',
  'function getTickLiquidity(bytes32 poolId,int24 tick) view returns (uint128 liquidityGross,int128 liquidityNet)',
  'function getPositionInfo(bytes32 poolId,bytes32 positionId) view returns (uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128)',
  'function getFeeGrowthInside(bytes32 poolId,int24 tickLower,int24 tickUpper) view returns (uint256 feeGrowthInside0X128,uint256 feeGrowthInside1X128)',
])

const POSITION_MANAGER_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
])

const ERC20_BALANCE_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)'])

const V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
])

const V3_QUOTER_ABI = parseAbi([
  'function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)',
])

const V4_SWAP_EVENT = parseAbiItem(
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
)

const V3_SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
)

function json(value) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item))
}

function floorDiv(value, divisor) {
  return Math.floor(value / divisor)
}

function ceilDiv(value, divisor) {
  return Math.ceil(value / divisor)
}

function sqrtAtTick(tick) {
  return Math.pow(1.0001, tick / 2) * Q96_NUMBER
}

export function sqrtRatioAtTick(tick) {
  if (!Number.isInteger(tick) || Math.abs(tick) > 887_272) {
    throw new RangeError(`tick out of range: ${tick}`)
  }
  const absolute = Math.abs(tick)
  let ratio = (absolute & 1) !== 0 ? TICK_MULTIPLIERS[0] : Q128
  for (let bit = 1; bit < TICK_MULTIPLIERS.length; bit += 1) {
    if ((absolute & (1 << bit)) !== 0) ratio = (ratio * TICK_MULTIPLIERS[bit]) >> 128n
  }
  if (tick > 0) ratio = UINT256_MAX / ratio
  return (ratio >> 32n) + ((ratio & (Q32 - 1n)) === 0n ? 0n : 1n)
}

export function positionTokenAmounts(liquidity, sqrtPriceX96, tickLower, tickUpper) {
  const activeLiquidity = BigInt(liquidity)
  const current = BigInt(sqrtPriceX96)
  const lower = sqrtRatioAtTick(tickLower)
  const upper = sqrtRatioAtTick(tickUpper)
  if (lower >= upper) throw new RangeError('position ticks are not ordered')

  if (current <= lower) {
    return {
      amount0: (activeLiquidity * (upper - lower) * Q96) / (upper * lower),
      amount1: 0n,
    }
  }
  if (current < upper) {
    return {
      amount0: (activeLiquidity * (upper - current) * Q96) / (upper * current),
      amount1: (activeLiquidity * (current - lower)) / Q96,
    }
  }
  return {
    amount0: 0n,
    amount1: (activeLiquidity * (upper - lower)) / Q96,
  }
}

function tickAtSqrt(sqrtPriceX96) {
  return (2 * Math.log(sqrtPriceX96 / Q96_NUMBER)) / Math.log(1.0001)
}

export function pairPriceAtTick(spyUsdg, tick) {
  return spyUsdg / Math.pow(1.0001, tick)
}

export function currentPairPositionConfigs(configured = [], manifest = null) {
  if (!manifest?.positions) return configured
  const activeManifest = manifest.positions.filter((position) => {
    if (position.poolKind !== 'pair-spy') return false
    try {
      return BigInt(position.lastKnownLiquidity || 0) > 0n
    } catch {
      return false
    }
  })
  const activeById = new Map(activeManifest.map((position) => [String(position.tokenId), position]))
  const result = []
  const seen = new Set()
  for (const override of configured) {
    const tokenId = String(override.tokenId)
    const position = activeById.get(tokenId)
    if (!position) continue
    result.push({
      label: override.label || position.label || `NFT ${tokenId}`,
      role: override.role || position.role || 'unclassified',
      tokenId,
      tickLower: Number(position.tickLower),
      tickUpper: Number(position.tickUpper),
    })
    seen.add(tokenId)
  }
  for (const position of activeManifest) {
    const tokenId = String(position.tokenId)
    if (seen.has(tokenId)) continue
    result.push({
      label: position.label || `NFT ${tokenId}`,
      role: position.role || 'unclassified',
      tokenId,
      tickLower: Number(position.tickLower),
      tickUpper: Number(position.tickUpper),
    })
  }
  return result
}

export function v3HumanPriceFromSqrt(sqrtPriceX96, token0Decimals = 18, token1Decimals = 6) {
  const rawToken1PerToken0 = Math.pow(Number(sqrtPriceX96) / Q96_NUMBER, 2)
  return rawToken1PerToken0 * Math.pow(10, token0Decimals - token1Decimals)
}

export function directPairPriceAtTick(tick, token0Decimals = 6, token1Decimals = 18) {
  return Math.pow(10, token1Decimals - token0Decimals) / Math.pow(1.0001, tick)
}

export function directPairTickAtPrice(pairUsdg, token0Decimals = 6, token1Decimals = 18) {
  if (!Number.isFinite(pairUsdg) || pairUsdg <= 0) throw new RangeError('PAIR price must be positive')
  return Math.log(Math.pow(10, token1Decimals - token0Decimals) / pairUsdg) / Math.log(1.0001)
}

export function directLiquidityForCapital({
  capitalUsdg,
  pairUsdg,
  priceLowUsdg,
  priceHighUsdg,
  currentTick,
  tickSpacing,
  token0Decimals = 6,
  token1Decimals = 18,
}) {
  if (!Number.isFinite(capitalUsdg) || capitalUsdg <= 0) {
    return { liquidity: 0, tickLower: 0, tickUpper: 0, amount0: 0, amount1: 0, inRange: false }
  }
  const low = Math.min(priceLowUsdg, priceHighUsdg)
  const high = Math.max(priceLowUsdg, priceHighUsdg)
  const tickLower = floorDiv(directPairTickAtPrice(high, token0Decimals, token1Decimals), tickSpacing) * tickSpacing
  const tickUpper = ceilDiv(directPairTickAtPrice(low, token0Decimals, token1Decimals), tickSpacing) * tickSpacing
  const sqrtCurrent = Math.pow(1.0001, currentTick / 2)
  const sqrtLower = Math.pow(1.0001, tickLower / 2)
  const sqrtUpper = Math.pow(1.0001, tickUpper / 2)
  let amount0RawPerLiquidity = 0
  let amount1RawPerLiquidity = 0
  if (sqrtCurrent <= sqrtLower) {
    amount0RawPerLiquidity = (sqrtUpper - sqrtLower) / (sqrtLower * sqrtUpper)
  } else if (sqrtCurrent < sqrtUpper) {
    amount0RawPerLiquidity = (sqrtUpper - sqrtCurrent) / (sqrtCurrent * sqrtUpper)
    amount1RawPerLiquidity = sqrtCurrent - sqrtLower
  } else {
    amount1RawPerLiquidity = sqrtUpper - sqrtLower
  }
  const amount0PerLiquidity = amount0RawPerLiquidity / Math.pow(10, token0Decimals)
  const amount1PerLiquidity = amount1RawPerLiquidity / Math.pow(10, token1Decimals)
  const valuePerLiquidity = amount0PerLiquidity + amount1PerLiquidity * pairUsdg
  const liquidity = valuePerLiquidity > 0 ? capitalUsdg / valuePerLiquidity : 0
  return {
    liquidity,
    tickLower,
    tickUpper,
    amount0: liquidity * amount0PerLiquidity,
    amount1: liquidity * amount1PerLiquidity,
    inRange: currentTick >= tickLower && currentTick < tickUpper,
    priceLowUsdg: directPairPriceAtTick(tickUpper, token0Decimals, token1Decimals),
    priceHighUsdg: directPairPriceAtTick(tickLower, token0Decimals, token1Decimals),
  }
}

function windowHours(window) {
  return Math.max(1 / 3_600, (Date.parse(window.toTime) - Date.parse(window.effectiveFromTime)) / 3_600_000)
}

function weightedPriceQuantile(bins, quantile) {
  const ordered = bins
    .filter((bin) => Number(bin.volumeUsdg) > 0)
    .sort((left, right) => left.priceMidUsdg - right.priceMidUsdg)
  const total = ordered.reduce((sum, bin) => sum + Number(bin.volumeUsdg), 0)
  if (total <= 0) return null
  const target = total * quantile
  let cumulative = 0
  for (const bin of ordered) {
    cumulative += Number(bin.volumeUsdg)
    if (cumulative >= target) return bin.priceMidUsdg
  }
  return ordered.at(-1)?.priceMidUsdg ?? null
}

export function optimizeDirectRange({
  currentTick,
  pairUsdg,
  tickSpacing,
  capitalUsdg,
  baseBins,
  windows,
  minSpanTicks = 2_000,
  maxSpanTicks = 3_600,
  minimumRangePositionBps = 2_000,
  maximumRangePositionBps = 8_000,
}) {
  const oneHour = windows['1h']
  const sixHours = windows['6h']
  if (!oneHour || !sixHours || capitalUsdg <= 0) return null
  const currentBin = floorDiv(currentTick, tickSpacing) * tickSpacing
  const binByTick = new Map(baseBins.map((bin) => [bin.tickLower, bin]))
  const windowMaps = Object.fromEntries(
    Object.entries(windows).map(([id, window]) => [id, new Map(window.bins.map((bin) => [bin.tickLower, bin]))]),
  )
  const totals = Object.fromEntries(
    Object.entries(windows).map(([id, window]) => [
      id,
      window.bins.reduce((sum, bin) => sum + Number(bin.volumeUsdg), 0),
    ]),
  )
  const candidates = []
  const minimumSteps = Math.max(2, Math.ceil(minSpanTicks / tickSpacing))
  const maximumSteps = Math.max(minimumSteps, Math.floor(maxSpanTicks / tickSpacing))

  for (let spanSteps = minimumSteps; spanSteps <= maximumSteps; spanSteps += 1) {
    for (let stepsBelow = 1; stepsBelow < spanSteps; stepsBelow += 1) {
      const tickLower = currentBin - stepsBelow * tickSpacing
      const tickUpper = tickLower + spanSteps * tickSpacing
      if (currentTick < tickLower || currentTick >= tickUpper) continue
      const rangePositionBps = ((currentTick - tickLower) / (tickUpper - tickLower)) * 10_000
      if (rangePositionBps < minimumRangePositionBps || rangePositionBps > maximumRangePositionBps) continue
      const priceLowUsdg = directPairPriceAtTick(tickUpper)
      const priceHighUsdg = directPairPriceAtTick(tickLower)
      const modeled = directLiquidityForCapital({
        capitalUsdg,
        pairUsdg,
        priceLowUsdg,
        priceHighUsdg,
        currentTick,
        tickSpacing,
      })
      if (!Number.isFinite(modeled.liquidity) || modeled.liquidity <= 0) continue
      const metrics = {}
      for (const [id, window] of Object.entries(windows)) {
        let volumeUsdg = 0
        let grossFeeUsdg = 0
        let estimatedFeeUsdg = 0
        let feeWeightedShareNumerator = 0
        for (let tick = tickLower; tick < tickUpper; tick += tickSpacing) {
          const historical = windowMaps[id].get(tick)
          if (!historical) continue
          const market = Math.max(0, Number(BigInt(binByTick.get(tick)?.marketLiquidity || 0)))
          const share = modeled.liquidity / (market + modeled.liquidity)
          const volume = Number(historical.volumeUsdg)
          const fee = Number(historical.grossFeeUsdg)
          volumeUsdg += volume
          grossFeeUsdg += fee
          estimatedFeeUsdg += fee * share
          feeWeightedShareNumerator += fee * share
        }
        const hours = windowHours(window)
        metrics[id] = {
          volumeUsdg,
          volumeCoveragePct: totals[id] > 0 ? (volumeUsdg / totals[id]) * 100 : 0,
          grossFeeUsdg,
          estimatedFeeUsdg,
          hourlyFeeUsdg: estimatedFeeUsdg / hours,
          dailyRatePct: (estimatedFeeUsdg / capitalUsdg / hours) * 24 * 100,
          feeWeightedMarketSharePct: grossFeeUsdg > 0 ? (feeWeightedShareNumerator / grossFeeUsdg) * 100 : 0,
        }
      }
      const oneHourRate = metrics['1h'].hourlyFeeUsdg
      const sixHourRate = metrics['6h'].hourlyFeeUsdg
      const stableHourlyFeeUsdg = Math.min(sixHourRate, oneHourRate * 0.5 + sixHourRate * 0.5)
      const coverageFloor = Math.min(metrics['1h'].volumeCoveragePct, metrics['6h'].volumeCoveragePct) / 100
      const score = stableHourlyFeeUsdg * (0.75 + 0.25 * coverageFloor)
      candidates.push({
        tickLower,
        tickUpper,
        priceLowUsdg,
        priceHighUsdg,
        priceWidthPct: (priceHighUsdg / priceLowUsdg - 1) * 100,
        rangePositionPct: rangePositionBps / 100,
        modeledLiquidity: modeled.liquidity,
        score,
        stableHourlyFeeUsdg,
        metrics,
      })
    }
  }
  candidates.sort((left, right) => right.score - left.score)
  const recommendation = candidates[0] || null
  const sixHourBins = sixHours.bins
  const topVolumeBins = [...sixHourBins]
    .filter((bin) => Number(bin.volumeUsdg) > 0)
    .sort((left, right) => Number(right.volumeUsdg) - Number(left.volumeUsdg))
    .slice(0, 8)
    .map((bin) => ({
      tickLower: bin.tickLower,
      tickUpper: bin.tickUpper,
      priceLowUsdg: bin.priceLowUsdg,
      priceHighUsdg: bin.priceHighUsdg,
      volumeUsdg: Number(bin.volumeUsdg),
      marketLiquidity: bin.marketLiquidity,
    }))
  return {
    method: 'contiguous tick search using 1h/6h path-allocated volume and current per-tick market-liquidity share',
    capitalUsdg,
    constraints: {
      minSpanTicks: minimumSteps * tickSpacing,
      maxSpanTicks: maximumSteps * tickSpacing,
      minimumRangePositionPct: minimumRangePositionBps / 100,
      maximumRangePositionPct: maximumRangePositionBps / 100,
    },
    hotBand6hUsdg: {
      p10: weightedPriceQuantile(sixHourBins, 0.1),
      p50: weightedPriceQuantile(sixHourBins, 0.5),
      p90: weightedPriceQuantile(sixHourBins, 0.9),
    },
    topVolumeBins6h: topVolumeBins,
    recommendation,
    alternatives: candidates.slice(1, 5),
  }
}

export function feeVelocity({ estimatedFeeUsdg, capitalUsdg, fromTime, toTime }) {
  const durationSeconds = Math.max(1, (Date.parse(toTime) - Date.parse(fromTime)) / 1_000)
  const hourlyFeeUsdg = (estimatedFeeUsdg / durationSeconds) * 3_600
  const dailyRatePct = capitalUsdg > 0 ? (((estimatedFeeUsdg / capitalUsdg) * 86_400) / durationSeconds) * 100 : 0
  return {
    durationSeconds,
    hourlyFeeUsdg,
    dailyRatePct,
    annualizedGrossPct: dailyRatePct * 365,
  }
}

export function evaluateComparisonDecision({
  baseRow,
  candidateRows,
  confirmationWindows,
  minimumLeadPct,
  maximumBreakEvenHours,
  testFraction,
  migrationCostUsdg,
}) {
  const candidates = candidateRows.map((row) => {
    const gates = confirmationWindows.map((id) => {
      const metric = row.windows[id]
      const baseline = baseRow.windows[id]
      const leadPct = metric?.relativeLeadPct ?? null
      const coverageComplete = Boolean(
        metric && baseline && !metric.partialBeforeAnchor && !baseline.partialBeforeAnchor,
      )
      return {
        id,
        label: metric?.label || id,
        coverageComplete,
        leadPct,
        pass: coverageComplete && leadPct != null && leadPct >= minimumLeadPct,
      }
    })
    const incrementalRates = confirmationWindows.map((id) => {
      const metric = row.windows[id]
      const baseline = baseRow.windows[id]
      return metric && baseline ? (metric.hourlyFeeUsdg - baseline.hourlyFeeUsdg) * testFraction : -Infinity
    })
    const conservativeIncrementalHourlyUsdg = Math.min(...incrementalRates)
    const breakEvenHours =
      migrationCostUsdg != null && conservativeIncrementalHourlyUsdg > 0
        ? migrationCostUsdg / conservativeIncrementalHourlyUsdg
        : null
    return {
      poolId: row.poolId,
      id: row.id,
      label: `${row.label} ${row.feeLabel}`,
      gates,
      conservativeIncrementalHourlyUsdg,
      breakEvenHours,
      costPass: breakEvenHours != null && breakEvenHours <= maximumBreakEvenHours,
      allEvidenceReady: gates.every((gate) => gate.coverageComplete),
      allLeadGatesPass: gates.every((gate) => gate.pass),
    }
  })
  candidates.sort((left, right) => {
    const leftScore = Math.min(...left.gates.map((gate) => gate.leadPct ?? -Infinity))
    const rightScore = Math.min(...right.gates.map((gate) => gate.leadPct ?? -Infinity))
    return rightScore - leftScore
  })
  const best = candidates[0] || null
  const signal = !best?.allEvidenceReady
    ? 'BUILDING_EVIDENCE'
    : best.allLeadGatesPass && best.costPass
      ? 'TEST_ELIGIBLE'
      : 'HOLD_SPY'
  return { signal, bestCandidate: best, candidates }
}

function wrappingSub(left, right) {
  return (left - right + UINT256_MODULUS) % UINT256_MODULUS
}

function amount(value, decimals = 18) {
  return Number(formatUnits(BigInt(value), decimals))
}

function positionStateId(positionManager, tokenId, tickLower, tickUpper) {
  const salt = padHex(toHex(BigInt(tokenId)), { size: 32 })
  return keccak256(
    encodePacked(['address', 'int24', 'int24', 'bytes32'], [positionManager, tickLower, tickUpper, salt]),
  )
}

function mapWithConcurrency(values, concurrency, fn) {
  const result = new Array(values.length)
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      result[index] = await fn(values[index], index)
    }
  }
  return Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker)).then(() => result)
}

class Store {
  constructor(filePath, identity) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pair_swaps (
        transaction_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        transaction_index INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        amount0 TEXT NOT NULL,
        amount1 TEXT NOT NULL,
        sqrt_price TEXT NOT NULL,
        tick INTEGER NOT NULL,
        fee INTEGER NOT NULL,
        PRIMARY KEY (transaction_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS pair_swaps_block_idx
        ON pair_swaps(block_number, transaction_index, log_index);
      CREATE TABLE IF NOT EXISTS comparison_swaps (
        pool_id TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        transaction_index INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        amount0 TEXT NOT NULL,
        amount1 TEXT NOT NULL,
        sqrt_price TEXT NOT NULL,
        tick INTEGER NOT NULL,
        fee INTEGER NOT NULL,
        PRIMARY KEY (pool_id, transaction_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS comparison_swaps_pool_block_idx
        ON comparison_swaps(pool_id, block_number, transaction_index, log_index);
      CREATE TABLE IF NOT EXISTS spy_marks (
        transaction_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        transaction_index INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        sqrt_price TEXT NOT NULL,
        tick INTEGER NOT NULL,
        spy_usdg REAL NOT NULL,
        PRIMARY KEY (transaction_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS spy_marks_block_idx
        ON spy_marks(block_number, transaction_index, log_index);
      CREATE TABLE IF NOT EXISTS blocks (
        block_number INTEGER PRIMARY KEY,
        block_hash TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `)
    const storedIdentity = this.getMeta('identity')
    if (storedIdentity && storedIdentity !== identity) {
      throw new Error('面板数据库身份与当前 pool/anchor 不一致；请使用新的数据库路径')
    }
    if (!storedIdentity) this.setMeta('identity', identity)
    this.insertPair = this.db.prepare(`
      INSERT OR REPLACE INTO pair_swaps
      (transaction_hash, log_index, transaction_index, block_number, block_hash, amount0, amount1, sqrt_price, tick, fee)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.insertMark = this.db.prepare(`
      INSERT OR REPLACE INTO spy_marks
      (transaction_hash, log_index, transaction_index, block_number, block_hash, sqrt_price, tick, spy_usdg)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.insertComparison = this.db.prepare(`
      INSERT OR REPLACE INTO comparison_swaps
      (pool_id, transaction_hash, log_index, transaction_index, block_number, block_hash, amount0, amount1, sqrt_price, tick, fee)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.insertBlock = this.db.prepare(`
      INSERT OR REPLACE INTO blocks (block_number, block_hash, timestamp) VALUES (?, ?, ?)
    `)
  }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
  }

  setMeta(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value))
  }

  cursor(anchorBlock) {
    return BigInt(this.getMeta('cursor_block') ?? anchorBlock - 1n)
  }

  comparisonCursor(poolId, anchorBlock) {
    return BigInt(this.getMeta(`comparison:${poolId}:cursor_block`) ?? anchorBlock - 1n)
  }

  commitChunk({ pairLogs, markLogs, blocks, cursorBlock, cursorHash, markDecimals }) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const log of pairLogs) {
        this.insertPair.run(
          log.transactionHash,
          Number(log.logIndex),
          Number(log.transactionIndex),
          Number(log.blockNumber),
          log.blockHash,
          log.args.amount0.toString(),
          log.args.amount1.toString(),
          log.args.sqrtPriceX96.toString(),
          Number(log.args.tick),
          Number(log.args.fee),
        )
      }
      for (const log of markLogs) {
        this.insertMark.run(
          log.transactionHash,
          Number(log.logIndex),
          Number(log.transactionIndex),
          Number(log.blockNumber),
          log.blockHash,
          log.args.sqrtPriceX96.toString(),
          Number(log.args.tick),
          v3HumanPriceFromSqrt(log.args.sqrtPriceX96, markDecimals.token0, markDecimals.token1),
        )
      }
      for (const block of blocks) {
        this.insertBlock.run(Number(block.number), block.hash, Number(block.timestamp))
      }
      this.setMeta('cursor_block', cursorBlock)
      this.setMeta('cursor_hash', cursorHash)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  rollbackFrom(blockNumber) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM pair_swaps WHERE block_number >= ?').run(Number(blockNumber))
      this.db.prepare('DELETE FROM spy_marks WHERE block_number >= ?').run(Number(blockNumber))
      this.db.prepare('DELETE FROM comparison_swaps WHERE block_number >= ?').run(Number(blockNumber))
      this.db.prepare('DELETE FROM blocks WHERE block_number >= ?').run(Number(blockNumber))
      this.setMeta('cursor_block', blockNumber - 1n)
      this.setMeta('cursor_hash', '')
      this.db
        .prepare(
          `
        UPDATE meta
        SET value = CASE WHEN CAST(value AS INTEGER) > ? THEN ? ELSE value END
        WHERE key LIKE 'comparison:%:cursor_block'
      `,
        )
        .run(Number(blockNumber - 1n), String(blockNumber - 1n))
      this.db.prepare("UPDATE meta SET value = '' WHERE key LIKE 'comparison:%:cursor_hash'").run()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  commitComparisonChunk({ poolId, logs, blocks, cursorBlock, cursorHash }) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const log of logs) {
        this.insertComparison.run(
          poolId,
          log.transactionHash,
          Number(log.logIndex),
          Number(log.transactionIndex),
          Number(log.blockNumber),
          log.blockHash,
          log.args.amount0.toString(),
          log.args.amount1.toString(),
          log.args.sqrtPriceX96.toString(),
          Number(log.args.tick),
          Number(log.args.fee),
        )
      }
      for (const block of blocks) {
        this.insertBlock.run(Number(block.number), block.hash, Number(block.timestamp))
      }
      this.setMeta(`comparison:${poolId}:cursor_block`, cursorBlock)
      this.setMeta(`comparison:${poolId}:cursor_hash`, cursorHash)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  rollbackComparisonFrom(poolId, blockNumber) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('DELETE FROM comparison_swaps WHERE pool_id = ? AND block_number >= ?')
        .run(poolId, Number(blockNumber))
      this.setMeta(`comparison:${poolId}:cursor_block`, blockNumber - 1n)
      this.setMeta(`comparison:${poolId}:cursor_hash`, '')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  pairSwaps() {
    return this.db
      .prepare(
        `
      SELECT p.*, b.timestamp
      FROM pair_swaps p
      JOIN blocks b USING (block_number)
      ORDER BY p.block_number, p.transaction_index, p.log_index
    `,
      )
      .all()
  }

  comparisonSwaps(poolId) {
    return this.db
      .prepare(
        `
      SELECT p.*, b.timestamp
      FROM comparison_swaps p
      JOIN blocks b USING (block_number)
      WHERE p.pool_id = ?
      ORDER BY p.block_number, p.transaction_index, p.log_index
    `,
      )
      .all(poolId)
  }

  marks() {
    return this.db
      .prepare(
        `
      SELECT m.*, b.timestamp
      FROM spy_marks m
      JOIN blocks b USING (block_number)
      ORDER BY m.block_number, m.transaction_index, m.log_index
    `,
      )
      .all()
  }

  counts() {
    return {
      pairSwaps: Number(this.db.prepare('SELECT COUNT(*) AS count FROM pair_swaps').get().count),
      spyMarks: Number(this.db.prepare('SELECT COUNT(*) AS count FROM spy_marks').get().count),
      comparisonSwaps: Number(this.db.prepare('SELECT COUNT(*) AS count FROM comparison_swaps').get().count),
    }
  }

  close() {
    this.db.close()
  }
}

async function fetchBlockBatch(rpcUrl, blockNumbers, gate = (operation) => operation()) {
  const unique = [...new Set(blockNumbers.map(String))].map(BigInt)
  const blocks = []
  for (let offset = 0; offset < unique.length; offset += BLOCK_BATCH) {
    const group = unique.slice(offset, offset + BLOCK_BATCH)
    const body = group.map((blockNumber, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: 'eth_getBlockByNumber',
      params: [toHex(blockNumber), false],
    }))
    let response
    let lastError
    for (let attempt = 0; attempt < BLOCK_FETCH_ATTEMPTS; attempt += 1) {
      try {
        response = await gate(() =>
          fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          }),
        )
      } catch (error) {
        lastError = error
        if (attempt === BLOCK_FETCH_ATTEMPTS - 1) throw error
        const waitMs = Math.min(15_000, 1_000 * 2 ** attempt)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        continue
      }
      if (response.ok) break
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`批量区块读取失败：HTTP ${response.status}`)
      }
      if (attempt === BLOCK_FETCH_ATTEMPTS - 1) {
        throw new Error(`批量区块读取失败：HTTP ${response.status}`)
      }
      const retryAfter = Number(response.headers.get('retry-after'))
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(30_000, retryAfter * 1_000)
          : Math.min(15_000, 1_000 * 2 ** attempt)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
    if (!response) throw lastError || new Error('批量区块读取没有返回响应')
    const payload = await response.json()
    if (!Array.isArray(payload)) throw new Error('RPC 不支持批量区块读取')
    const byId = new Map(payload.map((item) => [Number(item.id), item]))
    for (let index = 0; index < group.length; index += 1) {
      const item = byId.get(index + 1)
      if (item?.error || !item?.result) throw new Error(`区块 ${group[index]} 读取失败`)
      blocks.push({
        number: BigInt(item.result.number),
        hash: item.result.hash,
        timestamp: BigInt(item.result.timestamp),
      })
    }
    if (offset + BLOCK_BATCH < unique.length) {
      await new Promise((resolve) => setTimeout(resolve, BLOCK_BATCH_PAUSE_MS))
    }
  }
  return blocks
}

function logOrder(log) {
  return [Number(log.block_number), Number(log.transaction_index), Number(log.log_index)]
}

function orderBeforeOrEqual(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return true
    if (left[index] > right[index]) return false
  }
  return true
}

function appendMarketPoint(points, timestamp, pairUsdg) {
  const numericTime = Number(timestamp)
  if (!Number.isFinite(numericTime) || !Number.isFinite(pairUsdg) || pairUsdg <= 0) return
  const at = new Date(numericTime * 1_000).toISOString()
  const previous = points.at(-1)
  if (previous?.at === at) {
    previous.pairUsdg = pairUsdg
    return
  }
  points.push({ at, pairUsdg })
}

export function pairSpyMarketHistory({
  pairSwaps = [],
  marks = [],
  anchorTime,
  anchorPairSqrt,
  anchorSpyUsdg,
  toTime,
}) {
  let currentTick = tickAtSqrt(Number(anchorPairSqrt))
  let currentSpyUsdg = Number(anchorSpyUsdg)
  const points = []
  appendMarketPoint(points, anchorTime, pairPriceAtTick(currentSpyUsdg, currentTick))
  const events = [
    ...pairSwaps.map((event) => ({ kind: 'pair', event })),
    ...marks.map((event) => ({ kind: 'spy', event })),
  ].sort((left, right) => {
    const leftOrder = logOrder(left.event)
    const rightOrder = logOrder(right.event)
    for (let index = 0; index < leftOrder.length; index += 1) {
      if (leftOrder[index] !== rightOrder[index]) return leftOrder[index] - rightOrder[index]
    }
    return left.kind === right.kind ? 0 : left.kind === 'spy' ? -1 : 1
  })
  for (const { kind, event } of events) {
    if (kind === 'pair') currentTick = Number(event.tick)
    else currentSpyUsdg = Number(event.spy_usdg)
    appendMarketPoint(points, event.timestamp, pairPriceAtTick(currentSpyUsdg, currentTick))
  }
  return {
    fromTime: Number.isFinite(Number(anchorTime)) ? new Date(Number(anchorTime) * 1_000).toISOString() : null,
    toTime: Number.isFinite(Number(toTime)) ? new Date(Number(toTime) * 1_000).toISOString() : null,
    points,
    source: 'canonical_pair_swaps_plus_spy_usdg_marks',
  }
}

export function directPairMarketHistory({
  swaps = [],
  anchorTime,
  anchorSqrt,
  toTime,
  token0Decimals = 6,
  token1Decimals = 18,
}) {
  let currentTick = tickAtSqrt(Number(anchorSqrt))
  const points = []
  appendMarketPoint(points, anchorTime, directPairPriceAtTick(currentTick, token0Decimals, token1Decimals))
  for (const event of swaps) {
    currentTick = Number(event.tick)
    appendMarketPoint(points, event.timestamp, directPairPriceAtTick(currentTick, token0Decimals, token1Decimals))
  }
  return {
    fromTime: Number.isFinite(Number(anchorTime)) ? new Date(Number(anchorTime) * 1_000).toISOString() : null,
    toTime: Number.isFinite(Number(toTime)) ? new Date(Number(toTime) * 1_000).toISOString() : null,
    points,
    source: 'canonical_direct_pool_swaps',
  }
}

export function allocateSwapToBins(log, previousSqrt, tickSpacing, spyUsdg, volumeByTick) {
  const endingSqrt = Number(log.sqrt_price ?? log.args?.sqrtPriceX96)
  const amount0 = Number(log.amount0 ?? log.args?.amount0) / 1e18
  const amount1 = Number(log.amount1 ?? log.args?.amount1) / 1e18
  const inputToken = amount0 > 0 ? 'SPY' : amount1 > 0 ? 'PAIR' : null
  const inputAmount = Math.max(amount0, amount1)
  if (!inputToken || inputAmount <= 0) return endingSqrt

  const lowSqrt = Math.min(previousSqrt, endingSqrt)
  const highSqrt = Math.max(previousSqrt, endingSqrt)
  const lowTick = tickAtSqrt(lowSqrt)
  const highTick = tickAtSqrt(highSqrt)
  const boundarySqrts = []
  for (let tick = (floorDiv(lowTick, tickSpacing) + 1) * tickSpacing; tick < highTick; tick += tickSpacing)
    boundarySqrts.push(sqrtAtTick(tick))

  const points = [previousSqrt, ...boundarySqrts, endingSqrt].sort((left, right) =>
    previousSqrt < endingSqrt ? left - right : right - left,
  )
  const slices = []
  let totalWeight = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index]
    const right = points[index + 1]
    const midpointTick = tickAtSqrt((left + right) / 2)
    const weight = inputToken === 'PAIR' ? Math.abs(right - left) : Math.abs(1 / right - 1 / left)
    totalWeight += weight
    slices.push({ midpointTick, weight })
  }
  if (!slices.length || totalWeight === 0) {
    slices.push({ midpointTick: Number(log.tick ?? log.args?.tick), weight: 1 })
    totalWeight = 1
  }

  for (const slice of slices) {
    const allocatedInput = (inputAmount * slice.weight) / totalWeight
    const tickLower = floorDiv(slice.midpointTick, tickSpacing) * tickSpacing
    const pairUsdg = pairPriceAtTick(spyUsdg, slice.midpointTick)
    const volumeUsdg = allocatedInput * (inputToken === 'SPY' ? spyUsdg : pairUsdg)
    const grossFeeUsdg = (volumeUsdg * Number(log.fee ?? log.args?.fee)) / 1_000_000
    const current = volumeByTick.get(tickLower) || {
      volumeUsdg: 0,
      grossFeeUsdg: 0,
      swapSlices: 0,
      spyInput: 0,
      pairInput: 0,
    }
    current.volumeUsdg += volumeUsdg
    current.grossFeeUsdg += grossFeeUsdg
    current.swapSlices += 1
    if (inputToken === 'SPY') current.spyInput += allocatedInput
    else current.pairInput += allocatedInput
    volumeByTick.set(tickLower, current)
  }
  return endingSqrt
}

export function allocateDirectSwapToBins(
  log,
  previousSqrt,
  tickSpacing,
  volumeByTick,
  token0Decimals = 6,
  token1Decimals = 18,
) {
  const endingSqrt = Number(log.sqrt_price ?? log.args?.sqrtPriceX96)
  const amount0 = Number(log.amount0 ?? log.args?.amount0) / Math.pow(10, token0Decimals)
  const amount1 = Number(log.amount1 ?? log.args?.amount1) / Math.pow(10, token1Decimals)
  const inputToken = amount0 > 0 ? 'USDG' : amount1 > 0 ? 'PAIR' : null
  const inputAmount = Math.max(amount0, amount1)
  if (!inputToken || inputAmount <= 0) return endingSqrt

  const lowSqrt = Math.min(previousSqrt, endingSqrt)
  const highSqrt = Math.max(previousSqrt, endingSqrt)
  const lowTick = tickAtSqrt(lowSqrt)
  const highTick = tickAtSqrt(highSqrt)
  const boundarySqrts = []
  for (let tick = (floorDiv(lowTick, tickSpacing) + 1) * tickSpacing; tick < highTick; tick += tickSpacing)
    boundarySqrts.push(sqrtAtTick(tick))

  const points = [previousSqrt, ...boundarySqrts, endingSqrt].sort((left, right) =>
    previousSqrt < endingSqrt ? left - right : right - left,
  )
  const slices = []
  let totalWeight = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index]
    const right = points[index + 1]
    const midpointTick = tickAtSqrt((left + right) / 2)
    const weight = inputToken === 'PAIR' ? Math.abs(right - left) : Math.abs(1 / right - 1 / left)
    totalWeight += weight
    slices.push({ midpointTick, weight })
  }
  if (!slices.length || totalWeight === 0) {
    slices.push({ midpointTick: Number(log.tick ?? log.args?.tick), weight: 1 })
    totalWeight = 1
  }

  for (const slice of slices) {
    const allocatedInput = (inputAmount * slice.weight) / totalWeight
    const tickLower = floorDiv(slice.midpointTick, tickSpacing) * tickSpacing
    const pairUsdg = directPairPriceAtTick(slice.midpointTick, token0Decimals, token1Decimals)
    const volumeUsdg = allocatedInput * (inputToken === 'USDG' ? 1 : pairUsdg)
    const grossFeeUsdg = (volumeUsdg * Number(log.fee ?? log.args?.fee)) / 1_000_000
    const current = volumeByTick.get(tickLower) || {
      volumeUsdg: 0,
      grossFeeUsdg: 0,
      swapSlices: 0,
      usdgInput: 0,
      pairInput: 0,
    }
    current.volumeUsdg += volumeUsdg
    current.grossFeeUsdg += grossFeeUsdg
    current.swapSlices += 1
    if (inputToken === 'USDG') current.usdgInput += allocatedInput
    else current.pairInput += allocatedInput
    volumeByTick.set(tickLower, current)
  }
  return endingSqrt
}

export class PairDashboardCollector {
  constructor({
    configPath,
    databasePath,
    rpcUrl,
    confirmations,
    rpcMinimumIntervalMs,
    rpcBatchSize,
    rpcBatchWaitMs,
    rpcFetchFn = fetch,
    onProgress = () => {},
  }) {
    this.configPath = configPath
    this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    this.rpcUrl = rpcUrl || this.config.chain.defaultRpcUrl
    this.confirmations = BigInt(confirmations ?? this.config.chain.confirmations ?? 3)
    this.rpcMinimumIntervalMs = finiteSetting(rpcMinimumIntervalMs ?? this.config.chain.rpcMinimumIntervalMs, 150, 0)
    this.rpcBatchSize = finiteSetting(rpcBatchSize ?? this.config.chain.rpcBatchSize, 20, 1, true)
    this.rpcBatchWaitMs = finiteSetting(rpcBatchWaitMs ?? this.config.chain.rpcBatchWaitMs, 25, 0)
    this.rpcFetchFn = rpcFetchFn
    this.rpcGate = createRpcRequestGate({ minimumIntervalMs: this.rpcMinimumIntervalMs })
    this.onProgress = onProgress

    const chain = defineChain({
      id: this.config.chain.id,
      name: this.config.chain.name,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [this.rpcUrl] } },
    })
    this.client = createPublicClient({
      chain,
      transport: http(undefined, {
        batch: { batchSize: this.rpcBatchSize, wait: this.rpcBatchWaitMs },
        fetchFn: (input, init) => this.rpcGate(() => this.rpcFetchFn(input, init)),
        timeout: 30_000,
        retryCount: 3,
      }),
    })
    this.wallet = getAddress(this.config.wallet)
    this.poolManager = getAddress(this.config.contracts.poolManager)
    this.stateView = getAddress(this.config.contracts.stateView)
    this.positionManager = getAddress(this.config.contracts.positionManager)
    this.v3Quoter = getAddress(this.config.contracts.v3Quoter)
    this.spyUsdgV3Pool = getAddress(this.config.contracts.spyUsdgV3Pool)
    this.weth = getAddress(this.config.tokens.weth.address)
    this.usdg = getAddress(this.config.tokens.usdg.address)
    this.poolId = this.config.pool.poolId
    this.comparisonPools = (this.config.comparison?.pools || []).map((pool) => ({ ...pool }))
    this.anchorBlock = BigInt(this.config.history.anchorBlock)
    this.identity = `${this.config.chain.id}:${this.poolId}:${this.anchorBlock}`
    this.store = new Store(databasePath, this.identity)
    const manifestName = this.config.portfolio?.manifest || 'lp-portfolio-ledger.json'
    this.portfolioManifestPath = path.resolve(path.dirname(configPath), manifestName)
    this.portfolioManifest = loadPortfolioManifest(this.portfolioManifestPath)
    this.pairPositionConfigs = currentPairPositionConfigs(this.config.positions, this.portfolioManifest)
  }

  async getLogs(address, event, fromBlock, toBlock, args) {
    if (fromBlock > toBlock) return []
    return this.rpcRead(`日志区块 ${fromBlock}–${toBlock}`, () =>
      this.client.getLogs({ address, event, args, fromBlock, toBlock }),
    )
  }

  async rpcRead(label, operation) {
    let lastError
    for (let attempt = 0; attempt < RPC_READ_ATTEMPTS; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (attempt === RPC_READ_ATTEMPTS - 1) break
        const waitMs = Math.min(8_000, 750 * 2 ** attempt)
        this.onProgress({
          phase: 'rpc-backoff',
          message: `${label} 暂时失败，${(waitMs / 1_000).toFixed(2)} 秒后重试`,
          attempt: attempt + 1,
          attempts: RPC_READ_ATTEMPTS,
          waitMs,
        })
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
    }
    throw lastError
  }

  async getBlock(parameters) {
    return this.rpcRead('区块读取', () => this.client.getBlock(parameters))
  }

  async findPreviousLog(address, event, atBlock, args) {
    for (let end = atBlock; end >= 0n; end -= LOG_CHUNK) {
      const start = end >= LOG_CHUNK ? end - LOG_CHUNK + 1n : 0n
      const logs = await this.getLogs(address, event, start, end, args)
      if (logs.length) return logs.at(-1)
      if (start === 0n) break
    }
    throw new Error(`区块 ${atBlock} 之前没有找到所需 Swap 事件`)
  }

  async ensureAnchors() {
    if (!this.store.getMeta('anchor_pair_sqrt')) {
      this.onProgress({ phase: 'bootstrap', message: '读取周期起点之前的 PAIR/SPY 价格' })
      const log = await this.findPreviousLog(this.poolManager, V4_SWAP_EVENT, this.anchorBlock - 1n, {
        id: this.poolId,
      })
      this.store.setMeta('anchor_pair_sqrt', log.args.sqrtPriceX96)
    }
    if (!this.store.getMeta('anchor_spy_usdg')) {
      this.onProgress({ phase: 'bootstrap', message: '读取周期起点之前的 SPY/USDG 价格' })
      const log = await this.findPreviousLog(this.spyUsdgV3Pool, V3_SWAP_EVENT, this.anchorBlock - 1n)
      this.store.setMeta(
        'anchor_spy_usdg',
        v3HumanPriceFromSqrt(log.args.sqrtPriceX96, this.config.tokens.spy.decimals, this.config.tokens.usdg.decimals),
      )
    }
    if (!this.store.getMeta('anchor_time')) {
      const block = await this.getBlock({ blockNumber: this.anchorBlock })
      this.store.setMeta('anchor_time', block.timestamp)
    }
    for (const pool of this.comparisonPools) {
      const key = `comparison:${pool.poolId}:anchor_sqrt`
      if (this.store.getMeta(key)) continue
      this.onProgress({ phase: 'bootstrap', message: `读取 ${pool.label} ${pool.feeLabel} 对照起点价格` })
      const log = await this.findPreviousLog(this.poolManager, V4_SWAP_EVENT, this.anchorBlock - 1n, {
        id: pool.poolId,
      })
      this.store.setMeta(key, log.args.sqrtPriceX96)
    }
  }

  async verifyComparisonCursor(pool) {
    const cursor = this.store.comparisonCursor(pool.poolId, this.anchorBlock)
    const storedHash = this.store.getMeta(`comparison:${pool.poolId}:cursor_hash`)
    if (cursor < this.anchorBlock || !storedHash) return cursor
    const block = await this.getBlock({ blockNumber: cursor })
    if (block.hash === storedHash) return cursor
    const rollback = cursor - 128n > this.anchorBlock ? cursor - 128n : this.anchorBlock
    this.onProgress({ phase: 'reorg', message: `${pool.label} ${pool.feeLabel} 检测到区块重组，回滚到 ${rollback}` })
    this.store.rollbackComparisonFrom(pool.poolId, rollback)
    return rollback - 1n
  }

  async syncComparisonPoolTo(pool, safeBlock) {
    let cursor = await this.verifyComparisonCursor(pool)
    if (cursor >= safeBlock) return
    for (let start = cursor + 1n; start <= safeBlock; start += LOG_CHUNK) {
      const end = start + LOG_CHUNK - 1n > safeBlock ? safeBlock : start + LOG_CHUNK - 1n
      this.onProgress({
        phase: 'sync-comparison',
        message: `${pool.label} ${pool.feeLabel} 增量同步区块 ${start}–${end}`,
        fromBlock: start.toString(),
        toBlock: end.toString(),
        targetBlock: safeBlock.toString(),
      })
      const [logs, endBlock] = await Promise.all([
        this.getLogs(this.poolManager, V4_SWAP_EVENT, start, end, { id: pool.poolId }),
        this.getBlock({ blockNumber: end }),
      ])
      const eventBlocks = logs.map((log) => log.blockNumber)
      const blocks = eventBlocks.length ? await fetchBlockBatch(this.rpcUrl, eventBlocks, this.rpcGate) : []
      this.store.commitComparisonChunk({
        poolId: pool.poolId,
        logs,
        blocks,
        cursorBlock: end,
        cursorHash: endBlock.hash,
      })
      cursor = end
      if (cursor < safeBlock) await new Promise((resolve) => setTimeout(resolve, SYNC_CHUNK_PAUSE_MS))
    }
  }

  async verifyCursor() {
    const cursor = this.store.cursor(this.anchorBlock)
    const storedHash = this.store.getMeta('cursor_hash')
    if (cursor < this.anchorBlock || !storedHash) return cursor
    const block = await this.getBlock({ blockNumber: cursor })
    if (block.hash === storedHash) return cursor
    const rollback = cursor - 128n > this.anchorBlock ? cursor - 128n : this.anchorBlock
    this.onProgress({ phase: 'reorg', message: `检测到区块重组，回滚到 ${rollback}` })
    this.store.rollbackFrom(rollback)
    return rollback - 1n
  }

  async syncTo(safeBlock) {
    await this.ensureAnchors()
    let cursor = await this.verifyCursor()
    if (cursor >= safeBlock) return

    for (let start = cursor + 1n; start <= safeBlock; start += LOG_CHUNK) {
      const end = start + LOG_CHUNK - 1n > safeBlock ? safeBlock : start + LOG_CHUNK - 1n
      this.onProgress({
        phase: 'sync',
        message: `增量同步区块 ${start}–${end}`,
        fromBlock: start.toString(),
        toBlock: end.toString(),
        targetBlock: safeBlock.toString(),
      })
      const [pairLogs, markLogs, endBlock] = await Promise.all([
        this.getLogs(this.poolManager, V4_SWAP_EVENT, start, end, { id: this.poolId }),
        this.getLogs(this.spyUsdgV3Pool, V3_SWAP_EVENT, start, end),
        this.getBlock({ blockNumber: end }),
      ])
      const eventBlocks = pairLogs.map((log) => log.blockNumber)
      const blocks = eventBlocks.length ? await fetchBlockBatch(this.rpcUrl, eventBlocks, this.rpcGate) : []
      this.store.commitChunk({
        pairLogs,
        markLogs,
        blocks,
        cursorBlock: end,
        cursorHash: endBlock.hash,
        markDecimals: {
          token0: this.config.tokens.spy.decimals,
          token1: this.config.tokens.usdg.decimals,
        },
      })
      cursor = end
      if (cursor < safeBlock) await new Promise((resolve) => setTimeout(resolve, SYNC_CHUNK_PAUSE_MS))
    }
  }

  async getInitializedTicks(poolId, tickSpacing, minTick, maxTick, blockNumber) {
    const minCompressed = floorDiv(minTick, tickSpacing)
    const maxCompressed = floorDiv(maxTick, tickSpacing)
    const minWord = floorDiv(minCompressed, 256)
    const maxWord = floorDiv(maxCompressed, 256)
    const words = []
    for (let word = minWord; word <= maxWord; word += 1) words.push(word)

    const bitmaps = await mapWithConcurrency(words, 4, async (word) => ({
      word,
      bitmap: await this.client.readContract({
        address: this.stateView,
        abi: STATE_VIEW_ABI,
        functionName: 'getTickBitmap',
        args: [poolId, word],
        blockNumber,
      }),
    }))
    const ticks = []
    for (const { word, bitmap } of bitmaps) {
      for (let bit = 0; bit < 256; bit += 1) {
        if ((bitmap & (1n << BigInt(bit))) === 0n) continue
        const tick = (word * 256 + bit) * tickSpacing
        if (tick >= minTick && tick <= maxTick) ticks.push(tick)
      }
    }
    return mapWithConcurrency(ticks, 8, async (tick) => {
      const [gross, net] = await this.client.readContract({
        address: this.stateView,
        abi: STATE_VIEW_ABI,
        functionName: 'getTickLiquidity',
        args: [poolId, tick],
        blockNumber,
      })
      return { tick, gross, net }
    })
  }

  async readPosition(position, sqrtPriceX96, spyUsdg, pairUsdg, currentTick, blockNumber) {
    const tokenId = BigInt(position.tokenId)
    let owner
    try {
      owner = await this.client.readContract({
        address: this.positionManager,
        abi: POSITION_MANAGER_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
        blockNumber,
      })
    } catch {
      return { ...position, status: 'missing', inRange: false, dataQuality: 'ownerOf_failed' }
    }
    const [managerLiquidity, accrued] = await Promise.all([
      this.client.readContract({
        address: this.positionManager,
        abi: POSITION_MANAGER_ABI,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
        blockNumber,
      }),
      this.getAccruedFees(position, blockNumber),
    ])
    const owned = owner.toLowerCase() === this.wallet.toLowerCase()
    const active = owned && managerLiquidity > 0n
    const principal = active
      ? positionTokenAmounts(managerLiquidity, sqrtPriceX96, position.tickLower, position.tickUpper)
      : { amount0: 0n, amount1: 0n }
    const principalSpy = amount(principal.amount0)
    const principalPair = amount(principal.amount1)
    const feeSpy = amount(accrued.spyWei)
    const feePair = amount(accrued.pairWei)
    const low = Math.min(pairPriceAtTick(spyUsdg, position.tickLower), pairPriceAtTick(spyUsdg, position.tickUpper))
    const high = Math.max(pairPriceAtTick(spyUsdg, position.tickLower), pairPriceAtTick(spyUsdg, position.tickUpper))
    return {
      ...position,
      owner,
      status: active ? 'active' : owned ? 'empty' : 'owner_mismatch',
      liquidity: managerLiquidity.toString(),
      stateViewLiquidity: accrued.liquidity.toString(),
      liquidityMatches: managerLiquidity === accrued.liquidity,
      inRange: active && currentTick >= position.tickLower && currentTick < position.tickUpper,
      priceLowUsdg: low,
      priceHighUsdg: high,
      principal: {
        spy: principalSpy,
        pair: principalPair,
        usdg: principalSpy * spyUsdg + principalPair * pairUsdg,
      },
      accruedFees: {
        spy: feeSpy,
        pair: feePair,
        usdg: feeSpy * spyUsdg + feePair * pairUsdg,
      },
      dataQuality: managerLiquidity === accrued.liquidity ? 'verified' : 'liquidity_mismatch',
    }
  }

  async readDirectPosition(pool, position, state, blockNumber) {
    const tokenId = BigInt(position.tokenId)
    const [slot0] = state
    const currentTick = Number(slot0[1])
    let owner
    try {
      owner = await this.client.readContract({
        address: this.positionManager,
        abi: POSITION_MANAGER_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
        blockNumber,
      })
    } catch {
      return {
        ...position,
        poolId: pool.poolId,
        poolLabel: `${pool.label} ${pool.feeLabel}`,
        poolKind: 'direct',
        status: 'missing',
        inRange: false,
        dataQuality: 'ownerOf_failed',
      }
    }
    const [managerLiquidity, accrued] = await Promise.all([
      this.client.readContract({
        address: this.positionManager,
        abi: POSITION_MANAGER_ABI,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
        blockNumber,
      }),
      this.getAccruedFeesForPool(pool.poolId, position, blockNumber),
    ])
    const owned = owner.toLowerCase() === this.wallet.toLowerCase()
    const active = owned && managerLiquidity > 0n
    const principal = active
      ? positionTokenAmounts(managerLiquidity, slot0[0], position.tickLower, position.tickUpper)
      : { amount0: 0n, amount1: 0n }
    const principalUsdg = amount(principal.amount0, this.config.tokens.usdg.decimals)
    const principalPair = amount(principal.amount1, this.config.tokens.pair.decimals)
    const feeUsdg = amount(accrued.amount0, this.config.tokens.usdg.decimals)
    const feePair = amount(accrued.amount1, this.config.tokens.pair.decimals)
    const pairUsdg = directPairPriceAtTick(
      currentTick,
      this.config.tokens.usdg.decimals,
      this.config.tokens.pair.decimals,
    )
    return {
      ...position,
      poolId: pool.poolId,
      poolLabel: `${pool.label} ${pool.feeLabel}`,
      poolKind: 'direct',
      owner,
      status: active ? 'active' : owned ? 'empty' : 'owner_mismatch',
      liquidity: managerLiquidity.toString(),
      stateViewLiquidity: accrued.liquidity.toString(),
      liquidityMatches: managerLiquidity === accrued.liquidity,
      inRange: active && currentTick >= position.tickLower && currentTick < position.tickUpper,
      priceLowUsdg: directPairPriceAtTick(
        position.tickUpper,
        this.config.tokens.usdg.decimals,
        this.config.tokens.pair.decimals,
      ),
      priceHighUsdg: directPairPriceAtTick(
        position.tickLower,
        this.config.tokens.usdg.decimals,
        this.config.tokens.pair.decimals,
      ),
      principal: {
        usdgToken: principalUsdg,
        pair: principalPair,
        usdg: principalUsdg + principalPair * pairUsdg,
      },
      accruedFees: {
        usdgToken: feeUsdg,
        pair: feePair,
        usdg: feeUsdg + feePair * pairUsdg,
      },
      dataQuality: managerLiquidity === accrued.liquidity ? 'verified' : 'liquidity_mismatch',
    }
  }

  async readPortfolioChainStates(detailedPositions, blockNumber) {
    if (!this.portfolioManifest) return []
    const detailById = new Map(detailedPositions.map((position) => [String(position.tokenId), position]))
    return mapWithConcurrency(this.portfolioManifest.positions, 4, async (position) => {
      const detailed = detailById.get(String(position.tokenId))
      if (detailed) {
        return {
          tokenId: String(position.tokenId),
          owner: detailed.owner || null,
          liquidity: detailed.liquidity || '0',
          status: detailed.status,
          dataQuality: detailed.dataQuality,
        }
      }
      try {
        const [owner, liquidity] = await Promise.all([
          this.client.readContract({
            address: this.positionManager,
            abi: POSITION_MANAGER_ABI,
            functionName: 'ownerOf',
            args: [BigInt(position.tokenId)],
            blockNumber,
          }),
          this.client.readContract({
            address: this.positionManager,
            abi: POSITION_MANAGER_ABI,
            functionName: 'getPositionLiquidity',
            args: [BigInt(position.tokenId)],
            blockNumber,
          }),
        ])
        const owned = owner.toLowerCase() === this.wallet.toLowerCase()
        return {
          tokenId: String(position.tokenId),
          owner,
          liquidity: liquidity.toString(),
          status: owned ? (liquidity > 0n ? 'active' : 'empty') : 'owner_mismatch',
          dataQuality: 'verified_same_safe_block',
        }
      } catch (error) {
        return {
          tokenId: String(position.tokenId),
          owner: null,
          liquidity: null,
          status: 'read_failed',
          dataQuality: safePublicError(error),
        }
      }
    })
  }

  async readPortfolioWalletBalances(blockNumber) {
    if (!this.portfolioManifest) return null
    const tokenEntries = [
      ['spy', this.config.tokens.spy],
      ['pair', this.config.tokens.pair],
      ['usdg', this.config.tokens.usdg],
      ['one', this.config.tokens.one],
    ].filter(([, token]) => token?.address)
    const [ethWei, tokenBalances] = await Promise.all([
      this.client.getBalance({ address: this.wallet, blockNumber }),
      mapWithConcurrency(tokenEntries, 4, async ([field, token]) => [
        field,
        amount(
          await this.client.readContract({
            address: getAddress(token.address),
            abi: ERC20_BALANCE_ABI,
            functionName: 'balanceOf',
            args: [this.wallet],
            blockNumber,
          }),
          token.decimals,
        ),
      ]),
    ])
    return {
      eth: amount(ethWei),
      spy: 0,
      pair: 0,
      usdg: 0,
      one: 0,
      ...Object.fromEntries(tokenBalances),
    }
  }

  async readOneUsdg(blockNumber) {
    const pool = this.portfolioManifest?.pools?.find((item) => item.poolKind === 'one-usdg')
    if (!pool) return null
    try {
      const slot0 = await this.client.readContract({
        address: this.stateView,
        abi: STATE_VIEW_ABI,
        functionName: 'getSlot0',
        args: [pool.poolId],
        blockNumber,
      })
      return directPairPriceAtTick(
        Number(slot0[1]),
        this.config.tokens.usdg.decimals,
        this.config.tokens.one?.decimals || 18,
      )
    } catch {
      return null
    }
  }

  buildPortfolioMarketHistories({ safeBlock, pairSwaps, marks }) {
    const anchorTime = Number(this.store.getMeta('anchor_time'))
    const histories = {
      'pair-spy': pairSpyMarketHistory({
        pairSwaps,
        marks,
        anchorTime,
        anchorPairSqrt: this.store.getMeta('anchor_pair_sqrt'),
        anchorSpyUsdg: this.store.getMeta('anchor_spy_usdg'),
        toTime: safeBlock.timestamp,
      }),
    }
    for (const pool of this.comparisonPools) {
      const anchorSqrt = this.store.getMeta(`comparison:${pool.poolId}:anchor_sqrt`)
      if (!anchorSqrt) continue
      histories[pool.poolId] = directPairMarketHistory({
        swaps: this.store.comparisonSwaps(pool.poolId),
        anchorTime,
        anchorSqrt,
        toTime: safeBlock.timestamp,
        token0Decimals: this.config.tokens.usdg.decimals,
        token1Decimals: this.config.tokens.pair.decimals,
      })
    }
    return histories
  }

  async buildPortfolioSnapshot({
    safeBlock,
    positions,
    directPositions,
    spyUsdg,
    pairUsdg,
    ethQuote,
    pairSwaps,
    marks,
  }) {
    if (!this.portfolioManifest) return null
    const detailedPositions = [...positions, ...directPositions]
    const [chainStates, walletBalances, oneUsdg] = await Promise.all([
      this.readPortfolioChainStates(detailedPositions, safeBlock.number),
      this.readPortfolioWalletBalances(safeBlock.number),
      this.readOneUsdg(safeBlock.number),
    ])
    return buildPortfolioView({
      manifest: this.portfolioManifest,
      detailedPositions,
      chainStates,
      prices: {
        spyUsdg,
        pairUsdg,
        ethUsdg: ethQuote?.status === 'verified_quote' ? ethQuote.ethUsdg : null,
        oneUsdg,
      },
      walletBalances,
      marketHistories: this.buildPortfolioMarketHistories({ safeBlock, pairSwaps, marks }),
      safeBlock: {
        number: safeBlock.number,
        time: new Date(Number(safeBlock.timestamp) * 1_000).toISOString(),
      },
    })
  }

  async getAccruedFeesForPool(poolId, position, blockNumber) {
    const id = positionStateId(this.positionManager, position.tokenId, position.tickLower, position.tickUpper)
    const [[liquidity, last0, last1], [inside0, inside1]] = await Promise.all([
      this.client.readContract({
        address: this.stateView,
        abi: STATE_VIEW_ABI,
        functionName: 'getPositionInfo',
        args: [poolId, id],
        blockNumber,
      }),
      this.client.readContract({
        address: this.stateView,
        abi: STATE_VIEW_ABI,
        functionName: 'getFeeGrowthInside',
        args: [poolId, position.tickLower, position.tickUpper],
        blockNumber,
      }),
    ])
    return {
      liquidity,
      amount0: (liquidity * wrappingSub(inside0, last0)) / Q128,
      amount1: (liquidity * wrappingSub(inside1, last1)) / Q128,
    }
  }

  async getAccruedFees(position, blockNumber) {
    const accrued = await this.getAccruedFeesForPool(this.poolId, position, blockNumber)
    return {
      liquidity: accrued.liquidity,
      spyWei: accrued.amount0,
      pairWei: accrued.amount1,
    }
  }

  analyticsForWindow({ id, label, seconds }, pairSwaps, marks, baseBins, safeBlock, currentSpyUsdg) {
    const anchorTime = Number(this.store.getMeta('anchor_time'))
    const requestedFromTime = seconds == null ? anchorTime : Number(safeBlock.timestamp) - seconds
    const effectiveFromTime = Math.max(anchorTime, requestedFromTime)
    let startIndex = pairSwaps.findIndex((swap) => Number(swap.timestamp) >= effectiveFromTime)
    if (startIndex < 0) startIndex = pairSwaps.length
    const selected = pairSwaps.slice(startIndex)
    let previousSqrt =
      startIndex > 0 ? Number(pairSwaps[startIndex - 1].sqrt_price) : Number(this.store.getMeta('anchor_pair_sqrt'))
    let markIndex = 0
    let spyUsdg = Number(this.store.getMeta('anchor_spy_usdg')) || currentSpyUsdg
    const firstOrder = selected.length ? logOrder(selected[0]) : [Number.MAX_SAFE_INTEGER, 0, 0]
    while (markIndex < marks.length && orderBeforeOrEqual(logOrder(marks[markIndex]), firstOrder)) {
      spyUsdg = Number(marks[markIndex].spy_usdg)
      markIndex += 1
    }
    const volumeByTick = new Map()
    for (const swap of selected) {
      const swapOrder = logOrder(swap)
      while (markIndex < marks.length && orderBeforeOrEqual(logOrder(marks[markIndex]), swapOrder)) {
        spyUsdg = Number(marks[markIndex].spy_usdg)
        markIndex += 1
      }
      previousSqrt = allocateSwapToBins(
        swap,
        previousSqrt,
        this.config.pool.tickSpacing,
        spyUsdg || currentSpyUsdg,
        volumeByTick,
      )
    }
    const bins = baseBins.map((bin) => {
      const history = volumeByTick.get(bin.tickLower) || {
        volumeUsdg: 0,
        grossFeeUsdg: 0,
        swapSlices: 0,
        spyInput: 0,
        pairInput: 0,
      }
      const marketNumber = Number(BigInt(bin.marketLiquidity))
      return {
        ...bin,
        ...history,
        feeUsdgPer1e20Liquidity: marketNumber > 0 ? history.grossFeeUsdg / (marketNumber / 1e20) : 0,
      }
    })
    const totals = bins.reduce(
      (result, bin) => ({
        volumeUsdg: result.volumeUsdg + bin.volumeUsdg,
        grossFeeUsdg: result.grossFeeUsdg + bin.grossFeeUsdg,
        spyInput: result.spyInput + bin.spyInput,
        pairInput: result.pairInput + bin.pairInput,
      }),
      { volumeUsdg: 0, grossFeeUsdg: 0, spyInput: 0, pairInput: 0 },
    )
    return {
      id,
      label,
      requestedFromTime: new Date(requestedFromTime * 1_000).toISOString(),
      effectiveFromTime: new Date(effectiveFromTime * 1_000).toISOString(),
      toTime: new Date(Number(safeBlock.timestamp) * 1_000).toISOString(),
      partialBeforeAnchor: requestedFromTime < anchorTime,
      swapEvents: selected.length,
      totals,
      bins,
    }
  }

  directAnalyticsForWindow(pool, { id, label, seconds }, swaps, baseBins, safeBlock) {
    const anchorTime = Number(this.store.getMeta('anchor_time'))
    const requestedFromTime = seconds == null ? anchorTime : Number(safeBlock.timestamp) - seconds
    const effectiveFromTime = Math.max(anchorTime, requestedFromTime)
    let startIndex = swaps.findIndex((swap) => Number(swap.timestamp) >= effectiveFromTime)
    if (startIndex < 0) startIndex = swaps.length
    const selected = swaps.slice(startIndex)
    let previousSqrt =
      startIndex > 0
        ? Number(swaps[startIndex - 1].sqrt_price)
        : Number(this.store.getMeta(`comparison:${pool.poolId}:anchor_sqrt`))
    const volumeByTick = new Map()
    for (const swap of selected) {
      previousSqrt = allocateDirectSwapToBins(
        swap,
        previousSqrt,
        pool.tickSpacing,
        volumeByTick,
        this.config.tokens.usdg.decimals,
        this.config.tokens.pair.decimals,
      )
    }
    const bins = baseBins.map((bin) => {
      const history = volumeByTick.get(bin.tickLower) || {
        volumeUsdg: 0,
        grossFeeUsdg: 0,
        swapSlices: 0,
        usdgInput: 0,
        pairInput: 0,
      }
      return {
        ...bin,
        ...history,
        estimatedOurFeeUsdg: (history.grossFeeUsdg * bin.ourSharePct) / 100,
      }
    })
    const totals = bins.reduce(
      (result, bin) => ({
        volumeUsdg: result.volumeUsdg + bin.volumeUsdg,
        grossFeeUsdg: result.grossFeeUsdg + bin.grossFeeUsdg,
        estimatedOurFeeUsdg: result.estimatedOurFeeUsdg + bin.estimatedOurFeeUsdg,
        usdgInput: result.usdgInput + bin.usdgInput,
        pairInput: result.pairInput + bin.pairInput,
      }),
      { volumeUsdg: 0, grossFeeUsdg: 0, estimatedOurFeeUsdg: 0, usdgInput: 0, pairInput: 0 },
    )
    return {
      id,
      label,
      requestedFromTime: new Date(requestedFromTime * 1_000).toISOString(),
      effectiveFromTime: new Date(effectiveFromTime * 1_000).toISOString(),
      toTime: new Date(Number(safeBlock.timestamp) * 1_000).toISOString(),
      partialBeforeAnchor: requestedFromTime < anchorTime,
      swapEvents: selected.length,
      totals,
      bins,
    }
  }

  async quoteEthUsdg(blockNumber) {
    const model = this.config.comparison.migrationModel
    const amountEth = Number(model.ethQuoteAmount)
    try {
      const amountIn = BigInt(Math.round(amountEth * 1e18))
      const path = encodePacked(['address', 'uint24', 'address'], [this.weth, Number(model.ethUsdgFeePips), this.usdg])
      const { result } = await this.client.simulateContract({
        address: this.v3Quoter,
        abi: V3_QUOTER_ABI,
        functionName: 'quoteExactInput',
        args: [path, amountIn],
        account: this.wallet,
        blockNumber,
      })
      const outputUsdg = amount(result[0], this.config.tokens.usdg.decimals)
      return {
        status: 'verified_quote',
        amountEth,
        outputUsdg,
        ethUsdg: outputUsdg / amountEth,
        feePips: Number(model.ethUsdgFeePips),
        quoterGas: result[3].toString(),
      }
    } catch (error) {
      return { status: 'unavailable', message: safePublicError(error) }
    }
  }

  async buildDirectComparisonPool(pool, state, positions, safeBlock) {
    const [slot0, activeLiquidity] = state
    const currentTick = Number(slot0[1])
    const pairUsdg = directPairPriceAtTick(
      currentTick,
      this.config.tokens.usdg.decimals,
      this.config.tokens.pair.decimals,
    )
    const actualPositions = await mapWithConcurrency(pool.positions || [], 4, (position) =>
      this.readDirectPosition(pool, position, state, safeBlock.number),
    )
    const activePositions = positions.filter((position) => position.status === 'active')
    const hypotheticalPositions = activePositions.map((position) => ({
      tokenId: position.tokenId,
      capitalUsdg: position.principal.usdg,
      ...directLiquidityForCapital({
        capitalUsdg: position.principal.usdg,
        pairUsdg,
        priceLowUsdg: position.priceLowUsdg,
        priceHighUsdg: position.priceHighUsdg,
        currentTick,
        tickSpacing: pool.tickSpacing,
        token0Decimals: this.config.tokens.usdg.decimals,
        token1Decimals: this.config.tokens.pair.decimals,
      }),
    }))
    const swaps = this.store.comparisonSwaps(pool.poolId)
    const observedTicks = swaps.map((swap) => Number(swap.tick))
    const relevantTicks = [
      currentTick,
      ...observedTicks,
      ...hypotheticalPositions.flatMap((position) => [position.tickLower, position.tickUpper]),
    ]
    const spacing = pool.tickSpacing
    const minTick = floorDiv(Math.min(...relevantTicks) - spacing * 4, spacing) * spacing
    const maxTick = ceilDiv(Math.max(...relevantTicks) + spacing * 4, spacing) * spacing
    const initializedTicks = await this.getInitializedTicks(pool.poolId, spacing, minTick, maxTick, safeBlock.number)
    const liquidityNet = new Map(initializedTicks.map((item) => [item.tick, item.net]))
    const currentBin = floorDiv(currentTick, spacing) * spacing
    const marketLiquidity = new Map([[currentBin, activeLiquidity]])
    let liquidity = activeLiquidity
    for (let tick = currentBin + spacing; tick < maxTick; tick += spacing) {
      liquidity += liquidityNet.get(tick) || 0n
      marketLiquidity.set(tick, liquidity)
    }
    liquidity = activeLiquidity
    for (let tick = currentBin - spacing; tick >= minTick; tick -= spacing) {
      liquidity -= liquidityNet.get(tick + spacing) || 0n
      marketLiquidity.set(tick, liquidity)
    }

    const baseBins = []
    for (let tickLower = minTick; tickLower < maxTick; tickLower += spacing) {
      const tickUpper = tickLower + spacing
      const market = marketLiquidity.get(tickLower) || 0n
      const ours = hypotheticalPositions.reduce(
        (sum, position) =>
          sum + (tickLower >= position.tickLower && tickLower < position.tickUpper ? position.liquidity : 0),
        0,
      )
      const low = directPairPriceAtTick(tickLower, this.config.tokens.usdg.decimals, this.config.tokens.pair.decimals)
      const high = directPairPriceAtTick(tickUpper, this.config.tokens.usdg.decimals, this.config.tokens.pair.decimals)
      const marketNumber = Math.max(0, Number(market))
      baseBins.push({
        tickLower,
        tickUpper,
        priceLowUsdg: Math.min(low, high),
        priceHighUsdg: Math.max(low, high),
        priceMidUsdg: directPairPriceAtTick(
          (tickLower + tickUpper) / 2,
          this.config.tokens.usdg.decimals,
          this.config.tokens.pair.decimals,
        ),
        marketLiquidity: market.toString(),
        ourLiquidity: ours,
        ourSharePct: marketNumber + ours > 0 ? (ours / (marketNumber + ours)) * 100 : 0,
      })
    }
    baseBins.sort((left, right) => left.priceMidUsdg - right.priceMidUsdg)
    const windows = Object.fromEntries(
      this.config.history.windows.map((window) => [
        window.id,
        this.directAnalyticsForWindow(
          pool,
          {
            ...window,
            seconds: window.seconds == null ? null : Number(window.seconds),
          },
          swaps,
          baseBins,
          safeBlock,
        ),
      ]),
    )
    const rangeAnalysis =
      pool.id === 'pair-usdg-1'
        ? optimizeDirectRange({
            currentTick,
            pairUsdg,
            tickSpacing: spacing,
            capitalUsdg: Number(this.config.comparison.rangeOptimization?.capitalUsdg || 170),
            baseBins,
            windows,
            minSpanTicks: Number(this.config.comparison.rangeOptimization?.minSpanTicks || 2_000),
            maxSpanTicks: Number(this.config.comparison.rangeOptimization?.maxSpanTicks || 3_600),
            minimumRangePositionBps: Number(this.config.comparison.rangeOptimization?.minimumRangePositionBps || 2_000),
            maximumRangePositionBps: Number(this.config.comparison.rangeOptimization?.maximumRangePositionBps || 8_000),
          })
        : null
    return {
      ...pool,
      kind: 'candidate',
      currentTick,
      pairUsdg,
      feePips: Number(slot0[3]),
      protocolFeePips: Number(slot0[2]),
      currentActiveLiquidity: activeLiquidity.toString(),
      hypotheticalPositions,
      hypotheticalActiveLiquidity: hypotheticalPositions.reduce(
        (sum, position) => sum + (position.inRange ? position.liquidity : 0),
        0,
      ),
      activeRangeCount: hypotheticalPositions.filter((position) => position.inRange).length,
      actualPositions,
      actualTotals: actualPositions
        .filter((position) => position.status === 'active')
        .reduce(
          (totals, position) => ({
            activePositions: totals.activePositions + 1,
            inRangePositions: totals.inRangePositions + Number(position.inRange),
            principalUsdg: totals.principalUsdg + position.principal.usdg,
            accruedFeeUsdg: totals.accruedFeeUsdg + position.accruedFees.usdg,
            accruedFeeUsdgToken: totals.accruedFeeUsdgToken + position.accruedFees.usdgToken,
            accruedFeePair: totals.accruedFeePair + position.accruedFees.pair,
          }),
          {
            activePositions: 0,
            inRangePositions: 0,
            principalUsdg: 0,
            accruedFeeUsdg: 0,
            accruedFeeUsdgToken: 0,
            accruedFeePair: 0,
          },
        ),
      windows,
      rangeAnalysis,
      historyCount: swaps.length,
    }
  }

  metricForWindow(analytics, capitalUsdg, source = false) {
    const estimatedFeeUsdg = source
      ? analytics.bins.reduce((sum, bin) => sum + (bin.grossFeeUsdg * bin.ourSharePct) / 100, 0)
      : analytics.totals.estimatedOurFeeUsdg
    return {
      id: analytics.id,
      label: analytics.label,
      effectiveFromTime: analytics.effectiveFromTime,
      toTime: analytics.toTime,
      partialBeforeAnchor: analytics.partialBeforeAnchor,
      swapEvents: analytics.swapEvents,
      volumeUsdg: analytics.totals.volumeUsdg,
      grossFeeUsdg: analytics.totals.grossFeeUsdg,
      estimatedFeeUsdg,
      ...feeVelocity({
        estimatedFeeUsdg,
        capitalUsdg,
        fromTime: analytics.effectiveFromTime,
        toTime: analytics.toTime,
      }),
    }
  }

  buildComparison({
    safeBlock,
    slot0,
    activeLiquidity,
    positions,
    windows,
    directPools,
    principalTotals,
    ourActiveLiquidity,
    spyUsdg,
    pairUsdg,
    gasPrice,
    ethQuote,
  }) {
    const capitalUsdg = principalTotals.usdg
    const base = {
      id: 'spy-pair-1',
      label: 'SPY / PAIR',
      feeLabel: '1%',
      kind: 'current',
      poolId: this.poolId,
      feePips: Number(slot0[3]),
      hooks: this.config.pool.hooks,
      currentTick: Number(slot0[1]),
      pairUsdg,
      currentActiveLiquidity: activeLiquidity.toString(),
      hypotheticalActiveLiquidity: Number(ourActiveLiquidity),
      activeRangeCount: positions.filter((position) => position.status === 'active' && position.inRange).length,
      capitalUsdg,
      windows: Object.fromEntries(
        Object.entries(windows).map(([id, analytics]) => [id, this.metricForWindow(analytics, capitalUsdg, true)]),
      ),
    }
    const rows = [
      base,
      ...directPools.map((pool) => ({
        ...pool,
        capitalUsdg,
        priceDivergencePct: pairUsdg > 0 ? (pool.pairUsdg / pairUsdg - 1) * 100 : 0,
        windows: Object.fromEntries(
          Object.entries(pool.windows).map(([id, analytics]) => [
            id,
            this.metricForWindow(analytics, capitalUsdg, false),
          ]),
        ),
      })),
    ]
    for (const row of rows.slice(1)) {
      for (const [id, metric] of Object.entries(row.windows)) {
        const baseline = base.windows[id]
        metric.relativeLeadPct =
          baseline.hourlyFeeUsdg > 0 ? (metric.hourlyFeeUsdg / baseline.hourlyFeeUsdg - 1) * 100 : null
      }
    }

    const policy = this.config.comparison
    const testFraction = Number(policy.testCapitalPct) / 100
    const gasPriceGwei = Number(gasPrice) / 1e9
    const gasCostUsdg =
      ethQuote.status === 'verified_quote'
        ? ((Number(gasPrice) * Number(policy.migrationModel.gasUnits)) / 1e18) * ethQuote.ethUsdg
        : null
    const sourceSpyUsdg = principalTotals.spy * spyUsdg * testFraction
    const swapFrictionUsdg =
      (sourceSpyUsdg *
        (Number(policy.migrationModel.sourceSwapFeeBps) + Number(policy.migrationModel.slippageBufferBps))) /
      10_000
    const migrationCostUsdg = gasCostUsdg == null ? null : gasCostUsdg + swapFrictionUsdg
    const confirmationWindows = policy.confirmationWindows
    const decision = evaluateComparisonDecision({
      baseRow: base,
      candidateRows: rows.slice(1),
      confirmationWindows,
      minimumLeadPct: Number(policy.minimumLeadPct),
      maximumBreakEvenHours: Number(policy.maximumBreakEvenHours),
      testFraction,
      migrationCostUsdg,
    })

    return {
      asOfBlock: safeBlock.number.toString(),
      asOfTime: new Date(Number(safeBlock.timestamp) * 1_000).toISOString(),
      method: 'same current USD capital and price bands; current-liquidity static attribution',
      capitalUsdg,
      rows,
      policy: {
        minimumLeadPct: Number(policy.minimumLeadPct),
        confirmationWindows,
        maximumBreakEvenHours: Number(policy.maximumBreakEvenHours),
        testCapitalPct: Number(policy.testCapitalPct),
      },
      migrationEstimate: {
        status: migrationCostUsdg == null ? 'unknown' : 'modeled',
        gasUnits: Number(policy.migrationModel.gasUnits),
        gasPriceGwei,
        ethQuote,
        gasCostUsdg,
        sourceSwapNotionalUsdg: sourceSpyUsdg,
        swapFrictionUsdg,
        totalUsdg: migrationCostUsdg,
        meaning: `${Number(policy.testCapitalPct)}% test-slice estimate only; not a transaction simulation or executable quote`,
      },
      decision,
    }
  }

  async buildSnapshot(safeBlock) {
    const [slot0, activeLiquidity, spySlot0, gasPrice, ethQuote, comparisonStates] = await Promise.all([
      this.client.readContract({
        address: this.stateView,
        abi: STATE_VIEW_ABI,
        functionName: 'getSlot0',
        args: [this.poolId],
        blockNumber: safeBlock.number,
      }),
      this.client.readContract({
        address: this.stateView,
        abi: STATE_VIEW_ABI,
        functionName: 'getLiquidity',
        args: [this.poolId],
        blockNumber: safeBlock.number,
      }),
      this.client.readContract({
        address: this.spyUsdgV3Pool,
        abi: V3_POOL_ABI,
        functionName: 'slot0',
        blockNumber: safeBlock.number,
      }),
      this.client.getGasPrice(),
      this.quoteEthUsdg(safeBlock.number),
      Promise.all(
        this.comparisonPools.map((pool) =>
          Promise.all([
            this.client.readContract({
              address: this.stateView,
              abi: STATE_VIEW_ABI,
              functionName: 'getSlot0',
              args: [pool.poolId],
              blockNumber: safeBlock.number,
            }),
            this.client.readContract({
              address: this.stateView,
              abi: STATE_VIEW_ABI,
              functionName: 'getLiquidity',
              args: [pool.poolId],
              blockNumber: safeBlock.number,
            }),
          ]),
        ),
      ),
    ])
    const currentTick = Number(slot0[1])
    const spyUsdg = v3HumanPriceFromSqrt(spySlot0[0], this.config.tokens.spy.decimals, this.config.tokens.usdg.decimals)
    const pairUsdg = pairPriceAtTick(spyUsdg, currentTick)
    const positions = await mapWithConcurrency(this.pairPositionConfigs, 4, (position) =>
      this.readPosition(position, slot0[0], spyUsdg, pairUsdg, currentTick, safeBlock.number),
    )

    const pairSwaps = this.store.pairSwaps()
    const marks = this.store.marks()
    const observedTicks = pairSwaps.map((swap) => Number(swap.tick))
    const relevantTicks = [
      currentTick,
      ...observedTicks,
      ...positions.flatMap((position) => [position.tickLower, position.tickUpper]),
    ]
    const spacing = this.config.pool.tickSpacing
    const minTick = floorDiv(Math.min(...relevantTicks) - 800, spacing) * spacing
    const maxTick = ceilDiv(Math.max(...relevantTicks) + 800, spacing) * spacing
    const initializedTicks = await this.getInitializedTicks(this.poolId, spacing, minTick, maxTick, safeBlock.number)
    const liquidityNet = new Map(initializedTicks.map((item) => [item.tick, item.net]))

    const currentBin = floorDiv(currentTick, spacing) * spacing
    const marketLiquidity = new Map([[currentBin, activeLiquidity]])
    let liquidity = activeLiquidity
    for (let tick = currentBin + spacing; tick < maxTick; tick += spacing) {
      liquidity += liquidityNet.get(tick) || 0n
      marketLiquidity.set(tick, liquidity)
    }
    liquidity = activeLiquidity
    for (let tick = currentBin - spacing; tick >= minTick; tick -= spacing) {
      liquidity -= liquidityNet.get(tick + spacing) || 0n
      marketLiquidity.set(tick, liquidity)
    }

    const activePositions = positions.filter((position) => position.status === 'active')
    const baseBins = []
    for (let tickLower = minTick; tickLower < maxTick; tickLower += spacing) {
      const tickUpper = tickLower + spacing
      const market = marketLiquidity.get(tickLower) || 0n
      const ours = activePositions.reduce(
        (sum, position) =>
          sum + (tickLower >= position.tickLower && tickLower < position.tickUpper ? BigInt(position.liquidity) : 0n),
        0n,
      )
      const low = pairPriceAtTick(spyUsdg, tickLower)
      const high = pairPriceAtTick(spyUsdg, tickUpper)
      baseBins.push({
        tickLower,
        tickUpper,
        priceLowUsdg: Math.min(low, high),
        priceHighUsdg: Math.max(low, high),
        priceMidUsdg: pairPriceAtTick(spyUsdg, (tickLower + tickUpper) / 2),
        marketLiquidity: market.toString(),
        ourLiquidity: ours.toString(),
        ourSharePct: market > 0n ? (Number(ours) / Number(market)) * 100 : 0,
      })
    }
    baseBins.sort((left, right) => left.priceMidUsdg - right.priceMidUsdg)

    const windows = Object.fromEntries(
      this.config.history.windows.map((window) => [
        window.id,
        this.analyticsForWindow(
          {
            ...window,
            seconds: window.seconds == null ? null : Number(window.seconds),
          },
          pairSwaps,
          marks,
          baseBins,
          safeBlock,
          spyUsdg,
        ),
      ]),
    )
    const feeTotals = activePositions.reduce(
      (totals, position) => ({
        spy: totals.spy + position.accruedFees.spy,
        pair: totals.pair + position.accruedFees.pair,
        usdg: totals.usdg + position.accruedFees.usdg,
      }),
      { spy: 0, pair: 0, usdg: 0 },
    )
    const principalTotals = activePositions.reduce(
      (totals, position) => ({
        spy: totals.spy + position.principal.spy,
        pair: totals.pair + position.principal.pair,
        usdg: totals.usdg + position.principal.usdg,
      }),
      { spy: 0, pair: 0, usdg: 0 },
    )
    const ourActiveLiquidity = activePositions.reduce(
      (sum, position) =>
        sum + (currentTick >= position.tickLower && currentTick < position.tickUpper ? BigInt(position.liquidity) : 0n),
      0n,
    )
    const directPools = await Promise.all(
      this.comparisonPools.map((pool, index) =>
        this.buildDirectComparisonPool(pool, comparisonStates[index], positions, safeBlock),
      ),
    )
    const directPositions = directPools.flatMap((pool) => pool.actualPositions || [])
    const comparison = this.buildComparison({
      safeBlock,
      slot0,
      activeLiquidity,
      positions,
      windows,
      directPools,
      principalTotals,
      ourActiveLiquidity,
      spyUsdg,
      pairUsdg,
      gasPrice,
      ethQuote,
    })
    const portfolio = await this.buildPortfolioSnapshot({
      safeBlock,
      positions,
      directPositions,
      spyUsdg,
      pairUsdg,
      ethQuote,
      pairSwaps,
      marks,
    })

    return {
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      status: 'LIVE',
      chain: {
        id: this.config.chain.id,
        name: this.config.chain.name,
        confirmations: Number(this.confirmations),
        source: 'Robinhood JSON-RPC; fixed safe-block snapshot',
      },
      wallet: this.wallet,
      pool: {
        poolId: this.poolId,
        feePips: Number(slot0[3]),
        tickSpacing: spacing,
        currentTick,
        currentSqrtPriceX96: slot0[0].toString(),
        currentActiveLiquidity: activeLiquidity.toString(),
        ourActiveLiquidity: ourActiveLiquidity.toString(),
        ourActiveSharePct: activeLiquidity > 0n ? (Number(ourActiveLiquidity) / Number(activeLiquidity)) * 100 : 0,
        spyUsdg,
        pairUsdg,
        blockNumber: safeBlock.number.toString(),
        blockHash: safeBlock.hash,
        blockTime: new Date(Number(safeBlock.timestamp) * 1_000).toISOString(),
      },
      history: {
        anchorBlock: this.anchorBlock.toString(),
        anchorTime: new Date(Number(this.store.getMeta('anchor_time')) * 1_000).toISOString(),
        anchorLabel: this.config.history.anchorLabel,
        valuation: 'SPY/USDG event-time spot price from the canonical 0.05% V3 pool; PAIR follows each V4 swap path',
        counts: this.store.counts(),
      },
      totals: {
        activePositions: activePositions.length,
        configuredPositions: positions.length,
        principal: principalTotals,
        accruedFees: feeTotals,
      },
      positions,
      directPositions,
      portfolio,
      focusBandUsdg: this.config.focusBandUsdg,
      windows,
      comparison,
      dataQuality: {
        positionVerification: [...positions, ...directPositions].every(
          (position) => position.dataQuality === 'verified',
        )
          ? 'verified'
          : 'partial',
        historyCoverage: 'from configured anchor block',
        grossFeeMeaning: 'pool-wide estimate, not wallet attribution',
        accruedFeeMeaning: 'wallet-position feeGrowth readback at the displayed block, before gas',
      },
      caveats: [
        'Every market and position read is pinned to the displayed safe block.',
        'Historical volume is allocated across crossed 200-tick bins and remains an estimate.',
        'Pool-wide gross fee excludes historical liquidity changes, inventory PnL, gas and slippage.',
        'Accrued position fees are separate from pool-wide heatmap estimates.',
        'Cross-pool comparison applies current liquidity to historical flow; it is a static opportunity estimate, not realized APR.',
        'PAIR/USDG candidates change inventory exposure from SPY to USDG and are not economically identical to SPY/PAIR.',
      ],
    }
  }

  async refresh() {
    const head = await this.getBlock()
    const safeNumber = head.number > this.confirmations ? head.number - this.confirmations : head.number
    const safeBlock = await this.getBlock({ blockNumber: safeNumber })
    await this.syncTo(safeBlock.number)
    for (const pool of this.comparisonPools) await this.syncComparisonPoolTo(pool, safeBlock.number)
    this.onProgress({ phase: 'build', message: `构建安全区块 ${safeBlock.number} 快照` })
    return this.buildSnapshot(safeBlock)
  }

  close() {
    this.store.close()
  }
}

export function stringifySnapshot(value, indentation = 2) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), indentation)
}

export function snapshotWindow(snapshot, requestedWindow) {
  const windowId = snapshot.windows[requestedWindow] ? requestedWindow : '24h'
  const summaries = Object.fromEntries(
    Object.entries(snapshot.windows).map(([id, value]) => [
      id,
      {
        id,
        label: value.label,
        effectiveFromTime: value.effectiveFromTime,
        partialBeforeAnchor: value.partialBeforeAnchor,
        swapEvents: value.swapEvents,
        totals: value.totals,
      },
    ]),
  )
  const { windows, ...rest } = snapshot
  return { ...rest, selectedWindow: windowId, windowSummaries: summaries, analytics: windows[windowId] }
}

export function safePublicError(error) {
  const message = error?.shortMessage || error?.message || String(error)
  return message.replace(/https?:\/\/[^\s]+/gu, '[RPC]').slice(0, 500)
}

export const internals = {
  floorDiv,
  ceilDiv,
  sqrtAtTick,
  tickAtSqrt,
  json,
}
