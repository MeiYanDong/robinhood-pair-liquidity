import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
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
  maxUint256,
  padHex,
  parseAbi,
  parseAbiParameters,
  parseEther,
  parseUnits,
  toHex,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

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
const V3_ROUTER = getAddress('0xcaf681a66d020601342297493863e78c959e5cb2')
const V4_QUOTER = getAddress('0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94')
const STATE_VIEW = getAddress('0xF3334192D15450CdD385c8B70e03f9A6bD9E673b')
const UNIVERSAL_ROUTER = getAddress('0x8876789976dEcBfCbBbe364623C63652db8C0904')
const POSITION_MANAGER = getAddress('0x58daec3116aae6D93017bAAea7749052E8a04fA7')
const SPY_PAIR_HOOK = getAddress('0x16D1560630Ce74af4478d9b8AD46548A092A2000')

const SPY_PAIR_POOL_ID = '0xf224a070c8626c890a085b258cf562ee4bf052b6d1d59104b3b44d722640c001'
const USDG_PAIR_POOL_ID = '0x97f48c8d9639b7940874b6c6a43b3d606d070a694920b545acff9c35926593a6'
const USDG_PAIR_3_POOL_ID = '0x25779a6de9bc9f244211c4eeabca191966d4a18e97bbe690a4af91a29e65ec86'
const POOL_FEE = 10_000
const SPY_PAIR_TICK_SPACING = 200
const USDG_PAIR_TICK_SPACING = 100
const USDG_PAIR_3_FEE = 30_000
const USDG_PAIR_3_TICK_SPACING = 300

// Defaults are only a manual fallback. The one-shot watcher supplies the
// volume/liquidity-share optimized ticks and they are persisted in the ledger.
let TICK_LOWER = integerEnv('PAIR_USDG_TICK_LOWER', 323_400)
let TICK_UPPER = integerEnv('PAIR_USDG_TICK_UPPER', 326_400)
let PRINCIPAL_ETH = parseEther(process.env.PAIR_USDG_PRINCIPAL_ETH || '0.04')
const MIN_FINAL_ETH = parseEther('0.015')
const MAX_GAS_USDG = process.env.PAIR_USDG_MAX_GAS_USDG || '5'
const SWAP_SLIPPAGE_BPS = 100n
const ETH_SWAP_SLIPPAGE_BPS = 50n
const MINT_SLIPPAGE = new Percent(50, 10_000)
const MINT_SAFETY_BPS = 5n
const UINT160_MAX = (1n << 160n) - 1n
const UINT256_MODULUS = 1n << 256n
const Q128 = 1n << 128n
const SOLVER_ITERATIONS = 20
const FEE_TIERS = [100, 500, 3_000, 10_000]
const SEND_GAS_PRICE_BPS = 11_000n
const GAS_MODEL_SAFETY_BPS = 11_500n
const GAS_MODEL = {
  v4Swap: 180_000n,
  erc20Approval: 65_000n,
  permit2Approval: 50_000n,
  mint: 425_000n,
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const RUN_DIR = path.join(ROOT, 'runs')
const STATE_PATH = path.join(RUN_DIR, 'pair-usdg-narrow-live-one.json')
const AUDIT_PATH = path.join(RUN_DIR, 'pair-usdg-narrow-live-one.jsonl')
const FEES_TO_PAIR_STATE_PATH = path.join(RUN_DIR, 'pair-fees-to-pair-live.json')
const FEES_TO_PAIR_AUDIT_PATH = path.join(RUN_DIR, 'pair-fees-to-pair-live.jsonl')
const FEES_TO_PAIR_HISTORY_DIR = path.join(RUN_DIR, 'pair-fees-to-pair-history')
const FEES_COLLECT_STATE_PATH = path.join(RUN_DIR, 'pair-fees-collect-live.json')
const FEES_COLLECT_AUDIT_PATH = path.join(RUN_DIR, 'pair-fees-collect-live.jsonl')
const PAIR_STATE_PATH = path.join(RUN_DIR, 'pair-lp-live-one.json')

function integerEnv(name, fallback) {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  if (!/^-?\d+$/.test(value)) throw new Error(`${name} 必须是整数`)
  return Number(value)
}

function assertRuntimeParameters() {
  if (!Number.isSafeInteger(TICK_LOWER) || !Number.isSafeInteger(TICK_UPPER) || TICK_LOWER >= TICK_UPPER) {
    throw new Error(`PAIR/USDG Tick 区间无效：[${TICK_LOWER},${TICK_UPPER})`)
  }
  if (TICK_LOWER % USDG_PAIR_TICK_SPACING !== 0 || TICK_UPPER % USDG_PAIR_TICK_SPACING !== 0) {
    throw new Error(`PAIR/USDG Tick 必须按 ${USDG_PAIR_TICK_SPACING} 对齐`)
  }
  if (PRINCIPAL_ETH <= 0n) throw new Error('PAIR_USDG_PRINCIPAL_ETH 必须大于 0')
  if (!/^\d+(\.\d{1,6})?$/.test(MAX_GAS_USDG) || parseUnits(MAX_GAS_USDG, 6) <= 0n) {
    throw new Error('PAIR_USDG_MAX_GAS_USDG 必须是最多 6 位小数的正数')
  }
}

function applyStateRuntime(state) {
  if (state?.target?.tickLower != null) TICK_LOWER = Number(state.target.tickLower)
  if (state?.target?.tickUpper != null) TICK_UPPER = Number(state.target.tickUpper)
  if (state?.policy?.principalEth) PRINCIPAL_ETH = parseEther(String(state.policy.principalEth))
  assertRuntimeParameters()
}

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Robinhood Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
})

const publicClient = createPublicClient({
  chain,
  transport: http(undefined, { timeout: 30_000, retryCount: 1 }),
})

const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])

const V3_QUOTER_ABI = parseAbi([
  'function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)',
])

const V3_ROUTER_ABI = [
  {
    type: 'function',
    name: 'exactInput',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
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
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
]

const UNIVERSAL_ROUTER_ABI = parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable'])

const POSITION_NFT_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed id)',
])

const POSITION_MANAGER_MULTICALL_ABI = parseAbi(['function multicall(bytes[] data) payable returns (bytes[] results)'])

const spyPairPoolKey = {
  currency0: SPY,
  currency1: PAIR,
  fee: POOL_FEE,
  tickSpacing: SPY_PAIR_TICK_SPACING,
  hooks: SPY_PAIR_HOOK,
}

const usdgPairPoolKey = {
  currency0: USDG,
  currency1: PAIR,
  fee: POOL_FEE,
  tickSpacing: USDG_PAIR_TICK_SPACING,
  hooks: zeroAddress,
}

const usdgPair3PoolKey = {
  currency0: USDG,
  currency1: PAIR,
  fee: USDG_PAIR_3_FEE,
  tickSpacing: USDG_PAIR_3_TICK_SPACING,
  hooks: zeroAddress,
}

function nowSeconds() {
  return Math.floor(Date.now() / 1_000)
}

function stringify(value) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), 2)
}

function bpsFloor(value, bps) {
  return (value * (10_000n - bps)) / 10_000n
}

function absoluteBigInt(value) {
  return value < 0n ? -value : value
}

function asBigInt(value) {
  return BigInt(value.toString())
}

