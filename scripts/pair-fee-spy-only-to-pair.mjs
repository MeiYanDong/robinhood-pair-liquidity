import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  padHex,
  parseAbi,
  parseAbiParameters,
  parseEther,
  parseUnits,
  toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  assertPairOnlyBoundary,
  authorizedPairBudget,
  protectedPairFloor,
  verifyAuthorizedPairSpend,
} from '../lib/execution-guards.mjs'

const require = createRequire(import.meta.url)
const { Pool, Position, V4PositionManager } = require('@uniswap/v4-sdk')
const { Percent, Token } = require('@uniswap/sdk-core')

const CHAIN_ID = 4663
const RPC_URL = process.env.RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const EXPLORER_TX = 'https://robinhoodchain.blockscout.com/tx/'
const KEYCHAIN_SERVICE = process.env.PAIR_KEYCHAIN_SERVICE || 'robinhood-pair-liquidity'

const WALLET = getAddress('0xe864237f450E3C813EB6C5652106EC3AFd9Bc919')
const WETH = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73')
const USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
const SPY = getAddress('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C')
const PAIR = getAddress('0x6b1d42927B1a84eC28Fa88d4fC6FA7AF404966be')
const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3')
const V3_QUOTER = getAddress('0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7')
const V4_QUOTER = getAddress('0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94')
const STATE_VIEW = getAddress('0xF3334192D15450CdD385c8B70e03f9A6bD9E673b')
const UNIVERSAL_ROUTER = getAddress('0x8876789976dEcBfCbBbe364623C63652db8C0904')
const POSITION_MANAGER = getAddress('0x58daec3116aae6D93017bAAea7749052E8a04fA7')
const SPY_PAIR_HOOK = getAddress('0x16D1560630Ce74af4478d9b8AD46548A092A2000')
const SPY_PAIR_POOL_ID = '0xf224a070c8626c890a085b258cf562ee4bf052b6d1d59104b3b44d722640c001'
const POOL_FEE = 10_000
const TICK_SPACING = 200
const Q128 = 1n << 128n
const UINT256_MODULUS = 1n << 256n
const SEND_GAS_PRICE_BPS = 11_000n
const SLIPPAGE_BPS = 100n
const MIN_QUOTE_RETENTION_BPS = 9_600n
const MIN_FINAL_ETH = parseEther('0.0001')
const MAX_TOTAL_GAS_USDG = parseUnits(process.env.PAIR_INCREASE_MAX_GAS_USDG || '5', 6)
const UINT160_MAX = (1n << 160n) - 1n
const SINGLE_ROLL_SOURCE_TOKEN_ID = '1987316'
const SINGLE_ROLL_SOURCE_TICK_LOWER = 93_000
const SINGLE_ROLL_SOURCE_TICK_UPPER = 99_600
const SINGLE_ROLL_TARGET_TICK_LOWER = 97_400
const SINGLE_ROLL_TARGET_TICK_UPPER = 99_800
const SINGLE_ROLL_MINT_SLIPPAGE = new Percent(100, 10_000)
const SINGLE_ROLL_MIN_PAIR_USE_BPS = 9_999n
const CLI_COMMAND = process.argv[2] || 'preflight'
const SINGLE_ROLL_MODE = CLI_COMMAND.startsWith('single-roll-')
const POSITION_PAIR_INCREASE_MODE = CLI_COMMAND.startsWith('position-pair-increase-')
const POSITION_INCREASE_TARGET_TOKEN_ID = String(process.env.PAIR_INCREASE_TARGET_TOKEN_ID || '1988669')
const POSITION_INCREASE_TARGET_TICK_LOWER = Number(process.env.PAIR_INCREASE_TICK_LOWER || '97400')
const POSITION_INCREASE_TARGET_TICK_UPPER = Number(process.env.PAIR_INCREASE_TICK_UPPER || '99800')
const POSITION_INCREASE_MINT_SLIPPAGE = new Percent(100, 10_000)
const POSITION_INCREASE_MIN_PAIR_USE_BPS = 9_999n
const POSITION_INCREASE_PAIR_ONLY_SAFETY_PPM = 999_990n
const POSITION_INCREASE_MAX_WALLET_SPY = parseUnits(process.env.PAIR_INCREASE_MAX_WALLET_SPY || '0', 18)
const POSITION_INCREASE_MAX_WALLET_PAIR_WEI =
  process.env.PAIR_INCREASE_MAX_WALLET_PAIR_WEI == null ? null : BigInt(process.env.PAIR_INCREASE_MAX_WALLET_PAIR_WEI)
const POSITION_INCREASE_MAX_PAIR_RESIDUAL_BPS = 700n
const POSITION_INCREASE_MIN_FINAL_ETH = parseEther(process.env.PAIR_INCREASE_MIN_FINAL_ETH || '0.005')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const MANIFEST_PATH = path.join(ROOT, 'dashboard', 'config', 'lp-portfolio-ledger.json')
const RUN_DIR = path.join(ROOT, 'runs')
const OPERATION_FILE_STEM = POSITION_PAIR_INCREASE_MODE
  ? 'pair-position-pair-increase'
  : SINGLE_ROLL_MODE
    ? 'pair-single-sided-roll'
    : 'pair-fees-to-pair'
const STATE_PATH = path.join(RUN_DIR, `${OPERATION_FILE_STEM}-live.json`)
const AUDIT_PATH = path.join(RUN_DIR, `${OPERATION_FILE_STEM}-live.jsonl`)
const HISTORY_DIR = path.join(RUN_DIR, `${OPERATION_FILE_STEM}-history`)
const LOCK_PATH = path.join(RUN_DIR, `${OPERATION_FILE_STEM}.lock`)

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Robinhood Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
})
const publicClient = createPublicClient({ chain, transport: http(undefined, { timeout: 30_000, retryCount: 1 }) })

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
])
const POSITION_ABI = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)',
])
const POSITION_MANAGER_MULTICALL_ABI = parseAbi(['function multicall(bytes[] data) payable returns (bytes[] results)'])
const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
  'function getPositionInfo(bytes32 poolId,bytes32 positionId) view returns (uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128)',
  'function getFeeGrowthInside(bytes32 poolId,int24 tickLower,int24 tickUpper) view returns (uint256 feeGrowthInside0X128,uint256 feeGrowthInside1X128)',
])
const PERMIT2_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
]
const V4_QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
]
const V3_QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInput',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'path', type: 'bytes' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
      { name: 'initializedTicksCrossedList', type: 'uint32[]' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
]
const UNIVERSAL_ROUTER_ABI = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable'])

const poolKey = {
  currency0: SPY,
  currency1: PAIR,
  fee: POOL_FEE,
  tickSpacing: TICK_SPACING,
  hooks: SPY_PAIR_HOOK,
}

function stringify(value) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), 2)
}

function readJson(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null
}

function writeState(state) {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
  const temporary = `${STATE_PATH}.tmp`
  fs.writeFileSync(temporary, `${stringify(state)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, STATE_PATH)
  fs.chmodSync(STATE_PATH, 0o600)
}

function appendAudit(event, details = {}) {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...details }, (_, item) =>
    typeof item === 'bigint' ? item.toString() : item,
  )
  fs.appendFileSync(AUDIT_PATH, `${line}\n`, { mode: 0o600 })
}

function archiveCompleteState(state) {
  if (!state?.operationId || state.status !== 'complete') return
  fs.mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 })
  const target = path.join(HISTORY_DIR, `${state.operationId}.json`)
  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, `${stringify(state)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, target)
  fs.chmodSync(target, 0o600)
}

function acquireLock() {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
  let fd
  try {
    fd = fs.openSync(LOCK_PATH, 'wx', 0o600)
  } catch {
    throw new Error(`检测到并发执行锁：${LOCK_PATH}`)
  }
  fs.writeFileSync(fd, `${process.pid}\n`)
  return () => {
    fs.closeSync(fd)
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH)
  }
}

function loadAccount() {
  let privateKey
  try {
    privateKey = execFileSync('/usr/bin/security', ['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    throw new Error(`macOS Keychain 中找不到 ${KEYCHAIN_SERVICE}`)
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Keychain 项目不是有效的 EVM 私钥')
  const account = privateKeyToAccount(privateKey)
  privateKey = undefined
  if (account.address.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`签名钱包不匹配：${account.address}`)
  return account
}

function nowSeconds() {
  return Math.floor(Date.now() / 1_000)
}

function bpsFloor(value, bps) {
  return (value * (10_000n - bps)) / 10_000n
}

function wrappingSub(left, right) {
  return (left - right + UINT256_MODULUS) % UINT256_MODULUS
}

function positionStateId(tokenId, tickLower, tickUpper) {
  const salt = padHex(toHex(tokenId), { size: 32 })
  return keccak256(
    encodePacked(['address', 'int24', 'int24', 'bytes32'], [POSITION_MANAGER, tickLower, tickUpper, salt]),
  )
}

async function poolState() {
  const [[sqrtPriceX96, tick, protocolFee, lpFee], liquidity] = await Promise.all([
    publicClient.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [SPY_PAIR_POOL_ID],
    }),
    publicClient.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [SPY_PAIR_POOL_ID],
    }),
  ])
  if (sqrtPriceX96 === 0n || liquidity === 0n || lpFee !== POOL_FEE) throw new Error('PAIR/SPY 池状态异常')
  return { sqrtPriceX96, tick, protocolFee, lpFee, liquidity }
}

function makePool(state) {
  const spy = new Token(CHAIN_ID, SPY, 18, 'SPY', 'Robinhood SPY Stock Token')
  const pair = new Token(CHAIN_ID, PAIR, 18, 'PAIR', 'PAIR')
  const pool = new Pool(
    spy,
    pair,
    POOL_FEE,
    TICK_SPACING,
    SPY_PAIR_HOOK,
    state.sqrtPriceX96.toString(),
    state.liquidity.toString(),
    state.tick,
  )
  if (pool.poolId.toLowerCase() !== SPY_PAIR_POOL_ID) throw new Error(`SDK PoolId 不匹配：${pool.poolId}`)
  return pool
}

async function accruedFees(tokenId, tickLower, tickUpper) {
  const positionId = positionStateId(tokenId, tickLower, tickUpper)
  const [[liquidity, last0, last1], [inside0, inside1]] = await Promise.all([
    publicClient.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getPositionInfo',
      args: [SPY_PAIR_POOL_ID, positionId],
    }),
    publicClient.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getFeeGrowthInside',
      args: [SPY_PAIR_POOL_ID, tickLower, tickUpper],
    }),
  ])
  return {
    liquidity,
    spyWei: (liquidity * wrappingSub(inside0, last0)) / Q128,
    pairWei: (liquidity * wrappingSub(inside1, last1)) / Q128,
  }
}

async function discoverNonzeroPositions() {
  const manifest = readJson(MANIFEST_PATH)
  if (!manifest?.positions?.length) throw new Error('生命周期 manifest 不存在或为空')
  const records = [...manifest.positions]
  if (SINGLE_ROLL_MODE && !records.some((record) => String(record.tokenId) === SINGLE_ROLL_SOURCE_TOKEN_ID)) {
    records.push({
      tokenId: SINGLE_ROLL_SOURCE_TOKEN_ID,
      tickLower: SINGLE_ROLL_SOURCE_TICK_LOWER,
      tickUpper: SINGLE_ROLL_SOURCE_TICK_UPPER,
      poolKind: 'pair-spy',
      label: `待迁移单边仓 NFT ${SINGLE_ROLL_SOURCE_TOKEN_ID}`,
    })
  }
  const reads = await Promise.all(
    records.map(async (record) => {
      const tokenId = BigInt(record.tokenId)
      const [owner, liquidity] = await Promise.all([
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_ABI,
          functionName: 'ownerOf',
          args: [tokenId],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_ABI,
          functionName: 'getPositionLiquidity',
          args: [tokenId],
        }),
      ])
      return { record, tokenId, owner, liquidity }
    }),
  )
  const nonzero = reads.filter((item) => item.liquidity > 0n)
  const foreign = nonzero.filter((item) => item.owner.toLowerCase() !== WALLET.toLowerCase())
  if (foreign.length) throw new Error(`非空 NFT 所有权不匹配：${foreign.map((item) => item.tokenId).join(',')}`)
  const unsupported = nonzero.filter((item) => item.record.poolKind !== 'pair-spy')
  if (unsupported.length)
    throw new Error(
      `存在未纳入本流程的非空 LP：${unsupported.map((item) => `${item.tokenId}/${item.record.poolKind}`).join(',')}`,
    )
  if (!nonzero.length) throw new Error('钱包没有非空 LP')
  const positions = []
  for (const item of nonzero) {
    if (!Number.isInteger(item.record.tickLower) || !Number.isInteger(item.record.tickUpper))
      throw new Error(`NFT ${item.tokenId} 缺少 Tick`)
    const fees = await accruedFees(item.tokenId, item.record.tickLower, item.record.tickUpper)
    if (fees.liquidity !== item.liquidity) throw new Error(`NFT ${item.tokenId} 的流动性读回不一致`)
    positions.push({
      tokenId: item.tokenId.toString(),
      tickLower: item.record.tickLower,
      tickUpper: item.record.tickUpper,
      liquidity: item.liquidity.toString(),
      estimatedFeeSpyWei: fees.spyWei.toString(),
      estimatedFeePairWei: fees.pairWei.toString(),
    })
  }
  return positions.sort((a, b) => Number(a.tokenId) - Number(b.tokenId))
}

