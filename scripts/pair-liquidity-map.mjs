import fs from 'node:fs'
import path from 'node:path'
import {
  createPublicClient,
  defineChain,
  encodePacked,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  parseEther,
} from 'viem'

const CHAIN_ID = 4663
const RPC_URL = process.env.RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const STATE_PATH = path.join(ROOT, 'runs', 'pair-lp-live-one.json')
const OUTPUT_PATH = process.env.PAIR_LIQUIDITY_MAP_OUTPUT
  ? path.resolve(process.env.PAIR_LIQUIDITY_MAP_OUTPUT)
  : path.join(ROOT, 'reports', 'pair-liquidity-map-latest.json')

const POOL_MANAGER = getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951')
const STATE_VIEW = getAddress('0xF3334192D15450CdD385c8B70e03f9A6bD9E673b')
const POSITION_MANAGER = getAddress('0x58daec3116aae6D93017bAAea7749052E8a04fA7')
const V3_QUOTER = getAddress('0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7')
const USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
const SPY = getAddress('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C')
const WALLET = getAddress('0xe864237f450E3C813EB6C5652106EC3AFd9Bc919')
const Q96_NUMBER = 2 ** 96
const LOG_CHUNK = 10_000n

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
})

const client = createPublicClient({
  chain,
  transport: http(undefined, { timeout: 30_000, retryCount: 3 }),
})

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
  'function getTickBitmap(bytes32 poolId,int16 wordPosition) view returns (uint256 tickBitmap)',
  'function getTickLiquidity(bytes32 poolId,int24 tick) view returns (uint128 liquidityGross,int128 liquidityNet)',
])

const POSITION_MANAGER_ABI = parseAbi(['function getPositionLiquidity(uint256 tokenId) view returns (uint128)'])

const V3_QUOTER_ABI = parseAbi([
  'function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)',
])

const SWAP_EVENT = parseAbiItem(
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
)

function readState() {
  if (!fs.existsSync(STATE_PATH)) throw new Error(`缺少实盘状态文件：${STATE_PATH}`)
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
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

function tickAtSqrt(sqrtPriceX96) {
  return (2 * Math.log(sqrtPriceX96 / Q96_NUMBER)) / Math.log(1.0001)
}

function pairPriceAtTick(spyUsdg, tick) {
  return spyUsdg / Math.pow(1.0001, tick)
}

async function quoteSpyUsdg() {
  const amountIn = parseEther('0.05')
  const candidates = []
  for (const fee of [500, 3_000]) {
    try {
      const pathBytes = encodePacked(['address', 'uint24', 'address'], [SPY, fee, USDG])
      const { result } = await client.simulateContract({
        address: V3_QUOTER,
        abi: V3_QUOTER_ABI,
        functionName: 'quoteExactInput',
        args: [pathBytes, amountIn],
        account: WALLET,
      })
      candidates.push({ fee, amountOut: result[0] })
    } catch {
      // Missing fee-tier pools are expected route rejections.
    }
  }
  candidates.sort((left, right) => (left.amountOut > right.amountOut ? -1 : 1))
  if (!candidates.length) throw new Error('无法取得 SPY/USDG 链上报价')
  return Number(formatUnits(candidates[0].amountOut, 6)) / 0.05
}

async function getSwapLogs(poolId, fromBlock, toBlock) {
  const logs = []
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n > toBlock ? toBlock : start + LOG_CHUNK - 1n
    logs.push(
      ...(await client.getLogs({
        address: POOL_MANAGER,
        event: SWAP_EVENT,
        args: { id: poolId },
        fromBlock: start,
        toBlock: end,
      })),
    )
  }
  return logs
}

async function findPreviousSwap(poolId, atBlock) {
  for (let end = atBlock; end > 0n; end -= LOG_CHUNK) {
    const start = end >= LOG_CHUNK ? end - LOG_CHUNK + 1n : 0n
    const logs = await client.getLogs({
      address: POOL_MANAGER,
      event: SWAP_EVENT,
      args: { id: poolId },
      fromBlock: start,
      toBlock: end,
    })
    if (logs.length) return logs.at(-1)
  }
  throw new Error(`区块 ${atBlock} 之前没有找到池子 Swap 事件`)
}