function minBigInt(...values) {
  return values.reduce((minimum, value) => (value < minimum ? value : minimum))
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function statePathFor(state) {
  if (state?.operationType === 'fees_to_pair') return FEES_TO_PAIR_STATE_PATH
  if (state?.operationType === 'fees_collect') return FEES_COLLECT_STATE_PATH
  return STATE_PATH
}

function auditPathFor(state) {
  if (state?.operationType === 'fees_to_pair') return FEES_TO_PAIR_AUDIT_PATH
  if (state?.operationType === 'fees_collect') return FEES_COLLECT_AUDIT_PATH
  return AUDIT_PATH
}

function writeState(state) {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
  const statePath = statePathFor(state)
  const temporary = `${statePath}.tmp`
  fs.writeFileSync(temporary, `${stringify(state)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, statePath)
  fs.chmodSync(statePath, 0o600)
}

function appendAudit(event, details = {}, state = null) {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...details }, (_, item) =>
    typeof item === 'bigint' ? item.toString() : item,
  )
  fs.appendFileSync(auditPathFor(state), `${line}\n`, { mode: 0o600 })
}

function archiveFeesToPairState(state) {
  if (state?.operationType !== 'fees_to_pair' || state.status !== 'complete' || !state.operationId) return
  fs.mkdirSync(FEES_TO_PAIR_HISTORY_DIR, { recursive: true, mode: 0o700 })
  const archivePath = path.join(FEES_TO_PAIR_HISTORY_DIR, `${state.operationId}.json`)
  const temporary = `${archivePath}.tmp`
  fs.writeFileSync(temporary, `${stringify(state)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, archivePath)
  fs.chmodSync(archivePath, 0o600)
}

function archiveFeesCollectState(state) {
  if (state?.operationType !== 'fees_collect' || state.status !== 'complete' || !state.operationId) return
  fs.mkdirSync(FEES_TO_PAIR_HISTORY_DIR, { recursive: true, mode: 0o700 })
  const archivePath = path.join(FEES_TO_PAIR_HISTORY_DIR, `${state.operationId}.json`)
  const temporary = `${archivePath}.tmp`
  fs.writeFileSync(temporary, `${stringify(state)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, archivePath)
  fs.chmodSync(archivePath, 0o600)
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
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Keychain 项目不是有效的 32-byte EVM 私钥')
  const account = privateKeyToAccount(privateKey)
  privateKey = undefined
  if (account.address.toLowerCase() !== WALLET.toLowerCase()) {
    throw new Error(`Keychain 私钥地址不匹配；预期 ${WALLET}，实际 ${account.address}`)
  }
  return account
}

function activePairPositions(pairState) {
  if (!pairState?.position?.tokenId) throw new Error('PAIR/SPY 本地账本缺少主仓')
  const records = [{ role: 'main', ...pairState.position }]
  for (const item of (pairState.satellites || []).filter((entry) => entry.status === 'active')) {
    records.push({ role: 'satellite', ...item })
  }
  const seen = new Set()
  return records.filter((record) => {
    const tokenId = String(record.tokenId)
    if (seen.has(tokenId)) return false
    seen.add(tokenId)
    return true
  })
}

function assertNoPairPending(pairState) {
  const keys = [
    'pendingIncrease',
    'pendingSatellite',
    'pendingMigration',
    'pendingUpperRange',
    'pendingFeeBand',
    'pendingAttackRoll',
    'pendingAttackCompound',
    'pendingAttackResidual',
    'pendingMainRoll',
    'pendingRollResidual',
  ]
  const pending = keys.filter((key) => pairState?.[key])
  if (pending.length) throw new Error(`PAIR/SPY 账本存在未结算操作：${pending.join(', ')}`)
}

async function assertContracts() {
  const targets = [
    WETH,
    USDG,
    SPY,
    PAIR,
    PERMIT2,
    V3_QUOTER,
    V3_ROUTER,
    V4_QUOTER,
    STATE_VIEW,
    UNIVERSAL_ROUTER,
    POSITION_MANAGER,
    SPY_PAIR_HOOK,
  ]
  const codes = await Promise.all(targets.map((address) => publicClient.getCode({ address })))
  const missing = targets.filter((_, index) => !codes[index] || codes[index] === '0x')
  if (missing.length) throw new Error(`目标合约无 bytecode：${missing.join(', ')}`)
  const [usdgSymbol, usdgDecimals, spySymbol, spyDecimals, pairSymbol, pairDecimals] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'symbol' }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'decimals' }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'symbol' }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'decimals' }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'symbol' }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'decimals' }),
  ])
  if (
    usdgSymbol !== 'USDG' ||
    usdgDecimals !== 6 ||
    spySymbol !== 'SPY' ||
    spyDecimals !== 18 ||
    pairSymbol !== 'PAIR' ||
    pairDecimals !== 18
  ) {
    throw new Error(
      `代币元数据不匹配：USDG=${usdgSymbol}/${usdgDecimals}, SPY=${spySymbol}/${spyDecimals}, PAIR=${pairSymbol}/${pairDecimals}`,
    )
  }
}

async function getPoolState(poolId, expectedFee) {
  const [[sqrtPriceX96, tick, protocolFee, lpFee], liquidity] = await Promise.all([
    publicClient.readContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] }),
    publicClient.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [poolId],
    }),
  ])
  if (sqrtPriceX96 === 0n || liquidity === 0n || lpFee !== expectedFee) {
    throw new Error(`池状态异常：pool=${poolId}, sqrt=${sqrtPriceX96}, liquidity=${liquidity}, lpFee=${lpFee}`)
  }
  return { sqrtPriceX96, tick, protocolFee, lpFee, liquidity }
}

function makeSpyPairPool(state) {
  const spyToken = new Token(CHAIN_ID, SPY, 18, 'SPY', 'Robinhood SPY Stock Token')
  const pairToken = new Token(CHAIN_ID, PAIR, 18, 'PAIR', 'PAIR')
  const pool = new Pool(
    spyToken,
    pairToken,
    POOL_FEE,
    SPY_PAIR_TICK_SPACING,
    SPY_PAIR_HOOK,
    state.sqrtPriceX96.toString(),
    state.liquidity.toString(),
    state.tick,
  )
  if (pool.poolId.toLowerCase() !== SPY_PAIR_POOL_ID.toLowerCase())
    throw new Error(`PAIR/SPY SDK PoolId 不匹配：${pool.poolId}`)
  return pool
}

function makeUsdgPairPool(state) {
  const usdgToken = new Token(CHAIN_ID, USDG, 6, 'USDG', 'Global Dollar')
  const pairToken = new Token(CHAIN_ID, PAIR, 18, 'PAIR', 'PAIR')
  const pool = new Pool(
    usdgToken,
    pairToken,
    POOL_FEE,
    USDG_PAIR_TICK_SPACING,
    zeroAddress,
    state.sqrtPriceX96.toString(),
    state.liquidity.toString(),
    state.tick,
  )
  if (pool.poolId.toLowerCase() !== USDG_PAIR_POOL_ID.toLowerCase())
    throw new Error(`PAIR/USDG SDK PoolId 不匹配：${pool.poolId}`)
  return pool
}

function positionStateId(tokenId, tickLower, tickUpper) {
  const salt = padHex(toHex(tokenId), { size: 32 })
  return keccak256(
    encodePacked(['address', 'int24', 'int24', 'bytes32'], [POSITION_MANAGER, tickLower, tickUpper, salt]),
  )
}

function wrappingSub(left, right) {
  return (left - right + UINT256_MODULUS) % UINT256_MODULUS
}

async function accruedFees(poolId, tokenId, tickLower, tickUpper) {
  const id = positionStateId(tokenId, tickLower, tickUpper)
  const [[liquidity, last0, last1], [inside0, inside1]] = await Promise.all([
    publicClient.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getPositionInfo',
      args: [poolId, id],
    }),
    publicClient.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getFeeGrowthInside',
      args: [poolId, tickLower, tickUpper],
    }),
  ])
  return {
    liquidity,
    amount0: (liquidity * wrappingSub(inside0, last0)) / Q128,
    amount1: (liquidity * wrappingSub(inside1, last1)) / Q128,
  }
}

async function readPositionRecords(records) {
  const reads = []
  for (const record of records) {
    const tokenId = BigInt(record.tokenId)
    const [owner, liquidity, fees] = await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
      }),
      accruedFees(SPY_PAIR_POOL_ID, tokenId, record.tickLower, record.tickUpper),
    ])
    if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`NFT ${tokenId} 不在执行钱包：${owner}`)
    if (liquidity === 0n) throw new Error(`NFT ${tokenId} 链上流动性为 0`)
    if (record.liquidity && liquidity !== BigInt(record.liquidity)) {
      throw new Error(`NFT ${tokenId} 流动性与账本不一致：chain=${liquidity}, local=${record.liquidity}`)
    }
    if (fees.liquidity !== liquidity) throw new Error(`NFT ${tokenId} 手续费状态流动性不一致`)
    reads.push({ record, tokenId, owner, liquidity, fees })
  }
  return reads
}

async function assertPositionInvariants(records) {
  for (const record of records) {
    const tokenId = BigInt(record.tokenId)
    const [owner, liquidity] = await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
      }),
    ])
    if (owner.toLowerCase() !== WALLET.toLowerCase() || liquidity !== BigInt(record.liquidity)) {
      throw new Error(`源 NFT ${record.tokenId} 所有权或流动性发生变化`)
    }
  }
}

function buildCollect(record, liquidity, spyPoolState) {
  const position = new Position({
    pool: makeSpyPairPool(spyPoolState),
    liquidity: liquidity.toString(),
    tickLower: record.tickLower,
    tickUpper: record.tickUpper,
  })
  const method = V4PositionManager.collectCallParameters(position, {
    tokenId: String(record.tokenId),
    recipient: WALLET,
    slippageTolerance: MINT_SLIPPAGE,
    deadline: BigInt(nowSeconds() + 5 * 60).toString(),
    hookData: '0x',
  })
  return method.calldata
}

function buildCollectBatch(positionReads, spyPoolState) {
  const calls = positionReads.map((item) => buildCollect(item.record, item.liquidity, spyPoolState))
  if (!calls.length) throw new Error('没有可领取手续费的源 NFT')
  return encodeFunctionData({
    abi: POSITION_MANAGER_MULTICALL_ABI,
    functionName: 'multicall',
    args: [calls],
  })
}

function v3Path(tokens, fees) {
  const types = ['address']
  const values = [tokens[0]]
  for (let index = 0; index < fees.length; index += 1) {
    types.push('uint24', 'address')
    values.push(fees[index], tokens[index + 1])
  }
  return encodePacked(types, values)
}

async function quoteEthToUsdg(amountIn) {
  const candidates = []
  for (const fee of FEE_TIERS) {
    const pathBytes = v3Path([WETH, USDG], [fee])
    try {
      const { result } = await publicClient.simulateContract({
        address: V3_QUOTER,
        abi: V3_QUOTER_ABI,
        functionName: 'quoteExactInput',
        args: [pathBytes, amountIn],
        account: WALLET,
      })
      if (result[0] > 0n) candidates.push({ fee, path: pathBytes, amountOut: result[0], quoterGas: result[3] })
    } catch {
      // Missing fee tier.
    }
  }
  candidates.sort((left, right) => (left.amountOut > right.amountOut ? -1 : left.amountOut < right.amountOut ? 1 : 0))
  if (!candidates.length) throw new Error('没有可执行的 ETH→USDG V3 路径')
  return candidates[0]
}

function buildV3SwapData(pathBytes, amountIn, amountOutMinimum) {
  return encodeFunctionData({
    abi: V3_ROUTER_ABI,
    functionName: 'exactInput',
    args: [{ path: pathBytes, recipient: WALLET, amountIn, amountOutMinimum }],
  })
}

async function quoteV4(poolKey, amountIn, zeroForOne, label) {
  if (amountIn <= 0n || amountIn > (1n << 128n) - 1n) throw new Error(`${label} 输入数量无效：${amountIn}`)
  const { result } = await publicClient.simulateContract({
    address: V4_QUOTER,
    abi: V4_QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
    account: WALLET,
  })
  const amountOut = Array.isArray(result) ? result[0] : result.amountOut
  const gasEstimate = Array.isArray(result) ? result[1] : result.gasEstimate
  if (amountOut <= 0n) throw new Error(`${label} 报价为 0`)
  return { amountOut, gasEstimate }
}

function buildV4SwapInput(poolKey, amountIn, amountOutMinimum, zeroForOne) {
  const inputCurrency = zeroForOne ? poolKey.currency0 : poolKey.currency1
  const outputCurrency = zeroForOne ? poolKey.currency1 : poolKey.currency0
  const swap = encodeAbiParameters(
    parseAbiParameters(
      '((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData) params',
    ),
    [[poolKey, zeroForOne, amountIn, amountOutMinimum, 0n, '0x']],
  )
  const settle = encodeAbiParameters(parseAbiParameters('address currency,uint256 amount,bool payerIsUser'), [
    inputCurrency,
    amountIn,
    true,
  ])
  const take = encodeAbiParameters(parseAbiParameters('address currency,address recipient,uint256 amount'), [
    outputCurrency,
    WALLET,
    0n,
  ])
  return encodeAbiParameters(parseAbiParameters('bytes actions,bytes[] params'), ['0x060b0e', [swap, settle, take]])
}

function buildV4SwapData(poolKey, amountIn, amountOutMinimum, deadline, zeroForOne) {
  const v4Input = buildV4SwapInput(poolKey, amountIn, amountOutMinimum, zeroForOne)
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: ['0x10', [v4Input], deadline],
  })
}

function buildCombinedV4SwapData(legs, deadline) {
  if (!legs.length) throw new Error('没有可执行的 PAIR 兑换腿')
  const commands = `0x${legs.map(() => '10').join('')}`
  const inputs = legs.map((leg) => buildV4SwapInput(leg.poolKey, leg.amountIn, leg.amountOutMinimum, leg.zeroForOne))
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: [commands, inputs, deadline],
  })
}

function pairPriceUsdgAtTick(tick) {
  return 1e12 / Math.pow(1.0001, tick)
}

function directRangeUnitAmounts(poolState) {
  const position = new Position({
    pool: makeUsdgPairPool(poolState),
    liquidity: (10n ** 24n).toString(),
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
  })
  const usdgAtomic = asBigInt(position.amount0.quotient)
  const pairWei = asBigInt(position.amount1.quotient)
  if (usdgAtomic === 0n || pairWei === 0n) throw new Error('目标窄区间当前不是双边头寸')
  return { usdgAtomic, pairWei }
}

async function solveDirectRebalance(usdgAtomic, pairWei, poolState) {
  if (usdgAtomic < 0n || pairWei < 0n || (usdgAtomic === 0n && pairWei === 0n))
    throw new Error('PAIR/USDG 配平资产无效')
  const unit = directRangeUnitAmounts(poolState)
  const imbalanceAtZero = pairWei * unit.usdgAtomic - usdgAtomic * unit.pairWei
  if (imbalanceAtZero === 0n) {
    return {
      direction: 'NONE',
      zeroForOne: null,
      amountIn: 0n,
      amountOut: 0n,
      expectedUsdgAtomic: usdgAtomic,
      expectedPairWei: pairWei,
      imbalance: 0n,
      unit,
    }
  }
  const zeroForOne = imbalanceAtZero < 0n
  const direction = zeroForOne ? 'USDG_TO_PAIR' : 'PAIR_TO_USDG'
  const maximumInput = zeroForOne ? usdgAtomic : pairWei
  const evaluate = async (amountIn) => {
    if (amountIn === 0n)
      return {
        amountIn,
        amountOut: 0n,
        expectedUsdgAtomic: usdgAtomic,
        expectedPairWei: pairWei,
        imbalance: imbalanceAtZero,
      }
    const quote = await quoteV4(usdgPairPoolKey, amountIn, zeroForOne, direction)
    const expectedUsdgAtomic = zeroForOne ? usdgAtomic - amountIn : usdgAtomic + quote.amountOut
    const expectedPairWei = zeroForOne ? pairWei + quote.amountOut : pairWei - amountIn
    return {
      amountIn,
      amountOut: quote.amountOut,
      gasEstimate: quote.gasEstimate,
      expectedUsdgAtomic,
      expectedPairWei,
      imbalance: expectedPairWei * unit.usdgAtomic - expectedUsdgAtomic * unit.pairWei,
    }
  }
  let low = 0n
  let high = maximumInput
  for (let iteration = 0; iteration < SOLVER_ITERATIONS; iteration += 1) {
    const middle = (low + high) / 2n
    if (middle === low || middle === high) break
    const candidate = await evaluate(middle)
    if (zeroForOne ? candidate.imbalance >= 0n : candidate.imbalance <= 0n) high = middle
    else low = middle
  }
  const [lowCandidate, highCandidate] = await Promise.all([evaluate(low), evaluate(high)])
  const selected =
    absoluteBigInt(lowCandidate.imbalance) <= absoluteBigInt(highCandidate.imbalance) ? lowCandidate : highCandidate
  if (selected.amountIn <= 0n || selected.amountIn >= maximumInput)
    throw new Error(`${direction} 配平数量无效：${selected.amountIn}`)
  return { direction, zeroForOne, ...selected, unit }
}

function buildUnsignedDirectPosition(poolState, usdgAtomic, pairWei) {
  const pool = makeUsdgPairPool(poolState)
  const raw = Position.fromAmounts({
    pool,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    amount0: usdgAtomic.toString(),
    amount1: pairWei.toString(),
    useFullPrecision: true,
  })
  let liquidity = asBigInt(raw.liquidity)
  if (liquidity === 0n) throw new Error('目标窄区间可铸造流动性为 0')
  const rawMaximums = raw.mintAmountsWithSlippage(MINT_SLIPPAGE)
  const rawMax0 = asBigInt(rawMaximums.amount0)
  const rawMax1 = asBigInt(rawMaximums.amount1)
  let scale = minBigInt(10n ** 18n, (usdgAtomic * 10n ** 18n) / rawMax0, (pairWei * 10n ** 18n) / rawMax1)
  scale = (scale * (10_000n - MINT_SAFETY_BPS)) / 10_000n
  liquidity = (liquidity * scale) / 10n ** 18n
  let position
  let amount0Max
  let amount1Max
  for (let attempt = 0; attempt < 6; attempt += 1) {
    position = new Position({ pool, liquidity: liquidity.toString(), tickLower: TICK_LOWER, tickUpper: TICK_UPPER })
    const maximums = position.mintAmountsWithSlippage(MINT_SLIPPAGE)
    amount0Max = asBigInt(maximums.amount0)
    amount1Max = asBigInt(maximums.amount1)
    if (amount0Max <= usdgAtomic && amount1Max <= pairWei) break
    liquidity = (liquidity * 9_999n) / 10_000n
  }
  if (!position || amount0Max > usdgAtomic || amount1Max > pairWei) throw new Error('窄区间滑点上限超过可用余额')
  return {
    pool,
    position,
    liquidity,
    amount0Desired: asBigInt(position.mintAmounts.amount0),
    amount1Desired: asBigInt(position.mintAmounts.amount1),
    amount0Max,
    amount1Max,
  }
}

async function signPermitBatch(account, amount0Max, amount1Max) {
  if (amount0Max > UINT160_MAX || amount1Max > UINT160_MAX) throw new Error('Permit2 授权金额超过 uint160')
  const [, , nonce0] = await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [WALLET, USDG, POSITION_MANAGER],
  })
  const [, , nonce1] = await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [WALLET, PAIR, POSITION_MANAGER],
  })
  const permitBatch = {
    details: [
      { token: USDG, amount: amount0Max, expiration: BigInt(nowSeconds() + 30 * 60), nonce: nonce0 },
      { token: PAIR, amount: amount1Max, expiration: BigInt(nowSeconds() + 30 * 60), nonce: nonce1 },
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

async function buildDirectMint(account, poolState, usdgAtomic, pairWei) {
  const built = buildUnsignedDirectPosition(poolState, usdgAtomic, pairWei)
  const batchPermit = await signPermitBatch(account, built.amount0Max, built.amount1Max)
  const method = V4PositionManager.addCallParameters(built.position, {
    recipient: WALLET,
    slippageTolerance: MINT_SLIPPAGE,
    deadline: BigInt(nowSeconds() + 5 * 60).toString(),
    hookData: '0x',
    batchPermit,
  })
  return { ...built, data: method.calldata }
}

async function transactionBudget(to, data, value = 0n) {
  await publicClient.call({ account: WALLET, to, data, value })
  const [estimatedGas, gasPrice] = await Promise.all([
    publicClient.estimateGas({ account: WALLET, to, data, value }),
    publicClient.getGasPrice(),
  ])
  const gasLimit = (estimatedGas * 120n) / 100n + 10_000n
  const sendGasPrice = (gasPrice * SEND_GAS_PRICE_BPS + 9_999n) / 10_000n
  const maxGasBudget = (gasLimit * sendGasPrice * 125n) / 100n
  return { estimatedGas, gasLimit, gasPrice, sendGasPrice, maxGasBudget }
}

async function runStep(
  walletClient,
  state,
  key,
  { label, to, data, value = 0n, minimumBalanceAfter = MIN_FINAL_ETH, metadata = {} },
) {
  state.steps ||= {}
  let step = state.steps[key]
  if (step?.status === 'confirmed') return step
  if (step?.hash) {
    let receipt
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: step.hash })
    } catch {
      throw new Error(`${label} 已有交易哈希但回执仍未知，禁止重发：${step.hash}`)
    }
    if (receipt.status !== 'success') throw new Error(`${label} 链上回执失败：${step.hash}`)
    step.status = 'confirmed'
    step.blockNumber = receipt.blockNumber.toString()
    step.gasUsed = receipt.gasUsed.toString()
    step.effectiveGasPrice = receipt.effectiveGasPrice.toString()
    step.gasCostWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString()
    writeState(state)
    appendAudit(
      'receipt_reconciled',
      { key, label, hash: step.hash, blockNumber: receipt.blockNumber, gasCostWei: step.gasCostWei },
      state,
    )
    return step
  }

  const budget = await transactionBudget(to, data, value)
  if (state.gasPolicy?.maximumGasPriceWei && budget.gasPrice > BigInt(state.gasPolicy.maximumGasPriceWei)) {
    throw new Error(
      `${label} 等待 Gas：当前 ${formatUnits(budget.gasPrice, 9)} gwei，高于整套流程门槛 ${formatUnits(BigInt(state.gasPolicy.maximumGasPriceWei), 9)} gwei`,
    )
  }
  if (state.gasPolicy?.maximumGasWei) {
    const spent = stepGasTotal(state)
    const maximumStepCost = budget.gasLimit * budget.sendGasPrice
    if (spent + maximumStepCost > BigInt(state.gasPolicy.maximumGasWei)) {
      throw new Error(`${label} 等待 Gas：累计实际费用加本笔上限将超过 ${state.gasPolicy.maximumGasUsdg} USDG`)
    }
  }
  const balance = await publicClient.getBalance({ address: WALLET })
  if (balance < value + budget.maxGasBudget + minimumBalanceAfter) {
    throw new Error(
      `${label} 资金保护触发：余额 ${formatEther(balance)} ETH，需保留 ${formatEther(value + budget.maxGasBudget + minimumBalanceAfter)} ETH`,
    )
  }
  const [nonceLatest, noncePending] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`${label} 广播前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  step = {
    ...metadata,
    status: 'prepared',
    label,
    nonce: noncePending,
    valueWei: value.toString(),
    gasEstimate: budget.estimatedGas.toString(),
    gasLimit: budget.gasLimit.toString(),
    gasPriceWei: budget.gasPrice.toString(),
    maxGasBudgetWei: budget.maxGasBudget.toString(),
  }
  state.steps[key] = step
  writeState(state)
  appendAudit('transaction_prepared', { key, ...step }, state)

  let hash
  try {
    hash = await walletClient.sendTransaction({
      account: walletClient.account,
      to,
      data,
      value,
      gas: budget.gasLimit,
      gasPrice: budget.sendGasPrice,
      nonce: noncePending,
    })
  } catch (error) {
    step.status = 'failed_before_hash'
    step.error = error.shortMessage || error.message
    writeState(state)
    appendAudit('broadcast_failed_before_hash', { key, label, message: step.error }, state)
    throw error
  }
  step.hash = hash
  step.status = 'broadcast'
  writeState(state)
  appendAudit('broadcast', { key, label, hash }, state)

  let receipt
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 })
  } catch (error) {
    step.status = 'receipt_unknown'
    step.error = error.shortMessage || error.message
    writeState(state)
    appendAudit('receipt_unknown', { key, label, hash, message: step.error }, state)
    throw new Error(`${label} 已广播但回执未知，禁止自动重发：${hash}`)
  }
  if (receipt.status !== 'success') {
    step.status = 'reverted'
    step.blockNumber = receipt.blockNumber.toString()
    writeState(state)
    appendAudit('receipt_reverted', { key, label, hash, blockNumber: receipt.blockNumber }, state)
    throw new Error(`${label} 链上回执失败：${hash}`)
  }
  step.status = 'confirmed'
  step.blockNumber = receipt.blockNumber.toString()
  step.gasUsed = receipt.gasUsed.toString()
  step.effectiveGasPrice = receipt.effectiveGasPrice.toString()
  step.gasCostWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString()
  writeState(state)
  appendAudit(
    'receipt_success',
    {
      key,
      label,
      hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      gasCostWei: step.gasCostWei,
    },
    state,
  )
  console.log(`${label}: ${hash} (${EXPLORER_TX}${hash})`)
  return step
}

