import fs from 'node:fs'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

const root = process.env.PAIR_DASHBOARD_ROOT || '/opt/pair-liquidity-dashboard/current/dashboard'
const require = createRequire(`${root}/package.json`)
const { createPublicClient, defineChain, http, parseAbi } = require('viem')

const dbPath = process.env.PAIR_DASHBOARD_DB || '/var/lib/pair-liquidity-dashboard/history.sqlite'
const snapshotPath = process.env.PAIR_DASHBOARD_SNAPSHOT || '/var/lib/pair-liquidity-dashboard/latest.json'
const rpcUrl = process.env.RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const poolId = '0x97f48c8d9639b7940874b6c6a43b3d606d070a694920b545acff9c35926593a6'
const stateView = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b'
const tickSpacing = 100
const capitalUsdg = Number(process.env.PAIR_USDG_RANGE_CAPITAL_USDG || 170)
const minimumRangePosition = Number(process.env.PAIR_USDG_MIN_RANGE_POSITION || 0.2)
const maximumRangePosition = Number(process.env.PAIR_USDG_MAX_RANGE_POSITION || 0.75)
const Q96 = 2 ** 96

const stateViewAbi = parseAbi([
  'function getTickBitmap(bytes32 poolId,int16 wordPosition) view returns (uint256 tickBitmap)',
  'function getTickLiquidity(bytes32 poolId,int24 tick) view returns (uint128 liquidityGross,int128 liquidityNet)',
])
const chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
})
const client = createPublicClient({ chain, transport: http(undefined, { timeout: 30_000, retryCount: 2 }) })

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function readContract(parameters) {
  let lastError
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      return await client.readContract(parameters)
    } catch (error) {
      lastError = error
      if (attempt === 6) break
      await delay(Math.min(8_000, 500 * 2 ** attempt))
    }
  }
  throw lastError
}

function floorDiv(value, divisor) {
  return Math.floor(value / divisor)
}

function ceilDiv(value, divisor) {
  return Math.ceil(value / divisor)
}

function priceAtTick(tick) {
  return 1e12 / Math.pow(1.0001, tick)
}

function tickAtSqrt(value) {
  return (2 * Math.log(value / Q96)) / Math.log(1.0001)
}

function sqrtAtTick(tick) {
  return Math.pow(1.0001, tick / 2) * Q96
}

function positionLiquidity(capital, currentTick, tickLower, tickUpper) {
  const sqrtCurrent = Math.pow(1.0001, currentTick / 2)
  const sqrtLower = Math.pow(1.0001, tickLower / 2)
  const sqrtUpper = Math.pow(1.0001, tickUpper / 2)
  let amount0PerLiquidity = 0
  let amount1PerLiquidity = 0
  if (sqrtCurrent <= sqrtLower) {
    amount0PerLiquidity = (sqrtUpper - sqrtLower) / (sqrtLower * sqrtUpper) / 1e6
  } else if (sqrtCurrent < sqrtUpper) {
    amount0PerLiquidity = (sqrtUpper - sqrtCurrent) / (sqrtCurrent * sqrtUpper) / 1e6
    amount1PerLiquidity = (sqrtCurrent - sqrtLower) / 1e18
  } else {
    amount1PerLiquidity = (sqrtUpper - sqrtLower) / 1e18
  }
  const value = amount0PerLiquidity + amount1PerLiquidity * priceAtTick(currentTick)
  return value > 0 ? capital / value : 0
}

function allocate(logs, previousSqrt) {
  const byWindow = { '1h': new Map(), '6h': new Map(), '24h': new Map() }
  const endTime = Math.max(...logs.map((item) => Number(item.timestamp)))
  for (const log of logs) {
    const endingSqrt = Number(log.sqrt_price)
    const amount0 = Number(log.amount0) / 1e6
    const amount1 = Number(log.amount1) / 1e18
    const inputToken = amount0 > 0 ? 'USDG' : amount1 > 0 ? 'PAIR' : null
    const inputAmount = Math.max(amount0, amount1)
    if (!inputToken || inputAmount <= 0) {
      previousSqrt = endingSqrt
      continue
    }
    const lowSqrt = Math.min(previousSqrt, endingSqrt)
    const highSqrt = Math.max(previousSqrt, endingSqrt)
    const boundaries = []
    for (
      let tick = (floorDiv(tickAtSqrt(lowSqrt), tickSpacing) + 1) * tickSpacing;
      tick < tickAtSqrt(highSqrt);
      tick += tickSpacing
    ) {
      boundaries.push(sqrtAtTick(tick))
    }
    const points = [previousSqrt, ...boundaries, endingSqrt].sort((left, right) =>
      previousSqrt < endingSqrt ? left - right : right - left,
    )
    const slices = []
    let totalWeight = 0
    for (let index = 0; index < points.length - 1; index += 1) {
      const left = points[index]
      const right = points[index + 1]
      const weight = inputToken === 'PAIR' ? Math.abs(right - left) : Math.abs(1 / right - 1 / left)
      totalWeight += weight
      slices.push({ tick: tickAtSqrt((left + right) / 2), weight })
    }
    if (!slices.length || totalWeight === 0) {
      slices.push({ tick: Number(log.tick), weight: 1 })
      totalWeight = 1
    }
    for (const [id, seconds] of [
      ['1h', 3_600],
      ['6h', 21_600],
      ['24h', 86_400],
    ]) {
      if (Number(log.timestamp) < endTime - seconds) continue
      for (const slice of slices) {
        const allocated = (inputAmount * slice.weight) / totalWeight
        const tick = floorDiv(slice.tick, tickSpacing) * tickSpacing
        const volume = allocated * (inputToken === 'USDG' ? 1 : priceAtTick(slice.tick))
        const current = byWindow[id].get(tick) || { volume: 0, fee: 0 }
        current.volume += volume
        current.fee += (volume * Number(log.fee)) / 1e6
        byWindow[id].set(tick, current)
      }
    }
    previousSqrt = endingSqrt
  }
  return { byWindow, endTime }
}