async function assertPositionsUnchanged(positions) {
  for (const position of positions) {
    const tokenId = BigInt(position.tokenId)
    const [owner, liquidity] = await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_ABI,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
      }),
    ])
    if (owner.toLowerCase() !== WALLET.toLowerCase() || liquidity !== BigInt(position.liquidity)) {
      throw new Error(`NFT ${position.tokenId} 所有权或 liquidity 已变化`)
    }
  }
}

function buildCollectBatch(positions, state) {
  const pool = makePool(state)
  const calls = positions.map((record) => {
    const position = new Position({
      pool,
      liquidity: record.liquidity,
      tickLower: record.tickLower,
      tickUpper: record.tickUpper,
    })
    return V4PositionManager.collectCallParameters(position, {
      tokenId: record.tokenId,
      recipient: WALLET,
      slippageTolerance: new Percent(50, 10_000),
      deadline: BigInt(nowSeconds() + 300).toString(),
      hookData: '0x',
    }).calldata
  })
  return encodeFunctionData({ abi: POSITION_MANAGER_MULTICALL_ABI, functionName: 'multicall', args: [calls] })
}

async function quoteSpyToPair(amountIn) {
  if (amountIn <= 0n) return { amountOut: 0n, gasEstimate: 0n }
  const { result } = await publicClient.simulateContract({
    address: V4_QUOTER,
    abi: V4_QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey, zeroForOne: true, exactAmount: amountIn, hookData: '0x' }],
    account: WALLET,
  })
  const amountOut = Array.isArray(result) ? result[0] : result.amountOut
  const gasEstimate = Array.isArray(result) ? result[1] : result.gasEstimate
  if (amountOut <= 0n) throw new Error('SPY→PAIR 报价为 0')
  return { amountOut, gasEstimate }
}

function buildSwapData(amountIn, minimumOut) {
  const swap = encodeAbiParameters(
    parseAbiParameters(
      '((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData) params',
    ),
    [[poolKey, true, amountIn, minimumOut, 0n, '0x']],
  )
  const settle = encodeAbiParameters(parseAbiParameters('address currency,uint256 amount,bool payerIsUser'), [
    SPY,
    amountIn,
    true,
  ])
  const take = encodeAbiParameters(parseAbiParameters('address currency,address recipient,uint256 amount'), [
    PAIR,
    WALLET,
    0n,
  ])
  const input = encodeAbiParameters(parseAbiParameters('bytes actions,bytes[] params'), [
    '0x060b0e',
    [swap, settle, take],
  ])
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: ['0x10', [input], BigInt(nowSeconds() + 300)],
  })
}

async function ethUsdgQuote() {
  const amountIn = parseEther('0.01')
  const candidates = []
  for (const fee of [100, 500, 3_000, 10_000]) {
    const pathBytes = encodePacked(['address', 'uint24', 'address'], [WETH, fee, USDG])
    try {
      const { result } = await publicClient.simulateContract({
        address: V3_QUOTER,
        abi: V3_QUOTER_ABI,
        functionName: 'quoteExactInput',
        args: [pathBytes, amountIn],
        account: WALLET,
      })
      if (result[0] > 0n) candidates.push({ fee, amountOut: result[0] })
    } catch {
      // The fee tier does not exist or is not liquid.
    }
  }
  candidates.sort((a, b) => (a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : 0))
  if (!candidates.length) throw new Error('无法取得 ETH/USDG 链上报价')
  return { amountIn, ...candidates[0] }
}

async function balances() {
  const [eth, spy, pair, usdg] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  return { eth, spy, pair, usdg }
}

async function nonces() {
  const [latest, pending] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  return { latest, pending }
}

async function transactionBudget(to, data) {
  await publicClient.call({ account: WALLET, to, data })
  const [estimatedGas, gasPrice] = await Promise.all([
    publicClient.estimateGas({ account: WALLET, to, data }),
    publicClient.getGasPrice(),
  ])
  const gasLimit = (estimatedGas * 120n) / 100n + 10_000n
  const sendGasPrice = (gasPrice * SEND_GAS_PRICE_BPS + 9_999n) / 10_000n
  return { estimatedGas, gasPrice, gasLimit, sendGasPrice, sendCeilingWei: gasLimit * sendGasPrice }
}

function quoteRetentionBps(amountIn, amountOut, tick) {
  if (amountIn <= 0n) return 10_000n
  const spotOut = Number(formatUnits(amountIn, 18)) * Math.pow(1.0001, tick)
  if (!Number.isFinite(spotOut) || spotOut <= 0) throw new Error('无法计算 SPY→PAIR 现货保留率')
  return BigInt(Math.floor((Number(formatUnits(amountOut, 18)) / spotOut) * 10_000))
}

async function preflight({ print = true, requireReady = false } = {}) {
  const existing = readJson(STATE_PATH)
  if (existing && existing.status !== 'complete') {
    const report = { status: 'RESUME_REQUIRED', operationId: existing.operationId, phase: existing.status }
    if (print) console.log(stringify(report))
    return { existing, report }
  }
  if ((await publicClient.getChainId()) !== CHAIN_ID) throw new Error('RPC chainId 不匹配')
  const [blockNumber, walletBalances, nonceState, positions, currentPool, ethQuote] = await Promise.all([
    publicClient.getBlockNumber(),
    balances(),
    nonces(),
    discoverNonzeroPositions(),
    poolState(),
    ethUsdgQuote(),
  ])
  if (nonceState.latest !== nonceState.pending)
    throw new Error(`存在 pending nonce：${nonceState.latest}/${nonceState.pending}`)
  const feeSpy = positions.reduce((sum, item) => sum + BigInt(item.estimatedFeeSpyWei), 0n)
  const feePair = positions.reduce((sum, item) => sum + BigInt(item.estimatedFeePairWei), 0n)
  if (feeSpy === 0n && feePair === 0n) throw new Error('当前没有可领取手续费')
  const collectData = buildCollectBatch(positions, currentPool)
  const collectBudget = await transactionBudget(POSITION_MANAGER, collectData)
  const [erc20Allowance, permit2Allowance] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
    publicClient.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [WALLET, SPY, UNIVERSAL_ROUTER],
    }),
  ])
  const approvalsReady =
    feeSpy === 0n ||
    (erc20Allowance >= feeSpy && permit2Allowance[0] >= feeSpy && permit2Allowance[1] > BigInt(nowSeconds() + 600))
  let swapQuote = { amountOut: 0n, gasEstimate: 0n }
  let swapBudget = {
    estimatedGas: 0n,
    gasPrice: collectBudget.gasPrice,
    gasLimit: 0n,
    sendGasPrice: collectBudget.sendGasPrice,
    sendCeilingWei: 0n,
  }
  let retentionBps = 10_000n
  if (feeSpy > 0n) {
    swapQuote = await quoteSpyToPair(feeSpy)
    retentionBps = quoteRetentionBps(feeSpy, swapQuote.amountOut, currentPool.tick)
    swapBudget = await transactionBudget(
      UNIVERSAL_ROUTER,
      buildSwapData(feeSpy, bpsFloor(swapQuote.amountOut, SLIPPAGE_BPS)),
    )
  }
  const totalSendCeilingWei = collectBudget.sendCeilingWei + swapBudget.sendCeilingWei
  const totalGasUsdg = (totalSendCeilingWei * ethQuote.amountOut) / ethQuote.amountIn
  const maximumTotalGasWei = (MAX_TOTAL_GAS_USDG * ethQuote.amountIn) / ethQuote.amountOut
  const balanceReady = walletBalances.eth >= totalSendCeilingWei + MIN_FINAL_ETH
  const gasReady = totalGasUsdg <= MAX_TOTAL_GAS_USDG
  const quoteReady = retentionBps >= MIN_QUOTE_RETENTION_BPS
  const status = !approvalsReady
    ? 'APPROVAL_REQUIRED'
    : !quoteReady
      ? 'BAD_QUOTE'
      : !gasReady
        ? 'WAIT_GAS'
        : !balanceReady
          ? 'NEEDS_ETH_TOP_UP'
          : 'READY'
  const report = {
    status,
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest: nonceState.latest,
    noncePending: nonceState.pending,
    baselineBalances: {
      eth: formatEther(walletBalances.eth),
      spy: formatUnits(walletBalances.spy, 18),
      pair: formatUnits(walletBalances.pair, 18),
      usdg: formatUnits(walletBalances.usdg, 6),
    },
    positions: positions.map((item) => ({
      tokenId: item.tokenId,
      tickLower: item.tickLower,
      tickUpper: item.tickUpper,
      liquidity: item.liquidity,
      estimatedFeeSpy: formatUnits(BigInt(item.estimatedFeeSpyWei), 18),
      estimatedFeePair: formatUnits(BigInt(item.estimatedFeePairWei), 18),
    })),
    estimatedFees: { spy: formatUnits(feeSpy, 18), pair: formatUnits(feePair, 18) },
    swap: {
      exactInputSource: 'post-claim wallet delta; estimate shown here only for full-workflow gas modeling',
      estimatedSpyInput: formatUnits(feeSpy, 18),
      quotedPairOut: formatUnits(swapQuote.amountOut, 18),
      minimumPairOut: formatUnits(bpsFloor(swapQuote.amountOut, SLIPPAGE_BPS), 18),
      quoteRetentionPct: Number(retentionBps) / 100,
      approvalsReady,
    },
    gas: {
      gasPriceGwei: formatUnits(collectBudget.gasPrice, 9),
      collectEstimatedUnits: collectBudget.estimatedGas,
      collectSendCeilingEth: formatEther(collectBudget.sendCeilingWei),
      swapEstimatedUnits: swapBudget.estimatedGas,
      swapSendCeilingEth: formatEther(swapBudget.sendCeilingWei),
      totalSendCeilingEth: formatEther(totalSendCeilingWei),
      totalSendCeilingUsdg: formatUnits(totalGasUsdg, 6),
      maximumTotalGasUsdg: formatUnits(MAX_TOTAL_GAS_USDG, 6),
      minimumFinalEth: formatEther(MIN_FINAL_ETH),
      ethUsdgQuote: formatUnits(ethQuote.amountOut, 6),
    },
    policy: {
      collectEveryNonzeroLp: true,
      swapOnlySpyReceivedByThisClaim: true,
      protectedBaselineSpyWei: walletBalances.spy,
      protectedBaselineUsdgAtomic: walletBalances.usdg,
      preserveAllLpLiquidity: true,
      noReinvest: true,
      slippageBps: Number(SLIPPAGE_BPS),
    },
  }
  appendAudit('fee_spy_only_preflight', report)
  if (print) console.log(stringify(report))
  if (requireReady && status !== 'READY') throw new Error(`预检未就绪：${status}`)
  return {
    report,
    blockNumber,
    positions,
    currentPool,
    balances: walletBalances,
    nonceState,
    gasPolicy: {
      maximumGasUsdg: formatUnits(MAX_TOTAL_GAS_USDG, 6),
      maximumGasWei: maximumTotalGasWei.toString(),
      minimumFinalEthWei: MIN_FINAL_ETH.toString(),
      modeledCollectSendCeilingWei: collectBudget.sendCeilingWei.toString(),
      modeledSwapSendCeilingWei: swapBudget.sendCeilingWei.toString(),
      modeledFirstTwoSendCeilingWei: totalSendCeilingWei.toString(),
    },
    ethQuote,
  }
}