async function ensureErc20Approval(walletClient, state, key, token, required, label) {
  if (required <= 0n) return null
  const allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [WALLET, PERMIT2],
  })
  if (allowance >= required) return null
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, maxUint256] })
  return runStep(walletClient, state, key, { label, to: token, data })
}

async function ensurePermit2RouterApproval(walletClient, state, key, token, required, label) {
  if (required <= 0n) return null
  const [amount, expiration] = await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [WALLET, token, UNIVERSAL_ROUTER],
  })
  if (amount >= required && expiration > BigInt(nowSeconds() + 300)) return null
  const data = encodeFunctionData({
    abi: PERMIT2_ABI,
    functionName: 'approve',
    args: [token, UNIVERSAL_ROUTER, required > UINT160_MAX ? UINT160_MAX : required, BigInt(nowSeconds() + 60 * 60)],
  })
  return runStep(walletClient, state, key, { label, to: PERMIT2, data })
}

function parseMintTokenId(receipt) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== POSITION_MANAGER.toLowerCase()) continue
    try {
      const parsed = decodeEventLog({ abi: POSITION_NFT_ABI, data: log.data, topics: log.topics })
      if (
        parsed.eventName === 'Transfer' &&
        parsed.args.from === zeroAddress &&
        parsed.args.to.toLowerCase() === WALLET.toLowerCase()
      )
        return parsed.args.id
    } catch {
      // Ignore unrelated PositionManager logs.
    }
  }
  return null
}

function stepGasTotal(state) {
  return Object.values(state.steps || {}).reduce((sum, step) => sum + BigInt(step.gasCostWei || 0), 0n)
}

async function preflight({ print = true, requireReady = false } = {}) {
  const existing = readJson(STATE_PATH)
  if (existing?.status === 'active') {
    const report = { status: 'ALREADY_ACTIVE', tokenId: existing.position.tokenId, poolId: USDG_PAIR_POOL_ID }
    if (print) console.log(stringify(report))
    return { existing, report }
  }
  if (existing && existing.status !== 'exited') {
    const report = { status: 'RESUME_REQUIRED', operationId: existing.operationId, phase: existing.status }
    if (print) console.log(stringify(report))
    return { existing, report }
  }
  assertRuntimeParameters()
  const pairState = readJson(PAIR_STATE_PATH)
  if (!pairState || pairState.status !== 'active') throw new Error('PAIR/SPY 主账本不是 active')
  assertNoPairPending(pairState)
  const records = activePairPositions(pairState)
  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const [
    blockNumber,
    nonceLatest,
    noncePending,
    gasPrice,
    ethBalance,
    spyBalance,
    pairBalance,
    usdgBalance,
    spyPoolState,
    directPoolState,
    positionReads,
    ethQuote,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    publicClient.getGasPrice(),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(SPY_PAIR_POOL_ID, POOL_FEE),
    getPoolState(USDG_PAIR_POOL_ID, POOL_FEE),
    readPositionRecords(records),
    quoteEthToUsdg(PRINCIPAL_ETH),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (directPoolState.tick < TICK_LOWER || directPoolState.tick >= TICK_UPPER) {
    throw new Error(`PAIR/USDG 现价已离开目标区间：tick=${directPoolState.tick}, range=[${TICK_LOWER},${TICK_UPPER})`)
  }
  const rangePositionBps = (BigInt(directPoolState.tick - TICK_LOWER) * 10_000n) / BigInt(TICK_UPPER - TICK_LOWER)
  if (rangePositionBps < 2_000n || rangePositionBps > 7_500n)
    throw new Error(`PAIR/USDG 现价距目标边界过近：rangeBps=${rangePositionBps}`)

  const totalFeeSpy = positionReads.reduce((sum, item) => sum + item.fees.amount0, 0n)
  const totalFeePair = positionReads.reduce((sum, item) => sum + item.fees.amount1, 0n)
  const allSpy = spyBalance + totalFeeSpy
  const spySwapQuote =
    allSpy > 0n ? await quoteV4(spyPairPoolKey, allSpy, true, 'SPY_TO_PAIR') : { amountOut: 0n, gasEstimate: 0n }
  const projectedPair = totalFeePair + spySwapQuote.amountOut
  const projectedUsdg = ethQuote.amountOut
  const directPlan = await solveDirectRebalance(projectedUsdg, projectedPair, directPoolState)
  const projectedPosition = buildUnsignedDirectPosition(
    directPoolState,
    directPlan.expectedUsdgAtomic,
    directPlan.expectedPairWei,
  )

  const collectBatchData = buildCollectBatch(positionReads, spyPoolState)
  const collectBatchBudget = await transactionBudget(POSITION_MANAGER, collectBatchData)
  const ethSwapData = buildV3SwapData(ethQuote.path, PRINCIPAL_ETH, bpsFloor(ethQuote.amountOut, ETH_SWAP_SLIPPAGE_BPS))
  const ethSwapBudget = await transactionBudget(V3_ROUTER, ethSwapData, PRINCIPAL_ETH)
  const directInputToken = directPlan.zeroForOne ? USDG : PAIR
  const directInputRequired = directPlan.amountIn
  const erc20Requirements = new Map([
    [SPY, allSpy],
    [USDG, directPlan.zeroForOne ? maxUint256 : projectedPosition.amount0Max],
    [PAIR, directPlan.zeroForOne ? projectedPosition.amount1Max : maxUint256],
  ])
  if (directPlan.zeroForOne)
    erc20Requirements.set(
      USDG,
      directInputRequired > projectedPosition.amount0Max ? directInputRequired : projectedPosition.amount0Max,
    )
  else
    erc20Requirements.set(
      PAIR,
      directInputRequired > projectedPosition.amount1Max ? directInputRequired : projectedPosition.amount1Max,
    )
  const [spyErc20Allowance, usdgErc20Allowance, pairErc20Allowance, spyRouterAllowance, directRouterAllowance] =
    await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
      publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
      publicClient.readContract({
        address: PERMIT2,
        abi: PERMIT2_ABI,
        functionName: 'allowance',
        args: [WALLET, SPY, UNIVERSAL_ROUTER],
      }),
      publicClient.readContract({
        address: PERMIT2,
        abi: PERMIT2_ABI,
        functionName: 'allowance',
        args: [WALLET, directInputToken, UNIVERSAL_ROUTER],
      }),
    ])
  const erc20Allowances = new Map([
    [SPY, spyErc20Allowance],
    [USDG, usdgErc20Allowance],
    [PAIR, pairErc20Allowance],
  ])
  const requiredErc20Approvals = [...erc20Requirements.entries()]
    .filter(([, required]) => required > 0n)
    .filter(([token, required]) => erc20Allowances.get(token) < required)
  const routerApprovalRequired = (allowance, required) =>
    required > 0n && (allowance[0] < required || allowance[1] <= BigInt(nowSeconds() + 300))
  const requiredRouterApprovals =
    Number(routerApprovalRequired(spyRouterAllowance, allSpy)) +
    Number(routerApprovalRequired(directRouterAllowance, directInputRequired))
  let modeledGasUnits = collectBatchBudget.estimatedGas + ethSwapBudget.estimatedGas + GAS_MODEL.mint
  if (allSpy > 0n) modeledGasUnits += GAS_MODEL.v4Swap
  if (directPlan.amountIn > 0n) modeledGasUnits += GAS_MODEL.v4Swap
  modeledGasUnits += BigInt(requiredErc20Approvals.length) * GAS_MODEL.erc20Approval
  modeledGasUnits += BigInt(requiredRouterApprovals) * GAS_MODEL.permit2Approval
  const safeModeledGasUnits = (modeledGasUnits * GAS_MODEL_SAFETY_BPS + 9_999n) / 10_000n
  const modeledSendGasPrice = (gasPrice * SEND_GAS_PRICE_BPS + 9_999n) / 10_000n
  const modeledGasWei = safeModeledGasUnits * modeledSendGasPrice
  const maximumGasAtomic = parseUnits(MAX_GAS_USDG, 6)
  const maximumGasWei = (maximumGasAtomic * PRINCIPAL_ETH) / ethQuote.amountOut
  const maximumGasPriceWei = (maximumGasWei * 10_000n) / (safeModeledGasUnits * SEND_GAS_PRICE_BPS)
  const modeledGasAtomic = (modeledGasWei * ethQuote.amountOut) / PRINCIPAL_ETH
  const requiredEth = PRINCIPAL_ETH + MIN_FINAL_ETH + maximumGasWei
  const balanceReady = ethBalance >= requiredEth
  const gasReady = modeledGasWei <= maximumGasWei
  const status = !balanceReady ? 'NEEDS_ETH_TOP_UP' : !gasReady ? 'WAIT_GAS' : 'READY'
  const gasPolicy = {
    maximumGasUsdg: MAX_GAS_USDG,
    maximumGasWei: maximumGasWei.toString(),
    maximumGasPriceWei: maximumGasPriceWei.toString(),
    modeledGasUnits: modeledGasUnits.toString(),
    safeModeledGasUnits: safeModeledGasUnits.toString(),
    ethQuoteUsdgAtomic: ethQuote.amountOut.toString(),
    ethQuoteInputWei: PRINCIPAL_ETH.toString(),
  }
  const report = {
    status,
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    choice: {
      pool: 'PAIR/USDG 1%',
      poolId: USDG_PAIR_POOL_ID,
      reason:
        'fixed USD range and no SPY exposure; latest 6h fee velocity is near PAIR/SPY while 3% direct pool is materially weaker',
    },
    balances: {
      eth: formatEther(ethBalance),
      spy: formatUnits(spyBalance, 18),
      pairPreserved: formatUnits(pairBalance, 18),
      usdgPreserved: formatUnits(usdgBalance, 6),
    },
    sourcePositions: positionReads.map((item) => ({
      role: item.record.role,
      tokenId: item.tokenId.toString(),
      tickLower: item.record.tickLower,
      tickUpper: item.record.tickUpper,
      liquidity: item.liquidity.toString(),
      estimatedFeeSpy: formatUnits(item.fees.amount0, 18),
      estimatedFeePair: formatUnits(item.fees.amount1, 18),
    })),
    estimatedFees: {
      spy: formatUnits(totalFeeSpy, 18),
      pair: formatUnits(totalFeePair, 18),
      walletPlusFeesSpyToSwap: formatUnits(allSpy, 18),
      quotedPairFromAllSpy: formatUnits(spySwapQuote.amountOut, 18),
    },
    newPrincipal: {
      eth: formatEther(PRINCIPAL_ETH),
      ethToUsdgFeeTier: ethQuote.fee,
      quotedUsdg: formatUnits(ethQuote.amountOut, 6),
      minimumUsdg: formatUnits(bpsFloor(ethQuote.amountOut, ETH_SWAP_SLIPPAGE_BPS), 6),
    },
    target: {
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      requestedPriceLowUsdg: pairPriceUsdgAtTick(TICK_UPPER).toFixed(8),
      requestedPriceHighUsdg: pairPriceUsdgAtTick(TICK_LOWER).toFixed(8),
      executablePriceLowUsdg: pairPriceUsdgAtTick(TICK_UPPER).toFixed(8),
      executablePriceHighUsdg: pairPriceUsdgAtTick(TICK_LOWER).toFixed(8),
      currentTick: directPoolState.tick,
      currentPairPriceUsdg: pairPriceUsdgAtTick(directPoolState.tick).toFixed(8),
      rangePositionPct: (Number(rangePositionBps) / 100).toFixed(2),
      activeLiquidity: directPoolState.liquidity.toString(),
      protocolFeePacked: directPoolState.protocolFee,
    },
    rebalance: {
      direction: directPlan.direction,
      input:
        directPlan.direction === 'USDG_TO_PAIR'
          ? formatUnits(directPlan.amountIn, 6)
          : formatUnits(directPlan.amountIn, 18),
      quotedOutput:
        directPlan.direction === 'USDG_TO_PAIR'
          ? formatUnits(directPlan.amountOut, 18)
          : formatUnits(directPlan.amountOut, 6),
      expectedUsdgForMint: formatUnits(directPlan.expectedUsdgAtomic, 6),
      expectedPairForMint: formatUnits(directPlan.expectedPairWei, 18),
    },
    projectedMint: {
      desiredUsdg: formatUnits(projectedPosition.amount0Desired, 6),
      desiredPair: formatUnits(projectedPosition.amount1Desired, 18),
      liquidity: projectedPosition.liquidity.toString(),
    },
    gas: {
      gasPriceGwei: (Number(gasPrice) / 1e9).toFixed(6),
      modeledGasUnits: modeledGasUnits.toString(),
      safeModeledGasUnits: safeModeledGasUnits.toString(),
      modeledGasEth: formatEther(modeledGasWei),
      modeledGasUsdg: formatUnits(modeledGasAtomic, 6),
      maximumGasUsdg: MAX_GAS_USDG,
      maximumGasEth: formatEther(maximumGasWei),
      maximumGasPriceGwei: formatUnits(maximumGasPriceWei, 9),
      collectMode: 'single PositionManager multicall for all source NFTs',
      expectedApprovalTransactions: requiredErc20Approvals.length + requiredRouterApprovals,
      minimumFinalEth: formatEther(MIN_FINAL_ETH),
      requiredEth: formatEther(requiredEth),
      projectedFinalEthBeforeActualGas: formatEther(ethBalance - PRINCIPAL_ETH),
    },
    policy: {
      collectFeesOnly: true,
      preserveAllSourceLiquidity: true,
      swapAllWalletSpyToPair: true,
      preservePreExistingWalletPair: true,
      preservePreExistingWalletUsdg: true,
      principalEth: formatEther(PRINCIPAL_ETH),
      swapSlippageBps: Number(SWAP_SLIPPAGE_BPS),
      ethSwapSlippageBps: Number(ETH_SWAP_SLIPPAGE_BPS),
      mintSlippageBps: 50,
      autoExit: false,
    },
  }
  appendAudit('preflight', report)
  if (print) console.log(stringify(report))
  if (requireReady && status !== 'READY') throw new Error(`预检未就绪：${status}`)
  return {
    report,
    pairState,
    positionReads,
    blockNumber,
    ethBalance,
    spyBalance,
    pairBalance,
    usdgBalance,
    directPoolState,
    gasPolicy,
  }
}