async function initializedTicks(minTick, maxTick, blockNumber) {
  const words = []
  for (
    let word = floorDiv(floorDiv(minTick, tickSpacing), 256);
    word <= floorDiv(floorDiv(maxTick, tickSpacing), 256);
    word += 1
  )
    words.push(word)
  const bitmaps = []
  for (const word of words) {
    const bitmap = await readContract({
      address: stateView,
      abi: stateViewAbi,
      functionName: 'getTickBitmap',
      args: [poolId, word],
      blockNumber,
    })
    bitmaps.push({ word, bitmap })
  }
  const ticks = []
  for (const { word, bitmap } of bitmaps) {
    for (let bit = 0; bit < 256; bit += 1) {
      if ((bitmap & (1n << BigInt(bit))) === 0n) continue
      const tick = (word * 256 + bit) * tickSpacing
      if (tick >= minTick && tick <= maxTick) ticks.push(tick)
    }
  }
  const result = []
  for (const tick of ticks) {
    const [gross, net] = await readContract({
      address: stateView,
      abi: stateViewAbi,
      functionName: 'getTickLiquidity',
      args: [poolId, tick],
      blockNumber,
    })
    result.push({ tick, gross, net })
    await delay(120)
  }
  return result
}

function quantilePrice(map, quantile) {
  const rows = [...map.entries()]
    .filter(([, value]) => value.volume > 0)
    .sort((a, b) => priceAtTick(a[0] + 50) - priceAtTick(b[0] + 50))
  const total = rows.reduce((sum, [, value]) => sum + value.volume, 0)
  let cumulative = 0
  for (const [tick, value] of rows) {
    cumulative += value.volume
    if (cumulative >= total * quantile) return priceAtTick(tick + 50)
  }
  return null
}