function gasSpent(state) {
  return Object.values(state.steps || {}).reduce((sum, step) => sum + BigInt(step.gasCostWei || 0), 0n)
}

async function runStep(walletClient, state, key, { label, to, data, remainingGasWei = 0n, metadata = {} }) {
  state.steps ||= {}
  let step = state.steps[key]
  if (step?.status === 'confirmed') return step
  if (step?.hash) {
    let receipt
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: step.hash })
    } catch {
      throw new Error(`${label} 已有哈希但回执未知，禁止重发：${step.hash}`)
    }
    if (receipt.status !== 'success') throw new Error(`${label} 链上失败：${step.hash}`)
    step.status = 'confirmed'
    step.blockNumber = receipt.blockNumber.toString()
    step.gasUsed = receipt.gasUsed.toString()
    step.effectiveGasPrice = receipt.effectiveGasPrice.toString()
    step.gasCostWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString()
    writeState(state)
    appendAudit('receipt_success', {
      key,
      label,
      hash: step.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      gasCostWei: step.gasCostWei,
    })
    return step
  }

  const budget = await transactionBudget(to, data)
  const spent = gasSpent(state)
  if (spent + budget.sendCeilingWei + remainingGasWei > BigInt(state.gasPolicy.maximumGasWei)) {
    throw new Error(`${label} 的完整流程 Gas 上限超过 ${state.gasPolicy.maximumGasUsdg} USDG`)
  }
  const walletEth = await publicClient.getBalance({ address: WALLET })
  if (walletEth < budget.sendCeilingWei + remainingGasWei + BigInt(state.gasPolicy.minimumFinalEthWei)) {
    throw new Error(`${label} ETH 不足以覆盖本笔、后续步骤和保留金`)
  }
  const nonceState = await nonces()
  if (nonceState.latest !== nonceState.pending) throw new Error(`${label} 广播前存在 pending nonce`)
  step = {
    ...metadata,
    status: 'prepared',
    label,
    nonce: nonceState.pending,
    gasEstimate: budget.estimatedGas.toString(),
    gasLimit: budget.gasLimit.toString(),
    gasPriceWei: budget.gasPrice.toString(),
    sendGasPriceWei: budget.sendGasPrice.toString(),
    sendCeilingWei: budget.sendCeilingWei.toString(),
  }
  state.steps[key] = step
  writeState(state)
  appendAudit('transaction_prepared', { key, ...step })
  let hash
  try {
    hash = await walletClient.sendTransaction({
      account: walletClient.account,
      to,
      data,
      gas: budget.gasLimit,
      gasPrice: budget.sendGasPrice,
      nonce: nonceState.pending,
    })
  } catch (error) {
    step.status = 'failed_before_hash'
    step.error = error.shortMessage || error.message
    writeState(state)
    appendAudit('broadcast_failed_before_hash', { key, label, message: step.error })
    throw error
  }
  step.hash = hash
  step.status = 'broadcast'
  writeState(state)
  appendAudit('broadcast', { key, label, hash })
  let receipt
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 })
  } catch (error) {
    step.status = 'receipt_unknown'
    step.error = error.shortMessage || error.message
    writeState(state)
    appendAudit('receipt_unknown', { key, label, hash, message: step.error })
    throw new Error(`${label} 已广播但回执未知，禁止自动重发：${hash}`)
  }
  if (receipt.status !== 'success') {
    step.status = 'reverted'
    writeState(state)
    appendAudit('receipt_reverted', { key, label, hash, blockNumber: receipt.blockNumber })
    throw new Error(`${label} 链上回执失败：${hash}`)
  }
  step.status = 'confirmed'
  step.blockNumber = receipt.blockNumber.toString()
  step.gasUsed = receipt.gasUsed.toString()
  step.effectiveGasPrice = receipt.effectiveGasPrice.toString()
  step.gasCostWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString()
  writeState(state)
  appendAudit('receipt_success', {
    key,
    label,
    hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    gasCostWei: step.gasCostWei,
  })
  console.log(`${label}: ${hash} (${EXPLORER_TX}${hash})`)
  return step
}

async function collect(walletClient, state) {
  const prior = state.steps?.collect_all_fees
  if (prior?.status === 'confirmed' && prior.received) return
  if (prior?.status === 'confirmed') {
    const after = await balances()
    prior.received = {
      spyWei: (after.spy - BigInt(state.baseline.spyWei)).toString(),
      pairWei: (after.pair - BigInt(state.baseline.pairWei)).toString(),
      usdgAtomic: (after.usdg - BigInt(state.baseline.usdgAtomic)).toString(),
    }
    writeState(state)
    return
  }
  await assertPositionsUnchanged(state.pairPositions)
  const before = await balances()
  if (
    before.spy !== BigInt(state.baseline.spyWei) ||
    before.pair !== BigInt(state.baseline.pairWei) ||
    before.usdg !== BigInt(state.baseline.usdgAtomic)
  ) {
    throw new Error('领取前钱包代币余额偏离预检基线，禁止误归因或动用新增资产')
  }
  const data = buildCollectBatch(state.pairPositions, await poolState())
  const step = await runStep(walletClient, state, 'collect_all_fees', {
    label: `一笔领取 ${state.pairPositions.length} 个非空 PAIR/SPY LP 手续费`,
    to: POSITION_MANAGER,
    data,
    remainingGasWei: BigInt(
      state.gasPolicy.modeledAfterCollectSendCeilingWei || state.gasPolicy.modeledSwapSendCeilingWei,
    ),
    metadata: {
      tokenIds: state.pairPositions.map((item) => item.tokenId),
      spyBeforeWei: before.spy.toString(),
      pairBeforeWei: before.pair.toString(),
      usdgBeforeAtomic: before.usdg.toString(),
    },
  })
  const after = await balances()
  if (after.spy < before.spy || after.pair < before.pair || after.usdg !== before.usdg)
    throw new Error('领取后余额不符合仅领取手续费的约束')
  step.received = {
    spyWei: (after.spy - before.spy).toString(),
    pairWei: (after.pair - before.pair).toString(),
    usdgAtomic: '0',
  }
  writeState(state)
  await assertPositionsUnchanged(state.pairPositions)
}

async function swapClaimedSpy(walletClient, state) {
  const prior = state.steps?.swap_claimed_spy_to_pair
  if (prior?.status === 'confirmed' && prior.actualPairOutWei) return
  const claim = state.steps?.collect_all_fees?.received
  if (!claim) throw new Error('领取结果尚未固化')
  const amountIn = BigInt(claim.spyWei)
  if (amountIn === 0n) {
    state.steps.swap_claimed_spy_to_pair = {
      status: 'confirmed',
      label: '本次未领取 SPY，无需兑换',
      gasCostWei: '0',
      spyInputWei: '0',
      actualPairOutWei: '0',
      minimumPairOutWei: '0',
    }
    writeState(state)
    return
  }
  if (prior?.status === 'confirmed') {
    const after = await balances()
    if (after.spy !== BigInt(state.baseline.spyWei)) throw new Error('已确认兑换的 SPY 基线回读不符')
    prior.actualPairOutWei = (after.pair - BigInt(prior.pairBeforeWei)).toString()
    writeState(state)
    return
  }
  await assertPositionsUnchanged(state.pairPositions)
  const before = await balances()
  const expectedSpy = BigInt(state.baseline.spyWei) + amountIn
  const expectedPair = BigInt(state.baseline.pairWei) + BigInt(claim.pairWei)
  if (before.spy !== expectedSpy || before.pair !== expectedPair || before.usdg !== BigInt(state.baseline.usdgAtomic)) {
    throw new Error('兑换前余额与“原余额 + 本次领取”不一致，禁止动用原有 SPY')
  }
  const [erc20Allowance, permit2Allowance, currentPool] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
    publicClient.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [WALLET, SPY, UNIVERSAL_ROUTER],
    }),
    poolState(),
  ])
  if (
    erc20Allowance < amountIn ||
    permit2Allowance[0] < amountIn ||
    permit2Allowance[1] <= BigInt(nowSeconds() + 300)
  ) {
    throw new Error('SPY 授权不足；本流程禁止临时追加未建模授权交易')
  }
  const quote = await quoteSpyToPair(amountIn)
  const retentionBps = quoteRetentionBps(amountIn, quote.amountOut, currentPool.tick)
  if (retentionBps < MIN_QUOTE_RETENTION_BPS) throw new Error(`SPY→PAIR 报价保留率过低：${Number(retentionBps) / 100}%`)
  const minimumOut = bpsFloor(quote.amountOut, SLIPPAGE_BPS)
  const data = buildSwapData(amountIn, minimumOut)
  const step = await runStep(walletClient, state, 'swap_claimed_spy_to_pair', {
    label: '仅将本次领取的 SPY 精确兑换为 PAIR',
    to: UNIVERSAL_ROUTER,
    data,
    remainingGasWei: BigInt(state.gasPolicy.modeledAfterSwapSendCeilingWei || 0),
    metadata: {
      spyInputWei: amountIn.toString(),
      pairBeforeWei: before.pair.toString(),
      quotedPairOutWei: quote.amountOut.toString(),
      minimumPairOutWei: minimumOut.toString(),
      quoteRetentionBps: retentionBps.toString(),
    },
  })
  const after = await balances()
  const pairOut = after.pair - before.pair
  if (
    after.spy !== BigInt(state.baseline.spyWei) ||
    after.usdg !== BigInt(state.baseline.usdgAtomic) ||
    pairOut < minimumOut
  ) {
    throw new Error('兑换后余额未满足“原 SPY 不动”的硬约束')
  }
  step.actualPairOutWei = pairOut.toString()
  writeState(state)
  await assertPositionsUnchanged(state.pairPositions)
}

function signed24(value) {
  const mask = (1n << 24n) - 1n
  const unsigned = BigInt(value) & mask
  return Number(unsigned >= 1n << 23n ? unsigned - (1n << 24n) : unsigned)
}

async function readSingleRollSource() {
  const tokenId = BigInt(SINGLE_ROLL_SOURCE_TOKEN_ID)
  const [owner, liquidity, poolAndInfo] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'getPoolAndPositionInfo',
      args: [tokenId],
    }),
  ])
  const [sourcePoolKey, info] = poolAndInfo
  const tickLower = signed24(info >> 8n)
  const tickUpper = signed24(info >> 32n)
  if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`待迁移 NFT ${tokenId} 不在执行钱包`)
  if (liquidity === 0n) throw new Error(`待迁移 NFT ${tokenId} 已无流动性`)
  if (
    sourcePoolKey.currency0.toLowerCase() !== SPY.toLowerCase() ||
    sourcePoolKey.currency1.toLowerCase() !== PAIR.toLowerCase() ||
    Number(sourcePoolKey.fee) !== POOL_FEE ||
    Number(sourcePoolKey.tickSpacing) !== TICK_SPACING ||
    sourcePoolKey.hooks.toLowerCase() !== SPY_PAIR_HOOK.toLowerCase()
  )
    throw new Error(`待迁移 NFT ${tokenId} 不属于目标 PAIR/SPY 池`)
  if (tickLower !== SINGLE_ROLL_SOURCE_TICK_LOWER || tickUpper !== SINGLE_ROLL_SOURCE_TICK_UPPER) {
    throw new Error(`待迁移 NFT ${tokenId} 区间不匹配：链上=[${tickLower},${tickUpper})`)
  }
  return { tokenId, owner, liquidity, tickLower, tickUpper }
}

function buildFullRemove(source, currentPool) {
  const position = new Position({
    pool: makePool(currentPool),
    liquidity: source.liquidity.toString(),
    tickLower: source.tickLower,
    tickUpper: source.tickUpper,
  })
  const method = V4PositionManager.removeCallParameters(position, {
    tokenId: source.tokenId.toString(),
    liquidityPercentage: new Percent(1, 1),
    burnToken: false,
    slippageTolerance: new Percent(100, 10_000),
    deadline: BigInt(nowSeconds() + 300).toString(),
    hookData: '0x',
  })
  return {
    data: method.calldata,
    principalSpyWei: BigInt(position.amount0.quotient.toString()),
    principalPairWei: BigInt(position.amount1.quotient.toString()),
  }
}