async function collectAllFees(walletClient, state) {
  const existing = state.steps?.collect_batch
  if (existing?.status === 'confirmed' && existing.spyReceivedWei !== undefined) return
  if (existing?.status === 'confirmed') {
    const [spyAfter, pairAfter] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    ])
    await assertPositionInvariants(state.sourcePositions)
    if (spyAfter < BigInt(existing.spyBeforeWei) || pairAfter < BigInt(existing.pairBeforeWei))
      throw new Error('恢复批量领取后余额异常')
    existing.spyReceivedWei = (spyAfter - BigInt(existing.spyBeforeWei)).toString()
    existing.pairReceivedWei = (pairAfter - BigInt(existing.pairBeforeWei)).toString()
    writeState(state)
    return
  }
  await assertPositionInvariants(state.sourcePositions)
  const [spyBefore, pairBefore, spyPoolState] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(SPY_PAIR_POOL_ID, POOL_FEE),
  ])
  const positionReads = state.sourcePositions.map((source) => ({
    record: source,
    liquidity: BigInt(source.liquidity),
  }))
  const data = buildCollectBatch(positionReads, spyPoolState)
  const step = await runStep(walletClient, state, 'collect_batch', {
    label: `一笔领取 ${state.sourcePositions.length} 个 PAIR/SPY NFT 手续费`,
    to: POSITION_MANAGER,
    data,
    metadata: {
      spyBeforeWei: spyBefore.toString(),
      pairBeforeWei: pairBefore.toString(),
      tokenIds: state.sourcePositions.map((source) => source.tokenId),
    },
  })
  const [spyAfter, pairAfter] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  await assertPositionInvariants(state.sourcePositions)
  if (spyAfter < spyBefore || pairAfter < pairBefore) throw new Error('批量领取后余额异常')
  step.spyReceivedWei = (spyAfter - spyBefore).toString()
  step.pairReceivedWei = (pairAfter - pairBefore).toString()
  writeState(state)
}

async function swapAllSpy(walletClient, state) {
  const existing = state.steps?.swap_all_spy
  if (existing?.status === 'confirmed') {
    if (existing.outputPairWei === undefined) {
      const [spyAfter, pairAfter] = await Promise.all([
        publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      ])
      const outputPair = pairAfter - BigInt(existing.pairBeforeWei)
      if (spyAfter !== 0n || outputPair < BigInt(existing.minimumPairWei))
        throw new Error('恢复 SPY→PAIR 成交回读不符合保护条件')
      existing.outputPairWei = outputPair.toString()
      writeState(state)
    }
    return
  }
  const spyBalance = await publicClient.readContract({
    address: SPY,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [WALLET],
  })
  if (spyBalance === 0n) return
  await ensureErc20Approval(walletClient, state, 'approve_spy_erc20', SPY, spyBalance, '授权 SPY 给 Permit2')
  await ensurePermit2RouterApproval(
    walletClient,
    state,
    'approve_spy_router',
    SPY,
    spyBalance,
    '授权 Universal Router 使用全部 SPY',
  )
  const [liveSpy, pairBefore] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  const quote = await quoteV4(spyPairPoolKey, liveSpy, true, 'SPY_TO_PAIR')
  const minimum = bpsFloor(quote.amountOut, SWAP_SLIPPAGE_BPS)
  const data = buildV4SwapData(spyPairPoolKey, liveSpy, minimum, BigInt(nowSeconds() + 5 * 60), true)
  const step = await runStep(walletClient, state, 'swap_all_spy', {
    label: '全部 SPY 换成 PAIR',
    to: UNIVERSAL_ROUTER,
    data,
    metadata: {
      inputSpyWei: liveSpy.toString(),
      pairBeforeWei: pairBefore.toString(),
      minimumPairWei: minimum.toString(),
    },
  })
  const [spyAfter, pairAfter] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  if (spyAfter !== 0n || pairAfter - pairBefore < minimum) throw new Error('SPY→PAIR 成交回读不符合保护条件')
  step.inputSpyWei = liveSpy.toString()
  step.outputPairWei = (pairAfter - pairBefore).toString()
  step.minimumPairWei = minimum.toString()
  writeState(state)
}

async function fundUsdg(walletClient, state) {
  const existing = state.steps?.eth_to_usdg
  if (existing?.status === 'confirmed' && existing.outputUsdgAtomic !== undefined) return
  if (existing?.status === 'confirmed') {
    const usdgAfter = await publicClient.readContract({
      address: USDG,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [WALLET],
    })
    const outputUsdg = usdgAfter - BigInt(existing.usdgBeforeAtomic)
    if (outputUsdg < BigInt(existing.minimumUsdgAtomic)) throw new Error('恢复 ETH→USDG 成交回读低于滑点保护')
    existing.outputUsdgAtomic = outputUsdg.toString()
    writeState(state)
    return
  }
  const usdgBefore = await publicClient.readContract({
    address: USDG,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [WALLET],
  })
  const quote = await quoteEthToUsdg(PRINCIPAL_ETH)
  const minimum = bpsFloor(quote.amountOut, ETH_SWAP_SLIPPAGE_BPS)
  const data = buildV3SwapData(quote.path, PRINCIPAL_ETH, minimum)
  const step = await runStep(walletClient, state, 'eth_to_usdg', {
    label: `用新增 ${formatEther(PRINCIPAL_ETH)} ETH 买入 USDG`,
    to: V3_ROUTER,
    data,
    value: PRINCIPAL_ETH,
    metadata: { usdgBeforeAtomic: usdgBefore.toString(), minimumUsdgAtomic: minimum.toString(), feeTier: quote.fee },
  })
  const usdgAfter = await publicClient.readContract({
    address: USDG,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [WALLET],
  })
  if (usdgAfter - usdgBefore < minimum) throw new Error('ETH→USDG 成交回读低于滑点保护')
  step.outputUsdgAtomic = (usdgAfter - usdgBefore).toString()
  step.minimumUsdgAtomic = minimum.toString()
  step.feeTier = quote.fee
  writeState(state)
}

async function rebalanceDirect(walletClient, state) {
  const existing = state.steps?.direct_rebalance
  if (existing?.status === 'confirmed' && existing.actualInput !== undefined) return
  if (existing?.status === 'confirmed') {
    const [usdgAfter, pairAfter] = await Promise.all([
      publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    ])
    const zeroForOne = existing.direction === 'USDG_TO_PAIR'
    const actualInput = zeroForOne
      ? BigInt(existing.usdgBeforeAtomic) - usdgAfter
      : BigInt(existing.pairBeforeWei) - pairAfter
    const actualOutput = zeroForOne
      ? pairAfter - BigInt(existing.pairBeforeWei)
      : usdgAfter - BigInt(existing.usdgBeforeAtomic)
    if (actualInput !== BigInt(existing.plannedInput) || actualOutput < BigInt(existing.minimumOutput))
      throw new Error('恢复 PAIR/USDG 配平成交回读不符合保护条件')
    existing.actualInput = actualInput.toString()
    existing.actualOutput = actualOutput.toString()
    writeState(state)
    return
  }
  const [usdgBalance, pairBalance, poolState] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(USDG_PAIR_POOL_ID, POOL_FEE),
  ])
  const availableUsdg = usdgBalance - BigInt(state.baseline.usdgAtomic)
  const availablePair = pairBalance - BigInt(state.baseline.pairWei)
  if (availableUsdg <= 0n || availablePair <= 0n) throw new Error('PAIR/USDG 配平前本次可用资产不是双边')
  const plan = await solveDirectRebalance(availableUsdg, availablePair, poolState)
  if (plan.direction === 'NONE') {
    state.steps.direct_rebalance = {
      status: 'confirmed',
      label: '无需 PAIR/USDG 配平',
      actualInput: '0',
      actualOutput: '0',
      direction: 'NONE',
      gasCostWei: '0',
    }
    writeState(state)
    return
  }
  const inputToken = plan.zeroForOne ? USDG : PAIR
  const inputSymbol = plan.zeroForOne ? 'USDG' : 'PAIR'
  const outputSymbol = plan.zeroForOne ? 'PAIR' : 'USDG'
  await ensureErc20Approval(
    walletClient,
    state,
    `approve_${inputSymbol.toLowerCase()}_erc20_swap`,
    inputToken,
    plan.amountIn,
    `授权 ${inputSymbol} 给 Permit2`,
  )
  await ensurePermit2RouterApproval(
    walletClient,
    state,
    `approve_${inputSymbol.toLowerCase()}_router`,
    inputToken,
    plan.amountIn,
    `授权 Universal Router 使用 ${inputSymbol}`,
  )
  const [usdgBefore, pairBefore] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  const quote = await quoteV4(usdgPairPoolKey, plan.amountIn, plan.zeroForOne, plan.direction)
  const minimum = bpsFloor(quote.amountOut, SWAP_SLIPPAGE_BPS)
  const data = buildV4SwapData(usdgPairPoolKey, plan.amountIn, minimum, BigInt(nowSeconds() + 5 * 60), plan.zeroForOne)
  const step = await runStep(walletClient, state, 'direct_rebalance', {
    label: `PAIR/USDG 窄仓配平 ${inputSymbol}→${outputSymbol}`,
    to: UNIVERSAL_ROUTER,
    data,
    metadata: {
      direction: plan.direction,
      plannedInput: plan.amountIn.toString(),
      minimumOutput: minimum.toString(),
      usdgBeforeAtomic: usdgBefore.toString(),
      pairBeforeWei: pairBefore.toString(),
    },
  })
  const [usdgAfter, pairAfter] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  const actualInput = plan.zeroForOne ? usdgBefore - usdgAfter : pairBefore - pairAfter
  const actualOutput = plan.zeroForOne ? pairAfter - pairBefore : usdgAfter - usdgBefore
  if (actualInput !== plan.amountIn || actualOutput < minimum) throw new Error('PAIR/USDG 配平成交回读不符合保护条件')
  step.direction = plan.direction
  step.actualInput = actualInput.toString()
  step.actualOutput = actualOutput.toString()
  step.minimumOutput = minimum.toString()
  writeState(state)
}