async function main() {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
  const direct = snapshot.comparison.rows.find((row) => row.id === 'pair-usdg-1')
  if (!direct) throw new Error('PAIR/USDG 1% snapshot missing')
  const safeBlock = BigInt(snapshot.pool.blockNumber)
  const safeTime = Math.floor(Date.parse(snapshot.pool.blockTime) / 1_000)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const previous = db
    .prepare(
      `
    SELECT sqrt_price FROM comparison_swaps p JOIN blocks b USING (block_number)
    WHERE pool_id = ? AND b.timestamp < ? ORDER BY block_number DESC, transaction_index DESC, log_index DESC LIMIT 1
  `,
    )
    .get(poolId, safeTime - 86_400)
  const anchorSqrt = db.prepare('SELECT value FROM meta WHERE key = ?').get(`comparison:${poolId}:anchor_sqrt`)?.value
  const logs = db
    .prepare(
      `
    SELECT p.*, b.timestamp FROM comparison_swaps p JOIN blocks b USING (block_number)
    WHERE pool_id = ? AND b.timestamp >= ? AND b.timestamp <= ?
    ORDER BY block_number, transaction_index, log_index
  `,
    )
    .all(poolId, safeTime - 86_400, safeTime)
  db.close()
  if (!logs.length || (!previous && !anchorSqrt)) throw new Error('insufficient direct-pool history')
  const { byWindow, endTime } = allocate(logs, Number(previous?.sqrt_price || anchorSqrt))
  const currentTick = Number(direct.currentTick)
  const observed = logs.map((item) => Number(item.tick))
  const minTick = floorDiv(Math.min(currentTick - 4_000, ...observed) - 200, tickSpacing) * tickSpacing
  const maxTick = ceilDiv(Math.max(currentTick + 4_000, ...observed) + 200, tickSpacing) * tickSpacing
  const initialized = await initializedTicks(minTick, maxTick, safeBlock)
  const net = new Map(initialized.map((item) => [item.tick, item.net]))
  const currentBin = floorDiv(currentTick, tickSpacing) * tickSpacing
  const market = new Map([[currentBin, BigInt(direct.currentActiveLiquidity)]])
  let liquidity = BigInt(direct.currentActiveLiquidity)
  for (let tick = currentBin + tickSpacing; tick < maxTick; tick += tickSpacing) {
    liquidity += net.get(tick) || 0n
    market.set(tick, liquidity)
  }
  liquidity = BigInt(direct.currentActiveLiquidity)
  for (let tick = currentBin - tickSpacing; tick >= minTick; tick -= tickSpacing) {
    liquidity -= net.get(tick + tickSpacing) || 0n
    market.set(tick, liquidity)
  }

  const candidates = []
  for (let span = 2_000; span <= 3_600; span += tickSpacing) {
    for (let below = 400; below < span; below += tickSpacing) {
      const lower = currentBin - below
      const upper = lower + span
      const position = (currentTick - lower) / span
      if (position < minimumRangePosition || position > maximumRangePosition) continue
      const ourLiquidity = positionLiquidity(capitalUsdg, currentTick, lower, upper)
      const metrics = {}
      for (const [id, seconds] of [
        ['1h', 3_600],
        ['6h', 21_600],
        ['24h', 86_400],
      ]) {
        let volume = 0
        let fee = 0
        let captured = 0
        const totalVolume = [...byWindow[id].values()].reduce((sum, value) => sum + value.volume, 0)
        for (let tick = lower; tick < upper; tick += tickSpacing) {
          const history = byWindow[id].get(tick)
          if (!history) continue
          const marketLiquidity = Math.max(0, Number(market.get(tick) || 0n))
          const share = ourLiquidity / (marketLiquidity + ourLiquidity)
          volume += history.volume
          fee += history.fee
          captured += history.fee * share
        }
        metrics[id] = {
          volume,
          coveragePct: totalVolume > 0 ? (volume / totalVolume) * 100 : 0,
          capturedFeeUsdg: captured,
          hourlyFeeUsdg: captured / (seconds / 3_600),
          dailyRatePct: (captured / capitalUsdg / (seconds / 86_400)) * 100,
          feeWeightedSharePct: fee > 0 ? (captured / fee) * 100 : 0,
        }
      }
      const stableHourly = Math.min(
        metrics['6h'].hourlyFeeUsdg,
        (metrics['1h'].hourlyFeeUsdg + metrics['6h'].hourlyFeeUsdg) / 2,
      )
      const coverage = Math.min(metrics['1h'].coveragePct, metrics['6h'].coveragePct) / 100
      candidates.push({
        tickLower: lower,
        tickUpper: upper,
        priceLowUsdg: priceAtTick(upper),
        priceHighUsdg: priceAtTick(lower),
        priceWidthPct: (priceAtTick(lower) / priceAtTick(upper) - 1) * 100,
        rangePositionPct: position * 100,
        modeledLiquidity: ourLiquidity,
        stableHourlyFeeUsdg: stableHourly,
        score: stableHourly * (0.75 + 0.25 * coverage),
        metrics,
      })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  const topBins = [...byWindow['6h'].entries()]
    .sort((a, b) => b[1].volume - a[1].volume)
    .slice(0, 10)
    .map(([tick, value]) => ({
      tickLower: tick,
      priceLowUsdg: priceAtTick(tick + tickSpacing),
      priceHighUsdg: priceAtTick(tick),
      volumeUsdg: value.volume,
      marketLiquidity: String(market.get(tick) || 0n),
    }))
  console.log(
    JSON.stringify(
      {
        status: 'LIVE_READ_ONLY',
        asOfBlock: safeBlock.toString(),
        asOfTime: new Date(endTime * 1_000).toISOString(),
        currentTick,
        pairUsdg: priceAtTick(currentTick),
        capitalUsdg,
        rangePositionGuardPct: { minimum: minimumRangePosition * 100, maximum: maximumRangePosition * 100 },
        hotBand6hUsdg: {
          p10: quantilePrice(byWindow['6h'], 0.1),
          p50: quantilePrice(byWindow['6h'], 0.5),
          p90: quantilePrice(byWindow['6h'], 0.9),
        },
        topVolumeBins6h: topBins,
        recommendation: candidates[0],
        alternatives: candidates.slice(1, 5),
        method:
          '24h canonical swaps; crossed-path allocation; 1h/6h robust fee capture under current per-tick market liquidity',
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