async function signPairOnlyPermit(account, amount1Max) {
  if (amount1Max <= 0n || amount1Max > UINT160_MAX) throw new Error('单边 PAIR Permit2 金额无效')
  const [, , nonce] = await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [WALLET, PAIR, POSITION_MANAGER],
  })
  const permitBatch = {
    details: [
      {
        token: PAIR,
        amount: amount1Max,
        expiration: BigInt(nowSeconds() + 30 * 60),
        nonce,
      },
    ],
    spender: POSITION_MANAGER,
    sigDeadline: BigInt(nowSeconds() + 5 * 60),
  }
  const signature = await account.signTypedData({
    domain: { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2 },
    types: {
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
      PermitBatch: [
        { name: 'details', type: 'PermitDetails[]' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
    },
    primaryType: 'PermitBatch',
    message: permitBatch,
  })
  return { owner: WALLET, permitBatch, signature }
}

async function signPositionIncreasePermit(account, amount0Max, amount1Max) {
  const requested = [
    { token: SPY, amount: amount0Max },
    { token: PAIR, amount: amount1Max },
  ].filter((item) => item.amount > 0n)
  if (!requested.length || requested.some((item) => item.amount > UINT160_MAX)) throw new Error('追加 Permit2 金额无效')
  const allowances = await Promise.all(
    requested.map((item) =>
      publicClient.readContract({
        address: PERMIT2,
        abi: PERMIT2_ABI,
        functionName: 'allowance',
        args: [WALLET, item.token, POSITION_MANAGER],
      }),
    ),
  )
  const permitBatch = {
    details: requested.map((item, index) => ({
      token: item.token,
      amount: item.amount,
      expiration: BigInt(nowSeconds() + 30 * 60),
      nonce: allowances[index][2],
    })),
    spender: POSITION_MANAGER,
    sigDeadline: BigInt(nowSeconds() + 5 * 60),
  }
  const signature = await account.signTypedData({
    domain: { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2 },
    types: {
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
      PermitBatch: [
        { name: 'details', type: 'PermitDetails[]' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
    },
    primaryType: 'PermitBatch',
    message: permitBatch,
  })
  return { owner: WALLET, permitBatch, signature }
}

async function buildSingleSidedMint(account, pairAmount) {
  if (pairAmount <= 0n) throw new Error('没有可用于单边重建的 PAIR')
  const currentPool = await poolState()
  if (currentPool.tick < SINGLE_ROLL_TARGET_TICK_UPPER) {
    throw new Error(`PAIR 已进入目标区间，无法继续按单边 PAIR 建仓：tick=${currentPool.tick}`)
  }
  const position = Position.fromAmount1({
    pool: makePool(currentPool),
    tickLower: SINGLE_ROLL_TARGET_TICK_LOWER,
    tickUpper: SINGLE_ROLL_TARGET_TICK_UPPER,
    amount1: pairAmount.toString(),
  })
  const liquidity = BigInt(position.liquidity.toString())
  const desired = position.mintAmounts
  const maximums = position.mintAmountsWithSlippage(SINGLE_ROLL_MINT_SLIPPAGE)
  const amount0Desired = BigInt(desired.amount0.toString())
  const amount1Desired = BigInt(desired.amount1.toString())
  const amount0Max = BigInt(maximums.amount0.toString())
  const amount1Max = BigInt(maximums.amount1.toString())
  if (liquidity === 0n || amount0Desired !== 0n || amount0Max !== 0n) {
    throw new Error(`目标不再是单边 PAIR：liquidity=${liquidity}, desiredSPY=${amount0Desired}, maxSPY=${amount0Max}`)
  }
  if (amount1Desired <= 0n || amount1Max > pairAmount) throw new Error('单边 PAIR 用量超过可用余额')
  if (amount1Desired * 10_000n < pairAmount * SINGLE_ROLL_MIN_PAIR_USE_BPS) {
    throw new Error(`单边建仓预计使用 PAIR 不足 99.99%：desired=${amount1Desired}, available=${pairAmount}`)
  }
  const batchPermit = await signPairOnlyPermit(account, amount1Max)
  const method = V4PositionManager.addCallParameters(position, {
    recipient: WALLET,
    slippageTolerance: SINGLE_ROLL_MINT_SLIPPAGE,
    deadline: BigInt(nowSeconds() + 300).toString(),
    hookData: '0x',
    batchPermit,
  })
  return {
    currentPool,
    position,
    liquidity,
    amount0Desired,
    amount1Desired,
    amount0Max,
    amount1Max,
    data: method.calldata,
  }
}

function validatePositionIncreaseParameters() {
  if (
    !/^\d+$/.test(POSITION_INCREASE_TARGET_TOKEN_ID) ||
    !Number.isSafeInteger(POSITION_INCREASE_TARGET_TICK_LOWER) ||
    !Number.isSafeInteger(POSITION_INCREASE_TARGET_TICK_UPPER) ||
    POSITION_INCREASE_TARGET_TICK_LOWER >= POSITION_INCREASE_TARGET_TICK_UPPER ||
    POSITION_INCREASE_TARGET_TICK_LOWER % TICK_SPACING !== 0 ||
    POSITION_INCREASE_TARGET_TICK_UPPER % TICK_SPACING !== 0
  )
    throw new Error('单边追加目标 NFT 或 Tick 参数无效')
}

async function readPositionIncreaseTarget() {
  validatePositionIncreaseParameters()
  const tokenId = BigInt(POSITION_INCREASE_TARGET_TOKEN_ID)
  const [owner, liquidity, poolAndInfo] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'getPoolAndPositionInfo',
      args: [tokenId],
    }),
  ])
  const [targetPoolKey, info] = poolAndInfo
  const tickLower = signed24(info >> 8n)
  const tickUpper = signed24(info >> 32n)
  if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`目标 NFT ${tokenId} 不在执行钱包`)
  if (liquidity === 0n) throw new Error(`目标 NFT ${tokenId} 已无流动性`)
  if (
    targetPoolKey.currency0.toLowerCase() !== SPY.toLowerCase() ||
    targetPoolKey.currency1.toLowerCase() !== PAIR.toLowerCase() ||
    Number(targetPoolKey.fee) !== POOL_FEE ||
    Number(targetPoolKey.tickSpacing) !== TICK_SPACING ||
    targetPoolKey.hooks.toLowerCase() !== SPY_PAIR_HOOK.toLowerCase()
  )
    throw new Error(`目标 NFT ${tokenId} 不属于目标 PAIR/SPY 池`)
  if (tickLower !== POSITION_INCREASE_TARGET_TICK_LOWER || tickUpper !== POSITION_INCREASE_TARGET_TICK_UPPER) {
    throw new Error(`目标 NFT ${tokenId} 区间不匹配：链上=[${tickLower},${tickUpper})`)
  }
  return { tokenId, owner, liquidity, tickLower, tickUpper }
}

async function buildPositionPairOnlyIncrease(account, target, walletSpyWei, walletPairWei) {
  if (walletPairWei <= 0n) throw new Error('钱包没有可用于追加的 PAIR')
  const [currentPool, fees] = await Promise.all([
    poolState(),
    accruedFees(target.tokenId, target.tickLower, target.tickUpper),
  ])
  if (currentPool.tick < target.tickLower)
    throw new Error(`PAIR 已涨出目标区间，无法按授权配比追加：tick=${currentPool.tick}`)
  if (fees.liquidity !== target.liquidity) throw new Error('目标 NFT 手续费读回的 liquidity 不一致')
  const inRange = currentPool.tick < target.tickUpper
  if (!inRange) assertPairOnlyBoundary(currentPool.tick, target.tickUpper)
  const walletPairBudgetWei = authorizedPairBudget(walletPairWei, POSITION_INCREASE_MAX_WALLET_PAIR_WEI)
  const walletSpyBudgetWei = inRange
    ? walletSpyWei < POSITION_INCREASE_MAX_WALLET_SPY
      ? walletSpyWei
      : POSITION_INCREASE_MAX_WALLET_SPY
    : 0n
  if (inRange && walletSpyBudgetWei <= 0n)
    throw new Error(`PAIR 已进入目标区间，需要 SPY 配平：tick=${currentPool.tick}`)
  const availableSpyWei = walletSpyBudgetWei + fees.spyWei
  const availablePairWei = walletPairBudgetWei + fees.pairWei
  const pool = makePool(currentPool)
  const rawPosition = inRange
    ? Position.fromAmounts({
        pool,
        tickLower: target.tickLower,
        tickUpper: target.tickUpper,
        amount0: availableSpyWei.toString(),
        amount1: availablePairWei.toString(),
        useFullPrecision: true,
      })
    : Position.fromAmount1({
        pool,
        tickLower: target.tickLower,
        tickUpper: target.tickUpper,
        amount1: availablePairWei.toString(),
      })
  const rawLiquidity = BigInt(rawPosition.liquidity.toString())
  const rawMaximums = rawPosition.mintAmountsWithSlippage(POSITION_INCREASE_MINT_SLIPPAGE)
  const rawAmount0Max = BigInt(rawMaximums.amount0.toString())
  const rawAmount1Max = BigInt(rawMaximums.amount1.toString())
  const scaleBase = 10n ** 18n
  let scale = scaleBase
  if (rawAmount0Max > 0n)
    scale =
      scale < (availableSpyWei * scaleBase) / rawAmount0Max ? scale : (availableSpyWei * scaleBase) / rawAmount0Max
  if (rawAmount1Max > 0n)
    scale =
      scale < (availablePairWei * scaleBase) / rawAmount1Max ? scale : (availablePairWei * scaleBase) / rawAmount1Max
  scale = inRange ? (scale * 9_999n) / 10_000n : (scale * POSITION_INCREASE_PAIR_ONLY_SAFETY_PPM) / 1_000_000n
  let liquidity = (rawLiquidity * scale) / scaleBase
  if (liquidity <= 0n) throw new Error('授权资产在滑点保护后无法增加流动性')
  let position = new Position({
    pool,
    liquidity: liquidity.toString(),
    tickLower: target.tickLower,
    tickUpper: target.tickUpper,
  })
  let maximums = position.mintAmountsWithSlippage(POSITION_INCREASE_MINT_SLIPPAGE)
  let amount0Max = BigInt(maximums.amount0.toString())
  let amount1Max = BigInt(maximums.amount1.toString())
  let externalSpyMax = amount0Max > fees.spyWei ? amount0Max - fees.spyWei : 0n
  let externalPairMax = amount1Max > fees.pairWei ? amount1Max - fees.pairWei : 0n
  for (
    let attempt = 0;
    attempt < 8 && (externalSpyMax > walletSpyBudgetWei || externalPairMax > walletPairBudgetWei);
    attempt += 1
  ) {
    liquidity = (liquidity * 9_995n) / 10_000n
    position = new Position({
      pool,
      liquidity: liquidity.toString(),
      tickLower: target.tickLower,
      tickUpper: target.tickUpper,
    })
    maximums = position.mintAmountsWithSlippage(POSITION_INCREASE_MINT_SLIPPAGE)
    amount0Max = BigInt(maximums.amount0.toString())
    amount1Max = BigInt(maximums.amount1.toString())
    externalSpyMax = amount0Max > fees.spyWei ? amount0Max - fees.spyWei : 0n
    externalPairMax = amount1Max > fees.pairWei ? amount1Max - fees.pairWei : 0n
  }
  const desired = position.mintAmounts
  const amount0Desired = BigInt(desired.amount0.toString())
  const amount1Desired = BigInt(desired.amount1.toString())
  const externalSpyDesired = amount0Desired > fees.spyWei ? amount0Desired - fees.spyWei : 0n
  const externalPairDesired = amount1Desired > fees.pairWei ? amount1Desired - fees.pairWei : 0n
  if (amount1Desired <= 0n || externalSpyMax > walletSpyBudgetWei || externalPairMax > walletPairBudgetWei) {
    throw new Error('追加所需代币超过授权钱包预算与目标仓内部费用')
  }
  if (!inRange && (amount0Desired !== 0n || amount0Max !== 0n)) throw new Error('目标追加不再是单边 PAIR')
  if (inRange && (amount0Desired <= 0n || amount0Max <= 0n)) throw new Error('目标仓位已在区间内但追加配比不是双边')
  const pairResidualWei = walletPairWei - externalPairDesired
  const protectedPairFloorWei = protectedPairFloor(walletPairWei, walletPairBudgetWei)
  if (!inRange && amount1Desired * 10_000n < availablePairWei * POSITION_INCREASE_MIN_PAIR_USE_BPS) {
    throw new Error(
      `单边追加没有最大化使用钱包 PAIR 与目标仓费用：desired=${amount1Desired}, available=${availablePairWei}`,
    )
  }
  if (
    inRange &&
    (pairResidualWei - protectedPairFloorWei) * 10_000n > walletPairBudgetWei * POSITION_INCREASE_MAX_PAIR_RESIDUAL_BPS
  ) {
    throw new Error(
      `安全配比留下的授权 PAIR 超过 7%：residual=${pairResidualWei - protectedPairFloorWei}, budget=${walletPairBudgetWei}`,
    )
  }
  // Existing-position fees are closed into this increase before settlement. Permit2
  // therefore only needs to authorize the net amount that may leave the wallet,
  // not the position's full gross token maxima.
  const batchPermit = await signPositionIncreasePermit(account, externalSpyMax, externalPairMax)
  const method = V4PositionManager.addCallParameters(position, {
    tokenId: target.tokenId.toString(),
    slippageTolerance: POSITION_INCREASE_MINT_SLIPPAGE,
    deadline: BigInt(nowSeconds() + 300).toString(),
    hookData: '0x',
    batchPermit,
  })
  return {
    currentPool,
    fees,
    mode: inRange ? 'in_range_two_sided' : 'out_of_range_pair_only',
    position,
    liquidity,
    walletSpyBudgetWei,
    walletPairBudgetWei,
    protectedPairFloorWei,
    availableSpyWei,
    availablePairWei,
    amount0Desired,
    amount1Desired,
    amount0Max,
    amount1Max,
    externalSpyDesired,
    externalPairDesired,
    externalSpyMax,
    externalPairMax,
    pairResidualWei,
    data: method.calldata,
  }
}