async function mintDirect(walletClient, account, state) {
  if (state.steps?.mint?.status === 'confirmed' && state.steps.mint.tokenId) return
  await assertPositionInvariants(state.sourcePositions)
  const [usdgBefore, pairBefore, poolState] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(USDG_PAIR_POOL_ID, POOL_FEE),
  ])
  if (poolState.tick < TICK_LOWER || poolState.tick >= TICK_UPPER)
    throw new Error(`mint 前价格离开窄区间：tick=${poolState.tick}`)
  const positionBps = (BigInt(poolState.tick - TICK_LOWER) * 10_000n) / BigInt(TICK_UPPER - TICK_LOWER)
  if (positionBps < 1_000n || positionBps > 9_000n) throw new Error(`mint 前价格距边界过近：rangeBps=${positionBps}`)
  const availableUsdg = usdgBefore - BigInt(state.baseline.usdgAtomic)
  const availablePair = pairBefore - BigInt(state.baseline.pairWei)
  if (availableUsdg <= 0n || availablePair <= 0n) throw new Error('mint 前本次可用 PAIR/USDG 不是双边')
  await ensureErc20Approval(
    walletClient,
    state,
    'approve_usdg_erc20_mint',
    USDG,
    availableUsdg,
    '确认 USDG 给 Permit2 的铸仓授权',
  )
  await ensureErc20Approval(
    walletClient,
    state,
    'approve_pair_erc20_mint',
    PAIR,
    availablePair,
    '确认 PAIR 给 Permit2 的铸仓授权',
  )

  const [freshUsdg, freshPair, freshPoolState] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(USDG_PAIR_POOL_ID, POOL_FEE),
  ])
  const mintUsdg = freshUsdg - BigInt(state.baseline.usdgAtomic)
  const mintPair = freshPair - BigInt(state.baseline.pairWei)
  const mint = await buildDirectMint(account, freshPoolState, mintUsdg, mintPair)
  state.mintPlan = {
    poolTick: freshPoolState.tick,
    liquidity: mint.liquidity.toString(),
    desiredUsdgAtomic: mint.amount0Desired.toString(),
    desiredPairWei: mint.amount1Desired.toString(),
    maxUsdgAtomic: mint.amount0Max.toString(),
    maxPairWei: mint.amount1Max.toString(),
    usdgBeforeAtomic: freshUsdg.toString(),
    pairBeforeWei: freshPair.toString(),
  }
  writeState(state)
  const step = await runStep(walletClient, state, 'mint', {
    label: '铸造 PAIR/USDG 1% 窄区间 LP',
    to: POSITION_MANAGER,
    data: mint.data,
  })
  const receipt = await publicClient.getTransactionReceipt({ hash: step.hash })
  const tokenId = parseMintTokenId(receipt)
  if (tokenId === null) throw new Error(`mint 成功但未解析到 NFT：${step.hash}`)
  step.tokenId = tokenId.toString()
  writeState(state)
}

async function finalize(state) {
  const mintStep = state.steps?.mint
  if (!mintStep?.hash || mintStep.status !== 'confirmed' || !mintStep.tokenId)
    throw new Error('mint 尚未完成，不能结算')
  const tokenId = BigInt(mintStep.tokenId)
  const [owner, liquidity, finalEth, finalSpy, finalPair, finalUsdg, poolState] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    }),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(USDG_PAIR_POOL_ID, POOL_FEE),
  ])
  if (owner.toLowerCase() !== WALLET.toLowerCase() || liquidity === 0n)
    throw new Error('新 NFT 所有权或流动性读回不完整')
  if (liquidity !== BigInt(state.mintPlan.liquidity))
    throw new Error(`新 NFT 流动性与计划不一致：chain=${liquidity}, plan=${state.mintPlan.liquidity}`)
  if (finalSpy !== 0n) throw new Error(`钱包仍有 SPY：${formatUnits(finalSpy, 18)}`)
  if (finalPair < BigInt(state.baseline.pairWei) || finalUsdg < BigInt(state.baseline.usdgAtomic))
    throw new Error('新仓动用了受保护的原有 PAIR/USDG')
  if (finalEth < MIN_FINAL_ETH) throw new Error(`最终 ETH 低于保护线：${formatEther(finalEth)}`)
  await assertPositionInvariants(state.sourcePositions)

  const position = new Position({
    pool: makeUsdgPairPool(poolState),
    liquidity: liquidity.toString(),
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
  })
  const underlyingUsdg = asBigInt(position.amount0.quotient)
  const underlyingPair = asBigInt(position.amount1.quotient)
  const actualMintUsdg = BigInt(state.mintPlan.usdgBeforeAtomic) - finalUsdg
  const actualMintPair = BigInt(state.mintPlan.pairBeforeWei) - finalPair
  const totalCollectedSpy = BigInt(state.steps.collect_batch?.spyReceivedWei || 0)
  const totalCollectedPair = BigInt(state.steps.collect_batch?.pairReceivedWei || 0)
  const receipt = await publicClient.getTransactionReceipt({ hash: mintStep.hash })
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
  state.status = 'active'
  state.completedAt = new Date().toISOString()
  state.position = {
    tokenId: tokenId.toString(),
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    liquidity: liquidity.toString(),
    mintBlock: receipt.blockNumber.toString(),
    mintTransaction: mintStep.hash,
    enteredAt: new Date(Number(block.timestamp) * 1_000).toISOString(),
  }
  state.result = {
    collectedFees: { spyWei: totalCollectedSpy.toString(), pairWei: totalCollectedPair.toString() },
    spySwap: state.steps.swap_all_spy || null,
    ethToUsdg: state.steps.eth_to_usdg || null,
    directRebalance: state.steps.direct_rebalance || null,
    mint: {
      actualUsdgAtomic: actualMintUsdg.toString(),
      actualPairWei: actualMintPair.toString(),
      underlyingUsdgAtomic: underlyingUsdg.toString(),
      underlyingPairWei: underlyingPair.toString(),
    },
    residual: {
      usdgAtomic: (finalUsdg - BigInt(state.baseline.usdgAtomic)).toString(),
      pairWei: (finalPair - BigInt(state.baseline.pairWei)).toString(),
      spyWei: finalSpy.toString(),
    },
    finalBalances: {
      ethWei: finalEth.toString(),
      spyWei: finalSpy.toString(),
      pairWei: finalPair.toString(),
      usdgAtomic: finalUsdg.toString(),
    },
    finalPool: {
      tick: poolState.tick,
      pairPriceUsdg: pairPriceUsdgAtTick(poolState.tick).toFixed(8),
      inRange: poolState.tick >= TICK_LOWER && poolState.tick < TICK_UPPER,
    },
    gasSpentWei: stepGasTotal(state).toString(),
    sourceLiquidityUnchanged: true,
  }
  writeState(state)
  archiveFeesToPairState(state)
  appendAudit('entry_complete', { operationId: state.operationId, position: state.position, result: state.result })
  console.log(
    stringify({
      status: 'ACTIVE',
      pool: 'PAIR/USDG 1%',
      tokenId: state.position.tokenId,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      priceLowUsdg: pairPriceUsdgAtTick(TICK_UPPER).toFixed(8),
      priceHighUsdg: pairPriceUsdgAtTick(TICK_LOWER).toFixed(8),
      finalPairPriceUsdg: state.result.finalPool.pairPriceUsdg,
      inRange: state.result.finalPool.inRange,
      collectedFees: { spy: formatUnits(totalCollectedSpy, 18), pair: formatUnits(totalCollectedPair, 18) },
      lpUnderlying: { usdg: formatUnits(underlyingUsdg, 6), pair: formatUnits(underlyingPair, 18) },
      residual: {
        usdg: formatUnits(BigInt(state.result.residual.usdgAtomic), 6),
        pair: formatUnits(BigInt(state.result.residual.pairWei), 18),
        spy: formatUnits(finalSpy, 18),
      },
      gasSpentEth: formatEther(BigInt(state.result.gasSpentWei)),
      finalEth: formatEther(finalEth),
      sourceLiquidityUnchanged: true,
      transactions: Object.values(state.steps)
        .filter((step) => step.hash)
        .map((step) => step.hash),
    }),
  )
}

async function execute(state) {
  applyStateRuntime(state)
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  try {
    await assertPositionInvariants(state.sourcePositions)
    await collectAllFees(walletClient, state)
    await swapAllSpy(walletClient, state)
    await fundUsdg(walletClient, state)
    await rebalanceDirect(walletClient, state)
    await mintDirect(walletClient, account, state)
    await finalize(state)
  } catch (error) {
    const latest = readJson(STATE_PATH) || state
    if (latest.status !== 'active') {
      latest.status = 'partial'
      latest.lastErrorAt = new Date().toISOString()
      latest.lastError = error.shortMessage || error.message
      writeState(latest)
      appendAudit('operation_partial', {
        operationId: latest.operationId,
        message: latest.lastError,
        steps: latest.steps,
      })
    }
    throw error
  }
}

async function enter() {
  const existing = readJson(STATE_PATH)
  if (existing?.status === 'active') {
    console.log(stringify({ status: 'ALREADY_ACTIVE', tokenId: existing.position.tokenId }))
    return
  }
  if (existing && existing.status !== 'exited') return execute(existing)
  const check = await preflight({ print: true, requireReady: true })
  const state = {
    schemaVersion: 1,
    name: 'PAIR/USDG 1% 窄区间复投仓一号',
    status: 'planned',
    operationId: `pair-usdg-narrow-${new Date().toISOString().replace(/[-:.]/g, '')}`,
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    wallet: WALLET,
    chainId: CHAIN_ID,
    pool: { poolId: USDG_PAIR_POOL_ID, ...usdgPairPoolKey },
    policy: check.report.policy,
    target: check.report.target,
    gasPolicy: check.gasPolicy,
    baseline: {
      ethWei: check.ethBalance.toString(),
      startingSpyWeiToUse: check.spyBalance.toString(),
      pairWei: check.pairBalance.toString(),
      usdgAtomic: check.usdgBalance.toString(),
    },
    sourcePositions: check.positionReads.map((item) => ({
      role: item.record.role,
      tokenId: item.tokenId.toString(),
      tickLower: item.record.tickLower,
      tickUpper: item.record.tickUpper,
      liquidity: item.liquidity.toString(),
      estimatedFeeSpyWei: item.fees.amount0.toString(),
      estimatedFeePairWei: item.fees.amount1.toString(),
    })),
    steps: {},
  }
  writeState(state)
  appendAudit('plan_created', state)
  return execute(state)
}

async function resume() {
  const state = readJson(STATE_PATH)
  if (!state || state.status === 'exited') throw new Error('没有可恢复的 PAIR/USDG 窄仓操作')
  if (state.status === 'active') {
    console.log(stringify({ status: 'ALREADY_ACTIVE', tokenId: state.position.tokenId }))
    return
  }
  applyStateRuntime(state)
  return execute(state)
}

async function status() {
  const state = readJson(STATE_PATH)
  const [eth, spy, pair, usdg, poolState, nonceLatest, noncePending] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(USDG_PAIR_POOL_ID, POOL_FEE),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  const report = {
    status: state?.status || 'NOT_ENTERED',
    operationId: state?.operationId || null,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    pool: {
      poolId: USDG_PAIR_POOL_ID,
      tick: poolState.tick,
      pairPriceUsdg: pairPriceUsdgAtTick(poolState.tick).toFixed(8),
    },
    balances: {
      eth: formatEther(eth),
      spy: formatUnits(spy, 18),
      pair: formatUnits(pair, 18),
      usdg: formatUnits(usdg, 6),
    },
    pendingSteps: state && state.status !== 'active' ? state.steps : null,
  }
  if (state?.status === 'active' && state.position?.tokenId) {
    const tokenId = BigInt(state.position.tokenId)
    const [owner, liquidity, fees] = await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
      }),
      accruedFees(USDG_PAIR_POOL_ID, tokenId, state.position.tickLower, state.position.tickUpper),
    ])
    const position = new Position({
      pool: makeUsdgPairPool(poolState),
      liquidity: liquidity.toString(),
      tickLower: state.position.tickLower,
      tickUpper: state.position.tickUpper,
    })
    report.position = {
      tokenId: tokenId.toString(),
      owner,
      liquidity: liquidity.toString(),
      tickLower: state.position.tickLower,
      tickUpper: state.position.tickUpper,
      priceLowUsdg: pairPriceUsdgAtTick(state.position.tickUpper).toFixed(8),
      priceHighUsdg: pairPriceUsdgAtTick(state.position.tickLower).toFixed(8),
      inRange: poolState.tick >= state.position.tickLower && poolState.tick < state.position.tickUpper,
      underlying: {
        usdg: formatUnits(asBigInt(position.amount0.quotient), 6),
        pair: formatUnits(asBigInt(position.amount1.quotient), 18),
      },
      accruedFees: { usdg: formatUnits(fees.amount0, 6), pair: formatUnits(fees.amount1, 18) },
    }
  }
  console.log(stringify(report))
}