async function mapWithConcurrency(values, concurrency, fn) {
  const result = new Array(values.length)
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      result[index] = await fn(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  return result
}

async function getInitializedTicks(poolId, tickSpacing, minTick, maxTick) {
  const minCompressed = floorDiv(minTick, tickSpacing)
  const maxCompressed = floorDiv(maxTick, tickSpacing)
  const minWord = floorDiv(minCompressed, 256)
  const maxWord = floorDiv(maxCompressed, 256)
  const words = []
  for (let word = minWord; word <= maxWord; word += 1) words.push(word)

  const bitmaps = await mapWithConcurrency(words, 4, async (word) => ({
    word,
    bitmap: await client.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getTickBitmap',
      args: [poolId, word],
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

  const liquidity = await mapWithConcurrency(ticks, 8, async (tick) => {
    const [gross, net] = await client.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getTickLiquidity',
      args: [poolId, tick],
    })
    return { tick, gross, net }
  })
  return liquidity.sort((left, right) => left.tick - right.tick)
}

function activePositions(state) {
  const positions = []
  if (state.position?.tokenId && state.status === 'active') {
    positions.push({
      label: '主 LP',
      tokenId: state.position.tokenId,
      tickLower: state.position.tickLower,
      tickUpper: state.position.tickUpper,
    })
  }
  for (const item of state.satellites || []) {
    if (item.status !== 'active') continue
    positions.push({
      label: `第 ${positions.length + 1} LP`,
      tokenId: item.tokenId,
      tickLower: item.tickLower,
      tickUpper: item.tickUpper,
    })
  }
  return positions
}

function allocateSwapToBins(log, previousSqrt, tickSpacing, spyUsdg, volumeByTick) {
  const endingSqrt = Number(log.args.sqrtPriceX96)
  const amount0 = Number(log.args.amount0) / 1e18
  const amount1 = Number(log.args.amount1) / 1e18
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
    slices.push({ midpointTick: Number(log.args.tick), weight: 1 })
    totalWeight = 1
  }

  for (const slice of slices) {
    const amount = (inputAmount * slice.weight) / totalWeight
    const tickLower = floorDiv(slice.midpointTick, tickSpacing) * tickSpacing
    const pairUsdg = pairPriceAtTick(spyUsdg, slice.midpointTick)
    const volumeUsdg = amount * (inputToken === 'SPY' ? spyUsdg : pairUsdg)
    const grossFeeUsdg = (volumeUsdg * Number(log.args.fee)) / 1_000_000
    const current = volumeByTick.get(tickLower) || { volumeUsdg: 0, grossFeeUsdg: 0, swaps: 0 }
    current.volumeUsdg += volumeUsdg
    current.grossFeeUsdg += grossFeeUsdg
    current.swaps += 1
    volumeByTick.set(tickLower, current)
  }
  return endingSqrt
}

function stringify(value) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), 2)
}