function parseMintTokenId(receipt) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== POSITION_MANAGER.toLowerCase()) continue
    try {
      const parsed = decodeEventLog({ abi: POSITION_ABI, data: log.data, topics: log.topics })
      if (
        parsed.eventName === 'Transfer' &&
        parsed.args.from.toLowerCase() === '0x0000000000000000000000000000000000000000' &&
        parsed.args.to.toLowerCase() === WALLET.toLowerCase()
      )
        return BigInt(parsed.args.tokenId)
    } catch {
      // Ignore non-ERC721 logs from PositionManager multicall internals.
    }
  }
  return null
}

async function assertSingleRollProtectedUnchanged(state) {
  return assertPositionsUnchanged(state.pairPositions.filter((item) => item.tokenId !== SINGLE_ROLL_SOURCE_TOKEN_ID))
}

async function singleRollPreflight({ print = true, requireReady = false } = {}) {
  const feeCheck = await preflight({ print: false, requireReady: false })
  if (feeCheck.existing) {
    if (print) console.log(stringify(feeCheck.report))
    if (requireReady) throw new Error(`存在待恢复流程：${feeCheck.report.operationId}`)
    return feeCheck
  }
  const source = await readSingleRollSource()
  const sourceRecord = feeCheck.positions.find((item) => item.tokenId === SINGLE_ROLL_SOURCE_TOKEN_ID)
  if (!sourceRecord || BigInt(sourceRecord.liquidity) !== source.liquidity)
    throw new Error('手续费清单未完整纳入待迁移 NFT')
  if (feeCheck.currentPool.tick < SINGLE_ROLL_TARGET_TICK_UPPER) {
    throw new Error(`当前 tick=${feeCheck.currentPool.tick} 已进入目标区间，无法单边重建`)
  }
  const duplicate = feeCheck.positions.find(
    (item) =>
      item.tokenId !== SINGLE_ROLL_SOURCE_TOKEN_ID &&
      item.tickLower === SINGLE_ROLL_TARGET_TICK_LOWER &&
      item.tickUpper === SINGLE_ROLL_TARGET_TICK_UPPER,
  )
  if (duplicate) throw new Error(`目标区间已有非空 NFT ${duplicate.tokenId}`)

  const removal = buildFullRemove(source, feeCheck.currentPool)
  if (removal.principalSpyWei !== 0n || removal.principalPairWei <= 0n) {
    throw new Error(`待迁移 NFT 当前不是纯 PAIR：SPY=${removal.principalSpyWei}, PAIR=${removal.principalPairWei}`)
  }
  const feeSpy = feeCheck.positions.reduce((sum, item) => sum + BigInt(item.estimatedFeeSpyWei), 0n)
  const feePair = feeCheck.positions.reduce((sum, item) => sum + BigInt(item.estimatedFeePairWei), 0n)
  const swapQuote = await quoteSpyToPair(feeSpy)
  const expectedAvailablePair = removal.principalPairWei + feePair + swapQuote.amountOut
  const erc20PairAllowance = await publicClient.readContract({
    address: PAIR,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [WALLET, PERMIT2],
  })
  if (erc20PairAllowance < expectedAvailablePair)
    throw new Error('PAIR 对 Permit2 的 ERC20 授权不足，流程未建模额外授权交易')
  const previewPosition = Position.fromAmount1({
    pool: makePool(feeCheck.currentPool),
    tickLower: SINGLE_ROLL_TARGET_TICK_LOWER,
    tickUpper: SINGLE_ROLL_TARGET_TICK_UPPER,
    amount1: expectedAvailablePair.toString(),
  })
  const previewDesired = previewPosition.mintAmounts
  const previewSpy = BigInt(previewDesired.amount0.toString())
  const previewPair = BigInt(previewDesired.amount1.toString())
  if (previewSpy !== 0n || previewPair * 10_000n < expectedAvailablePair * SINGLE_ROLL_MIN_PAIR_USE_BPS) {
    throw new Error('预览结果不是高利用率单边 PAIR')
  }
  const removeBudget = await transactionBudget(POSITION_MANAGER, removal.data)
  // The wallet does not hold the future withdrawn/claimed PAIR during preflight,
  // so an eth_call of the future mint correctly reverts TRANSFER_FROM_FAILED.
  // Use a conservative 500k-unit ceiling here (recent canonical single-sided
  // mint used 314,252 gas), then rebuild, simulate, and estimate against the
  // actual post-withdrawal balance immediately before broadcast.
  const modeledMintGasLimit = 500_000n
  const modeledMintSendGasPrice = (removeBudget.gasPrice * SEND_GAS_PRICE_BPS + 9_999n) / 10_000n
  const mintBudget = {
    estimatedGas: 500_000n,
    gasPrice: removeBudget.gasPrice,
    gasLimit: modeledMintGasLimit,
    sendGasPrice: modeledMintSendGasPrice,
    sendCeilingWei: modeledMintGasLimit * modeledMintSendGasPrice,
  }
  const firstTwo = BigInt(feeCheck.gasPolicy.modeledFirstTwoSendCeilingWei)
  const totalSendCeilingWei = firstTwo + removeBudget.sendCeilingWei + mintBudget.sendCeilingWei
  const maximumGasWei = BigInt(feeCheck.gasPolicy.maximumGasWei)
  const totalGasUsdg = (totalSendCeilingWei * MAX_TOTAL_GAS_USDG) / maximumGasWei
  const gasReady = totalSendCeilingWei <= maximumGasWei
  const balanceReady = feeCheck.balances.eth >= totalSendCeilingWei + MIN_FINAL_ETH
  const status =
    feeCheck.report.status !== 'READY'
      ? feeCheck.report.status
      : !gasReady
        ? 'WAIT_GAS'
        : !balanceReady
          ? 'NEEDS_ETH_TOP_UP'
          : 'READY'
  const report = {
    status,
    observedAt: new Date().toISOString(),
    blockNumber: feeCheck.blockNumber,
    wallet: WALLET,
    nonceLatest: feeCheck.nonceState.latest,
    noncePending: feeCheck.nonceState.pending,
    source: {
      tokenId: source.tokenId.toString(),
      tickLower: source.tickLower,
      tickUpper: source.tickUpper,
      liquidity: source.liquidity.toString(),
      principalSpy: formatUnits(removal.principalSpyWei, 18),
      principalPair: formatUnits(removal.principalPairWei, 18),
    },
    fees: {
      positions: feeCheck.positions.length,
      estimatedSpy: formatUnits(feeSpy, 18),
      estimatedPair: formatUnits(feePair, 18),
      quotedPairFromSpy: formatUnits(swapQuote.amountOut, 18),
    },
    target: {
      mode: 'single_sided_pair',
      tickLower: SINGLE_ROLL_TARGET_TICK_LOWER,
      tickUpper: SINGLE_ROLL_TARGET_TICK_UPPER,
      currentTick: feeCheck.currentPool.tick,
      expectedPairInput: formatUnits(expectedAvailablePair, 18),
      expectedLiquidity: previewPosition.liquidity.toString(),
      expectedPairUse: formatUnits(previewPair, 18),
    },
    protectedBaseline: {
      spy: formatUnits(feeCheck.balances.spy, 18),
      pair: formatUnits(feeCheck.balances.pair, 18),
      usdg: formatUnits(feeCheck.balances.usdg, 6),
    },
    gas: {
      gasPriceGwei: feeCheck.report.gas.gasPriceGwei,
      collectAndSwapCeilingEth: formatEther(firstTwo),
      removeCeilingEth: formatEther(removeBudget.sendCeilingWei),
      mintCeilingEth: formatEther(mintBudget.sendCeilingWei),
      totalSendCeilingEth: formatEther(totalSendCeilingWei),
      totalSendCeilingUsdg: formatUnits(totalGasUsdg, 6),
      maximumTotalGasUsdg: formatUnits(MAX_TOTAL_GAS_USDG, 6),
      ethBalance: formatEther(feeCheck.balances.eth),
    },
    policy: {
      collectAllSevenNonzeroPairSpyPositions: true,
      swapOnlyClaimedSpyToPair: true,
      migrateOnlyTokenId: SINGLE_ROLL_SOURCE_TOKEN_ID,
      preservePreExistingWalletSpyPairUsdg: true,
      preserveOtherLpLiquidity: true,
      requireSingleSidedPairAtMint: true,
      autoExit: false,
    },
  }
  appendAudit('single_roll_preflight', report)
  if (print) console.log(stringify(report))
  if (requireReady && status !== 'READY') throw new Error(`单边迁移预检未就绪：${status}`)
  return {
    ...feeCheck,
    source,
    report,
    gasPolicy: {
      ...feeCheck.gasPolicy,
      modeledAfterCollectSendCeilingWei: (
        BigInt(feeCheck.gasPolicy.modeledSwapSendCeilingWei) +
        removeBudget.sendCeilingWei +
        mintBudget.sendCeilingWei
      ).toString(),
      modeledAfterSwapSendCeilingWei: (removeBudget.sendCeilingWei + mintBudget.sendCeilingWei).toString(),
      modeledAfterRemoveSendCeilingWei: mintBudget.sendCeilingWei.toString(),
      modeledRemoveSendCeilingWei: removeBudget.sendCeilingWei.toString(),
      modeledMintSendCeilingWei: mintBudget.sendCeilingWei.toString(),
    },
  }
}

async function withdrawSingleRollSource(walletClient, state) {
  const prior = state.steps?.withdraw_source
  if (prior?.status === 'confirmed' && prior.receivedPairWei) return prior
  if (prior?.status === 'confirmed') {
    const after = await balances()
    prior.receivedSpyWei = (after.spy - BigInt(prior.spyBeforeWei)).toString()
    prior.receivedPairWei = (after.pair - BigInt(prior.pairBeforeWei)).toString()
    state.availablePairWei = (after.pair - BigInt(state.baseline.pairWei)).toString()
    writeState(state)
    return prior
  }
  await assertSingleRollProtectedUnchanged(state)
  const [before, source, currentPool] = await Promise.all([balances(), readSingleRollSource(), poolState()])
  const claim = state.steps.collect_all_fees.received
  const swap = state.steps.swap_claimed_spy_to_pair
  const expectedPair = BigInt(state.baseline.pairWei) + BigInt(claim.pairWei) + BigInt(swap.actualPairOutWei || 0)
  if (
    before.spy !== BigInt(state.baseline.spyWei) ||
    before.pair !== expectedPair ||
    before.usdg !== BigInt(state.baseline.usdgAtomic)
  )
    throw new Error('撤仓前余额不等于受保护基线加本次手续费资产')
  if (currentPool.tick < SINGLE_ROLL_TARGET_TICK_UPPER)
    throw new Error('撤仓前 PAIR 已进入目标区间，已停止以保持单边策略')
  if (source.liquidity !== BigInt(state.source.liquidity)) throw new Error('撤仓前来源 NFT liquidity 已变化')
  const removal = buildFullRemove(source, currentPool)
  if (removal.principalSpyWei !== 0n) throw new Error('撤仓前来源 NFT 已不再是纯 PAIR')
  const step = await runStep(walletClient, state, 'withdraw_source', {
    label: `撤出单边来源 NFT ${source.tokenId}`,
    to: POSITION_MANAGER,
    data: removal.data,
    remainingGasWei: BigInt(state.gasPolicy.modeledAfterRemoveSendCeilingWei),
    metadata: {
      spyBeforeWei: before.spy.toString(),
      pairBeforeWei: before.pair.toString(),
      sourceLiquidityBefore: source.liquidity.toString(),
    },
  })
  const [after, sourceLiquidityAfter] = await Promise.all([
    balances(),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'getPositionLiquidity',
      args: [source.tokenId],
    }),
  ])
  if (sourceLiquidityAfter !== 0n) throw new Error(`来源 NFT 撤出后 liquidity=${sourceLiquidityAfter}`)
  if (after.spy !== before.spy || after.pair <= before.pair || after.usdg !== before.usdg)
    throw new Error('来源 NFT 撤出后的代币余额异常')
  step.receivedSpyWei = '0'
  step.receivedPairWei = (after.pair - before.pair).toString()
  state.availablePairWei = (after.pair - BigInt(state.baseline.pairWei)).toString()
  writeState(state)
  await assertSingleRollProtectedUnchanged(state)
  return step
}