function buildDirectCollect(record, liquidity, poolState) {
  const position = new Position({
    pool: makeUsdgPairPool(poolState),
    liquidity: liquidity.toString(),
    tickLower: record.tickLower,
    tickUpper: record.tickUpper,
  })
  return V4PositionManager.collectCallParameters(position, {
    tokenId: String(record.tokenId),
    recipient: WALLET,
    slippageTolerance: MINT_SLIPPAGE,
    deadline: BigInt(nowSeconds() + 5 * 60).toString(),
    hookData: '0x',
  }).calldata
}

async function readDirectPositionRecord(directState) {
  if (directState?.status !== 'active' || !directState.position?.tokenId)
    throw new Error('PAIR/USDG 本地账本不是 active')
  if (directState.pendingSteps) throw new Error('PAIR/USDG 账本存在未结算步骤')
  const record = directState.position
  const tokenId = BigInt(record.tokenId)
  const [owner, liquidity, fees] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    }),
    accruedFees(USDG_PAIR_POOL_ID, tokenId, record.tickLower, record.tickUpper),
  ])
  if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`PAIR/USDG NFT ${tokenId} 不在执行钱包：${owner}`)
  if (liquidity === 0n) throw new Error(`PAIR/USDG NFT ${tokenId} 链上流动性为 0`)
  if (record.liquidity && liquidity !== BigInt(record.liquidity)) {
    throw new Error(`PAIR/USDG NFT ${tokenId} 流动性与账本不一致：chain=${liquidity}, local=${record.liquidity}`)
  }
  if (fees.liquidity !== liquidity) throw new Error(`PAIR/USDG NFT ${tokenId} 手续费状态流动性不一致`)
  return { record, tokenId, owner, liquidity, fees }
}

function buildAllFeesCollectBatch(pairReads, directRead, spyPoolState, directPoolState) {
  const calls = [
    ...pairReads.map((item) => buildCollect(item.record, item.liquidity, spyPoolState)),
    buildDirectCollect(directRead.record, directRead.liquidity, directPoolState),
  ]
  return encodeFunctionData({
    abi: POSITION_MANAGER_MULTICALL_ABI,
    functionName: 'multicall',
    args: [calls],
  })
}

async function feesCollectPreflight({ print = true, requireReady = false } = {}) {
  const existing = readJson(FEES_COLLECT_STATE_PATH)
  if (existing && existing.status !== 'complete') {
    const report = { status: 'RESUME_REQUIRED', operationId: existing.operationId, phase: existing.status }
    if (print) console.log(stringify(report))
    return { existing, report }
  }

  const pairState = readJson(PAIR_STATE_PATH)
  const directState = readJson(STATE_PATH)
  if (!pairState || pairState.status !== 'active') throw new Error('PAIR/SPY 主账本不是 active')
  assertNoPairPending(pairState)
  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()

  const pairRecords = activePairPositions(pairState)
  const [
    blockNumber,
    nonceLatest,
    noncePending,
    ethBalance,
    spyBalance,
    pairBalance,
    usdgBalance,
    spyPoolState,
    directPoolState,
    pairReads,
    directRead,
    ethQuote,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(SPY_PAIR_POOL_ID, POOL_FEE),
    getPoolState(USDG_PAIR_POOL_ID, POOL_FEE),
    readPositionRecords(pairRecords),
    readDirectPositionRecord(directState),
    quoteEthToUsdg(parseEther('0.01')),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)

  const feeSpy = pairReads.reduce((sum, item) => sum + item.fees.amount0, 0n)
  const feePairFromSpyPool = pairReads.reduce((sum, item) => sum + item.fees.amount1, 0n)
  const feeUsdg = directRead.fees.amount0
  const feePairFromDirectPool = directRead.fees.amount1
  const feePair = feePairFromSpyPool + feePairFromDirectPool
  const collectData = buildAllFeesCollectBatch(pairReads, directRead, spyPoolState, directPoolState)
  const collectBudget = await transactionBudget(POSITION_MANAGER, collectData)
  const maximumGasAtomic = parseUnits(MAX_GAS_USDG, 6)
  const maximumGasWei = (maximumGasAtomic * parseEther('0.01')) / ethQuote.amountOut
  const maximumGasPriceWei = (maximumGasWei * 10_000n) / (collectBudget.gasLimit * SEND_GAS_PRICE_BPS)
  const estimatedGasWei = collectBudget.estimatedGas * collectBudget.sendGasPrice
  const sendCeilingGasWei = collectBudget.gasLimit * collectBudget.sendGasPrice
  const estimatedGasAtomic = (estimatedGasWei * ethQuote.amountOut) / parseEther('0.01')
  const sendCeilingGasAtomic = (sendCeilingGasWei * ethQuote.amountOut) / parseEther('0.01')
  const hasFees = feeSpy > 0n || feePair > 0n || feeUsdg > 0n
  const balanceReady = ethBalance >= MIN_FINAL_ETH + collectBudget.maxGasBudget
  const gasReady = sendCeilingGasWei <= maximumGasWei
  const status = !hasFees ? 'NO_FEES' : !balanceReady ? 'NEEDS_ETH_TOP_UP' : !gasReady ? 'WAIT_GAS' : 'READY'
  const report = {
    status,
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    balances: {
      eth: formatEther(ethBalance),
      spy: formatUnits(spyBalance, 18),
      pair: formatUnits(pairBalance, 18),
      usdg: formatUnits(usdgBalance, 6),
    },
    sourcePositions: [
      ...pairReads.map((item) => ({
        pool: 'PAIR/SPY',
        tokenId: item.tokenId.toString(),
        liquidity: item.liquidity.toString(),
        feeSpy: formatUnits(item.fees.amount0, 18),
        feePair: formatUnits(item.fees.amount1, 18),
      })),
      {
        pool: 'PAIR/USDG',
        tokenId: directRead.tokenId.toString(),
        liquidity: directRead.liquidity.toString(),
        feeUsdg: formatUnits(directRead.fees.amount0, 6),
        feePair: formatUnits(directRead.fees.amount1, 18),
      },
    ],
    estimatedTotalFees: {
      spy: formatUnits(feeSpy, 18),
      pair: formatUnits(feePair, 18),
      usdg: formatUnits(feeUsdg, 6),
    },
    gas: {
      gasPriceGwei: formatUnits(collectBudget.gasPrice, 9),
      sendGasPriceGwei: formatUnits(collectBudget.sendGasPrice, 9),
      estimatedGasUnits: collectBudget.estimatedGas.toString(),
      gasLimit: collectBudget.gasLimit.toString(),
      estimatedGasEth: formatEther(estimatedGasWei),
      estimatedGasUsdg: formatUnits(estimatedGasAtomic, 6),
      sendCeilingGasEth: formatEther(sendCeilingGasWei),
      sendCeilingGasUsdg: formatUnits(sendCeilingGasAtomic, 6),
      maximumGasUsdg: MAX_GAS_USDG,
      maximumGasEth: formatEther(maximumGasWei),
      maximumGasPriceGwei: formatUnits(maximumGasPriceWei, 9),
      expectedTransactions: 1,
      collectionMode: `one PositionManager multicall for ${pairReads.length + 1} active NFTs`,
      minimumFinalEth: formatEther(MIN_FINAL_ETH),
    },
    policy: {
      collectFeesOnly: true,
      preserveAllLpLiquidity: true,
      noSwap: true,
      noReinvest: true,
      maximumGasUsdg: MAX_GAS_USDG,
      minimumFinalEth: formatEther(MIN_FINAL_ETH),
    },
  }
  appendAudit('fees_collect_preflight', report, { operationType: 'fees_collect' })
  if (print) console.log(stringify(report))
  if (requireReady && status !== 'READY') throw new Error(`批量领取手续费预检未就绪：${status}`)
  return {
    report,
    pairReads,
    directRead,
    blockNumber,
    balances: { ethBalance, spyBalance, pairBalance, usdgBalance },
    gasPolicy: {
      maximumGasUsdg: MAX_GAS_USDG,
      maximumGasWei: maximumGasWei.toString(),
      maximumGasPriceWei: maximumGasPriceWei.toString(),
    },
  }
}

async function bestUsdgToPairQuote(amountIn) {
  if (amountIn <= 0n) return null
  const candidates = [
    { id: 'pair-usdg-1', feeLabel: '1%', poolId: USDG_PAIR_POOL_ID, poolKey: usdgPairPoolKey },
    { id: 'pair-usdg-3', feeLabel: '3%', poolId: USDG_PAIR_3_POOL_ID, poolKey: usdgPair3PoolKey },
  ]
  const results = []
  for (const candidate of candidates) {
    try {
      const quote = await quoteV4(candidate.poolKey, amountIn, true, `USDG_TO_PAIR_${candidate.feeLabel}`)
      results.push({ ...candidate, ...quote })
    } catch (error) {
      results.push({ ...candidate, error: error.shortMessage || error.message })
    }
  }
  const executable = results.filter((item) => item.amountOut > 0n)
  executable.sort((left, right) => (left.amountOut > right.amountOut ? -1 : left.amountOut < right.amountOut ? 1 : 0))
  if (!executable.length)
    throw new Error(
      `USDG→PAIR 无可执行路线：${results.map((item) => `${item.feeLabel}=${item.error || '0'}`).join('; ')}`,
    )
  return { selected: executable[0], candidates: results }
}

function swapRetention(amountIn, amountOut, kind, spyPoolState, directPoolState) {
  if (amountIn <= 0n) return 1
  const outputPair = Number(formatUnits(amountOut, 18))
  if (kind === 'SPY') {
    const inputSpy = Number(formatUnits(amountIn, 18))
    const spotPair = inputSpy * Math.pow(1.0001, spyPoolState.tick)
    return outputPair / spotPair
  }
  const inputUsdg = Number(formatUnits(amountIn, 6))
  const spotPair = inputUsdg / pairPriceUsdgAtTick(directPoolState.tick)
  return outputPair / spotPair
}

async function approvalRequirements(token, required) {
  if (required <= 0n) return { erc20: false, permit2: false }
  const [erc20Allowance, permit2Allowance] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
    publicClient.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [WALLET, token, UNIVERSAL_ROUTER],
    }),
  ])
  return {
    erc20: erc20Allowance < required,
    permit2: permit2Allowance[0] < required || permit2Allowance[1] <= BigInt(nowSeconds() + 300),
  }
}