async function main() {
  const state = readState()
  const poolId = state.pool.poolId
  const tickSpacing = state.pool.tickSpacing
  const positions = activePositions(state)
  if (!positions.length) throw new Error('本地状态没有活动 PAIR/SPY LP')

  const migrationTx = state.migrations?.at(-1)?.target?.increaseTransaction
  const fallbackBlock = BigInt(state.position.mintBlock)
  const migrationReceipt = migrationTx ? await client.getTransactionReceipt({ hash: migrationTx }) : null
  const historyAnchorBlock = migrationReceipt?.blockNumber || fallbackBlock
  const historyFromBlock = historyAnchorBlock + 1n

  const [latestBlock, slot0, activeLiquidity, spyUsdg, onchainPositions] = await Promise.all([
    client.getBlock(),
    client.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] }),
    client.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] }),
    quoteSpyUsdg(),
    mapWithConcurrency(positions, 4, async (position) => ({
      ...position,
      liquidity: await client.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_MANAGER_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(position.tokenId)],
      }),
    })),
  ])

  const [historyStartBlock, priorSwap, swaps] = await Promise.all([
    client.getBlock({ blockNumber: historyFromBlock }),
    findPreviousSwap(poolId, historyAnchorBlock),
    getSwapLogs(poolId, historyFromBlock, latestBlock.number),
  ])

  const observedTicks = swaps.map((log) => Number(log.args.tick))
  const relevantTicks = [
    Number(slot0[1]),
    ...observedTicks,
    ...onchainPositions.flatMap((position) => [position.tickLower, position.tickUpper]),
  ]
  const minTick = floorDiv(Math.min(...relevantTicks) - 800, tickSpacing) * tickSpacing
  const maxTick = ceilDiv(Math.max(...relevantTicks) + 800, tickSpacing) * tickSpacing
  const initializedTicks = await getInitializedTicks(poolId, tickSpacing, minTick, maxTick)
  const liquidityNet = new Map(initializedTicks.map((item) => [item.tick, item.net]))

  const currentBin = floorDiv(Number(slot0[1]), tickSpacing) * tickSpacing
  const marketLiquidity = new Map([[currentBin, activeLiquidity]])
  let liquidity = activeLiquidity
  for (let tick = currentBin + tickSpacing; tick < maxTick; tick += tickSpacing) {
    liquidity += liquidityNet.get(tick) || 0n
    marketLiquidity.set(tick, liquidity)
  }
  liquidity = activeLiquidity
  for (let tick = currentBin - tickSpacing; tick >= minTick; tick -= tickSpacing) {
    liquidity -= liquidityNet.get(tick + tickSpacing) || 0n
    marketLiquidity.set(tick, liquidity)
  }

  const volumeByTick = new Map()
  let previousSqrt = Number(priorSwap.args.sqrtPriceX96)
  for (const log of swaps) {
    previousSqrt = allocateSwapToBins(log, previousSqrt, tickSpacing, spyUsdg, volumeByTick)
  }

  const bins = []
  for (let tickLower = minTick; tickLower < maxTick; tickLower += tickSpacing) {
    const tickUpper = tickLower + tickSpacing
    const market = marketLiquidity.get(tickLower) || 0n
    const ours = onchainPositions.reduce(
      (sum, position) =>
        sum + (tickLower >= position.tickLower && tickLower < position.tickUpper ? position.liquidity : 0n),
      0n,
    )
    const history = volumeByTick.get(tickLower) || { volumeUsdg: 0, grossFeeUsdg: 0, swaps: 0 }
    const priceAtLowerTick = pairPriceAtTick(spyUsdg, tickLower)
    const priceAtUpperTick = pairPriceAtTick(spyUsdg, tickUpper)
    const marketNumber = Number(market)
    bins.push({
      tickLower,
      tickUpper,
      priceLowUsdg: Math.min(priceAtLowerTick, priceAtUpperTick),
      priceHighUsdg: Math.max(priceAtLowerTick, priceAtUpperTick),
      priceMidUsdg: pairPriceAtTick(spyUsdg, (tickLower + tickUpper) / 2),
      marketLiquidity: market.toString(),
      ourLiquidity: ours.toString(),
      ourSharePct: market > 0n ? (Number(ours) / marketNumber) * 100 : 0,
      volumeUsdg: history.volumeUsdg,
      grossFeeUsdg: history.grossFeeUsdg,
      feeUsdgPer1e20Liquidity: marketNumber > 0 ? history.grossFeeUsdg / (marketNumber / 1e20) : 0,
      allocatedSwapSlices: history.swaps,
    })
  }
  bins.sort((left, right) => left.priceMidUsdg - right.priceMidUsdg)

  const positionOutput = onchainPositions.map((position) => ({
    ...position,
    liquidity: position.liquidity.toString(),
    priceLowUsdg: Math.min(pairPriceAtTick(spyUsdg, position.tickLower), pairPriceAtTick(spyUsdg, position.tickUpper)),
    priceHighUsdg: Math.max(pairPriceAtTick(spyUsdg, position.tickLower), pairPriceAtTick(spyUsdg, position.tickUpper)),
    inRange: Number(slot0[1]) >= position.tickLower && Number(slot0[1]) < position.tickUpper,
  }))

  const targetBins = bins.filter((bin) => bin.priceMidUsdg >= 0.007 && bin.priceMidUsdg <= 0.008)
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    wallet: WALLET,
    pool: {
      poolId,
      feePips: Number(slot0[3]),
      tickSpacing,
      currentTick: Number(slot0[1]),
      currentSqrtPriceX96: slot0[0].toString(),
      currentActiveLiquidity: activeLiquidity.toString(),
      spyUsdg,
      pairUsdg: pairPriceAtTick(spyUsdg, Number(slot0[1])),
      blockNumber: latestBlock.number.toString(),
      blockTime: new Date(Number(latestBlock.timestamp) * 1_000).toISOString(),
    },
    history: {
      fromBlock: historyFromBlock.toString(),
      toBlock: latestBlock.number.toString(),
      fromTime: new Date(Number(historyStartBlock.timestamp) * 1_000).toISOString(),
      toTime: new Date(Number(latestBlock.timestamp) * 1_000).toISOString(),
      swapEvents: swaps.length,
      method:
        'one-sided Swap input volume allocated over crossed 200-tick price bins; SPY marked at the report-time SPY/USDG quote',
    },
    positions: positionOutput,
    focus007To008: {
      volumeUsdg: targetBins.reduce((sum, bin) => sum + bin.volumeUsdg, 0),
      grossFeeUsdg: targetBins.reduce((sum, bin) => sum + bin.grossFeeUsdg, 0),
      bins: targetBins.length,
    },
    initializedTicks: initializedTicks.map((item) => ({
      tick: item.tick,
      liquidityGross: item.gross.toString(),
      liquidityNet: item.net.toString(),
    })),
    bins,
    caveats: [
      'Liquidity is a current StateView snapshot; historical volume spans the stated block window.',
      'Cross-tick Swap input is price-path allocated and is an estimate, not historical feeGrowth readback.',
      'Gross fee is the pool-wide fee before attribution to a particular LP and excludes inventory PnL, gas, and slippage.',
    ],
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
  fs.writeFileSync(OUTPUT_PATH, `${stringify(report)}\n`)
  console.log(
    stringify({
      status: 'READY',
      output: OUTPUT_PATH,
      blockNumber: report.pool.blockNumber,
      currentPairUsdg: report.pool.pairUsdg,
      positions: report.positions,
      history: report.history,
      focus007To008: report.focus007To008,
      bins: report.bins.length,
    }),
  )
}

main().catch((error) => {
  console.error(error.shortMessage || error.message)
  process.exitCode = 1
})