async function mintSingleRollTarget(walletClient, state) {
  const prior = state.steps?.mint_target
  if (prior?.status === 'confirmed' && prior.tokenId) return prior
  await assertSingleRollProtectedUnchanged(state)
  const [before, sourceLiquidityAfter, currentPool, erc20PairAllowance] = await Promise.all([
    balances(),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(SINGLE_ROLL_SOURCE_TOKEN_ID)],
    }),
    poolState(),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
  ])
  const availablePair = BigInt(state.availablePairWei)
  if (sourceLiquidityAfter !== 0n) throw new Error('铸造前来源 NFT 尚未清空')
  if (currentPool.tick < SINGLE_ROLL_TARGET_TICK_UPPER) throw new Error('铸造前 PAIR 已进入目标区间，禁止非单边建仓')
  if (
    before.spy !== BigInt(state.baseline.spyWei) ||
    before.pair !== BigInt(state.baseline.pairWei) + availablePair ||
    before.usdg !== BigInt(state.baseline.usdgAtomic)
  )
    throw new Error('铸造前钱包余额偏离已归因资产')
  if (erc20PairAllowance < availablePair) throw new Error('铸造前 PAIR 对 Permit2 的 ERC20 授权不足')
  const mint = await buildSingleSidedMint(walletClient.account, availablePair)
  const step = await runStep(walletClient, state, 'mint_target', {
    label: `重建单边 PAIR/SPY LP [${SINGLE_ROLL_TARGET_TICK_LOWER},${SINGLE_ROLL_TARGET_TICK_UPPER})`,
    to: POSITION_MANAGER,
    data: mint.data,
    metadata: {
      pairBeforeWei: before.pair.toString(),
      availablePairWei: availablePair.toString(),
      plannedLiquidity: mint.liquidity.toString(),
      plannedPairDesiredWei: mint.amount1Desired.toString(),
    },
  })
  const receipt = await publicClient.getTransactionReceipt({ hash: step.hash })
  const tokenId = parseMintTokenId(receipt)
  if (tokenId === null) throw new Error(`mint 已成功但无法解析新 NFT：${step.hash}`)
  const [owner, liquidity, after, sourceFinal] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    }),
    balances(),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(SINGLE_ROLL_SOURCE_TOKEN_ID)],
    }),
  ])
  if (owner.toLowerCase() !== WALLET.toLowerCase() || liquidity !== mint.liquidity || sourceFinal !== 0n)
    throw new Error('新 NFT 或来源 NFT 链上读回不一致')
  if (after.spy !== BigInt(state.baseline.spyWei) || after.usdg !== BigInt(state.baseline.usdgAtomic))
    throw new Error('mint 后受保护 SPY/USDG 发生变化')
  const pairSpent = before.pair - after.pair
  if (pairSpent * 10_000n < availablePair * SINGLE_ROLL_MIN_PAIR_USE_BPS)
    throw new Error('mint 实际 PAIR 使用率低于 99.99%')
  step.tokenId = tokenId.toString()
  step.liquidity = liquidity.toString()
  step.pairSpentWei = pairSpent.toString()
  step.pairAfterWei = after.pair.toString()
  writeState(state)
  await assertSingleRollProtectedUnchanged(state)
  return step
}

async function finalizeSingleRoll(state) {
  await assertSingleRollProtectedUnchanged(state)
  const mint = state.steps?.mint_target
  const withdraw = state.steps?.withdraw_source
  const claim = state.steps?.collect_all_fees
  const swap = state.steps?.swap_claimed_spy_to_pair
  if (
    !mint?.tokenId ||
    mint.status !== 'confirmed' ||
    withdraw?.status !== 'confirmed' ||
    !claim?.received ||
    swap?.status !== 'confirmed'
  ) {
    throw new Error('单边迁移步骤尚未全部确认')
  }
  const tokenId = BigInt(mint.tokenId)
  const [finalBalances, nonceState, sourceLiquidity, owner, targetLiquidity, poolAndInfo] = await Promise.all([
    balances(),
    nonces(),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(SINGLE_ROLL_SOURCE_TOKEN_ID)],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'getPoolAndPositionInfo',
      args: [tokenId],
    }),
  ])
  if (nonceState.latest !== nonceState.pending) throw new Error('结算时仍有 pending nonce')
  if (
    sourceLiquidity !== 0n ||
    owner.toLowerCase() !== WALLET.toLowerCase() ||
    targetLiquidity !== BigInt(mint.liquidity)
  ) {
    throw new Error('结算时新旧 NFT 状态不符合迁移结果')
  }
  const info = poolAndInfo[1]
  const tickLower = signed24(info >> 8n)
  const tickUpper = signed24(info >> 32n)
  if (tickLower !== SINGLE_ROLL_TARGET_TICK_LOWER || tickUpper !== SINGLE_ROLL_TARGET_TICK_UPPER)
    throw new Error('新 NFT 最终 Tick 不匹配')
  if (finalBalances.spy !== BigInt(state.baseline.spyWei) || finalBalances.usdg !== BigInt(state.baseline.usdgAtomic)) {
    throw new Error('最终受保护 SPY/USDG 基线不一致')
  }
  state.status = 'complete'
  state.completedAt = new Date().toISOString()
  state.result = {
    sourceTokenId: SINGLE_ROLL_SOURCE_TOKEN_ID,
    sourceLiquidityAfter: '0',
    targetTokenId: mint.tokenId,
    targetTickLower: tickLower,
    targetTickUpper: tickUpper,
    targetLiquidity: targetLiquidity.toString(),
    collected: claim.received,
    swapped: { spyWei: swap.spyInputWei || '0', actualPairOutWei: swap.actualPairOutWei || '0' },
    withdrawn: { spyWei: withdraw.receivedSpyWei, pairWei: withdraw.receivedPairWei },
    mintedPairWei: mint.pairSpentWei,
    residualPairAboveBaselineWei: (finalBalances.pair - BigInt(state.baseline.pairWei)).toString(),
    gasSpentWei: gasSpent(state).toString(),
    finalBalances: {
      ethWei: finalBalances.eth.toString(),
      spyWei: finalBalances.spy.toString(),
      pairWei: finalBalances.pair.toString(),
      usdgAtomic: finalBalances.usdg.toString(),
    },
    nonceLatest: nonceState.latest,
    protectedOtherLpLiquidityUnchanged: true,
  }
  writeState(state)
  appendAudit('single_roll_complete', {
    operationId: state.operationId,
    result: state.result,
    transactions: Object.values(state.steps)
      .map((step) => step.hash)
      .filter(Boolean),
  })
  console.log(
    stringify({
      status: 'COMPLETE',
      operationId: state.operationId,
      sourceTokenId: state.result.sourceTokenId,
      target: { tokenId: state.result.targetTokenId, tickLower, tickUpper, liquidity: targetLiquidity },
      collected: {
        spy: formatUnits(BigInt(claim.received.spyWei), 18),
        pair: formatUnits(BigInt(claim.received.pairWei), 18),
      },
      swapped: {
        spy: formatUnits(BigInt(swap.spyInputWei || 0), 18),
        pairReceived: formatUnits(BigInt(swap.actualPairOutWei || 0), 18),
      },
      withdrawnPair: formatUnits(BigInt(withdraw.receivedPairWei), 18),
      mintedPair: formatUnits(BigInt(mint.pairSpentWei), 18),
      residualPairAboveBaseline: formatUnits(BigInt(state.result.residualPairAboveBaselineWei), 18),
      protectedBaseline: { spy: formatUnits(finalBalances.spy, 18), usdg: formatUnits(finalBalances.usdg, 6) },
      gasSpentEth: formatEther(BigInt(state.result.gasSpentWei)),
      finalEth: formatEther(finalBalances.eth),
      transactions: Object.values(state.steps)
        .filter((step) => step.hash)
        .map((step) => ({ label: step.label, hash: step.hash, explorer: `${EXPLORER_TX}${step.hash}` })),
    }),
  )
}

async function executeSingleRollState(state) {
  const release = acquireLock()
  try {
    const account = loadAccount()
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
    })
    await collect(walletClient, state)
    await swapClaimedSpy(walletClient, state)
    await withdrawSingleRollSource(walletClient, state)
    await mintSingleRollTarget(walletClient, state)
    await finalizeSingleRoll(state)
  } catch (error) {
    const latest = readJson(STATE_PATH) || state
    if (latest.status !== 'complete') {
      latest.status = 'partial'
      latest.lastErrorAt = new Date().toISOString()
      latest.lastError = error.shortMessage || error.message
      writeState(latest)
      appendAudit('single_roll_partial', {
        operationId: latest.operationId,
        message: latest.lastError,
        steps: latest.steps,
      })
    }
    throw error
  } finally {
    release()
  }
}

async function singleRollEnter() {
  const existing = readJson(STATE_PATH)
  if (existing && existing.status !== 'complete') return executeSingleRollState(existing)
  archiveCompleteState(existing)
  const check = await singleRollPreflight({ print: true, requireReady: true })
  const state = {
    schemaVersion: 1,
    operationType: 'fees_and_single_sided_roll',
    name: '领取全部 PAIR/SPY 手续费，将手续费 SPY 换成 PAIR，并迁移指定单边仓',
    status: 'planned',
    operationId: `single-roll-${new Date().toISOString().replace(/[-:.]/g, '')}`,
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    wallet: WALLET,
    chainId: CHAIN_ID,
    policy: check.report.policy,
    gasPolicy: check.gasPolicy,
    baseline: {
      ethWei: check.balances.eth.toString(),
      spyWei: check.balances.spy.toString(),
      pairWei: check.balances.pair.toString(),
      usdgAtomic: check.balances.usdg.toString(),
    },
    pairPositions: check.positions,
    source: {
      tokenId: check.source.tokenId.toString(),
      tickLower: check.source.tickLower,
      tickUpper: check.source.tickUpper,
      liquidity: check.source.liquidity.toString(),
    },
    target: { tickLower: SINGLE_ROLL_TARGET_TICK_LOWER, tickUpper: SINGLE_ROLL_TARGET_TICK_UPPER },
    steps: {},
  }
  writeState(state)
  appendAudit('single_roll_plan_created', state)
  return executeSingleRollState(state)
}

async function singleRollResume() {
  const state = readJson(STATE_PATH)
  if (!state) throw new Error('没有可恢复的单边迁移操作')
  if (state.status === 'complete') {
    console.log(stringify({ status: 'ALREADY_COMPLETE', operationId: state.operationId, result: state.result }))
    return
  }
  return executeSingleRollState(state)
}

async function singleRollStatus() {
  return status()
}