async function feesToPairPreflight({ print = true, requireReady = false } = {}) {
  const existing = readJson(FEES_TO_PAIR_STATE_PATH)
  if (existing && existing.status !== 'complete') {
    const report = { status: 'RESUME_REQUIRED', operationId: existing.operationId, phase: existing.status }
    if (print) console.log(stringify(report))
    return { existing, report }
  }
  const pairState = readJson(PAIR_STATE_PATH)
  const directState = readJson(STATE_PATH)
  if (!pairState || pairState.status !== 'active') throw new Error('PAIR/SPY 主账本不是 active')
  assertNoPairPending(pairState)
  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const pairRecords = activePairPositions(pairState)
  const [
    blockNumber,
    nonceLatest,
    noncePending,
    gasPrice,
    ethBalance,
    spyBalance,
    pairBalance,
    usdgBalance,
    spyPoolState,
    directPoolState,
    pairReads,
    directRead,
    ethQuote,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    publicClient.getGasPrice(),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(SPY_PAIR_POOL_ID, POOL_FEE),
    getPoolState(USDG_PAIR_POOL_ID, POOL_FEE),
    readPositionRecords(pairRecords),
    readDirectPositionRecord(directState),
    quoteEthToUsdg(parseEther('0.01')),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)

  const feeSpy = pairReads.reduce((sum, item) => sum + item.fees.amount0, 0n)
  const feePairFromSpyPool = pairReads.reduce((sum, item) => sum + item.fees.amount1, 0n)
  const feeUsdg = directRead.fees.amount0
  const feePairFromDirectPool = directRead.fees.amount1
  const projectedSpy = spyBalance + feeSpy
  const projectedUsdg = usdgBalance + feeUsdg
  const projectedPair = pairBalance + feePairFromSpyPool + feePairFromDirectPool
  const [spyQuote, usdgRoute] = await Promise.all([
    projectedSpy > 0n ? quoteV4(spyPairPoolKey, projectedSpy, true, 'SPY_TO_PAIR') : null,
    bestUsdgToPairQuote(projectedUsdg),
  ])
  const spyRetention = spyQuote
    ? swapRetention(projectedSpy, spyQuote.amountOut, 'SPY', spyPoolState, directPoolState)
    : 1
  const usdgRetention = usdgRoute
    ? swapRetention(projectedUsdg, usdgRoute.selected.amountOut, 'USDG', spyPoolState, directPoolState)
    : 1
  const priceReady = spyRetention >= 0.96 && usdgRetention >= 0.96

  const collectData = buildAllFeesCollectBatch(pairReads, directRead, spyPoolState, directPoolState)
  const collectBudget = await transactionBudget(POSITION_MANAGER, collectData)
  const [spyApprovals, usdgApprovals] = await Promise.all([
    approvalRequirements(SPY, projectedSpy),
    approvalRequirements(USDG, projectedUsdg),
  ])
  const erc20Approvals = Number(spyApprovals.erc20) + Number(usdgApprovals.erc20)
  const permit2Approvals = Number(spyApprovals.permit2) + Number(usdgApprovals.permit2)
  const modeledGasUnits =
    collectBudget.estimatedGas +
    (projectedSpy > 0n ? GAS_MODEL.v4Swap : 0n) +
    (projectedUsdg > 0n ? GAS_MODEL.v4Swap : 0n) +
    BigInt(erc20Approvals) * GAS_MODEL.erc20Approval +
    BigInt(permit2Approvals) * GAS_MODEL.permit2Approval
  const safeModeledGasUnits = (modeledGasUnits * GAS_MODEL_SAFETY_BPS + 9_999n) / 10_000n
  const modeledSendGasPrice = (gasPrice * SEND_GAS_PRICE_BPS + 9_999n) / 10_000n
  const modeledGasWei = safeModeledGasUnits * modeledSendGasPrice
  const maximumGasAtomic = parseUnits(MAX_GAS_USDG, 6)
  const maximumGasWei = (maximumGasAtomic * parseEther('0.01')) / ethQuote.amountOut
  const maximumGasPriceWei = (maximumGasWei * 10_000n) / (safeModeledGasUnits * SEND_GAS_PRICE_BPS)
  const modeledGasAtomic = (modeledGasWei * ethQuote.amountOut) / parseEther('0.01')
  const balanceReady = ethBalance >= MIN_FINAL_ETH + maximumGasWei
  const gasReady = modeledGasWei <= maximumGasWei
  const status = !balanceReady
    ? 'NEEDS_ETH_TOP_UP'
    : !gasReady
      ? 'WAIT_GAS'
      : !priceReady
        ? 'QUOTE_IMPACT_TOO_HIGH'
        : 'READY'
  const report = {
    status,
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    balances: {
      eth: formatEther(ethBalance),
      spy: formatUnits(spyBalance, 18),
      pair: formatUnits(pairBalance, 18),
      usdg: formatUnits(usdgBalance, 6),
    },
    sourcePositions: [
      ...pairReads.map((item) => ({
        pool: 'PAIR/SPY',
        tokenId: item.tokenId.toString(),
        liquidity: item.liquidity.toString(),
        feeSpy: formatUnits(item.fees.amount0, 18),
        feePair: formatUnits(item.fees.amount1, 18),
      })),
      {
        pool: 'PAIR/USDG',
        tokenId: directRead.tokenId.toString(),
        liquidity: directRead.liquidity.toString(),
        feeUsdg: formatUnits(directRead.fees.amount0, 6),
        feePair: formatUnits(directRead.fees.amount1, 18),
      },
    ],
    projectedWalletAfterCollect: {
      spyToSwap: formatUnits(projectedSpy, 18),
      usdgToSwap: formatUnits(projectedUsdg, 6),
      pairBeforeSwaps: formatUnits(projectedPair, 18),
    },
    quotes: {
      spyToPair: spyQuote
        ? {
            inputSpy: formatUnits(projectedSpy, 18),
            outputPair: formatUnits(spyQuote.amountOut, 18),
            minimumPair: formatUnits(bpsFloor(spyQuote.amountOut, SWAP_SLIPPAGE_BPS), 18),
            spotRetentionPct: (spyRetention * 100).toFixed(3),
            route: 'PAIR/SPY 1%',
          }
        : null,
      usdgToPair: usdgRoute
        ? {
            inputUsdg: formatUnits(projectedUsdg, 6),
            outputPair: formatUnits(usdgRoute.selected.amountOut, 18),
            minimumPair: formatUnits(bpsFloor(usdgRoute.selected.amountOut, SWAP_SLIPPAGE_BPS), 18),
            spotRetentionPct: (usdgRetention * 100).toFixed(3),
            route: `PAIR/USDG ${usdgRoute.selected.feeLabel}`,
            candidates: usdgRoute.candidates.map((item) => ({
              feeLabel: item.feeLabel,
              outputPair: item.amountOut ? formatUnits(item.amountOut, 18) : null,
              error: item.error || null,
            })),
          }
        : null,
      projectedPairAfterSwaps: formatUnits(
        projectedPair + (spyQuote?.amountOut || 0n) + (usdgRoute?.selected.amountOut || 0n),
        18,
      ),
    },
    gas: {
      gasPriceGwei: formatUnits(gasPrice, 9),
      modeledGasUnits: modeledGasUnits.toString(),
      safeModeledGasUnits: safeModeledGasUnits.toString(),
      modeledGasEth: formatEther(modeledGasWei),
      modeledGasUsdg: formatUnits(modeledGasAtomic, 6),
      maximumGasUsdg: MAX_GAS_USDG,
      maximumGasEth: formatEther(maximumGasWei),
      maximumGasPriceGwei: formatUnits(maximumGasPriceWei, 9),
      expectedTransactions: 2 + erc20Approvals + permit2Approvals,
      collectionMode: 'one PositionManager multicall for five active NFTs',
      swapMode: 'one atomic Universal Router transaction for SPY and USDG legs',
      minimumFinalEth: formatEther(MIN_FINAL_ETH),
    },
    policy: {
      collectFeesOnly: true,
      preserveAllLpLiquidity: true,
      swapAllWalletSpy: true,
      swapAllWalletUsdg: true,
      preserveWalletPair: true,
      preserveEthForGas: true,
      swapSlippageBps: Number(SWAP_SLIPPAGE_BPS),
      maximumGasUsdg: MAX_GAS_USDG,
      minimumQuoteRetentionPct: 96,
    },
  }
  appendAudit('fees_to_pair_preflight', report, { operationType: 'fees_to_pair' })
  if (print) console.log(stringify(report))
  if (requireReady && status !== 'READY') throw new Error(`手续费换 PAIR 预检未就绪：${status}`)
  return {
    report,
    pairReads,
    directRead,
    blockNumber,
    balances: { ethBalance, spyBalance, pairBalance, usdgBalance },
    gasPolicy: {
      maximumGasUsdg: MAX_GAS_USDG,
      maximumGasWei: maximumGasWei.toString(),
      maximumGasPriceWei: maximumGasPriceWei.toString(),
    },
  }
}

async function assertFeesToPairInvariants(state) {
  await assertPositionInvariants(state.pairPositions)
  const direct = state.directPosition
  const [owner, liquidity] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [BigInt(direct.tokenId)],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(direct.tokenId)],
    }),
  ])
  if (owner.toLowerCase() !== WALLET.toLowerCase() || liquidity !== BigInt(direct.liquidity)) {
    throw new Error(`PAIR/USDG 源 NFT ${direct.tokenId} 所有权或流动性发生变化`)
  }
}

async function collectFeesForPair(walletClient, state) {
  const existing = state.steps?.collect_all_fees
  if (existing?.status === 'confirmed' && existing.received) return
  if (existing?.status === 'confirmed') {
    const [spyAfter, pairAfter, usdgAfter] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    ])
    existing.received = {
      spyWei: (spyAfter - BigInt(existing.spyBeforeWei)).toString(),
      pairWei: (pairAfter - BigInt(existing.pairBeforeWei)).toString(),
      usdgAtomic: (usdgAfter - BigInt(existing.usdgBeforeAtomic)).toString(),
    }
    writeState(state)
    return
  }
  await assertFeesToPairInvariants(state)
  const [spyBefore, pairBefore, usdgBefore, spyPoolState, directPoolState] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(SPY_PAIR_POOL_ID, POOL_FEE),
    getPoolState(USDG_PAIR_POOL_ID, POOL_FEE),
  ])
  const pairReads = state.pairPositions.map((record) => ({ record, liquidity: BigInt(record.liquidity) }))
  const directRead = { record: state.directPosition, liquidity: BigInt(state.directPosition.liquidity) }
  const data = buildAllFeesCollectBatch(pairReads, directRead, spyPoolState, directPoolState)
  const step = await runStep(walletClient, state, 'collect_all_fees', {
    label: `一笔领取 ${state.pairPositions.length + 1} 个活跃 LP 的手续费`,
    to: POSITION_MANAGER,
    data,
    metadata: {
      tokenIds: [...state.pairPositions.map((item) => item.tokenId), state.directPosition.tokenId],
      spyBeforeWei: spyBefore.toString(),
      pairBeforeWei: pairBefore.toString(),
      usdgBeforeAtomic: usdgBefore.toString(),
    },
  })
  const [spyAfter, pairAfter, usdgAfter] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  if (spyAfter < spyBefore || pairAfter < pairBefore || usdgAfter < usdgBefore) throw new Error('领取后钱包余额异常')
  step.received = {
    spyWei: (spyAfter - spyBefore).toString(),
    pairWei: (pairAfter - pairBefore).toString(),
    usdgAtomic: (usdgAfter - usdgBefore).toString(),
  }
  writeState(state)
  await assertFeesToPairInvariants(state)
}