async function positionPairIncreasePreflight({ print = true, requireReady = false } = {}) {
  const existing = readJson(STATE_PATH)
  if (existing && existing.status !== 'complete') {
    const report = { status: 'RESUME_REQUIRED', operationId: existing.operationId, phase: existing.status }
    if (print) console.log(stringify(report))
    if (requireReady) throw new Error(`存在待恢复的单边追加：${existing.operationId}`)
    return { existing, report }
  }
  if ((await publicClient.getChainId()) !== CHAIN_ID) throw new Error('RPC chainId 不匹配')
  const [blockNumber, walletBalances, nonceState, positions, target, currentPool, ethQuote] = await Promise.all([
    publicClient.getBlockNumber(),
    balances(),
    nonces(),
    discoverNonzeroPositions(),
    readPositionIncreaseTarget(),
    poolState(),
    ethUsdgQuote(),
  ])
  if (nonceState.latest !== nonceState.pending)
    throw new Error(`存在 pending nonce：${nonceState.latest}/${nonceState.pending}`)
  const targetRecord = positions.find((item) => item.tokenId === target.tokenId.toString())
  if (!targetRecord || BigInt(targetRecord.liquidity) !== target.liquidity)
    throw new Error('组合账本没有完整纳入目标 NFT')
  if (currentPool.tick < target.tickLower) throw new Error(`PAIR 已涨出目标区间，停止追加：tick=${currentPool.tick}`)
  if (currentPool.tick < target.tickUpper && POSITION_INCREASE_MAX_WALLET_SPY <= 0n) {
    throw new Error(`PAIR 已进入目标区间，需要明确的 SPY 配平额度：tick=${currentPool.tick}`)
  }
  if (walletBalances.pair <= 0n) throw new Error('钱包没有可追加的 PAIR')
  const account = loadAccount()
  const plan = await buildPositionPairOnlyIncrease(account, target, walletBalances.spy, walletBalances.pair)
  const [erc20SpyAllowance, erc20PairAllowance] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
  ])
  if (erc20SpyAllowance < plan.externalSpyMax || erc20PairAllowance < plan.externalPairMax) {
    throw new Error('SPY 或 PAIR 对 Permit2 的 ERC20 allowance 不足；本流程禁止新增授权交易')
  }
  const budget = await transactionBudget(POSITION_MANAGER, plan.data)
  const sendCeilingUsdg = (budget.sendCeilingWei * ethQuote.amountOut) / ethQuote.amountIn
  const maximumGasWei = (MAX_TOTAL_GAS_USDG * ethQuote.amountIn) / ethQuote.amountOut
  const gasReady = sendCeilingUsdg <= MAX_TOTAL_GAS_USDG
  const balanceReady = walletBalances.eth >= budget.sendCeilingWei + POSITION_INCREASE_MIN_FINAL_ETH
  const status = !gasReady ? 'WAIT_GAS' : !balanceReady ? 'NEEDS_ETH_TOP_UP' : 'READY'
  const report = {
    status,
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest: nonceState.latest,
    noncePending: nonceState.pending,
    target: {
      tokenId: target.tokenId.toString(),
      tickLower: target.tickLower,
      tickUpper: target.tickUpper,
      currentTick: plan.currentPool.tick,
      mode: plan.mode,
      liquidityBefore: target.liquidity,
      liquidityToAdd: plan.liquidity,
    },
    inputs: {
      walletPair: formatUnits(walletBalances.pair, 18),
      walletPairWei: walletBalances.pair,
      authorizedWalletPair: formatUnits(plan.walletPairBudgetWei, 18),
      authorizedWalletPairWei: plan.walletPairBudgetWei,
      targetAccruedFeeSpy: formatUnits(plan.fees.spyWei, 18),
      targetAccruedFeePair: formatUnits(plan.fees.pairWei, 18),
      desiredSpy: formatUnits(plan.amount0Desired, 18),
      desiredPair: formatUnits(plan.amount1Desired, 18),
      expectedWalletSpySpend: formatUnits(plan.externalSpyDesired, 18),
      expectedWalletPairSpend: formatUnits(plan.externalPairDesired, 18),
      maximumExternalSpy: formatUnits(plan.externalSpyMax, 18),
      maximumExternalPair: formatUnits(plan.externalPairMax, 18),
      expectedWalletPairResidual: formatUnits(plan.pairResidualWei, 18),
      protectedWalletPairFloor: formatUnits(plan.protectedPairFloorWei, 18),
    },
    protected: {
      walletSpy: formatUnits(walletBalances.spy, 18),
      walletUsdg: formatUnits(walletBalances.usdg, 6),
      walletPairFloor: formatUnits(plan.protectedPairFloorWei, 18),
      nonTargetPositions: positions.filter((item) => item.tokenId !== target.tokenId.toString()).length,
    },
    gas: {
      gasPriceGwei: formatUnits(budget.gasPrice, 9),
      estimatedUnits: budget.estimatedGas,
      sendCeilingEth: formatEther(budget.sendCeilingWei),
      sendCeilingUsdg: formatUnits(sendCeilingUsdg, 6),
      maximumGasUsdg: formatUnits(MAX_TOTAL_GAS_USDG, 6),
      minimumFinalEth: formatEther(POSITION_INCREASE_MIN_FINAL_ETH),
      currentEth: formatEther(walletBalances.eth),
      ethUsdgQuoteFor001Eth: formatUnits(ethQuote.amountOut, 6),
    },
    policy: {
      maximizeWalletPairWithinOnePercentMintGuard: true,
      useCompleteWalletPairBalance:
        plan.mode === 'out_of_range_pair_only' && plan.walletPairBudgetWei === walletBalances.pair,
      authorizedWalletPairWei: plan.walletPairBudgetWei,
      protectedWalletPairFloorWei: plan.protectedPairFloorWei,
      useWalletSpy: plan.externalSpyDesired > 0n,
      collectOtherLpFees: false,
      createNewNft: false,
      preserveOtherLpLiquidity: true,
      maximumWalletSpy: formatUnits(POSITION_INCREASE_MAX_WALLET_SPY, 18),
      maximumWalletSpyWei: POSITION_INCREASE_MAX_WALLET_SPY,
      maximumWalletPairResidualBps: POSITION_INCREASE_MAX_PAIR_RESIDUAL_BPS,
      requirePriceNotAboveTargetRangeAtBroadcast: true,
      maximumGasUsdg: formatUnits(MAX_TOTAL_GAS_USDG, 6),
    },
  }
  appendAudit('position_pair_increase_preflight', report)
  if (print) console.log(stringify(report))
  if (requireReady && status !== 'READY') throw new Error(`单边追加预检未就绪：${status}`)
  return {
    report,
    blockNumber,
    balances: walletBalances,
    nonceState,
    positions,
    target,
    plan,
    gasPolicy: {
      maximumGasUsdg: formatUnits(MAX_TOTAL_GAS_USDG, 6),
      maximumGasWei: maximumGasWei.toString(),
      minimumFinalEthWei: POSITION_INCREASE_MIN_FINAL_ETH.toString(),
      modeledSendCeilingWei: budget.sendCeilingWei.toString(),
    },
  }
}

async function finalizePositionPairIncrease(state) {
  const step = state.steps?.increase_target
  if (!step?.hash || step.status !== 'confirmed' || !state.mintPlan) throw new Error('追加交易尚未完整确认')
  const receipt = await publicClient.getTransactionReceipt({ hash: step.hash })
  if (receipt.status !== 'success') throw new Error(`追加链上回执失败：${step.hash}`)
  const targetTokenId = BigInt(state.target.tokenId)
  const protectedPositions = state.pairPositions.filter((item) => item.tokenId !== state.target.tokenId)
  const [owner, liquidityAfter, poolAndInfo, finalBalances, nonceState] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'ownerOf',
      args: [targetTokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'getPositionLiquidity',
      args: [targetTokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_ABI,
      functionName: 'getPoolAndPositionInfo',
      args: [targetTokenId],
    }),
    balances(),
    nonces(),
    assertPositionsUnchanged(protectedPositions),
  ])
  if (nonceState.latest !== nonceState.pending) throw new Error('追加结算时仍有 pending nonce')
  if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error('追加后目标 NFT owner 异常')
  const [, info] = poolAndInfo
  const tickLower = signed24(info >> 8n)
  const tickUpper = signed24(info >> 32n)
  if (tickLower !== state.target.tickLower || tickUpper !== state.target.tickUpper)
    throw new Error('追加后目标 NFT Tick 异常')
  const expectedLiquidityAfter = BigInt(state.target.liquidityBefore) + BigInt(state.mintPlan.liquidityToAdd)
  if (liquidityAfter !== expectedLiquidityAfter) {
    throw new Error(`追加后 liquidity 不一致：chain=${liquidityAfter}, expected=${expectedLiquidityAfter}`)
  }
  const baselineSpy = BigInt(state.baseline.spyWei)
  const baselinePair = BigInt(state.baseline.pairWei)
  if (finalBalances.usdg !== BigInt(state.baseline.usdgAtomic)) throw new Error('追加意外改变了钱包 USDG')
  const spySpentWei = baselineSpy > finalBalances.spy ? baselineSpy - finalBalances.spy : 0n
  const pairSpentWei = baselinePair > finalBalances.pair ? baselinePair - finalBalances.pair : 0n
  const maximumWalletSpyWei = BigInt(state.policy.maximumWalletSpyWei || '0')
  if (spySpentWei > maximumWalletSpyWei) {
    throw new Error(`追加实际 SPY 支出超过授权上限：spent=${spySpentWei}, max=${maximumWalletSpyWei}`)
  }
  if (state.mintPlan.mode === 'out_of_range_pair_only') {
    if (finalBalances.spy < baselineSpy) throw new Error('单边追加意外花费了钱包 SPY')
    verifyAuthorizedPairSpend({
      baselinePairWei: baselinePair,
      finalPairWei: finalBalances.pair,
      authorizedBudgetWei: BigInt(state.policy.authorizedWalletPairWei),
      minimumUseBps: POSITION_INCREASE_MIN_PAIR_USE_BPS,
    })
  } else {
    const authorizedPair = BigInt(state.policy.authorizedWalletPairWei)
    const protectedFloor = BigInt(state.policy.protectedWalletPairFloorWei)
    if ((finalBalances.pair - protectedFloor) * 10_000n > authorizedPair * POSITION_INCREASE_MAX_PAIR_RESIDUAL_BPS) {
      throw new Error(
        `双边追加后授权 PAIR 剩余超过 7%：residual=${finalBalances.pair - protectedFloor}, budget=${authorizedPair}`,
      )
    }
  }
  const actualGasWei = BigInt(step.gasCostWei)
  if (actualGasWei > BigInt(state.gasPolicy.maximumGasWei)) {
    throw new Error(`单边追加实际 Gas 超过 ${state.gasPolicy.maximumGasUsdg} USDG 上限`)
  }
  state.status = 'complete'
  state.completedAt = new Date().toISOString()
  state.result = {
    targetTokenId: state.target.tokenId,
    tickLower,
    tickUpper,
    liquidityBefore: state.target.liquidityBefore,
    liquidityAdded: state.mintPlan.liquidityToAdd,
    liquidityAfter: liquidityAfter.toString(),
    walletPairBeforeWei: state.baseline.pairWei,
    walletPairSpentWei: pairSpentWei.toString(),
    walletPairResidualWei: finalBalances.pair.toString(),
    walletSpyBeforeWei: state.baseline.spyWei,
    walletSpyAfterWei: finalBalances.spy.toString(),
    walletSpySpentWei: spySpentWei.toString(),
    accruedFeesAtBuild: state.mintPlan.accruedFees,
    gasSpentWei: actualGasWei.toString(),
    blockNumber: receipt.blockNumber.toString(),
    transactionHash: step.hash,
    finalBalances: {
      ethWei: finalBalances.eth.toString(),
      spyWei: finalBalances.spy.toString(),
      pairWei: finalBalances.pair.toString(),
      usdgAtomic: finalBalances.usdg.toString(),
    },
    nonceLatest: nonceState.latest,
    protectedOtherLpLiquidityUnchanged: true,
    noNewNft: true,
  }
  writeState(state)
  appendAudit('position_pair_increase_complete', { operationId: state.operationId, result: state.result })
  console.log(
    stringify({
      status: 'POSITION_INCREASE_COMPLETE',
      operationId: state.operationId,
      tokenId: state.target.tokenId,
      tickLower,
      tickUpper,
      liquidityBefore: state.target.liquidityBefore,
      liquidityAdded: state.mintPlan.liquidityToAdd,
      liquidityAfter,
      pairDeposited: formatUnits(pairSpentWei, 18),
      pairResidual: formatUnits(finalBalances.pair, 18),
      walletSpySpent: formatUnits(spySpentWei, 18),
      gasSpentEth: formatEther(actualGasWei),
      finalEth: formatEther(finalBalances.eth),
      transaction: { hash: step.hash, explorer: `${EXPLORER_TX}${step.hash}` },
    }),
  )
}