async function finalizeFeesCollect(state) {
  await assertFeesToPairInvariants(state)
  const collect = state.steps?.collect_all_fees
  if (!collect?.hash || collect.status !== 'confirmed' || !collect.received) {
    throw new Error('批量领取尚未完成，不能结算')
  }
  const [eth, spy, pair, usdg, nonceLatest, noncePending, pairReadsAfter, directReadAfter] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    readPositionRecords(state.pairPositions),
    readDirectPositionRecord({ status: 'active', position: state.directPosition }),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`完成核验仍有 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (eth < MIN_FINAL_ETH) throw new Error(`完成后 ETH 低于保留线：${formatEther(eth)}`)

  state.status = 'complete'
  state.completedAt = new Date().toISOString()
  state.result = {
    collected: collect.received,
    gasSpentWei: stepGasTotal(state).toString(),
    finalBalances: {
      ethWei: eth.toString(),
      spyWei: spy.toString(),
      pairWei: pair.toString(),
      usdgAtomic: usdg.toString(),
    },
    postCollectAccrued: [
      ...pairReadsAfter.map((item) => ({
        pool: 'PAIR/SPY',
        tokenId: item.tokenId.toString(),
        feeSpyWei: item.fees.amount0.toString(),
        feePairWei: item.fees.amount1.toString(),
      })),
      {
        pool: 'PAIR/USDG',
        tokenId: directReadAfter.tokenId.toString(),
        feeUsdgAtomic: directReadAfter.fees.amount0.toString(),
        feePairWei: directReadAfter.fees.amount1.toString(),
      },
    ],
    sourceLiquidityUnchanged: true,
    noSwap: true,
    noReinvest: true,
    nonceLatest,
  }
  writeState(state)
  appendAudit(
    'fees_collect_complete',
    {
      operationId: state.operationId,
      result: state.result,
      transactions: [collect.hash],
    },
    state,
  )
  console.log(
    stringify({
      status: 'COMPLETE',
      operationId: state.operationId,
      collected: {
        spy: formatUnits(BigInt(collect.received.spyWei), 18),
        pair: formatUnits(BigInt(collect.received.pairWei), 18),
        usdg: formatUnits(BigInt(collect.received.usdgAtomic), 6),
      },
      final: {
        eth: formatEther(eth),
        spy: formatUnits(spy, 18),
        pair: formatUnits(pair, 18),
        usdg: formatUnits(usdg, 6),
      },
      gasSpentEth: formatEther(BigInt(state.result.gasSpentWei)),
      sourceLiquidityUnchanged: true,
      noSwap: true,
      transaction: {
        hash: collect.hash,
        explorer: `${EXPLORER_TX}${collect.hash}`,
      },
    }),
  )
}

async function executeFeesCollect(state) {
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  try {
    await assertFeesToPairInvariants(state)
    await collectFeesForPair(walletClient, state)
    await finalizeFeesCollect(state)
  } catch (error) {
    const latest = readJson(FEES_COLLECT_STATE_PATH) || state
    if (latest.status !== 'complete') {
      latest.status = 'partial'
      latest.lastErrorAt = new Date().toISOString()
      latest.lastError = error.shortMessage || error.message
      writeState(latest)
      appendAudit(
        'fees_collect_partial',
        { operationId: latest.operationId, message: latest.lastError, steps: latest.steps },
        latest,
      )
    }
    throw error
  }
}

async function feesCollectEnter() {
  const existing = readJson(FEES_COLLECT_STATE_PATH)
  if (existing && existing.status !== 'complete') return executeFeesCollect(existing)
  archiveFeesCollectState(existing)
  const check = await feesCollectPreflight({ print: true, requireReady: true })
  const state = {
    schemaVersion: 1,
    operationType: 'fees_collect',
    name: '领取全部活跃 PAIR LP 手续费（不兑换、不复投）',
    status: 'planned',
    operationId: `fees-collect-${new Date().toISOString().replace(/[-:.]/g, '')}`,
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    wallet: WALLET,
    chainId: CHAIN_ID,
    policy: check.report.policy,
    gasPolicy: check.gasPolicy,
    baseline: {
      ethWei: check.balances.ethBalance.toString(),
      spyWei: check.balances.spyBalance.toString(),
      pairWei: check.balances.pairBalance.toString(),
      usdgAtomic: check.balances.usdgBalance.toString(),
    },
    pairPositions: check.pairReads.map((item) => ({
      tokenId: item.tokenId.toString(),
      tickLower: item.record.tickLower,
      tickUpper: item.record.tickUpper,
      liquidity: item.liquidity.toString(),
      estimatedFeeSpyWei: item.fees.amount0.toString(),
      estimatedFeePairWei: item.fees.amount1.toString(),
    })),
    directPosition: {
      tokenId: check.directRead.tokenId.toString(),
      tickLower: check.directRead.record.tickLower,
      tickUpper: check.directRead.record.tickUpper,
      liquidity: check.directRead.liquidity.toString(),
      estimatedFeeUsdgAtomic: check.directRead.fees.amount0.toString(),
      estimatedFeePairWei: check.directRead.fees.amount1.toString(),
    },
    steps: {},
  }
  writeState(state)
  appendAudit('fees_collect_plan_created', state, state)
  return executeFeesCollect(state)
}

async function feesCollectResume() {
  const state = readJson(FEES_COLLECT_STATE_PATH)
  if (!state) throw new Error('没有可恢复的批量领取手续费操作')
  if (state.status === 'complete') {
    console.log(stringify({ status: 'ALREADY_COMPLETE', operationId: state.operationId, result: state.result }))
    return
  }
  return executeFeesCollect(state)
}

async function feesCollectStatus() {
  const state = readJson(FEES_COLLECT_STATE_PATH)
  const [eth, spy, pair, usdg, nonceLatest, noncePending] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  console.log(
    stringify({
      status: state?.status || 'NOT_STARTED',
      operationId: state?.operationId || null,
      lastError: state?.lastError || null,
      balances: {
        eth: formatEther(eth),
        spy: formatUnits(spy, 18),
        pair: formatUnits(pair, 18),
        usdg: formatUnits(usdg, 6),
      },
      nonceLatest,
      noncePending,
      steps: state?.steps || null,
      result: state?.result || null,
    }),
  )
}

async function swapWalletToPair(walletClient, state) {
  const existing = state.steps?.swap_spy_usdg_to_pair
  if (existing?.status === 'confirmed' && existing.actualPairOutWei) return
  if (existing?.status === 'confirmed') {
    const [spyAfter, pairAfter, usdgAfter] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    ])
    const pairOut = pairAfter - BigInt(existing.pairBeforeWei)
    if (spyAfter !== 0n || usdgAfter !== 0n || pairOut < BigInt(existing.minimumPairOutWei)) {
      throw new Error('恢复 SPY/USDG→PAIR 成交回读不符合保护条件')
    }
    existing.actualPairOutWei = pairOut.toString()
    writeState(state)
    return
  }
  let [spyBalance, usdgBalance] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  if (spyBalance === 0n && usdgBalance === 0n) {
    state.steps ||= {}
    state.steps.swap_spy_usdg_to_pair = {
      status: 'confirmed',
      label: '钱包没有 SPY/USDG，无需兑换',
      gasCostWei: '0',
      actualPairOutWei: '0',
      minimumPairOutWei: '0',
    }
    writeState(state)
    return
  }
  await ensureErc20Approval(walletClient, state, 'approve_spy_erc20_fees', SPY, spyBalance, '授权手续费 SPY 给 Permit2')
  await ensurePermit2RouterApproval(
    walletClient,
    state,
    'approve_spy_router_fees',
    SPY,
    spyBalance,
    '授权路由使用手续费 SPY',
  )
  await ensureErc20Approval(
    walletClient,
    state,
    'approve_usdg_erc20_fees',
    USDG,
    usdgBalance,
    '授权钱包 USDG 给 Permit2',
  )
  await ensurePermit2RouterApproval(
    walletClient,
    state,
    'approve_usdg_router_fees',
    USDG,
    usdgBalance,
    '授权路由使用钱包 USDG',
  )

  const [freshSpy, freshUsdg, pairBefore, spyPoolState, directPoolState] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(SPY_PAIR_POOL_ID, POOL_FEE),
    getPoolState(USDG_PAIR_POOL_ID, POOL_FEE),
  ])
  spyBalance = freshSpy
  usdgBalance = freshUsdg
  const [spyQuote, usdgRoute] = await Promise.all([
    spyBalance > 0n ? quoteV4(spyPairPoolKey, spyBalance, true, 'SPY_TO_PAIR') : null,
    bestUsdgToPairQuote(usdgBalance),
  ])
  if (spyQuote && swapRetention(spyBalance, spyQuote.amountOut, 'SPY', spyPoolState, directPoolState) < 0.96)
    throw new Error('SPY→PAIR 实时报价偏离现货超过门槛')
  if (
    usdgRoute &&
    swapRetention(usdgBalance, usdgRoute.selected.amountOut, 'USDG', spyPoolState, directPoolState) < 0.96
  )
    throw new Error('USDG→PAIR 实时报价偏离现货超过门槛')
  const legs = []
  if (spyQuote)
    legs.push({
      symbol: 'SPY',
      poolKey: spyPairPoolKey,
      amountIn: spyBalance,
      amountOutMinimum: bpsFloor(spyQuote.amountOut, SWAP_SLIPPAGE_BPS),
      zeroForOne: true,
      quotedOut: spyQuote.amountOut,
    })
  if (usdgRoute)
    legs.push({
      symbol: 'USDG',
      poolKey: usdgRoute.selected.poolKey,
      amountIn: usdgBalance,
      amountOutMinimum: bpsFloor(usdgRoute.selected.amountOut, SWAP_SLIPPAGE_BPS),
      zeroForOne: true,
      quotedOut: usdgRoute.selected.amountOut,
      route: usdgRoute.selected.feeLabel,
    })
  const minimumPairOut = legs.reduce((sum, leg) => sum + leg.amountOutMinimum, 0n)
  const data = buildCombinedV4SwapData(legs, BigInt(nowSeconds() + 5 * 60))
  const step = await runStep(walletClient, state, 'swap_spy_usdg_to_pair', {
    label: `原子兑换全部 SPY 与 USDG 为 PAIR（USDG ${usdgRoute?.selected.feeLabel || '无'} 路线）`,
    to: UNIVERSAL_ROUTER,
    data,
    metadata: {
      spyInputWei: spyBalance.toString(),
      usdgInputAtomic: usdgBalance.toString(),
      pairBeforeWei: pairBefore.toString(),
      minimumPairOutWei: minimumPairOut.toString(),
      quotedPairOutWei: legs.reduce((sum, leg) => sum + leg.quotedOut, 0n).toString(),
      usdgRoute: usdgRoute?.selected.id || null,
    },
  })
  const [spyAfter, pairAfter, usdgAfter] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  const pairOut = pairAfter - pairBefore
  if (spyAfter !== 0n || usdgAfter !== 0n || pairOut < minimumPairOut)
    throw new Error('SPY/USDG→PAIR 成交回读不符合保护条件')
  step.actualPairOutWei = pairOut.toString()
  writeState(state)
}

async function finalizeFeesToPair(state) {
  await assertFeesToPairInvariants(state)
  const [eth, spy, pair, usdg, nonceLatest, noncePending] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`完成核验仍有 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (spy !== 0n || usdg !== 0n) throw new Error(`完成核验仍有残余：SPY=${spy}, USDG=${usdg}`)
  if (eth < MIN_FINAL_ETH) throw new Error(`完成后 ETH 低于保留线：${formatEther(eth)}`)
  const collect = state.steps.collect_all_fees
  const swap = state.steps.swap_spy_usdg_to_pair
  state.status = 'complete'
  state.completedAt = new Date().toISOString()
  state.result = {
    collected: collect.received,
    swapped: {
      spyWei: swap.spyInputWei || '0',
      usdgAtomic: swap.usdgInputAtomic || '0',
      quotedPairOutWei: swap.quotedPairOutWei || '0',
      actualPairOutWei: swap.actualPairOutWei || '0',
      usdgRoute: swap.usdgRoute || null,
    },
    gasSpentWei: stepGasTotal(state).toString(),
    finalBalances: {
      ethWei: eth.toString(),
      spyWei: spy.toString(),
      pairWei: pair.toString(),
      usdgAtomic: usdg.toString(),
    },
    nonceLatest,
    sourceLiquidityUnchanged: true,
  }
  writeState(state)
  appendAudit(
    'fees_to_pair_complete',
    {
      operationId: state.operationId,
      result: state.result,
      transactions: Object.values(state.steps)
        .filter((step) => step.hash)
        .map((step) => step.hash),
    },
    state,
  )
  console.log(
    stringify({
      status: 'COMPLETE',
      operationId: state.operationId,
      collected: {
        spy: formatUnits(BigInt(collect.received.spyWei), 18),
        pair: formatUnits(BigInt(collect.received.pairWei), 18),
        usdg: formatUnits(BigInt(collect.received.usdgAtomic), 6),
      },
      swapped: {
        spy: formatUnits(BigInt(swap.spyInputWei || 0), 18),
        usdg: formatUnits(BigInt(swap.usdgInputAtomic || 0), 6),
        pairReceived: formatUnits(BigInt(swap.actualPairOutWei || 0), 18),
        usdgRoute: swap.usdgRoute || null,
      },
      final: { eth: formatEther(eth), spy: '0', usdg: '0', pair: formatUnits(pair, 18) },
      gasSpentEth: formatEther(BigInt(state.result.gasSpentWei)),
      transactions: Object.values(state.steps)
        .filter((step) => step.hash)
        .map((step) => ({ label: step.label, hash: step.hash, explorer: `${EXPLORER_TX}${step.hash}` })),
    }),
  )
}

async function executeFeesToPair(state) {
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  try {
    await assertFeesToPairInvariants(state)
    await collectFeesForPair(walletClient, state)
    await swapWalletToPair(walletClient, state)
    await finalizeFeesToPair(state)
  } catch (error) {
    const latest = readJson(FEES_TO_PAIR_STATE_PATH) || state
    if (latest.status !== 'complete') {
      latest.status = 'partial'
      latest.lastErrorAt = new Date().toISOString()
      latest.lastError = error.shortMessage || error.message
      writeState(latest)
      appendAudit(
        'fees_to_pair_partial',
        { operationId: latest.operationId, message: latest.lastError, steps: latest.steps },
        latest,
      )
    }
    throw error
  }
}

async function feesToPairEnter() {
  const existing = readJson(FEES_TO_PAIR_STATE_PATH)
  if (existing && existing.status !== 'complete') return executeFeesToPair(existing)
  archiveFeesToPairState(existing)
  const check = await feesToPairPreflight({ print: true, requireReady: true })
  const state = {
    schemaVersion: 1,
    operationType: 'fees_to_pair',
    name: '领取全部 LP 手续费并将钱包 SPY/USDG 换成 PAIR',
    status: 'planned',
    operationId: `fees-to-pair-${new Date().toISOString().replace(/[-:.]/g, '')}`,
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    wallet: WALLET,
    chainId: CHAIN_ID,
    policy: check.report.policy,
    gasPolicy: check.gasPolicy,
    baseline: {
      ethWei: check.balances.ethBalance.toString(),
      spyWei: check.balances.spyBalance.toString(),
      pairWei: check.balances.pairBalance.toString(),
      usdgAtomic: check.balances.usdgBalance.toString(),
    },
    pairPositions: check.pairReads.map((item) => ({
      tokenId: item.tokenId.toString(),
      tickLower: item.record.tickLower,
      tickUpper: item.record.tickUpper,
      liquidity: item.liquidity.toString(),
      estimatedFeeSpyWei: item.fees.amount0.toString(),
      estimatedFeePairWei: item.fees.amount1.toString(),
    })),
    directPosition: {
      tokenId: check.directRead.tokenId.toString(),
      tickLower: check.directRead.record.tickLower,
      tickUpper: check.directRead.record.tickUpper,
      liquidity: check.directRead.liquidity.toString(),
      estimatedFeeUsdgAtomic: check.directRead.fees.amount0.toString(),
      estimatedFeePairWei: check.directRead.fees.amount1.toString(),
    },
    steps: {},
  }
  writeState(state)
  appendAudit('fees_to_pair_plan_created', state, state)
  return executeFeesToPair(state)
}

async function feesToPairResume() {
  const state = readJson(FEES_TO_PAIR_STATE_PATH)
  if (!state) throw new Error('没有可恢复的手续费换 PAIR 操作')
  if (state.status === 'complete') {
    archiveFeesToPairState(state)
    console.log(stringify({ status: 'ALREADY_COMPLETE', operationId: state.operationId, result: state.result }))
    return
  }
  return executeFeesToPair(state)
}

async function feesToPairStatus() {
  const state = readJson(FEES_TO_PAIR_STATE_PATH)
  const [eth, spy, pair, usdg, nonceLatest, noncePending] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  console.log(
    stringify({
      status: state?.status || 'NOT_STARTED',
      operationId: state?.operationId || null,
      lastError: state?.lastError || null,
      balances: {
        eth: formatEther(eth),
        spy: formatUnits(spy, 18),
        pair: formatUnits(pair, 18),
        usdg: formatUnits(usdg, 6),
      },
      nonceLatest,
      noncePending,
      steps: state?.steps || null,
      result: state?.result || null,
    }),
  )
}

async function main() {
  const command = process.argv[2] || 'preflight'
  if (command === 'preflight') return preflight()
  if (command === 'enter') return enter()
  if (command === 'resume') return resume()
  if (command === 'status') return status()
  if (command === 'fees-to-pair-preflight') return feesToPairPreflight()
  if (command === 'fees-to-pair-enter') return feesToPairEnter()
  if (command === 'fees-to-pair-resume') return feesToPairResume()
  if (command === 'fees-to-pair-status') return feesToPairStatus()
  if (command === 'fees-collect-preflight') return feesCollectPreflight()
  if (command === 'fees-collect-enter') return feesCollectEnter()
  if (command === 'fees-collect-resume') return feesCollectResume()
  if (command === 'fees-collect-status') return feesCollectStatus()
  throw new Error(`未知命令：${command}`)
}

main().catch((error) => {
  const command = process.argv[2] || 'preflight'
  const state = command.startsWith('fees-to-pair')
    ? readJson(FEES_TO_PAIR_STATE_PATH) || { operationType: 'fees_to_pair' }
    : command.startsWith('fees-collect')
      ? readJson(FEES_COLLECT_STATE_PATH) || { operationType: 'fees_collect' }
      : null
  appendAudit('command_failed', { command, message: error.shortMessage || error.message }, state)
  console.error(`ERROR: ${error.shortMessage || error.message}`)
  process.exitCode = 1
})