async function executePositionPairIncreaseState(state) {
  const release = acquireLock()
  try {
    if (state.steps?.increase_target?.status === 'confirmed') return finalizePositionPairIncrease(state)
    const account = loadAccount()
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
    })
    await assertPositionsUnchanged(state.pairPositions)
    const [walletBalances, nonceState, target, currentPool] = await Promise.all([
      balances(),
      nonces(),
      readPositionIncreaseTarget(),
      poolState(),
    ])
    if (nonceState.latest !== nonceState.pending) throw new Error('追加广播前存在 pending nonce')
    if (
      walletBalances.spy !== BigInt(state.baseline.spyWei) ||
      walletBalances.pair !== BigInt(state.baseline.pairWei) ||
      walletBalances.usdg !== BigInt(state.baseline.usdgAtomic)
    )
      throw new Error('预检后钱包代币余额发生变化，停止使用旧金额')
    if (target.liquidity !== BigInt(state.target.liquidityBefore)) throw new Error('预检后目标 NFT liquidity 发生变化')
    if (currentPool.tick < target.tickLower) throw new Error(`PAIR 已涨出目标区间，停止追加：tick=${currentPool.tick}`)
    const plan = await buildPositionPairOnlyIncrease(account, target, walletBalances.spy, walletBalances.pair)
    const [erc20SpyAllowance, erc20PairAllowance] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
    ])
    if (erc20SpyAllowance < plan.externalSpyMax || erc20PairAllowance < plan.externalPairMax) {
      throw new Error('广播前 SPY 或 PAIR 对 Permit2 的 ERC20 allowance 不足')
    }
    state.mintPlan = {
      mode: plan.mode,
      liquidityToAdd: plan.liquidity.toString(),
      desiredSpyWei: plan.amount0Desired.toString(),
      desiredPairWei: plan.amount1Desired.toString(),
      maximumSpyWei: plan.amount0Max.toString(),
      maximumPairWei: plan.amount1Max.toString(),
      expectedExternalSpyWei: plan.externalSpyDesired.toString(),
      expectedExternalPairWei: plan.externalPairDesired.toString(),
      maximumExternalSpyWei: plan.externalSpyMax.toString(),
      maximumExternalPairWei: plan.externalPairMax.toString(),
      expectedWalletPairResidualWei: plan.pairResidualWei.toString(),
      authorizedWalletPairWei: plan.walletPairBudgetWei.toString(),
      protectedWalletPairFloorWei: plan.protectedPairFloorWei.toString(),
      accruedFees: { spyWei: plan.fees.spyWei.toString(), pairWei: plan.fees.pairWei.toString() },
      buildTick: plan.currentPool.tick,
    }
    writeState(state)
    await runStep(walletClient, state, 'increase_target', {
      label: `向 NFT ${state.target.tokenId} 按授权配比追加 PAIR/SPY`,
      to: POSITION_MANAGER,
      data: plan.data,
      metadata: {
        targetTokenId: state.target.tokenId,
        liquidityBefore: state.target.liquidityBefore,
        liquidityToAdd: plan.liquidity.toString(),
        mode: plan.mode,
        spyBeforeWei: walletBalances.spy.toString(),
        pairBeforeWei: walletBalances.pair.toString(),
      },
    })
    return finalizePositionPairIncrease(state)
  } catch (error) {
    const latest = readJson(STATE_PATH) || state
    if (latest.status !== 'complete') {
      latest.status = 'partial'
      latest.lastErrorAt = new Date().toISOString()
      latest.lastError = error.shortMessage || error.message
      writeState(latest)
      appendAudit('position_pair_increase_partial', {
        operationId: latest.operationId,
        message: latest.lastError,
        steps: latest.steps,
      })
    }
    throw error
  } finally {
    release()
  }
}

async function positionPairIncreaseEnter() {
  const existing = readJson(STATE_PATH)
  if (existing && existing.status !== 'complete') return executePositionPairIncreaseState(existing)
  archiveCompleteState(existing)
  const check = await positionPairIncreasePreflight({ print: true, requireReady: true })
  const state = {
    schemaVersion: 1,
    operationType: 'increase_existing_position_authorized_ratio',
    name: `向 NFT ${check.target.tokenId} 按授权配比追加钱包 PAIR/SPY`,
    status: 'planned',
    operationId: `position-pair-increase-${new Date().toISOString().replace(/[-:.]/g, '')}`,
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    wallet: WALLET,
    chainId: CHAIN_ID,
    policy: check.report.policy,
    gasPolicy: check.gasPolicy,
    baseline: {
      ethWei: check.balances.eth.toString(),
      spyWei: check.balances.spy.toString(),
      pairWei: check.balances.pair.toString(),
      usdgAtomic: check.balances.usdg.toString(),
    },
    pairPositions: check.positions,
    target: {
      tokenId: check.target.tokenId.toString(),
      tickLower: check.target.tickLower,
      tickUpper: check.target.tickUpper,
      liquidityBefore: check.target.liquidity.toString(),
    },
    steps: {},
  }
  writeState(state)
  appendAudit('position_pair_increase_plan_created', state)
  return executePositionPairIncreaseState(state)
}

async function positionPairIncreaseResume() {
  const state = readJson(STATE_PATH)
  if (!state) throw new Error('没有可恢复的单边追加操作')
  if (state.status === 'complete') {
    console.log(stringify({ status: 'ALREADY_COMPLETE', operationId: state.operationId, result: state.result }))
    return
  }
  return executePositionPairIncreaseState(state)
}

async function positionPairIncreaseStatus() {
  return status()
}

async function finalize(state) {
  await assertPositionsUnchanged(state.pairPositions)
  const [finalBalances, nonceState] = await Promise.all([balances(), nonces()])
  if (nonceState.latest !== nonceState.pending) throw new Error('结算时仍有 pending nonce')
  const collectStep = state.steps.collect_all_fees
  const swapStep = state.steps.swap_claimed_spy_to_pair
  if (!collectStep?.received || !swapStep || swapStep.status !== 'confirmed') throw new Error('两步操作尚未完整确认')
  if (finalBalances.spy !== BigInt(state.baseline.spyWei)) throw new Error('最终 SPY 不等于受保护基线')
  if (finalBalances.usdg !== BigInt(state.baseline.usdgAtomic)) throw new Error('最终 USDG 不等于受保护基线')
  const expectedPair =
    BigInt(state.baseline.pairWei) + BigInt(collectStep.received.pairWei) + BigInt(swapStep.actualPairOutWei || 0)
  if (finalBalances.pair !== expectedPair) throw new Error('最终 PAIR 与领取和兑换结果不一致')
  state.status = 'complete'
  state.completedAt = new Date().toISOString()
  state.result = {
    collected: collectStep.received,
    swapped: {
      spyWei: swapStep.spyInputWei || '0',
      usdgAtomic: '0',
      quotedPairOutWei: swapStep.quotedPairOutWei || '0',
      actualPairOutWei: swapStep.actualPairOutWei || '0',
      usdgRoute: null,
    },
    gasSpentWei: gasSpent(state).toString(),
    finalBalances: {
      ethWei: finalBalances.eth.toString(),
      spyWei: finalBalances.spy.toString(),
      pairWei: finalBalances.pair.toString(),
      usdgAtomic: finalBalances.usdg.toString(),
    },
    nonceLatest: nonceState.latest,
    sourceLiquidityUnchanged: true,
    protectedWalletSpyUnchanged: true,
    noReinvest: true,
  }
  writeState(state)
  appendAudit('fees_to_pair_complete', {
    operationId: state.operationId,
    result: state.result,
    transactions: [collectStep.hash, swapStep.hash].filter(Boolean),
  })
  console.log(
    stringify({
      status: 'COMPLETE',
      operationId: state.operationId,
      collected: {
        spy: formatUnits(BigInt(collectStep.received.spyWei), 18),
        pair: formatUnits(BigInt(collectStep.received.pairWei), 18),
      },
      swapped: {
        spy: formatUnits(BigInt(swapStep.spyInputWei || 0), 18),
        pairReceived: formatUnits(BigInt(swapStep.actualPairOutWei || 0), 18),
      },
      protectedBaseline: { spy: formatUnits(finalBalances.spy, 18), usdg: formatUnits(finalBalances.usdg, 6) },
      final: {
        eth: formatEther(finalBalances.eth),
        spy: formatUnits(finalBalances.spy, 18),
        pair: formatUnits(finalBalances.pair, 18),
        usdg: formatUnits(finalBalances.usdg, 6),
      },
      gasSpentEth: formatEther(BigInt(state.result.gasSpentWei)),
      transactions: [collectStep, swapStep]
        .filter((step) => step.hash)
        .map((step) => ({ label: step.label, hash: step.hash, explorer: `${EXPLORER_TX}${step.hash}` })),
    }),
  )
}

async function executeState(state) {
  const release = acquireLock()
  try {
    const account = loadAccount()
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
    })
    await collect(walletClient, state)
    await swapClaimedSpy(walletClient, state)
    await finalize(state)
  } catch (error) {
    const latest = readJson(STATE_PATH) || state
    if (latest.status !== 'complete') {
      latest.status = 'partial'
      latest.lastErrorAt = new Date().toISOString()
      latest.lastError = error.shortMessage || error.message
      writeState(latest)
      appendAudit('fees_to_pair_partial', {
        operationId: latest.operationId,
        message: latest.lastError,
        steps: latest.steps,
      })
    }
    throw error
  } finally {
    release()
  }
}

async function enter() {
  const existing = readJson(STATE_PATH)
  if (existing && existing.status !== 'complete') return executeState(existing)
  archiveCompleteState(existing)
  const check = await preflight({ print: true, requireReady: true })
  const state = {
    schemaVersion: 1,
    operationType: 'fees_to_pair',
    name: '领取全部非空 LP 手续费，仅将本次领取的 SPY 换成 PAIR',
    status: 'planned',
    operationId: `fees-to-pair-${new Date().toISOString().replace(/[-:.]/g, '')}`,
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    wallet: WALLET,
    chainId: CHAIN_ID,
    policy: check.report.policy,
    gasPolicy: check.gasPolicy,
    baseline: {
      ethWei: check.balances.eth.toString(),
      spyWei: check.balances.spy.toString(),
      pairWei: check.balances.pair.toString(),
      usdgAtomic: check.balances.usdg.toString(),
    },
    pairPositions: check.positions,
    steps: {},
  }
  writeState(state)
  appendAudit('fees_to_pair_plan_created', state)
  return executeState(state)
}

async function resume() {
  const state = readJson(STATE_PATH)
  if (!state) throw new Error('没有可恢复操作')
  if (state.status === 'complete') {
    console.log(stringify({ status: 'ALREADY_COMPLETE', operationId: state.operationId, result: state.result }))
    return
  }
  return executeState(state)
}

async function status() {
  const state = readJson(STATE_PATH)
  const [walletBalances, nonceState] = await Promise.all([balances(), nonces()])
  console.log(
    stringify({
      status: state?.status || 'NOT_STARTED',
      operationId: state?.operationId || null,
      lastError: state?.lastError || null,
      balances: {
        eth: formatEther(walletBalances.eth),
        spy: formatUnits(walletBalances.spy, 18),
        pair: formatUnits(walletBalances.pair, 18),
        usdg: formatUnits(walletBalances.usdg, 6),
      },
      nonceLatest: nonceState.latest,
      noncePending: nonceState.pending,
      steps: state?.steps || null,
      result: state?.result || null,
    }),
  )
}

const command = CLI_COMMAND
const actions = {
  preflight,
  enter,
  resume,
  status,
  'single-roll-preflight': singleRollPreflight,
  'single-roll-enter': singleRollEnter,
  'single-roll-resume': singleRollResume,
  'single-roll-status': singleRollStatus,
  'position-pair-increase-preflight': positionPairIncreasePreflight,
  'position-pair-increase-enter': positionPairIncreaseEnter,
  'position-pair-increase-resume': positionPairIncreaseResume,
  'position-pair-increase-status': positionPairIncreaseStatus,
}
if (!actions[command]) throw new Error(`未知命令：${command}`)
actions[command]().catch((error) => {
  appendAudit('command_failed', { command, message: error.shortMessage || error.message })
  console.error(`ERROR: ${error.shortMessage || error.message}`)
  process.exitCode = 1
})
