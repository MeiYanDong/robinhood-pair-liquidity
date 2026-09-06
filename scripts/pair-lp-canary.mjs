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
const V4_STATE_VIEW = getAddress('0xF3334192D15450CdD385c8B70e03f9A6bD9E673b')
const UNIVERSAL_ROUTER = getAddress('0x8876789976dEcBfCbBbe364623C63652db8C0904')
const POSITION_MANAGER = getAddress('0x58daec3116aae6D93017bAAea7749052E8a04fA7')
const HOOK = getAddress('0x16D1560630Ce74af4478d9b8AD46548A092A2000')
const POOL_ID = '0xf224a070c8626c890a085b258cf562ee4bf052b6d1d59104b3b44d722640c001'

const PRINCIPAL_PER_SIDE = parseEther('0.025')
const TOTAL_PRINCIPAL = PRINCIPAL_PER_SIDE * 2n
const MIN_GAS_RESERVE = parseEther('0.005')
const EXIT_GAS_RESERVE = parseEther('0.0015')
const MAX_LIFECYCLE_GAS_RESERVE = parseEther('0.005')
const RUN_SECONDS = 24 * 60 * 60
const SWAP_SLIPPAGE_BPS = 100n
const MINT_SLIPPAGE = new Percent(100, 10_000)
const EXIT_SLIPPAGE = new Percent(200, 10_000)
// Leave enough token balance for the 1% mint price-slippage envelope. 97% is
// the smallest conservative buffer that keeps both max token amounts funded
// for the configured asymmetric -30%/+30% range.
const TOKEN_USE_BPS = 9_700n
const FEE_TIERS = [10_000, 3_000, 500, 100]
const UINT160_MAX = (1n << 160n) - 1n
const Q128 = 1n << 128n
const Q192 = 1n << 192n
const UINT256_MODULUS = 1n << 256n
const ADD_TARGET_USDG_PER_SIDE = 50_000_000n
const ADD_SPY_MARK_INPUT = parseEther('0.05')
const ADD_MIN_RANGE_BPS = 3_000n
const ADD_MAX_RANGE_BPS = 7_000n
const ADD_MIN_PAIR_RESERVE_USDG = 40_000_000n
const SATELLITE_TICK_LOWER = 116_200
const SATELLITE_TICK_UPPER = 121_200
const SATELLITE_MINT_SLIPPAGE = new Percent(50, 10_000)
const SATELLITE_MINT_SAFETY_BPS = 5n
const SATELLITE_SWAP_SOLVER_ITERATIONS = 16
const SATELLITE_MAX_RESIDUAL_BPS = 200n
// The live PAIR rally moved through the original main-position boundary during
// preflight. Keep the confirmed 7,000-tick width, but shift the new band upward
// in PAIR-price terms so the PAIR-heavy wallet can be deployed while retaining
// the 0.02 ETH operating reserve.
const UPPER_TICK_LOWER = 112_000
const UPPER_TICK_UPPER = 119_000
const UPPER_MIN_ETH_RESERVE = parseEther('0.02')
const UPPER_SPY_BUFFER_BPS = 200n
const UPPER_MIN_PAIR_USE_BPS = 9_900n
const UPPER_RESUME_TOP_UP_ETH = parseEther('0.005')
const UPPER_MINT_SLIPPAGE = new Percent(20, 10_000)
const UPPER_MINT_SAFETY_BPS = 1n
const FEE_BAND_PAIR_PRICE_LOW_USDG = 0.0064
const FEE_BAND_PAIR_PRICE_HIGH_USDG = 0.0075
const FEE_BAND_MIN_ETH_RESERVE = parseEther('0.02')
const FEE_BAND_SWAP_SOLVER_ITERATIONS = 16
const FEE_BAND_MAX_RESIDUAL_BPS = 250n
// The attack-roll implementation is also used for explicitly authorized,
// one-off fixed-range migrations.  Runtime overrides keep the signed plan
// auditable without changing the historical default command.
const ATTACK_SOURCE_TOKEN_ID = process.env.PAIR_ROLL_SOURCE_TOKEN_ID || '1726507'
const ATTACK_FIXED_TICK_LOWER =
  process.env.PAIR_ROLL_TICK_LOWER === undefined ? null : Number(process.env.PAIR_ROLL_TICK_LOWER)
const ATTACK_FIXED_TICK_UPPER =
  process.env.PAIR_ROLL_TICK_UPPER === undefined ? null : Number(process.env.PAIR_ROLL_TICK_UPPER)
const ATTACK_COMPOUND_TARGET_TOKEN_ID = '1732600'
const ATTACK_RANGE_WIDTH_TICKS = 1_200
const ATTACK_MIN_RANGE_POSITION_BPS = 1_500n
const ATTACK_MAX_RANGE_POSITION_BPS = BigInt(process.env.PAIR_ROLL_MAX_RANGE_POSITION_BPS || '8500')
const ATTACK_MIN_ETH_RESERVE = parseEther(process.env.PAIR_ROLL_MIN_ETH_RESERVE || '0.02')
const ATTACK_MAX_RESIDUAL_BPS = 250n
const ATTACK_MINT_SLIPPAGE = new Percent(300, 10_000)
const ATTACK_RESIDUAL_MINT_SLIPPAGE = new Percent(50, 10_000)
const MAIN_ROLL_EXPECTED_SOURCE_TOKEN_ID = '1643016'
const MAIN_ROLL_TICK_LOWER = 112_400
const MAIN_ROLL_TICK_UPPER = 117_000
const MAIN_ROLL_MIN_RANGE_POSITION_BPS = 1_500n
const MAIN_ROLL_MAX_RANGE_POSITION_BPS = 8_500n
const MAIN_ROLL_MIN_ETH_RESERVE = parseEther('0.02')
const MAIN_ROLL_MAX_SPOT_PAIR_USDG = 0.0079
const MAIN_ROLL_MAX_AVERAGE_PAIR_USDG = 0.008
const MAIN_ROLL_MAX_AVERAGE_PAIR_MICRO_USDG = 8_000n
const MAIN_ROLL_MINT_SLIPPAGE = new Percent(100, 10_000)
// One-shot current-price canary funded only by the user's newly supplied ETH.
// The existing wallet SPY/PAIR balances are hard baselines and cannot be spent.
const CURRENT_BAND_TOTAL_ETH = parseEther(process.env.PAIR_CURRENT_BAND_TOTAL_ETH || '0.008')
const CURRENT_BAND_PER_SIDE_ETH = CURRENT_BAND_TOTAL_ETH / 2n
const CURRENT_BAND_TICK_LOWER =
  process.env.PAIR_CURRENT_BAND_TICK_LOWER === undefined ? null : Number(process.env.PAIR_CURRENT_BAND_TICK_LOWER)
const CURRENT_BAND_TICK_UPPER =
  process.env.PAIR_CURRENT_BAND_TICK_UPPER === undefined ? null : Number(process.env.PAIR_CURRENT_BAND_TICK_UPPER)
const CURRENT_BAND_WIDTH_TICKS = 3_200
const CURRENT_BAND_MIN_RANGE_POSITION_BPS = 2_000n
const CURRENT_BAND_MAX_RANGE_POSITION_BPS = 8_000n
const CURRENT_BAND_MIN_ETH_RESERVE = parseEther(process.env.PAIR_CURRENT_BAND_MIN_ETH_RESERVE || '0.08')
const CURRENT_BAND_MAX_GAS_USDG_ATOMIC = 5_000_000n
const CURRENT_BAND_ETH_SWAP_SLIPPAGE_BPS = 50n
const CURRENT_BAND_MINT_SLIPPAGE = new Percent(50, 10_000)
const CURRENT_BAND_DASHBOARD = process.env.PAIR_CURRENT_BAND_DASHBOARD || 'http://47.251.187.250'
const CURRENT_BAND_GAS_MODEL = {
  v4Swap: 180_000n,
  erc20Approval: 65_000n,
  permit2Approval: 50_000n,
  mint: 425_000n,
  safetyBps: 11_500n,
  sendGasPriceBps: 11_000n,
}

// Explicit one-off consolidation authorized on 2026-09-05: retire the two
// exhausted low-band NFTs, combine their SPY principal with the freshly
// collected wallet fees, rebalance only SPY -> PAIR, and mint one higher band.
// The fixed ticks correspond to roughly $0.0135-$0.0200 while SPY is near $772.
const HIGH_BAND_SOURCE_TOKEN_IDS = ['1871220', '1871913']
const HIGH_BAND_TICK_LOWER = 105_600
const HIGH_BAND_TICK_UPPER = 109_600
const HIGH_BAND_MIN_RANGE_POSITION_BPS = 1_000n
const HIGH_BAND_MAX_RANGE_POSITION_BPS = 9_000n
const HIGH_BAND_MIN_ETH_RESERVE = parseEther('0.012')
const HIGH_BAND_MAX_GAS_USDG_ATOMIC = 5_000_000n
// The first live attempt was quoted 1.52% above the amount available at
// inclusion and reverted against the shared 1% floor. This one-off volatile
// high-band migration therefore uses a dedicated 2.5% floor; all other flows
// retain the stricter shared setting.
const HIGH_BAND_SWAP_SLIPPAGE_BPS = 250n
// Minting does not trade either token, but a fast-moving in-range price changes
// the token ratio required for the fixed liquidity. A 7.5% ratio envelope
// deliberately scales initial liquidity down so an inclusion-time move does not
// burn another transaction; any unspent token remains in the wallet.
const HIGH_BAND_MINT_SLIPPAGE = new Percent(750, 10_000)
const HIGH_BAND_MINT_SAFETY_BPS = 25n
const HIGH_BAND_SEND_GAS_PRICE_BPS = 11_000n
const HIGH_BAND_GAS_MODEL = {
  v4Swap: 180_000n,
  erc20Approval: 65_000n,
  permit2Approval: 50_000n,
  mint: 425_000n,
  safetyBps: 11_500n,
}

// One-shot, single-sided PAIR continuation range authorized on 2026-09-06.
// It starts exactly where the current high-band NFT ends, so a rising PAIR
// price can hand fee coverage from [105600,109600) to [103400,105600)
// without touching any existing position or wallet SPY.
const UPPER_EXTENSION_TICK_LOWER = Number(process.env.PAIR_UPPER_EXTENSION_TICK_LOWER || '103400')
const UPPER_EXTENSION_TICK_UPPER = Number(process.env.PAIR_UPPER_EXTENSION_TICK_UPPER || '105600')
const UPPER_EXTENSION_ANCHOR_TOKEN_ID = String(process.env.PAIR_UPPER_EXTENSION_ANCHOR_TOKEN_ID || '1908663')
const UPPER_EXTENSION_MIN_ETH_RESERVE = parseEther(process.env.PAIR_UPPER_EXTENSION_MIN_ETH_RESERVE || '0.012')
const UPPER_EXTENSION_MAX_GAS_USDG_ATOMIC = 5_000_000n
const UPPER_EXTENSION_MINT_SLIPPAGE = new Percent(100, 10_000)
const UPPER_EXTENSION_MIN_PAIR_USE_BPS = 9_999n
const UPPER_EXTENSION_SEND_GAS_PRICE_BPS = 11_000n
const UPPER_EXTENSION_BUY_USDG_ATOMIC = parseUnits(process.env.PAIR_UPPER_EXTENSION_BUY_USDG || '0', 6)
const UPPER_EXTENSION_BUY_SLIPPAGE_BPS = 250n
const UPPER_EXTENSION_MIN_QUOTE_RETENTION_BPS = 9_600n
// Optional follow-up mode for an explicitly selected overlapping range that
// already contains the market price. The freshly bought PAIR remains the
// limiting principal; wallet SPY is used only in the ratio required to mint it.
const UPPER_EXTENSION_PAIRED_IN_RANGE = process.env.PAIR_UPPER_EXTENSION_PAIRED_IN_RANGE === '1'
const UPPER_EXTENSION_PAIRED_MIN_RANGE_POSITION_BPS = 1_000n
const UPPER_EXTENSION_PAIRED_MAX_RANGE_POSITION_BPS = 9_800n
const UPPER_EXTENSION_PAIRED_MIN_PAIR_USE_BPS = 9_500n
const UPPER_EXTENSION_PAIRED_MINT_SAFETY_BPS = 5n
const UPPER_EXTENSION_GAS_MODEL = {
  v4Swap: 180_000n,
  erc20Approval: 65_000n,
  permit2Approval: 50_000n,
  mint: 425_000n,
  safetyBps: 12_500n,
}

// One-shot manual retirement of the legacy main NFT.  This must not reuse the
// global `exit` command because other PAIR/SPY NFTs remain active and need the
// shared ledger to stay operational after this position is emptied.
const TARGET_RETIRE_TOKEN_ID = String(process.env.PAIR_RETIRE_TOKEN_ID || '1773157')
const TARGET_RETIRE_MIN_ETH_RESERVE = parseEther(process.env.PAIR_RETIRE_MIN_ETH_RESERVE || '0.005')
const TARGET_RETIRE_MAX_GAS_USDG_ATOMIC = parseUnits(process.env.PAIR_RETIRE_MAX_GAS_USDG || '5', 6)
const TARGET_RETIRE_SEND_GAS_PRICE_BPS = 11_000n

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const RUN_DIR = path.join(ROOT, 'runs')
const STATE_PATH = path.join(RUN_DIR, 'pair-lp-live-one.json')
const AUDIT_PATH = path.join(RUN_DIR, 'pair-lp-live-one.jsonl')
const PORTFOLIO_LEDGER_PATH = path.join(ROOT, 'dashboard', 'config', 'lp-portfolio-ledger.json')

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Robinhood Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
})

const publicClient = createPublicClient({
  chain,
  transport: http(undefined, { timeout: 30_000, retryCount: 3 }),
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

const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])

const poolKey = {
  currency0: SPY,
  currency1: PAIR,
  fee: 10_000,
  tickSpacing: 200,
  hooks: HOOK,
}

function nowSeconds() {
  return Math.floor(Date.now() / 1_000)
}

function bpsFloor(value, bps) {
  return (value * (10_000n - bps)) / 10_000n
}

function minBigInt(...values) {
  if (!values.length) throw new Error('minBigInt 至少需要一个值')
  return values.reduce((minimum, value) => (value < minimum ? value : minimum))
}

function absoluteBigInt(value) {
  return value < 0n ? -value : value
}

function asBigInt(value) {
  return BigInt(value.toString())
}

function stringify(value) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), 2)
}

function appendAudit(event, details = {}) {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...details }, (_, item) =>
    typeof item === 'bigint' ? item.toString() : item,
  )
  fs.appendFileSync(AUDIT_PATH, `${line}\n`, { mode: 0o600 })
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) return null
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
}

function readAuditEvents() {
  if (!fs.existsSync(AUDIT_PATH)) return []
  return fs
    .readFileSync(AUDIT_PATH, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function writeState(state) {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
  const temporary = `${STATE_PATH}.tmp`
  fs.writeFileSync(temporary, `${stringify(state)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, STATE_PATH)
  fs.chmodSync(STATE_PATH, 0o600)
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
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('Keychain 项目不是有效的 32-byte EVM 私钥')
  }
  const account = privateKeyToAccount(privateKey)
  privateKey = undefined
  if (account.address.toLowerCase() !== WALLET.toLowerCase()) {
    throw new Error(`Keychain 私钥地址不匹配；预期 ${WALLET}，实际 ${account.address}`)
  }
  return account
}

async function assertContracts() {
  const expected = [
    WETH,
    USDG,
    SPY,
    PAIR,
    PERMIT2,
    V3_QUOTER,
    V3_ROUTER,
    V4_QUOTER,
    V4_STATE_VIEW,
    UNIVERSAL_ROUTER,
    POSITION_MANAGER,
    HOOK,
  ]
  const codes = await Promise.all(expected.map((address) => publicClient.getCode({ address })))
  const missing = expected.filter((_, index) => !codes[index] || codes[index] === '0x')
  if (missing.length) throw new Error(`目标合约无 bytecode: ${missing.join(', ')}`)
  const [spySymbol, spyDecimals, pairSymbol, pairDecimals] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'symbol' }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'decimals' }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'symbol' }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'decimals' }),
  ])
  if (spySymbol !== 'SPY' || spyDecimals !== 18 || pairSymbol !== 'PAIR' || pairDecimals !== 18) {
    throw new Error(`代币元数据不匹配: SPY=${spySymbol}/${spyDecimals}, PAIR=${pairSymbol}/${pairDecimals}`)
  }
}

async function getPoolState() {
  const [[sqrtPriceX96, tick, protocolFee, lpFee], liquidity] = await Promise.all([
    publicClient.readContract({
      address: V4_STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [POOL_ID],
    }),
    publicClient.readContract({
      address: V4_STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [POOL_ID],
    }),
  ])
  if (sqrtPriceX96 === 0n || liquidity === 0n || lpFee !== 10_000) {
    throw new Error(`官方池状态异常: sqrt=${sqrtPriceX96}, liquidity=${liquidity}, lpFee=${lpFee}`)
  }
  return { sqrtPriceX96, tick, protocolFee, lpFee, liquidity }
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

async function quoteBestV3(candidates, amountIn, label) {
  const results = []
  for (const candidate of candidates) {
    try {
      const { result } = await publicClient.simulateContract({
        address: V3_QUOTER,
        abi: V3_QUOTER_ABI,
        functionName: 'quoteExactInput',
        args: [candidate.path, amountIn],
        account: WALLET,
      })
      if (result[0] > 0n) results.push({ ...candidate, amountOut: result[0], quoterGas: result[3] })
    } catch {
      // A missing pool is an expected route rejection.
    }
  }
  results.sort((left, right) => (left.amountOut > right.amountOut ? -1 : left.amountOut < right.amountOut ? 1 : 0))
  if (!results.length) throw new Error(`没有可执行的 ${label} V3 路径`)
  return results[0]
}

async function quoteBestEthToSpy(amountIn) {
  const candidates = []
  for (const fee of FEE_TIERS) candidates.push({ fees: [fee], path: v3Path([WETH, SPY], [fee]) })
  for (const first of FEE_TIERS) {
    for (const second of FEE_TIERS)
      candidates.push({ fees: [first, second], path: v3Path([WETH, USDG, SPY], [first, second]) })
  }
  return quoteBestV3(candidates, amountIn, 'ETH→SPY')
}

async function quoteBestSpyToUsdg(amountIn) {
  const candidates = []
  for (const fee of FEE_TIERS) candidates.push({ fees: [fee], path: v3Path([SPY, USDG], [fee]) })
  for (const first of FEE_TIERS) {
    for (const second of FEE_TIERS)
      candidates.push({ fees: [first, second], path: v3Path([SPY, WETH, USDG], [first, second]) })
  }
  return quoteBestV3(candidates, amountIn, 'SPY→USDG')
}

async function quoteSpyInputForTargetUsdg(targetUsdgAtomic, spyMark = null) {
  if (targetUsdgAtomic <= 0n) throw new Error('SPY 买入目标 USDG 必须大于 0')
  const reference = spyMark || (await quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT))
  if (reference.amountOut <= 0n) throw new Error('SPY/USDG 标记报价为 0')
  let amountIn = (targetUsdgAtomic * ADD_SPY_MARK_INPUT + reference.amountOut - 1n) / reference.amountOut
  let valuation = await quoteBestSpyToUsdg(amountIn)
  if (valuation.amountOut <= 0n) throw new Error('目标 SPY 的 USDG 报价为 0')
  amountIn = (amountIn * targetUsdgAtomic + valuation.amountOut - 1n) / valuation.amountOut
  valuation = await quoteBestSpyToUsdg(amountIn)
  return { amountIn, valuation, reference }
}

async function quoteEthForTargetSpyUsdg(targetUsdg) {
  const spyMark = await quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT)
  let ethInput = parseEther('0.02')
  let route = await quoteBestEthToSpy(ethInput)
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const outputUsdg = (route.amountOut * spyMark.amountOut) / ADD_SPY_MARK_INPUT
    if (outputUsdg === 0n) throw new Error('ETH→SPY 的 USDG 估值为 0')
    ethInput = (ethInput * targetUsdg) / outputUsdg
    route = await quoteBestEthToSpy(ethInput)
  }
  return { ethInput, route, spyMark }
}

async function quotePairPoolSwap(amountIn, zeroForOne) {
  const { result } = await publicClient.simulateContract({
    address: V4_QUOTER,
    abi: V4_QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' }],
    account: WALLET,
  })
  const amountOut = Array.isArray(result) ? result[0] : result.amountOut
  const gasEstimate = Array.isArray(result) ? result[1] : result.gasEstimate
  if (amountOut <= 0n) throw new Error(`${zeroForOne ? 'SPY→PAIR' : 'PAIR→SPY'} 官方池报价为 0`)
  return { amountOut, gasEstimate }
}

async function quoteSpyToPair(amountIn) {
  return quotePairPoolSwap(amountIn, true)
}

async function quotePairToSpy(amountIn) {
  return quotePairPoolSwap(amountIn, false)
}

function buildV3SwapData(pathBytes, amountIn, amountOutMinimum) {
  return encodeFunctionData({
    abi: V3_ROUTER_ABI,
    functionName: 'exactInput',
    args: [{ path: pathBytes, recipient: WALLET, amountIn, amountOutMinimum }],
  })
}

function buildV4SwapData(amountIn, amountOutMinimum, deadline, zeroForOne = true) {
  const inputCurrency = zeroForOne ? SPY : PAIR
  const outputCurrency = zeroForOne ? PAIR : SPY
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
  const v4Input = encodeAbiParameters(parseAbiParameters('bytes actions,bytes[] params'), [
    '0x060b0e',
    [swap, settle, take],
  ])
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: ['0x10', [v4Input], deadline],
  })
}

async function transactionBudget(to, data, value = 0n) {
  await publicClient.call({ account: WALLET, to, data, value })
  const [estimatedGas, gasPrice] = await Promise.all([
    publicClient.estimateGas({ account: WALLET, to, data, value }),
    publicClient.getGasPrice(),
  ])
  const gasLimit = (estimatedGas * 120n) / 100n + 10_000n
  const budget = (gasLimit * gasPrice * 125n) / 100n
  return { estimatedGas, gasLimit, gasPrice, budget }
}

async function fastTransactionBudget(to, data, value = 0n) {
  const [estimatedGas, gasPrice] = await Promise.all([
    publicClient.estimateGas({ account: WALLET, to, data, value }),
    publicClient.getGasPrice(),
  ])
  const gasLimit = (estimatedGas * 120n) / 100n + 10_000n
  const budget = (gasLimit * gasPrice * 125n) / 100n
  return { estimatedGas, gasLimit, gasPrice, budget }
}

async function sendChecked(
  walletClient,
  {
    label,
    to,
    data,
    value = 0n,
    minimumBalanceAfter = EXIT_GAS_RESERVE,
    fast = false,
    gasPriceMultiplierBps = 10_000n,
    gasBudgetSafetyBps = 12_500n,
  },
) {
  const budget = fast ? await fastTransactionBudget(to, data, value) : await transactionBudget(to, data, value)
  const sendGasPrice = (budget.gasPrice * gasPriceMultiplierBps + 9_999n) / 10_000n
  const maxGasBudget = (budget.gasLimit * sendGasPrice * gasBudgetSafetyBps) / 10_000n
  const balance = await publicClient.getBalance({ address: WALLET })
  if (balance < value + maxGasBudget + minimumBalanceAfter) {
    throw new Error(
      `${label} 资金保护触发：余额 ${formatEther(balance)} ETH，需为 value+Gas+退出储备保留 ${formatEther(value + maxGasBudget + minimumBalanceAfter)} ETH`,
    )
  }
  const [nonceLatest, noncePending] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  if (nonceLatest !== noncePending) {
    throw new Error(`${label} 广播前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  }
  appendAudit('transaction_prepared', {
    label,
    nonce: noncePending,
    valueWei: value,
    gasEstimate: budget.estimatedGas,
    gasLimit: budget.gasLimit,
    gasPriceWei: budget.gasPrice,
    fast,
    gasPriceMultiplierBps,
    gasBudgetSafetyBps,
    maxGasBudgetWei: maxGasBudget,
  })
  let hash
  try {
    const request = { account: walletClient.account, to, data, value, gas: budget.gasLimit, nonce: noncePending }
    if (gasPriceMultiplierBps !== 10_000n) request.gasPrice = sendGasPrice
    hash = await walletClient.sendTransaction(request)
  } catch (error) {
    appendAudit('broadcast_failed_before_hash', { label, message: error.shortMessage || error.message })
    throw error
  }
  appendAudit('broadcast', { label, hash })
  let receipt
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 })
  } catch (error) {
    appendAudit('receipt_unknown', { label, hash, message: error.shortMessage || error.message })
    throw new Error(`${label} 已广播但回执未知，禁止自动重试。交易：${hash}`)
  }
  if (receipt.status !== 'success') {
    appendAudit('receipt_reverted', { label, hash, blockNumber: receipt.blockNumber })
    throw new Error(`${label} 链上回执失败：${hash}`)
  }
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice
  appendAudit('receipt_success', {
    label,
    hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    gasCostWei: gasCost,
  })
  console.log(`${label}: ${hash} (${EXPLORER_TX}${hash})`)
  return { hash, receipt, gasCost }
}

async function approveErc20(walletClient, token, required, label, minimumBalanceAfter = EXIT_GAS_RESERVE) {
  const allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [WALLET, PERMIT2],
  })
  if (allowance >= required) return null
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, maxUint256] })
  return sendChecked(walletClient, { label, to: token, data, minimumBalanceAfter })
}

async function approvePermit2(walletClient, token, spender, required, label, minimumBalanceAfter = EXIT_GAS_RESERVE) {
  const [amount, expiration] = await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [WALLET, token, spender],
  })
  const desiredExpiration = BigInt(nowSeconds() + 60 * 60)
  if (amount >= required && expiration > BigInt(nowSeconds() + 300)) return null
  const data = encodeFunctionData({
    abi: PERMIT2_ABI,
    functionName: 'approve',
    args: [token, spender, required > UINT160_MAX ? UINT160_MAX : required, desiredExpiration],
  })
  return sendChecked(walletClient, { label, to: PERMIT2, data, minimumBalanceAfter })
}

function rangeForTick(tick) {
  const lowerDelta = Math.log(0.7) / Math.log(1.0001)
  const upperDelta = Math.log(1.3) / Math.log(1.0001)
  return {
    tickLower: Math.floor((tick + lowerDelta) / 200) * 200,
    tickUpper: Math.ceil((tick + upperDelta) / 200) * 200,
  }
}

function makePool(state) {
  const spyToken = new Token(CHAIN_ID, SPY, 18, 'SPY', 'Robinhood SPY Stock Token')
  const pairToken = new Token(CHAIN_ID, PAIR, 18, 'PAIR', 'PAIR')
  const pool = new Pool(
    spyToken,
    pairToken,
    10_000,
    200,
    HOOK,
    state.sqrtPriceX96.toString(),
    state.liquidity.toString(),
    state.tick,
  )
  if (pool.poolId.toLowerCase() !== POOL_ID.toLowerCase()) {
    throw new Error(`SDK PoolId 不匹配: ${pool.poolId}`)
  }
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

async function getAccruedFees(tokenId, tickLower, tickUpper) {
  const id = positionStateId(tokenId, tickLower, tickUpper)
  const [[liquidity, last0, last1], [inside0, inside1]] = await Promise.all([
    publicClient.readContract({
      address: V4_STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getPositionInfo',
      args: [POOL_ID, id],
    }),
    publicClient.readContract({
      address: V4_STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getFeeGrowthInside',
      args: [POOL_ID, tickLower, tickUpper],
    }),
  ])
  return {
    positionId: id,
    liquidity,
    spyWei: (liquidity * wrappingSub(inside0, last0)) / Q128,
    pairWei: (liquidity * wrappingSub(inside1, last1)) / Q128,
  }
}

function satelliteRangePositionBps(tick) {
  return (BigInt(tick - SATELLITE_TICK_LOWER) * 10_000n) / BigInt(SATELLITE_TICK_UPPER - SATELLITE_TICK_LOWER)
}

function customRangePositionBps(tick, tickLower, tickUpper) {
  return (BigInt(tick - tickLower) * 10_000n) / BigInt(tickUpper - tickLower)
}

function tokenAmountsUsdg(spyWei, pairWei, poolState, spyMark) {
  const spyUsdg = (spyWei * spyMark.amountOut) / ADD_SPY_MARK_INPUT
  const pairAsSpyWei = (pairWei * Q192) / (poolState.sqrtPriceX96 * poolState.sqrtPriceX96)
  const pairUsdg = (pairAsSpyWei * spyMark.amountOut) / ADD_SPY_MARK_INPUT
  return { spyUsdg, pairUsdg, totalUsdg: spyUsdg + pairUsdg }
}

function satelliteRangePricesUsdg(spyMark) {
  const spyPrice = Number(spyMark.amountOut) / 1e6 / (Number(ADD_SPY_MARK_INPUT) / 1e18)
  const lowerTickPairPrice = spyPrice / Math.pow(1.0001, SATELLITE_TICK_LOWER)
  const upperTickPairPrice = spyPrice / Math.pow(1.0001, SATELLITE_TICK_UPPER)
  return {
    lower: Math.min(lowerTickPairPrice, upperTickPairPrice).toFixed(8),
    upper: Math.max(lowerTickPairPrice, upperTickPairPrice).toFixed(8),
  }
}

function satelliteUnitAmounts(poolState) {
  const pool = makePool(poolState)
  const unitPosition = new Position({
    pool,
    liquidity: (10n ** 24n).toString(),
    tickLower: SATELLITE_TICK_LOWER,
    tickUpper: SATELLITE_TICK_UPPER,
  })
  const spyWei = asBigInt(unitPosition.amount0.quotient)
  const pairWei = asBigInt(unitPosition.amount1.quotient)
  if (spyWei === 0n || pairWei === 0n) throw new Error('卫星仓当前不是双边头寸，禁止建仓')
  return { spyWei, pairWei }
}

function customRangeUnitAmounts(poolState, tickLower, tickUpper) {
  const pool = makePool(poolState)
  const unitPosition = new Position({
    pool,
    liquidity: (10n ** 24n).toString(),
    tickLower,
    tickUpper,
  })
  const spyWei = asBigInt(unitPosition.amount0.quotient)
  const pairWei = asBigInt(unitPosition.amount1.quotient)
  if (spyWei === 0n || pairWei === 0n) throw new Error('新区间当前不是双边头寸，禁止建仓')
  return { spyWei, pairWei }
}

function activePairPositionRecords(state) {
  const records = []
  if (state.position && !String(state.position.status || 'active').startsWith('retired')) {
    records.push({ role: 'main', ...state.position })
  }
  for (const item of (state.satellites || []).filter((entry) => entry.status === 'active')) {
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

function activePairPositionRecordsFromPortfolioLedger() {
  if (!fs.existsSync(PORTFOLIO_LEDGER_PATH)) {
    throw new Error(`缺少最新组合账本：${PORTFOLIO_LEDGER_PATH}`)
  }
  const ledger = JSON.parse(fs.readFileSync(PORTFOLIO_LEDGER_PATH, 'utf8'))
  const records = (ledger.positions || [])
    .filter((record) => record.poolKind === 'pair-spy' && record.lastKnownStatus === 'active')
    .map((record) => ({
      role: record.role || 'portfolio',
      tokenId: String(record.tokenId),
      tickLower: record.tickLower,
      tickUpper: record.tickUpper,
      liquidity: String(record.lastKnownLiquidity || '0'),
      owner: record.owner,
      chainDataQuality: record.chainDataQuality,
    }))
    .filter((record) => BigInt(record.liquidity) > 0n)
  if (!records.length) throw new Error('最新组合账本没有活动 PAIR/SPY NFT')
  const seen = new Set()
  for (const record of records) {
    if (seen.has(record.tokenId)) throw new Error(`最新组合账本重复记录 NFT ${record.tokenId}`)
    seen.add(record.tokenId)
    if (!Number.isSafeInteger(record.tickLower) || !Number.isSafeInteger(record.tickUpper)) {
      throw new Error(`最新组合账本 NFT ${record.tokenId} 缺少有效 Tick`)
    }
    if (!record.owner || record.owner.toLowerCase() !== WALLET.toLowerCase()) {
      throw new Error(`最新组合账本 NFT ${record.tokenId} owner 异常`)
    }
    if (record.chainDataQuality !== 'verified_same_safe_block') {
      throw new Error(`最新组合账本 NFT ${record.tokenId} 链上质量不足：${record.chainDataQuality || 'unknown'}`)
    }
  }
  return records
}

function attackRangeForTick(tick) {
  if (ATTACK_FIXED_TICK_LOWER !== null || ATTACK_FIXED_TICK_UPPER !== null) {
    if (!Number.isInteger(ATTACK_FIXED_TICK_LOWER) || !Number.isInteger(ATTACK_FIXED_TICK_UPPER)) {
      throw new Error('固定迁移区间必须同时提供整数 tickLower/tickUpper')
    }
    if (ATTACK_FIXED_TICK_LOWER >= ATTACK_FIXED_TICK_UPPER) {
      throw new Error(`固定迁移区间无效：[${ATTACK_FIXED_TICK_LOWER},${ATTACK_FIXED_TICK_UPPER})`)
    }
    if (ATTACK_FIXED_TICK_LOWER % poolKey.tickSpacing !== 0 || ATTACK_FIXED_TICK_UPPER % poolKey.tickSpacing !== 0) {
      throw new Error(`固定迁移区间未按 tickSpacing 对齐：[${ATTACK_FIXED_TICK_LOWER},${ATTACK_FIXED_TICK_UPPER})`)
    }
    return {
      centerTick: null,
      tickLower: ATTACK_FIXED_TICK_LOWER,
      tickUpper: ATTACK_FIXED_TICK_UPPER,
    }
  }
  const centerTick = Math.round(tick / poolKey.tickSpacing) * poolKey.tickSpacing
  const halfWidth = ATTACK_RANGE_WIDTH_TICKS / 2
  const tickLower = centerTick - halfWidth
  const tickUpper = centerTick + halfWidth
  if (tickLower % poolKey.tickSpacing !== 0 || tickUpper % poolKey.tickSpacing !== 0) {
    throw new Error(`进攻仓 tick 未按 tickSpacing 对齐：[${tickLower},${tickUpper})`)
  }
  return { centerTick, tickLower, tickUpper }
}

function attackRecoveryRangeForTick(tick) {
  const centerTick = Math.round(tick / poolKey.tickSpacing) * poolKey.tickSpacing
  const tickLower = centerTick - 1_800
  const tickUpper = centerTick + 800
  if (tickLower % poolKey.tickSpacing !== 0 || tickUpper % poolKey.tickSpacing !== 0) {
    throw new Error(`进攻仓恢复区间未按 tickSpacing 对齐：[${tickLower},${tickUpper})`)
  }
  return { centerTick, tickLower, tickUpper }
}

function customRangePricesUsdg(spyPriceUsdg, tickLower, tickUpper) {
  const priceAtLowerTick = spyPriceUsdg / Math.pow(1.0001, tickLower)
  const priceAtUpperTick = spyPriceUsdg / Math.pow(1.0001, tickUpper)
  return {
    low: Math.min(priceAtLowerTick, priceAtUpperTick),
    high: Math.max(priceAtLowerTick, priceAtUpperTick),
  }
}

function feeBandTicksAndPrices(spyMark) {
  const spyPriceUsdg = Number(formatUnits(spyMark.amountOut, 6)) / Number(formatUnits(ADD_SPY_MARK_INPUT, 18))
  if (!Number.isFinite(spyPriceUsdg) || spyPriceUsdg <= 0) throw new Error(`SPY/USDG 标记价格无效：${spyPriceUsdg}`)
  const tickForHighPairPrice = Math.log(spyPriceUsdg / FEE_BAND_PAIR_PRICE_HIGH_USDG) / Math.log(1.0001)
  const tickForLowPairPrice = Math.log(spyPriceUsdg / FEE_BAND_PAIR_PRICE_LOW_USDG) / Math.log(1.0001)
  const tickLower = Math.floor(tickForHighPairPrice / poolKey.tickSpacing) * poolKey.tickSpacing
  const tickUpper = Math.ceil(tickForLowPairPrice / poolKey.tickSpacing) * poolKey.tickSpacing
  if (tickLower >= tickUpper) throw new Error(`手续费新区间 tick 无效：[${tickLower},${tickUpper})`)
  const priceAtLowerTick = spyPriceUsdg / Math.pow(1.0001, tickLower)
  const priceAtUpperTick = spyPriceUsdg / Math.pow(1.0001, tickUpper)
  const actualPriceLowUsdg = Math.min(priceAtLowerTick, priceAtUpperTick)
  const actualPriceHighUsdg = Math.max(priceAtLowerTick, priceAtUpperTick)
  if (actualPriceLowUsdg > FEE_BAND_PAIR_PRICE_LOW_USDG || actualPriceHighUsdg < FEE_BAND_PAIR_PRICE_HIGH_USDG) {
    throw new Error(`tick 向外取整后未完整覆盖目标美元区间：${actualPriceLowUsdg}-${actualPriceHighUsdg}`)
  }
  return {
    spyPriceUsdg,
    tickLower,
    tickUpper,
    requestedPriceLowUsdg: FEE_BAND_PAIR_PRICE_LOW_USDG,
    requestedPriceHighUsdg: FEE_BAND_PAIR_PRICE_HIGH_USDG,
    actualPriceLowUsdg,
    actualPriceHighUsdg,
  }
}

function buildPositionCollect(positionRecord, liquidity, poolState) {
  const position = new Position({
    pool: makePool(poolState),
    liquidity: liquidity.toString(),
    tickLower: positionRecord.tickLower,
    tickUpper: positionRecord.tickUpper,
  })
  const method = V4PositionManager.collectCallParameters(position, {
    tokenId: String(positionRecord.tokenId),
    recipient: WALLET,
    slippageTolerance: SATELLITE_MINT_SLIPPAGE,
    deadline: BigInt(nowSeconds() + 5 * 60).toString(),
    hookData: '0x',
  })
  return { data: method.calldata }
}

async function solveCustomRangeRebalance(totalSpyWei, totalPairWei, poolState, tickLower, tickUpper) {
  if (totalSpyWei < 0n || totalPairWei < 0n || (totalSpyWei === 0n && totalPairWei === 0n)) {
    throw new Error('手续费配平资产数量无效')
  }
  const unit = customRangeUnitAmounts(poolState, tickLower, tickUpper)
  const imbalanceAtZero = totalPairWei * unit.spyWei - totalSpyWei * unit.pairWei
  const pairAsSpyWei = (unit.pairWei * Q192) / (poolState.sqrtPriceX96 * poolState.sqrtPriceX96)
  const targetSpyValueBps = (unit.spyWei * 10_000n) / (unit.spyWei + pairAsSpyWei)
  if (imbalanceAtZero === 0n) {
    return {
      direction: 'NONE',
      zeroForOne: null,
      amountIn: 0n,
      amountOut: 0n,
      gasEstimate: 0n,
      imbalance: 0n,
      expectedSpyWei: totalSpyWei,
      expectedPairWei: totalPairWei,
      unitSpyWei: unit.spyWei,
      unitPairWei: unit.pairWei,
      targetSpyValueBps,
      targetPairValueBps: 10_000n - targetSpyValueBps,
    }
  }

  const zeroForOne = imbalanceAtZero < 0n
  const direction = zeroForOne ? 'SPY_TO_PAIR' : 'PAIR_TO_SPY'
  const maximumInput = zeroForOne ? totalSpyWei : totalPairWei
  const quote = zeroForOne ? quoteSpyToPair : quotePairToSpy
  const evaluate = async (amountIn) => {
    if (amountIn === 0n) {
      return {
        amountIn,
        amountOut: 0n,
        gasEstimate: 0n,
        imbalance: imbalanceAtZero,
        expectedSpyWei: totalSpyWei,
        expectedPairWei: totalPairWei,
      }
    }
    const result = await quote(amountIn)
    const expectedSpyWei = zeroForOne ? totalSpyWei - amountIn : totalSpyWei + result.amountOut
    const expectedPairWei = zeroForOne ? totalPairWei + result.amountOut : totalPairWei - amountIn
    return {
      amountIn,
      amountOut: result.amountOut,
      gasEstimate: result.gasEstimate,
      imbalance: expectedPairWei * unit.spyWei - expectedSpyWei * unit.pairWei,
      expectedSpyWei,
      expectedPairWei,
    }
  }

  let low = 0n
  let high = maximumInput
  for (let iteration = 0; iteration < FEE_BAND_SWAP_SOLVER_ITERATIONS; iteration += 1) {
    const middle = (low + high) / 2n
    if (middle === low || middle === high) break
    const candidate = await evaluate(middle)
    if (zeroForOne ? candidate.imbalance >= 0n : candidate.imbalance <= 0n) high = middle
    else low = middle
  }
  const [lowCandidate, highCandidate] = await Promise.all([evaluate(low), evaluate(high)])
  const selected =
    absoluteBigInt(lowCandidate.imbalance) <= absoluteBigInt(highCandidate.imbalance) ? lowCandidate : highCandidate
  if (selected.amountIn <= 0n || selected.amountIn >= maximumInput) {
    throw new Error(`${direction} 配平数量无效：${selected.amountIn}`)
  }
  return {
    direction,
    zeroForOne,
    ...selected,
    unitSpyWei: unit.spyWei,
    unitPairWei: unit.pairWei,
    targetSpyValueBps,
    targetPairValueBps: 10_000n - targetSpyValueBps,
  }
}

async function quoteUpperEthToSpy(amountIn) {
  const fees = [100, 500]
  const path = v3Path([WETH, USDG, SPY], fees)
  const { result } = await publicClient.simulateContract({
    address: V3_QUOTER,
    abi: V3_QUOTER_ABI,
    functionName: 'quoteExactInput',
    args: [path, amountIn],
    account: WALLET,
  })
  if (result[0] <= 0n) throw new Error('ETH→USDG→SPY 路径报价为 0')
  return { fees, path, amountOut: result[0], quoterGas: result[3] }
}

async function quoteEthForSpyTarget(targetSpyWei) {
  if (targetSpyWei <= 0n) return { amountIn: 0n, fees: [], path: '0x', amountOut: 0n, quoterGas: 0n }
  let amountIn = parseEther('0.045')
  let quote = await quoteUpperEthToSpy(amountIn)
  for (let iteration = 0; iteration < 3; iteration += 1) {
    if (quote.amountOut === 0n) throw new Error('ETH→SPY 求解报价为 0')
    amountIn = (amountIn * targetSpyWei) / quote.amountOut
    if (amountIn === 0n) throw new Error('ETH→SPY 求解输入为 0')
    quote = await quoteUpperEthToSpy(amountIn)
  }
  return { amountIn, ...quote }
}

async function solveSatelliteSwap(totalSpyWei, totalPairWei, poolState) {
  if (totalSpyWei <= 0n || totalPairWei < 0n) throw new Error('卫星仓配平资产数量无效')
  const unit = satelliteUnitAmounts(poolState)
  const imbalanceAtZero = totalPairWei * unit.spyWei - totalSpyWei * unit.pairWei
  if (imbalanceAtZero >= 0n) {
    throw new Error('当前资产已偏 PAIR，若要全部投入需 PAIR→SPY；本次只获准 SPY→PAIR，已停止')
  }

  let low = 0n
  let high = totalSpyWei
  for (let iteration = 0; iteration < SATELLITE_SWAP_SOLVER_ITERATIONS; iteration += 1) {
    const middle = (low + high) / 2n
    if (middle === 0n) break
    const quote = await quoteSpyToPair(middle)
    const imbalance = (totalPairWei + quote.amountOut) * unit.spyWei - (totalSpyWei - middle) * unit.pairWei
    if (imbalance >= 0n) high = middle
    else low = middle
  }

  const evaluate = async (amountIn) => {
    if (amountIn === 0n) return { amountIn, amountOut: 0n, imbalance: imbalanceAtZero, gasEstimate: 0n }
    const quote = await quoteSpyToPair(amountIn)
    return {
      amountIn,
      amountOut: quote.amountOut,
      gasEstimate: quote.gasEstimate,
      imbalance: (totalPairWei + quote.amountOut) * unit.spyWei - (totalSpyWei - amountIn) * unit.pairWei,
    }
  }
  const [lowCandidate, highCandidate] = await Promise.all([evaluate(low), evaluate(high)])
  const selected =
    absoluteBigInt(lowCandidate.imbalance) <= absoluteBigInt(highCandidate.imbalance) ? lowCandidate : highCandidate
  if (selected.amountIn <= 0n || selected.amountIn >= totalSpyWei) throw new Error('卫星仓求解出的 SPY 换币数量无效')

  const expectedSpyWei = totalSpyWei - selected.amountIn
  const expectedPairWei = totalPairWei + selected.amountOut
  const pairAsSpyWei = (unit.pairWei * Q192) / (poolState.sqrtPriceX96 * poolState.sqrtPriceX96)
  const targetSpyValueBps = (unit.spyWei * 10_000n) / (unit.spyWei + pairAsSpyWei)
  return {
    ...selected,
    expectedSpyWei,
    expectedPairWei,
    unitSpyWei: unit.spyWei,
    unitPairWei: unit.pairWei,
    targetSpyValueBps,
    targetPairValueBps: 10_000n - targetSpyValueBps,
  }
}

function buildSatelliteCollect(state, liquidity, poolState) {
  const pool = makePool(poolState)
  const position = new Position({
    pool,
    liquidity: liquidity.toString(),
    tickLower: state.position.tickLower,
    tickUpper: state.position.tickUpper,
  })
  const method = V4PositionManager.collectCallParameters(position, {
    tokenId: state.position.tokenId,
    recipient: WALLET,
    slippageTolerance: SATELLITE_MINT_SLIPPAGE,
    deadline: BigInt(nowSeconds() + 5 * 60).toString(),
    hookData: '0x',
  })
  return { data: method.calldata }
}

function buildFullRemove(positionRecord, liquidity, poolState) {
  const pool = makePool(poolState)
  const position = new Position({
    pool,
    liquidity: liquidity.toString(),
    tickLower: positionRecord.tickLower,
    tickUpper: positionRecord.tickUpper,
  })
  const method = V4PositionManager.removeCallParameters(position, {
    tokenId: positionRecord.tokenId,
    liquidityPercentage: new Percent(1, 1),
    burnToken: false,
    slippageTolerance: EXIT_SLIPPAGE,
    deadline: BigInt(nowSeconds() + 5 * 60).toString(),
    hookData: '0x',
  })
  return {
    position,
    amount0Principal: asBigInt(position.amount0.quotient),
    amount1Principal: asBigInt(position.amount1.quotient),
    data: method.calldata,
  }
}

async function signPermitBatch(account, amount0Max, amount1Max) {
  if (amount0Max > UINT160_MAX || amount1Max > UINT160_MAX) throw new Error('Permit2 授权金额超过 uint160')
  const [, , nonce0] = await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [WALLET, SPY, POSITION_MANAGER],
  })
  const [, , nonce1] = await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [WALLET, PAIR, POSITION_MANAGER],
  })
  const expiration = BigInt(nowSeconds() + 30 * 60)
  const sigDeadline = BigInt(nowSeconds() + 5 * 60)
  const permitBatch = {
    details: [
      { token: SPY, amount: amount0Max, expiration, nonce: nonce0 },
      { token: PAIR, amount: amount1Max, expiration, nonce: nonce1 },
    ],
    spender: POSITION_MANAGER,
    sigDeadline,
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

async function buildIncrease(account, state, externalSpyWei, externalPairWei) {
  const tokenId = BigInt(state.position.tokenId)
  const poolState = await getPoolState()
  const rangeBps =
    (BigInt(poolState.tick - state.position.tickLower) * 10_000n) /
    BigInt(state.position.tickUpper - state.position.tickLower)
  if (rangeBps < ADD_MIN_RANGE_BPS || rangeBps > ADD_MAX_RANGE_BPS) {
    throw new Error(`旧仓不再接近区间中部：tick=${poolState.tick}, rangeBps=${rangeBps}，禁止追价增加`)
  }
  const fees = await getAccruedFees(tokenId, state.position.tickLower, state.position.tickUpper)
  const pool = makePool(poolState)
  const position = Position.fromAmounts({
    pool,
    tickLower: state.position.tickLower,
    tickUpper: state.position.tickUpper,
    amount0: (externalSpyWei + fees.spyWei).toString(),
    amount1: (externalPairWei + fees.pairWei).toString(),
    useFullPrecision: true,
  })
  const maximums = position.mintAmountsWithSlippage(MINT_SLIPPAGE)
  const amount0Max = asBigInt(maximums.amount0)
  const amount1Max = asBigInt(maximums.amount1)
  const batchPermit = await signPermitBatch(account, amount0Max, amount1Max)
  const deadline = BigInt(nowSeconds() + 5 * 60)
  const method = V4PositionManager.addCallParameters(position, {
    tokenId: tokenId.toString(),
    slippageTolerance: MINT_SLIPPAGE,
    deadline: deadline.toString(),
    hookData: '0x',
    batchPermit,
  })
  return {
    poolState,
    fees,
    position,
    amount0Desired: asBigInt(position.mintAmounts.amount0),
    amount1Desired: asBigInt(position.mintAmounts.amount1),
    amount0Max,
    amount1Max,
    data: method.calldata,
  }
}

async function buildMint(account, spyBalance, pairBalance) {
  const state = await getPoolState()
  const pool = makePool(state)
  const { tickLower, tickUpper } = rangeForTick(state.tick)
  const position = Position.fromAmounts({
    pool,
    tickLower,
    tickUpper,
    amount0: ((spyBalance * TOKEN_USE_BPS) / 10_000n).toString(),
    amount1: ((pairBalance * TOKEN_USE_BPS) / 10_000n).toString(),
    useFullPrecision: true,
  })
  const maximums = position.mintAmountsWithSlippage(MINT_SLIPPAGE)
  const amount0Max = asBigInt(maximums.amount0)
  const amount1Max = asBigInt(maximums.amount1)
  if (amount0Max > spyBalance || amount1Max > pairBalance) {
    throw new Error('LP 滑点缓冲后的最大代币用量超过余额')
  }
  const [, , nonce0] = await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [WALLET, SPY, POSITION_MANAGER],
  })
  const [, , nonce1] = await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [WALLET, PAIR, POSITION_MANAGER],
  })
  const expiration = BigInt(nowSeconds() + 30 * 60)
  const sigDeadline = BigInt(nowSeconds() + 5 * 60)
  const permitBatch = {
    details: [
      { token: SPY, amount: amount0Max, expiration, nonce: nonce0 },
      { token: PAIR, amount: amount1Max, expiration, nonce: nonce1 },
    ],
    spender: POSITION_MANAGER,
    sigDeadline,
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
  const deadline = BigInt(nowSeconds() + 5 * 60)
  const method = V4PositionManager.addCallParameters(position, {
    recipient: WALLET,
    slippageTolerance: MINT_SLIPPAGE,
    deadline: deadline.toString(),
    hookData: '0x',
    batchPermit: { owner: WALLET, permitBatch, signature },
  })
  return {
    state,
    position,
    tickLower,
    tickUpper,
    liquidity: asBigInt(position.liquidity),
    amount0Desired: asBigInt(position.mintAmounts.amount0),
    amount1Desired: asBigInt(position.mintAmounts.amount1),
    amount0Max,
    amount1Max,
    data: method.calldata,
  }
}

async function buildSatelliteMint(account, spyBalance, pairBalance) {
  const poolState = await getPoolState()
  if (poolState.tick < SATELLITE_TICK_LOWER || poolState.tick >= SATELLITE_TICK_UPPER) {
    throw new Error(
      `价格已离开卫星仓区间：tick=${poolState.tick}，区间=[${SATELLITE_TICK_LOWER},${SATELLITE_TICK_UPPER})`,
    )
  }
  const rangePositionBps = satelliteRangePositionBps(poolState.tick)
  if (rangePositionBps < 2_000n || rangePositionBps > 8_000n) {
    throw new Error(`价格已接近卫星仓边界：tick=${poolState.tick}, rangeBps=${rangePositionBps}，禁止此时追价建仓`)
  }
  const pool = makePool(poolState)
  const rawPosition = Position.fromAmounts({
    pool,
    tickLower: SATELLITE_TICK_LOWER,
    tickUpper: SATELLITE_TICK_UPPER,
    amount0: spyBalance.toString(),
    amount1: pairBalance.toString(),
    useFullPrecision: true,
  })
  const rawLiquidity = asBigInt(rawPosition.liquidity)
  if (rawLiquidity === 0n) throw new Error('卫星仓可铸造流动性为 0')
  const rawMaximums = rawPosition.mintAmountsWithSlippage(SATELLITE_MINT_SLIPPAGE)
  const rawAmount0Max = asBigInt(rawMaximums.amount0)
  const rawAmount1Max = asBigInt(rawMaximums.amount1)
  if (rawAmount0Max === 0n || rawAmount1Max === 0n) throw new Error('卫星仓滑点上限不是双边金额')

  const scaleBase = 10n ** 18n
  let scale = minBigInt(scaleBase, (spyBalance * scaleBase) / rawAmount0Max, (pairBalance * scaleBase) / rawAmount1Max)
  scale = (scale * (10_000n - SATELLITE_MINT_SAFETY_BPS)) / 10_000n
  let liquidity = (rawLiquidity * scale) / scaleBase
  if (liquidity === 0n) throw new Error('卫星仓安全缩放后的流动性为 0')

  let position
  let amount0Max
  let amount1Max
  for (let attempt = 0; attempt < 5; attempt += 1) {
    position = new Position({
      pool,
      liquidity: liquidity.toString(),
      tickLower: SATELLITE_TICK_LOWER,
      tickUpper: SATELLITE_TICK_UPPER,
    })
    const maximums = position.mintAmountsWithSlippage(SATELLITE_MINT_SLIPPAGE)
    amount0Max = asBigInt(maximums.amount0)
    amount1Max = asBigInt(maximums.amount1)
    if (amount0Max <= spyBalance && amount1Max <= pairBalance) break
    liquidity = (liquidity * 9_999n) / 10_000n
  }
  if (!position || amount0Max > spyBalance || amount1Max > pairBalance) {
    throw new Error('卫星仓滑点缓冲后的最大代币用量超过余额')
  }

  const batchPermit = await signPermitBatch(account, amount0Max, amount1Max)
  const method = V4PositionManager.addCallParameters(position, {
    recipient: WALLET,
    slippageTolerance: SATELLITE_MINT_SLIPPAGE,
    deadline: BigInt(nowSeconds() + 5 * 60).toString(),
    hookData: '0x',
    batchPermit,
  })
  return {
    poolState,
    position,
    tickLower: SATELLITE_TICK_LOWER,
    tickUpper: SATELLITE_TICK_UPPER,
    liquidity,
    amount0Desired: asBigInt(position.mintAmounts.amount0),
    amount1Desired: asBigInt(position.mintAmounts.amount1),
    amount0Max,
    amount1Max,
    data: method.calldata,
  }
}

async function buildCustomRangeMint(
  account,
  spyBalance,
  pairBalance,
  tickLower,
  tickUpper,
  {
    minimumRangePositionBps = 2_000n,
    maximumRangePositionBps = 8_000n,
    slippageTolerance = UPPER_MINT_SLIPPAGE,
    safetyBps = UPPER_MINT_SAFETY_BPS,
  } = {},
) {
  const poolState = await getPoolState()
  if (poolState.tick < tickLower || poolState.tick >= tickUpper) {
    throw new Error(`价格已离开新区间：tick=${poolState.tick}，区间=[${tickLower},${tickUpper})`)
  }
  const rangePositionBps = customRangePositionBps(poolState.tick, tickLower, tickUpper)
  if (rangePositionBps < minimumRangePositionBps || rangePositionBps > maximumRangePositionBps) {
    throw new Error(`价格已接近新区间边界：tick=${poolState.tick}, rangeBps=${rangePositionBps}，禁止追价建仓`)
  }
  const pool = makePool(poolState)
  const rawPosition = Position.fromAmounts({
    pool,
    tickLower,
    tickUpper,
    amount0: spyBalance.toString(),
    amount1: pairBalance.toString(),
    useFullPrecision: true,
  })
  const rawLiquidity = asBigInt(rawPosition.liquidity)
  if (rawLiquidity === 0n) throw new Error('新区间可铸造流动性为 0')
  const rawMaximums = rawPosition.mintAmountsWithSlippage(slippageTolerance)
  const rawAmount0Max = asBigInt(rawMaximums.amount0)
  const rawAmount1Max = asBigInt(rawMaximums.amount1)
  if (rawAmount0Max === 0n || rawAmount1Max === 0n) throw new Error('新区间滑点上限不是双边金额')

  const scaleBase = 10n ** 18n
  let scale = minBigInt(scaleBase, (spyBalance * scaleBase) / rawAmount0Max, (pairBalance * scaleBase) / rawAmount1Max)
  scale = (scale * (10_000n - safetyBps)) / 10_000n
  let liquidity = (rawLiquidity * scale) / scaleBase
  if (liquidity === 0n) throw new Error('新区间安全缩放后的流动性为 0')

  let position
  let amount0Max
  let amount1Max
  for (let attempt = 0; attempt < 5; attempt += 1) {
    position = new Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper })
    const maximums = position.mintAmountsWithSlippage(slippageTolerance)
    amount0Max = asBigInt(maximums.amount0)
    amount1Max = asBigInt(maximums.amount1)
    if (amount0Max <= spyBalance && amount1Max <= pairBalance) break
    liquidity = (liquidity * 9_999n) / 10_000n
  }
  if (!position || amount0Max > spyBalance || amount1Max > pairBalance) {
    throw new Error('新区间滑点缓冲后的最大代币用量超过余额')
  }

  const batchPermit = await signPermitBatch(account, amount0Max, amount1Max)
  const method = V4PositionManager.addCallParameters(position, {
    recipient: WALLET,
    slippageTolerance,
    deadline: BigInt(nowSeconds() + 5 * 60).toString(),
    hookData: '0x',
    batchPermit,
  })
  return {
    poolState,
    position,
    tickLower,
    tickUpper,
    liquidity,
    amount0Desired: asBigInt(position.mintAmounts.amount0),
    amount1Desired: asBigInt(position.mintAmounts.amount1),
    amount0Max,
    amount1Max,
    data: method.calldata,
  }
}

async function buildUpperExtensionMint(
  account,
  pairBalance,
  tickLower = UPPER_EXTENSION_TICK_LOWER,
  tickUpper = UPPER_EXTENSION_TICK_UPPER,
) {
  if (pairBalance <= 0n) throw new Error('单边接力仓 PAIR 余额为 0')
  const poolState = await getPoolState()
  if (poolState.tick < tickUpper) {
    throw new Error(`PAIR 已进入或穿过接力区间，无法继续按单边 PAIR 铸仓：tick=${poolState.tick}`)
  }
  const pool = makePool(poolState)
  const position = Position.fromAmount1({
    pool,
    tickLower,
    tickUpper,
    amount1: pairBalance.toString(),
  })
  const liquidity = asBigInt(position.liquidity)
  if (liquidity === 0n) throw new Error('单边接力仓可铸造流动性为 0')
  const amounts = position.mintAmounts
  const maximums = position.mintAmountsWithSlippage(UPPER_EXTENSION_MINT_SLIPPAGE)
  const amount0Desired = asBigInt(amounts.amount0)
  const amount1Desired = asBigInt(amounts.amount1)
  const amount0Max = asBigInt(maximums.amount0)
  const amount1Max = asBigInt(maximums.amount1)
  if (amount0Desired !== 0n || amount0Max !== 0n) {
    throw new Error(`接力仓不再是单边 PAIR：desiredSPY=${amount0Desired}, maxSPY=${amount0Max}`)
  }
  if (amount1Desired <= 0n || amount1Max > pairBalance) {
    throw new Error(`接力仓 PAIR 用量异常：desired=${amount1Desired}, max=${amount1Max}, balance=${pairBalance}`)
  }
  if (amount1Desired * 10_000n < pairBalance * UPPER_EXTENSION_MIN_PAIR_USE_BPS) {
    throw new Error(`接力仓没有最大化使用 PAIR：desired=${amount1Desired}, balance=${pairBalance}`)
  }
  const batchPermit = await signPairOnlyPermit(account, amount1Max)
  const method = V4PositionManager.addCallParameters(position, {
    recipient: WALLET,
    slippageTolerance: UPPER_EXTENSION_MINT_SLIPPAGE,
    deadline: BigInt(nowSeconds() + 5 * 60).toString(),
    hookData: '0x',
    batchPermit,
  })
  return {
    poolState,
    position,
    liquidity,
    amount0Desired,
    amount1Desired,
    amount0Max,
    amount1Max,
    data: method.calldata,
  }
}

async function buildSatelliteIncrease(account, targetRecord, walletSpyWei, walletPairWei) {
  const poolState = await getPoolState()
  if (poolState.tick < SATELLITE_TICK_LOWER || poolState.tick >= SATELLITE_TICK_UPPER) {
    throw new Error(
      `价格已离开目标区间：tick=${poolState.tick}，区间=[${SATELLITE_TICK_LOWER},${SATELLITE_TICK_UPPER})`,
    )
  }
  const rangePositionBps = satelliteRangePositionBps(poolState.tick)
  if (rangePositionBps < 2_000n || rangePositionBps > 8_000n) {
    throw new Error(`价格已接近目标区间边界：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
  }
  const tokenId = BigInt(targetRecord.tokenId)
  const fees = await getAccruedFees(tokenId, SATELLITE_TICK_LOWER, SATELLITE_TICK_UPPER)
  const availableSpyWei = walletSpyWei + fees.spyWei
  const availablePairWei = walletPairWei + fees.pairWei
  const pool = makePool(poolState)
  const rawPosition = Position.fromAmounts({
    pool,
    tickLower: SATELLITE_TICK_LOWER,
    tickUpper: SATELLITE_TICK_UPPER,
    amount0: availableSpyWei.toString(),
    amount1: availablePairWei.toString(),
    useFullPrecision: true,
  })
  const rawLiquidity = asBigInt(rawPosition.liquidity)
  if (rawLiquidity === 0n) throw new Error('迁移可增加流动性为 0')
  const rawMaximums = rawPosition.mintAmountsWithSlippage(SATELLITE_MINT_SLIPPAGE)
  const rawAmount0Max = asBigInt(rawMaximums.amount0)
  const rawAmount1Max = asBigInt(rawMaximums.amount1)
  if (rawAmount0Max === 0n || rawAmount1Max === 0n) throw new Error('迁移滑点上限不是双边金额')

  const scaleBase = 10n ** 18n
  let scale = minBigInt(
    scaleBase,
    (availableSpyWei * scaleBase) / rawAmount0Max,
    (availablePairWei * scaleBase) / rawAmount1Max,
  )
  scale = (scale * (10_000n - SATELLITE_MINT_SAFETY_BPS)) / 10_000n
  let liquidity = (rawLiquidity * scale) / scaleBase
  if (liquidity === 0n) throw new Error('迁移安全缩放后的流动性为 0')

  let position
  let amount0Max
  let amount1Max
  for (let attempt = 0; attempt < 5; attempt += 1) {
    position = new Position({
      pool,
      liquidity: liquidity.toString(),
      tickLower: SATELLITE_TICK_LOWER,
      tickUpper: SATELLITE_TICK_UPPER,
    })
    const maximums = position.mintAmountsWithSlippage(SATELLITE_MINT_SLIPPAGE)
    amount0Max = asBigInt(maximums.amount0)
    amount1Max = asBigInt(maximums.amount1)
    const external0Max = amount0Max > fees.spyWei ? amount0Max - fees.spyWei : 0n
    const external1Max = amount1Max > fees.pairWei ? amount1Max - fees.pairWei : 0n
    if (external0Max <= walletSpyWei && external1Max <= walletPairWei) break
    liquidity = (liquidity * 9_999n) / 10_000n
  }
  const external0Max = amount0Max > fees.spyWei ? amount0Max - fees.spyWei : 0n
  const external1Max = amount1Max > fees.pairWei ? amount1Max - fees.pairWei : 0n
  if (!position || external0Max > walletSpyWei || external1Max > walletPairWei) {
    throw new Error('迁移滑点缓冲后的外部代币需求超过钱包余额')
  }
  const batchPermit = await signPermitBatch(account, amount0Max, amount1Max)
  const method = V4PositionManager.addCallParameters(position, {
    tokenId: targetRecord.tokenId,
    slippageTolerance: SATELLITE_MINT_SLIPPAGE,
    deadline: BigInt(nowSeconds() + 5 * 60).toString(),
    hookData: '0x',
    batchPermit,
  })
  return {
    poolState,
    fees,
    position,
    liquidity,
    amount0Desired: asBigInt(position.mintAmounts.amount0),
    amount1Desired: asBigInt(position.mintAmounts.amount1),
    amount0Max,
    amount1Max,
    external0Max,
    external1Max,
    data: method.calldata,
  }
}

async function buildCustomRangeIncrease(
  account,
  targetRecord,
  walletSpyWei,
  walletPairWei,
  {
    minimumRangePositionBps = ATTACK_MIN_RANGE_POSITION_BPS,
    maximumRangePositionBps = ATTACK_MAX_RANGE_POSITION_BPS,
    slippageTolerance = ATTACK_MINT_SLIPPAGE,
  } = {},
) {
  const poolState = await getPoolState()
  if (poolState.tick < targetRecord.tickLower || poolState.tick >= targetRecord.tickUpper) {
    throw new Error(
      `价格已离开目标进攻区间：tick=${poolState.tick}，区间=[${targetRecord.tickLower},${targetRecord.tickUpper})`,
    )
  }
  const rangePositionBps = customRangePositionBps(poolState.tick, targetRecord.tickLower, targetRecord.tickUpper)
  if (rangePositionBps < minimumRangePositionBps || rangePositionBps > maximumRangePositionBps) {
    throw new Error(`价格已接近目标进攻区间边界：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
  }

  const tokenId = BigInt(targetRecord.tokenId)
  const [currentLiquidity, fees] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    }),
    getAccruedFees(tokenId, targetRecord.tickLower, targetRecord.tickUpper),
  ])
  if (currentLiquidity !== BigInt(targetRecord.liquidity)) {
    throw new Error(`目标进攻仓流动性变化：chain=${currentLiquidity}, local=${targetRecord.liquidity}`)
  }
  if (fees.liquidity !== currentLiquidity) throw new Error('目标进攻仓手续费状态流动性不一致')

  // INCREASE_LIQUIDITY closes both currencies, so fees accrued after the explicit
  // collection can fund this increase directly. Only the remainder may be pulled
  // from the fee-only wallet balance.
  const availableSpyWei = walletSpyWei + fees.spyWei
  const availablePairWei = walletPairWei + fees.pairWei
  const pool = makePool(poolState)
  const rawPosition = Position.fromAmounts({
    pool,
    tickLower: targetRecord.tickLower,
    tickUpper: targetRecord.tickUpper,
    amount0: availableSpyWei.toString(),
    amount1: availablePairWei.toString(),
    useFullPrecision: true,
  })
  const rawLiquidity = asBigInt(rawPosition.liquidity)
  if (rawLiquidity === 0n) throw new Error('手续费可增加的进攻仓流动性为 0')
  const rawMaximums = rawPosition.mintAmountsWithSlippage(slippageTolerance)
  const rawAmount0Max = asBigInt(rawMaximums.amount0)
  const rawAmount1Max = asBigInt(rawMaximums.amount1)
  if (rawAmount0Max === 0n || rawAmount1Max === 0n) throw new Error('进攻仓追加滑点上限不是双边金额')

  const scaleBase = 10n ** 18n
  let scale = minBigInt(
    scaleBase,
    (availableSpyWei * scaleBase) / rawAmount0Max,
    (availablePairWei * scaleBase) / rawAmount1Max,
  )
  scale = (scale * (10_000n - UPPER_MINT_SAFETY_BPS)) / 10_000n
  let liquidity = (rawLiquidity * scale) / scaleBase
  if (liquidity === 0n) throw new Error('进攻仓追加安全缩放后的流动性为 0')

  let position
  let amount0Max
  let amount1Max
  let external0Max
  let external1Max
  for (let attempt = 0; attempt < 8; attempt += 1) {
    position = new Position({
      pool,
      liquidity: liquidity.toString(),
      tickLower: targetRecord.tickLower,
      tickUpper: targetRecord.tickUpper,
    })
    const maximums = position.mintAmountsWithSlippage(slippageTolerance)
    amount0Max = asBigInt(maximums.amount0)
    amount1Max = asBigInt(maximums.amount1)
    external0Max = amount0Max > fees.spyWei ? amount0Max - fees.spyWei : 0n
    external1Max = amount1Max > fees.pairWei ? amount1Max - fees.pairWei : 0n
    if (external0Max <= walletSpyWei && external1Max <= walletPairWei) break
    liquidity = (liquidity * 9_995n) / 10_000n
  }
  if (!position || external0Max > walletSpyWei || external1Max > walletPairWei) {
    throw new Error('进攻仓追加的外部代币最大需求超过本次手续费余额')
  }

  const batchPermit = await signPermitBatch(account, amount0Max, amount1Max)
  const method = V4PositionManager.addCallParameters(position, {
    tokenId: targetRecord.tokenId,
    slippageTolerance,
    deadline: BigInt(nowSeconds() + 5 * 60).toString(),
    hookData: '0x',
    batchPermit,
  })
  return {
    poolState,
    currentLiquidity,
    fees,
    position,
    liquidity,
    amount0Desired: asBigInt(position.mintAmounts.amount0),
    amount1Desired: asBigInt(position.mintAmounts.amount1),
    amount0Max,
    amount1Max,
    external0Max,
    external1Max,
    data: method.calldata,
  }
}

async function satellitePreflight({ print = true } = {}) {
  const state = readState()
  if (!state || state.status !== 'active' || !state.position?.tokenId)
    throw new Error('没有可领取手续费的活动主 LP 头寸')
  if (state.pendingIncrease) throw new Error(`存在未结算的追加计划：${state.pendingIncrease.id}`)
  if (state.pendingSatellite) throw new Error(`存在未结算的卫星仓计划：${state.pendingSatellite.id}`)
  if (state.pendingMigration) throw new Error(`存在未结算的迁移计划：${state.pendingMigration.id}`)
  if (state.pendingMainRoll) throw new Error(`存在未结算的主仓迁移计划：${state.pendingMainRoll.id}`)
  if (state.pendingCurrentBand) throw new Error(`存在未结算的当前热区仓计划：${state.pendingCurrentBand.id}`)
  const duplicate = (state.satellites || []).find(
    (item) =>
      item.status === 'active' && item.tickLower === SATELLITE_TICK_LOWER && item.tickUpper === SATELLITE_TICK_UPPER,
  )
  if (duplicate) throw new Error(`相同区间已有活动卫星仓 tokenId=${duplicate.tokenId}，禁止重复建仓`)

  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const tokenId = BigInt(state.position.tokenId)
  const [
    blockNumber,
    nonceLatest,
    noncePending,
    owner,
    oldLiquidity,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    gasPrice,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
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
    getPoolState(),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getGasPrice(),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`主 LP NFT 不在执行钱包：owner=${owner}`)
  if (oldLiquidity === 0n) throw new Error('主 LP 流动性为 0')
  if (oldLiquidity !== BigInt(state.position.liquidity)) {
    throw new Error(`主 LP 链上流动性与本地账本不一致：chain=${oldLiquidity}, local=${state.position.liquidity}`)
  }
  if (spyBalance === 0n) throw new Error('钱包没有可投入的 SPY')
  if (pairBalance !== 0n) {
    throw new Error(`钱包出现 ${formatUnits(pairBalance, 18)} PAIR；为避免动用此前要求保留的 PAIR，本次停止`)
  }
  if (poolState.tick < SATELLITE_TICK_LOWER || poolState.tick >= SATELLITE_TICK_UPPER) {
    throw new Error(`当前 tick=${poolState.tick} 不在卫星仓区间 [${SATELLITE_TICK_LOWER},${SATELLITE_TICK_UPPER})`)
  }
  const rangePositionBps = satelliteRangePositionBps(poolState.tick)
  if (rangePositionBps < 2_000n || rangePositionBps > 8_000n) {
    throw new Error(`当前价格距卫星仓边界过近：rangeBps=${rangePositionBps}，禁止追价建仓`)
  }

  const [fees, spyMark] = await Promise.all([
    getAccruedFees(tokenId, state.position.tickLower, state.position.tickUpper),
    quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT),
  ])
  if (fees.liquidity !== oldLiquidity) throw new Error(`手续费状态中的主仓流动性不一致：${fees.liquidity}`)
  if (fees.spyWei === 0n && fees.pairWei === 0n) throw new Error('主仓当前没有可领取手续费')
  const totalSpyWei = spyBalance + fees.spyWei
  const totalPairWei = pairBalance + fees.pairWei
  const swap = await solveSatelliteSwap(totalSpyWei, totalPairWei, poolState)
  const collect = buildSatelliteCollect(state, oldLiquidity, poolState)
  const collectBudget = await transactionBudget(POSITION_MANAGER, collect.data)
  const conservativeRemainingGas = (gasPrice * 1_600_000n * 125n) / 100n
  const requiredEth = MIN_GAS_RESERVE + collectBudget.budget + conservativeRemainingGas
  if (ethBalance < requiredEth) {
    throw new Error(`ETH Gas 储备不足：余额 ${formatEther(ethBalance)}，保守要求 ${formatEther(requiredEth)}`)
  }

  const projectedValue = tokenAmountsUsdg(totalSpyWei, totalPairWei, poolState, spyMark)
  const rangePrices = satelliteRangePricesUsdg(spyMark)
  const report = {
    status: 'READY_TO_CREATE_SATELLITE_POSITION',
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    mainPosition: {
      tokenId: tokenId.toString(),
      tickLower: state.position.tickLower,
      tickUpper: state.position.tickUpper,
      liquidity: oldLiquidity.toString(),
      invariant: 'collect fees only; principal liquidity must remain unchanged',
    },
    satellite: {
      tickLower: SATELLITE_TICK_LOWER,
      tickUpper: SATELLITE_TICK_UPPER,
      currentTick: poolState.tick,
      rangePositionPct: (Number(rangePositionBps) / 100).toFixed(2),
      approximatePairPriceRangeUsdg: rangePrices,
      targetValueSplitPct: {
        spy: (Number(swap.targetSpyValueBps) / 100).toFixed(2),
        pair: (Number(swap.targetPairValueBps) / 100).toFixed(2),
      },
    },
    inputs: {
      walletSpy: formatUnits(spyBalance, 18),
      walletPair: formatUnits(pairBalance, 18),
      accruedFeeSpy: formatUnits(fees.spyWei, 18),
      accruedFeePair: formatUnits(fees.pairWei, 18),
      projectedTotalUsdg: formatUnits(projectedValue.totalUsdg, 6),
    },
    rebalance: {
      swapSpy: formatUnits(swap.amountIn, 18),
      quotedPair: formatUnits(swap.amountOut, 18),
      expectedPostSwapSpy: formatUnits(swap.expectedSpyWei, 18),
      expectedPostSwapPair: formatUnits(swap.expectedPairWei, 18),
      slippageBps: Number(SWAP_SLIPPAGE_BPS),
    },
    gas: {
      ethBalance: formatEther(ethBalance),
      collectMaxBudgetEth: formatEther(collectBudget.budget),
      conservativeRequiredEth: formatEther(requiredEth),
      retainedMinimumEth: formatEther(MIN_GAS_RESERVE),
    },
    policy: {
      useAllWalletSpy: true,
      useExistingWalletPair: false,
      collectAllCurrentMainPositionFees: true,
      useEthAsPrincipal: false,
      holdWhenOutOfRange: true,
      automaticExit: false,
      maximumEconomicResidualBps: Number(SATELLITE_MAX_RESIDUAL_BPS),
    },
  }
  appendAudit('satellite_preflight', report)
  if (print) console.log(stringify(report))
  return {
    state,
    tokenId,
    oldLiquidity,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    fees,
    spyMark,
    swap,
    collect,
    report,
  }
}

async function migrationPreflight({ print = true } = {}) {
  const state = readState()
  if (!state || state.status !== 'active' || !state.position?.tokenId) throw new Error('没有可迁移的活动主 LP 头寸')
  if (state.pendingIncrease) throw new Error(`存在未结算的追加计划：${state.pendingIncrease.id}`)
  if (state.pendingSatellite) throw new Error(`存在未结算的卫星仓计划：${state.pendingSatellite.id}`)
  if (state.pendingMigration) throw new Error(`存在未结算的迁移计划：${state.pendingMigration.id}`)
  if (state.pendingMainRoll) throw new Error(`存在未结算的主仓迁移计划：${state.pendingMainRoll.id}`)
  if (state.pendingCurrentBand) throw new Error(`存在未结算的当前热区仓计划：${state.pendingCurrentBand.id}`)

  const activeTargets = (state.satellites || []).filter(
    (item) =>
      item.status === 'active' && item.tickLower === SATELLITE_TICK_LOWER && item.tickUpper === SATELLITE_TICK_UPPER,
  )
  if (activeTargets.length !== 1) {
    throw new Error(`目标区间活动头寸数量必须恰好为 1，当前为 ${activeTargets.length}`)
  }
  const targetRecord = activeTargets[0]
  if (String(targetRecord.tokenId) === String(state.position.tokenId)) {
    throw new Error(`主仓已是目标 NFT ${targetRecord.tokenId}，禁止重复迁移`)
  }

  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const sourceTokenId = BigInt(state.position.tokenId)
  const targetTokenId = BigInt(targetRecord.tokenId)
  const [
    blockNumber,
    nonceLatest,
    noncePending,
    sourceOwner,
    targetOwner,
    sourceLiquidity,
    targetLiquidity,
    poolState,
    ethBalance,
    walletSpyWei,
    walletPairWei,
    gasPrice,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [sourceTokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [targetTokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [sourceTokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [targetTokenId],
    }),
    getPoolState(),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getGasPrice(),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (sourceOwner.toLowerCase() !== WALLET.toLowerCase())
    throw new Error(`旧主仓 NFT 不在执行钱包：owner=${sourceOwner}`)
  if (targetOwner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`目标 NFT 不在执行钱包：owner=${targetOwner}`)
  if (sourceLiquidity === 0n) throw new Error('旧主仓流动性为 0')
  if (targetLiquidity === 0n) throw new Error('目标头寸流动性为 0')
  if (sourceLiquidity !== BigInt(state.position.liquidity)) {
    throw new Error(`旧主仓链上流动性与本地账本不一致：chain=${sourceLiquidity}, local=${state.position.liquidity}`)
  }
  if (targetLiquidity !== BigInt(targetRecord.liquidity)) {
    throw new Error(`目标头寸链上流动性与本地账本不一致：chain=${targetLiquidity}, local=${targetRecord.liquidity}`)
  }
  if (poolState.tick < SATELLITE_TICK_LOWER || poolState.tick >= SATELLITE_TICK_UPPER) {
    throw new Error(`当前 tick=${poolState.tick} 不在目标区间 [${SATELLITE_TICK_LOWER},${SATELLITE_TICK_UPPER})`)
  }
  const rangePositionBps = satelliteRangePositionBps(poolState.tick)
  if (rangePositionBps < 2_000n || rangePositionBps > 8_000n) {
    throw new Error(`当前价格距目标区间边界过近：rangeBps=${rangePositionBps}，禁止迁移追价`)
  }

  const [sourceFees, targetFees, spyMark] = await Promise.all([
    getAccruedFees(sourceTokenId, state.position.tickLower, state.position.tickUpper),
    getAccruedFees(targetTokenId, targetRecord.tickLower, targetRecord.tickUpper),
    quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT),
  ])
  if (sourceFees.liquidity !== sourceLiquidity) throw new Error(`旧主仓手续费状态流动性不一致：${sourceFees.liquidity}`)
  if (targetFees.liquidity !== targetLiquidity)
    throw new Error(`目标头寸手续费状态流动性不一致：${targetFees.liquidity}`)

  const removal = buildFullRemove(state.position, sourceLiquidity, poolState)
  const totalSpyWei = walletSpyWei + removal.amount0Principal + sourceFees.spyWei + targetFees.spyWei
  const totalPairWei = walletPairWei + removal.amount1Principal + sourceFees.pairWei + targetFees.pairWei
  const swap = await solveSatelliteSwap(totalSpyWei, totalPairWei, poolState)
  const removalBudget = await transactionBudget(POSITION_MANAGER, removal.data)
  const conservativeRemainingGas = (gasPrice * 1_600_000n * 125n) / 100n
  const requiredEth = MIN_GAS_RESERVE + removalBudget.budget + conservativeRemainingGas
  if (ethBalance < requiredEth) {
    throw new Error(`ETH Gas 储备不足：余额 ${formatEther(ethBalance)}，保守要求 ${formatEther(requiredEth)}`)
  }

  const projectedValue = tokenAmountsUsdg(totalSpyWei, totalPairWei, poolState, spyMark)
  const sourcePrincipalValue = tokenAmountsUsdg(removal.amount0Principal, removal.amount1Principal, poolState, spyMark)
  const sourceFeeValue = tokenAmountsUsdg(sourceFees.spyWei, sourceFees.pairWei, poolState, spyMark)
  const targetFeeValue = tokenAmountsUsdg(targetFees.spyWei, targetFees.pairWei, poolState, spyMark)
  const report = {
    status: 'READY_TO_MIGRATE_AND_COMPOUND',
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    pool: {
      currentTick: poolState.tick,
      targetTickLower: SATELLITE_TICK_LOWER,
      targetTickUpper: SATELLITE_TICK_UPPER,
      targetRangePositionPct: (Number(rangePositionBps) / 100).toFixed(2),
      approximatePairPriceRangeUsdg: satelliteRangePricesUsdg(spyMark),
    },
    sourcePosition: {
      tokenId: sourceTokenId.toString(),
      tickLower: state.position.tickLower,
      tickUpper: state.position.tickUpper,
      liquidity: sourceLiquidity.toString(),
      principal: {
        spy: formatUnits(removal.amount0Principal, 18),
        pair: formatUnits(removal.amount1Principal, 18),
        markedUsdg: formatUnits(sourcePrincipalValue.totalUsdg, 6),
      },
      accruedFees: {
        spy: formatUnits(sourceFees.spyWei, 18),
        pair: formatUnits(sourceFees.pairWei, 18),
        markedUsdg: formatUnits(sourceFeeValue.totalUsdg, 6),
      },
      action: 'remove all liquidity and collect; keep NFT unburned',
    },
    targetPosition: {
      tokenId: targetTokenId.toString(),
      liquidityBefore: targetLiquidity.toString(),
      accruedFeesToCompound: {
        spy: formatUnits(targetFees.spyWei, 18),
        pair: formatUnits(targetFees.pairWei, 18),
        markedUsdg: formatUnits(targetFeeValue.totalUsdg, 6),
      },
      action: 'increase this existing NFT; do not create a third NFT',
    },
    projectedAssets: {
      walletSpy: formatUnits(walletSpyWei, 18),
      walletPair: formatUnits(walletPairWei, 18),
      totalSpyBeforeRebalance: formatUnits(totalSpyWei, 18),
      totalPairBeforeRebalance: formatUnits(totalPairWei, 18),
      totalMarkedUsdg: formatUnits(projectedValue.totalUsdg, 6),
    },
    rebalance: {
      direction: 'SPY_TO_PAIR',
      swapSpy: formatUnits(swap.amountIn, 18),
      quotedPair: formatUnits(swap.amountOut, 18),
      expectedPostSwapSpy: formatUnits(swap.expectedSpyWei, 18),
      expectedPostSwapPair: formatUnits(swap.expectedPairWei, 18),
      slippageBps: Number(SWAP_SLIPPAGE_BPS),
      targetValueSplitPct: {
        spy: (Number(swap.targetSpyValueBps) / 100).toFixed(2),
        pair: (Number(swap.targetPairValueBps) / 100).toFixed(2),
      },
    },
    gas: {
      ethBalance: formatEther(ethBalance),
      removalMaxBudgetEth: formatEther(removalBudget.budget),
      conservativeRequiredEth: formatEther(requiredEth),
      retainedMinimumEth: formatEther(MIN_GAS_RESERVE),
    },
    policy: {
      compoundBothPositionsFees: true,
      preserveWalletEthExceptGas: true,
      useAllWalletSpyAndPair: true,
      burnSourceNft: false,
      createNewNft: false,
      finalActiveLiquidityNftCount: 1,
      holdWhenOutOfRange: true,
      automaticExit: false,
    },
  }
  appendAudit('migration_preflight', report)
  if (print) console.log(stringify(report))
  return {
    state,
    targetRecord,
    sourceTokenId,
    targetTokenId,
    sourceLiquidity,
    targetLiquidity,
    poolState,
    ethBalance,
    walletSpyWei,
    walletPairWei,
    sourceFees,
    targetFees,
    spyMark,
    removal,
    swap,
    report,
  }
}

async function satelliteEnter() {
  const check = await satellitePreflight({ print: true })
  const operationId = `satellite-${new Date().toISOString().replace(/[-:.]/g, '')}`
  const state = check.state
  state.pendingSatellite = {
    id: operationId,
    status: 'planned',
    createdAt: new Date().toISOString(),
    tickLower: SATELLITE_TICK_LOWER,
    tickUpper: SATELLITE_TICK_UPPER,
    mainTokenId: check.tokenId.toString(),
    mainLiquidityInvariant: check.oldLiquidity.toString(),
    baselineWalletSpyWei: check.spyBalance.toString(),
    baselineWalletPairWei: check.pairBalance.toString(),
  }
  writeState(state)
  appendAudit('satellite_plan_created', state.pendingSatellite)

  const transactions = []
  try {
    const account = loadAccount()
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
    })
    const [spyBeforeCollect, pairBeforeCollect, oldLiquidityBeforeCollect, nonceLatest, noncePending] =
      await Promise.all([
        publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [check.tokenId],
        }),
        publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
        publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
      ])
    if (nonceLatest !== noncePending)
      throw new Error(`广播前出现 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
    if (spyBeforeCollect !== check.spyBalance || pairBeforeCollect !== check.pairBalance)
      throw new Error('广播前钱包代币余额发生变化，已停止')
    if (oldLiquidityBeforeCollect !== check.oldLiquidity) throw new Error('广播前主仓流动性发生变化，已停止')

    const freshCollectPoolState = await getPoolState()
    const collect = buildSatelliteCollect(state, check.oldLiquidity, freshCollectPoolState)
    const collected = await sendChecked(walletClient, {
      label: `卫星仓 1/4 领取主仓手续费 (${operationId})`,
      to: POSITION_MANAGER,
      data: collect.data,
      minimumBalanceAfter: MIN_GAS_RESERVE,
    })
    transactions.push(collected)
    const [spyAfterCollect, pairAfterCollect, oldLiquidityAfterCollect] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.tokenId],
      }),
    ])
    if (oldLiquidityAfterCollect !== check.oldLiquidity) throw new Error('手续费领取成功，但主仓流动性发生变化')
    if (spyAfterCollect < spyBeforeCollect || pairAfterCollect < pairBeforeCollect)
      throw new Error('手续费领取后的钱包余额异常')
    const collectedSpyWei = spyAfterCollect - spyBeforeCollect
    const collectedPairWei = pairAfterCollect - pairBeforeCollect
    if (collectedSpyWei === 0n && collectedPairWei === 0n) throw new Error('领取交易成功但未收到手续费')
    state.pendingSatellite.status = 'fees_collected'
    state.pendingSatellite.collectTransaction = collected.hash
    state.pendingSatellite.collectedSpyWei = collectedSpyWei.toString()
    state.pendingSatellite.collectedPairWei = collectedPairWei.toString()
    writeState(state)

    const poolStateBeforeSwap = await getPoolState()
    const swapPlan = await solveSatelliteSwap(spyAfterCollect, pairAfterCollect, poolStateBeforeSwap)
    transactions.push(
      await approveErc20(
        walletClient,
        SPY,
        swapPlan.amountIn,
        `卫星仓授权 SPY 给 Permit2 (${operationId})`,
        MIN_GAS_RESERVE,
      ),
    )
    transactions.push(
      await approvePermit2(
        walletClient,
        SPY,
        UNIVERSAL_ROUTER,
        swapPlan.amountIn,
        `卫星仓 2/4 授权路由使用 SPY (${operationId})`,
        MIN_GAS_RESERVE,
      ),
    )
    const liveSwapQuote = await quoteSpyToPair(swapPlan.amountIn)
    const pairMinimum = bpsFloor(liveSwapQuote.amountOut, SWAP_SLIPPAGE_BPS)
    const swapData = buildV4SwapData(swapPlan.amountIn, pairMinimum, BigInt(nowSeconds() + 5 * 60))
    const [spyBeforeSwap, pairBeforeSwap] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    ])
    const swapped = await sendChecked(walletClient, {
      label: `卫星仓 3/4 配平 SPY→PAIR (${operationId})`,
      to: UNIVERSAL_ROUTER,
      data: swapData,
      minimumBalanceAfter: MIN_GAS_RESERVE,
    })
    transactions.push(swapped)
    const [spyAfterSwap, pairAfterSwap, oldLiquidityAfterSwap] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.tokenId],
      }),
    ])
    const actualSpySpentWei = spyBeforeSwap - spyAfterSwap
    const actualPairReceivedWei = pairAfterSwap - pairBeforeSwap
    if (actualSpySpentWei !== swapPlan.amountIn) throw new Error(`换币实际 SPY 支出异常：${actualSpySpentWei}`)
    if (actualPairReceivedWei < pairMinimum) throw new Error('换币实际 PAIR 收入低于滑点保护下限')
    if (oldLiquidityAfterSwap !== check.oldLiquidity) throw new Error('配平后主仓流动性发生变化')
    state.pendingSatellite.status = 'rebalanced'
    state.pendingSatellite.swapTransaction = swapped.hash
    state.pendingSatellite.swapSpyWei = actualSpySpentWei.toString()
    state.pendingSatellite.receivedPairWei = actualPairReceivedWei.toString()
    writeState(state)

    transactions.push(
      await approveErc20(
        walletClient,
        SPY,
        spyAfterSwap,
        `卫星仓确认 SPY Permit2 授权 (${operationId})`,
        MIN_GAS_RESERVE,
      ),
    )
    transactions.push(
      await approveErc20(
        walletClient,
        PAIR,
        pairAfterSwap,
        `卫星仓确认 PAIR Permit2 授权 (${operationId})`,
        MIN_GAS_RESERVE,
      ),
    )
    const mint = await buildSatelliteMint(account, spyAfterSwap, pairAfterSwap)
    const [spyBeforeMint, pairBeforeMint, oldLiquidityBeforeMint] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.tokenId],
      }),
    ])
    if (spyBeforeMint < mint.amount0Max || pairBeforeMint < mint.amount1Max)
      throw new Error('铸造前余额不足以覆盖滑点上限')
    if (oldLiquidityBeforeMint !== check.oldLiquidity) throw new Error('铸造前主仓流动性发生变化')
    const minted = await sendChecked(walletClient, {
      label: `卫星仓 4/4 铸造新区间 LP (${operationId})`,
      to: POSITION_MANAGER,
      data: mint.data,
      minimumBalanceAfter: MIN_GAS_RESERVE,
    })
    transactions.push(minted)
    const satelliteTokenId = parseMintTokenId(minted.receipt)
    if (satelliteTokenId === null) throw new Error(`卫星仓 mint 已成功但未解析到 NFT tokenId：${minted.hash}`)
    const [satelliteOwner, satelliteLiquidity, oldLiquidityFinal, finalEth, finalSpy, finalPair, finalPoolState] =
      await Promise.all([
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [satelliteTokenId],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [satelliteTokenId],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [check.tokenId],
        }),
        publicClient.getBalance({ address: WALLET }),
        publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        getPoolState(),
      ])
    if (satelliteOwner.toLowerCase() !== WALLET.toLowerCase() || satelliteLiquidity === 0n)
      throw new Error('卫星仓 NFT 链上读回不完整')
    if (satelliteLiquidity !== mint.liquidity)
      throw new Error(`卫星仓流动性与铸造计划不一致：chain=${satelliteLiquidity}, plan=${mint.liquidity}`)
    if (oldLiquidityFinal !== check.oldLiquidity)
      throw new Error(`主仓流动性不变量被破坏：before=${check.oldLiquidity}, after=${oldLiquidityFinal}`)
    if (finalEth < MIN_GAS_RESERVE) throw new Error(`建仓后 ETH 低于 Gas 储备：${formatEther(finalEth)}`)

    const finalPosition = new Position({
      pool: makePool(finalPoolState),
      liquidity: satelliteLiquidity.toString(),
      tickLower: SATELLITE_TICK_LOWER,
      tickUpper: SATELLITE_TICK_UPPER,
    })
    const underlyingSpyWei = asBigInt(finalPosition.amount0.quotient)
    const underlyingPairWei = asBigInt(finalPosition.amount1.quotient)
    let residualBps = null
    let residualUsdg = null
    let positionUsdg = null
    let residualWarning = null
    try {
      const finalSpyMark = await quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT)
      const residualValue = tokenAmountsUsdg(finalSpy, finalPair, finalPoolState, finalSpyMark)
      const positionValue = tokenAmountsUsdg(underlyingSpyWei, underlyingPairWei, finalPoolState, finalSpyMark)
      residualUsdg = residualValue.totalUsdg
      positionUsdg = positionValue.totalUsdg
      const denominator = residualUsdg + positionUsdg
      residualBps = denominator === 0n ? 0n : (residualUsdg * 10_000n) / denominator
      if (residualBps > SATELLITE_MAX_RESIDUAL_BPS) {
        residualWarning = `钱包非 ETH 残余约占 ${Number(residualBps) / 100}%，高于 ${Number(SATELLITE_MAX_RESIDUAL_BPS) / 100}% 目标；不自动追加第二笔交易`
      }
    } catch (error) {
      residualWarning = `估值读回失败：${error.shortMessage || error.message}`
    }

    const record = {
      id: operationId,
      status: 'active',
      completedAt: new Date().toISOString(),
      tokenId: satelliteTokenId.toString(),
      tickLower: SATELLITE_TICK_LOWER,
      tickUpper: SATELLITE_TICK_UPPER,
      liquidity: satelliteLiquidity.toString(),
      source: 'all wallet SPY plus all fees collected from main position; no ETH principal',
      policy: { mode: 'grid_hold_out_of_range', autoExit: false },
      mainPositionInvariant: {
        tokenId: check.tokenId.toString(),
        liquidityBefore: check.oldLiquidity.toString(),
        liquidityAfter: oldLiquidityFinal.toString(),
      },
      collectedFees: { spyWei: collectedSpyWei.toString(), pairWei: collectedPairWei.toString() },
      rebalance: { spySpentWei: actualSpySpentWei.toString(), pairReceivedWei: actualPairReceivedWei.toString() },
      minted: {
        desiredSpyWei: mint.amount0Desired.toString(),
        desiredPairWei: mint.amount1Desired.toString(),
        walletSpentSpyWei: (spyBeforeMint - finalSpy).toString(),
        walletSpentPairWei: (pairBeforeMint - finalPair).toString(),
        underlyingSpyWei: underlyingSpyWei.toString(),
        underlyingPairWei: underlyingPairWei.toString(),
      },
      residual: {
        spyWei: finalSpy.toString(),
        pairWei: finalPair.toString(),
        markedUsdg: residualUsdg?.toString() ?? null,
        bpsOfSatelliteAssets: residualBps?.toString() ?? null,
        warning: residualWarning,
      },
      gasSpentWei: receiptGasTotal(transactions).toString(),
      finalEthWei: finalEth.toString(),
      transactions: transactions.filter(Boolean).map((item) => item.hash),
      mintBlock: minted.receipt.blockNumber.toString(),
      mintTransaction: minted.hash,
    }
    state.satellites = [...(state.satellites || []), record]
    delete state.pendingSatellite
    writeState(state)
    appendAudit('satellite_complete', record)
    console.log(
      stringify({
        status: 'SATELLITE_ACTIVE',
        tokenId: satelliteTokenId,
        tickLower: SATELLITE_TICK_LOWER,
        tickUpper: SATELLITE_TICK_UPPER,
        liquidity: satelliteLiquidity,
        currentTick: finalPoolState.tick,
        mainLiquidityUnchanged: oldLiquidityFinal === check.oldLiquidity,
        collectedFees: { spy: formatUnits(collectedSpyWei, 18), pair: formatUnits(collectedPairWei, 18) },
        rebalance: {
          spySpent: formatUnits(actualSpySpentWei, 18),
          pairReceived: formatUnits(actualPairReceivedWei, 18),
        },
        lpUnderlying: { spy: formatUnits(underlyingSpyWei, 18), pair: formatUnits(underlyingPairWei, 18) },
        walletResidual: {
          spy: formatUnits(finalSpy, 18),
          pair: formatUnits(finalPair, 18),
          markedUsdg: residualUsdg === null ? null : formatUnits(residualUsdg, 6),
          bpsOfSatelliteAssets: residualBps,
          warning: residualWarning,
        },
        remainingEth: formatEther(finalEth),
        gasSpentEth: formatEther(receiptGasTotal(transactions)),
        transactions: record.transactions,
      }),
    )
  } catch (error) {
    const latestState = readState()
    if (latestState?.pendingSatellite?.id === operationId) {
      latestState.pendingSatellite.lastErrorAt = new Date().toISOString()
      latestState.pendingSatellite.lastError = error.shortMessage || error.message
      latestState.pendingSatellite.completedTransactions = transactions.filter(Boolean).map((item) => item.hash)
      writeState(latestState)
    }
    appendAudit('satellite_partial', {
      id: operationId,
      message: error.shortMessage || error.message,
      transactions: transactions.filter(Boolean).map((item) => item.hash),
    })
    throw error
  }
}

async function migrationEnter() {
  const check = await migrationPreflight({ print: true })
  const operationId = `migration-${new Date().toISOString().replace(/[-:.]/g, '')}`
  const state = check.state
  const sourcePositionRecord = { ...state.position }
  state.pendingMigration = {
    id: operationId,
    status: 'planned',
    createdAt: new Date().toISOString(),
    sourceTokenId: check.sourceTokenId.toString(),
    targetTokenId: check.targetTokenId.toString(),
    sourceLiquidityBefore: check.sourceLiquidity.toString(),
    targetLiquidityBefore: check.targetLiquidity.toString(),
    baselineWalletSpyWei: check.walletSpyWei.toString(),
    baselineWalletPairWei: check.walletPairWei.toString(),
    burnSourceNft: false,
    createNewNft: false,
  }
  writeState(state)
  appendAudit('migration_plan_created', state.pendingMigration)

  const transactions = []
  try {
    const account = loadAccount()
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
    })
    const [
      nonceLatest,
      noncePending,
      sourceOwnerBefore,
      targetOwnerBefore,
      sourceLiquidityBefore,
      targetLiquidityBefore,
      spyBeforeRemoval,
      pairBeforeRemoval,
    ] = await Promise.all([
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [check.sourceTokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [check.targetTokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.sourceTokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.targetTokenId],
      }),
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    ])
    if (nonceLatest !== noncePending)
      throw new Error(`广播前出现 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
    if (
      sourceOwnerBefore.toLowerCase() !== WALLET.toLowerCase() ||
      targetOwnerBefore.toLowerCase() !== WALLET.toLowerCase()
    ) {
      throw new Error('广播前源或目标 NFT 所有权发生变化')
    }
    if (sourceLiquidityBefore !== check.sourceLiquidity || targetLiquidityBefore !== check.targetLiquidity) {
      throw new Error('广播前源或目标 LP 流动性发生变化')
    }
    if (spyBeforeRemoval !== check.walletSpyWei || pairBeforeRemoval !== check.walletPairWei) {
      throw new Error('广播前钱包代币余额发生变化，已停止')
    }

    const removalPoolState = await getPoolState()
    const removalRangePositionBps = satelliteRangePositionBps(removalPoolState.tick)
    if (removalRangePositionBps < 2_000n || removalRangePositionBps > 8_000n) {
      throw new Error(
        `广播前价格已接近目标区间边界：tick=${removalPoolState.tick}, rangeBps=${removalRangePositionBps}`,
      )
    }
    const removal = buildFullRemove(sourcePositionRecord, sourceLiquidityBefore, removalPoolState)
    const removed = await sendChecked(walletClient, {
      label: `迁移 1/3 撤出旧主仓并领取手续费 (${operationId})`,
      to: POSITION_MANAGER,
      data: removal.data,
      minimumBalanceAfter: MIN_GAS_RESERVE,
    })
    transactions.push(removed)
    const [spyAfterRemoval, pairAfterRemoval, sourceLiquidityAfterRemoval, targetLiquidityAfterRemoval] =
      await Promise.all([
        publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [check.sourceTokenId],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [check.targetTokenId],
        }),
      ])
    if (sourceLiquidityAfterRemoval !== 0n)
      throw new Error(`旧主仓撤出回执成功但 liquidity=${sourceLiquidityAfterRemoval}`)
    if (targetLiquidityAfterRemoval !== targetLiquidityBefore) throw new Error('撤出旧主仓时目标头寸流动性发生变化')
    if (spyAfterRemoval < spyBeforeRemoval || pairAfterRemoval < pairBeforeRemoval)
      throw new Error('撤出旧主仓后的钱包余额异常')
    const sourceReceivedSpyWei = spyAfterRemoval - spyBeforeRemoval
    const sourceReceivedPairWei = pairAfterRemoval - pairBeforeRemoval
    if (sourceReceivedSpyWei === 0n && sourceReceivedPairWei === 0n) throw new Error('旧主仓撤出成功但钱包未收到代币')
    state.pendingMigration.status = 'source_removed'
    state.pendingMigration.removalTransaction = removed.hash
    state.pendingMigration.sourceReceivedSpyWei = sourceReceivedSpyWei.toString()
    state.pendingMigration.sourceReceivedPairWei = sourceReceivedPairWei.toString()
    writeState(state)

    const poolStateBeforeSwap = await getPoolState()
    const rangePositionBeforeSwapBps = satelliteRangePositionBps(poolStateBeforeSwap.tick)
    if (rangePositionBeforeSwapBps < 2_000n || rangePositionBeforeSwapBps > 8_000n) {
      throw new Error(
        `撤仓后价格已接近目标区间边界：tick=${poolStateBeforeSwap.tick}, rangeBps=${rangePositionBeforeSwapBps}`,
      )
    }
    const targetFeesBeforeSwap = await getAccruedFees(check.targetTokenId, SATELLITE_TICK_LOWER, SATELLITE_TICK_UPPER)
    if (targetFeesBeforeSwap.liquidity !== targetLiquidityBefore)
      throw new Error('配平前目标头寸手续费状态流动性不一致')
    const swapPlan = await solveSatelliteSwap(
      spyAfterRemoval + targetFeesBeforeSwap.spyWei,
      pairAfterRemoval + targetFeesBeforeSwap.pairWei,
      poolStateBeforeSwap,
    )
    transactions.push(
      await approveErc20(
        walletClient,
        SPY,
        swapPlan.amountIn,
        `迁移确认 SPY 授权给 Permit2 (${operationId})`,
        MIN_GAS_RESERVE,
      ),
    )
    transactions.push(
      await approvePermit2(
        walletClient,
        SPY,
        UNIVERSAL_ROUTER,
        swapPlan.amountIn,
        `迁移 2/3 授权路由使用 SPY (${operationId})`,
        MIN_GAS_RESERVE,
      ),
    )
    const liveSwapQuote = await quoteSpyToPair(swapPlan.amountIn)
    const pairMinimum = bpsFloor(liveSwapQuote.amountOut, SWAP_SLIPPAGE_BPS)
    const swapData = buildV4SwapData(swapPlan.amountIn, pairMinimum, BigInt(nowSeconds() + 5 * 60))
    const [spyBeforeSwap, pairBeforeSwap, sourceLiquidityBeforeSwap, targetLiquidityBeforeSwap] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.sourceTokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.targetTokenId],
      }),
    ])
    if (sourceLiquidityBeforeSwap !== 0n || targetLiquidityBeforeSwap !== targetLiquidityBefore) {
      throw new Error('配平广播前源或目标流动性状态异常')
    }
    if (spyBeforeSwap < swapPlan.amountIn) throw new Error('配平广播前 SPY 余额不足')
    const swapped = await sendChecked(walletClient, {
      label: `迁移 2/3 配平 SPY→PAIR (${operationId})`,
      to: UNIVERSAL_ROUTER,
      data: swapData,
      minimumBalanceAfter: MIN_GAS_RESERVE,
    })
    transactions.push(swapped)
    const [spyAfterSwap, pairAfterSwap, sourceLiquidityAfterSwap, targetLiquidityAfterSwap] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.sourceTokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.targetTokenId],
      }),
    ])
    const actualSpySpentWei = spyBeforeSwap - spyAfterSwap
    const actualPairReceivedWei = pairAfterSwap - pairBeforeSwap
    if (actualSpySpentWei !== swapPlan.amountIn) throw new Error(`配平实际 SPY 支出异常：${actualSpySpentWei}`)
    if (actualPairReceivedWei < pairMinimum) throw new Error('配平实际 PAIR 收入低于滑点保护下限')
    if (sourceLiquidityAfterSwap !== 0n || targetLiquidityAfterSwap !== targetLiquidityBefore) {
      throw new Error('配平后源或目标流动性状态异常')
    }
    state.pendingMigration.status = 'rebalanced'
    state.pendingMigration.swapTransaction = swapped.hash
    state.pendingMigration.swapSpyWei = actualSpySpentWei.toString()
    state.pendingMigration.receivedPairWei = actualPairReceivedWei.toString()
    writeState(state)

    const increase = await buildSatelliteIncrease(account, check.targetRecord, spyAfterSwap, pairAfterSwap)
    transactions.push(
      await approveErc20(
        walletClient,
        SPY,
        increase.external0Max,
        `迁移确认 SPY Permit2 授权 (${operationId})`,
        MIN_GAS_RESERVE,
      ),
    )
    transactions.push(
      await approveErc20(
        walletClient,
        PAIR,
        increase.external1Max,
        `迁移确认 PAIR Permit2 授权 (${operationId})`,
        MIN_GAS_RESERVE,
      ),
    )
    const [spyBeforeIncrease, pairBeforeIncrease, sourceLiquidityBeforeIncrease, targetLiquidityBeforeIncrease] =
      await Promise.all([
        publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [check.sourceTokenId],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [check.targetTokenId],
        }),
      ])
    if (sourceLiquidityBeforeIncrease !== 0n || targetLiquidityBeforeIncrease !== targetLiquidityBefore) {
      throw new Error('复投广播前源或目标流动性状态异常')
    }
    if (spyBeforeIncrease < increase.external0Max || pairBeforeIncrease < increase.external1Max) {
      throw new Error(
        `复投滑点上限所需钱包余额不足：SPY max=${formatUnits(increase.external0Max, 18)}, PAIR max=${formatUnits(increase.external1Max, 18)}`,
      )
    }
    const added = await sendChecked(walletClient, {
      label: `迁移 3/3 增加目标 NFT 并复投手续费 (${operationId})`,
      to: POSITION_MANAGER,
      data: increase.data,
      minimumBalanceAfter: MIN_GAS_RESERVE,
    })
    transactions.push(added)

    const [
      sourceOwnerFinal,
      targetOwnerFinal,
      sourceLiquidityFinal,
      targetLiquidityFinal,
      finalEth,
      finalSpy,
      finalPair,
      finalPoolState,
    ] = await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [check.sourceTokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [check.targetTokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.sourceTokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.targetTokenId],
      }),
      publicClient.getBalance({ address: WALLET }),
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      getPoolState(),
    ])
    const expectedTargetLiquidity = targetLiquidityBefore + increase.liquidity
    if (sourceOwnerFinal.toLowerCase() !== WALLET.toLowerCase()) throw new Error('旧 NFT 被意外转移或销毁')
    if (targetOwnerFinal.toLowerCase() !== WALLET.toLowerCase()) throw new Error('目标 NFT 所有权异常')
    if (sourceLiquidityFinal !== 0n) throw new Error(`迁移完成回执后旧主仓 liquidity=${sourceLiquidityFinal}`)
    if (targetLiquidityFinal !== expectedTargetLiquidity) {
      throw new Error(`目标流动性与复投计划不一致：chain=${targetLiquidityFinal}, expected=${expectedTargetLiquidity}`)
    }
    if (finalEth < MIN_GAS_RESERVE) throw new Error(`迁移后 ETH 低于 Gas 储备：${formatEther(finalEth)}`)

    const finalPosition = new Position({
      pool: makePool(finalPoolState),
      liquidity: targetLiquidityFinal.toString(),
      tickLower: SATELLITE_TICK_LOWER,
      tickUpper: SATELLITE_TICK_UPPER,
    })
    const underlyingSpyWei = asBigInt(finalPosition.amount0.quotient)
    const underlyingPairWei = asBigInt(finalPosition.amount1.quotient)
    let residualBps = null
    let residualUsdg = null
    let positionUsdg = null
    let residualWarning = null
    try {
      const finalSpyMark = await quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT)
      const residualValue = tokenAmountsUsdg(finalSpy, finalPair, finalPoolState, finalSpyMark)
      const positionValue = tokenAmountsUsdg(underlyingSpyWei, underlyingPairWei, finalPoolState, finalSpyMark)
      residualUsdg = residualValue.totalUsdg
      positionUsdg = positionValue.totalUsdg
      const denominator = residualUsdg + positionUsdg
      residualBps = denominator === 0n ? 0n : (residualUsdg * 10_000n) / denominator
      if (residualBps > SATELLITE_MAX_RESIDUAL_BPS) {
        residualWarning = `钱包非 ETH 残余约占 ${Number(residualBps) / 100}%，高于 ${Number(SATELLITE_MAX_RESIDUAL_BPS) / 100}% 目标；不自动追加第二笔交易`
      }
    } catch (error) {
      residualWarning = `估值读回失败：${error.shortMessage || error.message}`
    }

    const record = {
      id: operationId,
      status: 'complete',
      completedAt: new Date().toISOString(),
      source: {
        tokenId: check.sourceTokenId.toString(),
        tickLower: sourcePositionRecord.tickLower,
        tickUpper: sourcePositionRecord.tickUpper,
        liquidityBefore: sourceLiquidityBefore.toString(),
        liquidityAfter: sourceLiquidityFinal.toString(),
        burned: false,
        accruedFeesAtPreflight: {
          spyWei: check.sourceFees.spyWei.toString(),
          pairWei: check.sourceFees.pairWei.toString(),
        },
        walletReceived: {
          spyWei: sourceReceivedSpyWei.toString(),
          pairWei: sourceReceivedPairWei.toString(),
        },
        removalTransaction: removed.hash,
      },
      target: {
        tokenId: check.targetTokenId.toString(),
        tickLower: SATELLITE_TICK_LOWER,
        tickUpper: SATELLITE_TICK_UPPER,
        liquidityBefore: targetLiquidityBefore.toString(),
        liquidityAdded: increase.liquidity.toString(),
        liquidityAfter: targetLiquidityFinal.toString(),
        accruedFeesCompounded: {
          spyWei: increase.fees.spyWei.toString(),
          pairWei: increase.fees.pairWei.toString(),
        },
        desiredIncrease: {
          spyWei: increase.amount0Desired.toString(),
          pairWei: increase.amount1Desired.toString(),
        },
        walletNetSpentOnIncrease: {
          spyWei: (spyBeforeIncrease - finalSpy).toString(),
          pairWei: (pairBeforeIncrease - finalPair).toString(),
        },
        underlyingAfter: {
          spyWei: underlyingSpyWei.toString(),
          pairWei: underlyingPairWei.toString(),
        },
        increaseTransaction: added.hash,
      },
      rebalance: {
        spySpentWei: actualSpySpentWei.toString(),
        pairReceivedWei: actualPairReceivedWei.toString(),
        minimumPairWei: pairMinimum.toString(),
        transaction: swapped.hash,
      },
      residual: {
        spyWei: finalSpy.toString(),
        pairWei: finalPair.toString(),
        markedUsdg: residualUsdg?.toString() ?? null,
        bpsOfTotalAssets: residualBps?.toString() ?? null,
        warning: residualWarning,
      },
      finalPoolTick: finalPoolState.tick,
      gasSpentWei: receiptGasTotal(transactions).toString(),
      finalEthWei: finalEth.toString(),
      transactions: transactions.filter(Boolean).map((item) => item.hash),
    }

    state.retiredPositions = [
      ...(state.retiredPositions || []),
      {
        ...sourcePositionRecord,
        status: 'migrated_empty',
        liquidity: '0',
        retiredAt: record.completedAt,
        migrationId: operationId,
        removalTransaction: removed.hash,
        burned: false,
      },
    ]
    state.satellites = (state.satellites || []).map((item) =>
      String(item.tokenId) === check.targetTokenId.toString()
        ? {
            ...item,
            status: 'promoted_to_main',
            liquidity: targetLiquidityFinal.toString(),
            promotedAt: record.completedAt,
            promotedByMigration: operationId,
          }
        : item,
    )
    state.position = {
      tokenId: check.targetTokenId.toString(),
      tickLower: SATELLITE_TICK_LOWER,
      tickUpper: SATELLITE_TICK_UPPER,
      liquidity: targetLiquidityFinal.toString(),
      mintBlock: check.targetRecord.mintBlock,
      mintTransaction: check.targetRecord.mintTransaction,
      promotedAt: record.completedAt,
      promotedByMigration: operationId,
    }
    state.policy = {
      ...(state.policy || {}),
      targetTickLower: SATELLITE_TICK_LOWER,
      targetTickUpper: SATELLITE_TICK_UPPER,
      primaryStrategy: 'narrow_grid_hold',
      earlyExitOutOfRange: false,
      autoExit: false,
    }
    state.migrations = [...(state.migrations || []), record]
    delete state.pendingMigration
    writeState(state)
    appendAudit('migration_complete', record)
    console.log(
      stringify({
        status: 'MIGRATION_COMPLETE',
        sourceNft: {
          tokenId: check.sourceTokenId,
          liquidity: sourceLiquidityFinal,
          burned: false,
        },
        activeNft: {
          tokenId: check.targetTokenId,
          tickLower: SATELLITE_TICK_LOWER,
          tickUpper: SATELLITE_TICK_UPPER,
          liquidityBefore: targetLiquidityBefore,
          liquidityAdded: increase.liquidity,
          liquidityAfter: targetLiquidityFinal,
          inRange: finalPoolState.tick >= SATELLITE_TICK_LOWER && finalPoolState.tick < SATELLITE_TICK_UPPER,
        },
        feesCompounded: {
          sourceAtPreflight: {
            spy: formatUnits(check.sourceFees.spyWei, 18),
            pair: formatUnits(check.sourceFees.pairWei, 18),
          },
          targetAtIncrease: {
            spy: formatUnits(increase.fees.spyWei, 18),
            pair: formatUnits(increase.fees.pairWei, 18),
          },
        },
        rebalance: {
          spySpent: formatUnits(actualSpySpentWei, 18),
          pairReceived: formatUnits(actualPairReceivedWei, 18),
        },
        lpUnderlying: {
          spy: formatUnits(underlyingSpyWei, 18),
          pair: formatUnits(underlyingPairWei, 18),
        },
        walletResidual: {
          spy: formatUnits(finalSpy, 18),
          pair: formatUnits(finalPair, 18),
          markedUsdg: residualUsdg === null ? null : formatUnits(residualUsdg, 6),
          bpsOfTotalAssets: residualBps,
          warning: residualWarning,
        },
        currentTick: finalPoolState.tick,
        remainingEth: formatEther(finalEth),
        gasSpentEth: formatEther(receiptGasTotal(transactions)),
        transactions: record.transactions,
      }),
    )
  } catch (error) {
    const latestState = readState()
    if (latestState?.pendingMigration?.id === operationId) {
      latestState.pendingMigration.lastErrorAt = new Date().toISOString()
      latestState.pendingMigration.lastError = error.shortMessage || error.message
      latestState.pendingMigration.completedTransactions = transactions.filter(Boolean).map((item) => item.hash)
      writeState(latestState)
    }
    appendAudit('migration_partial', {
      id: operationId,
      message: error.shortMessage || error.message,
      transactions: transactions.filter(Boolean).map((item) => item.hash),
    })
    throw error
  }
}

async function preflight({ requireFunding = false } = {}) {
  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const [balance, nonceLatest, noncePending, gasPrice, poolState, route] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    publicClient.getGasPrice(),
    getPoolState(),
    quoteBestEthToSpy(TOTAL_PRINCIPAL),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  const spyMinimum = bpsFloor(route.amountOut, SWAP_SLIPPAGE_BPS)
  const firstSwapData = buildV3SwapData(route.path, TOTAL_PRINCIPAL, spyMinimum)
  const firstSwapBudget = await transactionBudget(V3_ROUTER, firstSwapData, TOTAL_PRINCIPAL)
  const dynamicLifecycleReserve = gasPrice * 2_000_000n
  const requiredReserve = dynamicLifecycleReserve > MIN_GAS_RESERVE ? dynamicLifecycleReserve : MIN_GAS_RESERVE
  if (requiredReserve > MAX_LIFECYCLE_GAS_RESERVE) {
    throw new Error(
      `当前 Gas 过高：完整生命周期预留约 ${formatEther(requiredReserve)} ETH，超过 ${formatEther(MAX_LIFECYCLE_GAS_RESERVE)} ETH 安全上限`,
    )
  }
  const requiredBalance = TOTAL_PRINCIPAL + requiredReserve
  const report = {
    status: balance >= requiredBalance ? 'READY' : 'NEEDS_GAS_TOP_UP',
    wallet: WALLET,
    balanceEth: formatEther(balance),
    requiredBalanceEth: formatEther(requiredBalance),
    topUpNeededEth: formatEther(balance >= requiredBalance ? 0n : requiredBalance - balance),
    nonceLatest,
    noncePending,
    gasPriceGwei: (Number(gasPrice) / 1e9).toFixed(6),
    target: {
      poolId: POOL_ID,
      feePips: poolState.lpFee,
      tick: poolState.tick,
      liquidity: poolState.liquidity.toString(),
    },
    route: { fees: route.fees, expectedSpy: formatUnits(route.amountOut, 18), minimumSpy: formatUnits(spyMinimum, 18) },
    firstSwap: {
      gasEstimate: firstSwapBudget.estimatedGas.toString(),
      maxGasBudgetEth: formatEther(firstSwapBudget.budget),
    },
    policy: {
      perSideEth: '0.025',
      durationHours: 24,
      priceRange: '-30%/+30%',
      earlyExitOutOfRange: true,
      exitAsset: 'retain PAIR/SPY',
    },
  }
  console.log(stringify(report))
  appendAudit('preflight', report)
  if (requireFunding && balance < requiredBalance) {
    throw new Error(`余额不足以安全完成完整生命周期；还需 ${formatEther(requiredBalance - balance)} ETH`)
  }
  return { ...report, balance, requiredBalance, route, spyMinimum, firstSwapData, poolState }
}

function receiptGasTotal(results) {
  return results.filter(Boolean).reduce((sum, item) => sum + item.gasCost, 0n)
}

function parseMintTokenId(receipt) {
  const transferLog = receipt.logs.find((log) => {
    if (log.address.toLowerCase() !== POSITION_MANAGER.toLowerCase()) return false
    try {
      const parsed = decodeEventLog({ abi: POSITION_NFT_ABI, data: log.data, topics: log.topics })
      return (
        parsed.eventName === 'Transfer' &&
        parsed.args.from === '0x0000000000000000000000000000000000000000' &&
        parsed.args.to.toLowerCase() === WALLET.toLowerCase()
      )
    } catch {
      return false
    }
  })
  if (!transferLog) return null
  return decodeEventLog({ abi: POSITION_NFT_ABI, data: transferLog.data, topics: transferLog.topics }).args.id
}

function tokenNetFromReceipt(receipt, token) {
  let net = 0n
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue
    try {
      const parsed = decodeEventLog({ abi: TRANSFER_ABI, data: log.data, topics: log.topics })
      if (parsed.eventName !== 'Transfer') continue
      if (parsed.args.to.toLowerCase() === WALLET.toLowerCase()) net += parsed.args.value
      if (parsed.args.from.toLowerCase() === WALLET.toLowerCase()) net -= parsed.args.value
    } catch {
      // Ignore unrelated logs emitted by token wrappers/proxies.
    }
  }
  return net
}

async function enter() {
  const existing = readState()
  if (existing?.status === 'active') {
    console.log(
      stringify({
        status: 'ALREADY_ACTIVE',
        tokenId: existing.position.tokenId,
        enteredAt: existing.enteredAt,
        exitDueAt: existing.exitDueAt,
      }),
    )
    return
  }
  if (existing && existing.status !== 'exited') throw new Error(`已有未完成状态：${existing.status}`)
  const [partialSpy, partialPair] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  if (partialSpy > 0n || partialPair > 0n) {
    if (partialSpy > 0n && partialPair > 0n) return resumeMint()
    throw new Error('检测到单边部分建仓，禁止自动继续')
  }
  const check = await preflight({ requireFunding: true })
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  const transactions = []
  const [spyBefore, pairBefore] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  if (spyBefore !== 0n || pairBefore !== 0n) throw new Error('钱包已有 SPY/PAIR，无法保持本次本金归因；请先人工审计')

  transactions.push(
    await sendChecked(walletClient, {
      label: '1/6 用 0.05 ETH 买入 SPY',
      to: V3_ROUTER,
      data: check.firstSwapData,
      value: TOTAL_PRINCIPAL,
    }),
  )
  const spyAfterBuy = await publicClient.readContract({
    address: SPY,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [WALLET],
  })
  if (spyAfterBuy < check.spyMinimum) throw new Error('SPY 成交回读低于交易保护下限')
  const spyForPair = spyAfterBuy / 2n

  transactions.push(await approveErc20(walletClient, SPY, spyAfterBuy, '2/6 授权 SPY 给 Permit2'))
  transactions.push(
    await approvePermit2(walletClient, SPY, UNIVERSAL_ROUTER, spyForPair, '3/6 授权 Universal Router 使用半数 SPY'),
  )

  const pairQuote = await quoteSpyToPair(spyForPair)
  const pairMinimum = bpsFloor(pairQuote.amountOut, SWAP_SLIPPAGE_BPS)
  const swapDeadline = BigInt(nowSeconds() + 5 * 60)
  const v4Data = buildV4SwapData(spyForPair, pairMinimum, swapDeadline)
  transactions.push(
    await sendChecked(walletClient, { label: '4/6 半数 SPY 换入 PAIR', to: UNIVERSAL_ROUTER, data: v4Data }),
  )

  const [spyAfterPairBuy, pairAfterBuy] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  if (pairAfterBuy < pairMinimum) throw new Error('PAIR 成交回读低于交易保护下限')
  transactions.push(await approveErc20(walletClient, PAIR, pairAfterBuy, '5/6 授权 PAIR 给 Permit2'))

  const mint = await buildMint(account, spyAfterPairBuy, pairAfterBuy)
  const mintResult = await sendChecked(walletClient, {
    label: '6/6 铸造 PAIR/SPY V4 LP',
    to: POSITION_MANAGER,
    data: mint.data,
  })
  transactions.push(mintResult)
  const tokenId = parseMintTokenId(mintResult.receipt)
  if (tokenId === null) throw new Error(`LP mint 已成功但未解析到 NFT tokenId，请核对 ${mintResult.hash}`)
  const owner = await publicClient.readContract({
    address: POSITION_MANAGER,
    abi: POSITION_NFT_ABI,
    functionName: 'ownerOf',
    args: [tokenId],
  })
  const positionLiquidity = await publicClient.readContract({
    address: POSITION_MANAGER,
    abi: POSITION_NFT_ABI,
    functionName: 'getPositionLiquidity',
    args: [tokenId],
  })
  if (owner.toLowerCase() !== WALLET.toLowerCase() || positionLiquidity === 0n) throw new Error('LP NFT 链上回读不完整')
  const mintBlock = await publicClient.getBlock({ blockNumber: mintResult.receipt.blockNumber })
  const enteredAtSeconds = Number(mintBlock.timestamp)
  const finalEth = await publicClient.getBalance({ address: WALLET })
  const state = {
    schemaVersion: 1,
    name: 'PAIR LP 实盘一号',
    status: 'active',
    wallet: WALLET,
    chainId: CHAIN_ID,
    pool: { poolId: POOL_ID, ...poolKey },
    policy: {
      principalPerSideWei: PRINCIPAL_PER_SIDE.toString(),
      totalPrincipalWei: TOTAL_PRINCIPAL.toString(),
      durationSeconds: RUN_SECONDS,
      earlyExitOutOfRange: true,
      exitAsset: 'retain_tokens',
      swapSlippageBps: Number(SWAP_SLIPPAGE_BPS),
      mintSlippageBps: 100,
      exitSlippageBps: 200,
    },
    entry: {
      expectedSpyWei: check.route.amountOut.toString(),
      actualSpyAfterFirstSwapWei: spyAfterBuy.toString(),
      spyInputToPairWei: spyForPair.toString(),
      expectedPairWei: pairQuote.amountOut.toString(),
      actualSpyBeforeMintWei: spyAfterPairBuy.toString(),
      actualPairBeforeMintWei: pairAfterBuy.toString(),
      lpAmount0DesiredWei: mint.amount0Desired.toString(),
      lpAmount1DesiredWei: mint.amount1Desired.toString(),
      gasSpentWei: receiptGasTotal(transactions).toString(),
      finalEthWei: finalEth.toString(),
      transactions: transactions.filter(Boolean).map((item) => item.hash),
    },
    position: {
      tokenId: tokenId.toString(),
      tickLower: mint.tickLower,
      tickUpper: mint.tickUpper,
      liquidity: positionLiquidity.toString(),
      mintBlock: mintResult.receipt.blockNumber.toString(),
      mintTransaction: mintResult.hash,
    },
    enteredAt: new Date(enteredAtSeconds * 1_000).toISOString(),
    exitDueAt: new Date((enteredAtSeconds + RUN_SECONDS) * 1_000).toISOString(),
  }
  writeState(state)
  appendAudit('entry_complete', { tokenId, positionLiquidity, enteredAt: state.enteredAt, exitDueAt: state.exitDueAt })
  console.log(
    stringify({
      status: 'ACTIVE',
      tokenId,
      liquidity: positionLiquidity,
      tickLower: mint.tickLower,
      tickUpper: mint.tickUpper,
      enteredAt: state.enteredAt,
      exitDueAt: state.exitDueAt,
      gasSpentEth: formatEther(receiptGasTotal(transactions)),
      ethReserve: formatEther(finalEth),
    }),
  )
}

async function increasePreflight({ print = true } = {}) {
  const state = readState()
  if (!state || state.status !== 'active' || !state.position?.tokenId) throw new Error('没有可增加的活动 LP 头寸')
  if (state.pendingIncrease) throw new Error(`存在未结算的追加计划：${state.pendingIncrease.id}，禁止重复执行`)
  if (state.pendingSatellite) throw new Error(`存在未结算的卫星仓计划：${state.pendingSatellite.id}，禁止交叉执行`)
  if (state.pendingMigration) throw new Error(`存在未结算的迁移计划：${state.pendingMigration.id}，禁止交叉执行`)
  if (state.pendingMainRoll) throw new Error(`存在未结算的主仓迁移计划：${state.pendingMainRoll.id}，禁止交叉执行`)
  if (state.pendingCurrentBand)
    throw new Error(`存在未结算的当前热区仓计划：${state.pendingCurrentBand.id}，禁止交叉执行`)
  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const tokenId = BigInt(state.position.tokenId)
  const [nonceLatest, noncePending, owner, liquidity, poolState, ethBalance, spyBalance, pairBalance] =
    await Promise.all([
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
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
      getPoolState(),
      publicClient.getBalance({ address: WALLET }),
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`LP NFT 不在执行钱包：owner=${owner}`)
  if (liquidity === 0n) throw new Error('现有 LP 流动性为 0')
  const rangeBps =
    (BigInt(poolState.tick - state.position.tickLower) * 10_000n) /
    BigInt(state.position.tickUpper - state.position.tickLower)
  if (rangeBps < ADD_MIN_RANGE_BPS || rangeBps > ADD_MAX_RANGE_BPS) {
    throw new Error(`旧仓不再接近区间中部：tick=${poolState.tick}, rangeBps=${rangeBps}，禁止追价增加`)
  }
  const [{ ethInput, route, spyMark }, fees] = await Promise.all([
    quoteEthForTargetSpyUsdg(ADD_TARGET_USDG_PER_SIDE),
    getAccruedFees(tokenId, state.position.tickLower, state.position.tickUpper),
  ])
  const externalSpyWei = (ADD_TARGET_USDG_PER_SIDE * ADD_SPY_MARK_INPUT) / spyMark.amountOut
  const externalPairWei = (externalSpyWei * poolState.sqrtPriceX96 * poolState.sqrtPriceX96) / Q192
  const spyMinimum = bpsFloor(route.amountOut, SWAP_SLIPPAGE_BPS)
  if (spyBalance + spyMinimum < externalSpyWei) throw new Error('ETH→SPY 成交保护下限加现有余额不足 50U SPY 侧本金')
  if (pairBalance < externalPairWei) throw new Error('PAIR 余额不足 50U PAIR 侧本金')
  const pairReserveUsdg = ((pairBalance - externalPairWei) * ADD_TARGET_USDG_PER_SIDE) / externalPairWei
  if (pairReserveUsdg < ADD_MIN_PAIR_RESERVE_USDG) {
    throw new Error(`追加后 PAIR 现货储备不足 ${formatUnits(ADD_MIN_PAIR_RESERVE_USDG, 6)}U`)
  }
  const swapData = buildV3SwapData(route.path, ethInput, spyMinimum)
  const swapBudget = await transactionBudget(V3_ROUTER, swapData, ethInput)
  const requiredEth = ethInput + swapBudget.budget + MIN_GAS_RESERVE
  if (ethBalance < requiredEth)
    throw new Error(`ETH 不足：余额 ${formatEther(ethBalance)}，至少需要 ${formatEther(requiredEth)}`)
  const expectedSpyUsdg = (route.amountOut * spyMark.amountOut) / ADD_SPY_MARK_INPUT
  const feeUsdg =
    (fees.spyWei * spyMark.amountOut) / ADD_SPY_MARK_INPUT + (fees.pairWei * ADD_TARGET_USDG_PER_SIDE) / externalPairWei
  const report = {
    status: 'READY_TO_INCREASE_EXISTING_POSITION',
    wallet: WALLET,
    tokenId: tokenId.toString(),
    nonceLatest,
    noncePending,
    pool: {
      tick: poolState.tick,
      tickLower: state.position.tickLower,
      tickUpper: state.position.tickUpper,
      rangePositionPct: (Number(rangeBps) / 100).toFixed(2),
      liquidity: liquidity.toString(),
    },
    newPrincipal: {
      targetPerSideUsdg: formatUnits(ADD_TARGET_USDG_PER_SIDE, 6),
      spyWei: externalSpyWei.toString(),
      spy: formatUnits(externalSpyWei, 18),
      pairWei: externalPairWei.toString(),
      pair: formatUnits(externalPairWei, 18),
    },
    accruedFees: {
      spy: formatUnits(fees.spyWei, 18),
      pair: formatUnits(fees.pairWei, 18),
      markedUsdg: formatUnits(feeUsdg, 6),
    },
    spyPurchase: {
      ethInput: formatEther(ethInput),
      routeFees: route.fees,
      expectedSpy: formatUnits(route.amountOut, 18),
      expectedUsdg: formatUnits(expectedSpyUsdg, 6),
      minimumSpy: formatUnits(spyMinimum, 18),
      maxGasBudgetEth: formatEther(swapBudget.budget),
    },
    balances: {
      eth: formatEther(ethBalance),
      spy: formatUnits(spyBalance, 18),
      pair: formatUnits(pairBalance, 18),
      pairReserveAfterNominalAddUsdg: formatUnits(pairReserveUsdg, 6),
    },
    policy: {
      increaseExistingTokenId: true,
      compoundAccruedFees: true,
      createNewPosition: false,
      minimumEthReserve: formatEther(MIN_GAS_RESERVE),
    },
  }
  appendAudit('increase_preflight', report)
  if (print) console.log(stringify(report))
  return {
    state,
    tokenId,
    liquidity,
    poolState,
    ethInput,
    route,
    spyMinimum,
    swapData,
    externalSpyWei,
    externalPairWei,
    report,
  }
}

async function increasePosition() {
  const check = await increasePreflight({ print: true })
  const operationId = `increase-${new Date().toISOString().replace(/[-:.]/g, '')}`
  const state = check.state
  state.pendingIncrease = {
    id: operationId,
    status: 'planned',
    createdAt: new Date().toISOString(),
    targetUsdgPerSide: formatUnits(ADD_TARGET_USDG_PER_SIDE, 6),
    externalSpyWei: check.externalSpyWei.toString(),
    externalPairWei: check.externalPairWei.toString(),
  }
  writeState(state)
  appendAudit('increase_plan_created', state.pendingIncrease)

  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  const transactions = []
  const spyBuy = await sendChecked(walletClient, {
    label: `追加 1/2 用约 50U ETH 买入 SPY (${operationId})`,
    to: V3_ROUTER,
    data: check.swapData,
    value: check.ethInput,
    minimumBalanceAfter: MIN_GAS_RESERVE,
  })
  transactions.push(spyBuy)
  state.pendingIncrease.status = 'spy_bought'
  state.pendingIncrease.spyPurchaseTransaction = spyBuy.hash
  state.pendingIncrease.spyPurchaseGasWei = spyBuy.gasCost.toString()
  writeState(state)

  const [nonceLatest, noncePending, currentSpy, currentPair] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`SPY 买入后存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (currentSpy < check.externalSpyWei || currentPair < check.externalPairWei)
    throw new Error('SPY 买入后双边余额不足追加目标')

  transactions.push(await approveErc20(walletClient, SPY, currentSpy, `追加授权 SPY 给 Permit2 (${operationId})`))
  transactions.push(await approveErc20(walletClient, PAIR, currentPair, `追加授权 PAIR 给 Permit2 (${operationId})`))

  const increase = await buildIncrease(account, state, check.externalSpyWei, check.externalPairWei)
  const maximumExternalSpy =
    increase.amount0Max > increase.fees.spyWei ? increase.amount0Max - increase.fees.spyWei : 0n
  const maximumExternalPair =
    increase.amount1Max > increase.fees.pairWei ? increase.amount1Max - increase.fees.pairWei : 0n
  const [spyBefore, pairBefore, liquidityBefore] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [check.tokenId],
    }),
  ])
  if (spyBefore < maximumExternalSpy || pairBefore < maximumExternalPair) {
    throw new Error(
      `滑点上限所需余额不足：SPY max=${formatUnits(maximumExternalSpy, 18)}, PAIR max=${formatUnits(maximumExternalPair, 18)}`,
    )
  }
  const pairReserveUsdg = ((pairBefore - maximumExternalPair) * ADD_TARGET_USDG_PER_SIDE) / check.externalPairWei
  if (pairReserveUsdg < ADD_MIN_PAIR_RESERVE_USDG) throw new Error('滑点上限会侵占预留的 PAIR 现货仓')

  const added = await sendChecked(walletClient, {
    label: `追加 2/2 增加现有 LP 并复投手续费 (${operationId})`,
    to: POSITION_MANAGER,
    data: increase.data,
    minimumBalanceAfter: MIN_GAS_RESERVE,
  })
  transactions.push(added)
  const [spyAfter, pairAfter, liquidityAfter, ethAfter] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [check.tokenId],
    }),
    publicClient.getBalance({ address: WALLET }),
  ])
  if (liquidityAfter <= liquidityBefore)
    throw new Error(`追加回执成功但流动性未增加：before=${liquidityBefore}, after=${liquidityAfter}`)
  if (ethAfter < MIN_GAS_RESERVE) throw new Error(`追加后 ETH 储备低于 ${formatEther(MIN_GAS_RESERVE)}`)
  const record = {
    id: operationId,
    completedAt: new Date().toISOString(),
    targetUsdgPerSide: formatUnits(ADD_TARGET_USDG_PER_SIDE, 6),
    externalTargets: { spyWei: check.externalSpyWei.toString(), pairWei: check.externalPairWei.toString() },
    accruedFeesBeforeIncrease: { spyWei: increase.fees.spyWei.toString(), pairWei: increase.fees.pairWei.toString() },
    principalDesired: { spyWei: increase.amount0Desired.toString(), pairWei: increase.amount1Desired.toString() },
    walletNetSpent: { spyWei: (spyBefore - spyAfter).toString(), pairWei: (pairBefore - pairAfter).toString() },
    liquidityBefore: liquidityBefore.toString(),
    liquidityAfter: liquidityAfter.toString(),
    liquidityAdded: (liquidityAfter - liquidityBefore).toString(),
    ethAfterWei: ethAfter.toString(),
    gasSpentWei: receiptGasTotal(transactions).toString(),
    transactions: transactions.filter(Boolean).map((item) => item.hash),
  }
  state.increases = [...(state.increases || []), record]
  state.position.liquidity = liquidityAfter.toString()
  delete state.pendingIncrease
  writeState(state)
  appendAudit('increase_complete', record)
  console.log(
    stringify({
      status: 'INCREASED',
      tokenId: check.tokenId,
      liquidityBefore,
      liquidityAfter,
      liquidityAdded: liquidityAfter - liquidityBefore,
      liquidityIncreasePct: ((Number(liquidityAfter - liquidityBefore) / Number(liquidityBefore)) * 100).toFixed(4),
      walletNetSpentSpy: formatUnits(spyBefore - spyAfter, 18),
      walletNetSpentPair: formatUnits(pairBefore - pairAfter, 18),
      remainingEth: formatEther(ethAfter),
      remainingPair: formatUnits(pairAfter, 18),
      gasSpentEth: formatEther(receiptGasTotal(transactions)),
      transactions: record.transactions,
    }),
  )
}

async function resumeMint() {
  if (readState()) throw new Error('已有本地状态，禁止部分建仓续跑')
  const successful = readAuditEvents().filter((event) => event.event === 'receipt_success')
  const expectedLabels = [
    '1/6 用 0.05 ETH 买入 SPY',
    '2/6 授权 SPY 给 Permit2',
    '3/6 授权 Universal Router 使用半数 SPY',
    '4/6 半数 SPY 换入 PAIR',
    '5/6 授权 PAIR 给 Permit2',
  ]
  const latestByLabel = new Map(successful.map((event) => [event.label, event]))
  if (!expectedLabels.every((label) => latestByLabel.has(label)) || latestByLabel.has('6/6 铸造 PAIR/SPY V4 LP')) {
    throw new Error('部分建仓审计链不完整，禁止自动续跑')
  }
  const [nonceLatest, noncePending, spyBalance, pairBalance] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  if (nonceLatest !== noncePending || nonceLatest !== 5)
    throw new Error(`续跑 nonce 不匹配：latest=${nonceLatest}, pending=${noncePending}, expected=5`)
  if (spyBalance === 0n || pairBalance === 0n) throw new Error('续跑所需的双边代币余额不存在')
  const receipts = []
  for (const label of expectedLabels) {
    const event = latestByLabel.get(label)
    const receipt = await publicClient.getTransactionReceipt({ hash: event.hash })
    if (receipt.status !== 'success') throw new Error(`历史步骤回执不成功：${event.hash}`)
    receipts.push(receipt)
  }
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  const mint = await buildMint(account, spyBalance, pairBalance)
  const mintResult = await sendChecked(walletClient, {
    label: '6/6 铸造 PAIR/SPY V4 LP',
    to: POSITION_MANAGER,
    data: mint.data,
  })
  const tokenId = parseMintTokenId(mintResult.receipt)
  if (tokenId === null) throw new Error(`LP mint 已成功但未解析到 NFT tokenId，请核对 ${mintResult.hash}`)
  const [owner, positionLiquidity] = await Promise.all([
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
  if (owner.toLowerCase() !== WALLET.toLowerCase() || positionLiquidity === 0n) throw new Error('LP NFT 链上回读不完整')
  const mintBlock = await publicClient.getBlock({ blockNumber: mintResult.receipt.blockNumber })
  const enteredAtSeconds = Number(mintBlock.timestamp)
  const [finalEth, finalSpy, finalPair] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  const firstSwapSpy = tokenNetFromReceipt(receipts[0], SPY)
  const pairSwapSpy = -tokenNetFromReceipt(receipts[3], SPY)
  const pairSwapPair = tokenNetFromReceipt(receipts[3], PAIR)
  const historicalGas = successful
    .filter((event) => expectedLabels.includes(event.label))
    .reduce((sum, event) => sum + BigInt(event.gasCostWei), 0n)
  const state = {
    schemaVersion: 1,
    name: 'PAIR LP 实盘一号',
    status: 'active',
    wallet: WALLET,
    chainId: CHAIN_ID,
    pool: { poolId: POOL_ID, ...poolKey },
    policy: {
      principalPerSideWei: PRINCIPAL_PER_SIDE.toString(),
      totalPrincipalWei: TOTAL_PRINCIPAL.toString(),
      durationSeconds: RUN_SECONDS,
      earlyExitOutOfRange: true,
      exitAsset: 'retain_tokens',
      swapSlippageBps: Number(SWAP_SLIPPAGE_BPS),
      mintSlippageBps: 100,
      exitSlippageBps: 200,
    },
    entry: {
      actualSpyAfterFirstSwapWei: firstSwapSpy.toString(),
      spyInputToPairWei: pairSwapSpy.toString(),
      actualPairFromSwapWei: pairSwapPair.toString(),
      actualSpyBeforeMintWei: spyBalance.toString(),
      actualPairBeforeMintWei: pairBalance.toString(),
      lpAmount0DesiredWei: mint.amount0Desired.toString(),
      lpAmount1DesiredWei: mint.amount1Desired.toString(),
      gasSpentWei: (historicalGas + mintResult.gasCost).toString(),
      finalEthWei: finalEth.toString(),
      residualSpyWei: finalSpy.toString(),
      residualPairWei: finalPair.toString(),
      transactions: [...expectedLabels.map((label) => latestByLabel.get(label).hash), mintResult.hash],
    },
    position: {
      tokenId: tokenId.toString(),
      tickLower: mint.tickLower,
      tickUpper: mint.tickUpper,
      liquidity: positionLiquidity.toString(),
      mintBlock: mintResult.receipt.blockNumber.toString(),
      mintTransaction: mintResult.hash,
    },
    enteredAt: new Date(enteredAtSeconds * 1_000).toISOString(),
    exitDueAt: new Date((enteredAtSeconds + RUN_SECONDS) * 1_000).toISOString(),
  }
  writeState(state)
  appendAudit('entry_complete', {
    resumed: true,
    tokenId,
    positionLiquidity,
    enteredAt: state.enteredAt,
    exitDueAt: state.exitDueAt,
  })
  console.log(
    stringify({
      status: 'ACTIVE',
      resumed: true,
      tokenId,
      liquidity: positionLiquidity,
      tickLower: mint.tickLower,
      tickUpper: mint.tickUpper,
      enteredAt: state.enteredAt,
      exitDueAt: state.exitDueAt,
      gasSpentEth: formatEther(historicalGas + mintResult.gasCost),
      ethReserve: formatEther(finalEth),
      residualSpy: formatUnits(finalSpy, 18),
      residualPair: formatUnits(finalPair, 18),
    }),
  )
}

async function feeBandPreflight({ print = true } = {}) {
  const state = readState()
  if (!state || state.status !== 'active' || !state.position?.tokenId)
    throw new Error('没有可领取手续费的活动 PAIR/SPY LP')
  if (state.pendingIncrease) throw new Error(`存在未结算的追加计划：${state.pendingIncrease.id}`)
  if (state.pendingSatellite) throw new Error(`存在未结算的卫星仓计划：${state.pendingSatellite.id}`)
  if (state.pendingMigration) throw new Error(`存在未结算的迁移计划：${state.pendingMigration.id}`)
  if (state.pendingUpperRange) throw new Error(`存在未结算的新区间计划：${state.pendingUpperRange.id}`)
  if (state.pendingFeeBand) throw new Error(`存在未结算的手续费新区间计划：${state.pendingFeeBand.id}`)
  if (state.pendingMainRoll) throw new Error(`存在未结算的主仓迁移计划：${state.pendingMainRoll.id}`)
  if (state.pendingCurrentBand) throw new Error(`存在未结算的当前热区仓计划：${state.pendingCurrentBand.id}`)

  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const positionRecords = activePairPositionRecords(state)
  if (positionRecords.length < 1) throw new Error('本地账本没有活动 LP 头寸')

  const [
    blockNumber,
    nonceLatest,
    noncePending,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    gasPrice,
    spyMark,
    positionReads,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    getPoolState(),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getGasPrice(),
    quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT),
    Promise.all(
      positionRecords.map(async (record) => {
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
          getAccruedFees(tokenId, record.tickLower, record.tickUpper),
        ])
        return { record, tokenId, owner, liquidity, fees }
      }),
    ),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)

  for (const item of positionReads) {
    if (item.owner.toLowerCase() !== WALLET.toLowerCase())
      throw new Error(`LP NFT ${item.tokenId} 不在执行钱包：owner=${item.owner}`)
    if (item.liquidity === 0n) throw new Error(`LP NFT ${item.tokenId} 流动性为 0`)
    if (item.liquidity !== BigInt(item.record.liquidity)) {
      throw new Error(
        `LP NFT ${item.tokenId} 流动性与本地账本不一致：chain=${item.liquidity}, local=${item.record.liquidity}`,
      )
    }
    if (item.fees.liquidity !== item.liquidity) throw new Error(`LP NFT ${item.tokenId} 手续费状态流动性不一致`)
  }

  const band = feeBandTicksAndPrices(spyMark)
  const duplicate = positionRecords.find(
    (record) => record.tickLower === band.tickLower && record.tickUpper === band.tickUpper,
  )
  if (duplicate) throw new Error(`相同区间已有活动头寸 tokenId=${duplicate.tokenId}，禁止重复建仓`)
  if (poolState.tick < band.tickLower || poolState.tick >= band.tickUpper) {
    throw new Error(`当前 tick=${poolState.tick} 不在目标区间 [${band.tickLower},${band.tickUpper})`)
  }
  const rangePositionBps = customRangePositionBps(poolState.tick, band.tickLower, band.tickUpper)
  if (rangePositionBps < 2_000n || rangePositionBps > 8_000n) {
    throw new Error(`当前价格距目标区间边界过近：rangeBps=${rangePositionBps}`)
  }

  const accruedSpyWei = positionReads.reduce((sum, item) => sum + item.fees.spyWei, 0n)
  const accruedPairWei = positionReads.reduce((sum, item) => sum + item.fees.pairWei, 0n)
  if (accruedSpyWei === 0n && accruedPairWei === 0n) throw new Error('活动 LP 当前没有可领取手续费')
  const rebalance = await solveCustomRangeRebalance(
    accruedSpyWei,
    accruedPairWei,
    poolState,
    band.tickLower,
    band.tickUpper,
  )
  const feeValue = tokenAmountsUsdg(accruedSpyWei, accruedPairWei, poolState, spyMark)

  const collectBudgets = []
  for (const item of positionReads) {
    const collect = buildPositionCollect(item.record, item.liquidity, poolState)
    const budget = await transactionBudget(POSITION_MANAGER, collect.data)
    collectBudgets.push({ tokenId: item.tokenId, collect, budget })
  }
  const collectGasBudget = collectBudgets.reduce((sum, item) => sum + item.budget.budget, 0n)
  const remainingGasBudget = (gasPrice * 1_800_000n * 125n) / 100n
  const requiredEth = FEE_BAND_MIN_ETH_RESERVE + collectGasBudget + remainingGasBudget
  if (ethBalance < requiredEth) {
    throw new Error(`ETH Gas 储备不足：余额=${formatEther(ethBalance)}，保守需要=${formatEther(requiredEth)}`)
  }

  const currentPairPriceUsdg = band.spyPriceUsdg / Math.pow(1.0001, poolState.tick)
  const report = {
    status: 'READY_TO_COLLECT_AND_CREATE_FEE_BAND',
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    pool: {
      currentTick: poolState.tick,
      currentPairPriceUsdg: currentPairPriceUsdg.toFixed(8),
      spyPriceUsdg: band.spyPriceUsdg.toFixed(6),
      requestedPairPriceRangeUsdg: {
        low: FEE_BAND_PAIR_PRICE_LOW_USDG.toFixed(8),
        high: FEE_BAND_PAIR_PRICE_HIGH_USDG.toFixed(8),
      },
      executableTickRange: { tickLower: band.tickLower, tickUpper: band.tickUpper },
      actualPairPriceRangeUsdg: {
        low: band.actualPriceLowUsdg.toFixed(8),
        high: band.actualPriceHighUsdg.toFixed(8),
      },
      rangePositionPct: (Number(rangePositionBps) / 100).toFixed(2),
    },
    positionsToCollect: positionReads.map((item) => ({
      role: item.record.role,
      tokenId: item.tokenId.toString(),
      tickLower: item.record.tickLower,
      tickUpper: item.record.tickUpper,
      liquidity: item.liquidity.toString(),
      accruedFees: { spy: formatUnits(item.fees.spyWei, 18), pair: formatUnits(item.fees.pairWei, 18) },
      invariant: 'collect fees only; liquidity unchanged',
    })),
    projectedFeeAssets: {
      spy: formatUnits(accruedSpyWei, 18),
      pair: formatUnits(accruedPairWei, 18),
      markedUsdg: formatUnits(feeValue.totalUsdg, 6),
    },
    rebalance: {
      direction: rebalance.direction,
      input: formatUnits(rebalance.amountIn, 18),
      quotedOutput: formatUnits(rebalance.amountOut, 18),
      expectedPostSwapSpy: formatUnits(rebalance.expectedSpyWei, 18),
      expectedPostSwapPair: formatUnits(rebalance.expectedPairWei, 18),
      targetValueSplitPct: {
        spy: (Number(rebalance.targetSpyValueBps) / 100).toFixed(2),
        pair: (Number(rebalance.targetPairValueBps) / 100).toFixed(2),
      },
      slippageBps: Number(SWAP_SLIPPAGE_BPS),
    },
    walletBaselineExcludedFromMint: {
      spy: formatUnits(spyBalance, 18),
      pair: formatUnits(pairBalance, 18),
    },
    gas: {
      ethBalance: formatEther(ethBalance),
      collectMaxBudgetEth: formatEther(collectGasBudget),
      conservativeRequiredEth: formatEther(requiredEth),
      retainedMinimumEth: formatEther(FEE_BAND_MIN_ETH_RESERVE),
    },
    policy: {
      collectAllActivePositionFees: true,
      modifyExistingLiquidity: false,
      mintOnlyFromCollectedFeeBalanceDeltas: true,
      preservePreExistingWalletSpyAndPair: true,
      preserveWalletEthExceptGas: true,
      autoExit: false,
    },
  }
  appendAudit('fee_band_preflight', report)
  if (print) console.log(stringify(report))
  return {
    state,
    positionReads,
    blockNumber,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    spyMark,
    band,
    accruedSpyWei,
    accruedPairWei,
    rebalance,
    report,
  }
}

function rememberFeeBandTransaction(state, pending, result) {
  if (!result) return
  pending.transactions = [...new Set([...(pending.transactions || []), result.hash])]
  writeState(state)
}

async function confirmedFeeBandTransactions(pending) {
  const results = []
  for (const hash of [...new Set(pending.transactions || [])]) {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`手续费新区间历史交易不是 success：${hash}`)
    results.push({ hash, receipt, gasCost: receipt.gasUsed * receipt.effectiveGasPrice })
  }
  return results
}

async function readFeeBandPositionInvariants(pending) {
  return Promise.all(
    pending.positions.map(async (item) => {
      const tokenId = BigInt(item.tokenId)
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
      if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`原 LP NFT ${tokenId} 不在执行钱包`)
      if (liquidity !== BigInt(item.liquidity)) throw new Error(`原 LP NFT ${tokenId} 流动性不变量被破坏`)
      return { tokenId, owner, liquidity }
    }),
  )
}

async function finalizeFeeBand(state, pending) {
  if (!pending.mintTransaction || !pending.mintPlan) throw new Error('手续费新区间尚无可结算的 mint 交易')
  const mintReceipt = await publicClient.getTransactionReceipt({ hash: pending.mintTransaction })
  if (mintReceipt.status !== 'success')
    throw new Error(`手续费新区间 mint 回执不是 success：${pending.mintTransaction}`)
  const newTokenId = parseMintTokenId(mintReceipt)
  if (newTokenId === null) throw new Error(`手续费新区间 mint 成功但未解析到 NFT tokenId：${pending.mintTransaction}`)
  const [newOwner, newLiquidity, finalEth, finalSpy, finalPair, finalPoolState, invariants] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [newTokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [newTokenId],
    }),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
    readFeeBandPositionInvariants(pending),
  ])
  if (newOwner.toLowerCase() !== WALLET.toLowerCase() || newLiquidity === 0n)
    throw new Error('手续费新区间 NFT 链上读回不完整')
  if (newLiquidity !== BigInt(pending.mintPlan.liquidity)) {
    throw new Error(`手续费新区间流动性与计划不一致：chain=${newLiquidity}, plan=${pending.mintPlan.liquidity}`)
  }
  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  if (finalSpy < baselineSpy || finalPair < baselinePair) {
    throw new Error(`手续费新区间动用了钱包既有代币：final SPY/PAIR=${finalSpy}/${finalPair}`)
  }
  if (finalEth < FEE_BAND_MIN_ETH_RESERVE) throw new Error(`建仓后 ETH 低于 0.02 储备：${formatEther(finalEth)}`)

  const finalPosition = new Position({
    pool: makePool(finalPoolState),
    liquidity: newLiquidity.toString(),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
  })
  const underlyingSpyWei = asBigInt(finalPosition.amount0.quotient)
  const underlyingPairWei = asBigInt(finalPosition.amount1.quotient)
  const residualSpyWei = finalSpy - baselineSpy
  const residualPairWei = finalPair - baselinePair
  let priceSnapshot = null
  let marked = null
  try {
    const finalSpyMark = await quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT)
    const band = feeBandTicksAndPrices(finalSpyMark)
    const positionValue = tokenAmountsUsdg(underlyingSpyWei, underlyingPairWei, finalPoolState, finalSpyMark)
    const residualValue = tokenAmountsUsdg(residualSpyWei, residualPairWei, finalPoolState, finalSpyMark)
    const totalValue = positionValue.totalUsdg + residualValue.totalUsdg
    const residualBps = totalValue === 0n ? 0n : (residualValue.totalUsdg * 10_000n) / totalValue
    priceSnapshot = {
      spyPriceUsdg: band.spyPriceUsdg.toFixed(6),
      actualPairPriceLowUsdg: (band.spyPriceUsdg / Math.pow(1.0001, pending.tickUpper)).toFixed(8),
      actualPairPriceHighUsdg: (band.spyPriceUsdg / Math.pow(1.0001, pending.tickLower)).toFixed(8),
      currentPairPriceUsdg: (band.spyPriceUsdg / Math.pow(1.0001, finalPoolState.tick)).toFixed(8),
    }
    marked = {
      positionUsdg: positionValue.totalUsdg.toString(),
      residualUsdg: residualValue.totalUsdg.toString(),
      residualBps: residualBps.toString(),
      warning:
        residualBps > FEE_BAND_MAX_RESIDUAL_BPS
          ? `手续费残余约占 ${Number(residualBps) / 100}%，高于 ${Number(FEE_BAND_MAX_RESIDUAL_BPS) / 100}% 目标`
          : null,
    }
  } catch (error) {
    marked = { warning: `最终估值读取失败：${error.shortMessage || error.message}` }
  }
  const transactions = await confirmedFeeBandTransactions(pending)
  const mintSpySpentWei = BigInt(pending.mintPlan.spyBeforeMintWei) - finalSpy
  const mintPairSpentWei = BigInt(pending.mintPlan.pairBeforeMintWei) - finalPair
  const record = {
    id: pending.id,
    status: 'active',
    completedAt: new Date().toISOString(),
    tokenId: newTokenId.toString(),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
    liquidity: newLiquidity.toString(),
    source: 'fees collected from all active PAIR/SPY positions only; pre-existing wallet SPY/PAIR excluded',
    requestedPairPriceRangeUsdg: pending.requestedPairPriceRangeUsdg,
    priceSnapshot,
    policy: {
      mode: 'grid_hold_out_of_range',
      autoExit: false,
      preservePreExistingWalletTokens: true,
      minimumFinalEthWei: FEE_BAND_MIN_ETH_RESERVE.toString(),
    },
    sourcePositionInvariants: invariants.map((item) => ({
      tokenId: item.tokenId.toString(),
      liquidityAfter: item.liquidity.toString(),
    })),
    collectedFees: {
      spyWei: pending.collectedSpyWei,
      pairWei: pending.collectedPairWei,
      positions: pending.collections,
    },
    rebalance: pending.rebalance,
    rebalanceHistory: pending.rebalanceHistory || [],
    minted: {
      desiredSpyWei: pending.mintPlan.desiredSpyWei,
      desiredPairWei: pending.mintPlan.desiredPairWei,
      walletSpentSpyWei: mintSpySpentWei.toString(),
      walletSpentPairWei: mintPairSpentWei.toString(),
      underlyingSpyWei: underlyingSpyWei.toString(),
      underlyingPairWei: underlyingPairWei.toString(),
    },
    residualFromCollectedFees: {
      spyWei: residualSpyWei.toString(),
      pairWei: residualPairWei.toString(),
      ...marked,
    },
    excludedWalletBaseline: { spyWei: pending.baselineSpyWei, pairWei: pending.baselinePairWei },
    gasSpentWei: receiptGasTotal(transactions).toString(),
    finalEthWei: finalEth.toString(),
    transactions: pending.transactions,
    mintBlock: mintReceipt.blockNumber.toString(),
    mintTransaction: pending.mintTransaction,
  }
  state.satellites = [...(state.satellites || []), record]
  delete state.pendingFeeBand
  writeState(state)
  appendAudit('fee_band_complete', record)
  console.log(
    stringify({
      status: 'FEE_BAND_ACTIVE',
      tokenId: newTokenId,
      liquidity: newLiquidity,
      tickLower: record.tickLower,
      tickUpper: record.tickUpper,
      finalTick: finalPoolState.tick,
      priceSnapshot,
      collectedFees: {
        spy: formatUnits(BigInt(record.collectedFees.spyWei), 18),
        pair: formatUnits(BigInt(record.collectedFees.pairWei), 18),
      },
      rebalance: record.rebalance,
      lpUnderlying: { spy: formatUnits(underlyingSpyWei, 18), pair: formatUnits(underlyingPairWei, 18) },
      feeResidual: { spy: formatUnits(residualSpyWei, 18), pair: formatUnits(residualPairWei, 18), marked },
      originalPositionsLiquidityUnchanged: true,
      gasSpentEth: formatEther(BigInt(record.gasSpentWei)),
      finalEth: formatEther(finalEth),
      transactions: record.transactions,
    }),
  )
  return record
}

async function continueFeeBand(state, pending) {
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  await confirmedFeeBandTransactions(pending)
  const [nonceLatest, noncePending] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`执行前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  await readFeeBandPositionInvariants(pending)

  if (pending.mintTransaction) return finalizeFeeBand(state, pending)

  for (const item of pending.positions) {
    if ((pending.collections || []).some((entry) => String(entry.tokenId) === String(item.tokenId))) continue
    const [spyBefore, pairBefore, poolState, liquidityBefore] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      getPoolState(),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(item.tokenId)],
      }),
    ])
    if (liquidityBefore !== BigInt(item.liquidity)) throw new Error(`领取前 NFT ${item.tokenId} 流动性变化`)
    const collect = buildPositionCollect(item, liquidityBefore, poolState)
    const result = await sendChecked(walletClient, {
      label: `手续费新区间领取 NFT ${item.tokenId} (${pending.id})`,
      to: POSITION_MANAGER,
      data: collect.data,
      minimumBalanceAfter: FEE_BAND_MIN_ETH_RESERVE,
    })
    rememberFeeBandTransaction(state, pending, result)
    const [spyAfter, pairAfter, liquidityAfter] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(item.tokenId)],
      }),
    ])
    if (spyAfter < spyBefore || pairAfter < pairBefore) throw new Error(`领取 NFT ${item.tokenId} 后余额异常`)
    if (liquidityAfter !== liquidityBefore) throw new Error(`领取 NFT ${item.tokenId} 后原流动性发生变化`)
    pending.collections = [
      ...(pending.collections || []),
      {
        tokenId: String(item.tokenId),
        transaction: result.hash,
        spyWei: (spyAfter - spyBefore).toString(),
        pairWei: (pairAfter - pairBefore).toString(),
      },
    ]
    pending.status = `fees_collected_${pending.collections.length}_of_${pending.positions.length}`
    writeState(state)
  }

  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  let [walletSpy, walletPair] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  if (walletSpy < baselineSpy || walletPair < baselinePair) throw new Error('领取后钱包余额低于排除基线')
  if (!pending.collectedSpyWei || !pending.collectedPairWei) {
    pending.collectedSpyWei = (walletSpy - baselineSpy).toString()
    pending.collectedPairWei = (walletPair - baselinePair).toString()
    if (BigInt(pending.collectedSpyWei) === 0n && BigInt(pending.collectedPairWei) === 0n)
      throw new Error('领取交易成功但未收到手续费')
    pending.status = 'fees_collected'
    writeState(state)
  }

  if (!pending.rebalanceComplete) {
    const poolState = await getPoolState()
    if (poolState.tick < pending.tickLower || poolState.tick >= pending.tickUpper) {
      throw new Error(`配平前价格离开目标区间：tick=${poolState.tick}`)
    }
    const availableSpy = walletSpy - baselineSpy
    const availablePair = walletPair - baselinePair
    const plan = await solveCustomRangeRebalance(
      availableSpy,
      availablePair,
      poolState,
      pending.tickLower,
      pending.tickUpper,
    )
    if (plan.direction === 'NONE') {
      pending.rebalance = { direction: 'NONE', inputWei: '0', outputWei: '0', transaction: null }
      pending.rebalanceComplete = true
      pending.status = 'rebalanced'
      writeState(state)
    } else {
      const inputToken = plan.zeroForOne ? SPY : PAIR
      const inputSymbol = plan.zeroForOne ? 'SPY' : 'PAIR'
      const outputSymbol = plan.zeroForOne ? 'PAIR' : 'SPY'
      const erc20Approval = await approveErc20(
        walletClient,
        inputToken,
        plan.amountIn,
        `手续费新区间授权 ${inputSymbol} 给 Permit2 (${pending.id})`,
        FEE_BAND_MIN_ETH_RESERVE,
      )
      rememberFeeBandTransaction(state, pending, erc20Approval)
      const routerApproval = await approvePermit2(
        walletClient,
        inputToken,
        UNIVERSAL_ROUTER,
        plan.amountIn,
        `手续费新区间授权路由使用 ${inputSymbol} (${pending.id})`,
        FEE_BAND_MIN_ETH_RESERVE,
      )
      rememberFeeBandTransaction(state, pending, routerApproval)
      const liveQuote = await quotePairPoolSwap(plan.amountIn, plan.zeroForOne)
      const outputMinimum = bpsFloor(liveQuote.amountOut, SWAP_SLIPPAGE_BPS)
      const swapData = buildV4SwapData(plan.amountIn, outputMinimum, BigInt(nowSeconds() + 5 * 60), plan.zeroForOne)
      const [spyBeforeSwap, pairBeforeSwap] = await Promise.all([
        publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      ])
      const swapped = await sendChecked(walletClient, {
        label: `手续费新区间配平 ${inputSymbol}→${outputSymbol} (${pending.id})`,
        to: UNIVERSAL_ROUTER,
        data: swapData,
        minimumBalanceAfter: FEE_BAND_MIN_ETH_RESERVE,
      })
      rememberFeeBandTransaction(state, pending, swapped)
      const [spyAfterSwap, pairAfterSwap] = await Promise.all([
        publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      ])
      const actualInput = plan.zeroForOne ? spyBeforeSwap - spyAfterSwap : pairBeforeSwap - pairAfterSwap
      const actualOutput = plan.zeroForOne ? pairAfterSwap - pairBeforeSwap : spyAfterSwap - spyBeforeSwap
      if (actualInput !== plan.amountIn) throw new Error(`配平实际 ${inputSymbol} 支出异常：${actualInput}`)
      if (actualOutput < outputMinimum) throw new Error(`配平实际 ${outputSymbol} 收入低于滑点保护`)
      if (spyAfterSwap < baselineSpy || pairAfterSwap < baselinePair) throw new Error('配平动用了钱包既有代币')
      pending.rebalance = {
        direction: plan.direction,
        inputWei: actualInput.toString(),
        outputWei: actualOutput.toString(),
        minimumOutputWei: outputMinimum.toString(),
        transaction: swapped.hash,
      }
      pending.rebalanceComplete = true
      pending.status = 'rebalanced'
      writeState(state)
      walletSpy = spyAfterSwap
      walletPair = pairAfterSwap
    }
  }

  await readFeeBandPositionInvariants(pending)
  const [poolStateBeforeMint, spyBeforeMint, pairBeforeMint] = await Promise.all([
    getPoolState(),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  if (poolStateBeforeMint.tick < pending.tickLower || poolStateBeforeMint.tick >= pending.tickUpper) {
    throw new Error(`铸造前价格离开目标区间：tick=${poolStateBeforeMint.tick}`)
  }
  if (spyBeforeMint < baselineSpy || pairBeforeMint < baselinePair) throw new Error('铸造前钱包余额低于排除基线')
  const availableSpy = spyBeforeMint - baselineSpy
  const availablePair = pairBeforeMint - baselinePair
  const spyApproval = await approveErc20(
    walletClient,
    SPY,
    availableSpy,
    `手续费新区间确认 SPY Permit2 授权 (${pending.id})`,
    FEE_BAND_MIN_ETH_RESERVE,
  )
  rememberFeeBandTransaction(state, pending, spyApproval)
  const pairApproval = await approveErc20(
    walletClient,
    PAIR,
    availablePair,
    `手续费新区间确认 PAIR Permit2 授权 (${pending.id})`,
    FEE_BAND_MIN_ETH_RESERVE,
  )
  rememberFeeBandTransaction(state, pending, pairApproval)
  const mint = await buildCustomRangeMint(account, availableSpy, availablePair, pending.tickLower, pending.tickUpper, {
    minimumRangePositionBps: 0n,
    maximumRangePositionBps: 10_000n,
  })
  if (mint.amount0Max > availableSpy || mint.amount1Max > availablePair)
    throw new Error('手续费新区间滑点上限超过本次手续费余额')
  pending.mintPlan = {
    liquidity: mint.liquidity.toString(),
    desiredSpyWei: mint.amount0Desired.toString(),
    desiredPairWei: mint.amount1Desired.toString(),
    maxSpyWei: mint.amount0Max.toString(),
    maxPairWei: mint.amount1Max.toString(),
    spyBeforeMintWei: spyBeforeMint.toString(),
    pairBeforeMintWei: pairBeforeMint.toString(),
  }
  pending.status = 'mint_prepared'
  writeState(state)
  const minted = await sendChecked(walletClient, {
    label: `手续费新区间铸造 PAIR/SPY LP (${pending.id})`,
    to: POSITION_MANAGER,
    data: mint.data,
    minimumBalanceAfter: FEE_BAND_MIN_ETH_RESERVE,
  })
  rememberFeeBandTransaction(state, pending, minted)
  pending.mintTransaction = minted.hash
  pending.status = 'mint_confirmed'
  writeState(state)
  return finalizeFeeBand(state, pending)
}

function markFeeBandPartial(operationId, error) {
  const latestState = readState()
  if (!latestState?.pendingFeeBand || latestState.pendingFeeBand.id !== operationId) return
  const pending = latestState.pendingFeeBand
  if (!(pending.transactions || []).length) {
    delete latestState.pendingFeeBand
  } else {
    pending.status = pending.mintTransaction ? 'mint_confirmed_needs_readback' : 'partial'
    pending.lastErrorAt = new Date().toISOString()
    pending.lastError = error.shortMessage || error.message
  }
  writeState(latestState)
  appendAudit('fee_band_partial', {
    id: operationId,
    status: pending.status,
    message: error.shortMessage || error.message,
    transactions: pending.transactions || [],
  })
}

async function feeBandEnter() {
  const check = await feeBandPreflight({ print: true })
  const operationId = `fee-band-${new Date().toISOString().replace(/[-:.]/g, '')}`
  const state = check.state
  state.pendingFeeBand = {
    id: operationId,
    status: 'planned',
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    tickLower: check.band.tickLower,
    tickUpper: check.band.tickUpper,
    requestedPairPriceRangeUsdg: {
      low: FEE_BAND_PAIR_PRICE_LOW_USDG.toString(),
      high: FEE_BAND_PAIR_PRICE_HIGH_USDG.toString(),
    },
    baselineEthWei: check.ethBalance.toString(),
    baselineSpyWei: check.spyBalance.toString(),
    baselinePairWei: check.pairBalance.toString(),
    positions: check.positionReads.map((item) => ({
      role: item.record.role,
      tokenId: item.tokenId.toString(),
      tickLower: item.record.tickLower,
      tickUpper: item.record.tickUpper,
      liquidity: item.liquidity.toString(),
      estimatedFeeSpyWei: item.fees.spyWei.toString(),
      estimatedFeePairWei: item.fees.pairWei.toString(),
    })),
    collections: [],
    transactions: [],
  }
  writeState(state)
  appendAudit('fee_band_plan_created', state.pendingFeeBand)
  try {
    const [nonceLatest, noncePending, spyBefore, pairBefore] = await Promise.all([
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    ])
    if (nonceLatest !== noncePending)
      throw new Error(`广播前出现 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
    if (spyBefore !== check.spyBalance || pairBefore !== check.pairBalance)
      throw new Error('广播前钱包代币余额发生变化')
    return await continueFeeBand(state, state.pendingFeeBand)
  } catch (error) {
    markFeeBandPartial(operationId, error)
    throw error
  }
}

async function feeBandResume() {
  const state = readState()
  const pending = state?.pendingFeeBand
  if (!state || state.status !== 'active' || !pending) throw new Error('没有可恢复的手续费新区间计划')
  try {
    return await continueFeeBand(state, pending)
  } catch (error) {
    markFeeBandPartial(pending.id, error)
    throw error
  }
}

async function upperRangePreflight({ print = true } = {}) {
  const state = readState()
  if (!state || state.status !== 'active' || !state.position?.tokenId) throw new Error('没有可保护的活动主 LP 头寸')
  if (state.pendingIncrease) throw new Error(`存在未结算的追加计划：${state.pendingIncrease.id}`)
  if (state.pendingSatellite) throw new Error(`存在未结算的卫星仓计划：${state.pendingSatellite.id}`)
  if (state.pendingMigration) throw new Error(`存在未结算的迁移计划：${state.pendingMigration.id}`)
  if (state.pendingUpperRange) throw new Error(`存在未结算的新区间计划：${state.pendingUpperRange.id}`)
  if (state.pendingMainRoll) throw new Error(`存在未结算的主仓迁移计划：${state.pendingMainRoll.id}`)
  if (state.pendingCurrentBand) throw new Error(`存在未结算的当前热区仓计划：${state.pendingCurrentBand.id}`)
  const duplicate = (state.satellites || []).find(
    (item) => item.status === 'active' && item.tickLower === UPPER_TICK_LOWER && item.tickUpper === UPPER_TICK_UPPER,
  )
  if (duplicate) throw new Error(`相同新区间已有活动头寸 tokenId=${duplicate.tokenId}，禁止重复建仓`)

  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const mainTokenId = BigInt(state.position.tokenId)
  const [
    blockNumber,
    nonceLatest,
    noncePending,
    mainOwner,
    mainLiquidity,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    gasPrice,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [mainTokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [mainTokenId],
    }),
    getPoolState(),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getGasPrice(),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (mainOwner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`主 LP NFT 不在执行钱包：owner=${mainOwner}`)
  if (mainLiquidity === 0n || mainLiquidity !== BigInt(state.position.liquidity)) {
    throw new Error(`主 LP 流动性不变量不成立：chain=${mainLiquidity}, local=${state.position.liquidity}`)
  }
  if (pairBalance === 0n) throw new Error('钱包没有可投入的 PAIR')
  if (poolState.tick < UPPER_TICK_LOWER || poolState.tick >= UPPER_TICK_UPPER) {
    throw new Error(`当前 tick=${poolState.tick} 不在新区间 [${UPPER_TICK_LOWER},${UPPER_TICK_UPPER})`)
  }
  const rangePositionBps = customRangePositionBps(poolState.tick, UPPER_TICK_LOWER, UPPER_TICK_UPPER)
  if (rangePositionBps < 2_000n || rangePositionBps > 8_000n) {
    throw new Error(`当前价格距新区间边界过近：rangeBps=${rangePositionBps}`)
  }

  const unit = customRangeUnitAmounts(poolState, UPPER_TICK_LOWER, UPPER_TICK_UPPER)
  const requiredSpyForAllPair = (pairBalance * unit.spyWei) / unit.pairWei
  const bufferedSpyTarget = (requiredSpyForAllPair * (10_000n + UPPER_SPY_BUFFER_BPS)) / 10_000n
  const spyShortfall = bufferedSpyTarget > spyBalance ? bufferedSpyTarget - spyBalance : 0n
  const route = await quoteEthForSpyTarget(spyShortfall)
  if (route.amountIn === 0n)
    throw new Error('钱包 SPY 已足够，但本次流程要求存在明确的 ETH→SPY 输入；已停止以避免错误归因')
  const spyMinimum = bpsFloor(route.amountOut, SWAP_SLIPPAGE_BPS)
  const swapData = buildV3SwapData(route.path, route.amountIn, spyMinimum)
  const swapBudget = await transactionBudget(V3_ROUTER, swapData, route.amountIn)
  const conservativeRemainingGas = gasPrice * 1_200_000n
  const requiredEth = route.amountIn + swapBudget.budget + conservativeRemainingGas + UPPER_MIN_ETH_RESERVE
  if (ethBalance < requiredEth) {
    throw new Error(
      `ETH 不足以安全买入 SPY 并铸造：余额=${formatEther(ethBalance)}，保守需要=${formatEther(requiredEth)}`,
    )
  }

  const pairDownPct = (Math.pow(1.0001, poolState.tick - UPPER_TICK_UPPER) - 1) * 100
  const pairUpPct = (Math.pow(1.0001, poolState.tick - UPPER_TICK_LOWER) - 1) * 100
  const report = {
    status: 'READY_TO_CREATE_UPPER_RANGE',
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    mainPositionInvariant: { tokenId: mainTokenId, liquidity: mainLiquidity },
    pool: {
      currentTick: poolState.tick,
      tickLower: UPPER_TICK_LOWER,
      tickUpper: UPPER_TICK_UPPER,
      rangePositionPct: (Number(rangePositionBps) / 100).toFixed(2),
      pairDownsidePct: pairDownPct.toFixed(2),
      pairUpsidePct: pairUpPct.toFixed(2),
    },
    inputs: {
      ethBalance: formatEther(ethBalance),
      walletSpy: formatUnits(spyBalance, 18),
      walletPairAll: formatUnits(pairBalance, 18),
      requiredSpyForAllPair: formatUnits(requiredSpyForAllPair, 18),
      bufferedSpyTarget: formatUnits(bufferedSpyTarget, 18),
    },
    swap: {
      routeFees: route.fees,
      ethInput: formatEther(route.amountIn),
      quotedSpy: formatUnits(route.amountOut, 18),
      minimumSpy: formatUnits(spyMinimum, 18),
      maxGasBudgetEth: formatEther(swapBudget.budget),
    },
    safety: {
      mintSlippageBps: 20,
      minimumPairUseBps: UPPER_MIN_PAIR_USE_BPS,
      minimumFinalEth: formatEther(UPPER_MIN_ETH_RESERVE),
      collectMainFees: false,
      modifyMainPosition: false,
      useAllWalletPairAsMintBudget: true,
    },
  }
  if (print) console.log(stringify(report))
  appendAudit('upper_range_preflight', report)
  return {
    state,
    mainTokenId,
    mainLiquidity,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    route,
    spyMinimum,
    swapData,
    report,
  }
}

async function upperRangeEnter() {
  const check = await upperRangePreflight({ print: true })
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  const operationId = `upper-range-${new Date().toISOString().replace(/[-:.]/g, '')}`
  const state = check.state
  state.pendingUpperRange = {
    id: operationId,
    status: 'planned',
    createdAt: new Date().toISOString(),
    tickLower: UPPER_TICK_LOWER,
    tickUpper: UPPER_TICK_UPPER,
    mainTokenId: check.mainTokenId.toString(),
    mainLiquidityInvariant: check.mainLiquidity.toString(),
    baselineEthWei: check.ethBalance.toString(),
    baselineSpyWei: check.spyBalance.toString(),
    baselinePairWei: check.pairBalance.toString(),
    plannedEthInputWei: check.route.amountIn.toString(),
  }
  writeState(state)
  appendAudit('upper_range_plan_created', state.pendingUpperRange)

  const transactions = []
  try {
    const [nonceLatest, noncePending, ethBefore, spyBefore, pairBefore, mainLiquidityBefore] = await Promise.all([
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
      publicClient.getBalance({ address: WALLET }),
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.mainTokenId],
      }),
    ])
    if (nonceLatest !== noncePending)
      throw new Error(`广播前出现 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
    if (ethBefore !== check.ethBalance || spyBefore !== check.spyBalance || pairBefore !== check.pairBalance) {
      throw new Error('广播前钱包余额发生变化，已停止')
    }
    if (mainLiquidityBefore !== check.mainLiquidity) throw new Error('广播前主仓流动性发生变化，已停止')

    const bought = await sendChecked(walletClient, {
      label: `新区间 1/2 ETH 买入 SPY (${operationId})`,
      to: V3_ROUTER,
      data: check.swapData,
      value: check.route.amountIn,
      minimumBalanceAfter: UPPER_MIN_ETH_RESERVE,
    })
    transactions.push(bought)
    const [spyAfterBuy, pairAfterBuy, mainLiquidityAfterBuy] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.mainTokenId],
      }),
    ])
    const actualSpyBought = spyAfterBuy - spyBefore
    if (actualSpyBought < check.spyMinimum) throw new Error('ETH→SPY 成交回读低于保护下限')
    if (pairAfterBuy !== pairBefore) throw new Error('买入 SPY 时 PAIR 余额意外变化')
    if (mainLiquidityAfterBuy !== check.mainLiquidity) throw new Error('买入 SPY 后主仓流动性发生变化')
    state.pendingUpperRange.status = 'spy_purchased'
    state.pendingUpperRange.swapTransaction = bought.hash
    state.pendingUpperRange.actualSpyBoughtWei = actualSpyBought.toString()
    writeState(state)

    transactions.push(
      await approveErc20(
        walletClient,
        SPY,
        spyAfterBuy,
        `新区间确认 SPY Permit2 授权 (${operationId})`,
        UPPER_MIN_ETH_RESERVE,
      ),
    )
    transactions.push(
      await approveErc20(
        walletClient,
        PAIR,
        pairAfterBuy,
        `新区间确认 PAIR Permit2 授权 (${operationId})`,
        UPPER_MIN_ETH_RESERVE,
      ),
    )
    const mint = await buildCustomRangeMint(account, spyAfterBuy, pairAfterBuy, UPPER_TICK_LOWER, UPPER_TICK_UPPER)
    const plannedPairUseBps = (mint.amount1Desired * 10_000n) / pairAfterBuy
    if (plannedPairUseBps < UPPER_MIN_PAIR_USE_BPS) {
      throw new Error(`新区间预计仅使用 ${Number(plannedPairUseBps) / 100}% PAIR，低于 99% 硬门槛，停止铸造`)
    }

    const [spyBeforeMint, pairBeforeMint, mainLiquidityBeforeMint] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [check.mainTokenId],
      }),
    ])
    if (spyBeforeMint !== spyAfterBuy || pairBeforeMint !== pairAfterBuy) throw new Error('铸造前代币余额发生变化')
    if (spyBeforeMint < mint.amount0Max || pairBeforeMint < mint.amount1Max)
      throw new Error('铸造前余额不足以覆盖滑点上限')
    if (mainLiquidityBeforeMint !== check.mainLiquidity) throw new Error('铸造前主仓流动性发生变化')

    const minted = await sendChecked(walletClient, {
      label: `新区间 2/2 铸造 PAIR/SPY LP (${operationId})`,
      to: POSITION_MANAGER,
      data: mint.data,
      minimumBalanceAfter: UPPER_MIN_ETH_RESERVE,
    })
    transactions.push(minted)
    const newTokenId = parseMintTokenId(minted.receipt)
    if (newTokenId === null) throw new Error(`新区间 mint 成功但未解析到 NFT tokenId：${minted.hash}`)

    const [newOwner, newLiquidity, mainLiquidityFinal, finalEth, finalSpy, finalPair, finalPoolState] =
      await Promise.all([
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [newTokenId],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [newTokenId],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [check.mainTokenId],
        }),
        publicClient.getBalance({ address: WALLET }),
        publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        getPoolState(),
      ])
    if (newOwner.toLowerCase() !== WALLET.toLowerCase() || newLiquidity === 0n)
      throw new Error('新区间 NFT 链上读回不完整')
    if (newLiquidity !== mint.liquidity)
      throw new Error(`新区间流动性与计划不一致：chain=${newLiquidity}, plan=${mint.liquidity}`)
    if (mainLiquidityFinal !== check.mainLiquidity) throw new Error('主仓流动性不变量被破坏')
    if (finalEth < UPPER_MIN_ETH_RESERVE) throw new Error(`建仓后 ETH 低于 0.02 储备：${formatEther(finalEth)}`)

    const pairSpent = pairBeforeMint - finalPair
    const spySpent = spyBeforeMint - finalSpy
    const actualPairUseBps = pairBeforeMint === 0n ? 0n : (pairSpent * 10_000n) / pairBeforeMint
    const finalPosition = new Position({
      pool: makePool(finalPoolState),
      liquidity: newLiquidity.toString(),
      tickLower: UPPER_TICK_LOWER,
      tickUpper: UPPER_TICK_UPPER,
    })
    const record = {
      id: operationId,
      status: 'active',
      completedAt: new Date().toISOString(),
      tokenId: newTokenId.toString(),
      tickLower: UPPER_TICK_LOWER,
      tickUpper: UPPER_TICK_UPPER,
      liquidity: newLiquidity.toString(),
      source: 'all wallet PAIR plus wallet SPY and ETH converted to SPY; main position fees untouched',
      policy: {
        mode: 'grid_hold_out_of_range',
        autoExit: false,
        useAllWalletPairAsMintBudget: true,
        minimumPairUseBps: UPPER_MIN_PAIR_USE_BPS.toString(),
        minimumFinalEthWei: UPPER_MIN_ETH_RESERVE.toString(),
      },
      mainPositionInvariant: {
        tokenId: check.mainTokenId.toString(),
        liquidityBefore: check.mainLiquidity.toString(),
        liquidityAfter: mainLiquidityFinal.toString(),
      },
      ethToSpy: {
        ethSpentWei: check.route.amountIn.toString(),
        spyReceivedWei: actualSpyBought.toString(),
        transaction: bought.hash,
      },
      minted: {
        desiredSpyWei: mint.amount0Desired.toString(),
        desiredPairWei: mint.amount1Desired.toString(),
        walletSpentSpyWei: spySpent.toString(),
        walletSpentPairWei: pairSpent.toString(),
        pairUseBps: actualPairUseBps.toString(),
        underlyingSpyWei: asBigInt(finalPosition.amount0.quotient).toString(),
        underlyingPairWei: asBigInt(finalPosition.amount1.quotient).toString(),
      },
      residual: { spyWei: finalSpy.toString(), pairWei: finalPair.toString() },
      gasSpentWei: receiptGasTotal(transactions).toString(),
      finalEthWei: finalEth.toString(),
      transactions: transactions.filter(Boolean).map((item) => item.hash),
      mintBlock: minted.receipt.blockNumber.toString(),
      mintTransaction: minted.hash,
    }
    state.satellites = [...(state.satellites || []), record]
    delete state.pendingUpperRange
    writeState(state)
    appendAudit('upper_range_complete', record)
    console.log(
      stringify({
        status: 'ACTIVE',
        tokenId: newTokenId,
        liquidity: newLiquidity,
        tickLower: UPPER_TICK_LOWER,
        tickUpper: UPPER_TICK_UPPER,
        finalTick: finalPoolState.tick,
        ethSpent: formatEther(check.route.amountIn),
        spyBought: formatUnits(actualSpyBought, 18),
        pairSpent: formatUnits(pairSpent, 18),
        pairUsePct: (Number(actualPairUseBps) / 100).toFixed(2),
        residualSpy: formatUnits(finalSpy, 18),
        residualPair: formatUnits(finalPair, 18),
        gasSpentEth: formatEther(receiptGasTotal(transactions)),
        finalEth: formatEther(finalEth),
        transactions: transactions.filter(Boolean).map((item) => item.hash),
      }),
    )
  } catch (error) {
    const latestState = readState()
    const completedTransactions = transactions.filter(Boolean)
    if (latestState?.pendingUpperRange?.id === operationId) {
      if (completedTransactions.length === 0) {
        delete latestState.pendingUpperRange
      } else {
        latestState.pendingUpperRange.status = 'partial'
        latestState.pendingUpperRange.error = error.shortMessage || error.message
        latestState.pendingUpperRange.transactions = completedTransactions.map((item) => item.hash)
      }
      writeState(latestState)
    }
    appendAudit('upper_range_partial', {
      id: operationId,
      message: error.shortMessage || error.message,
      transactions: completedTransactions.map((item) => item.hash),
    })
    throw error
  }
}

async function upperRangeResume() {
  const state = readState()
  const pending = state?.pendingUpperRange
  if (!state || state.status !== 'active' || !pending) throw new Error('没有可恢复的新区间计划')
  if (!pending.swapTransaction) throw new Error('新区间计划没有已确认的首笔换币交易，禁止恢复')
  if (pending.mintTransaction) throw new Error(`新区间已记录 mint 交易 ${pending.mintTransaction}，需先做链上审计`)
  if (pending.tickLower !== UPPER_TICK_LOWER || pending.tickUpper !== UPPER_TICK_UPPER) {
    throw new Error(`待恢复区间 [${pending.tickLower},${pending.tickUpper}) 与代码配置不一致`)
  }

  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  const mainTokenId = BigInt(pending.mainTokenId)
  const initialReceipt = await publicClient.getTransactionReceipt({ hash: pending.swapTransaction })
  if (initialReceipt.status !== 'success') throw new Error(`首笔换币回执不是 success：${pending.swapTransaction}`)
  const transactions = [
    {
      hash: pending.swapTransaction,
      receipt: initialReceipt,
      gasCost: initialReceipt.gasUsed * initialReceipt.effectiveGasPrice,
    },
  ]

  const [nonceLatest, noncePending, mainLiquidityBefore, pairBeforeTopUp] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [mainTokenId],
    }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`恢复前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (mainLiquidityBefore !== BigInt(pending.mainLiquidityInvariant)) throw new Error('恢复前主仓流动性不变量不成立')
  if (pairBeforeTopUp !== BigInt(pending.baselinePairWei)) throw new Error('恢复前 PAIR 余额与计划基线不一致')

  if (!pending.topUpTransaction) {
    const quote = await quoteUpperEthToSpy(UPPER_RESUME_TOP_UP_ETH)
    const spyMinimum = bpsFloor(quote.amountOut, SWAP_SLIPPAGE_BPS)
    const topUpData = buildV3SwapData(quote.path, UPPER_RESUME_TOP_UP_ETH, spyMinimum)
    const toppedUp = await sendChecked(walletClient, {
      label: `新区间补充 SPY (${pending.id})`,
      to: V3_ROUTER,
      data: topUpData,
      value: UPPER_RESUME_TOP_UP_ETH,
      minimumBalanceAfter: UPPER_MIN_ETH_RESERVE,
    })
    transactions.push(toppedUp)
    pending.status = 'spy_topped_up'
    pending.topUpTransaction = toppedUp.hash
    pending.topUpEthWei = UPPER_RESUME_TOP_UP_ETH.toString()
    pending.topUpMinimumSpyWei = spyMinimum.toString()
    pending.transactions = transactions.map((item) => item.hash)
    writeState(state)
  } else {
    const topUpReceipt = await publicClient.getTransactionReceipt({ hash: pending.topUpTransaction })
    if (topUpReceipt.status !== 'success') throw new Error(`SPY 补充交易回执不是 success：${pending.topUpTransaction}`)
    transactions.push({
      hash: pending.topUpTransaction,
      receipt: topUpReceipt,
      gasCost: topUpReceipt.gasUsed * topUpReceipt.effectiveGasPrice,
    })
  }

  try {
    const [spyBeforeMint, pairBeforeMint, mainLiquidityBeforeMint, poolStateBeforeMint] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [mainTokenId],
      }),
      getPoolState(),
    ])
    if (pairBeforeMint !== BigInt(pending.baselinePairWei)) throw new Error('铸造前 PAIR 余额与计划基线不一致')
    if (mainLiquidityBeforeMint !== BigInt(pending.mainLiquidityInvariant)) throw new Error('铸造前主仓流动性发生变化')
    if (poolStateBeforeMint.tick < pending.tickLower || poolStateBeforeMint.tick >= pending.tickUpper) {
      throw new Error(`铸造前价格已离开新区间：tick=${poolStateBeforeMint.tick}`)
    }

    transactions.push(
      await approveErc20(
        walletClient,
        SPY,
        spyBeforeMint,
        `新区间恢复确认 SPY Permit2 授权 (${pending.id})`,
        UPPER_MIN_ETH_RESERVE,
      ),
    )
    transactions.push(
      await approveErc20(
        walletClient,
        PAIR,
        pairBeforeMint,
        `新区间恢复确认 PAIR Permit2 授权 (${pending.id})`,
        UPPER_MIN_ETH_RESERVE,
      ),
    )
    const mint = await buildCustomRangeMint(
      account,
      spyBeforeMint,
      pairBeforeMint,
      pending.tickLower,
      pending.tickUpper,
    )
    const plannedPairUseBps = (mint.amount1Desired * 10_000n) / pairBeforeMint
    if (plannedPairUseBps < UPPER_MIN_PAIR_USE_BPS) {
      throw new Error(`补充 SPY 后预计仍仅使用 ${Number(plannedPairUseBps) / 100}% PAIR，停止铸造`)
    }
    if (spyBeforeMint < mint.amount0Max || pairBeforeMint < mint.amount1Max)
      throw new Error('恢复铸造余额不足以覆盖滑点上限')

    const minted = await sendChecked(walletClient, {
      label: `新区间 2/2 铸造 PAIR/SPY LP (${pending.id})`,
      to: POSITION_MANAGER,
      data: mint.data,
      minimumBalanceAfter: UPPER_MIN_ETH_RESERVE,
    })
    transactions.push(minted)
    pending.mintTransaction = minted.hash
    pending.status = 'mint_broadcast'
    pending.transactions = transactions.filter(Boolean).map((item) => item.hash)
    writeState(state)

    const newTokenId = parseMintTokenId(minted.receipt)
    if (newTokenId === null) throw new Error(`新区间 mint 成功但未解析到 NFT tokenId：${minted.hash}`)
    const [newOwner, newLiquidity, mainLiquidityFinal, finalEth, finalSpy, finalPair, finalPoolState] =
      await Promise.all([
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [newTokenId],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [newTokenId],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [mainTokenId],
        }),
        publicClient.getBalance({ address: WALLET }),
        publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        getPoolState(),
      ])
    if (newOwner.toLowerCase() !== WALLET.toLowerCase() || newLiquidity === 0n)
      throw new Error('新区间 NFT 链上读回不完整')
    if (newLiquidity !== mint.liquidity)
      throw new Error(`新区间流动性与计划不一致：chain=${newLiquidity}, plan=${mint.liquidity}`)
    if (mainLiquidityFinal !== BigInt(pending.mainLiquidityInvariant)) throw new Error('主仓流动性不变量被破坏')
    if (finalEth < UPPER_MIN_ETH_RESERVE) throw new Error(`建仓后 ETH 低于 0.02 储备：${formatEther(finalEth)}`)

    const pairSpent = pairBeforeMint - finalPair
    const spySpent = spyBeforeMint - finalSpy
    const actualPairUseBps = (pairSpent * 10_000n) / pairBeforeMint
    const finalPosition = new Position({
      pool: makePool(finalPoolState),
      liquidity: newLiquidity.toString(),
      tickLower: pending.tickLower,
      tickUpper: pending.tickUpper,
    })
    const record = {
      id: pending.id,
      status: 'active',
      completedAt: new Date().toISOString(),
      tokenId: newTokenId.toString(),
      tickLower: pending.tickLower,
      tickUpper: pending.tickUpper,
      liquidity: newLiquidity.toString(),
      source: 'all wallet PAIR plus wallet SPY and ETH converted to SPY; main position fees untouched',
      policy: {
        mode: 'grid_hold_out_of_range',
        autoExit: false,
        useAllWalletPairAsMintBudget: true,
        minimumPairUseBps: UPPER_MIN_PAIR_USE_BPS.toString(),
        minimumFinalEthWei: UPPER_MIN_ETH_RESERVE.toString(),
      },
      mainPositionInvariant: {
        tokenId: mainTokenId.toString(),
        liquidityBefore: pending.mainLiquidityInvariant,
        liquidityAfter: mainLiquidityFinal.toString(),
      },
      ethToSpy: {
        ethSpentWei: (BigInt(pending.plannedEthInputWei) + BigInt(pending.topUpEthWei || '0')).toString(),
        spyReceivedWei: (spyBeforeMint - BigInt(pending.baselineSpyWei)).toString(),
        transactions: [pending.swapTransaction, pending.topUpTransaction].filter(Boolean),
      },
      minted: {
        desiredSpyWei: mint.amount0Desired.toString(),
        desiredPairWei: mint.amount1Desired.toString(),
        walletSpentSpyWei: spySpent.toString(),
        walletSpentPairWei: pairSpent.toString(),
        pairUseBps: actualPairUseBps.toString(),
        underlyingSpyWei: asBigInt(finalPosition.amount0.quotient).toString(),
        underlyingPairWei: asBigInt(finalPosition.amount1.quotient).toString(),
      },
      residual: { spyWei: finalSpy.toString(), pairWei: finalPair.toString() },
      gasSpentWei: receiptGasTotal(transactions).toString(),
      finalEthWei: finalEth.toString(),
      transactions: transactions.filter(Boolean).map((item) => item.hash),
      mintBlock: minted.receipt.blockNumber.toString(),
      mintTransaction: minted.hash,
    }
    state.satellites = [...(state.satellites || []), record]
    delete state.pendingUpperRange
    writeState(state)
    appendAudit('upper_range_complete', record)
    console.log(
      stringify({
        status: 'ACTIVE',
        resumed: true,
        tokenId: newTokenId,
        liquidity: newLiquidity,
        tickLower: record.tickLower,
        tickUpper: record.tickUpper,
        finalTick: finalPoolState.tick,
        totalEthToSpy: formatEther(BigInt(record.ethToSpy.ethSpentWei)),
        pairSpent: formatUnits(pairSpent, 18),
        pairUsePct: (Number(actualPairUseBps) / 100).toFixed(2),
        residualSpy: formatUnits(finalSpy, 18),
        residualPair: formatUnits(finalPair, 18),
        gasSpentEth: formatEther(receiptGasTotal(transactions)),
        finalEth: formatEther(finalEth),
        transactions: record.transactions,
      }),
    )
  } catch (error) {
    const latestState = readState()
    if (latestState?.pendingUpperRange?.id === pending.id) {
      latestState.pendingUpperRange.status = latestState.pendingUpperRange.mintTransaction
        ? 'mint_broadcast'
        : 'partial'
      latestState.pendingUpperRange.error = error.shortMessage || error.message
      latestState.pendingUpperRange.transactions = transactions.filter(Boolean).map((item) => item.hash)
      writeState(latestState)
    }
    appendAudit('upper_range_resume_partial', {
      id: pending.id,
      message: error.shortMessage || error.message,
      transactions: transactions.filter(Boolean).map((item) => item.hash),
    })
    throw error
  }
}

async function attackRollPreflight({ print = true } = {}) {
  const state = readState()
  if (!state || state.status !== 'active' || !state.position?.tokenId) throw new Error('没有活动的 PAIR/SPY 主仓')
  for (const key of [
    'pendingIncrease',
    'pendingSatellite',
    'pendingMigration',
    'pendingUpperRange',
    'pendingFeeBand',
    'pendingAttackRoll',
    'pendingAttackCompound',
    'pendingAttackResidual',
    'pendingMainRoll',
    'pendingCurrentBand',
  ]) {
    if (state[key]) throw new Error(`存在未结算计划 ${key}：${state[key].id || 'unknown'}`)
  }
  const source = (state.satellites || []).find(
    (item) => item.status === 'active' && String(item.tokenId) === ATTACK_SOURCE_TOKEN_ID,
  )
  if (!source) throw new Error(`没有找到活动的第 3 LP NFT ${ATTACK_SOURCE_TOKEN_ID}`)

  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const allRecords = activePairPositionRecords(state)
  const otherRecords = allRecords.filter((item) => String(item.tokenId) !== ATTACK_SOURCE_TOKEN_ID)
  const [
    blockNumber,
    nonceLatest,
    noncePending,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    gasPrice,
    spyMark,
    sourceOwner,
    sourceLiquidity,
    sourceFees,
    otherReads,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    getPoolState(),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getGasPrice(),
    quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [BigInt(source.tokenId)],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(source.tokenId)],
    }),
    getAccruedFees(BigInt(source.tokenId), source.tickLower, source.tickUpper),
    Promise.all(
      otherRecords.map(async (record) => ({
        tokenId: String(record.tokenId),
        liquidity: await publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(record.tokenId)],
        }),
        expectedLiquidity: BigInt(record.liquidity),
      })),
    ),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (sourceOwner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`第 3 LP NFT ${source.tokenId} 不在执行钱包`)
  if (sourceLiquidity === 0n || sourceLiquidity !== BigInt(source.liquidity)) {
    throw new Error(`第 3 LP 流动性不一致：chain=${sourceLiquidity}, local=${source.liquidity}`)
  }
  if (sourceFees.liquidity !== sourceLiquidity) throw new Error('第 3 LP 手续费读回的流动性不一致')
  for (const item of otherReads) {
    if (item.liquidity !== item.expectedLiquidity) throw new Error(`受保护 LP ${item.tokenId} 流动性不一致`)
  }

  const target = attackRangeForTick(poolState.tick)
  const duplicate = otherRecords.find(
    (record) => record.tickLower === target.tickLower && record.tickUpper === target.tickUpper,
  )
  if (duplicate) throw new Error(`进攻区间已有活动头寸 NFT ${duplicate.tokenId}`)
  const rangePositionBps = customRangePositionBps(poolState.tick, target.tickLower, target.tickUpper)
  if (rangePositionBps < ATTACK_MIN_RANGE_POSITION_BPS || rangePositionBps > ATTACK_MAX_RANGE_POSITION_BPS) {
    throw new Error(`现价距进攻区间边界过近：range? rangeBps=${rangePositionBps}`)
  }

  const removal = buildFullRemove(source, sourceLiquidity, poolState)
  const sourceSpyWei = removal.amount0Principal + sourceFees.spyWei
  const sourcePairWei = removal.amount1Principal + sourceFees.pairWei
  if (sourceSpyWei === 0n && sourcePairWei === 0n) throw new Error('第 3 LP 可迁移资产为 0')
  const rebalance = await solveCustomRangeRebalance(
    sourceSpyWei,
    sourcePairWei,
    poolState,
    target.tickLower,
    target.tickUpper,
  )
  const sourceValue = tokenAmountsUsdg(sourceSpyWei, sourcePairWei, poolState, spyMark)
  const removeBudget = await transactionBudget(POSITION_MANAGER, removal.data)
  // Canonical receipts for this remove + Permit2 refresh + V4 swap + V4 mint
  // path have used about 700k gas in total. The removal is budgeted separately
  // above; reserve another 650k units with a 25% margin here.
  const remainingGasBudget = (gasPrice * 650_000n * 125n) / 100n
  const requiredEth = ATTACK_MIN_ETH_RESERVE + removeBudget.budget + remainingGasBudget
  if (ethBalance < requiredEth) {
    throw new Error(`进攻仓迁移 ETH 储备不足：余额=${formatEther(ethBalance)}，保守需要=${formatEther(requiredEth)}`)
  }

  const spyPriceUsdg = Number(formatUnits(spyMark.amountOut, 6)) / Number(formatUnits(ADD_SPY_MARK_INPUT, 18))
  const currentPairPriceUsdg = spyPriceUsdg / Math.pow(1.0001, poolState.tick)
  const oldPrices = customRangePricesUsdg(spyPriceUsdg, source.tickLower, source.tickUpper)
  const targetPrices = customRangePricesUsdg(spyPriceUsdg, target.tickLower, target.tickUpper)
  const report = {
    status: 'READY_TO_ROLL_ATTACK_POSITION',
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    pool: {
      currentTick: poolState.tick,
      spyPriceUsdg: spyPriceUsdg.toFixed(6),
      currentPairPriceUsdg: currentPairPriceUsdg.toFixed(8),
    },
    source: {
      tokenId: String(source.tokenId),
      tickLower: source.tickLower,
      tickUpper: source.tickUpper,
      priceRangeUsdg: { low: oldPrices.low.toFixed(8), high: oldPrices.high.toFixed(8) },
      liquidity: sourceLiquidity,
      principal: {
        spy: formatUnits(removal.amount0Principal, 18),
        pair: formatUnits(removal.amount1Principal, 18),
      },
      accruedFees: {
        spy: formatUnits(sourceFees.spyWei, 18),
        pair: formatUnits(sourceFees.pairWei, 18),
      },
      totalMarkedUsdg: formatUnits(sourceValue.totalUsdg, 6),
    },
    target: {
      mode: 'offensive_fee_band',
      centerTick: target.centerTick,
      tickLower: target.tickLower,
      tickUpper: target.tickUpper,
      priceRangeUsdg: { low: targetPrices.low.toFixed(8), high: targetPrices.high.toFixed(8) },
      rangePositionPct: (Number(rangePositionBps) / 100).toFixed(2),
      widthTicks: target.tickUpper - target.tickLower,
    },
    rebalance: {
      direction: rebalance.direction,
      input: formatUnits(rebalance.amountIn, 18),
      quotedOutput: formatUnits(rebalance.amountOut, 18),
      expectedPostSwapSpy: formatUnits(rebalance.expectedSpyWei, 18),
      expectedPostSwapPair: formatUnits(rebalance.expectedPairWei, 18),
      targetValueSplitPct: {
        spy: (Number(rebalance.targetSpyValueBps) / 100).toFixed(2),
        pair: (Number(rebalance.targetPairValueBps) / 100).toFixed(2),
      },
      slippageBps: Number(SWAP_SLIPPAGE_BPS),
    },
    protectedPositions: otherReads.map((item) => ({
      tokenId: item.tokenId,
      liquidityInvariant: item.liquidity,
    })),
    walletBaselineExcluded: {
      spy: formatUnits(spyBalance, 18),
      pair: formatUnits(pairBalance, 18),
    },
    gas: {
      gasPriceGwei: (Number(gasPrice) / 1e9).toFixed(6),
      ethBalance: formatEther(ethBalance),
      removeMaxBudgetEth: formatEther(removeBudget.budget),
      conservativeRequiredEth: formatEther(requiredEth),
      retainedMinimumEth: formatEther(ATTACK_MIN_ETH_RESERVE),
    },
    policy: {
      migrateOnlyTokenId: ATTACK_SOURCE_TOKEN_ID,
      useOnlyWithdrawnPrincipalAndFees: true,
      preserveWalletTokenBaseline: true,
      preserveOtherLpLiquidity: true,
      autoExit: false,
    },
  }
  appendAudit('attack_roll_preflight', report)
  if (print) console.log(stringify(report))
  return {
    state,
    source,
    otherReads,
    blockNumber,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    spyMark,
    sourceLiquidity,
    sourceFees,
    target,
    report,
  }
}

function rememberAttackTransaction(state, pending, result) {
  if (!result) return
  pending.transactions = [...new Set([...(pending.transactions || []), result.hash])]
  writeState(state)
}

async function confirmedAttackTransactions(pending) {
  const results = []
  for (const hash of [...new Set(pending.transactions || [])]) {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`进攻仓历史交易回执不是 success：${hash}`)
    results.push({ hash, receipt, gasCost: receipt.gasUsed * receipt.effectiveGasPrice })
  }
  return results
}

async function confirmedFailedAttackTransactions(pending) {
  const results = []
  for (const hash of [...new Set(pending.failedTransactions || [])]) {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    if (receipt.status !== 'reverted') throw new Error(`进攻仓失败交易状态异常：${hash}`)
    results.push({ hash, receipt, gasCost: receipt.gasUsed * receipt.effectiveGasPrice })
  }
  return results
}

async function readAttackProtectedInvariants(pending) {
  return Promise.all(
    pending.protectedPositions.map(async (item) => {
      const liquidity = await publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(item.tokenId)],
      })
      if (liquidity !== BigInt(item.liquidity)) throw new Error(`受保护 LP ${item.tokenId} 流动性发生变化`)
      return { tokenId: String(item.tokenId), liquidity }
    }),
  )
}

async function finalizeAttackRoll(state, pending) {
  if (!pending.mintTransaction || !pending.mintPlan) throw new Error('进攻仓尚无可结算的 mint 交易')
  const mintReceipt = await publicClient.getTransactionReceipt({ hash: pending.mintTransaction })
  if (mintReceipt.status !== 'success') throw new Error(`进攻仓 mint 回执不是 success：${pending.mintTransaction}`)
  const newTokenId = parseMintTokenId(mintReceipt)
  if (newTokenId === null) throw new Error(`进攻仓 mint 成功但未解析到 NFT tokenId：${pending.mintTransaction}`)
  const [newOwner, newLiquidity, sourceLiquidityAfter, finalEth, finalSpy, finalPair, finalPoolState, invariants] =
    await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [newTokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [newTokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(pending.source.tokenId)],
      }),
      publicClient.getBalance({ address: WALLET }),
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      getPoolState(),
      readAttackProtectedInvariants(pending),
    ])
  if (newOwner.toLowerCase() !== WALLET.toLowerCase() || newLiquidity === 0n)
    throw new Error('进攻仓新 NFT 链上读回不完整')
  if (newLiquidity !== BigInt(pending.mintPlan.liquidity))
    throw new Error(`进攻仓流动性与计划不一致：chain=${newLiquidity}, plan=${pending.mintPlan.liquidity}`)
  if (sourceLiquidityAfter !== 0n) throw new Error(`原第 3 LP liquidity=${sourceLiquidityAfter}，预期为 0`)
  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  if (finalSpy < baselineSpy || finalPair < baselinePair) throw new Error('进攻仓迁移动用了钱包既有代币')
  if (finalEth < ATTACK_MIN_ETH_RESERVE)
    throw new Error(`建仓后 ETH 低于 ${formatEther(ATTACK_MIN_ETH_RESERVE)} 储备：${formatEther(finalEth)}`)

  const finalPosition = new Position({
    pool: makePool(finalPoolState),
    liquidity: newLiquidity.toString(),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
  })
  const underlyingSpyWei = asBigInt(finalPosition.amount0.quotient)
  const underlyingPairWei = asBigInt(finalPosition.amount1.quotient)
  const residualSpyWei = finalSpy - baselineSpy
  const residualPairWei = finalPair - baselinePair
  let priceSnapshot = null
  let marked = null
  try {
    const finalSpyMark = await quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT)
    const spyPriceUsdg = Number(formatUnits(finalSpyMark.amountOut, 6)) / Number(formatUnits(ADD_SPY_MARK_INPUT, 18))
    const prices = customRangePricesUsdg(spyPriceUsdg, pending.tickLower, pending.tickUpper)
    const positionValue = tokenAmountsUsdg(underlyingSpyWei, underlyingPairWei, finalPoolState, finalSpyMark)
    const residualValue = tokenAmountsUsdg(residualSpyWei, residualPairWei, finalPoolState, finalSpyMark)
    const totalValue = positionValue.totalUsdg + residualValue.totalUsdg
    const residualBps = totalValue === 0n ? 0n : (residualValue.totalUsdg * 10_000n) / totalValue
    priceSnapshot = {
      spyPriceUsdg: spyPriceUsdg.toFixed(6),
      actualPairPriceLowUsdg: prices.low.toFixed(8),
      actualPairPriceHighUsdg: prices.high.toFixed(8),
      currentPairPriceUsdg: (spyPriceUsdg / Math.pow(1.0001, finalPoolState.tick)).toFixed(8),
      currentTick: finalPoolState.tick,
    }
    marked = {
      positionUsdg: positionValue.totalUsdg.toString(),
      residualUsdg: residualValue.totalUsdg.toString(),
      residualBps: residualBps.toString(),
      warning:
        residualBps > ATTACK_MAX_RESIDUAL_BPS
          ? `进攻仓残余约占 ${Number(residualBps) / 100}%，高于 ${Number(ATTACK_MAX_RESIDUAL_BPS) / 100}% 目标`
          : null,
    }
  } catch (error) {
    marked = { warning: `最终估值读取失败：${error.shortMessage || error.message}` }
  }
  const transactions = await confirmedAttackTransactions(pending)
  const failedTransactions = await confirmedFailedAttackTransactions(pending)
  const sourceRecord = (state.satellites || []).find((item) => String(item.tokenId) === String(pending.source.tokenId))
  if (!sourceRecord || sourceRecord.status !== 'active') throw new Error('本地第 3 LP 状态无法结算迁移')
  sourceRecord.status = 'migrated_to_attack'
  sourceRecord.migratedAt = new Date().toISOString()
  sourceRecord.migratedBy = pending.id
  sourceRecord.liquidityAfter = '0'
  const record = {
    id: pending.id,
    status: 'active',
    completedAt: new Date().toISOString(),
    tokenId: newTokenId.toString(),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
    liquidity: newLiquidity.toString(),
    source: `principal and fees withdrawn from NFT ${pending.source.tokenId}; pre-existing wallet tokens excluded`,
    requestedRole: 'offensive_small_position',
    priceSnapshot,
    policy: {
      mode: 'offensive_fee_band',
      autoExit: false,
      sourceTokenId: String(pending.source.tokenId),
      preservePreExistingWalletTokens: true,
      preserveOtherLpLiquidity: true,
      minimumFinalEthWei: ATTACK_MIN_ETH_RESERVE.toString(),
    },
    protectedPositionInvariants: invariants.map((item) => ({
      tokenId: item.tokenId,
      liquidityAfter: item.liquidity.toString(),
    })),
    sourcePosition: {
      tokenId: String(pending.source.tokenId),
      tickLower: pending.source.tickLower,
      tickUpper: pending.source.tickUpper,
      liquidityBefore: pending.source.liquidity,
      liquidityAfter: sourceLiquidityAfter.toString(),
      withdrawnSpyWei: pending.withdrawnSpyWei,
      withdrawnPairWei: pending.withdrawnPairWei,
      removalTransaction: pending.removeTransaction,
    },
    rebalance: pending.rebalance,
    minted: {
      desiredSpyWei: pending.mintPlan.desiredSpyWei,
      desiredPairWei: pending.mintPlan.desiredPairWei,
      underlyingSpyWei: underlyingSpyWei.toString(),
      underlyingPairWei: underlyingPairWei.toString(),
    },
    residual: { spyWei: residualSpyWei.toString(), pairWei: residualPairWei.toString(), ...marked },
    excludedWalletBaseline: { spyWei: pending.baselineSpyWei, pairWei: pending.baselinePairWei },
    gasSpentWei: receiptGasTotal([...transactions, ...failedTransactions]).toString(),
    finalEthWei: finalEth.toString(),
    transactions: pending.transactions,
    failedTransactions: pending.failedTransactions || [],
    mintBlock: mintReceipt.blockNumber.toString(),
    mintTransaction: pending.mintTransaction,
  }
  state.satellites = [...state.satellites, record]
  delete state.pendingAttackRoll
  writeState(state)
  appendAudit('attack_roll_complete', record)
  console.log(
    stringify({
      status: 'ATTACK_POSITION_ACTIVE',
      sourceTokenId: pending.source.tokenId,
      tokenId: newTokenId,
      liquidity: newLiquidity,
      tickLower: pending.tickLower,
      tickUpper: pending.tickUpper,
      priceSnapshot,
      withdrawn: {
        spy: formatUnits(BigInt(pending.withdrawnSpyWei), 18),
        pair: formatUnits(BigInt(pending.withdrawnPairWei), 18),
      },
      rebalance: record.rebalance,
      lpUnderlying: { spy: formatUnits(underlyingSpyWei, 18), pair: formatUnits(underlyingPairWei, 18) },
      residual: { spy: formatUnits(residualSpyWei, 18), pair: formatUnits(residualPairWei, 18), marked },
      protectedPositionsUnchanged: true,
      gasSpentEth: formatEther(BigInt(record.gasSpentWei)),
      finalEth: formatEther(finalEth),
      transactions: record.transactions,
    }),
  )
  return record
}

async function continueAttackRoll(state, pending) {
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  await confirmedAttackTransactions(pending)
  const [nonceLatest, noncePending] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`执行前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  await readAttackProtectedInvariants(pending)
  if (pending.mintTransaction) return finalizeAttackRoll(state, pending)

  if (!pending.fixedTarget && (pending.failedTransactions || []).length >= 2 && !pending.retargetedAt) {
    const poolState = await getPoolState()
    const recovery = attackRecoveryRangeForTick(poolState.tick)
    pending.originalTarget = { tickLower: pending.tickLower, tickUpper: pending.tickUpper }
    pending.tickLower = recovery.tickLower
    pending.tickUpper = recovery.tickUpper
    pending.retargetedAt = new Date().toISOString()
    pending.retargetReason = 'two mint receipts reverted while the pool moved faster than the prior mint tolerance'
    pending.rebalanceHistory = pending.rebalance ? [pending.rebalance] : []
    pending.rebalance = null
    pending.rebalanceComplete = false
    pending.mintPlan = null
    pending.status = 'retargeted_for_volatile_recovery'
    writeState(state)
    appendAudit('attack_roll_retargeted', {
      id: pending.id,
      currentTick: poolState.tick,
      originalTarget: pending.originalTarget,
      target: { centerTick: recovery.centerTick, tickLower: recovery.tickLower, tickUpper: recovery.tickUpper },
      reason: pending.retargetReason,
    })
  }

  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  if (!pending.removeTransaction) {
    const [spyBefore, pairBefore, sourceLiquidity, poolState] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(pending.source.tokenId)],
      }),
      getPoolState(),
    ])
    if (spyBefore !== baselineSpy || pairBefore !== baselinePair) throw new Error('撤仓前钱包代币余额偏离计划基线')
    if (sourceLiquidity !== BigInt(pending.source.liquidity)) throw new Error('撤仓前第 3 LP 流动性发生变化')
    const rangePositionBps = customRangePositionBps(poolState.tick, pending.tickLower, pending.tickUpper)
    if (rangePositionBps < ATTACK_MIN_RANGE_POSITION_BPS || rangePositionBps > ATTACK_MAX_RANGE_POSITION_BPS) {
      throw new Error(`撤仓前现价已偏离进攻区间安全区域：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
    }
    const removal = buildFullRemove(pending.source, sourceLiquidity, poolState)
    const removed = await sendChecked(walletClient, {
      label: `进攻仓撤出第 3 LP NFT ${pending.source.tokenId} (${pending.id})`,
      to: POSITION_MANAGER,
      data: removal.data,
      minimumBalanceAfter: ATTACK_MIN_ETH_RESERVE,
    })
    rememberAttackTransaction(state, pending, removed)
    const [spyAfter, pairAfter, sourceLiquidityAfter] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(pending.source.tokenId)],
      }),
    ])
    if (sourceLiquidityAfter !== 0n) throw new Error(`第 3 LP 撤出后 liquidity=${sourceLiquidityAfter}`)
    if (spyAfter < baselineSpy || pairAfter < baselinePair) throw new Error('第 3 LP 撤出后钱包余额异常')
    pending.removeTransaction = removed.hash
    pending.withdrawnSpyWei = (spyAfter - baselineSpy).toString()
    pending.withdrawnPairWei = (pairAfter - baselinePair).toString()
    pending.availableSpyWei = pending.withdrawnSpyWei
    pending.availablePairWei = pending.withdrawnPairWei
    pending.status = 'source_removed'
    writeState(state)
  }

  if (!pending.rebalanceComplete) {
    const [walletSpy, walletPair, poolState] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      getPoolState(),
    ])
    const availableSpy = BigInt(pending.availableSpyWei)
    const availablePair = BigInt(pending.availablePairWei)
    if (walletSpy !== baselineSpy + availableSpy || walletPair !== baselinePair + availablePair) {
      throw new Error('配平前钱包余额不等于既有基线加第 3 LP 撤出资产')
    }
    const rangePositionBps = customRangePositionBps(poolState.tick, pending.tickLower, pending.tickUpper)
    if (rangePositionBps < ATTACK_MIN_RANGE_POSITION_BPS || rangePositionBps > ATTACK_MAX_RANGE_POSITION_BPS) {
      throw new Error(`配平前现价已偏离进攻区间安全区域：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
    }
    const plan = await solveCustomRangeRebalance(
      availableSpy,
      availablePair,
      poolState,
      pending.tickLower,
      pending.tickUpper,
    )
    if (plan.direction === 'NONE') {
      pending.rebalance = { direction: 'NONE', inputWei: '0', outputWei: '0', transaction: null }
    } else {
      const inputToken = plan.zeroForOne ? SPY : PAIR
      const inputSymbol = plan.zeroForOne ? 'SPY' : 'PAIR'
      const outputSymbol = plan.zeroForOne ? 'PAIR' : 'SPY'
      rememberAttackTransaction(
        state,
        pending,
        await approveErc20(
          walletClient,
          inputToken,
          plan.amountIn,
          `进攻仓授权 ${inputSymbol} 给 Permit2 (${pending.id})`,
          ATTACK_MIN_ETH_RESERVE,
        ),
      )
      rememberAttackTransaction(
        state,
        pending,
        await approvePermit2(
          walletClient,
          inputToken,
          UNIVERSAL_ROUTER,
          plan.amountIn,
          `进攻仓授权路由使用 ${inputSymbol} (${pending.id})`,
          ATTACK_MIN_ETH_RESERVE,
        ),
      )
      const liveQuote = await quotePairPoolSwap(plan.amountIn, plan.zeroForOne)
      const minimumOutput = bpsFloor(liveQuote.amountOut, SWAP_SLIPPAGE_BPS)
      const swapData = buildV4SwapData(plan.amountIn, minimumOutput, BigInt(nowSeconds() + 5 * 60), plan.zeroForOne)
      const swapped = await sendChecked(walletClient, {
        label: `进攻仓配平 ${inputSymbol}→${outputSymbol} (${pending.id})`,
        to: UNIVERSAL_ROUTER,
        data: swapData,
        minimumBalanceAfter: ATTACK_MIN_ETH_RESERVE,
      })
      rememberAttackTransaction(state, pending, swapped)
      const [spyAfterSwap, pairAfterSwap] = await Promise.all([
        publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      ])
      const actualInput = plan.zeroForOne ? walletSpy - spyAfterSwap : walletPair - pairAfterSwap
      const actualOutput = plan.zeroForOne ? pairAfterSwap - walletPair : spyAfterSwap - walletSpy
      if (actualInput !== plan.amountIn || actualOutput < minimumOutput)
        throw new Error('进攻仓配平实际输入或输出不符合保护条件')
      pending.rebalance = {
        direction: plan.direction,
        inputWei: actualInput.toString(),
        outputWei: actualOutput.toString(),
        minimumOutputWei: minimumOutput.toString(),
        transaction: swapped.hash,
      }
      pending.availableSpyWei = (spyAfterSwap - baselineSpy).toString()
      pending.availablePairWei = (pairAfterSwap - baselinePair).toString()
    }
    pending.rebalanceComplete = true
    pending.status = 'rebalanced'
    writeState(state)
  }

  await readAttackProtectedInvariants(pending)
  const [poolStateBeforeMint, spyBeforeMint, pairBeforeMint] = await Promise.all([
    getPoolState(),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  const availableSpy = BigInt(pending.availableSpyWei)
  const availablePair = BigInt(pending.availablePairWei)
  if (spyBeforeMint !== baselineSpy + availableSpy || pairBeforeMint !== baselinePair + availablePair) {
    throw new Error('铸造前钱包余额不等于既有基线加进攻仓资产')
  }
  const rangePositionBps = customRangePositionBps(poolStateBeforeMint.tick, pending.tickLower, pending.tickUpper)
  if (rangePositionBps < ATTACK_MIN_RANGE_POSITION_BPS || rangePositionBps > ATTACK_MAX_RANGE_POSITION_BPS) {
    throw new Error(`铸造前现价已偏离进攻区间安全区域：tick=${poolStateBeforeMint.tick}, rangeBps=${rangePositionBps}`)
  }
  rememberAttackTransaction(
    state,
    pending,
    await approveErc20(
      walletClient,
      SPY,
      availableSpy,
      `进攻仓确认 SPY Permit2 授权 (${pending.id})`,
      ATTACK_MIN_ETH_RESERVE,
    ),
  )
  rememberAttackTransaction(
    state,
    pending,
    await approveErc20(
      walletClient,
      PAIR,
      availablePair,
      `进攻仓确认 PAIR Permit2 授权 (${pending.id})`,
      ATTACK_MIN_ETH_RESERVE,
    ),
  )
  const mint = await buildCustomRangeMint(account, availableSpy, availablePair, pending.tickLower, pending.tickUpper, {
    minimumRangePositionBps: ATTACK_MIN_RANGE_POSITION_BPS,
    maximumRangePositionBps: ATTACK_MAX_RANGE_POSITION_BPS,
    slippageTolerance: ATTACK_MINT_SLIPPAGE,
  })
  if (mint.amount0Max > availableSpy || mint.amount1Max > availablePair)
    throw new Error('进攻仓滑点上限超过第 3 LP 迁移资产')
  pending.mintPlan = {
    liquidity: mint.liquidity.toString(),
    desiredSpyWei: mint.amount0Desired.toString(),
    desiredPairWei: mint.amount1Desired.toString(),
    maxSpyWei: mint.amount0Max.toString(),
    maxPairWei: mint.amount1Max.toString(),
  }
  pending.status = 'mint_prepared'
  writeState(state)
  const minted = await sendChecked(walletClient, {
    label: `进攻仓铸造 PAIR/SPY LP (${pending.id})`,
    to: POSITION_MANAGER,
    data: mint.data,
    minimumBalanceAfter: ATTACK_MIN_ETH_RESERVE,
    fast: true,
    gasPriceMultiplierBps: 20_000n,
  })
  pending.mintTransaction = minted.hash
  pending.status = 'mint_confirmed'
  rememberAttackTransaction(state, pending, minted)
  return finalizeAttackRoll(state, pending)
}

function markAttackRollPartial(operationId, error) {
  const latestState = readState()
  if (!latestState?.pendingAttackRoll || latestState.pendingAttackRoll.id !== operationId) return
  const pending = latestState.pendingAttackRoll
  if (!(pending.transactions || []).length) {
    delete latestState.pendingAttackRoll
  } else {
    const failedHash = String(error.shortMessage || error.message).match(/0x[0-9a-fA-F]{64}/)?.[0]
    if (failedHash) pending.failedTransactions = [...new Set([...(pending.failedTransactions || []), failedHash])]
    pending.status = pending.mintTransaction ? 'mint_confirmed_needs_readback' : 'partial'
    pending.lastErrorAt = new Date().toISOString()
    pending.lastError = error.shortMessage || error.message
  }
  writeState(latestState)
  appendAudit('attack_roll_partial', {
    id: operationId,
    status: pending.status,
    message: error.shortMessage || error.message,
    transactions: pending.transactions || [],
  })
}

async function attackRollEnter() {
  const check = await attackRollPreflight({ print: true })
  const operationId = `attack-roll-${new Date().toISOString().replace(/[-:.]/g, '')}`
  const state = check.state
  state.pendingAttackRoll = {
    id: operationId,
    status: 'planned',
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    tickLower: check.target.tickLower,
    tickUpper: check.target.tickUpper,
    fixedTarget: ATTACK_FIXED_TICK_LOWER !== null,
    baselineEthWei: check.ethBalance.toString(),
    baselineSpyWei: check.spyBalance.toString(),
    baselinePairWei: check.pairBalance.toString(),
    source: {
      tokenId: String(check.source.tokenId),
      tickLower: check.source.tickLower,
      tickUpper: check.source.tickUpper,
      liquidity: check.sourceLiquidity.toString(),
    },
    protectedPositions: check.otherReads.map((item) => ({
      tokenId: item.tokenId,
      liquidity: item.liquidity.toString(),
    })),
    transactions: [],
  }
  writeState(state)
  appendAudit('attack_roll_plan_created', state.pendingAttackRoll)
  try {
    return await continueAttackRoll(state, state.pendingAttackRoll)
  } catch (error) {
    markAttackRollPartial(operationId, error)
    throw error
  }
}

async function attackRollResume() {
  const state = readState()
  const pending = state?.pendingAttackRoll
  if (!state || state.status !== 'active' || !pending) throw new Error('没有可恢复的进攻仓迁移计划')
  try {
    return await continueAttackRoll(state, pending)
  } catch (error) {
    markAttackRollPartial(pending.id, error)
    throw error
  }
}

function mainRollPriceGuard(poolState, spyMark, amountInSpyWei = 0n, amountOutPairWei = 0n) {
  const spyPriceUsdg = Number(formatUnits(spyMark.amountOut, 6)) / Number(formatUnits(ADD_SPY_MARK_INPUT, 18))
  if (!Number.isFinite(spyPriceUsdg) || spyPriceUsdg <= 0)
    throw new Error(`主仓迁移 SPY/USDG 标记价格无效：${spyPriceUsdg}`)
  const spotPairPriceUsdg = spyPriceUsdg / Math.pow(1.0001, poolState.tick)
  if (spotPairPriceUsdg > MAIN_ROLL_MAX_SPOT_PAIR_USDG) {
    throw new Error(
      `PAIR 现价 $${spotPairPriceUsdg.toFixed(8)} 高于主仓追价上限 $${MAIN_ROLL_MAX_SPOT_PAIR_USDG.toFixed(5)}`,
    )
  }
  let averagePairPriceUsdg = null
  let inputUsdgMicro = 0n
  if (amountInSpyWei > 0n || amountOutPairWei > 0n) {
    if (amountInSpyWei <= 0n || amountOutPairWei <= 0n) throw new Error('主仓迁移成交均价输入无效')
    inputUsdgMicro = (amountInSpyWei * spyMark.amountOut) / ADD_SPY_MARK_INPUT
    if (inputUsdgMicro * 10n ** 18n > MAIN_ROLL_MAX_AVERAGE_PAIR_MICRO_USDG * amountOutPairWei) {
      averagePairPriceUsdg = Number(inputUsdgMicro) / 1e6 / Number(formatUnits(amountOutPairWei, 18))
      throw new Error(
        `PAIR 预计/实际成交均价 $${averagePairPriceUsdg.toFixed(8)} 高于上限 $${MAIN_ROLL_MAX_AVERAGE_PAIR_USDG.toFixed(5)}`,
      )
    }
    averagePairPriceUsdg = Number(inputUsdgMicro) / 1e6 / Number(formatUnits(amountOutPairWei, 18))
  }
  return { spyPriceUsdg, spotPairPriceUsdg, averagePairPriceUsdg, inputUsdgMicro }
}

function mainRollMinimumPairOutput(amountInSpyWei, spyMark) {
  const inputUsdgMicro = (amountInSpyWei * spyMark.amountOut) / ADD_SPY_MARK_INPUT
  const numerator = inputUsdgMicro * 10n ** 18n
  return (numerator + MAIN_ROLL_MAX_AVERAGE_PAIR_MICRO_USDG - 1n) / MAIN_ROLL_MAX_AVERAGE_PAIR_MICRO_USDG
}

async function mainRollPreflight({ print = true } = {}) {
  const state = readState()
  if (!state || state.status !== 'active' || !state.position?.tokenId) throw new Error('没有活动的 PAIR/SPY 主仓')
  for (const key of [
    'pendingIncrease',
    'pendingSatellite',
    'pendingMigration',
    'pendingUpperRange',
    'pendingFeeBand',
    'pendingAttackRoll',
    'pendingAttackCompound',
    'pendingAttackResidual',
    'pendingMainRoll',
    'pendingCurrentBand',
  ]) {
    if (state[key]) throw new Error(`存在未结算计划 ${key}：${state[key].id || state[key].compoundId || 'unknown'}`)
  }
  if (String(state.position.tokenId) !== MAIN_ROLL_EXPECTED_SOURCE_TOKEN_ID) {
    throw new Error(`活动主仓 NFT=${state.position.tokenId}，预期为 ${MAIN_ROLL_EXPECTED_SOURCE_TOKEN_ID}`)
  }
  if (MAIN_ROLL_TICK_LOWER % poolKey.tickSpacing !== 0 || MAIN_ROLL_TICK_UPPER % poolKey.tickSpacing !== 0) {
    throw new Error(`主仓目标 tick 未按 tickSpacing 对齐：[${MAIN_ROLL_TICK_LOWER},${MAIN_ROLL_TICK_UPPER})`)
  }

  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const source = { ...state.position }
  const allRecords = activePairPositionRecords(state)
  const otherRecords = allRecords.filter((item) => String(item.tokenId) !== MAIN_ROLL_EXPECTED_SOURCE_TOKEN_ID)
  const [
    blockNumber,
    nonceLatest,
    noncePending,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    gasPrice,
    spyMark,
    sourceOwner,
    sourceLiquidity,
    sourceFees,
    otherReads,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    getPoolState(),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getGasPrice(),
    quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [BigInt(source.tokenId)],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(source.tokenId)],
    }),
    getAccruedFees(BigInt(source.tokenId), source.tickLower, source.tickUpper),
    Promise.all(
      otherRecords.map(async (record) => {
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
        return { tokenId: String(record.tokenId), owner, liquidity, expectedLiquidity: BigInt(record.liquidity) }
      }),
    ),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (sourceOwner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`主仓 NFT ${source.tokenId} 不在执行钱包`)
  if (sourceLiquidity === 0n || sourceLiquidity !== BigInt(source.liquidity)) {
    throw new Error(`主仓流动性不一致：chain=${sourceLiquidity}, local=${source.liquidity}`)
  }
  if (sourceFees.liquidity !== sourceLiquidity) throw new Error('主仓手续费读回的流动性不一致')
  for (const item of otherReads) {
    if (item.owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`受保护 LP ${item.tokenId} 不在执行钱包`)
    if (item.liquidity !== item.expectedLiquidity) throw new Error(`受保护 LP ${item.tokenId} 流动性不一致`)
  }
  const duplicate = otherRecords.find(
    (record) => record.tickLower === MAIN_ROLL_TICK_LOWER && record.tickUpper === MAIN_ROLL_TICK_UPPER,
  )
  if (duplicate) throw new Error(`主仓目标区间已有活动头寸 NFT ${duplicate.tokenId}`)
  const rangePositionBps = customRangePositionBps(poolState.tick, MAIN_ROLL_TICK_LOWER, MAIN_ROLL_TICK_UPPER)
  if (rangePositionBps < MAIN_ROLL_MIN_RANGE_POSITION_BPS || rangePositionBps > MAIN_ROLL_MAX_RANGE_POSITION_BPS) {
    throw new Error(`现价距主仓目标区间边界过近：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
  }

  const removal = buildFullRemove(source, sourceLiquidity, poolState)
  const sourceSpyWei = removal.amount0Principal + sourceFees.spyWei
  const sourcePairWei = removal.amount1Principal + sourceFees.pairWei
  if (sourceSpyWei === 0n && sourcePairWei === 0n) throw new Error('主仓可迁移资产为 0')
  const rebalance = await solveCustomRangeRebalance(
    sourceSpyWei,
    sourcePairWei,
    poolState,
    MAIN_ROLL_TICK_LOWER,
    MAIN_ROLL_TICK_UPPER,
  )
  if (rebalance.direction !== 'SPY_TO_PAIR') {
    throw new Error(`主仓目标区间当前需要 ${rebalance.direction}，不符合本次“现在买入 PAIR”的授权`)
  }
  const priceGuard = mainRollPriceGuard(poolState, spyMark, rebalance.amountIn, rebalance.amountOut)
  const sourceValue = tokenAmountsUsdg(sourceSpyWei, sourcePairWei, poolState, spyMark)
  const removeBudget = await transactionBudget(POSITION_MANAGER, removal.data)
  // Recent canonical receipts for Permit2 refresh + swap + mint consumed about
  // 580k gas. Use a 5% unit buffer here; every broadcast separately enforces
  // the hard 0.02 ETH post-transaction reserve against its full gas limit.
  const remainingGasBudget = gasPrice * 609_000n
  const requiredEth = MAIN_ROLL_MIN_ETH_RESERVE + removeBudget.budget + remainingGasBudget
  if (ethBalance < requiredEth) {
    throw new Error(`主仓迁移 ETH 储备不足：余额=${formatEther(ethBalance)}，保守需要=${formatEther(requiredEth)}`)
  }

  const oldPrices = customRangePricesUsdg(priceGuard.spyPriceUsdg, source.tickLower, source.tickUpper)
  const targetPrices = customRangePricesUsdg(priceGuard.spyPriceUsdg, MAIN_ROLL_TICK_LOWER, MAIN_ROLL_TICK_UPPER)
  const report = {
    status: 'READY_TO_ROLL_MAIN_POSITION',
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    pool: {
      currentTick: poolState.tick,
      spyPriceUsdg: priceGuard.spyPriceUsdg.toFixed(6),
      currentPairPriceUsdg: priceGuard.spotPairPriceUsdg.toFixed(8),
    },
    source: {
      tokenId: String(source.tokenId),
      tickLower: source.tickLower,
      tickUpper: source.tickUpper,
      priceRangeUsdg: { low: oldPrices.low.toFixed(8), high: oldPrices.high.toFixed(8) },
      liquidity: sourceLiquidity,
      principal: { spy: formatUnits(removal.amount0Principal, 18), pair: formatUnits(removal.amount1Principal, 18) },
      accruedFees: { spy: formatUnits(sourceFees.spyWei, 18), pair: formatUnits(sourceFees.pairWei, 18) },
      totalMarkedUsdg: formatUnits(sourceValue.totalUsdg, 6),
    },
    target: {
      mode: 'focused_high_fee_main',
      tickLower: MAIN_ROLL_TICK_LOWER,
      tickUpper: MAIN_ROLL_TICK_UPPER,
      priceRangeUsdg: { low: targetPrices.low.toFixed(8), high: targetPrices.high.toFixed(8) },
      rangePositionPct: (Number(rangePositionBps) / 100).toFixed(2),
    },
    rebalance: {
      direction: rebalance.direction,
      inputSpy: formatUnits(rebalance.amountIn, 18),
      quotedPair: formatUnits(rebalance.amountOut, 18),
      expectedAveragePairPriceUsdg: priceGuard.averagePairPriceUsdg.toFixed(8),
      expectedPostSwapSpy: formatUnits(rebalance.expectedSpyWei, 18),
      expectedPostSwapPair: formatUnits(rebalance.expectedPairWei, 18),
      targetValueSplitPct: {
        spy: (Number(rebalance.targetSpyValueBps) / 100).toFixed(2),
        pair: (Number(rebalance.targetPairValueBps) / 100).toFixed(2),
      },
      slippageBps: Number(SWAP_SLIPPAGE_BPS),
    },
    protectedPositions: otherReads.map((item) => ({ tokenId: item.tokenId, liquidityInvariant: item.liquidity })),
    walletBaselineExcluded: { spy: formatUnits(spyBalance, 18), pair: formatUnits(pairBalance, 18) },
    gas: {
      gasPriceGwei: (Number(gasPrice) / 1e9).toFixed(6),
      ethBalance: formatEther(ethBalance),
      removeMaxBudgetEth: formatEther(removeBudget.budget),
      conservativeRequiredEth: formatEther(requiredEth),
      retainedMinimumEth: formatEther(MAIN_ROLL_MIN_ETH_RESERVE),
    },
    priceGuard: {
      maxSpotPairUsdg: MAIN_ROLL_MAX_SPOT_PAIR_USDG.toFixed(5),
      maxAveragePairUsdg: MAIN_ROLL_MAX_AVERAGE_PAIR_USDG.toFixed(5),
    },
    policy: {
      migrateOnlyTokenId: MAIN_ROLL_EXPECTED_SOURCE_TOKEN_ID,
      useOnlyWithdrawnPrincipalAndSourceFees: true,
      preserveWalletTokenBaseline: true,
      preserveOtherLpLiquidity: true,
      burnSourceNft: false,
      autoExit: false,
    },
  }
  appendAudit('main_roll_preflight', report)
  if (print) console.log(stringify(report))
  return {
    state,
    source,
    otherReads,
    blockNumber,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    sourceLiquidity,
    sourceFees,
    report,
  }
}

function rememberMainTransaction(state, pending, result) {
  if (!result) {
    pending.currentStep = null
    writeState(state)
    return
  }
  pending.transactions = [...new Set([...(pending.transactions || []), result.hash])]
  pending.currentStep = null
  writeState(state)
}

async function confirmedMainTransactions(pending) {
  const results = []
  for (const hash of [...new Set(pending.transactions || [])]) {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`主仓迁移历史交易回执不是 success：${hash}`)
    results.push({ hash, receipt, gasCost: receipt.gasUsed * receipt.effectiveGasPrice })
  }
  return results
}

async function confirmedFailedMainTransactions(pending) {
  const results = []
  for (const hash of [...new Set(pending.failedTransactions || [])]) {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    if (receipt.status !== 'reverted') throw new Error(`主仓迁移失败交易状态异常：${hash}`)
    results.push({ hash, receipt, gasCost: receipt.gasUsed * receipt.effectiveGasPrice })
  }
  return results
}

async function readMainProtectedInvariants(pending) {
  return Promise.all(
    pending.protectedPositions.map(async (item) => {
      const [owner, liquidity] = await Promise.all([
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [BigInt(item.tokenId)],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(item.tokenId)],
        }),
      ])
      if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`受保护 LP ${item.tokenId} 所有权发生变化`)
      if (liquidity !== BigInt(item.liquidity)) throw new Error(`受保护 LP ${item.tokenId} 流动性发生变化`)
      return { tokenId: String(item.tokenId), liquidity }
    }),
  )
}

async function resolveMainUnknownTransaction(state, pending) {
  if (!(pending.unknownTransactions || []).length) return
  for (const item of pending.unknownTransactions) {
    const receipt = await publicClient.getTransactionReceipt({ hash: item.hash })
    if (receipt.status === 'reverted') {
      pending.failedTransactions = [...new Set([...(pending.failedTransactions || []), item.hash])]
      pending.unknownTransactions = pending.unknownTransactions.filter((entry) => entry.hash !== item.hash)
      pending.currentStep = null
      writeState(state)
      throw new Error(`主仓迁移先前回执已确认失败，禁止自动重试：${item.hash}`)
    }
    pending.transactions = [...new Set([...(pending.transactions || []), item.hash])]
    if (item.step === 'remove') pending.removeTransaction = item.hash
    if (item.step === 'swap') pending.swapTransaction = item.hash
    if (item.step === 'mint') pending.mintTransaction = item.hash
    pending.unknownTransactions = pending.unknownTransactions.filter((entry) => entry.hash !== item.hash)
    pending.currentStep = null
    writeState(state)
  }
}

async function reconcileMainRemoval(state, pending) {
  if (!pending.removeTransaction || pending.withdrawnSpyWei !== undefined) return
  const [receipt, spyBalance, pairBalance, sourceLiquidity] = await Promise.all([
    publicClient.getTransactionReceipt({ hash: pending.removeTransaction }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(pending.source.tokenId)],
    }),
  ])
  if (receipt.status !== 'success') throw new Error(`主仓撤出回执不是 success：${pending.removeTransaction}`)
  if (sourceLiquidity !== 0n) throw new Error(`主仓撤出后 liquidity=${sourceLiquidity}`)
  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  if (spyBalance < baselineSpy || pairBalance < baselinePair) throw new Error('主仓撤出后钱包余额低于既有基线')
  pending.withdrawnSpyWei = (spyBalance - baselineSpy).toString()
  pending.withdrawnPairWei = (pairBalance - baselinePair).toString()
  pending.availableSpyWei = pending.withdrawnSpyWei
  pending.availablePairWei = pending.withdrawnPairWei
  pending.status = 'source_removed'
  writeState(state)
}

async function reconcileMainSwap(state, pending) {
  if (!pending.swapTransaction || pending.rebalanceComplete) return
  if (!pending.swapPlan) throw new Error('主仓配平交易存在，但缺少配平计划')
  const receipt = await publicClient.getTransactionReceipt({ hash: pending.swapTransaction })
  if (receipt.status !== 'success') throw new Error(`主仓配平回执不是 success：${pending.swapTransaction}`)
  const spyNet = tokenNetFromReceipt(receipt, SPY)
  const pairNet = tokenNetFromReceipt(receipt, PAIR)
  const actualInput = -spyNet
  const actualOutput = pairNet
  if (actualInput !== BigInt(pending.swapPlan.inputWei) || actualOutput < BigInt(pending.swapPlan.minimumOutputWei)) {
    throw new Error('主仓配平回执中的实际输入或输出不符合保护条件')
  }
  const price = mainRollPriceGuard(
    { tick: pending.swapPlan.poolTick },
    { amountOut: BigInt(pending.swapPlan.spyMarkAmountOut) },
    actualInput,
    actualOutput,
  )
  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  const [walletSpy, walletPair] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  if (walletSpy < baselineSpy || walletPair < baselinePair) throw new Error('主仓配平后钱包余额低于既有基线')
  pending.rebalance = {
    direction: 'SPY_TO_PAIR',
    inputWei: actualInput.toString(),
    outputWei: actualOutput.toString(),
    minimumOutputWei: pending.swapPlan.minimumOutputWei,
    averagePairPriceUsdg: price.averagePairPriceUsdg.toFixed(8),
    transaction: pending.swapTransaction,
  }
  pending.availableSpyWei = (walletSpy - baselineSpy).toString()
  pending.availablePairWei = (walletPair - baselinePair).toString()
  pending.rebalanceComplete = true
  pending.status = 'rebalanced'
  writeState(state)
}

async function finalizeMainRoll(state, pending) {
  if (!pending.mintTransaction || !pending.mintPlan) throw new Error('主仓迁移尚无可结算的 mint 交易')
  const mintReceipt = await publicClient.getTransactionReceipt({ hash: pending.mintTransaction })
  if (mintReceipt.status !== 'success') throw new Error(`主仓 mint 回执不是 success：${pending.mintTransaction}`)
  const newTokenId = parseMintTokenId(mintReceipt)
  if (newTokenId === null) throw new Error(`主仓 mint 成功但未解析到 NFT tokenId：${pending.mintTransaction}`)
  const [
    newOwner,
    newLiquidity,
    sourceOwner,
    sourceLiquidityAfter,
    finalEth,
    finalSpy,
    finalPair,
    finalPoolState,
    invariants,
  ] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [newTokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [newTokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [BigInt(pending.source.tokenId)],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(pending.source.tokenId)],
    }),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
    readMainProtectedInvariants(pending),
  ])
  if (newOwner.toLowerCase() !== WALLET.toLowerCase() || newLiquidity === 0n)
    throw new Error('新主仓 NFT 链上读回不完整')
  if (newLiquidity !== BigInt(pending.mintPlan.liquidity))
    throw new Error(`新主仓流动性与计划不一致：chain=${newLiquidity}, plan=${pending.mintPlan.liquidity}`)
  if (sourceOwner.toLowerCase() !== WALLET.toLowerCase()) throw new Error('旧主仓 NFT 被意外转移或销毁')
  if (sourceLiquidityAfter !== 0n) throw new Error(`旧主仓 liquidity=${sourceLiquidityAfter}，预期为 0`)
  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  if (finalSpy < baselineSpy || finalPair < baselinePair) throw new Error('主仓迁移动用了钱包既有代币')
  if (finalEth < MAIN_ROLL_MIN_ETH_RESERVE) throw new Error(`建仓后 ETH 低于 0.02 储备：${formatEther(finalEth)}`)
  if (String(state.position?.tokenId) !== String(pending.source.tokenId))
    throw new Error('本地主仓已变化，禁止覆盖结算')

  const finalPosition = new Position({
    pool: makePool(finalPoolState),
    liquidity: newLiquidity.toString(),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
  })
  const underlyingSpyWei = asBigInt(finalPosition.amount0.quotient)
  const underlyingPairWei = asBigInt(finalPosition.amount1.quotient)
  const residualSpyWei = finalSpy - baselineSpy
  const residualPairWei = finalPair - baselinePair
  let priceSnapshot = null
  let marked = null
  try {
    const finalSpyMark = await quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT)
    const price = mainRollPriceGuard(finalPoolState, finalSpyMark)
    const prices = customRangePricesUsdg(price.spyPriceUsdg, pending.tickLower, pending.tickUpper)
    const positionValue = tokenAmountsUsdg(underlyingSpyWei, underlyingPairWei, finalPoolState, finalSpyMark)
    const residualValue = tokenAmountsUsdg(residualSpyWei, residualPairWei, finalPoolState, finalSpyMark)
    const totalValue = positionValue.totalUsdg + residualValue.totalUsdg
    const residualBps = totalValue === 0n ? 0n : (residualValue.totalUsdg * 10_000n) / totalValue
    priceSnapshot = {
      spyPriceUsdg: price.spyPriceUsdg.toFixed(6),
      actualPairPriceLowUsdg: prices.low.toFixed(8),
      actualPairPriceHighUsdg: prices.high.toFixed(8),
      currentPairPriceUsdg: price.spotPairPriceUsdg.toFixed(8),
      currentTick: finalPoolState.tick,
    }
    marked = {
      positionUsdg: positionValue.totalUsdg.toString(),
      residualUsdg: residualValue.totalUsdg.toString(),
      residualBps: residualBps.toString(),
    }
  } catch (error) {
    marked = { warning: `最终估值读取失败：${error.shortMessage || error.message}` }
  }
  const transactions = await confirmedMainTransactions(pending)
  const failedTransactions = await confirmedFailedMainTransactions(pending)
  const completedAt = new Date().toISOString()
  const sourceRecord = { ...state.position }
  const record = {
    id: pending.id,
    status: 'complete',
    completedAt,
    source: {
      tokenId: String(pending.source.tokenId),
      tickLower: pending.source.tickLower,
      tickUpper: pending.source.tickUpper,
      liquidityBefore: pending.source.liquidity,
      liquidityAfter: sourceLiquidityAfter.toString(),
      burned: false,
      accruedFeesAtPreflight: pending.sourceFeesAtPreflight,
      withdrawnSpyWei: pending.withdrawnSpyWei,
      withdrawnPairWei: pending.withdrawnPairWei,
      removalTransaction: pending.removeTransaction,
    },
    target: {
      tokenId: newTokenId.toString(),
      tickLower: pending.tickLower,
      tickUpper: pending.tickUpper,
      liquidity: newLiquidity.toString(),
      desiredSpyWei: pending.mintPlan.desiredSpyWei,
      desiredPairWei: pending.mintPlan.desiredPairWei,
      underlyingSpyWei: underlyingSpyWei.toString(),
      underlyingPairWei: underlyingPairWei.toString(),
      mintBlock: mintReceipt.blockNumber.toString(),
      mintTransaction: pending.mintTransaction,
    },
    rebalance: pending.rebalance,
    residual: { spyWei: residualSpyWei.toString(), pairWei: residualPairWei.toString(), ...marked },
    priceSnapshot,
    priceGuard: pending.priceGuard,
    excludedWalletBaseline: { spyWei: pending.baselineSpyWei, pairWei: pending.baselinePairWei },
    protectedPositionInvariants: invariants.map((item) => ({
      tokenId: item.tokenId,
      liquidityAfter: item.liquidity.toString(),
    })),
    gasSpentWei: receiptGasTotal([...transactions, ...failedTransactions]).toString(),
    finalEthWei: finalEth.toString(),
    transactions: pending.transactions,
    failedTransactions: pending.failedTransactions || [],
  }
  state.retiredPositions = [
    ...(state.retiredPositions || []),
    {
      ...sourceRecord,
      status: 'main_rolled_empty',
      liquidity: '0',
      retiredAt: completedAt,
      mainRollId: pending.id,
      removalTransaction: pending.removeTransaction,
      burned: false,
    },
  ]
  state.satellites = (state.satellites || []).map((item) =>
    String(item.tokenId) === String(pending.source.tokenId)
      ? { ...item, status: 'retired_main_empty', liquidity: '0', retiredAt: completedAt, retiredByMainRoll: pending.id }
      : item,
  )
  state.position = {
    tokenId: newTokenId.toString(),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
    liquidity: newLiquidity.toString(),
    mintBlock: mintReceipt.blockNumber.toString(),
    mintTransaction: pending.mintTransaction,
    createdByMainRoll: pending.id,
  }
  state.policy = {
    ...(state.policy || {}),
    targetTickLower: pending.tickLower,
    targetTickUpper: pending.tickUpper,
    primaryStrategy: 'focused_high_fee_main',
    earlyExitOutOfRange: false,
    autoExit: false,
  }
  state.mainRolls = [...(state.mainRolls || []), record]
  delete state.pendingMainRoll
  writeState(state)
  appendAudit('main_roll_complete', record)
  console.log(
    stringify({
      status: 'MAIN_ROLL_COMPLETE',
      sourceNft: { tokenId: pending.source.tokenId, liquidity: sourceLiquidityAfter, burned: false },
      activeNft: {
        tokenId: newTokenId,
        liquidity: newLiquidity,
        tickLower: pending.tickLower,
        tickUpper: pending.tickUpper,
        inRange: finalPoolState.tick >= pending.tickLower && finalPoolState.tick < pending.tickUpper,
      },
      priceSnapshot,
      withdrawn: {
        spy: formatUnits(BigInt(pending.withdrawnSpyWei), 18),
        pair: formatUnits(BigInt(pending.withdrawnPairWei), 18),
      },
      rebalance: record.rebalance,
      lpUnderlying: { spy: formatUnits(underlyingSpyWei, 18), pair: formatUnits(underlyingPairWei, 18) },
      residual: { spy: formatUnits(residualSpyWei, 18), pair: formatUnits(residualPairWei, 18), marked },
      protectedPositionsUnchanged: true,
      gasSpentEth: formatEther(BigInt(record.gasSpentWei)),
      finalEth: formatEther(finalEth),
      transactions: record.transactions,
    }),
  )
  return record
}

async function continueMainRoll(state, pending) {
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  await resolveMainUnknownTransaction(state, pending)
  await confirmedMainTransactions(pending)
  if ((pending.failedTransactions || []).length) {
    throw new Error(`主仓迁移已有失败交易，禁止自动重试：${pending.failedTransactions.join(',')}`)
  }
  const [nonceLatest, noncePending] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`执行前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  await readMainProtectedInvariants(pending)
  if (pending.mintTransaction) return finalizeMainRoll(state, pending)

  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  if (!pending.removeTransaction) {
    const [spyBefore, pairBefore, sourceOwner, sourceLiquidity, poolState, spyMark] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [BigInt(pending.source.tokenId)],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(pending.source.tokenId)],
      }),
      getPoolState(),
      quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT),
    ])
    if (spyBefore !== baselineSpy || pairBefore !== baselinePair) throw new Error('撤仓前钱包代币余额偏离计划基线')
    if (sourceOwner.toLowerCase() !== WALLET.toLowerCase()) throw new Error('撤仓前主仓 NFT 所有权发生变化')
    if (sourceLiquidity !== BigInt(pending.source.liquidity)) throw new Error('撤仓前主仓流动性发生变化')
    const rangePositionBps = customRangePositionBps(poolState.tick, pending.tickLower, pending.tickUpper)
    if (rangePositionBps < MAIN_ROLL_MIN_RANGE_POSITION_BPS || rangePositionBps > MAIN_ROLL_MAX_RANGE_POSITION_BPS) {
      throw new Error(`撤仓前现价已偏离主仓目标区间安全区域：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
    }
    mainRollPriceGuard(poolState, spyMark)
    const removal = buildFullRemove(pending.source, sourceLiquidity, poolState)
    pending.currentStep = 'remove'
    writeState(state)
    const removed = await sendChecked(walletClient, {
      label: `主仓迁移 1/3 撤出 NFT ${pending.source.tokenId} (${pending.id})`,
      to: POSITION_MANAGER,
      data: removal.data,
      minimumBalanceAfter: MAIN_ROLL_MIN_ETH_RESERVE,
      fast: true,
      gasPriceMultiplierBps: 11_000n,
      gasBudgetSafetyBps: 10_000n,
    })
    pending.removeTransaction = removed.hash
    rememberMainTransaction(state, pending, removed)
  }
  await reconcileMainRemoval(state, pending)

  if (!pending.rebalanceComplete) {
    const [walletSpy, walletPair, poolState, spyMark] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      getPoolState(),
      quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT),
    ])
    const availableSpy = BigInt(pending.availableSpyWei)
    const availablePair = BigInt(pending.availablePairWei)
    if (walletSpy !== baselineSpy + availableSpy || walletPair !== baselinePair + availablePair) {
      throw new Error('配平前钱包余额不等于既有基线加主仓撤出资产')
    }
    const rangePositionBps = customRangePositionBps(poolState.tick, pending.tickLower, pending.tickUpper)
    if (rangePositionBps < MAIN_ROLL_MIN_RANGE_POSITION_BPS || rangePositionBps > MAIN_ROLL_MAX_RANGE_POSITION_BPS) {
      throw new Error(`配平前现价已偏离主仓目标区间安全区域：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
    }
    const plan = await solveCustomRangeRebalance(
      availableSpy,
      availablePair,
      poolState,
      pending.tickLower,
      pending.tickUpper,
    )
    if (plan.direction !== 'SPY_TO_PAIR')
      throw new Error(`主仓配平方向变为 ${plan.direction}，不符合本次买入 PAIR 授权`)
    mainRollPriceGuard(poolState, spyMark, plan.amountIn, plan.amountOut)

    pending.currentStep = 'approve_swap_erc20'
    writeState(state)
    rememberMainTransaction(
      state,
      pending,
      await approveErc20(
        walletClient,
        SPY,
        plan.amountIn,
        `主仓迁移授权 SPY 给 Permit2 (${pending.id})`,
        MAIN_ROLL_MIN_ETH_RESERVE,
      ),
    )
    pending.currentStep = 'approve_swap_permit2'
    writeState(state)
    rememberMainTransaction(
      state,
      pending,
      await approvePermit2(
        walletClient,
        SPY,
        UNIVERSAL_ROUTER,
        plan.amountIn,
        `主仓迁移授权路由使用 SPY (${pending.id})`,
        MAIN_ROLL_MIN_ETH_RESERVE,
      ),
    )

    const liveQuote = await quotePairPoolSwap(plan.amountIn, true)
    const livePrice = mainRollPriceGuard(poolState, spyMark, plan.amountIn, liveQuote.amountOut)
    const slippageMinimum = bpsFloor(liveQuote.amountOut, SWAP_SLIPPAGE_BPS)
    const priceCapMinimum = mainRollMinimumPairOutput(plan.amountIn, spyMark)
    const minimumOutput = slippageMinimum > priceCapMinimum ? slippageMinimum : priceCapMinimum
    if (minimumOutput > liveQuote.amountOut) throw new Error('PAIR 实时报价无法满足最高成交均价保护')
    pending.swapPlan = {
      inputWei: plan.amountIn.toString(),
      quotedOutputWei: liveQuote.amountOut.toString(),
      minimumOutputWei: minimumOutput.toString(),
      expectedAveragePairPriceUsdg: livePrice.averagePairPriceUsdg.toFixed(8),
      spyMarkAmountOut: spyMark.amountOut.toString(),
      poolTick: poolState.tick,
    }
    pending.currentStep = 'swap'
    pending.status = 'swap_prepared'
    writeState(state)
    const swapData = buildV4SwapData(plan.amountIn, minimumOutput, BigInt(nowSeconds() + 5 * 60), true)
    const swapped = await sendChecked(walletClient, {
      label: `主仓迁移 2/3 配平 SPY→PAIR (${pending.id})`,
      to: UNIVERSAL_ROUTER,
      data: swapData,
      minimumBalanceAfter: MAIN_ROLL_MIN_ETH_RESERVE,
      fast: true,
      gasPriceMultiplierBps: 11_000n,
      gasBudgetSafetyBps: 10_000n,
    })
    pending.swapTransaction = swapped.hash
    rememberMainTransaction(state, pending, swapped)
    await reconcileMainSwap(state, pending)
  }

  await readMainProtectedInvariants(pending)
  const [poolStateBeforeMint, spyMarkBeforeMint, spyBeforeMint, pairBeforeMint] = await Promise.all([
    getPoolState(),
    quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  mainRollPriceGuard(poolStateBeforeMint, spyMarkBeforeMint)
  const availableSpy = BigInt(pending.availableSpyWei)
  const availablePair = BigInt(pending.availablePairWei)
  if (spyBeforeMint !== baselineSpy + availableSpy || pairBeforeMint !== baselinePair + availablePair) {
    throw new Error('铸造前钱包余额不等于既有基线加主仓迁移资产')
  }
  const rangePositionBps = customRangePositionBps(poolStateBeforeMint.tick, pending.tickLower, pending.tickUpper)
  if (rangePositionBps < MAIN_ROLL_MIN_RANGE_POSITION_BPS || rangePositionBps > MAIN_ROLL_MAX_RANGE_POSITION_BPS) {
    throw new Error(
      `铸造前现价已偏离主仓目标区间安全区域：tick=${poolStateBeforeMint.tick}, rangeBps=${rangePositionBps}`,
    )
  }
  pending.currentStep = 'approve_mint_spy'
  writeState(state)
  rememberMainTransaction(
    state,
    pending,
    await approveErc20(
      walletClient,
      SPY,
      availableSpy,
      `主仓迁移确认 SPY Permit2 授权 (${pending.id})`,
      MAIN_ROLL_MIN_ETH_RESERVE,
    ),
  )
  pending.currentStep = 'approve_mint_pair'
  writeState(state)
  rememberMainTransaction(
    state,
    pending,
    await approveErc20(
      walletClient,
      PAIR,
      availablePair,
      `主仓迁移确认 PAIR Permit2 授权 (${pending.id})`,
      MAIN_ROLL_MIN_ETH_RESERVE,
    ),
  )
  const mint = await buildCustomRangeMint(account, availableSpy, availablePair, pending.tickLower, pending.tickUpper, {
    minimumRangePositionBps: MAIN_ROLL_MIN_RANGE_POSITION_BPS,
    maximumRangePositionBps: MAIN_ROLL_MAX_RANGE_POSITION_BPS,
    slippageTolerance: MAIN_ROLL_MINT_SLIPPAGE,
  })
  if (mint.amount0Max > availableSpy || mint.amount1Max > availablePair) throw new Error('新主仓滑点上限超过迁移资产')
  pending.mintPlan = {
    liquidity: mint.liquidity.toString(),
    desiredSpyWei: mint.amount0Desired.toString(),
    desiredPairWei: mint.amount1Desired.toString(),
    maxSpyWei: mint.amount0Max.toString(),
    maxPairWei: mint.amount1Max.toString(),
  }
  pending.currentStep = 'mint'
  pending.status = 'mint_prepared'
  writeState(state)
  const minted = await sendChecked(walletClient, {
    label: `主仓迁移 3/3 铸造新 PAIR/SPY LP (${pending.id})`,
    to: POSITION_MANAGER,
    data: mint.data,
    minimumBalanceAfter: MAIN_ROLL_MIN_ETH_RESERVE,
    fast: true,
    gasPriceMultiplierBps: 11_000n,
    gasBudgetSafetyBps: 10_000n,
  })
  pending.mintTransaction = minted.hash
  rememberMainTransaction(state, pending, minted)
  return finalizeMainRoll(state, pending)
}

function markMainRollPartial(operationId, error) {
  const latestState = readState()
  if (!latestState?.pendingMainRoll || latestState.pendingMainRoll.id !== operationId) return
  const pending = latestState.pendingMainRoll
  const message = error.shortMessage || error.message
  const hash = String(message).match(/0x[0-9a-fA-F]{64}/)?.[0]
  if (hash && String(message).includes('回执未知')) {
    const entry = { hash, step: pending.currentStep || 'unknown' }
    pending.unknownTransactions = [...(pending.unknownTransactions || []).filter((item) => item.hash !== hash), entry]
  } else if (hash) {
    pending.failedTransactions = [...new Set([...(pending.failedTransactions || []), hash])]
  }
  const hasChainActivity =
    (pending.transactions || []).length ||
    (pending.failedTransactions || []).length ||
    (pending.unknownTransactions || []).length ||
    pending.removeTransaction
  if (!hasChainActivity) {
    delete latestState.pendingMainRoll
  } else {
    pending.status = pending.mintTransaction ? 'mint_confirmed_needs_readback' : 'partial'
    pending.lastErrorAt = new Date().toISOString()
    pending.lastError = message
  }
  writeState(latestState)
  appendAudit('main_roll_partial', {
    id: operationId,
    status: pending.status,
    message,
    transactions: pending.transactions || [],
    failedTransactions: pending.failedTransactions || [],
    unknownTransactions: pending.unknownTransactions || [],
  })
}

async function mainRollEnter() {
  const check = await mainRollPreflight({ print: true })
  const operationId = `main-roll-${new Date().toISOString().replace(/[-:.]/g, '')}`
  const state = check.state
  state.pendingMainRoll = {
    id: operationId,
    status: 'planned',
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    tickLower: MAIN_ROLL_TICK_LOWER,
    tickUpper: MAIN_ROLL_TICK_UPPER,
    baselineEthWei: check.ethBalance.toString(),
    baselineSpyWei: check.spyBalance.toString(),
    baselinePairWei: check.pairBalance.toString(),
    source: {
      tokenId: String(check.source.tokenId),
      tickLower: check.source.tickLower,
      tickUpper: check.source.tickUpper,
      liquidity: check.sourceLiquidity.toString(),
    },
    sourceFeesAtPreflight: { spyWei: check.sourceFees.spyWei.toString(), pairWei: check.sourceFees.pairWei.toString() },
    protectedPositions: check.otherReads.map((item) => ({
      tokenId: item.tokenId,
      liquidity: item.liquidity.toString(),
    })),
    priceGuard: {
      maxSpotPairUsdg: MAIN_ROLL_MAX_SPOT_PAIR_USDG.toFixed(5),
      maxAveragePairUsdg: MAIN_ROLL_MAX_AVERAGE_PAIR_USDG.toFixed(5),
    },
    transactions: [],
    failedTransactions: [],
    unknownTransactions: [],
  }
  writeState(state)
  appendAudit('main_roll_plan_created', state.pendingMainRoll)
  try {
    return await continueMainRoll(state, state.pendingMainRoll)
  } catch (error) {
    markMainRollPartial(operationId, error)
    throw error
  }
}

async function mainRollResume() {
  const state = readState()
  const pending = state?.pendingMainRoll
  if (!state || state.status !== 'active' || !pending) throw new Error('没有可恢复的主仓迁移计划')
  try {
    return await continueMainRoll(state, pending)
  } catch (error) {
    markMainRollPartial(pending.id, error)
    throw error
  }
}

async function attackCompoundPreflight({ print = true } = {}) {
  const state = readState()
  if (!state || state.status !== 'active' || !state.position?.tokenId) throw new Error('没有活动的 PAIR/SPY 主仓')
  for (const key of [
    'pendingIncrease',
    'pendingSatellite',
    'pendingMigration',
    'pendingUpperRange',
    'pendingFeeBand',
    'pendingAttackRoll',
    'pendingAttackCompound',
    'pendingAttackResidual',
    'pendingMainRoll',
    'pendingCurrentBand',
  ]) {
    if (state[key]) throw new Error(`存在未结算计划 ${key}：${state[key].id || 'unknown'}`)
  }
  const targetRecord = (state.satellites || []).find(
    (item) => item.status === 'active' && String(item.tokenId) === ATTACK_COMPOUND_TARGET_TOKEN_ID,
  )
  if (!targetRecord) throw new Error(`没有找到活动的进攻仓 NFT ${ATTACK_COMPOUND_TARGET_TOKEN_ID}`)

  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const positionRecords = activePairPositionRecords(state)
  const [
    blockNumber,
    nonceLatest,
    noncePending,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    gasPrice,
    spyMark,
    positionReads,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    getPoolState(),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getGasPrice(),
    quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT),
    Promise.all(
      positionRecords.map(async (record) => {
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
          getAccruedFees(tokenId, record.tickLower, record.tickUpper),
        ])
        return { record, tokenId, owner, liquidity, fees }
      }),
    ),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)

  for (const item of positionReads) {
    if (item.owner.toLowerCase() !== WALLET.toLowerCase())
      throw new Error(`LP NFT ${item.tokenId} 不在执行钱包：owner=${item.owner}`)
    if (item.liquidity === 0n) throw new Error(`LP NFT ${item.tokenId} 流动性为 0`)
    if (item.liquidity !== BigInt(item.record.liquidity)) {
      throw new Error(
        `LP NFT ${item.tokenId} 流动性与本地账本不一致：chain=${item.liquidity}, local=${item.record.liquidity}`,
      )
    }
    if (item.fees.liquidity !== item.liquidity) throw new Error(`LP NFT ${item.tokenId} 手续费状态流动性不一致`)
  }

  if (poolState.tick < targetRecord.tickLower || poolState.tick >= targetRecord.tickUpper) {
    throw new Error(`当前 tick=${poolState.tick} 不在进攻仓区间 [${targetRecord.tickLower},${targetRecord.tickUpper})`)
  }
  const rangePositionBps = customRangePositionBps(poolState.tick, targetRecord.tickLower, targetRecord.tickUpper)
  if (rangePositionBps < ATTACK_MIN_RANGE_POSITION_BPS || rangePositionBps > ATTACK_MAX_RANGE_POSITION_BPS) {
    throw new Error(`当前价格距进攻仓边界过近：rangeBps=${rangePositionBps}`)
  }

  const accruedSpyWei = positionReads.reduce((sum, item) => sum + item.fees.spyWei, 0n)
  const accruedPairWei = positionReads.reduce((sum, item) => sum + item.fees.pairWei, 0n)
  if (accruedSpyWei === 0n && accruedPairWei === 0n) throw new Error('活动 LP 当前没有可复投手续费')
  const rebalance = await solveCustomRangeRebalance(
    accruedSpyWei,
    accruedPairWei,
    poolState,
    targetRecord.tickLower,
    targetRecord.tickUpper,
  )
  const feeValue = tokenAmountsUsdg(accruedSpyWei, accruedPairWei, poolState, spyMark)

  const collectBudgets = []
  for (const item of positionReads) {
    const collect = buildPositionCollect(item.record, item.liquidity, poolState)
    const budget = await transactionBudget(POSITION_MANAGER, collect.data)
    collectBudgets.push({ tokenId: item.tokenId, budget })
  }
  const collectGasBudget = collectBudgets.reduce((sum, item) => sum + item.budget.budget, 0n)
  // Covers a swap, optional allowance updates and a premium-priced increase.
  const remainingGasBudget = (gasPrice * 3_000_000n * 2n * 125n) / 100n
  const requiredEth = ATTACK_MIN_ETH_RESERVE + collectGasBudget + remainingGasBudget
  if (ethBalance < requiredEth) {
    throw new Error(`进攻仓复投 ETH 储备不足：余额=${formatEther(ethBalance)}，保守需要=${formatEther(requiredEth)}`)
  }

  const spyPriceUsdg = Number(formatUnits(spyMark.amountOut, 6)) / Number(formatUnits(ADD_SPY_MARK_INPUT, 18))
  const targetPrices = customRangePricesUsdg(spyPriceUsdg, targetRecord.tickLower, targetRecord.tickUpper)
  const report = {
    status: 'READY_TO_COLLECT_AND_COMPOUND_ATTACK_POSITION',
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    pool: {
      currentTick: poolState.tick,
      currentPairPriceUsdg: (spyPriceUsdg / Math.pow(1.0001, poolState.tick)).toFixed(8),
      spyPriceUsdg: spyPriceUsdg.toFixed(6),
    },
    target: {
      tokenId: String(targetRecord.tokenId),
      tickLower: targetRecord.tickLower,
      tickUpper: targetRecord.tickUpper,
      priceRangeUsdg: { low: targetPrices.low.toFixed(8), high: targetPrices.high.toFixed(8) },
      liquidityBefore: targetRecord.liquidity,
      rangePositionPct: (Number(rangePositionBps) / 100).toFixed(2),
      action: 'increase existing NFT; do not mint another NFT',
    },
    positionsToCollect: positionReads.map((item) => ({
      role: item.record.role,
      tokenId: item.tokenId.toString(),
      liquidity: item.liquidity.toString(),
      accruedFees: { spy: formatUnits(item.fees.spyWei, 18), pair: formatUnits(item.fees.pairWei, 18) },
      invariant: 'collect fees only; liquidity unchanged before final target increase',
    })),
    projectedFeeAssets: {
      spy: formatUnits(accruedSpyWei, 18),
      pair: formatUnits(accruedPairWei, 18),
      markedUsdg: formatUnits(feeValue.totalUsdg, 6),
    },
    rebalance: {
      direction: rebalance.direction,
      input: formatUnits(rebalance.amountIn, 18),
      quotedOutput: formatUnits(rebalance.amountOut, 18),
      expectedPostSwapSpy: formatUnits(rebalance.expectedSpyWei, 18),
      expectedPostSwapPair: formatUnits(rebalance.expectedPairWei, 18),
      targetValueSplitPct: {
        spy: (Number(rebalance.targetSpyValueBps) / 100).toFixed(2),
        pair: (Number(rebalance.targetPairValueBps) / 100).toFixed(2),
      },
      slippageBps: Number(SWAP_SLIPPAGE_BPS),
    },
    walletBaselineExcluded: {
      spy: formatUnits(spyBalance, 18),
      pair: formatUnits(pairBalance, 18),
    },
    gas: {
      ethBalance: formatEther(ethBalance),
      collectMaxBudgetEth: formatEther(collectGasBudget),
      conservativeRequiredEth: formatEther(requiredEth),
      retainedMinimumEth: formatEther(ATTACK_MIN_ETH_RESERVE),
    },
    policy: {
      collectAllActivePositionFees: true,
      targetExistingTokenId: ATTACK_COMPOUND_TARGET_TOKEN_ID,
      preserveWalletTokenBaseline: true,
      preserveNonTargetLpLiquidity: true,
      createNewNft: false,
      autoExit: false,
    },
  }
  appendAudit('attack_compound_preflight', report)
  if (print) console.log(stringify(report))
  return {
    state,
    targetRecord,
    positionReads,
    blockNumber,
    ethBalance,
    spyBalance,
    pairBalance,
    accruedSpyWei,
    accruedPairWei,
    report,
  }
}

function rememberAttackCompoundTransaction(state, pending, result) {
  if (!result) return
  pending.transactions = [...new Set([...(pending.transactions || []), result.hash])]
  writeState(state)
}

async function confirmedAttackCompoundTransactions(pending) {
  const results = []
  for (const hash of [...new Set(pending.transactions || [])]) {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`进攻仓复投历史交易回执不是 success：${hash}`)
    results.push({ hash, receipt, gasCost: receipt.gasUsed * receipt.effectiveGasPrice })
  }
  return results
}

async function confirmedFailedAttackCompoundTransactions(pending) {
  const results = []
  for (const hash of [...new Set(pending.failedTransactions || [])]) {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    if (receipt.status !== 'reverted') throw new Error(`进攻仓复投失败交易状态异常：${hash}`)
    results.push({ hash, receipt, gasCost: receipt.gasUsed * receipt.effectiveGasPrice })
  }
  return results
}

function collectedAttackCompoundTotals(pending) {
  return (pending.collections || []).reduce(
    (totals, item) => ({
      spyWei: totals.spyWei + BigInt(item.spyWei),
      pairWei: totals.pairWei + BigInt(item.pairWei),
    }),
    { spyWei: 0n, pairWei: 0n },
  )
}

async function readAttackCompoundInvariants(pending, { afterIncrease = false } = {}) {
  return Promise.all(
    pending.positions.map(async (item) => {
      const tokenId = BigInt(item.tokenId)
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
      if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`LP NFT ${tokenId} 不在执行钱包`)
      const expectedLiquidity =
        afterIncrease && String(item.tokenId) === String(pending.targetTokenId)
          ? BigInt(pending.increasePlan.expectedLiquidityAfter)
          : BigInt(item.liquidity)
      if (liquidity !== expectedLiquidity) {
        throw new Error(`LP NFT ${tokenId} 流动性不变量被破坏：chain=${liquidity}, expected=${expectedLiquidity}`)
      }
      return { tokenId, owner, liquidity }
    }),
  )
}

async function finalizeAttackCompound(state, pending) {
  if (!pending.increaseTransaction || !pending.increasePlan) throw new Error('进攻仓复投尚无可结算的增加流动性交易')
  const increaseReceipt = await publicClient.getTransactionReceipt({ hash: pending.increaseTransaction })
  if (increaseReceipt.status !== 'success')
    throw new Error(`进攻仓复投回执不是 success：${pending.increaseTransaction}`)
  const [finalEth, finalSpy, finalPair, finalPoolState, invariants, finalTargetFees] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
    readAttackCompoundInvariants(pending, { afterIncrease: true }),
    getAccruedFees(BigInt(pending.targetTokenId), pending.tickLower, pending.tickUpper),
  ])
  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  if (finalSpy < baselineSpy || finalPair < baselinePair) throw new Error('进攻仓复投入侵了钱包既有 SPY/PAIR 基线')
  if (finalEth < ATTACK_MIN_ETH_RESERVE) throw new Error(`复投后 ETH 低于 0.02 储备：${formatEther(finalEth)}`)

  const liquidityAdded = BigInt(pending.increasePlan.liquidityAdded)
  const addedPosition = new Position({
    pool: makePool(finalPoolState),
    liquidity: liquidityAdded.toString(),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
  })
  const addedUnderlyingSpyWei = asBigInt(addedPosition.amount0.quotient)
  const addedUnderlyingPairWei = asBigInt(addedPosition.amount1.quotient)
  const residualSpyWei = finalSpy - baselineSpy
  const residualPairWei = finalPair - baselinePair
  let priceSnapshot = null
  let marked = null
  try {
    const finalSpyMark = await quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT)
    const spyPriceUsdg = Number(formatUnits(finalSpyMark.amountOut, 6)) / Number(formatUnits(ADD_SPY_MARK_INPUT, 18))
    const prices = customRangePricesUsdg(spyPriceUsdg, pending.tickLower, pending.tickUpper)
    const addedValue = tokenAmountsUsdg(addedUnderlyingSpyWei, addedUnderlyingPairWei, finalPoolState, finalSpyMark)
    const residualValue = tokenAmountsUsdg(residualSpyWei, residualPairWei, finalPoolState, finalSpyMark)
    const totalValue = addedValue.totalUsdg + residualValue.totalUsdg
    const residualBps = totalValue === 0n ? 0n : (residualValue.totalUsdg * 10_000n) / totalValue
    priceSnapshot = {
      spyPriceUsdg: spyPriceUsdg.toFixed(6),
      currentPairPriceUsdg: (spyPriceUsdg / Math.pow(1.0001, finalPoolState.tick)).toFixed(8),
      actualPairPriceLowUsdg: prices.low.toFixed(8),
      actualPairPriceHighUsdg: prices.high.toFixed(8),
      currentTick: finalPoolState.tick,
    }
    marked = {
      addedLiquidityUsdg: addedValue.totalUsdg.toString(),
      residualUsdg: residualValue.totalUsdg.toString(),
      residualBps: residualBps.toString(),
      warning:
        residualBps > ATTACK_MAX_RESIDUAL_BPS
          ? `本次手续费残余约占 ${Number(residualBps) / 100}%，高于 ${Number(ATTACK_MAX_RESIDUAL_BPS) / 100}% 目标`
          : null,
    }
  } catch (error) {
    marked = { warning: `最终估值读取失败：${error.shortMessage || error.message}` }
  }

  const successfulTransactions = await confirmedAttackCompoundTransactions(pending)
  const failedTransactions = await confirmedFailedAttackCompoundTransactions(pending)
  const targetRecord = (state.satellites || []).find(
    (item) => item.status === 'active' && String(item.tokenId) === String(pending.targetTokenId),
  )
  if (!targetRecord) throw new Error(`本地找不到待更新的进攻仓 NFT ${pending.targetTokenId}`)
  const targetInvariant = invariants.find((item) => item.tokenId.toString() === String(pending.targetTokenId))
  if (!targetInvariant) throw new Error('最终不变量中缺少目标进攻仓')

  const record = {
    id: pending.id,
    status: 'complete',
    completedAt: new Date().toISOString(),
    targetTokenId: String(pending.targetTokenId),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
    source: 'fees from all active PAIR/SPY positions only; pre-existing wallet SPY/PAIR excluded',
    priceSnapshot,
    collectedFees: {
      spyWei: pending.collectedSpyWei,
      pairWei: pending.collectedPairWei,
      positions: pending.collections,
    },
    rebalance: pending.rebalance,
    increase: {
      liquidityBefore: pending.increasePlan.liquidityBefore,
      liquidityAdded: pending.increasePlan.liquidityAdded,
      liquidityAfter: targetInvariant.liquidity.toString(),
      desiredSpyWei: pending.increasePlan.desiredSpyWei,
      desiredPairWei: pending.increasePlan.desiredPairWei,
      walletNetSpentSpyWei: (BigInt(pending.increasePlan.spyBeforeIncreaseWei) - finalSpy).toString(),
      walletNetSpentPairWei: (BigInt(pending.increasePlan.pairBeforeIncreaseWei) - finalPair).toString(),
      targetFeesAtBuildSpyWei: pending.increasePlan.targetFeesAtBuildSpyWei,
      targetFeesAtBuildPairWei: pending.increasePlan.targetFeesAtBuildPairWei,
      addedUnderlyingSpyWei: addedUnderlyingSpyWei.toString(),
      addedUnderlyingPairWei: addedUnderlyingPairWei.toString(),
    },
    residualFromFees: {
      spyWei: residualSpyWei.toString(),
      pairWei: residualPairWei.toString(),
      ...marked,
    },
    postIncreaseAccruedFees: {
      spyWei: finalTargetFees.spyWei.toString(),
      pairWei: finalTargetFees.pairWei.toString(),
    },
    excludedWalletBaseline: { spyWei: pending.baselineSpyWei, pairWei: pending.baselinePairWei },
    protectedPositionInvariants: invariants
      .filter((item) => item.tokenId.toString() !== String(pending.targetTokenId))
      .map((item) => ({ tokenId: item.tokenId.toString(), liquidityAfter: item.liquidity.toString() })),
    gasSpentWei: receiptGasTotal([...successfulTransactions, ...failedTransactions]).toString(),
    finalEthWei: finalEth.toString(),
    transactions: pending.transactions || [],
    failedTransactions: pending.failedTransactions || [],
    increaseBlock: increaseReceipt.blockNumber.toString(),
    increaseTransaction: pending.increaseTransaction,
  }
  targetRecord.liquidity = targetInvariant.liquidity.toString()
  targetRecord.lastCompoundedAt = record.completedAt
  targetRecord.compoundIds = [...(targetRecord.compoundIds || []), record.id]
  state.compounds = [...(state.compounds || []), record]
  delete state.pendingAttackCompound
  writeState(state)
  appendAudit('attack_compound_complete', record)
  console.log(
    stringify({
      status: 'ATTACK_POSITION_COMPOUNDED',
      tokenId: pending.targetTokenId,
      tickLower: pending.tickLower,
      tickUpper: pending.tickUpper,
      priceSnapshot,
      collectedFees: {
        spy: formatUnits(BigInt(record.collectedFees.spyWei), 18),
        pair: formatUnits(BigInt(record.collectedFees.pairWei), 18),
        positions: record.collectedFees.positions.map((item) => ({
          tokenId: item.tokenId,
          spy: formatUnits(BigInt(item.spyWei), 18),
          pair: formatUnits(BigInt(item.pairWei), 18),
          transaction: item.transaction,
        })),
      },
      rebalance: record.rebalance,
      liquidity: {
        before: record.increase.liquidityBefore,
        added: record.increase.liquidityAdded,
        after: record.increase.liquidityAfter,
      },
      addedUnderlying: {
        spy: formatUnits(addedUnderlyingSpyWei, 18),
        pair: formatUnits(addedUnderlyingPairWei, 18),
      },
      feeResidual: {
        spy: formatUnits(residualSpyWei, 18),
        pair: formatUnits(residualPairWei, 18),
        marked,
      },
      nonTargetLiquidityUnchanged: true,
      gasSpentEth: formatEther(BigInt(record.gasSpentWei)),
      finalEth: formatEther(finalEth),
      transactions: record.transactions,
      failedTransactions: record.failedTransactions,
    }),
  )
  return record
}

async function continueAttackCompound(state, pending) {
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  await confirmedAttackCompoundTransactions(pending)
  await confirmedFailedAttackCompoundTransactions(pending)
  const [nonceLatest, noncePending] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`执行前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  await readAttackCompoundInvariants(pending, { afterIncrease: Boolean(pending.increaseTransaction) })
  if (pending.increaseTransaction) return finalizeAttackCompound(state, pending)

  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  for (const item of pending.positions) {
    if ((pending.collections || []).some((entry) => String(entry.tokenId) === String(item.tokenId))) continue
    const alreadyCollected = collectedAttackCompoundTotals(pending)
    const [spyBefore, pairBefore, poolState, liquidityBefore] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      getPoolState(),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(item.tokenId)],
      }),
    ])
    if (spyBefore !== baselineSpy + alreadyCollected.spyWei || pairBefore !== baselinePair + alreadyCollected.pairWei) {
      throw new Error(`领取 NFT ${item.tokenId} 前钱包余额不等于既有基线加已领取手续费`)
    }
    if (liquidityBefore !== BigInt(item.liquidity)) throw new Error(`领取前 NFT ${item.tokenId} 流动性变化`)
    const collect = buildPositionCollect(item, liquidityBefore, poolState)
    const result = await sendChecked(walletClient, {
      label: `进攻仓复投领取 NFT ${item.tokenId} (${pending.id})`,
      to: POSITION_MANAGER,
      data: collect.data,
      minimumBalanceAfter: ATTACK_MIN_ETH_RESERVE,
    })
    rememberAttackCompoundTransaction(state, pending, result)
    const [spyAfter, pairAfter, liquidityAfter] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(item.tokenId)],
      }),
    ])
    if (spyAfter < spyBefore || pairAfter < pairBefore) throw new Error(`领取 NFT ${item.tokenId} 后余额异常`)
    if (liquidityAfter !== liquidityBefore) throw new Error(`领取 NFT ${item.tokenId} 后流动性发生变化`)
    pending.collections = [
      ...(pending.collections || []),
      {
        tokenId: String(item.tokenId),
        transaction: result.hash,
        spyWei: (spyAfter - spyBefore).toString(),
        pairWei: (pairAfter - pairBefore).toString(),
      },
    ]
    pending.status = `fees_collected_${pending.collections.length}_of_${pending.positions.length}`
    writeState(state)
  }

  const collected = collectedAttackCompoundTotals(pending)
  let [walletSpy, walletPair] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  if (!pending.rebalanceComplete) {
    if (walletSpy !== baselineSpy + collected.spyWei || walletPair !== baselinePair + collected.pairWei) {
      throw new Error('领取后钱包余额不等于既有基线加逐笔手续费回执')
    }
    pending.collectedSpyWei = collected.spyWei.toString()
    pending.collectedPairWei = collected.pairWei.toString()
    if (collected.spyWei === 0n && collected.pairWei === 0n) throw new Error('领取交易成功但未收到手续费')

    const poolState = await getPoolState()
    const rangePositionBps = customRangePositionBps(poolState.tick, pending.tickLower, pending.tickUpper)
    if (rangePositionBps < ATTACK_MIN_RANGE_POSITION_BPS || rangePositionBps > ATTACK_MAX_RANGE_POSITION_BPS) {
      throw new Error(`配平前现价已偏离进攻仓安全区域：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
    }
    const plan = await solveCustomRangeRebalance(
      collected.spyWei,
      collected.pairWei,
      poolState,
      pending.tickLower,
      pending.tickUpper,
    )
    if (plan.direction === 'NONE') {
      pending.rebalance = { direction: 'NONE', inputWei: '0', outputWei: '0', transaction: null }
      pending.availableSpyWei = collected.spyWei.toString()
      pending.availablePairWei = collected.pairWei.toString()
    } else {
      const inputToken = plan.zeroForOne ? SPY : PAIR
      const inputSymbol = plan.zeroForOne ? 'SPY' : 'PAIR'
      const outputSymbol = plan.zeroForOne ? 'PAIR' : 'SPY'
      rememberAttackCompoundTransaction(
        state,
        pending,
        await approveErc20(
          walletClient,
          inputToken,
          plan.amountIn,
          `进攻仓复投授权 ${inputSymbol} 给 Permit2 (${pending.id})`,
          ATTACK_MIN_ETH_RESERVE,
        ),
      )
      rememberAttackCompoundTransaction(
        state,
        pending,
        await approvePermit2(
          walletClient,
          inputToken,
          UNIVERSAL_ROUTER,
          plan.amountIn,
          `进攻仓复投授权路由使用 ${inputSymbol} (${pending.id})`,
          ATTACK_MIN_ETH_RESERVE,
        ),
      )
      const [spyBeforeSwap, pairBeforeSwap] = await Promise.all([
        publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      ])
      if (spyBeforeSwap !== baselineSpy + collected.spyWei || pairBeforeSwap !== baselinePair + collected.pairWei) {
        throw new Error('配平前钱包余额发生变化')
      }
      const liveQuote = await quotePairPoolSwap(plan.amountIn, plan.zeroForOne)
      const minimumOutput = bpsFloor(liveQuote.amountOut, SWAP_SLIPPAGE_BPS)
      const swapData = buildV4SwapData(plan.amountIn, minimumOutput, BigInt(nowSeconds() + 5 * 60), plan.zeroForOne)
      pending.swapPlan = {
        direction: plan.direction,
        inputWei: plan.amountIn.toString(),
        minimumOutputWei: minimumOutput.toString(),
        spyBeforeWei: spyBeforeSwap.toString(),
        pairBeforeWei: pairBeforeSwap.toString(),
      }
      pending.status = 'swap_prepared'
      writeState(state)
      const swapped = await sendChecked(walletClient, {
        label: `进攻仓复投配平 ${inputSymbol}→${outputSymbol} (${pending.id})`,
        to: UNIVERSAL_ROUTER,
        data: swapData,
        minimumBalanceAfter: ATTACK_MIN_ETH_RESERVE,
      })
      pending.swapTransaction = swapped.hash
      rememberAttackCompoundTransaction(state, pending, swapped)
      const [spyAfterSwap, pairAfterSwap] = await Promise.all([
        publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
        publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      ])
      const actualInput = plan.zeroForOne ? spyBeforeSwap - spyAfterSwap : pairBeforeSwap - pairAfterSwap
      const actualOutput = plan.zeroForOne ? pairAfterSwap - pairBeforeSwap : spyAfterSwap - spyBeforeSwap
      if (actualInput !== plan.amountIn || actualOutput < minimumOutput)
        throw new Error('进攻仓复投配平的实际输入或输出不符合保护条件')
      if (spyAfterSwap < baselineSpy || pairAfterSwap < baselinePair)
        throw new Error('进攻仓复投配平动用了钱包既有代币')
      pending.rebalance = {
        direction: plan.direction,
        inputWei: actualInput.toString(),
        outputWei: actualOutput.toString(),
        minimumOutputWei: minimumOutput.toString(),
        transaction: swapped.hash,
      }
      pending.availableSpyWei = (spyAfterSwap - baselineSpy).toString()
      pending.availablePairWei = (pairAfterSwap - baselinePair).toString()
      walletSpy = spyAfterSwap
      walletPair = pairAfterSwap
    }
    pending.rebalanceComplete = true
    pending.status = 'rebalanced'
    writeState(state)
  }

  await readAttackCompoundInvariants(pending)
  const availableSpy = BigInt(pending.availableSpyWei)
  const availablePair = BigInt(pending.availablePairWei)
  const [spyBeforeIncrease, pairBeforeIncrease, poolStateBeforeIncrease] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
  ])
  if (spyBeforeIncrease !== baselineSpy + availableSpy || pairBeforeIncrease !== baselinePair + availablePair) {
    throw new Error('增加流动性前钱包余额不等于既有基线加本次手续费资产')
  }
  const rangePositionBps = customRangePositionBps(poolStateBeforeIncrease.tick, pending.tickLower, pending.tickUpper)
  if (rangePositionBps < ATTACK_MIN_RANGE_POSITION_BPS || rangePositionBps > ATTACK_MAX_RANGE_POSITION_BPS) {
    throw new Error(
      `增加流动性前现价已偏离进攻仓安全区域：tick=${poolStateBeforeIncrease.tick}, rangeBps=${rangePositionBps}`,
    )
  }
  rememberAttackCompoundTransaction(
    state,
    pending,
    await approveErc20(
      walletClient,
      SPY,
      availableSpy,
      `进攻仓复投确认 SPY Permit2 授权 (${pending.id})`,
      ATTACK_MIN_ETH_RESERVE,
    ),
  )
  rememberAttackCompoundTransaction(
    state,
    pending,
    await approveErc20(
      walletClient,
      PAIR,
      availablePair,
      `进攻仓复投确认 PAIR Permit2 授权 (${pending.id})`,
      ATTACK_MIN_ETH_RESERVE,
    ),
  )
  const targetRecord = {
    tokenId: pending.targetTokenId,
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
    liquidity: pending.targetLiquidityBefore,
  }
  const increase = await buildCustomRangeIncrease(account, targetRecord, availableSpy, availablePair)
  if (increase.external0Max > availableSpy || increase.external1Max > availablePair) {
    throw new Error('进攻仓追加的外部代币上限超过本次手续费资产')
  }
  pending.increasePlan = {
    liquidityBefore: increase.currentLiquidity.toString(),
    liquidityAdded: increase.liquidity.toString(),
    expectedLiquidityAfter: (increase.currentLiquidity + increase.liquidity).toString(),
    desiredSpyWei: increase.amount0Desired.toString(),
    desiredPairWei: increase.amount1Desired.toString(),
    maxSpyWei: increase.amount0Max.toString(),
    maxPairWei: increase.amount1Max.toString(),
    externalMaxSpyWei: increase.external0Max.toString(),
    externalMaxPairWei: increase.external1Max.toString(),
    targetFeesAtBuildSpyWei: increase.fees.spyWei.toString(),
    targetFeesAtBuildPairWei: increase.fees.pairWei.toString(),
    spyBeforeIncreaseWei: spyBeforeIncrease.toString(),
    pairBeforeIncreaseWei: pairBeforeIncrease.toString(),
  }
  pending.status = 'increase_prepared'
  writeState(state)
  const increased = await sendChecked(walletClient, {
    label: `进攻仓复投增加 NFT ${pending.targetTokenId} 流动性 (${pending.id})`,
    to: POSITION_MANAGER,
    data: increase.data,
    minimumBalanceAfter: ATTACK_MIN_ETH_RESERVE,
    fast: true,
    gasPriceMultiplierBps: 20_000n,
  })
  pending.increaseTransaction = increased.hash
  pending.status = 'increase_confirmed'
  rememberAttackCompoundTransaction(state, pending, increased)
  return finalizeAttackCompound(state, pending)
}

function markAttackCompoundPartial(operationId, error) {
  const latestState = readState()
  if (!latestState?.pendingAttackCompound || latestState.pendingAttackCompound.id !== operationId) return
  const pending = latestState.pendingAttackCompound
  const failedHash = String(error.shortMessage || error.message).match(/0x[0-9a-fA-F]{64}/)?.[0]
  if (failedHash) pending.failedTransactions = [...new Set([...(pending.failedTransactions || []), failedHash])]
  if (!(pending.transactions || []).length && !(pending.failedTransactions || []).length) {
    delete latestState.pendingAttackCompound
  } else {
    pending.status = pending.increaseTransaction ? 'increase_confirmed_needs_readback' : 'partial'
    pending.lastErrorAt = new Date().toISOString()
    pending.lastError = error.shortMessage || error.message
  }
  writeState(latestState)
  appendAudit('attack_compound_partial', {
    id: operationId,
    status: pending.status,
    message: error.shortMessage || error.message,
    transactions: pending.transactions || [],
    failedTransactions: pending.failedTransactions || [],
  })
}

async function attackCompoundEnter() {
  const check = await attackCompoundPreflight({ print: true })
  const operationId = `attack-compound-${new Date().toISOString().replace(/[-:.]/g, '')}`
  const state = check.state
  state.pendingAttackCompound = {
    id: operationId,
    status: 'planned',
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    targetTokenId: String(check.targetRecord.tokenId),
    targetLiquidityBefore: String(check.targetRecord.liquidity),
    tickLower: check.targetRecord.tickLower,
    tickUpper: check.targetRecord.tickUpper,
    baselineEthWei: check.ethBalance.toString(),
    baselineSpyWei: check.spyBalance.toString(),
    baselinePairWei: check.pairBalance.toString(),
    positions: check.positionReads.map((item) => ({
      role: item.record.role,
      tokenId: item.tokenId.toString(),
      tickLower: item.record.tickLower,
      tickUpper: item.record.tickUpper,
      liquidity: item.liquidity.toString(),
      estimatedFeeSpyWei: item.fees.spyWei.toString(),
      estimatedFeePairWei: item.fees.pairWei.toString(),
    })),
    collections: [],
    transactions: [],
    failedTransactions: [],
  }
  writeState(state)
  appendAudit('attack_compound_plan_created', state.pendingAttackCompound)
  try {
    const [nonceLatest, noncePending, spyBefore, pairBefore] = await Promise.all([
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    ])
    if (nonceLatest !== noncePending)
      throw new Error(`广播前出现 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
    if (spyBefore !== check.spyBalance || pairBefore !== check.pairBalance)
      throw new Error('广播前钱包代币余额发生变化')
    return await continueAttackCompound(state, state.pendingAttackCompound)
  } catch (error) {
    markAttackCompoundPartial(operationId, error)
    throw error
  }
}

async function attackCompoundResume() {
  const state = readState()
  const pending = state?.pendingAttackCompound
  if (!state || state.status !== 'active' || !pending) throw new Error('没有可恢复的进攻仓手续费复投计划')
  try {
    return await continueAttackCompound(state, pending)
  } catch (error) {
    markAttackCompoundPartial(pending.id, error)
    throw error
  }
}

async function finalizeAttackResidualSweep(state, pending) {
  if (!pending.transaction || !pending.increasePlan) throw new Error('手续费残余追加尚无可结算交易')
  const receipt = await publicClient.getTransactionReceipt({ hash: pending.transaction })
  if (receipt.status !== 'success') throw new Error(`手续费残余追加回执不是 success：${pending.transaction}`)
  const [finalEth, finalSpy, finalPair, finalPoolState, finalLiquidity, protectedReads, finalFees] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(pending.targetTokenId)],
    }),
    Promise.all(
      pending.protectedPositions.map(async (item) => ({
        tokenId: String(item.tokenId),
        liquidity: await publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(item.tokenId)],
        }),
      })),
    ),
    getAccruedFees(BigInt(pending.targetTokenId), pending.tickLower, pending.tickUpper),
  ])
  if (finalLiquidity !== BigInt(pending.increasePlan.expectedLiquidityAfter)) {
    throw new Error(
      `手续费残余追加后 liquidity 不一致：chain=${finalLiquidity}, expected=${pending.increasePlan.expectedLiquidityAfter}`,
    )
  }
  for (const item of protectedReads) {
    const expected = pending.protectedPositions.find((entry) => String(entry.tokenId) === item.tokenId)
    if (item.liquidity !== BigInt(expected.liquidity)) throw new Error(`受保护 LP ${item.tokenId} 流动性发生变化`)
  }
  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  if (finalSpy < baselineSpy || finalPair < baselinePair) throw new Error('手续费残余追加动用了钱包既有代币')
  if (finalEth < ATTACK_MIN_ETH_RESERVE) throw new Error(`手续费残余追加后 ETH 低于 0.02：${formatEther(finalEth)}`)

  const residualSpyWei = finalSpy - baselineSpy
  const residualPairWei = finalPair - baselinePair
  const liquidityAdded = BigInt(pending.increasePlan.liquidityAdded)
  const addedPosition = new Position({
    pool: makePool(finalPoolState),
    liquidity: liquidityAdded.toString(),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
  })
  const addedUnderlyingSpyWei = asBigInt(addedPosition.amount0.quotient)
  const addedUnderlyingPairWei = asBigInt(addedPosition.amount1.quotient)
  let marked = null
  try {
    const spyMark = await quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT)
    const addedValue = tokenAmountsUsdg(addedUnderlyingSpyWei, addedUnderlyingPairWei, finalPoolState, spyMark)
    const residualValue = tokenAmountsUsdg(residualSpyWei, residualPairWei, finalPoolState, spyMark)
    const totalValue = addedValue.totalUsdg + residualValue.totalUsdg
    marked = {
      addedLiquidityUsdg: addedValue.totalUsdg.toString(),
      residualUsdg: residualValue.totalUsdg.toString(),
      residualBpsOfSweepAssets: (totalValue === 0n ? 0n : (residualValue.totalUsdg * 10_000n) / totalValue).toString(),
    }
  } catch (error) {
    marked = { warning: `残余追加估值读取失败：${error.shortMessage || error.message}` }
  }

  const failedReceipts = await confirmedFailedAttackCompoundTransactions(pending)
  const gasSpentWei = receipt.gasUsed * receipt.effectiveGasPrice + receiptGasTotal(failedReceipts)
  const compound = (state.compounds || []).find((item) => item.id === pending.compoundId)
  const targetRecord = (state.satellites || []).find(
    (item) => item.status === 'active' && String(item.tokenId) === String(pending.targetTokenId),
  )
  if (!compound || !targetRecord) throw new Error('本地复投记录或目标进攻仓缺失，无法结算残余追加')
  const sweepRecord = {
    completedAt: new Date().toISOString(),
    transaction: pending.transaction,
    blockNumber: receipt.blockNumber.toString(),
    slippageBps: 50,
    liquidityBefore: pending.increasePlan.liquidityBefore,
    liquidityAdded: pending.increasePlan.liquidityAdded,
    liquidityAfter: finalLiquidity.toString(),
    desiredSpyWei: pending.increasePlan.desiredSpyWei,
    desiredPairWei: pending.increasePlan.desiredPairWei,
    walletNetSpentSpyWei: (BigInt(pending.spyBeforeWei) - finalSpy).toString(),
    walletNetSpentPairWei: (BigInt(pending.pairBeforeWei) - finalPair).toString(),
    targetFeesAtBuildSpyWei: pending.increasePlan.targetFeesAtBuildSpyWei,
    targetFeesAtBuildPairWei: pending.increasePlan.targetFeesAtBuildPairWei,
    addedUnderlyingSpyWei: addedUnderlyingSpyWei.toString(),
    addedUnderlyingPairWei: addedUnderlyingPairWei.toString(),
    residualSpyWei: residualSpyWei.toString(),
    residualPairWei: residualPairWei.toString(),
    gasSpentWei: gasSpentWei.toString(),
    failedTransactions: pending.failedTransactions || [],
    ...marked,
  }
  compound.residualSweeps = [...(compound.residualSweeps || []), sweepRecord]
  compound.residualFromFees = {
    spyWei: residualSpyWei.toString(),
    pairWei: residualPairWei.toString(),
    ...marked,
  }
  compound.gasSpentWei = (BigInt(compound.gasSpentWei) + gasSpentWei).toString()
  compound.finalEthWei = finalEth.toString()
  compound.transactions = [...new Set([...(compound.transactions || []), pending.transaction])]
  compound.failedTransactions = [
    ...new Set([...(compound.failedTransactions || []), ...(pending.failedTransactions || [])]),
  ]
  compound.postIncreaseAccruedFees = { spyWei: finalFees.spyWei.toString(), pairWei: finalFees.pairWei.toString() }
  targetRecord.liquidity = finalLiquidity.toString()
  targetRecord.lastCompoundedAt = sweepRecord.completedAt
  delete state.pendingAttackResidual
  writeState(state)
  appendAudit('attack_compound_residual_sweep_complete', { compoundId: compound.id, ...sweepRecord })
  console.log(
    stringify({
      status: 'ATTACK_COMPOUND_RESIDUAL_SWEPT',
      compoundId: compound.id,
      tokenId: pending.targetTokenId,
      liquidity: {
        before: sweepRecord.liquidityBefore,
        added: sweepRecord.liquidityAdded,
        after: sweepRecord.liquidityAfter,
      },
      addedUnderlying: {
        spy: formatUnits(addedUnderlyingSpyWei, 18),
        pair: formatUnits(addedUnderlyingPairWei, 18),
      },
      residual: {
        spy: formatUnits(residualSpyWei, 18),
        pair: formatUnits(residualPairWei, 18),
        marked,
      },
      nonTargetLiquidityUnchanged: true,
      gasSpentEth: formatEther(gasSpentWei),
      finalEth: formatEther(finalEth),
      transaction: pending.transaction,
      failedTransactions: pending.failedTransactions || [],
    }),
  )
  return sweepRecord
}

async function continueAttackResidualSweep(state, pending) {
  const [nonceLatest, noncePending] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`手续费残余追加前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (pending.transaction) return finalizeAttackResidualSweep(state, pending)
  const [targetLiquidity, spyBalance, pairBalance, poolState, protectedReads] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(pending.targetTokenId)],
    }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
    Promise.all(
      pending.protectedPositions.map(async (item) => ({
        tokenId: String(item.tokenId),
        liquidity: await publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(item.tokenId)],
        }),
      })),
    ),
  ])
  if (targetLiquidity !== BigInt(pending.targetLiquidityBefore))
    throw new Error('手续费残余追加前目标 liquidity 发生变化')
  for (const item of protectedReads) {
    const expected = pending.protectedPositions.find((entry) => String(entry.tokenId) === item.tokenId)
    if (item.liquidity !== BigInt(expected.liquidity)) throw new Error(`受保护 LP ${item.tokenId} 流动性发生变化`)
  }
  if (
    spyBalance !== BigInt(pending.baselineSpyWei) + BigInt(pending.availableSpyWei) ||
    pairBalance !== BigInt(pending.baselinePairWei) + BigInt(pending.availablePairWei)
  ) {
    throw new Error('手续费残余追加前钱包余额不等于原始基线加已核验残余')
  }
  const rangePositionBps = customRangePositionBps(poolState.tick, pending.tickLower, pending.tickUpper)
  if (rangePositionBps < ATTACK_MIN_RANGE_POSITION_BPS || rangePositionBps > ATTACK_MAX_RANGE_POSITION_BPS) {
    throw new Error(`手续费残余追加前现价偏离安全区：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
  }

  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  const targetRecord = {
    tokenId: pending.targetTokenId,
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
    liquidity: pending.targetLiquidityBefore,
  }
  const increase = await buildCustomRangeIncrease(
    account,
    targetRecord,
    BigInt(pending.availableSpyWei),
    BigInt(pending.availablePairWei),
    { slippageTolerance: ATTACK_RESIDUAL_MINT_SLIPPAGE },
  )
  pending.increasePlan = {
    liquidityBefore: increase.currentLiquidity.toString(),
    liquidityAdded: increase.liquidity.toString(),
    expectedLiquidityAfter: (increase.currentLiquidity + increase.liquidity).toString(),
    desiredSpyWei: increase.amount0Desired.toString(),
    desiredPairWei: increase.amount1Desired.toString(),
    targetFeesAtBuildSpyWei: increase.fees.spyWei.toString(),
    targetFeesAtBuildPairWei: increase.fees.pairWei.toString(),
  }
  pending.status = 'prepared'
  writeState(state)
  const result = await sendChecked(walletClient, {
    label: `进攻仓复投残余追加 NFT ${pending.targetTokenId} (${pending.compoundId})`,
    to: POSITION_MANAGER,
    data: increase.data,
    minimumBalanceAfter: ATTACK_MIN_ETH_RESERVE,
    fast: true,
    gasPriceMultiplierBps: 20_000n,
  })
  pending.transaction = result.hash
  pending.status = 'confirmed'
  writeState(state)
  return finalizeAttackResidualSweep(state, pending)
}

function markAttackResidualPartial(error) {
  const state = readState()
  const pending = state?.pendingAttackResidual
  if (!pending) return
  const failedHash = String(error.shortMessage || error.message).match(/0x[0-9a-fA-F]{64}/)?.[0]
  if (failedHash) pending.failedTransactions = [...new Set([...(pending.failedTransactions || []), failedHash])]
  pending.status = pending.transaction ? 'confirmed_needs_readback' : 'partial'
  pending.lastErrorAt = new Date().toISOString()
  pending.lastError = error.shortMessage || error.message
  writeState(state)
  appendAudit('attack_compound_residual_sweep_partial', {
    compoundId: pending.compoundId,
    status: pending.status,
    message: pending.lastError,
    transaction: pending.transaction || null,
    failedTransactions: pending.failedTransactions || [],
  })
}

async function attackResidualSweepEnter() {
  const state = readState()
  if (!state || state.status !== 'active') throw new Error('没有活动的 PAIR/SPY 账本')
  for (const key of [
    'pendingIncrease',
    'pendingSatellite',
    'pendingMigration',
    'pendingUpperRange',
    'pendingFeeBand',
    'pendingAttackRoll',
    'pendingAttackCompound',
    'pendingAttackResidual',
    'pendingMainRoll',
    'pendingCurrentBand',
  ]) {
    if (state[key]) throw new Error(`存在未结算计划 ${key}：${state[key].id || state[key].compoundId || 'unknown'}`)
  }
  const compound = (state.compounds || []).at(-1)
  if (
    !compound ||
    compound.status !== 'complete' ||
    String(compound.targetTokenId) !== ATTACK_COMPOUND_TARGET_TOKEN_ID
  ) {
    throw new Error('没有可追加残余的最新进攻仓复投记录')
  }
  const targetRecord = (state.satellites || []).find(
    (item) => item.status === 'active' && String(item.tokenId) === ATTACK_COMPOUND_TARGET_TOKEN_ID,
  )
  if (!targetRecord) throw new Error(`没有活动的目标 NFT ${ATTACK_COMPOUND_TARGET_TOKEN_ID}`)
  const baselineSpy = BigInt(compound.excludedWalletBaseline.spyWei)
  const baselinePair = BigInt(compound.excludedWalletBaseline.pairWei)
  const availableSpy = BigInt(compound.residualFromFees.spyWei)
  const availablePair = BigInt(compound.residualFromFees.pairWei)
  const [ethBalance, spyBalance, pairBalance, nonceLatest, noncePending] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`手续费残余追加前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (spyBalance !== baselineSpy + availableSpy || pairBalance !== baselinePair + availablePair) {
    throw new Error('钱包余额不再等于该复投记录的基线加残余，禁止混用其他资金')
  }
  if (ethBalance < ATTACK_MIN_ETH_RESERVE) throw new Error('ETH 已低于进攻仓 0.02 储备')
  state.pendingAttackResidual = {
    compoundId: compound.id,
    status: 'planned',
    createdAt: new Date().toISOString(),
    targetTokenId: ATTACK_COMPOUND_TARGET_TOKEN_ID,
    targetLiquidityBefore: targetRecord.liquidity,
    tickLower: targetRecord.tickLower,
    tickUpper: targetRecord.tickUpper,
    baselineSpyWei: baselineSpy.toString(),
    baselinePairWei: baselinePair.toString(),
    availableSpyWei: availableSpy.toString(),
    availablePairWei: availablePair.toString(),
    spyBeforeWei: spyBalance.toString(),
    pairBeforeWei: pairBalance.toString(),
    protectedPositions: activePairPositionRecords(state)
      .filter((item) => String(item.tokenId) !== ATTACK_COMPOUND_TARGET_TOKEN_ID)
      .map((item) => ({ tokenId: String(item.tokenId), liquidity: String(item.liquidity) })),
    failedTransactions: [],
  }
  writeState(state)
  appendAudit('attack_compound_residual_sweep_plan_created', state.pendingAttackResidual)
  try {
    return await continueAttackResidualSweep(state, state.pendingAttackResidual)
  } catch (error) {
    markAttackResidualPartial(error)
    throw error
  }
}

async function attackResidualSweepResume() {
  const state = readState()
  if (!state?.pendingAttackResidual) throw new Error('没有可恢复的手续费残余追加计划')
  try {
    return await continueAttackResidualSweep(state, state.pendingAttackResidual)
  } catch (error) {
    markAttackResidualPartial(error)
    throw error
  }
}

async function rollResidualSweepPreflight({ print = true } = {}) {
  const state = readState()
  if (!state || state.status !== 'active') throw new Error('没有活动的 PAIR/SPY 账本')
  for (const key of [
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
    'pendingCurrentBand',
  ]) {
    if (state[key]) throw new Error(`存在未结算计划 ${key}：${state[key].id || state[key].compoundId || 'unknown'}`)
  }
  const targetTokenId = process.env.PAIR_ROLL_RESIDUAL_TARGET_TOKEN_ID
  if (!/^\d+$/.test(targetTokenId || '')) throw new Error('缺少有效的 PAIR_ROLL_RESIDUAL_TARGET_TOKEN_ID')
  const targetRecord = (state.satellites || []).find(
    (item) => item.status === 'active' && String(item.tokenId) === targetTokenId,
  )
  if (!targetRecord) throw new Error(`没有活动的残余目标 NFT ${targetTokenId}`)
  if (!targetRecord.residual?.spyWei || !targetRecord.residual?.pairWei) {
    throw new Error(`目标 NFT ${targetTokenId} 没有可核验的迁移残余记录`)
  }
  const availableSpy = BigInt(targetRecord.residual.spyWei)
  const availablePair = BigInt(targetRecord.residual.pairWei)
  if (availableSpy === 0n && availablePair === 0n) throw new Error(`目标 NFT ${targetTokenId} 残余为 0`)
  const protectedRecords = activePairPositionRecords(state).filter((item) => String(item.tokenId) !== targetTokenId)
  const [
    blockNumber,
    nonceLatest,
    noncePending,
    ethBalance,
    spyBalance,
    pairBalance,
    poolState,
    targetOwner,
    targetLiquidity,
    protectedReads,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [BigInt(targetTokenId)],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(targetTokenId)],
    }),
    Promise.all(
      protectedRecords.map(async (record) => {
        const [owner, liquidity] = await Promise.all([
          publicClient.readContract({
            address: POSITION_MANAGER,
            abi: POSITION_NFT_ABI,
            functionName: 'ownerOf',
            args: [BigInt(record.tokenId)],
          }),
          publicClient.readContract({
            address: POSITION_MANAGER,
            abi: POSITION_NFT_ABI,
            functionName: 'getPositionLiquidity',
            args: [BigInt(record.tokenId)],
          }),
        ])
        return { tokenId: String(record.tokenId), owner, liquidity, expectedLiquidity: BigInt(record.liquidity) }
      }),
    ),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`残余追加前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (targetOwner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`目标 NFT ${targetTokenId} 不在执行钱包`)
  if (targetLiquidity !== BigInt(targetRecord.liquidity))
    throw new Error(`目标 NFT ${targetTokenId} liquidity 与账本不一致`)
  for (const item of protectedReads) {
    if (item.owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`受保护 LP ${item.tokenId} 不在执行钱包`)
    if (item.liquidity !== item.expectedLiquidity) throw new Error(`受保护 LP ${item.tokenId} liquidity 发生变化`)
  }
  if (spyBalance < availableSpy || pairBalance < availablePair) throw new Error('钱包余额小于账本记录的目标残余')
  // A later isolated sweep of another NFT legitimately changes the older
  // record's original wallet baseline.  The current record residual, target
  // liquidity and every non-target liquidity are the canonical isolation
  // anchors for this pass; exclude everything else as a fresh dynamic baseline.
  const baselineSpy = spyBalance - availableSpy
  const baselinePair = pairBalance - availablePair
  const rangePositionBps = customRangePositionBps(poolState.tick, targetRecord.tickLower, targetRecord.tickUpper)
  if (rangePositionBps < ATTACK_MIN_RANGE_POSITION_BPS || rangePositionBps > ATTACK_MAX_RANGE_POSITION_BPS) {
    throw new Error(`残余追加目标接近区间边界：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
  }
  if (ethBalance < ATTACK_MIN_ETH_RESERVE) throw new Error(`ETH 余额低于 ${formatEther(ATTACK_MIN_ETH_RESERVE)} 储备`)
  const report = {
    status: 'READY_TO_SWEEP_ROLL_RESIDUAL',
    observedAt: new Date().toISOString(),
    blockNumber,
    nonceLatest,
    noncePending,
    target: {
      tokenId: targetTokenId,
      tickLower: targetRecord.tickLower,
      tickUpper: targetRecord.tickUpper,
      liquidity: targetLiquidity,
      currentTick: poolState.tick,
      rangePositionPct: (Number(rangePositionBps) / 100).toFixed(2),
    },
    residualInput: { spy: formatUnits(availableSpy, 18), pair: formatUnits(availablePair, 18) },
    dynamicallyExcludedWalletBaseline: { spy: formatUnits(baselineSpy, 18), pair: formatUnits(baselinePair, 18) },
    protectedPositions: protectedReads.map((item) => ({ tokenId: item.tokenId, liquidityInvariant: item.liquidity })),
    eth: { balance: formatEther(ethBalance), retainedMinimum: formatEther(ATTACK_MIN_ETH_RESERVE) },
    policy: {
      addToExistingNft: true,
      rebalanceResidual: true,
      swapSlippageBps: 100,
      mintSlippageBps: 50,
      preserveAllOtherWalletTokens: true,
    },
  }
  appendAudit('roll_residual_sweep_preflight', report)
  if (print) console.log(stringify(report))
  return {
    state,
    targetRecord,
    protectedReads,
    blockNumber,
    ethBalance,
    spyBalance,
    pairBalance,
    baselineSpy,
    baselinePair,
    availableSpy,
    availablePair,
    report,
  }
}

async function readRollResidualProtectedInvariants(pending) {
  return Promise.all(
    pending.protectedPositions.map(async (item) => {
      const [owner, liquidity] = await Promise.all([
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [BigInt(item.tokenId)],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(item.tokenId)],
        }),
      ])
      if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`受保护 LP ${item.tokenId} 所有权发生变化`)
      if (liquidity !== BigInt(item.liquidity)) throw new Error(`受保护 LP ${item.tokenId} liquidity 发生变化`)
      return { tokenId: String(item.tokenId), liquidity }
    }),
  )
}

async function finalizeRollResidualSweep(state, pending) {
  if (!pending.transaction || !pending.increasePlan) throw new Error('迁移残余追加尚无可结算交易')
  const receipt = await publicClient.getTransactionReceipt({ hash: pending.transaction })
  if (receipt.status !== 'success') throw new Error(`迁移残余追加回执不是 success：${pending.transaction}`)
  const confirmedTransactions = await Promise.all(
    [...new Set([...(pending.transactions || []), pending.transaction])].map(async (hash) => {
      const transactionReceipt = await publicClient.getTransactionReceipt({ hash })
      if (transactionReceipt.status !== 'success') throw new Error(`迁移残余历史交易回执不是 success：${hash}`)
      return {
        hash,
        receipt: transactionReceipt,
        gasCost: transactionReceipt.gasUsed * transactionReceipt.effectiveGasPrice,
      }
    }),
  )
  const [owner, finalLiquidity, finalEth, finalSpy, finalPair, poolState, protectedReads, finalFees] =
    await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [BigInt(pending.targetTokenId)],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(pending.targetTokenId)],
      }),
      publicClient.getBalance({ address: WALLET }),
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      getPoolState(),
      readRollResidualProtectedInvariants(pending),
      getAccruedFees(BigInt(pending.targetTokenId), pending.tickLower, pending.tickUpper),
    ])
  if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error('残余追加后目标 NFT 所有权异常')
  if (finalLiquidity !== BigInt(pending.increasePlan.expectedLiquidityAfter)) {
    throw new Error(
      `残余追加后 liquidity 不一致：chain=${finalLiquidity}, expected=${pending.increasePlan.expectedLiquidityAfter}`,
    )
  }
  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  if (finalSpy < baselineSpy || finalPair < baselinePair) throw new Error('残余追加动用了动态基线中的其它钱包代币')
  if (finalEth < ATTACK_MIN_ETH_RESERVE) throw new Error(`残余追加后 ETH 低于 ${formatEther(ATTACK_MIN_ETH_RESERVE)}`)
  const residualSpy = finalSpy - baselineSpy
  const residualPair = finalPair - baselinePair
  const targetRecord = (state.satellites || []).find(
    (item) => item.status === 'active' && String(item.tokenId) === String(pending.targetTokenId),
  )
  if (!targetRecord) throw new Error('本地残余追加目标记录缺失')
  const liquidityAdded = BigInt(pending.increasePlan.liquidityAdded)
  const addedPosition = new Position({
    pool: makePool(poolState),
    liquidity: liquidityAdded.toString(),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
  })
  const addedSpy = asBigInt(addedPosition.amount0.quotient)
  const addedPair = asBigInt(addedPosition.amount1.quotient)
  let marked = null
  try {
    const spyMark = await quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT)
    const addedValue = tokenAmountsUsdg(addedSpy, addedPair, poolState, spyMark)
    const residualValue = tokenAmountsUsdg(residualSpy, residualPair, poolState, spyMark)
    const totalValue = addedValue.totalUsdg + residualValue.totalUsdg
    marked = {
      addedLiquidityUsdg: addedValue.totalUsdg.toString(),
      residualUsdg: residualValue.totalUsdg.toString(),
      residualBpsOfSweepAssets: (totalValue === 0n ? 0n : (residualValue.totalUsdg * 10_000n) / totalValue).toString(),
    }
  } catch (error) {
    marked = { warning: `迁移残余追加估值失败：${error.shortMessage || error.message}` }
  }
  const sweep = {
    completedAt: new Date().toISOString(),
    transaction: pending.transaction,
    blockNumber: receipt.blockNumber.toString(),
    liquidityBefore: pending.increasePlan.liquidityBefore,
    liquidityAdded: pending.increasePlan.liquidityAdded,
    liquidityAfter: finalLiquidity.toString(),
    desiredSpyWei: pending.increasePlan.desiredSpyWei,
    desiredPairWei: pending.increasePlan.desiredPairWei,
    walletNetSpentSpyWei: (BigInt(pending.spyBeforeWei) - finalSpy).toString(),
    walletNetSpentPairWei: (BigInt(pending.pairBeforeWei) - finalPair).toString(),
    targetFeesAtBuildSpyWei: pending.increasePlan.targetFeesAtBuildSpyWei,
    targetFeesAtBuildPairWei: pending.increasePlan.targetFeesAtBuildPairWei,
    addedUnderlyingSpyWei: addedSpy.toString(),
    addedUnderlyingPairWei: addedPair.toString(),
    residualSpyWei: residualSpy.toString(),
    residualPairWei: residualPair.toString(),
    rebalance: pending.rebalance || null,
    gasSpentWei: receiptGasTotal(confirmedTransactions).toString(),
    transactions: confirmedTransactions.map((item) => item.hash),
    protectedPositionInvariants: protectedReads.map((item) => ({
      tokenId: item.tokenId,
      liquidityAfter: item.liquidity.toString(),
    })),
    ...marked,
  }
  targetRecord.liquidity = finalLiquidity.toString()
  targetRecord.residualSweeps = [...(targetRecord.residualSweeps || []), sweep]
  targetRecord.residual = { spyWei: residualSpy.toString(), pairWei: residualPair.toString(), ...marked }
  targetRecord.lastResidualSweepAt = sweep.completedAt
  targetRecord.postSweepAccruedFees = { spyWei: finalFees.spyWei.toString(), pairWei: finalFees.pairWei.toString() }
  delete state.pendingRollResidual
  writeState(state)
  appendAudit('roll_residual_sweep_complete', { targetTokenId: pending.targetTokenId, ...sweep })
  console.log(
    stringify({
      status: 'ROLL_RESIDUAL_SWEPT',
      tokenId: pending.targetTokenId,
      liquidity: { before: sweep.liquidityBefore, added: sweep.liquidityAdded, after: sweep.liquidityAfter },
      addedUnderlying: { spy: formatUnits(addedSpy, 18), pair: formatUnits(addedPair, 18) },
      residual: { spy: formatUnits(residualSpy, 18), pair: formatUnits(residualPair, 18), marked },
      protectedPositionsUnchanged: true,
      gasSpentEth: formatEther(BigInt(sweep.gasSpentWei)),
      finalEth: formatEther(finalEth),
      transaction: pending.transaction,
      transactions: sweep.transactions,
    }),
  )
  return sweep
}

function rememberRollResidualTransaction(state, pending, result) {
  if (!result) {
    pending.currentStep = null
    writeState(state)
    return
  }
  pending.transactions = [...new Set([...(pending.transactions || []), result.hash])]
  pending.currentStep = null
  writeState(state)
}

async function reconcileRollResidualSwap(state, pending) {
  if (!pending.swapTransaction || pending.rebalanceComplete) return
  if (!pending.swapPlan) throw new Error('迁移残余配平交易存在，但缺少计划')
  const receipt = await publicClient.getTransactionReceipt({ hash: pending.swapTransaction })
  if (receipt.status !== 'success') throw new Error(`迁移残余配平回执不是 success：${pending.swapTransaction}`)
  const zeroForOne = pending.swapPlan.zeroForOne
  const spyNet = tokenNetFromReceipt(receipt, SPY)
  const pairNet = tokenNetFromReceipt(receipt, PAIR)
  const actualInput = zeroForOne ? -spyNet : -pairNet
  const actualOutput = zeroForOne ? pairNet : spyNet
  if (actualInput !== BigInt(pending.swapPlan.inputWei) || actualOutput < BigInt(pending.swapPlan.minimumOutputWei)) {
    throw new Error('迁移残余配平回执中的实际输入或输出不符合保护条件')
  }
  const [walletSpy, walletPair] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  if (walletSpy < baselineSpy || walletPair < baselinePair) throw new Error('迁移残余配平动用了动态钱包基线')
  pending.availableSpyWei = (walletSpy - baselineSpy).toString()
  pending.availablePairWei = (walletPair - baselinePair).toString()
  pending.rebalance = {
    direction: pending.swapPlan.direction,
    inputWei: actualInput.toString(),
    outputWei: actualOutput.toString(),
    minimumOutputWei: pending.swapPlan.minimumOutputWei,
    transaction: pending.swapTransaction,
  }
  pending.rebalanceComplete = true
  pending.status = 'rebalanced'
  writeState(state)
}

async function continueRollResidualSweep(state, pending) {
  if (pending.unknownTransaction) {
    const unknown = pending.unknownTransaction
    const receipt = await publicClient.getTransactionReceipt({ hash: unknown.hash })
    if (receipt.status === 'reverted') throw new Error(`迁移残余交易已确认回滚，禁止自动重试：${unknown.hash}`)
    pending.transactions = [...new Set([...(pending.transactions || []), unknown.hash])]
    if (unknown.step === 'swap') pending.swapTransaction = unknown.hash
    if (unknown.step === 'increase') pending.transaction = unknown.hash
    delete pending.unknownTransaction
    pending.currentStep = null
    writeState(state)
  }
  if (pending.transaction) return finalizeRollResidualSweep(state, pending)
  await reconcileRollResidualSwap(state, pending)
  const [nonceLatest, noncePending, targetOwner, targetLiquidity, spyBalance, pairBalance, poolState] =
    await Promise.all([
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [BigInt(pending.targetTokenId)],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(pending.targetTokenId)],
      }),
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      getPoolState(),
    ])
  if (nonceLatest !== noncePending)
    throw new Error(`残余追加广播前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (targetOwner.toLowerCase() !== WALLET.toLowerCase()) throw new Error('残余追加目标 NFT 所有权变化')
  if (targetLiquidity !== BigInt(pending.targetLiquidityBefore)) throw new Error('残余追加目标 liquidity 变化')
  await readRollResidualProtectedInvariants(pending)
  if (
    spyBalance !== BigInt(pending.baselineSpyWei) + BigInt(pending.availableSpyWei) ||
    pairBalance !== BigInt(pending.baselinePairWei) + BigInt(pending.availablePairWei)
  ) {
    throw new Error('残余追加前钱包余额不等于动态基线加目标残余')
  }
  const rangePositionBps = customRangePositionBps(poolState.tick, pending.tickLower, pending.tickUpper)
  if (rangePositionBps < ATTACK_MIN_RANGE_POSITION_BPS || rangePositionBps > ATTACK_MAX_RANGE_POSITION_BPS) {
    throw new Error(`残余追加前价格接近区间边界：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
  }
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  if (!pending.rebalanceComplete) {
    const plan = await solveCustomRangeRebalance(
      BigInt(pending.availableSpyWei),
      BigInt(pending.availablePairWei),
      poolState,
      pending.tickLower,
      pending.tickUpper,
    )
    if (plan.direction === 'NONE') {
      pending.rebalance = { direction: 'NONE', inputWei: '0', outputWei: '0', transaction: null }
      pending.rebalanceComplete = true
      writeState(state)
    } else {
      const inputToken = plan.zeroForOne ? SPY : PAIR
      const inputSymbol = plan.zeroForOne ? 'SPY' : 'PAIR'
      const outputSymbol = plan.zeroForOne ? 'PAIR' : 'SPY'
      pending.currentStep = 'approve_erc20'
      writeState(state)
      rememberRollResidualTransaction(
        state,
        pending,
        await approveErc20(
          walletClient,
          inputToken,
          plan.amountIn,
          `迁移残余授权 ${inputSymbol} 给 Permit2 (${pending.id})`,
          ATTACK_MIN_ETH_RESERVE,
        ),
      )
      pending.currentStep = 'approve_permit2'
      writeState(state)
      rememberRollResidualTransaction(
        state,
        pending,
        await approvePermit2(
          walletClient,
          inputToken,
          UNIVERSAL_ROUTER,
          plan.amountIn,
          `迁移残余授权路由使用 ${inputSymbol} (${pending.id})`,
          ATTACK_MIN_ETH_RESERVE,
        ),
      )
      const liveQuote = await quotePairPoolSwap(plan.amountIn, plan.zeroForOne)
      const minimumOutput = bpsFloor(liveQuote.amountOut, SWAP_SLIPPAGE_BPS)
      pending.swapPlan = {
        direction: plan.direction,
        zeroForOne: plan.zeroForOne,
        inputWei: plan.amountIn.toString(),
        quotedOutputWei: liveQuote.amountOut.toString(),
        minimumOutputWei: minimumOutput.toString(),
      }
      pending.currentStep = 'swap'
      pending.status = 'swap_prepared'
      writeState(state)
      const swapData = buildV4SwapData(plan.amountIn, minimumOutput, BigInt(nowSeconds() + 5 * 60), plan.zeroForOne)
      const swapped = await sendChecked(walletClient, {
        label: `迁移残余配平 ${inputSymbol}→${outputSymbol} (${pending.id})`,
        to: UNIVERSAL_ROUTER,
        data: swapData,
        minimumBalanceAfter: ATTACK_MIN_ETH_RESERVE,
        fast: true,
        gasPriceMultiplierBps: 11_000n,
        gasBudgetSafetyBps: 10_000n,
      })
      pending.swapTransaction = swapped.hash
      rememberRollResidualTransaction(state, pending, swapped)
      await reconcileRollResidualSwap(state, pending)
    }
  }

  const [spyBeforeIncrease, pairBeforeIncrease, targetLiquidityBeforeIncrease] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(pending.targetTokenId)],
    }),
  ])
  if (
    spyBeforeIncrease !== BigInt(pending.baselineSpyWei) + BigInt(pending.availableSpyWei) ||
    pairBeforeIncrease !== BigInt(pending.baselinePairWei) + BigInt(pending.availablePairWei)
  ) {
    throw new Error('配平后余额不等于动态基线加目标残余')
  }
  if (targetLiquidityBeforeIncrease !== BigInt(pending.targetLiquidityBefore))
    throw new Error('配平后目标 liquidity 发生变化')
  const targetRecord = {
    tokenId: pending.targetTokenId,
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
    liquidity: pending.targetLiquidityBefore,
  }
  const increase = await buildCustomRangeIncrease(
    account,
    targetRecord,
    BigInt(pending.availableSpyWei),
    BigInt(pending.availablePairWei),
    {
      minimumRangePositionBps: ATTACK_MIN_RANGE_POSITION_BPS,
      maximumRangePositionBps: ATTACK_MAX_RANGE_POSITION_BPS,
      slippageTolerance: ATTACK_RESIDUAL_MINT_SLIPPAGE,
    },
  )
  pending.increasePlan = {
    liquidityBefore: increase.currentLiquidity.toString(),
    liquidityAdded: increase.liquidity.toString(),
    expectedLiquidityAfter: (increase.currentLiquidity + increase.liquidity).toString(),
    desiredSpyWei: increase.amount0Desired.toString(),
    desiredPairWei: increase.amount1Desired.toString(),
    targetFeesAtBuildSpyWei: increase.fees.spyWei.toString(),
    targetFeesAtBuildPairWei: increase.fees.pairWei.toString(),
  }
  pending.currentStep = 'increase'
  pending.status = 'prepared'
  writeState(state)
  const result = await sendChecked(walletClient, {
    label: `迁移残余追加 NFT ${pending.targetTokenId} (${pending.id})`,
    to: POSITION_MANAGER,
    data: increase.data,
    minimumBalanceAfter: ATTACK_MIN_ETH_RESERVE,
    fast: true,
    gasPriceMultiplierBps: 11_000n,
    gasBudgetSafetyBps: 10_000n,
  })
  pending.transaction = result.hash
  pending.status = 'confirmed'
  rememberRollResidualTransaction(state, pending, result)
  return finalizeRollResidualSweep(state, pending)
}

function markRollResidualPartial(operationId, error) {
  const state = readState()
  const pending = state?.pendingRollResidual
  if (!pending || pending.id !== operationId) return
  const message = error.shortMessage || error.message
  const hash = String(message).match(/0x[0-9a-fA-F]{64}/)?.[0]
  if (hash && String(message).includes('回执未知'))
    pending.unknownTransaction = { hash, step: pending.currentStep || 'unknown' }
  const hasChainActivity = Boolean(pending.transaction || pending.unknownTransaction)
  if (!hasChainActivity) delete state.pendingRollResidual
  else {
    pending.status = 'partial'
    pending.lastErrorAt = new Date().toISOString()
    pending.lastError = message
  }
  writeState(state)
  appendAudit('roll_residual_sweep_partial', {
    id: operationId,
    message,
    transaction: pending.transaction || null,
    unknownTransaction: pending.unknownTransaction || null,
  })
}

async function rollResidualSweepEnter() {
  const check = await rollResidualSweepPreflight({ print: true })
  const id = `roll-residual-${check.targetRecord.tokenId}-${new Date().toISOString().replace(/[-:.]/g, '')}`
  const state = check.state
  state.pendingRollResidual = {
    id,
    status: 'planned',
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    targetTokenId: String(check.targetRecord.tokenId),
    tickLower: check.targetRecord.tickLower,
    tickUpper: check.targetRecord.tickUpper,
    targetLiquidityBefore: check.targetRecord.liquidity,
    baselineSpyWei: check.baselineSpy.toString(),
    baselinePairWei: check.baselinePair.toString(),
    availableSpyWei: check.availableSpy.toString(),
    availablePairWei: check.availablePair.toString(),
    spyBeforeWei: check.spyBalance.toString(),
    pairBeforeWei: check.pairBalance.toString(),
    protectedPositions: check.protectedReads.map((item) => ({
      tokenId: item.tokenId,
      liquidity: item.liquidity.toString(),
    })),
    rebalanceComplete: false,
    transactions: [],
  }
  writeState(state)
  appendAudit('roll_residual_sweep_plan_created', state.pendingRollResidual)
  try {
    return await continueRollResidualSweep(state, state.pendingRollResidual)
  } catch (error) {
    markRollResidualPartial(id, error)
    throw error
  }
}

async function rollResidualSweepResume() {
  const state = readState()
  const pending = state?.pendingRollResidual
  if (!state || state.status !== 'active' || !pending) throw new Error('没有可恢复的迁移残余追加计划')
  try {
    return await continueRollResidualSweep(state, pending)
  } catch (error) {
    markRollResidualPartial(pending.id, error)
    throw error
  }
}

function validateCurrentBandParameters() {
  if (CURRENT_BAND_TOTAL_ETH <= 0n || CURRENT_BAND_TOTAL_ETH % 2n !== 0n) {
    throw new Error('当前热区仓总 ETH 必须是可两等分的正数')
  }
  if ((CURRENT_BAND_TICK_LOWER === null) !== (CURRENT_BAND_TICK_UPPER === null)) {
    throw new Error('固定 tick 区间必须同时提供 lower 与 upper')
  }
  if (
    CURRENT_BAND_TICK_LOWER !== null &&
    (!Number.isSafeInteger(CURRENT_BAND_TICK_LOWER) ||
      !Number.isSafeInteger(CURRENT_BAND_TICK_UPPER) ||
      CURRENT_BAND_TICK_LOWER >= CURRENT_BAND_TICK_UPPER ||
      CURRENT_BAND_TICK_LOWER % poolKey.tickSpacing !== 0 ||
      CURRENT_BAND_TICK_UPPER % poolKey.tickSpacing !== 0)
  ) {
    throw new Error(`当前热区仓固定 tick 无效：[${CURRENT_BAND_TICK_LOWER},${CURRENT_BAND_TICK_UPPER})`)
  }
}

function currentBandTargetForTick(tick) {
  if (CURRENT_BAND_TICK_LOWER !== null) {
    return { tickLower: CURRENT_BAND_TICK_LOWER, tickUpper: CURRENT_BAND_TICK_UPPER, mode: 'fixed_override' }
  }
  const centerTick = Math.round(tick / poolKey.tickSpacing) * poolKey.tickSpacing
  const halfWidth = CURRENT_BAND_WIDTH_TICKS / 2
  return {
    centerTick,
    tickLower: centerTick - halfWidth,
    tickUpper: centerTick + halfWidth,
    mode: 'live_centered_volume_validated',
  }
}

async function fetchCurrentBandSnapshot(windowId) {
  const response = await fetch(`${CURRENT_BAND_DASHBOARD}/api/snapshot?window=${windowId}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`公开面板 ${windowId} 返回 HTTP ${response.status}`)
  const snapshot = await response.json()
  if (
    snapshot.status !== 'LIVE' ||
    snapshot.chain?.id !== CHAIN_ID ||
    String(snapshot.pool?.poolId).toLowerCase() !== POOL_ID.toLowerCase()
  ) {
    throw new Error(`公开面板 ${windowId} 不是可用的 Robinhood PAIR/SPY 快照`)
  }
  const ageMilliseconds = Date.now() - Date.parse(snapshot.pool.blockTime)
  if (!Number.isFinite(ageMilliseconds) || ageMilliseconds < -30_000 || ageMilliseconds > 180_000) {
    throw new Error(`公开面板 ${windowId} 快照过旧：blockTime=${snapshot.pool.blockTime}`)
  }
  return snapshot
}

function currentBandWindowMetrics(snapshot, projectedLiquidity, capitalUsdg, tickLower, tickUpper) {
  const bins = (snapshot.analytics?.bins || []).filter((item) => Number(item.volumeUsdg || 0) > 0)
  const totalVolumeUsdg = bins.reduce((sum, item) => sum + Number(item.volumeUsdg || 0), 0)
  let coveredVolumeUsdg = 0
  let estimatedFeeUsdg = 0
  let feeWeightedShareNumerator = 0
  let coveredGrossFeeUsdg = 0
  for (const item of bins) {
    if (Number(item.tickLower) < tickLower || Number(item.tickUpper) > tickUpper) continue
    const volume = Number(item.volumeUsdg || 0)
    const grossFee = Number(item.grossFeeUsdg || 0)
    const marketLiquidity = BigInt(item.marketLiquidity || 0)
    const denominator = marketLiquidity + projectedLiquidity
    const share = denominator === 0n ? 0 : Number((projectedLiquidity * 1_000_000_000n) / denominator) / 1_000_000_000
    coveredVolumeUsdg += volume
    coveredGrossFeeUsdg += grossFee
    estimatedFeeUsdg += grossFee * share
    feeWeightedShareNumerator += grossFee * share
  }
  const hours = snapshot.selectedWindow === '1h' ? 1 : snapshot.selectedWindow === '6h' ? 6 : 24
  return {
    id: snapshot.selectedWindow,
    blockNumber: String(snapshot.pool.blockNumber),
    blockTime: snapshot.pool.blockTime,
    currentTick: Number(snapshot.pool.currentTick),
    currentPairPriceUsdg: Number(snapshot.pool.pairUsdg),
    totalVolumeUsdg,
    coveredVolumeUsdg,
    coveragePct: totalVolumeUsdg > 0 ? (coveredVolumeUsdg / totalVolumeUsdg) * 100 : 0,
    coveredGrossFeeUsdg,
    modeledFeeUsdg: estimatedFeeUsdg,
    modeledHourlyFeeUsdg: estimatedFeeUsdg / hours,
    modeledDailyRatePct: capitalUsdg > 0 ? (estimatedFeeUsdg / capitalUsdg / hours) * 24 * 100 : 0,
    feeWeightedSharePct: coveredGrossFeeUsdg > 0 ? (feeWeightedShareNumerator / coveredGrossFeeUsdg) * 100 : 0,
  }
}

async function currentBandMarketEvidence(poolState, projectedLiquidity, capitalUsdg, tickLower, tickUpper) {
  const snapshots = await Promise.all([fetchCurrentBandSnapshot('1h'), fetchCurrentBandSnapshot('6h')])
  for (const snapshot of snapshots) {
    if (Math.abs(Number(snapshot.pool.currentTick) - poolState.tick) > 400) {
      throw new Error(`面板与 RPC 当前 tick 偏差过大：dashboard=${snapshot.pool.currentTick}, rpc=${poolState.tick}`)
    }
  }
  const windows = Object.fromEntries(
    snapshots.map((snapshot) => [
      snapshot.selectedWindow,
      currentBandWindowMetrics(snapshot, projectedLiquidity, capitalUsdg, tickLower, tickUpper),
    ]),
  )
  if (windows['1h'].coveragePct < 95) {
    throw new Error(`目标区间仅覆盖近 1h 成交量 ${windows['1h'].coveragePct.toFixed(2)}%`)
  }
  if (windows['6h'].coveragePct < 50) {
    throw new Error(`目标区间仅覆盖近 6h 成交量 ${windows['6h'].coveragePct.toFixed(2)}%`)
  }
  return {
    source: CURRENT_BAND_DASHBOARD,
    selectedPool: 'PAIR/SPY 1%',
    selectionReason: '近 6h/24h 实际费率速度领先 PAIR/USDG；新区间覆盖近 1h 主要成交路径并按市场流动性计入加入后份额',
    windows,
  }
}

async function currentBandPreflight({ print = true, requireReady = false } = {}) {
  validateCurrentBandParameters()
  const state = readState()
  if (!state || state.status !== 'active' || !state.position?.tokenId) throw new Error('没有活动的 PAIR/SPY 主账本')
  for (const key of [
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
    'pendingCurrentBand',
  ]) {
    if (state[key]) throw new Error(`存在未结算计划 ${key}：${state[key].id || 'unknown'}`)
  }
  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const records = activePairPositionRecords(state)
  const [
    blockNumber,
    nonceLatest,
    noncePending,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    gasPrice,
    spyMark,
    ethToSpy,
    positionReads,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    getPoolState(),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getGasPrice(),
    quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT),
    quoteBestEthToSpy(CURRENT_BAND_TOTAL_ETH),
    Promise.all(
      records.map(async (record) => ({
        tokenId: String(record.tokenId),
        owner: await publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [BigInt(record.tokenId)],
        }),
        liquidity: await publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(record.tokenId)],
        }),
        expectedLiquidity: BigInt(record.liquidity),
      })),
    ),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  for (const item of positionReads) {
    if (item.owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`受保护 LP ${item.tokenId} 所有权异常`)
    if (item.liquidity !== item.expectedLiquidity) throw new Error(`受保护 LP ${item.tokenId} liquidity 与账本不符`)
  }
  const target = currentBandTargetForTick(poolState.tick)
  if (records.some((record) => record.tickLower === target.tickLower && record.tickUpper === target.tickUpper)) {
    throw new Error('已存在相同区间的活动 LP，禁止重复铸仓')
  }
  const rangePositionBps = customRangePositionBps(poolState.tick, target.tickLower, target.tickUpper)
  if (
    rangePositionBps < CURRENT_BAND_MIN_RANGE_POSITION_BPS ||
    rangePositionBps > CURRENT_BAND_MAX_RANGE_POSITION_BPS
  ) {
    throw new Error(`当前价格不在新区间安全中部：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
  }

  const rebalance = await solveCustomRangeRebalance(
    ethToSpy.amountOut,
    0n,
    poolState,
    target.tickLower,
    target.tickUpper,
  )
  if (rebalance.direction !== 'SPY_TO_PAIR') throw new Error(`新仓配平方向异常：${rebalance.direction}`)
  const projectedPool = makePool(poolState)
  const projectedPosition = Position.fromAmounts({
    pool: projectedPool,
    tickLower: target.tickLower,
    tickUpper: target.tickUpper,
    amount0: rebalance.expectedSpyWei.toString(),
    amount1: rebalance.expectedPairWei.toString(),
    useFullPrecision: true,
  })
  const projectedLiquidity = asBigInt(projectedPosition.liquidity)
  if (projectedLiquidity === 0n) throw new Error('新仓预计 liquidity 为 0')
  const principalUsdgAtomic = (ethToSpy.amountOut * spyMark.amountOut) / ADD_SPY_MARK_INPUT
  const capitalUsdg = Number(principalUsdgAtomic) / 1e6
  const marketEvidence = await currentBandMarketEvidence(
    poolState,
    projectedLiquidity,
    capitalUsdg,
    target.tickLower,
    target.tickUpper,
  )

  const firstSwapMinimum = bpsFloor(ethToSpy.amountOut, CURRENT_BAND_ETH_SWAP_SLIPPAGE_BPS)
  const firstSwapData = buildV3SwapData(ethToSpy.path, CURRENT_BAND_TOTAL_ETH, firstSwapMinimum)
  const firstSwapBudget = await transactionBudget(V3_ROUTER, firstSwapData, CURRENT_BAND_TOTAL_ETH)
  const [spyErc20Allowance, pairErc20Allowance, routerAllowance] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
    publicClient.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [WALLET, SPY, UNIVERSAL_ROUTER],
    }),
  ])
  const erc20Approvals =
    Number(spyErc20Allowance < ethToSpy.amountOut) + Number(pairErc20Allowance < rebalance.expectedPairWei)
  const permit2Approval = Number(
    routerAllowance[0] < rebalance.amountIn || routerAllowance[1] <= BigInt(nowSeconds() + 300),
  )
  const modeledGasUnits =
    firstSwapBudget.estimatedGas +
    CURRENT_BAND_GAS_MODEL.v4Swap +
    CURRENT_BAND_GAS_MODEL.mint +
    BigInt(erc20Approvals) * CURRENT_BAND_GAS_MODEL.erc20Approval +
    BigInt(permit2Approval) * CURRENT_BAND_GAS_MODEL.permit2Approval
  const safeModeledGasUnits = (modeledGasUnits * CURRENT_BAND_GAS_MODEL.safetyBps + 9_999n) / 10_000n
  const modeledSendGasPrice = (gasPrice * CURRENT_BAND_GAS_MODEL.sendGasPriceBps + 9_999n) / 10_000n
  const modeledGasWei = safeModeledGasUnits * modeledSendGasPrice
  const maximumGasWei = (CURRENT_BAND_MAX_GAS_USDG_ATOMIC * CURRENT_BAND_TOTAL_ETH) / principalUsdgAtomic
  const modeledGasUsdgAtomic = (modeledGasWei * principalUsdgAtomic) / CURRENT_BAND_TOTAL_ETH
  const requiredEth = CURRENT_BAND_TOTAL_ETH + CURRENT_BAND_MIN_ETH_RESERVE + maximumGasWei
  const status = ethBalance < requiredEth ? 'NEEDS_ETH_TOP_UP' : modeledGasWei > maximumGasWei ? 'WAIT_GAS' : 'READY'
  const spyPriceUsdg = Number(formatUnits(spyMark.amountOut, 6)) / Number(formatUnits(ADD_SPY_MARK_INPUT, 18))
  const prices = customRangePricesUsdg(spyPriceUsdg, target.tickLower, target.tickUpper)
  const report = {
    status,
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    balances: {
      eth: formatEther(ethBalance),
      protectedSpy: formatUnits(spyBalance, 18),
      protectedPair: formatUnits(pairBalance, 18),
    },
    choice: {
      pool: 'PAIR/SPY 1%',
      poolId: POOL_ID,
      mode: target.mode,
      tickLower: target.tickLower,
      tickUpper: target.tickUpper,
      priceLowUsdg: prices.low.toFixed(8),
      priceHighUsdg: prices.high.toFixed(8),
      currentTick: poolState.tick,
      currentPairPriceUsdg: (spyPriceUsdg / Math.pow(1.0001, poolState.tick)).toFixed(8),
      rangePositionPct: (Number(rangePositionBps) / 100).toFixed(2),
    },
    funding: {
      totalEth: formatEther(CURRENT_BAND_TOTAL_ETH),
      targetPerSideEth: formatEther(CURRENT_BAND_PER_SIDE_ETH),
      ethToSpyRouteFees: ethToSpy.fees,
      expectedSpy: formatUnits(ethToSpy.amountOut, 18),
      minimumSpy: formatUnits(firstSwapMinimum, 18),
      markedCapitalUsdg: capitalUsdg.toFixed(6),
    },
    rebalance: {
      direction: rebalance.direction,
      inputSpy: formatUnits(rebalance.amountIn, 18),
      quotedPair: formatUnits(rebalance.amountOut, 18),
      expectedMintSpy: formatUnits(rebalance.expectedSpyWei, 18),
      expectedMintPair: formatUnits(rebalance.expectedPairWei, 18),
      targetValueSplitPct: {
        spy: (Number(rebalance.targetSpyValueBps) / 100).toFixed(2),
        pair: (Number(rebalance.targetPairValueBps) / 100).toFixed(2),
      },
    },
    projectedMint: {
      liquidity: projectedLiquidity.toString(),
      activeSharePct: (
        Number((projectedLiquidity * 1_000_000_000n) / (poolState.liquidity + projectedLiquidity)) / 10_000_000
      ).toFixed(6),
    },
    marketEvidence,
    protectedPositions: positionReads.map((item) => ({ tokenId: item.tokenId, liquidity: item.liquidity.toString() })),
    gas: {
      gasPriceGwei: (Number(gasPrice) / 1e9).toFixed(6),
      modeledGasUnits: modeledGasUnits.toString(),
      safeModeledGasUnits: safeModeledGasUnits.toString(),
      modeledGasEth: formatEther(modeledGasWei),
      modeledGasUsdg: formatUnits(modeledGasUsdgAtomic, 6),
      maximumGasUsdg: formatUnits(CURRENT_BAND_MAX_GAS_USDG_ATOMIC, 6),
      maximumGasEth: formatEther(maximumGasWei),
      expectedApprovalTransactions: erc20Approvals + permit2Approval,
      minimumFinalEth: formatEther(CURRENT_BAND_MIN_ETH_RESERVE),
      requiredEth: formatEther(requiredEth),
    },
    policy: {
      preserveExistingWalletTokens: true,
      preserveExistingLpLiquidity: true,
      collectFees: false,
      autoExit: false,
      swapSlippageBps: Number(SWAP_SLIPPAGE_BPS),
      ethSwapSlippageBps: Number(CURRENT_BAND_ETH_SWAP_SLIPPAGE_BPS),
      mintSlippageBps: 50,
    },
  }
  appendAudit('current_band_preflight', report)
  if (print) console.log(stringify(report))
  if (requireReady && status !== 'READY') throw new Error(`当前热区仓预检未就绪：${status}`)
  return {
    state,
    report,
    blockNumber,
    ethBalance,
    spyBalance,
    pairBalance,
    poolState,
    positionReads,
    maximumGasWei,
  }
}

function rememberCurrentBandTransaction(state, pending, result) {
  if (result) pending.transactions = [...new Set([...(pending.transactions || []), result.hash])]
  pending.currentStep = null
  writeState(state)
}

async function currentBandConfirmedTransactions(pending) {
  return Promise.all(
    [...new Set(pending.transactions || [])].map(async (hash) => {
      const receipt = await publicClient.getTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`当前热区仓历史交易不是 success：${hash}`)
      return { hash, receipt, gasCost: receipt.gasUsed * receipt.effectiveGasPrice }
    }),
  )
}

async function readCurrentBandProtectedInvariants(pending) {
  return Promise.all(
    pending.protectedPositions.map(async (item) => {
      const [owner, liquidity] = await Promise.all([
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [BigInt(item.tokenId)],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(item.tokenId)],
        }),
      ])
      if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`受保护 LP ${item.tokenId} 所有权发生变化`)
      if (liquidity !== BigInt(item.liquidity)) throw new Error(`受保护 LP ${item.tokenId} liquidity 发生变化`)
      return { tokenId: item.tokenId, liquidity }
    }),
  )
}

async function resolveCurrentBandUnknownTransaction(state, pending) {
  if (!pending.unknownTransaction) return
  const unknown = pending.unknownTransaction
  const receipt = await publicClient.getTransactionReceipt({ hash: unknown.hash })
  if (receipt.status !== 'success') throw new Error(`当前热区仓未知交易已回滚，禁止自动重试：${unknown.hash}`)
  pending.transactions = [...new Set([...(pending.transactions || []), unknown.hash])]
  if (unknown.step === 'eth_to_spy') pending.ethToSpyTransaction = unknown.hash
  if (unknown.step === 'rebalance') pending.rebalanceTransaction = unknown.hash
  if (unknown.step === 'mint') pending.mintTransaction = unknown.hash
  delete pending.unknownTransaction
  pending.currentStep = null
  writeState(state)
}

async function reconcileCurrentBandFunding(state, pending) {
  if (!pending.ethToSpyTransaction || pending.fundingComplete) return
  const receipt = await publicClient.getTransactionReceipt({ hash: pending.ethToSpyTransaction })
  if (receipt.status !== 'success') throw new Error(`ETH→SPY 回执不是 success：${pending.ethToSpyTransaction}`)
  const actualSpy = tokenNetFromReceipt(receipt, SPY)
  if (actualSpy < BigInt(pending.ethToSpyMinimumWei)) throw new Error('ETH→SPY 实际到账低于保护值')
  const [walletSpy, walletPair] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  if (walletSpy !== baselineSpy + actualSpy || walletPair !== baselinePair) {
    throw new Error('ETH→SPY 后钱包余额不等于受保护基线加本次到账')
  }
  pending.actualSpyReceivedWei = actualSpy.toString()
  pending.availableSpyWei = actualSpy.toString()
  pending.availablePairWei = '0'
  pending.fundingComplete = true
  pending.status = 'funded'
  writeState(state)
}

async function reconcileCurrentBandRebalance(state, pending) {
  if (!pending.rebalanceTransaction || pending.rebalanceComplete) return
  const receipt = await publicClient.getTransactionReceipt({ hash: pending.rebalanceTransaction })
  if (receipt.status !== 'success') throw new Error(`SPY→PAIR 回执不是 success：${pending.rebalanceTransaction}`)
  const actualInput = -tokenNetFromReceipt(receipt, SPY)
  const actualOutput = tokenNetFromReceipt(receipt, PAIR)
  if (
    actualInput !== BigInt(pending.rebalancePlan.inputSpyWei) ||
    actualOutput < BigInt(pending.rebalancePlan.minimumPairWei)
  ) {
    throw new Error('SPY→PAIR 回执中的实际输入或输出不符合保护')
  }
  const [walletSpy, walletPair] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  const availableSpy = BigInt(pending.actualSpyReceivedWei) - actualInput
  const availablePair = actualOutput
  if (walletSpy !== baselineSpy + availableSpy || walletPair !== baselinePair + availablePair) {
    throw new Error('SPY→PAIR 后钱包余额不等于受保护基线加本次资产')
  }
  pending.availableSpyWei = availableSpy.toString()
  pending.availablePairWei = availablePair.toString()
  pending.rebalance = {
    direction: 'SPY_TO_PAIR',
    inputSpyWei: actualInput.toString(),
    outputPairWei: actualOutput.toString(),
    minimumPairWei: pending.rebalancePlan.minimumPairWei,
    transaction: pending.rebalanceTransaction,
  }
  pending.rebalanceComplete = true
  pending.status = 'rebalanced'
  writeState(state)
}

async function finalizeCurrentBand(state, pending) {
  if (!pending.mintTransaction || !pending.mintPlan) throw new Error('当前热区仓没有可结算的 mint')
  const mintReceipt = await publicClient.getTransactionReceipt({ hash: pending.mintTransaction })
  if (mintReceipt.status !== 'success') throw new Error(`mint 回执不是 success：${pending.mintTransaction}`)
  const tokenId = parseMintTokenId(mintReceipt)
  if (tokenId === null) throw new Error(`mint 成功但未解析到 NFT：${pending.mintTransaction}`)
  const [owner, liquidity, finalEth, finalSpy, finalPair, poolState, invariants] = await Promise.all([
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
    getPoolState(),
    readCurrentBandProtectedInvariants(pending),
  ])
  if (owner.toLowerCase() !== WALLET.toLowerCase() || liquidity === 0n) throw new Error('当前热区仓 NFT 链上读回不完整')
  if (liquidity !== BigInt(pending.mintPlan.liquidity))
    throw new Error(`mint liquidity 不一致：chain=${liquidity}, plan=${pending.mintPlan.liquidity}`)
  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  if (finalSpy < baselineSpy || finalPair < baselinePair) throw new Error('mint 动用了钱包原有 SPY/PAIR')
  if (finalEth < CURRENT_BAND_MIN_ETH_RESERVE)
    throw new Error(`mint 后 ETH 低于 ${formatEther(CURRENT_BAND_MIN_ETH_RESERVE)}`)
  const position = new Position({
    pool: makePool(poolState),
    liquidity: liquidity.toString(),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
  })
  const underlyingSpyWei = asBigInt(position.amount0.quotient)
  const underlyingPairWei = asBigInt(position.amount1.quotient)
  const residualSpyWei = finalSpy - baselineSpy
  const residualPairWei = finalPair - baselinePair
  const spyMark = await quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT)
  const spyPriceUsdg = Number(formatUnits(spyMark.amountOut, 6)) / Number(formatUnits(ADD_SPY_MARK_INPUT, 18))
  const prices = customRangePricesUsdg(spyPriceUsdg, pending.tickLower, pending.tickUpper)
  const transactions = await currentBandConfirmedTransactions(pending)
  const gasSpentWei = receiptGasTotal(transactions)
  if (gasSpentWei > BigInt(pending.maximumGasWei)) {
    throw new Error(`当前热区仓实际 Gas 超过 5 USDG 等值上限`)
  }
  const completedAt = new Date().toISOString()
  const record = {
    id: pending.id,
    label: '当前热区小仓',
    role: 'current-volume-canary',
    status: 'active',
    completedAt,
    tokenId: tokenId.toString(),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
    liquidity: liquidity.toString(),
    source: `${formatEther(BigInt(pending.totalPrincipalEthWei))} ETH converted to SPY, then partially rebalanced to PAIR; pre-existing wallet tokens excluded`,
    policy: {
      mode: 'grid_hold_out_of_range',
      autoExit: false,
      totalPrincipalEthWei: pending.totalPrincipalEthWei,
      targetPerSideEthWei: pending.perSideEthWei,
      preserveWalletTokenBaseline: true,
      preserveOtherLpLiquidity: true,
      maximumGasUsdg: '5',
      minimumFinalEthWei: CURRENT_BAND_MIN_ETH_RESERVE.toString(),
    },
    funding: {
      ethSpentWei: pending.totalPrincipalEthWei,
      spyReceivedWei: pending.actualSpyReceivedWei,
      transaction: pending.ethToSpyTransaction,
    },
    rebalance: pending.rebalance,
    minted: {
      desiredSpyWei: pending.mintPlan.desiredSpyWei,
      desiredPairWei: pending.mintPlan.desiredPairWei,
      underlyingSpyWei: underlyingSpyWei.toString(),
      underlyingPairWei: underlyingPairWei.toString(),
    },
    residual: { spyWei: residualSpyWei.toString(), pairWei: residualPairWei.toString() },
    excludedWalletBaseline: { spyWei: pending.baselineSpyWei, pairWei: pending.baselinePairWei },
    protectedPositionInvariants: invariants.map((item) => ({
      tokenId: item.tokenId,
      liquidityAfter: item.liquidity.toString(),
    })),
    marketSelection: pending.marketEvidence,
    priceSnapshot: {
      spyPriceUsdg: spyPriceUsdg.toFixed(6),
      currentPairPriceUsdg: (spyPriceUsdg / Math.pow(1.0001, poolState.tick)).toFixed(8),
      actualPairPriceLowUsdg: prices.low.toFixed(8),
      actualPairPriceHighUsdg: prices.high.toFixed(8),
      currentTick: poolState.tick,
    },
    gasSpentWei: gasSpentWei.toString(),
    finalEthWei: finalEth.toString(),
    transactions: transactions.map((item) => item.hash),
    mintBlock: mintReceipt.blockNumber.toString(),
    mintTransaction: pending.mintTransaction,
  }
  state.satellites = [...(state.satellites || []), record]
  state.currentBandEntries = [...(state.currentBandEntries || []), record]
  delete state.pendingCurrentBand
  writeState(state)
  appendAudit('current_band_complete', record)
  console.log(
    stringify({
      status: 'CURRENT_BAND_ACTIVE',
      tokenId,
      liquidity,
      tickLower: record.tickLower,
      tickUpper: record.tickUpper,
      priceSnapshot: record.priceSnapshot,
      funding: {
        totalEth: formatEther(BigInt(record.funding.ethSpentWei)),
        targetPerSideEth: formatEther(BigInt(record.policy.targetPerSideEthWei)),
        receivedSpy: formatUnits(BigInt(record.funding.spyReceivedWei), 18),
      },
      rebalance: {
        inputSpy: formatUnits(BigInt(record.rebalance.inputSpyWei), 18),
        outputPair: formatUnits(BigInt(record.rebalance.outputPairWei), 18),
      },
      underlying: { spy: formatUnits(underlyingSpyWei, 18), pair: formatUnits(underlyingPairWei, 18) },
      residual: { spy: formatUnits(residualSpyWei, 18), pair: formatUnits(residualPairWei, 18) },
      protectedWalletPair: formatUnits(baselinePair, 18),
      protectedPositionsUnchanged: true,
      gasSpentEth: formatEther(gasSpentWei),
      finalEth: formatEther(finalEth),
      transactions: record.transactions,
    }),
  )
  return record
}

async function continueCurrentBand(state, pending) {
  await resolveCurrentBandUnknownTransaction(state, pending)
  if (pending.mintTransaction) return finalizeCurrentBand(state, pending)
  await currentBandConfirmedTransactions(pending)
  await readCurrentBandProtectedInvariants(pending)
  const [nonceLatest, noncePending] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`执行前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })

  if (!pending.ethToSpyTransaction) {
    const [walletSpy, walletPair, poolState, quote] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      getPoolState(),
      quoteBestEthToSpy(BigInt(pending.totalPrincipalEthWei)),
    ])
    if (walletSpy !== BigInt(pending.baselineSpyWei) || walletPair !== BigInt(pending.baselinePairWei)) {
      throw new Error('出资前钱包 SPY/PAIR 偏离受保护基线')
    }
    const rangePositionBps = customRangePositionBps(poolState.tick, pending.tickLower, pending.tickUpper)
    if (
      rangePositionBps < CURRENT_BAND_MIN_RANGE_POSITION_BPS ||
      rangePositionBps > CURRENT_BAND_MAX_RANGE_POSITION_BPS
    ) {
      throw new Error(`出资前价格偏离新区间安全中部：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
    }
    const minimumSpy = bpsFloor(quote.amountOut, CURRENT_BAND_ETH_SWAP_SLIPPAGE_BPS)
    pending.ethToSpyQuotedWei = quote.amountOut.toString()
    pending.ethToSpyMinimumWei = minimumSpy.toString()
    pending.ethToSpyRouteFees = quote.fees
    pending.currentStep = 'eth_to_spy'
    pending.status = 'funding_prepared'
    writeState(state)
    const result = await sendChecked(walletClient, {
      label: `当前热区仓 1/3 ${formatEther(BigInt(pending.totalPrincipalEthWei))} ETH→SPY (${pending.id})`,
      to: V3_ROUTER,
      data: buildV3SwapData(quote.path, BigInt(pending.totalPrincipalEthWei), minimumSpy),
      value: BigInt(pending.totalPrincipalEthWei),
      minimumBalanceAfter: CURRENT_BAND_MIN_ETH_RESERVE,
      fast: true,
      gasPriceMultiplierBps: CURRENT_BAND_GAS_MODEL.sendGasPriceBps,
      gasBudgetSafetyBps: 10_000n,
    })
    pending.ethToSpyTransaction = result.hash
    rememberCurrentBandTransaction(state, pending, result)
  }
  await reconcileCurrentBandFunding(state, pending)

  if (!pending.rebalanceComplete) {
    const [walletSpy, walletPair, poolState] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      getPoolState(),
    ])
    const baselineSpy = BigInt(pending.baselineSpyWei)
    const baselinePair = BigInt(pending.baselinePairWei)
    if (walletSpy !== baselineSpy + BigInt(pending.availableSpyWei) || walletPair !== baselinePair) {
      throw new Error('配平前钱包余额不等于受保护基线加本次资产')
    }
    const rangePositionBps = customRangePositionBps(poolState.tick, pending.tickLower, pending.tickUpper)
    if (
      rangePositionBps < CURRENT_BAND_MIN_RANGE_POSITION_BPS ||
      rangePositionBps > CURRENT_BAND_MAX_RANGE_POSITION_BPS
    ) {
      throw new Error(`配平前价格偏离新区间安全中部：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
    }
    const plan = await solveCustomRangeRebalance(
      BigInt(pending.availableSpyWei),
      0n,
      poolState,
      pending.tickLower,
      pending.tickUpper,
    )
    if (plan.direction !== 'SPY_TO_PAIR') throw new Error(`配平方向变为 ${plan.direction}`)
    pending.currentStep = 'approve_swap_erc20'
    writeState(state)
    rememberCurrentBandTransaction(
      state,
      pending,
      await approveErc20(
        walletClient,
        SPY,
        BigInt(pending.availableSpyWei),
        `当前热区仓授权 SPY 给 Permit2 (${pending.id})`,
        CURRENT_BAND_MIN_ETH_RESERVE,
      ),
    )
    pending.currentStep = 'approve_swap_permit2'
    writeState(state)
    rememberCurrentBandTransaction(
      state,
      pending,
      await approvePermit2(
        walletClient,
        SPY,
        UNIVERSAL_ROUTER,
        plan.amountIn,
        `当前热区仓授权路由使用 SPY (${pending.id})`,
        CURRENT_BAND_MIN_ETH_RESERVE,
      ),
    )
    const liveQuote = await quoteSpyToPair(plan.amountIn)
    const minimumPair = bpsFloor(liveQuote.amountOut, SWAP_SLIPPAGE_BPS)
    pending.rebalancePlan = {
      inputSpyWei: plan.amountIn.toString(),
      quotedPairWei: liveQuote.amountOut.toString(),
      minimumPairWei: minimumPair.toString(),
    }
    pending.currentStep = 'rebalance'
    pending.status = 'rebalance_prepared'
    writeState(state)
    const result = await sendChecked(walletClient, {
      label: `当前热区仓 2/3 SPY→PAIR 配平 (${pending.id})`,
      to: UNIVERSAL_ROUTER,
      data: buildV4SwapData(plan.amountIn, minimumPair, BigInt(nowSeconds() + 5 * 60), true),
      minimumBalanceAfter: CURRENT_BAND_MIN_ETH_RESERVE,
      fast: true,
      gasPriceMultiplierBps: CURRENT_BAND_GAS_MODEL.sendGasPriceBps,
      gasBudgetSafetyBps: 10_000n,
    })
    pending.rebalanceTransaction = result.hash
    rememberCurrentBandTransaction(state, pending, result)
  }
  await reconcileCurrentBandRebalance(state, pending)

  const [spyBeforeMint, pairBeforeMint, poolStateBeforeMint] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
  ])
  const baselineSpy = BigInt(pending.baselineSpyWei)
  const baselinePair = BigInt(pending.baselinePairWei)
  const availableSpy = BigInt(pending.availableSpyWei)
  const availablePair = BigInt(pending.availablePairWei)
  if (spyBeforeMint !== baselineSpy + availableSpy || pairBeforeMint !== baselinePair + availablePair) {
    throw new Error('mint 前钱包余额不等于受保护基线加本次资产')
  }
  const rangePositionBps = customRangePositionBps(poolStateBeforeMint.tick, pending.tickLower, pending.tickUpper)
  if (
    rangePositionBps < CURRENT_BAND_MIN_RANGE_POSITION_BPS ||
    rangePositionBps > CURRENT_BAND_MAX_RANGE_POSITION_BPS
  ) {
    throw new Error(`mint 前价格偏离新区间安全中部：tick=${poolStateBeforeMint.tick}, rangeBps=${rangePositionBps}`)
  }
  pending.currentStep = 'approve_mint_spy'
  writeState(state)
  rememberCurrentBandTransaction(
    state,
    pending,
    await approveErc20(
      walletClient,
      SPY,
      availableSpy,
      `当前热区仓确认 SPY 铸仓授权 (${pending.id})`,
      CURRENT_BAND_MIN_ETH_RESERVE,
    ),
  )
  pending.currentStep = 'approve_mint_pair'
  writeState(state)
  rememberCurrentBandTransaction(
    state,
    pending,
    await approveErc20(
      walletClient,
      PAIR,
      baselinePair + availablePair,
      `当前热区仓确认 PAIR 铸仓授权 (${pending.id})`,
      CURRENT_BAND_MIN_ETH_RESERVE,
    ),
  )
  const mint = await buildCustomRangeMint(account, availableSpy, availablePair, pending.tickLower, pending.tickUpper, {
    minimumRangePositionBps: CURRENT_BAND_MIN_RANGE_POSITION_BPS,
    maximumRangePositionBps: CURRENT_BAND_MAX_RANGE_POSITION_BPS,
    slippageTolerance: CURRENT_BAND_MINT_SLIPPAGE,
  })
  pending.mintPlan = {
    liquidity: mint.liquidity.toString(),
    desiredSpyWei: mint.amount0Desired.toString(),
    desiredPairWei: mint.amount1Desired.toString(),
    maximumSpyWei: mint.amount0Max.toString(),
    maximumPairWei: mint.amount1Max.toString(),
  }
  pending.currentStep = 'mint'
  pending.status = 'mint_prepared'
  writeState(state)
  const minted = await sendChecked(walletClient, {
    label: `当前热区仓 3/3 铸造 PAIR/SPY LP (${pending.id})`,
    to: POSITION_MANAGER,
    data: mint.data,
    minimumBalanceAfter: CURRENT_BAND_MIN_ETH_RESERVE,
    fast: true,
    gasPriceMultiplierBps: CURRENT_BAND_GAS_MODEL.sendGasPriceBps,
    gasBudgetSafetyBps: 10_000n,
  })
  pending.mintTransaction = minted.hash
  rememberCurrentBandTransaction(state, pending, minted)
  return finalizeCurrentBand(state, pending)
}

function markCurrentBandPartial(operationId, error) {
  const state = readState()
  const pending = state?.pendingCurrentBand
  if (!pending || pending.id !== operationId) return
  const message = error.shortMessage || error.message
  const hash = String(message).match(/0x[0-9a-fA-F]{64}/)?.[0]
  if (hash && String(message).includes('回执未知')) {
    pending.unknownTransaction = { hash, step: pending.currentStep || 'unknown' }
  }
  if (!(pending.transactions || []).length && !pending.unknownTransaction) delete state.pendingCurrentBand
  else {
    pending.status = 'partial'
    pending.lastErrorAt = new Date().toISOString()
    pending.lastError = message
  }
  writeState(state)
  appendAudit('current_band_partial', {
    id: operationId,
    message,
    transactions: pending.transactions || [],
    unknownTransaction: pending.unknownTransaction || null,
  })
}

async function currentBandEnter() {
  const state = readState()
  if (state?.pendingCurrentBand) return continueCurrentBand(state, state.pendingCurrentBand)
  const check = await currentBandPreflight({ print: true, requireReady: true })
  const id = `current-band-${new Date().toISOString().replace(/[-:.]/g, '')}`
  check.state.pendingCurrentBand = {
    id,
    status: 'planned',
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    tickLower: check.report.choice.tickLower,
    tickUpper: check.report.choice.tickUpper,
    totalPrincipalEthWei: CURRENT_BAND_TOTAL_ETH.toString(),
    perSideEthWei: CURRENT_BAND_PER_SIDE_ETH.toString(),
    baselineEthWei: check.ethBalance.toString(),
    baselineSpyWei: check.spyBalance.toString(),
    baselinePairWei: check.pairBalance.toString(),
    maximumGasWei: check.maximumGasWei.toString(),
    protectedPositions: check.positionReads.map((item) => ({
      tokenId: item.tokenId,
      liquidity: item.liquidity.toString(),
    })),
    marketEvidence: check.report.marketEvidence,
    fundingComplete: false,
    rebalanceComplete: false,
    transactions: [],
  }
  writeState(check.state)
  appendAudit('current_band_plan_created', check.state.pendingCurrentBand)
  try {
    return await continueCurrentBand(check.state, check.state.pendingCurrentBand)
  } catch (error) {
    markCurrentBandPartial(id, error)
    throw error
  }
}

async function currentBandResume() {
  const state = readState()
  const pending = state?.pendingCurrentBand
  if (!state || state.status !== 'active' || !pending) throw new Error('没有可恢复的当前热区仓计划')
  try {
    return await continueCurrentBand(state, pending)
  } catch (error) {
    markCurrentBandPartial(pending.id, error)
    throw error
  }
}

async function currentBandStatus() {
  const state = readState()
  const pending = state?.pendingCurrentBand || null
  const latest = state?.currentBandEntries?.at(-1) || null
  const [eth, spy, pair, poolState, nonceLatest, noncePending] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  const report = {
    status: pending ? pending.status : latest ? 'active' : 'NOT_STARTED',
    wallet: WALLET,
    nonceLatest,
    noncePending,
    poolTick: poolState.tick,
    balances: { eth: formatEther(eth), spy: formatUnits(spy, 18), pair: formatUnits(pair, 18) },
    pending,
    latest,
  }
  if (latest?.tokenId) {
    const tokenId = BigInt(latest.tokenId)
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
      getAccruedFees(tokenId, latest.tickLower, latest.tickUpper),
    ])
    report.chainPosition = {
      tokenId: latest.tokenId,
      owner,
      liquidity: liquidity.toString(),
      inRange: poolState.tick >= latest.tickLower && poolState.tick < latest.tickUpper,
      accruedFees: { spy: formatUnits(fees.spyWei, 18), pair: formatUnits(fees.pairWei, 18) },
    }
  }
  console.log(stringify(report))
}

function validateHighBandRollParameters() {
  if (HIGH_BAND_TICK_LOWER >= HIGH_BAND_TICK_UPPER) throw new Error('高位续航区间无效')
  if (HIGH_BAND_TICK_LOWER % poolKey.tickSpacing !== 0 || HIGH_BAND_TICK_UPPER % poolKey.tickSpacing !== 0) {
    throw new Error(`高位续航区间未按 tickSpacing 对齐：[${HIGH_BAND_TICK_LOWER},${HIGH_BAND_TICK_UPPER})`)
  }
}

function assertHighBandRange(poolState) {
  if (poolState.tick < HIGH_BAND_TICK_LOWER || poolState.tick >= HIGH_BAND_TICK_UPPER) {
    throw new Error(
      `PAIR 已离开高位续航区间：tick=${poolState.tick}，区间=[${HIGH_BAND_TICK_LOWER},${HIGH_BAND_TICK_UPPER})`,
    )
  }
  const rangePositionBps = customRangePositionBps(poolState.tick, HIGH_BAND_TICK_LOWER, HIGH_BAND_TICK_UPPER)
  if (rangePositionBps < HIGH_BAND_MIN_RANGE_POSITION_BPS || rangePositionBps > HIGH_BAND_MAX_RANGE_POSITION_BPS) {
    throw new Error(`PAIR 距高位续航区间边界过近：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
  }
  return rangePositionBps
}

async function highBandConfirmedTransactions(pending) {
  const results = []
  for (const hash of [...new Set(pending.transactions || [])]) {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`高位续航历史交易不是 success：${hash}`)
    results.push({ hash, receipt, gasCost: receipt.gasUsed * receipt.effectiveGasPrice })
  }
  return results
}

async function highBandConfirmedFailedTransactions(pending) {
  const results = []
  for (const hash of [...new Set(pending.failedTransactions || [])]) {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    if (receipt.status !== 'reverted') throw new Error(`高位续航失败交易状态异常：${hash}`)
    results.push({ hash, receipt, gasCost: receipt.gasUsed * receipt.effectiveGasPrice })
  }
  return results
}

async function highBandGasSpentWei(pending) {
  const [successful, failed] = await Promise.all([
    highBandConfirmedTransactions(pending),
    highBandConfirmedFailedTransactions(pending),
  ])
  return receiptGasTotal([...successful, ...failed])
}

async function readHighBandProtectedInvariants(pending) {
  return Promise.all(
    pending.protectedPositions.map(async (item) => {
      const [owner, liquidity] = await Promise.all([
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [BigInt(item.tokenId)],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(item.tokenId)],
        }),
      ])
      if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`受保护 LP ${item.tokenId} 所有权发生变化`)
      if (liquidity !== BigInt(item.liquidity)) throw new Error(`受保护 LP ${item.tokenId} liquidity 发生变化`)
      return { tokenId: item.tokenId, liquidity }
    }),
  )
}

function rememberHighBandTransaction(state, pending, result) {
  if (result) pending.transactions = [...new Set([...(pending.transactions || []), result.hash])]
  pending.currentStep = null
  writeState(state)
}

async function highBandSend(state, pending, walletClient, args) {
  let budget
  try {
    budget = await fastTransactionBudget(args.to, args.data, args.value || 0n)
  } catch (error) {
    appendAudit('high_band_prebroadcast_failed', {
      id: pending.id,
      step: pending.currentStep || 'unknown',
      label: args.label,
      message: error.message,
      shortMessage: error.shortMessage,
      details: error.details,
      data: error.data || error.cause?.data || error.cause?.cause?.data || null,
      cause: error.cause?.message || null,
    })
    throw error
  }
  const sendGasPrice = (budget.gasPrice * HIGH_BAND_SEND_GAS_PRICE_BPS + 9_999n) / 10_000n
  const prospectiveBudget = (budget.gasLimit * sendGasPrice * 125n) / 100n
  const spent = await highBandGasSpentWei(pending)
  if (spent + prospectiveBudget > BigInt(pending.maximumGasWei)) {
    throw new Error(
      `${args.label} 将使总 Gas 预算超过 5 USDG：已花 ${formatEther(spent)} ETH，下一步上限 ${formatEther(prospectiveBudget)} ETH`,
    )
  }
  const result = await sendChecked(walletClient, {
    ...args,
    minimumBalanceAfter: HIGH_BAND_MIN_ETH_RESERVE,
    fast: true,
    gasPriceMultiplierBps: HIGH_BAND_SEND_GAS_PRICE_BPS,
    gasBudgetSafetyBps: 12_500n,
  })
  rememberHighBandTransaction(state, pending, result)
  return result
}

async function highBandApproveErc20(state, pending, walletClient, token, required, label) {
  const allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [WALLET, PERMIT2],
  })
  if (allowance >= required) return null
  pending.currentStep = `approval:${token}`
  writeState(state)
  return highBandSend(state, pending, walletClient, {
    label,
    to: token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, maxUint256] }),
  })
}

async function highBandApprovePermit2(state, pending, walletClient, token, spender, required, label) {
  const [amount, expiration] = await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [WALLET, token, spender],
  })
  if (amount >= required && expiration > BigInt(nowSeconds() + 300)) return null
  pending.currentStep = `permit2:${token}:${spender}`
  writeState(state)
  const desiredExpiration = BigInt(nowSeconds() + 60 * 60)
  return highBandSend(state, pending, walletClient, {
    label,
    to: PERMIT2,
    data: encodeFunctionData({
      abi: PERMIT2_ABI,
      functionName: 'approve',
      args: [token, spender, required > UINT160_MAX ? UINT160_MAX : required, desiredExpiration],
    }),
  })
}

async function highBandRollPreflight({ print = true, requireReady = false } = {}) {
  validateHighBandRollParameters()
  const state = readState()
  if (!state || state.status !== 'active' || !state.position?.tokenId) throw new Error('没有活动的 PAIR/SPY 主账本')
  for (const key of [
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
    'pendingCurrentBand',
    'pendingHighBandRoll',
  ]) {
    if (state[key]) throw new Error(`存在未结算计划 ${key}：${state[key].id || 'unknown'}`)
  }
  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const records = activePairPositionRecords(state)
  const sources = HIGH_BAND_SOURCE_TOKEN_IDS.map((tokenId) => {
    const record = records.find((item) => String(item.tokenId) === tokenId)
    if (!record) throw new Error(`活动账本中找不到待撤 NFT ${tokenId}`)
    return record
  })
  const sourceSet = new Set(HIGH_BAND_SOURCE_TOKEN_IDS)
  const protectedRecords = records.filter((item) => !sourceSet.has(String(item.tokenId)))
  const [
    blockNumber,
    nonceLatest,
    noncePending,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    usdgBalance,
    gasPrice,
    spyMark,
    ethMark,
    sourceReads,
    protectedReads,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    getPoolState(),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getGasPrice(),
    quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT),
    quoteBestEthToSpy(parseEther('0.01')),
    Promise.all(
      sources.map(async (source) => ({
        record: source,
        owner: await publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [BigInt(source.tokenId)],
        }),
        liquidity: await publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(source.tokenId)],
        }),
      })),
    ),
    Promise.all(
      protectedRecords.map(async (record) => ({
        tokenId: String(record.tokenId),
        owner: await publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [BigInt(record.tokenId)],
        }),
        liquidity: await publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(record.tokenId)],
        }),
        expectedLiquidity: BigInt(record.liquidity),
      })),
    ),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  const rangePositionBps = assertHighBandRange(poolState)
  if (pairBalance <= 0n) throw new Error('钱包没有刚领取的 PAIR 手续费，禁止继续')
  for (const item of sourceReads) {
    if (item.owner.toLowerCase() !== WALLET.toLowerCase())
      throw new Error(`待撤 NFT ${item.record.tokenId} 不在执行钱包`)
    if (item.liquidity === 0n || item.liquidity !== BigInt(item.record.liquidity)) {
      throw new Error(
        `待撤 NFT ${item.record.tokenId} liquidity 不一致：chain=${item.liquidity}, local=${item.record.liquidity}`,
      )
    }
    if (poolState.tick >= item.record.tickLower && poolState.tick < item.record.tickUpper) {
      throw new Error(`待撤 NFT ${item.record.tokenId} 已重新进入区间，停止高位迁移`)
    }
  }
  for (const item of protectedReads) {
    if (item.owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`受保护 LP ${item.tokenId} 所有权异常`)
    if (item.liquidity !== item.expectedLiquidity) throw new Error(`受保护 LP ${item.tokenId} liquidity 与账本不符`)
  }
  if (
    protectedRecords.some(
      (record) => record.tickLower === HIGH_BAND_TICK_LOWER && record.tickUpper === HIGH_BAND_TICK_UPPER,
    )
  ) {
    throw new Error('已有相同高位续航区间的活动 LP')
  }

  const sourceDetails = []
  let totalSpyWei = spyBalance
  let totalPairWei = pairBalance
  for (const item of sourceReads) {
    const fees = await getAccruedFees(BigInt(item.record.tokenId), item.record.tickLower, item.record.tickUpper)
    if (fees.liquidity !== item.liquidity) throw new Error(`待撤 NFT ${item.record.tokenId} 手续费 liquidity 不一致`)
    const removal = buildFullRemove(item.record, item.liquidity, poolState)
    if (removal.amount1Principal !== 0n) throw new Error(`待撤 NFT ${item.record.tokenId} 已不再是单边 SPY`)
    const budget = await transactionBudget(POSITION_MANAGER, removal.data)
    totalSpyWei += removal.amount0Principal + fees.spyWei
    totalPairWei += removal.amount1Principal + fees.pairWei
    sourceDetails.push({ ...item, fees, removal, budget })
  }
  const rebalance = await solveCustomRangeRebalance(
    totalSpyWei,
    totalPairWei,
    poolState,
    HIGH_BAND_TICK_LOWER,
    HIGH_BAND_TICK_UPPER,
  )
  if (rebalance.direction !== 'SPY_TO_PAIR') {
    throw new Error(`高位续航配平方向为 ${rebalance.direction}；本次只授权 SPY→PAIR`)
  }
  const projectedPosition = Position.fromAmounts({
    pool: makePool(poolState),
    tickLower: HIGH_BAND_TICK_LOWER,
    tickUpper: HIGH_BAND_TICK_UPPER,
    amount0: rebalance.expectedSpyWei.toString(),
    amount1: rebalance.expectedPairWei.toString(),
    useFullPrecision: true,
  })
  const projectedLiquidity = asBigInt(projectedPosition.liquidity)
  if (projectedLiquidity === 0n) throw new Error('高位续航预计 liquidity 为 0')
  const totalValue = tokenAmountsUsdg(totalSpyWei, totalPairWei, poolState, spyMark)
  const capitalUsdg = Number(formatUnits(totalValue.totalUsdg, 6))
  const snapshots = await Promise.all([fetchCurrentBandSnapshot('1h'), fetchCurrentBandSnapshot('6h')])
  const marketEvidence = Object.fromEntries(
    snapshots.map((snapshot) => [
      snapshot.selectedWindow,
      currentBandWindowMetrics(snapshot, projectedLiquidity, capitalUsdg, HIGH_BAND_TICK_LOWER, HIGH_BAND_TICK_UPPER),
    ]),
  )

  const [spyErc20Allowance, pairErc20Allowance, routerAllowance] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
    publicClient.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [WALLET, SPY, UNIVERSAL_ROUTER],
    }),
  ])
  const erc20Approvals =
    Number(spyErc20Allowance < totalSpyWei) + Number(pairErc20Allowance < rebalance.expectedPairWei)
  const permit2Approval = Number(
    routerAllowance[0] < rebalance.amountIn || routerAllowance[1] <= BigInt(nowSeconds() + 300),
  )
  const removalGas = sourceDetails.reduce((sum, item) => sum + item.budget.estimatedGas, 0n)
  const swapGas =
    rebalance.gasEstimate > HIGH_BAND_GAS_MODEL.v4Swap ? rebalance.gasEstimate : HIGH_BAND_GAS_MODEL.v4Swap
  const modeledGasUnits =
    removalGas +
    swapGas +
    HIGH_BAND_GAS_MODEL.mint +
    BigInt(erc20Approvals) * HIGH_BAND_GAS_MODEL.erc20Approval +
    BigInt(permit2Approval) * HIGH_BAND_GAS_MODEL.permit2Approval
  const safeModeledGasUnits = (modeledGasUnits * HIGH_BAND_GAS_MODEL.safetyBps + 9_999n) / 10_000n
  const sendGasPrice = (gasPrice * HIGH_BAND_SEND_GAS_PRICE_BPS + 9_999n) / 10_000n
  const modeledGasWei = safeModeledGasUnits * sendGasPrice
  const ethMarkUsdgAtomic = (ethMark.amountOut * spyMark.amountOut) / ADD_SPY_MARK_INPUT
  if (ethMarkUsdgAtomic <= 0n) throw new Error('ETH/USDG 标记价格为 0')
  const maximumGasWei = (HIGH_BAND_MAX_GAS_USDG_ATOMIC * parseEther('0.01')) / ethMarkUsdgAtomic
  const modeledGasUsdgAtomic = (modeledGasWei * ethMarkUsdgAtomic) / parseEther('0.01')
  const requiredEth = HIGH_BAND_MIN_ETH_RESERVE + maximumGasWei
  const status = ethBalance < requiredEth ? 'NEEDS_ETH_TOP_UP' : modeledGasWei > maximumGasWei ? 'WAIT_GAS' : 'READY'
  const spyPriceUsdg = Number(formatUnits(spyMark.amountOut, 6)) / Number(formatUnits(ADD_SPY_MARK_INPUT, 18))
  const prices = customRangePricesUsdg(spyPriceUsdg, HIGH_BAND_TICK_LOWER, HIGH_BAND_TICK_UPPER)
  const report = {
    status,
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    pool: {
      currentTick: poolState.tick,
      currentPairPriceUsdg: (spyPriceUsdg / Math.pow(1.0001, poolState.tick)).toFixed(8),
      targetTickLower: HIGH_BAND_TICK_LOWER,
      targetTickUpper: HIGH_BAND_TICK_UPPER,
      targetPriceLowUsdg: prices.low.toFixed(8),
      targetPriceHighUsdg: prices.high.toFixed(8),
      rangePositionPct: (Number(rangePositionBps) / 100).toFixed(2),
    },
    authorizedWalletFees: {
      spy: formatUnits(spyBalance, 18),
      pair: formatUnits(pairBalance, 18),
      policy: 'use all wallet PAIR and SPY balances; preserve ETH and USDG except gas',
    },
    sources: sourceDetails.map((item) => ({
      tokenId: String(item.record.tokenId),
      liquidity: item.liquidity.toString(),
      principalSpy: formatUnits(item.removal.amount0Principal, 18),
      principalPair: formatUnits(item.removal.amount1Principal, 18),
      accruedFeeSpy: formatUnits(item.fees.spyWei, 18),
      accruedFeePair: formatUnits(item.fees.pairWei, 18),
    })),
    projectedAssets: {
      spyBeforeRebalance: formatUnits(totalSpyWei, 18),
      pairBeforeRebalance: formatUnits(totalPairWei, 18),
      markedUsdg: capitalUsdg.toFixed(6),
    },
    rebalance: {
      direction: rebalance.direction,
      inputSpy: formatUnits(rebalance.amountIn, 18),
      quotedPair: formatUnits(rebalance.amountOut, 18),
      expectedMintSpy: formatUnits(rebalance.expectedSpyWei, 18),
      expectedMintPair: formatUnits(rebalance.expectedPairWei, 18),
      targetValueSplitPct: {
        spy: (Number(rebalance.targetSpyValueBps) / 100).toFixed(2),
        pair: (Number(rebalance.targetPairValueBps) / 100).toFixed(2),
      },
      slippageBps: Number(HIGH_BAND_SWAP_SLIPPAGE_BPS),
    },
    projectedMint: {
      liquidity: projectedLiquidity.toString(),
      activeSharePct: (
        Number((projectedLiquidity * 1_000_000_000n) / (poolState.liquidity + projectedLiquidity)) / 10_000_000
      ).toFixed(6),
    },
    marketEvidence,
    protectedPositions: protectedReads.map((item) => ({ tokenId: item.tokenId, liquidity: item.liquidity.toString() })),
    gas: {
      gasPriceGwei: (Number(gasPrice) / 1e9).toFixed(6),
      modeledGasUnits: modeledGasUnits.toString(),
      safeModeledGasUnits: safeModeledGasUnits.toString(),
      modeledGasEth: formatEther(modeledGasWei),
      modeledGasUsdg: formatUnits(modeledGasUsdgAtomic, 6),
      maximumGasUsdg: formatUnits(HIGH_BAND_MAX_GAS_USDG_ATOMIC, 6),
      maximumGasEth: formatEther(maximumGasWei),
      minimumFinalEth: formatEther(HIGH_BAND_MIN_ETH_RESERVE),
      expectedApprovalTransactions: erc20Approvals + permit2Approval,
    },
    preserved: { usdg: formatUnits(usdgBalance, 6), otherLpLiquidity: true },
  }
  appendAudit('high_band_roll_preflight', report)
  if (print) console.log(stringify(report))
  if (requireReady && status !== 'READY') throw new Error(`高位续航预检未就绪：${status}`)
  return {
    state,
    report,
    blockNumber,
    ethBalance,
    spyBalance,
    pairBalance,
    usdgBalance,
    poolState,
    sourceDetails,
    protectedReads,
    maximumGasWei,
  }
}

async function resolveHighBandUnknownTransaction(state, pending) {
  if (!pending.unknownTransaction) return
  const unknown = pending.unknownTransaction
  const receipt = await publicClient.getTransactionReceipt({ hash: unknown.hash })
  if (receipt.status !== 'success') {
    pending.failedTransactions = [...new Set([...(pending.failedTransactions || []), unknown.hash])]
    pending.failedStep = unknown.step
    delete pending.unknownTransaction
    pending.currentStep = null
    writeState(state)
    return
  }
  pending.transactions = [...new Set([...(pending.transactions || []), unknown.hash])]
  if (unknown.step.startsWith('remove:')) {
    const tokenId = unknown.step.split(':')[1]
    const source = pending.sources.find((item) => item.tokenId === tokenId)
    if (!source) throw new Error(`未知撤仓交易无法映射 NFT ${tokenId}`)
    source.removalTransaction = unknown.hash
  }
  if (unknown.step === 'swap') pending.swapTransaction = unknown.hash
  if (unknown.step === 'mint') pending.mintTransaction = unknown.hash
  delete pending.unknownTransaction
  pending.currentStep = null
  writeState(state)
}

async function reconcileHighBandRecordedFailure(state, pending) {
  const message = String(pending.lastError || '')
  if (!message.includes('链上回执失败')) return
  const hash = message.match(/0x[0-9a-fA-F]{64}/)?.[0]
  if (!hash || (pending.failedTransactions || []).includes(hash)) return
  const receipt = await publicClient.getTransactionReceipt({ hash })
  if (receipt.status !== 'reverted') throw new Error(`高位续航记录的失败交易状态异常：${hash}`)
  pending.failedTransactions = [...new Set([...(pending.failedTransactions || []), hash])]
  pending.failedStep = pending.currentStep || 'unknown'
  if (pending.swapTransaction === hash) delete pending.swapTransaction
  if (pending.mintTransaction === hash) delete pending.mintTransaction
  pending.currentStep = null
  writeState(state)
}

async function reconcileHighBandRemovals(state, pending) {
  for (const source of pending.sources) {
    if (!source.removalTransaction || source.removedSpyWei !== undefined) continue
    const [receipt, liquidity] = await Promise.all([
      publicClient.getTransactionReceipt({ hash: source.removalTransaction }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(source.tokenId)],
      }),
    ])
    if (receipt.status !== 'success') throw new Error(`NFT ${source.tokenId} 撤仓回执失败`)
    if (liquidity !== 0n) throw new Error(`NFT ${source.tokenId} 撤仓后 liquidity=${liquidity}`)
    const spyNet = tokenNetFromReceipt(receipt, SPY)
    const pairNet = tokenNetFromReceipt(receipt, PAIR)
    if (spyNet < 0n || pairNet < 0n || (spyNet === 0n && pairNet === 0n))
      throw new Error(`NFT ${source.tokenId} 撤仓到账异常`)
    source.removedSpyWei = spyNet.toString()
    source.removedPairWei = pairNet.toString()
    source.status = 'removed'
    pending.status = 'sources_partially_removed'
    writeState(state)
  }
  if (pending.sources.every((item) => item.removedSpyWei !== undefined)) {
    pending.status = 'sources_removed'
    writeState(state)
  }
}

async function reconcileHighBandSwap(state, pending) {
  if (!pending.swapTransaction || pending.swapComplete) return
  if (!pending.swapPlan) throw new Error('高位续航 swap 已广播但缺少计划')
  const receipt = await publicClient.getTransactionReceipt({ hash: pending.swapTransaction })
  if (receipt.status !== 'success') throw new Error(`高位续航 swap 回执失败：${pending.swapTransaction}`)
  const actualInput = -tokenNetFromReceipt(receipt, SPY)
  const actualOutput = tokenNetFromReceipt(receipt, PAIR)
  if (actualInput !== BigInt(pending.swapPlan.inputSpyWei) || actualOutput < BigInt(pending.swapPlan.minimumPairWei)) {
    throw new Error('高位续航 SPY→PAIR 实际输入或输出不符合保护')
  }
  pending.swap = {
    direction: 'SPY_TO_PAIR',
    inputSpyWei: actualInput.toString(),
    outputPairWei: actualOutput.toString(),
    minimumPairWei: pending.swapPlan.minimumPairWei,
    transaction: pending.swapTransaction,
  }
  pending.swapComplete = true
  pending.status = 'rebalanced'
  writeState(state)
}

function expectedHighBandBalancesBeforeSwap(pending) {
  return pending.sources.reduce(
    (totals, source) => ({
      spy: totals.spy + BigInt(source.removedSpyWei || 0),
      pair: totals.pair + BigInt(source.removedPairWei || 0),
    }),
    {
      spy: BigInt(pending.initialSpyWei),
      pair: BigInt(pending.initialPairWei),
    },
  )
}

async function finalizeHighBandRoll(state, pending) {
  if (!pending.mintTransaction || !pending.mintPlan) throw new Error('高位续航没有可结算的 mint')
  const receipt = await publicClient.getTransactionReceipt({ hash: pending.mintTransaction })
  if (receipt.status !== 'success') throw new Error(`高位续航 mint 回执失败：${pending.mintTransaction}`)
  const tokenId = parseMintTokenId(receipt)
  if (tokenId === null) throw new Error(`高位续航 mint 成功但未解析到 NFT：${pending.mintTransaction}`)
  const [owner, liquidity, finalEth, finalSpy, finalPair, finalUsdg, poolState, invariants, sourceLiquidities] =
    await Promise.all([
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
      getPoolState(),
      readHighBandProtectedInvariants(pending),
      Promise.all(
        pending.sources.map((source) =>
          publicClient.readContract({
            address: POSITION_MANAGER,
            abi: POSITION_NFT_ABI,
            functionName: 'getPositionLiquidity',
            args: [BigInt(source.tokenId)],
          }),
        ),
      ),
    ])
  if (owner.toLowerCase() !== WALLET.toLowerCase() || liquidity === 0n) throw new Error('高位续航新 NFT 链上读回不完整')
  if (liquidity !== BigInt(pending.mintPlan.liquidity))
    throw new Error(`高位续航 liquidity 不一致：chain=${liquidity}, plan=${pending.mintPlan.liquidity}`)
  if (sourceLiquidities.some((value) => value !== 0n)) throw new Error('至少一个旧 NFT 撤仓后 liquidity 非 0')
  if (finalUsdg !== BigInt(pending.initialUsdgAtomic)) throw new Error('高位续航意外动用了 USDG')
  if (finalEth < HIGH_BAND_MIN_ETH_RESERVE)
    throw new Error(`高位续航完成后 ETH 低于 ${formatEther(HIGH_BAND_MIN_ETH_RESERVE)}`)
  const position = new Position({
    pool: makePool(poolState),
    liquidity: liquidity.toString(),
    tickLower: HIGH_BAND_TICK_LOWER,
    tickUpper: HIGH_BAND_TICK_UPPER,
  })
  const underlyingSpyWei = asBigInt(position.amount0.quotient)
  const underlyingPairWei = asBigInt(position.amount1.quotient)
  const spyMark = await quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT)
  const spyPriceUsdg = Number(formatUnits(spyMark.amountOut, 6)) / Number(formatUnits(ADD_SPY_MARK_INPUT, 18))
  const prices = customRangePricesUsdg(spyPriceUsdg, HIGH_BAND_TICK_LOWER, HIGH_BAND_TICK_UPPER)
  const [transactions, failedTransactions] = await Promise.all([
    highBandConfirmedTransactions(pending),
    highBandConfirmedFailedTransactions(pending),
  ])
  const gasSpentWei = receiptGasTotal([...transactions, ...failedTransactions])
  const completedAt = new Date().toISOString()
  const record = {
    id: pending.id,
    label: '高位续航仓',
    role: 'high-band-extension',
    status: 'active',
    completedAt,
    tokenId: tokenId.toString(),
    tickLower: HIGH_BAND_TICK_LOWER,
    tickUpper: HIGH_BAND_TICK_UPPER,
    liquidity: liquidity.toString(),
    source: 'all wallet PAIR/SPY fee balances plus principal removed from NFTs 1871220 and 1871913; USDG excluded',
    policy: {
      mode: 'layered_upper_fee_coverage',
      autoExit: false,
      sourceTokenIds: HIGH_BAND_SOURCE_TOKEN_IDS,
      useAllCollectedPairFees: true,
      rebalanceOnlySpyToPair: true,
      swapSlippageBps: Number(HIGH_BAND_SWAP_SLIPPAGE_BPS),
      mintRatioToleranceBps: 750,
      mintSafetyBps: Number(HIGH_BAND_MINT_SAFETY_BPS),
      preserveOtherLpLiquidity: true,
      preserveUsdg: true,
      maximumGasUsdg: '5',
      minimumFinalEthWei: HIGH_BAND_MIN_ETH_RESERVE.toString(),
    },
    sources: pending.sources.map((source) => ({
      tokenId: source.tokenId,
      liquidityBefore: source.liquidity,
      liquidityAfter: '0',
      removedSpyWei: source.removedSpyWei,
      removedPairWei: source.removedPairWei,
      removalTransaction: source.removalTransaction,
    })),
    authorizedInitialWalletAssets: {
      spyWei: pending.initialSpyWei,
      pairWei: pending.initialPairWei,
      usdgAtomic: pending.initialUsdgAtomic,
    },
    rebalance: pending.swap,
    minted: {
      desiredSpyWei: pending.mintPlan.desiredSpyWei,
      desiredPairWei: pending.mintPlan.desiredPairWei,
      underlyingSpyWei: underlyingSpyWei.toString(),
      underlyingPairWei: underlyingPairWei.toString(),
      transaction: pending.mintTransaction,
      blockNumber: receipt.blockNumber.toString(),
    },
    residual: { spyWei: finalSpy.toString(), pairWei: finalPair.toString() },
    protectedPositionInvariants: invariants.map((item) => ({
      tokenId: item.tokenId,
      liquidityAfter: item.liquidity.toString(),
    })),
    marketEvidence: pending.marketEvidence,
    priceSnapshot: {
      spyPriceUsdg: spyPriceUsdg.toFixed(6),
      currentPairPriceUsdg: (spyPriceUsdg / Math.pow(1.0001, poolState.tick)).toFixed(8),
      actualPairPriceLowUsdg: prices.low.toFixed(8),
      actualPairPriceHighUsdg: prices.high.toFixed(8),
      currentTick: poolState.tick,
      inRange: poolState.tick >= HIGH_BAND_TICK_LOWER && poolState.tick < HIGH_BAND_TICK_UPPER,
    },
    gasSpentWei: gasSpentWei.toString(),
    gasCapWei: pending.maximumGasWei,
    gasCapBreached: gasSpentWei > BigInt(pending.maximumGasWei),
    finalEthWei: finalEth.toString(),
    transactions: pending.transactions,
    failedTransactions: pending.failedTransactions || [],
  }
  state.satellites = (state.satellites || []).map((item) =>
    sourceSetForRecord(HIGH_BAND_SOURCE_TOKEN_IDS, item)
      ? { ...item, status: 'retired_high_band_empty', liquidity: '0', retiredAt: completedAt, retiredBy: pending.id }
      : item,
  )
  state.satellites.push(record)
  state.currentBandEntries = (state.currentBandEntries || []).map((item) =>
    HIGH_BAND_SOURCE_TOKEN_IDS.includes(String(item.tokenId))
      ? { ...item, status: 'retired_high_band_empty', liquidity: '0', retiredAt: completedAt, retiredBy: pending.id }
      : item,
  )
  state.highBandRolls = [...(state.highBandRolls || []), record]
  delete state.pendingHighBandRoll
  writeState(state)
  appendAudit('high_band_roll_complete', record)
  console.log(
    stringify({
      status: 'HIGH_BAND_ACTIVE',
      retiredTokenIds: HIGH_BAND_SOURCE_TOKEN_IDS,
      tokenId,
      liquidity,
      priceSnapshot: record.priceSnapshot,
      withdrawn: record.sources.map((source) => ({
        tokenId: source.tokenId,
        spy: formatUnits(BigInt(source.removedSpyWei), 18),
        pair: formatUnits(BigInt(source.removedPairWei), 18),
      })),
      rebalance: {
        inputSpy: formatUnits(BigInt(record.rebalance.inputSpyWei), 18),
        outputPair: formatUnits(BigInt(record.rebalance.outputPairWei), 18),
      },
      lpUnderlying: { spy: formatUnits(underlyingSpyWei, 18), pair: formatUnits(underlyingPairWei, 18) },
      residual: { spy: formatUnits(finalSpy, 18), pair: formatUnits(finalPair, 18) },
      gasSpentEth: formatEther(gasSpentWei),
      gasCapBreached: record.gasCapBreached,
      finalEth: formatEther(finalEth),
      transactions: record.transactions,
      failedTransactions: record.failedTransactions,
    }),
  )
  return record
}

function sourceSetForRecord(tokenIds, record) {
  return tokenIds.includes(String(record.tokenId))
}

async function continueHighBandRoll(state, pending) {
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  await resolveHighBandUnknownTransaction(state, pending)
  await reconcileHighBandRecordedFailure(state, pending)
  await reconcileHighBandRemovals(state, pending)
  await reconcileHighBandSwap(state, pending)
  await highBandConfirmedTransactions(pending)
  if (pending.mintTransaction) return finalizeHighBandRoll(state, pending)
  const [nonceLatest, noncePending] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`高位续航执行前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  await readHighBandProtectedInvariants(pending)

  for (const source of pending.sources) {
    if (source.removalTransaction) continue
    const [owner, liquidity, poolState] = await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [BigInt(source.tokenId)],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(source.tokenId)],
      }),
      getPoolState(),
    ])
    if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`待撤 NFT ${source.tokenId} 所有权发生变化`)
    if (liquidity !== BigInt(source.liquidity)) throw new Error(`待撤 NFT ${source.tokenId} liquidity 发生变化`)
    if (poolState.tick >= source.tickLower && poolState.tick < source.tickUpper)
      throw new Error(`待撤 NFT ${source.tokenId} 已重新入区间`)
    assertHighBandRange(poolState)
    const removal = buildFullRemove(source, liquidity, poolState)
    pending.currentStep = `remove:${source.tokenId}`
    writeState(state)
    const result = await highBandSend(state, pending, walletClient, {
      label: `高位续航撤出 NFT ${source.tokenId} (${pending.id})`,
      to: POSITION_MANAGER,
      data: removal.data,
    })
    source.removalTransaction = result.hash
    writeState(state)
    await reconcileHighBandRemovals(state, pending)
  }

  if (!pending.swapComplete) {
    const expected = expectedHighBandBalancesBeforeSwap(pending)
    const [spyBalance, pairBalance, poolState] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      getPoolState(),
    ])
    if (spyBalance !== expected.spy || pairBalance !== expected.pair)
      throw new Error('撤仓后钱包 SPY/PAIR 与授权资产账本不一致')
    assertHighBandRange(poolState)
    let plan = await solveCustomRangeRebalance(
      spyBalance,
      pairBalance,
      poolState,
      HIGH_BAND_TICK_LOWER,
      HIGH_BAND_TICK_UPPER,
    )
    if (plan.direction !== 'SPY_TO_PAIR') throw new Error(`实时配平方向变为 ${plan.direction}，不在授权范围`)
    await highBandApproveErc20(
      state,
      pending,
      walletClient,
      SPY,
      spyBalance,
      `高位续航授权 SPY 给 Permit2 (${pending.id})`,
    )
    await highBandApprovePermit2(
      state,
      pending,
      walletClient,
      SPY,
      UNIVERSAL_ROUTER,
      plan.amountIn,
      `高位续航授权路由使用 SPY (${pending.id})`,
    )
    const [liveSpy, livePair, livePool] = await Promise.all([
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      getPoolState(),
    ])
    if (liveSpy !== spyBalance || livePair !== pairBalance) throw new Error('配平授权期间钱包代币余额发生变化')
    assertHighBandRange(livePool)
    plan = await solveCustomRangeRebalance(liveSpy, livePair, livePool, HIGH_BAND_TICK_LOWER, HIGH_BAND_TICK_UPPER)
    if (plan.direction !== 'SPY_TO_PAIR') throw new Error(`实时配平方向变为 ${plan.direction}，不在授权范围`)
    await highBandApprovePermit2(
      state,
      pending,
      walletClient,
      SPY,
      UNIVERSAL_ROUTER,
      plan.amountIn,
      `高位续航刷新路由 SPY 授权 (${pending.id})`,
    )
    const minimumPair = bpsFloor(plan.amountOut, HIGH_BAND_SWAP_SLIPPAGE_BPS)
    pending.swapPlan = {
      poolTick: livePool.tick,
      inputSpyWei: plan.amountIn.toString(),
      quotedPairWei: plan.amountOut.toString(),
      minimumPairWei: minimumPair.toString(),
      slippageBps: Number(HIGH_BAND_SWAP_SLIPPAGE_BPS),
    }
    pending.currentStep = 'swap'
    pending.status = 'swap_prepared'
    writeState(state)
    const result = await highBandSend(state, pending, walletClient, {
      label: `高位续航 SPY→PAIR 配平 (${pending.id})`,
      to: UNIVERSAL_ROUTER,
      data: buildV4SwapData(plan.amountIn, minimumPair, BigInt(nowSeconds() + 5 * 60), true),
    })
    pending.swapTransaction = result.hash
    writeState(state)
    await reconcileHighBandSwap(state, pending)
  }

  const [spyBeforeMint, pairBeforeMint, poolBeforeMint] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
  ])
  assertHighBandRange(poolBeforeMint)
  await highBandApproveErc20(
    state,
    pending,
    walletClient,
    SPY,
    spyBeforeMint,
    `高位续航确认 SPY 铸仓授权 (${pending.id})`,
  )
  await highBandApproveErc20(
    state,
    pending,
    walletClient,
    PAIR,
    pairBeforeMint,
    `高位续航确认 PAIR 铸仓授权 (${pending.id})`,
  )
  const [liveSpyBeforeMint, livePairBeforeMint, livePoolBeforeMint] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
  ])
  if (liveSpyBeforeMint !== spyBeforeMint || livePairBeforeMint !== pairBeforeMint)
    throw new Error('铸仓授权期间钱包代币余额发生变化')
  assertHighBandRange(livePoolBeforeMint)
  const mint = await buildCustomRangeMint(
    account,
    liveSpyBeforeMint,
    livePairBeforeMint,
    HIGH_BAND_TICK_LOWER,
    HIGH_BAND_TICK_UPPER,
    {
      minimumRangePositionBps: HIGH_BAND_MIN_RANGE_POSITION_BPS,
      maximumRangePositionBps: HIGH_BAND_MAX_RANGE_POSITION_BPS,
      slippageTolerance: HIGH_BAND_MINT_SLIPPAGE,
      safetyBps: HIGH_BAND_MINT_SAFETY_BPS,
    },
  )
  pending.mintPlan = {
    liquidity: mint.liquidity.toString(),
    desiredSpyWei: mint.amount0Desired.toString(),
    desiredPairWei: mint.amount1Desired.toString(),
    maximumSpyWei: mint.amount0Max.toString(),
    maximumPairWei: mint.amount1Max.toString(),
  }
  pending.currentStep = 'mint'
  pending.status = 'mint_prepared'
  writeState(state)
  const minted = await highBandSend(state, pending, walletClient, {
    label: `高位续航铸造 PAIR/SPY LP (${pending.id})`,
    to: POSITION_MANAGER,
    data: mint.data,
  })
  pending.mintTransaction = minted.hash
  writeState(state)
  return finalizeHighBandRoll(state, pending)
}

function markHighBandRollPartial(operationId, error) {
  const state = readState()
  const pending = state?.pendingHighBandRoll
  if (!pending || pending.id !== operationId) return
  const message = error.shortMessage || error.message
  const hash = String(message).match(/0x[0-9a-fA-F]{64}/)?.[0]
  if (hash && String(message).includes('回执未知'))
    pending.unknownTransaction = { hash, step: pending.currentStep || 'unknown' }
  if (hash && String(message).includes('链上回执失败')) {
    pending.failedTransactions = [...new Set([...(pending.failedTransactions || []), hash])]
    pending.failedStep = pending.currentStep || 'unknown'
    pending.currentStep = null
  }
  pending.status = 'partial'
  pending.lastErrorAt = new Date().toISOString()
  pending.lastError = message
  writeState(state)
  appendAudit('high_band_roll_partial', {
    id: operationId,
    message,
    currentStep: pending.currentStep,
    transactions: pending.transactions || [],
    failedTransactions: pending.failedTransactions || [],
    unknownTransaction: pending.unknownTransaction || null,
  })
}

async function highBandRollEnter() {
  const state = readState()
  if (state?.pendingHighBandRoll) return continueHighBandRoll(state, state.pendingHighBandRoll)
  const check = await highBandRollPreflight({ print: true, requireReady: true })
  const id = `high-band-roll-${new Date().toISOString().replace(/[-:.]/g, '')}`
  check.state.pendingHighBandRoll = {
    id,
    status: 'planned',
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    tickLower: HIGH_BAND_TICK_LOWER,
    tickUpper: HIGH_BAND_TICK_UPPER,
    initialSpyWei: check.spyBalance.toString(),
    initialPairWei: check.pairBalance.toString(),
    initialUsdgAtomic: check.usdgBalance.toString(),
    initialEthWei: check.ethBalance.toString(),
    maximumGasWei: check.maximumGasWei.toString(),
    sources: check.sourceDetails.map((item) => ({
      tokenId: String(item.record.tokenId),
      tickLower: item.record.tickLower,
      tickUpper: item.record.tickUpper,
      liquidity: item.liquidity.toString(),
    })),
    protectedPositions: check.protectedReads.map((item) => ({
      tokenId: item.tokenId,
      liquidity: item.liquidity.toString(),
    })),
    marketEvidence: check.report.marketEvidence,
    transactions: [],
    failedTransactions: [],
    swapComplete: false,
  }
  writeState(check.state)
  appendAudit('high_band_roll_plan_created', check.state.pendingHighBandRoll)
  try {
    return await continueHighBandRoll(check.state, check.state.pendingHighBandRoll)
  } catch (error) {
    markHighBandRollPartial(id, error)
    throw error
  }
}

async function highBandRollResume() {
  const state = readState()
  const pending = state?.pendingHighBandRoll
  if (!state || state.status !== 'active' || !pending) throw new Error('没有可恢复的高位续航计划')
  try {
    return await continueHighBandRoll(state, pending)
  } catch (error) {
    markHighBandRollPartial(pending.id, error)
    throw error
  }
}

async function highBandRollStatus() {
  const state = readState()
  const pending = state?.pendingHighBandRoll || null
  const latest = state?.highBandRolls?.at(-1) || null
  const [eth, spy, pair, usdg, poolState, nonceLatest, noncePending] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  console.log(
    stringify({
      status: pending ? pending.status : latest ? latest.status : 'NOT_STARTED',
      wallet: WALLET,
      nonceLatest,
      noncePending,
      poolTick: poolState.tick,
      inTargetRange: poolState.tick >= HIGH_BAND_TICK_LOWER && poolState.tick < HIGH_BAND_TICK_UPPER,
      balances: {
        eth: formatEther(eth),
        spy: formatUnits(spy, 18),
        pair: formatUnits(pair, 18),
        usdg: formatUnits(usdg, 6),
      },
      pending,
      latest,
    }),
  )
}

function validateUpperExtensionParameters() {
  if (
    !Number.isSafeInteger(UPPER_EXTENSION_TICK_LOWER) ||
    !Number.isSafeInteger(UPPER_EXTENSION_TICK_UPPER) ||
    UPPER_EXTENSION_TICK_LOWER >= UPPER_EXTENSION_TICK_UPPER ||
    UPPER_EXTENSION_TICK_LOWER % poolKey.tickSpacing !== 0 ||
    UPPER_EXTENSION_TICK_UPPER % poolKey.tickSpacing !== 0
  ) {
    throw new Error(`高位接力仓 tick 无效：[${UPPER_EXTENSION_TICK_LOWER},${UPPER_EXTENSION_TICK_UPPER})`)
  }
  if (UPPER_EXTENSION_BUY_USDG_ATOMIC < 0n) throw new Error('高位接力仓 SPY 买入预算不能为负数')
  if (UPPER_EXTENSION_PAIRED_IN_RANGE && UPPER_EXTENSION_BUY_USDG_ATOMIC === 0n) {
    throw new Error('双边补隙模式必须提供明确的 PAIR 买入 USDG 预算')
  }
}

async function upperExtensionPreflight({ print = true, requireReady = false } = {}) {
  validateUpperExtensionParameters()
  const buyMode = UPPER_EXTENSION_BUY_USDG_ATOMIC > 0n
  const state = readState()
  if (!state || state.status !== 'active' || !state.position?.tokenId) throw new Error('没有活动的 PAIR/SPY 主账本')
  for (const key of [
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
    'pendingCurrentBand',
    'pendingHighBandRoll',
    'pendingUpperExtension',
    'pendingTargetRetirement',
  ]) {
    if (state[key]) throw new Error(`存在未结算计划 ${key}：${state[key].id || 'unknown'}`)
  }
  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()

  const records = activePairPositionRecordsFromPortfolioLedger()
  const anchor = records.find((record) => String(record.tokenId) === UPPER_EXTENSION_ANCHOR_TOKEN_ID)
  const anchorGapTicks = anchor ? anchor.tickLower - UPPER_EXTENSION_TICK_UPPER : null
  const overlappingRecords = records.filter(
    (record) => record.tickLower < UPPER_EXTENSION_TICK_UPPER && record.tickUpper > UPPER_EXTENSION_TICK_LOWER,
  )
  const anchorMatches = UPPER_EXTENSION_PAIRED_IN_RANGE
    ? overlappingRecords.length > 0
    : anchor &&
      anchor.tickUpper > UPPER_EXTENSION_TICK_UPPER &&
      (anchorGapTicks === 0 || (buyMode && anchorGapTicks > 0 && anchorGapTicks <= 400))
  if (!anchorMatches) {
    throw new Error('现有高位续航仓与接力边界不一致，停止创建')
  }
  if (
    records.some(
      (record) => record.tickLower === UPPER_EXTENSION_TICK_LOWER && record.tickUpper === UPPER_EXTENSION_TICK_UPPER,
    )
  ) {
    throw new Error('已有相同高位接力区间的活动 LP')
  }

  const [
    blockNumber,
    nonceLatest,
    noncePending,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    usdgBalance,
    spyErc20Allowance,
    pairErc20Allowance,
    spyRouterPermit2Allowance,
    gasPrice,
    spyMark,
    ethMark,
    protectedReads,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    getPoolState(),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'allowance', args: [WALLET, PERMIT2] }),
    publicClient.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [WALLET, SPY, UNIVERSAL_ROUTER],
    }),
    publicClient.getGasPrice(),
    quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT),
    quoteBestEthToSpy(parseEther('0.01')),
    Promise.all(
      records.map(async (record) => ({
        tokenId: String(record.tokenId),
        owner: await publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [BigInt(record.tokenId)],
        }),
        liquidity: await publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(record.tokenId)],
        }),
        expectedLiquidity: BigInt(record.liquidity),
      })),
    ),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  const rangePositionBps = customRangePositionBps(
    poolState.tick,
    UPPER_EXTENSION_TICK_LOWER,
    UPPER_EXTENSION_TICK_UPPER,
  )
  if (UPPER_EXTENSION_PAIRED_IN_RANGE) {
    if (poolState.tick < UPPER_EXTENSION_TICK_LOWER || poolState.tick >= UPPER_EXTENSION_TICK_UPPER) {
      throw new Error(`PAIR 不在双边补隙区间：tick=${poolState.tick}`)
    }
    if (
      rangePositionBps < UPPER_EXTENSION_PAIRED_MIN_RANGE_POSITION_BPS ||
      rangePositionBps > UPPER_EXTENSION_PAIRED_MAX_RANGE_POSITION_BPS
    ) {
      throw new Error(`PAIR 过于接近双边补隙区间边界：tick=${poolState.tick}, rangeBps=${rangePositionBps}`)
    }
  } else if (poolState.tick < UPPER_EXTENSION_TICK_UPPER) {
    throw new Error(`PAIR 已进入接力区间，不能再以单边 PAIR 建仓：tick=${poolState.tick}`)
  }
  for (const item of protectedReads) {
    if (item.owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`受保护 LP ${item.tokenId} 所有权异常`)
    if (item.liquidity !== item.expectedLiquidity) throw new Error(`受保护 LP ${item.tokenId} liquidity 与账本不符`)
  }

  let purchase = null
  let authorizedPairWei = pairBalance
  if (buyMode) {
    const target = await quoteSpyInputForTargetUsdg(UPPER_EXTENSION_BUY_USDG_ATOMIC, spyMark)
    if (target.amountIn <= 0n || target.amountIn > spyBalance) {
      throw new Error(`钱包 SPY 不足以完成 ${formatUnits(UPPER_EXTENSION_BUY_USDG_ATOMIC, 6)} USDG 买入`)
    }
    const pairQuote = await quoteSpyToPair(target.amountIn)
    const spotPairOut = (target.amountIn * poolState.sqrtPriceX96 * poolState.sqrtPriceX96) / Q192
    const quoteRetentionBps = spotPairOut > 0n ? (pairQuote.amountOut * 10_000n) / spotPairOut : 0n
    if (quoteRetentionBps < UPPER_EXTENSION_MIN_QUOTE_RETENTION_BPS) {
      throw new Error(`SPY→PAIR 报价留存率过低：${quoteRetentionBps} bps`)
    }
    authorizedPairWei = pairQuote.amountOut
    purchase = {
      requestedUsdgAtomic: UPPER_EXTENSION_BUY_USDG_ATOMIC,
      spyInputWei: target.amountIn,
      markedInputUsdgAtomic: target.valuation.amountOut,
      quotedPairOutWei: pairQuote.amountOut,
      minimumPairOutWei: bpsFloor(pairQuote.amountOut, UPPER_EXTENSION_BUY_SLIPPAGE_BPS),
      quoteGasEstimate: pairQuote.gasEstimate,
      quoteRetentionBps,
    }
  } else {
    if (pairBalance <= 0n) throw new Error('钱包没有可投入的 PAIR')
    if (pairErc20Allowance < pairBalance)
      throw new Error('PAIR 对 Permit2 的 ERC20 allowance 不足，当前流程拒绝新增授权交易')
  }

  const account = loadAccount()
  const availableSpyForMint = spyBalance - (purchase?.spyInputWei || 0n)
  const mint = UPPER_EXTENSION_PAIRED_IN_RANGE
    ? await buildCustomRangeMint(
        account,
        availableSpyForMint,
        authorizedPairWei,
        UPPER_EXTENSION_TICK_LOWER,
        UPPER_EXTENSION_TICK_UPPER,
        {
          minimumRangePositionBps: UPPER_EXTENSION_PAIRED_MIN_RANGE_POSITION_BPS,
          maximumRangePositionBps: UPPER_EXTENSION_PAIRED_MAX_RANGE_POSITION_BPS,
          slippageTolerance: UPPER_EXTENSION_MINT_SLIPPAGE,
          safetyBps: UPPER_EXTENSION_PAIRED_MINT_SAFETY_BPS,
        },
      )
    : await buildUpperExtensionMint(account, authorizedPairWei)
  const projectedPairUseBps = (mint.amount1Desired * 10_000n) / authorizedPairWei
  const minimumPairUseBps = UPPER_EXTENSION_PAIRED_IN_RANGE
    ? UPPER_EXTENSION_PAIRED_MIN_PAIR_USE_BPS
    : UPPER_EXTENSION_MIN_PAIR_USE_BPS
  if (projectedPairUseBps < minimumPairUseBps) {
    throw new Error(`新区间预计仅使用新买 PAIR 的 ${Number(projectedPairUseBps) / 100}%，停止建仓`)
  }
  if (mint.poolState.tick !== poolState.tick) {
    if (Math.abs(mint.poolState.tick - poolState.tick) > poolKey.tickSpacing) {
      throw new Error(`构建 mint 期间 tick 漂移过大：${poolState.tick} → ${mint.poolState.tick}`)
    }
  }
  let modeledGasUnits
  let mintBudget
  if (buyMode) {
    const needsSpyErc20Approval = spyErc20Allowance < purchase.spyInputWei + mint.amount0Max
    const needsSpyPermit2Approval =
      spyRouterPermit2Allowance[0] < purchase.spyInputWei || spyRouterPermit2Allowance[1] <= BigInt(nowSeconds() + 300)
    const needsPairErc20Approval = pairErc20Allowance < authorizedPairWei
    modeledGasUnits =
      (purchase.quoteGasEstimate > UPPER_EXTENSION_GAS_MODEL.v4Swap
        ? purchase.quoteGasEstimate
        : UPPER_EXTENSION_GAS_MODEL.v4Swap) +
      UPPER_EXTENSION_GAS_MODEL.mint +
      (needsSpyErc20Approval ? UPPER_EXTENSION_GAS_MODEL.erc20Approval : 0n) +
      (needsSpyPermit2Approval ? UPPER_EXTENSION_GAS_MODEL.permit2Approval : 0n) +
      (needsPairErc20Approval ? UPPER_EXTENSION_GAS_MODEL.erc20Approval : 0n)
    mintBudget = { estimatedGas: UPPER_EXTENSION_GAS_MODEL.mint, gasLimit: UPPER_EXTENSION_GAS_MODEL.mint }
  } else {
    mintBudget = await transactionBudget(POSITION_MANAGER, mint.data)
    modeledGasUnits = mintBudget.gasLimit
  }
  const sendGasPrice = (gasPrice * UPPER_EXTENSION_SEND_GAS_PRICE_BPS + 9_999n) / 10_000n
  const safeModeledGasWei = (modeledGasUnits * sendGasPrice * UPPER_EXTENSION_GAS_MODEL.safetyBps) / 10_000n
  const ethMarkUsdgAtomic = (ethMark.amountOut * spyMark.amountOut) / ADD_SPY_MARK_INPUT
  if (ethMarkUsdgAtomic <= 0n) throw new Error('ETH/USDG 标记价格为 0')
  const maximumGasWei = (UPPER_EXTENSION_MAX_GAS_USDG_ATOMIC * parseEther('0.01')) / ethMarkUsdgAtomic
  const modeledGasUsdgAtomic = (safeModeledGasWei * ethMarkUsdgAtomic) / parseEther('0.01')
  const requiredEth = UPPER_EXTENSION_MIN_ETH_RESERVE + maximumGasWei
  const status =
    ethBalance < requiredEth ? 'NEEDS_ETH_TOP_UP' : safeModeledGasWei > maximumGasWei ? 'WAIT_GAS' : 'READY'

  const spyPriceUsdg = Number(formatUnits(spyMark.amountOut, 6)) / Number(formatUnits(ADD_SPY_MARK_INPUT, 18))
  const prices = customRangePricesUsdg(spyPriceUsdg, UPPER_EXTENSION_TICK_LOWER, UPPER_EXTENSION_TICK_UPPER)
  const capital = tokenAmountsUsdg(mint.amount0Desired, mint.amount1Desired, poolState, spyMark)
  let marketEvidence = null
  try {
    const snapshots = await Promise.all([fetchCurrentBandSnapshot('1h'), fetchCurrentBandSnapshot('6h')])
    marketEvidence = Object.fromEntries(
      snapshots.map((snapshot) => [
        snapshot.selectedWindow,
        currentBandWindowMetrics(
          snapshot,
          mint.liquidity,
          Number(formatUnits(capital.totalUsdg, 6)),
          UPPER_EXTENSION_TICK_LOWER,
          UPPER_EXTENSION_TICK_UPPER,
        ),
      ]),
    )
  } catch (error) {
    throw new Error(`公开面板证据不可用，停止实盘：${error.shortMessage || error.message}`)
  }

  const report = {
    status,
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    pool: {
      currentTick: poolState.tick,
      currentPairPriceUsdg: (spyPriceUsdg / Math.pow(1.0001, poolState.tick)).toFixed(8),
      targetTickLower: UPPER_EXTENSION_TICK_LOWER,
      targetTickUpper: UPPER_EXTENSION_TICK_UPPER,
      targetPriceLowUsdg: prices.low.toFixed(8),
      targetPriceHighUsdg: prices.high.toFixed(8),
      mode: UPPER_EXTENSION_PAIRED_IN_RANGE ? 'paired_gap_fill_in_range' : 'single_sided_pair_out_of_range',
      rangePositionPct: UPPER_EXTENSION_PAIRED_IN_RANGE ? (Number(rangePositionBps) / 100).toFixed(2) : null,
      anchorTokenId: UPPER_EXTENSION_ANCHOR_TOKEN_ID,
      anchorGapTicks,
      overlappingTokenIds: overlappingRecords.map((record) => String(record.tokenId)),
    },
    authorizedAssets: {
      mode: buyMode ? 'buy_pair_with_spy_then_mint_only_bought_pair' : 'use_all_direct_wallet_pair',
      pair: formatUnits(authorizedPairWei, 18),
      pairWei: authorizedPairWei.toString(),
      markedUsdg: formatUnits(capital.totalUsdg, 6),
      policy: buyMode
        ? UPPER_EXTENSION_PAIRED_IN_RANGE
          ? 'buy the authorized PAIR notional, preserve pre-existing wallet PAIR, and use only the SPY ratio needed to mint it'
          : 'spend only the derived SPY amount; preserve pre-existing wallet PAIR and all existing LP liquidity'
        : 'use the complete direct wallet PAIR balance observed at preflight; do not collect fees or use SPY/USDG',
    },
    purchase: purchase
      ? {
          requestedUsdg: formatUnits(purchase.requestedUsdgAtomic, 6),
          spyInput: formatUnits(purchase.spyInputWei, 18),
          markedInputUsdg: formatUnits(purchase.markedInputUsdgAtomic, 6),
          quotedPairOut: formatUnits(purchase.quotedPairOutWei, 18),
          minimumPairOut: formatUnits(purchase.minimumPairOutWei, 18),
          quoteRetentionPct: (Number(purchase.quoteRetentionBps) / 100).toFixed(2),
          slippageBps: Number(UPPER_EXTENSION_BUY_SLIPPAGE_BPS),
        }
      : null,
    projectedMint: {
      liquidity: mint.liquidity.toString(),
      desiredSpy: formatUnits(mint.amount0Desired, 18),
      desiredPair: formatUnits(mint.amount1Desired, 18),
      pairUsePct: (Number(projectedPairUseBps) / 100).toFixed(2),
      residualPairWei: (authorizedPairWei - mint.amount1Desired).toString(),
    },
    marketEvidence,
    protectedPositions: protectedReads.map((item) => ({ tokenId: item.tokenId, liquidity: item.liquidity.toString() })),
    preservedWalletBalances: {
      spyBefore: formatUnits(spyBalance, 18),
      spyAfterPurchaseExpected: formatUnits(spyBalance - (purchase?.spyInputWei || 0n), 18),
      spyAfterMintExpected: formatUnits(spyBalance - (purchase?.spyInputWei || 0n) - mint.amount0Desired, 18),
      preExistingPair: formatUnits(pairBalance, 18),
      usdg: formatUnits(usdgBalance, 6),
    },
    gas: {
      gasPriceGwei: (Number(gasPrice) / 1e9).toFixed(6),
      estimatedGas: mintBudget.estimatedGas.toString(),
      gasLimit: mintBudget.gasLimit.toString(),
      modeledTotalGasUnits: modeledGasUnits.toString(),
      safeModeledGasEth: formatEther(safeModeledGasWei),
      safeModeledGasUsdg: formatUnits(modeledGasUsdgAtomic, 6),
      maximumGasUsdg: formatUnits(UPPER_EXTENSION_MAX_GAS_USDG_ATOMIC, 6),
      maximumGasEth: formatEther(maximumGasWei),
      minimumFinalEth: formatEther(UPPER_EXTENSION_MIN_ETH_RESERVE),
      currentEth: formatEther(ethBalance),
    },
  }
  appendAudit('upper_extension_preflight', report)
  if (print) console.log(stringify(report))
  if (requireReady && status !== 'READY') throw new Error(`高位接力仓预检未就绪：${status}`)
  return {
    state,
    report,
    blockNumber,
    ethBalance,
    spyBalance,
    pairBalance,
    usdgBalance,
    protectedReads,
    mint,
    maximumGasWei,
    purchase,
    authorizedPairWei,
  }
}

async function upperExtensionConfirmedTransactions(pending) {
  const results = []
  for (const hash of [...new Set(pending.transactions || [])]) {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`高位接力仓历史交易不是 success：${hash}`)
    results.push({ hash, receipt, gasCost: receipt.gasUsed * receipt.effectiveGasPrice })
  }
  return results
}

async function upperExtensionGasSpentWei(pending) {
  return receiptGasTotal(await upperExtensionConfirmedTransactions(pending))
}

async function readUpperExtensionProtectedInvariants(pending) {
  return Promise.all(
    pending.protectedPositions.map(async (item) => {
      const [owner, liquidity] = await Promise.all([
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [BigInt(item.tokenId)],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(item.tokenId)],
        }),
      ])
      if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`受保护 LP ${item.tokenId} 所有权发生变化`)
      if (liquidity !== BigInt(item.liquidity)) throw new Error(`受保护 LP ${item.tokenId} liquidity 发生变化`)
      return { tokenId: item.tokenId, liquidity }
    }),
  )
}

async function reconcileUpperExtensionPurchase(state, pending) {
  if (!pending.purchase || pending.purchaseComplete) return
  if (!pending.swapTransaction) throw new Error('高位接力仓买入计划缺少 swap 交易')
  const receipt = await publicClient.getTransactionReceipt({ hash: pending.swapTransaction })
  if (receipt.status !== 'success') throw new Error(`高位接力仓 SPY→PAIR 回执失败：${pending.swapTransaction}`)
  const spyNet = tokenNetFromReceipt(receipt, SPY)
  const pairNet = tokenNetFromReceipt(receipt, PAIR)
  const actualSpyInput = -spyNet
  if (actualSpyInput !== BigInt(pending.purchase.spyInputWei)) {
    throw new Error(`高位接力仓 SPY 实际支出不符：actual=${actualSpyInput}, plan=${pending.purchase.spyInputWei}`)
  }
  if (pairNet < BigInt(pending.purchase.minimumPairOutWei)) {
    throw new Error(
      `高位接力仓 PAIR 实际收入低于保护值：actual=${pairNet}, minimum=${pending.purchase.minimumPairOutWei}`,
    )
  }
  pending.purchase.actualPairOutWei = pairNet.toString()
  pending.purchase.actualSpyInputWei = actualSpyInput.toString()
  pending.authorizedPairWei = pairNet.toString()
  pending.purchaseComplete = true
  pending.status = 'pair_bought'
  writeState(state)
}

async function upperExtensionSend(state, pending, walletClient, args) {
  const budget = await fastTransactionBudget(args.to, args.data, args.value || 0n)
  const sendGasPrice = (budget.gasPrice * UPPER_EXTENSION_SEND_GAS_PRICE_BPS + 9_999n) / 10_000n
  const prospectiveBudget = (budget.gasLimit * sendGasPrice * 125n) / 100n
  const spent = await upperExtensionGasSpentWei(pending)
  if (spent + prospectiveBudget > BigInt(pending.maximumGasWei)) {
    throw new Error(`${args.label} 将使总 Gas 预算超过 5 USDG`)
  }
  const result = await sendChecked(walletClient, {
    ...args,
    minimumBalanceAfter: UPPER_EXTENSION_MIN_ETH_RESERVE,
    fast: true,
    gasPriceMultiplierBps: UPPER_EXTENSION_SEND_GAS_PRICE_BPS,
    gasBudgetSafetyBps: 12_500n,
  })
  pending.transactions = [...new Set([...(pending.transactions || []), result.hash])]
  if (pending.currentStep === 'mint') pending.mintTransaction = result.hash
  if (pending.currentStep === 'swap_spy_to_pair') pending.swapTransaction = result.hash
  pending.currentStep = null
  writeState(state)
  return result
}

async function resolveUpperExtensionUnknown(state, pending) {
  if (!pending.unknownTransaction) return
  const unknown = pending.unknownTransaction
  const receipt = await publicClient.getTransactionReceipt({ hash: unknown.hash })
  if (receipt.status !== 'success') {
    pending.failedTransactions = [...new Set([...(pending.failedTransactions || []), unknown.hash])]
    pending.failedStep = unknown.step
    delete pending.unknownTransaction
    pending.status = 'failed_on_chain'
    writeState(state)
    throw new Error(`高位接力仓交易已回滚，停止重试：${unknown.hash}`)
  }
  pending.transactions = [...new Set([...(pending.transactions || []), unknown.hash])]
  if (unknown.step === 'mint') pending.mintTransaction = unknown.hash
  if (unknown.step === 'swap_spy_to_pair') pending.swapTransaction = unknown.hash
  delete pending.unknownTransaction
  pending.currentStep = null
  writeState(state)
}

async function finalizeUpperExtension(state, pending) {
  if (!pending.mintTransaction || !pending.mintPlan) throw new Error('高位接力仓没有可结算的 mint')
  const receipt = await publicClient.getTransactionReceipt({ hash: pending.mintTransaction })
  if (receipt.status !== 'success') throw new Error(`高位接力仓 mint 回执失败：${pending.mintTransaction}`)
  const tokenId = parseMintTokenId(receipt)
  if (tokenId === null) throw new Error(`高位接力仓 mint 成功但未解析到 NFT：${pending.mintTransaction}`)
  const [owner, liquidity, finalEth, finalSpy, finalPair, finalUsdg, poolState, invariants] = await Promise.all([
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
    getPoolState(),
    readUpperExtensionProtectedInvariants(pending),
  ])
  if (owner.toLowerCase() !== WALLET.toLowerCase() || liquidity === 0n) throw new Error('高位接力仓 NFT 链上读回不完整')
  if (liquidity !== BigInt(pending.mintPlan.liquidity))
    throw new Error(`高位接力仓 liquidity 不一致：chain=${liquidity}, plan=${pending.mintPlan.liquidity}`)
  const purchasePairWei = pending.purchase ? BigInt(pending.purchase.actualPairOutWei || 0) : 0n
  const mintSpyWei = BigInt(pending.mintPlan.desiredSpyWei)
  const expectedFinalSpy =
    BigInt(pending.initialSpyWei) - (pending.purchase ? BigInt(pending.purchase.spyInputWei) : 0n) - mintSpyWei
  if (finalSpy !== expectedFinalSpy) throw new Error('高位接力仓最终 SPY 与授权买入计划不一致')
  if (finalUsdg !== BigInt(pending.initialUsdgAtomic)) throw new Error('高位接力仓意外动用了钱包 USDG')
  if (finalEth < UPPER_EXTENSION_MIN_ETH_RESERVE) throw new Error('高位接力仓完成后 ETH 低于储备线')
  const pairSpentWei = BigInt(pending.initialPairWei) + purchasePairWei - finalPair
  if (pairSpentWei <= 0n || pairSpentWei !== BigInt(pending.mintPlan.desiredPairWei)) {
    throw new Error(`高位接力仓 PAIR 支出不一致：spent=${pairSpentWei}, plan=${pending.mintPlan.desiredPairWei}`)
  }
  const minimumPairUseBps = pending.pairedInRange
    ? UPPER_EXTENSION_PAIRED_MIN_PAIR_USE_BPS
    : UPPER_EXTENSION_MIN_PAIR_USE_BPS
  if (pairSpentWei * 10_000n < BigInt(pending.authorizedPairWei) * minimumPairUseBps) {
    throw new Error('高位接力仓未最大化使用授权 PAIR')
  }

  const position = new Position({
    pool: makePool(poolState),
    liquidity: liquidity.toString(),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
  })
  const underlyingSpyWei = asBigInt(position.amount0.quotient)
  const underlyingPairWei = asBigInt(position.amount1.quotient)
  const spyMark = await quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT)
  const spyPriceUsdg = Number(formatUnits(spyMark.amountOut, 6)) / Number(formatUnits(ADD_SPY_MARK_INPUT, 18))
  const prices = customRangePricesUsdg(spyPriceUsdg, pending.tickLower, pending.tickUpper)
  const transactions = await upperExtensionConfirmedTransactions(pending)
  const gasSpentWei = receiptGasTotal(transactions)
  const record = {
    id: pending.id,
    label: pending.pairedInRange ? '高位补隙仓' : '高位接力仓',
    role: pending.pairedInRange ? 'upper-gap-fill' : 'upper-extension',
    status: 'active',
    completedAt: new Date().toISOString(),
    tokenId: tokenId.toString(),
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
    liquidity: liquidity.toString(),
    source: pending.purchase
      ? pending.pairedInRange
        ? 'PAIR bought with the explicitly authorized SPY amount and paired with the required wallet SPY; pre-existing wallet PAIR excluded'
        : 'PAIR bought with the explicitly authorized SPY amount; pre-existing wallet PAIR and existing LP liquidity excluded'
      : 'complete direct wallet PAIR balance observed at preflight; existing LP fees and wallet SPY/USDG excluded',
    policy: {
      mode: pending.pairedInRange ? 'paired_gap_fill_in_range' : 'single_sided_pair_upper_continuation',
      autoExit: false,
      useAllWalletPair: !pending.purchase,
      preservePreExistingWalletPair: Boolean(pending.purchase),
      buyPairWithSpyUsdg: pending.purchase ? formatUnits(BigInt(pending.purchase.requestedUsdgAtomic), 6) : '0',
      collectFees: false,
      preserveExistingLpLiquidity: true,
      preserveWalletUsdg: true,
      maximumGasUsdg: '5',
      minimumFinalEthWei: UPPER_EXTENSION_MIN_ETH_RESERVE.toString(),
    },
    authorizedInitialWalletAssets: {
      spyWei: pending.initialSpyWei,
      pairWei: pending.initialPairWei,
      authorizedPairWei: pending.authorizedPairWei,
      usdgAtomic: pending.initialUsdgAtomic,
    },
    purchase: pending.purchase
      ? {
          requestedUsdgAtomic: pending.purchase.requestedUsdgAtomic,
          markedInputUsdgAtomic: pending.purchase.markedInputUsdgAtomic,
          spyInputWei: pending.purchase.actualSpyInputWei,
          quotedPairOutWei: pending.purchase.quotedPairOutWei,
          minimumPairOutWei: pending.purchase.minimumPairOutWei,
          actualPairOutWei: pending.purchase.actualPairOutWei,
          transaction: pending.swapTransaction,
        }
      : null,
    minted: {
      desiredSpyWei: pending.mintPlan.desiredSpyWei,
      desiredPairWei: pending.mintPlan.desiredPairWei,
      walletSpentSpyWei: mintSpyWei.toString(),
      walletSpentPairWei: pairSpentWei.toString(),
      underlyingSpyWei: underlyingSpyWei.toString(),
      underlyingPairWei: underlyingPairWei.toString(),
      transaction: pending.mintTransaction,
      blockNumber: receipt.blockNumber.toString(),
    },
    residual: { spyWei: finalSpy.toString(), pairWei: finalPair.toString(), usdgAtomic: finalUsdg.toString() },
    protectedPositionInvariants: invariants.map((item) => ({
      tokenId: item.tokenId,
      liquidityAfter: item.liquidity.toString(),
    })),
    marketEvidence: pending.marketEvidence,
    priceSnapshot: {
      spyPriceUsdg: spyPriceUsdg.toFixed(6),
      currentPairPriceUsdg: (spyPriceUsdg / Math.pow(1.0001, poolState.tick)).toFixed(8),
      actualPairPriceLowUsdg: prices.low.toFixed(8),
      actualPairPriceHighUsdg: prices.high.toFixed(8),
      currentTick: poolState.tick,
      inRange: poolState.tick >= pending.tickLower && poolState.tick < pending.tickUpper,
    },
    gasSpentWei: gasSpentWei.toString(),
    gasCapWei: pending.maximumGasWei,
    gasCapBreached: gasSpentWei > BigInt(pending.maximumGasWei),
    finalEthWei: finalEth.toString(),
    transactions: pending.transactions,
  }
  state.satellites = [...(state.satellites || []), record]
  state.upperExtensionEntries = [...(state.upperExtensionEntries || []), record]
  delete state.pendingUpperExtension
  writeState(state)
  appendAudit('upper_extension_complete', record)
  console.log(
    stringify({
      status: 'UPPER_EXTENSION_ACTIVE',
      tokenId,
      liquidity,
      priceSnapshot: record.priceSnapshot,
      purchase: record.purchase
        ? {
            spySpent: formatUnits(BigInt(record.purchase.spyInputWei), 18),
            pairBought: formatUnits(BigInt(record.purchase.actualPairOutWei), 18),
            markedInputUsdg: formatUnits(BigInt(record.purchase.markedInputUsdgAtomic), 6),
            transaction: record.purchase.transaction,
          }
        : null,
      pairDeposited: formatUnits(pairSpentWei, 18),
      spyDeposited: formatUnits(mintSpyWei, 18),
      lpUnderlying: { spy: formatUnits(underlyingSpyWei, 18), pair: formatUnits(underlyingPairWei, 18) },
      residual: { spy: formatUnits(finalSpy, 18), pair: formatUnits(finalPair, 18), usdg: formatUnits(finalUsdg, 6) },
      existingPositionsLiquidityUnchanged: true,
      gasSpentEth: formatEther(gasSpentWei),
      gasCapBreached: record.gasCapBreached,
      finalEth: formatEther(finalEth),
      transactions: record.transactions,
    }),
  )
  return record
}

async function continueUpperExtension(state, pending) {
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  await resolveUpperExtensionUnknown(state, pending)
  if ((pending.failedTransactions || []).length) throw new Error('高位接力仓存在失败交易，禁止自动重试')
  if (pending.purchase && pending.swapTransaction && !pending.purchaseComplete) {
    await reconcileUpperExtensionPurchase(state, pending)
  }
  if (pending.mintTransaction) return finalizeUpperExtension(state, pending)

  let [nonceLatest, noncePending, liveEth, liveSpy, livePair, liveUsdg, livePool] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`高位接力仓执行前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (liveEth < UPPER_EXTENSION_MIN_ETH_RESERVE) throw new Error('高位接力仓执行前 ETH 低于储备线')
  await readUpperExtensionProtectedInvariants(pending)

  if (pending.purchase && !pending.purchaseComplete) {
    if (
      liveSpy !== BigInt(pending.initialSpyWei) ||
      livePair !== BigInt(pending.initialPairWei) ||
      liveUsdg !== BigInt(pending.initialUsdgAtomic)
    ) {
      throw new Error('买入前钱包代币余额偏离预检基线')
    }
    if (pending.pairedInRange) {
      const rangeBps = customRangePositionBps(livePool.tick, pending.tickLower, pending.tickUpper)
      if (
        livePool.tick < pending.tickLower ||
        livePool.tick >= pending.tickUpper ||
        rangeBps < UPPER_EXTENSION_PAIRED_MIN_RANGE_POSITION_BPS ||
        rangeBps > UPPER_EXTENSION_PAIRED_MAX_RANGE_POSITION_BPS
      ) {
        throw new Error(`PAIR 已离开双边补隙仓安全区，买入前停止：tick=${livePool.tick}`)
      }
    } else if (livePool.tick < pending.tickUpper)
      throw new Error(`PAIR 已进入接力区间，买入前停止：tick=${livePool.tick}`)
    const spyInputWei = BigInt(pending.purchase.spyInputWei)
    let spyErc20Allowance = await publicClient.readContract({
      address: SPY,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [WALLET, PERMIT2],
    })
    if (spyErc20Allowance < spyInputWei) {
      pending.currentStep = 'approve_spy_erc20'
      writeState(state)
      await upperExtensionSend(state, pending, walletClient, {
        label: `高位接力仓授权 SPY 给 Permit2 (${pending.id})`,
        to: SPY,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, maxUint256] }),
      })
      spyErc20Allowance = maxUint256
    }
    const [routerAmount, routerExpiration] = await publicClient.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [WALLET, SPY, UNIVERSAL_ROUTER],
    })
    if (routerAmount < spyInputWei || routerExpiration <= BigInt(nowSeconds() + 300)) {
      pending.currentStep = 'approve_spy_permit2'
      writeState(state)
      await upperExtensionSend(state, pending, walletClient, {
        label: `高位接力仓授权路由使用 SPY (${pending.id})`,
        to: PERMIT2,
        data: encodeFunctionData({
          abi: PERMIT2_ABI,
          functionName: 'approve',
          args: [
            SPY,
            UNIVERSAL_ROUTER,
            spyInputWei > UINT160_MAX ? UINT160_MAX : spyInputWei,
            BigInt(nowSeconds() + 60 * 60),
          ],
        }),
      })
    }

    ;[nonceLatest, noncePending, liveEth, liveSpy, livePair, liveUsdg, livePool] = await Promise.all([
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
      publicClient.getBalance({ address: WALLET }),
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      getPoolState(),
    ])
    if (nonceLatest !== noncePending)
      throw new Error(`高位接力仓 swap 前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
    if (liveEth < UPPER_EXTENSION_MIN_ETH_RESERVE) throw new Error('高位接力仓 swap 前 ETH 低于储备线')
    if (
      liveSpy !== BigInt(pending.initialSpyWei) ||
      livePair !== BigInt(pending.initialPairWei) ||
      liveUsdg !== BigInt(pending.initialUsdgAtomic)
    ) {
      throw new Error('授权后钱包代币余额偏离预检基线')
    }
    if (pending.pairedInRange) {
      const rangeBps = customRangePositionBps(livePool.tick, pending.tickLower, pending.tickUpper)
      if (
        livePool.tick < pending.tickLower ||
        livePool.tick >= pending.tickUpper ||
        rangeBps < UPPER_EXTENSION_PAIRED_MIN_RANGE_POSITION_BPS ||
        rangeBps > UPPER_EXTENSION_PAIRED_MAX_RANGE_POSITION_BPS
      ) {
        throw new Error(`PAIR 已离开双边补隙仓安全区，swap 前停止：tick=${livePool.tick}`)
      }
    } else if (livePool.tick < pending.tickUpper)
      throw new Error(`PAIR 已进入接力区间，swap 前停止：tick=${livePool.tick}`)
    await readUpperExtensionProtectedInvariants(pending)
    const quote = await quoteSpyToPair(spyInputWei)
    const spotPairOut = (spyInputWei * livePool.sqrtPriceX96 * livePool.sqrtPriceX96) / Q192
    const retentionBps = spotPairOut > 0n ? (quote.amountOut * 10_000n) / spotPairOut : 0n
    if (retentionBps < UPPER_EXTENSION_MIN_QUOTE_RETENTION_BPS) {
      throw new Error(`广播前 SPY→PAIR 报价留存率过低：${retentionBps} bps`)
    }
    pending.purchase.quotedPairOutWei = quote.amountOut.toString()
    pending.purchase.minimumPairOutWei = bpsFloor(quote.amountOut, UPPER_EXTENSION_BUY_SLIPPAGE_BPS).toString()
    pending.purchase.quoteRetentionBps = retentionBps.toString()
    pending.currentStep = 'swap_spy_to_pair'
    pending.status = 'swap_prepared'
    writeState(state)
    const swap = await upperExtensionSend(state, pending, walletClient, {
      label: `高位接力仓 SPY→PAIR 买入 (${pending.id})`,
      to: UNIVERSAL_ROUTER,
      data: buildV4SwapData(
        spyInputWei,
        BigInt(pending.purchase.minimumPairOutWei),
        BigInt(nowSeconds() + 5 * 60),
        true,
      ),
    })
    pending.swapTransaction = swap.hash
    writeState(state)
    await reconcileUpperExtensionPurchase(state, pending)
  }

  ;[nonceLatest, noncePending, liveEth, liveSpy, livePair, liveUsdg, livePool] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
  ])
  const purchasePairWei = pending.purchase ? BigInt(pending.purchase.actualPairOutWei || 0) : 0n
  const expectedSpyWei = BigInt(pending.initialSpyWei) - (pending.purchase ? BigInt(pending.purchase.spyInputWei) : 0n)
  const expectedPairWei = BigInt(pending.initialPairWei) + purchasePairWei
  if (nonceLatest !== noncePending)
    throw new Error(`高位接力仓 mint 前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (liveEth < UPPER_EXTENSION_MIN_ETH_RESERVE) throw new Error('高位接力仓 mint 前 ETH 低于储备线')
  if (liveSpy !== expectedSpyWei || livePair !== expectedPairWei || liveUsdg !== BigInt(pending.initialUsdgAtomic)) {
    throw new Error('高位接力仓 mint 前钱包余额与授权资产不一致')
  }
  if (pending.pairedInRange) {
    const rangeBps = customRangePositionBps(livePool.tick, pending.tickLower, pending.tickUpper)
    if (
      livePool.tick < pending.tickLower ||
      livePool.tick >= pending.tickUpper ||
      rangeBps < UPPER_EXTENSION_PAIRED_MIN_RANGE_POSITION_BPS ||
      rangeBps > UPPER_EXTENSION_PAIRED_MAX_RANGE_POSITION_BPS
    ) {
      throw new Error(`PAIR 已离开双边补隙仓安全区，停止铸仓：tick=${livePool.tick}`)
    }
  } else if (livePool.tick < pending.tickUpper)
    throw new Error(`PAIR 已进入接力区间，停止单边铸仓：tick=${livePool.tick}`)
  await readUpperExtensionProtectedInvariants(pending)
  const authorizedPairWei = BigInt(pending.authorizedPairWei)
  let pairAllowance = await publicClient.readContract({
    address: PAIR,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [WALLET, PERMIT2],
  })
  if (pairAllowance < authorizedPairWei) {
    pending.currentStep = 'approve_pair_erc20'
    writeState(state)
    await upperExtensionSend(state, pending, walletClient, {
      label: `高位接力仓授权 PAIR 给 Permit2 (${pending.id})`,
      to: PAIR,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, maxUint256] }),
    })
    pairAllowance = maxUint256
  }
  const mint = pending.pairedInRange
    ? await buildCustomRangeMint(account, liveSpy, authorizedPairWei, pending.tickLower, pending.tickUpper, {
        minimumRangePositionBps: UPPER_EXTENSION_PAIRED_MIN_RANGE_POSITION_BPS,
        maximumRangePositionBps: UPPER_EXTENSION_PAIRED_MAX_RANGE_POSITION_BPS,
        slippageTolerance: UPPER_EXTENSION_MINT_SLIPPAGE,
        safetyBps: UPPER_EXTENSION_PAIRED_MINT_SAFETY_BPS,
      })
    : await buildUpperExtensionMint(account, authorizedPairWei, pending.tickLower, pending.tickUpper)
  const plannedPairUseBps = (mint.amount1Desired * 10_000n) / authorizedPairWei
  const minimumPairUseBps = pending.pairedInRange
    ? UPPER_EXTENSION_PAIRED_MIN_PAIR_USE_BPS
    : UPPER_EXTENSION_MIN_PAIR_USE_BPS
  if (plannedPairUseBps < minimumPairUseBps) {
    throw new Error(`铸仓预计仅使用新买 PAIR 的 ${Number(plannedPairUseBps) / 100}%，停止铸造`)
  }
  if (!pending.pairedInRange && mint.poolState.tick < pending.tickUpper)
    throw new Error('构建 mint 时 PAIR 已进入接力区间')
  if (pending.pairedInRange && mint.amount0Max > 0n) {
    const spyAllowance = await publicClient.readContract({
      address: SPY,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [WALLET, PERMIT2],
    })
    if (spyAllowance < mint.amount0Max) {
      pending.currentStep = 'approve_spy_mint_erc20'
      writeState(state)
      await upperExtensionSend(state, pending, walletClient, {
        label: `高位补隙仓授权 SPY 给 Permit2 (${pending.id})`,
        to: SPY,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, maxUint256] }),
      })
    }
  }
  pending.mintPlan = {
    liquidity: mint.liquidity.toString(),
    desiredSpyWei: mint.amount0Desired.toString(),
    desiredPairWei: mint.amount1Desired.toString(),
    maximumSpyWei: mint.amount0Max.toString(),
    maximumPairWei: mint.amount1Max.toString(),
  }
  pending.currentStep = 'mint'
  pending.status = 'mint_prepared'
  writeState(state)
  const result = await upperExtensionSend(state, pending, walletClient, {
    label: `${pending.pairedInRange ? '高位补隙仓' : '高位接力仓'}铸造 PAIR/SPY LP (${pending.id})`,
    to: POSITION_MANAGER,
    data: mint.data,
  })
  pending.mintTransaction = result.hash
  pending.status = 'mint_confirmed'
  writeState(state)
  return finalizeUpperExtension(state, pending)
}

function markUpperExtensionPartial(operationId, error) {
  const state = readState()
  const pending = state?.pendingUpperExtension
  if (!pending || pending.id !== operationId) return
  const message = error.shortMessage || error.message
  const hash = String(message).match(/0x[0-9a-fA-F]{64}/)?.[0]
  if (hash && String(message).includes('回执未知'))
    pending.unknownTransaction = { hash, step: pending.currentStep || 'unknown' }
  if (hash && String(message).includes('链上回执失败')) {
    pending.failedTransactions = [...new Set([...(pending.failedTransactions || []), hash])]
    pending.failedStep = pending.currentStep || 'unknown'
  }
  const hasChainActivity = Boolean(
    (pending.transactions || []).length || pending.unknownTransaction || (pending.failedTransactions || []).length,
  )
  if (!hasChainActivity) delete state.pendingUpperExtension
  else {
    pending.status = 'partial'
    pending.lastErrorAt = new Date().toISOString()
    pending.lastError = message
  }
  writeState(state)
  appendAudit('upper_extension_partial', {
    id: operationId,
    message,
    currentStep: pending.currentStep || null,
    transactions: pending.transactions || [],
    failedTransactions: pending.failedTransactions || [],
    unknownTransaction: pending.unknownTransaction || null,
  })
}

async function upperExtensionEnter() {
  const check = await upperExtensionPreflight({ print: true, requireReady: true })
  const id = `upper-extension-${new Date().toISOString().replace(/[-:.]/g, '')}`
  check.state.pendingUpperExtension = {
    id,
    status: 'planned',
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    tickLower: UPPER_EXTENSION_TICK_LOWER,
    tickUpper: UPPER_EXTENSION_TICK_UPPER,
    pairedInRange: UPPER_EXTENSION_PAIRED_IN_RANGE,
    initialEthWei: check.ethBalance.toString(),
    initialSpyWei: check.spyBalance.toString(),
    initialPairWei: check.pairBalance.toString(),
    initialUsdgAtomic: check.usdgBalance.toString(),
    authorizedPairWei: check.authorizedPairWei.toString(),
    purchase: check.purchase
      ? {
          requestedUsdgAtomic: check.purchase.requestedUsdgAtomic.toString(),
          spyInputWei: check.purchase.spyInputWei.toString(),
          markedInputUsdgAtomic: check.purchase.markedInputUsdgAtomic.toString(),
          quotedPairOutWei: check.purchase.quotedPairOutWei.toString(),
          minimumPairOutWei: check.purchase.minimumPairOutWei.toString(),
          quoteGasEstimate: check.purchase.quoteGasEstimate.toString(),
          quoteRetentionBps: check.purchase.quoteRetentionBps.toString(),
        }
      : null,
    purchaseComplete: !check.purchase,
    maximumGasWei: check.maximumGasWei.toString(),
    protectedPositions: check.protectedReads.map((item) => ({
      tokenId: item.tokenId,
      liquidity: item.liquidity.toString(),
    })),
    marketEvidence: check.report.marketEvidence,
    transactions: [],
    failedTransactions: [],
  }
  writeState(check.state)
  appendAudit('upper_extension_plan_created', check.state.pendingUpperExtension)
  try {
    return await continueUpperExtension(check.state, check.state.pendingUpperExtension)
  } catch (error) {
    markUpperExtensionPartial(id, error)
    throw error
  }
}

async function upperExtensionResume() {
  const state = readState()
  const pending = state?.pendingUpperExtension
  if (!state || state.status !== 'active' || !pending) throw new Error('没有可恢复的高位接力仓计划')
  try {
    return await continueUpperExtension(state, pending)
  } catch (error) {
    markUpperExtensionPartial(pending.id, error)
    throw error
  }
}

async function upperExtensionStatus() {
  const state = readState()
  const pending = state?.pendingUpperExtension || null
  const latest = state?.upperExtensionEntries?.at(-1) || null
  const [eth, spy, pair, usdg, poolState, nonceLatest, noncePending] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  console.log(
    stringify({
      status: pending ? pending.status : latest ? latest.status : 'NOT_STARTED',
      wallet: WALLET,
      nonceLatest,
      noncePending,
      poolTick: poolState.tick,
      inTargetRange: poolState.tick >= UPPER_EXTENSION_TICK_LOWER && poolState.tick < UPPER_EXTENSION_TICK_UPPER,
      balances: {
        eth: formatEther(eth),
        spy: formatUnits(spy, 18),
        pair: formatUnits(pair, 18),
        usdg: formatUnits(usdg, 6),
      },
      pending,
      latest,
    }),
  )
}

async function targetRetirementConfirmedTransactions(pending) {
  const results = []
  for (const hash of [...new Set(pending.transactions || [])]) {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`指定 NFT 撤仓历史交易不是 success：${hash}`)
    results.push({ hash, receipt, gasCost: receipt.gasUsed * receipt.effectiveGasPrice })
  }
  return results
}

async function readTargetRetirementProtectedInvariants(pending) {
  return Promise.all(
    pending.protectedPositions.map(async (item) => {
      const [owner, liquidity] = await Promise.all([
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [BigInt(item.tokenId)],
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(item.tokenId)],
        }),
      ])
      if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`受保护 LP ${item.tokenId} 所有权发生变化`)
      if (liquidity !== BigInt(item.liquidity)) throw new Error(`受保护 LP ${item.tokenId} liquidity 发生变化`)
      return { tokenId: item.tokenId, liquidity }
    }),
  )
}

async function targetRetirementPreflight({ print = true, requireReady = false } = {}) {
  const state = readState()
  if (!state || state.status !== 'active') throw new Error('没有活动的 PAIR/SPY 总账')
  for (const key of [
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
    'pendingCurrentBand',
    'pendingHighBandRoll',
    'pendingUpperExtension',
    'pendingTargetRetirement',
  ]) {
    if (state[key]) throw new Error(`存在未结算计划 ${key}：${state[key].id || 'unknown'}`)
  }
  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()

  // The portfolio ledger is the reconciled source of truth for every current
  // PAIR/SPY NFT, including positions created by dedicated follow-up flows.
  // Completed withdrawals in this staged sequence are excluded until the final
  // chain-audited ledger rebuild catches up.
  const retiredTokenIds = new Set(
    (state.retirements || []).filter((record) => record.status === 'complete').map((record) => String(record.tokenId)),
  )
  const records = activePairPositionRecordsFromPortfolioLedger().filter(
    (record) => !retiredTokenIds.has(String(record.tokenId)),
  )
  const target = records.find((record) => String(record.tokenId) === TARGET_RETIRE_TOKEN_ID)
  if (!target) throw new Error(`活动账本中找不到待撤 NFT ${TARGET_RETIRE_TOKEN_ID}`)
  const protectedRecords = records.filter((record) => String(record.tokenId) !== TARGET_RETIRE_TOKEN_ID)
  const [
    blockNumber,
    nonceLatest,
    noncePending,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    usdgBalance,
    owner,
    liquidity,
    protectedReads,
    spyMark,
    ethMark,
  ] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
    getPoolState(),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [BigInt(TARGET_RETIRE_TOKEN_ID)],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(TARGET_RETIRE_TOKEN_ID)],
    }),
    Promise.all(
      protectedRecords.map(async (record) => ({
        tokenId: String(record.tokenId),
        owner: await publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'ownerOf',
          args: [BigInt(record.tokenId)],
        }),
        liquidity: await publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_NFT_ABI,
          functionName: 'getPositionLiquidity',
          args: [BigInt(record.tokenId)],
        }),
        expectedLiquidity: BigInt(record.liquidity),
      })),
    ),
    quoteBestSpyToUsdg(ADD_SPY_MARK_INPUT),
    quoteBestEthToSpy(parseEther('0.01')),
  ])
  if (nonceLatest !== noncePending)
    throw new Error(`存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`待撤 NFT ${TARGET_RETIRE_TOKEN_ID} 不在执行钱包`)
  if (liquidity === 0n || liquidity !== BigInt(target.liquidity)) {
    throw new Error(
      `待撤 NFT ${TARGET_RETIRE_TOKEN_ID} liquidity 不一致：chain=${liquidity}, local=${target.liquidity}`,
    )
  }
  for (const item of protectedReads) {
    if (item.owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`受保护 LP ${item.tokenId} 所有权异常`)
    if (item.liquidity !== item.expectedLiquidity) throw new Error(`受保护 LP ${item.tokenId} liquidity 与账本不符`)
  }

  const fees = await getAccruedFees(BigInt(TARGET_RETIRE_TOKEN_ID), target.tickLower, target.tickUpper)
  if (fees.liquidity !== liquidity) throw new Error(`待撤 NFT ${TARGET_RETIRE_TOKEN_ID} 手续费读回 liquidity 不一致`)
  const removal = buildFullRemove(target, liquidity, poolState)
  const budget = await transactionBudget(POSITION_MANAGER, removal.data)
  const sendGasPrice = (budget.gasPrice * TARGET_RETIRE_SEND_GAS_PRICE_BPS + 9_999n) / 10_000n
  const safeGasWei = (budget.gasLimit * sendGasPrice * 125n) / 100n
  const ethMarkUsdgAtomic = (ethMark.amountOut * spyMark.amountOut) / ADD_SPY_MARK_INPUT
  if (ethMarkUsdgAtomic <= 0n) throw new Error('ETH/USDG 标记价格为 0')
  const maximumGasWei = (TARGET_RETIRE_MAX_GAS_USDG_ATOMIC * parseEther('0.01')) / ethMarkUsdgAtomic
  const modeledGasUsdgAtomic = (safeGasWei * ethMarkUsdgAtomic) / parseEther('0.01')
  const requiredEth = TARGET_RETIRE_MIN_ETH_RESERVE + maximumGasWei
  const status = ethBalance < requiredEth ? 'NEEDS_ETH_TOP_UP' : safeGasWei > maximumGasWei ? 'WAIT_GAS' : 'READY'
  const principalValue = tokenAmountsUsdg(removal.amount0Principal, removal.amount1Principal, poolState, spyMark)
  const feeValue = tokenAmountsUsdg(fees.spyWei, fees.pairWei, poolState, spyMark)
  const spyPriceUsdg = Number(formatUnits(spyMark.amountOut, 6)) / Number(formatUnits(ADD_SPY_MARK_INPUT, 18))
  const report = {
    status,
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    nonceLatest,
    noncePending,
    pool: {
      currentTick: poolState.tick,
      currentSpyPriceUsdg: spyPriceUsdg.toFixed(6),
      currentPairPriceUsdg: (spyPriceUsdg / Math.pow(1.0001, poolState.tick)).toFixed(8),
    },
    target: {
      tokenId: TARGET_RETIRE_TOKEN_ID,
      location: String(state.position?.tokenId) === TARGET_RETIRE_TOKEN_ID ? 'main' : 'satellite',
      tickLower: target.tickLower,
      tickUpper: target.tickUpper,
      liquidity: liquidity.toString(),
      inRange: poolState.tick >= target.tickLower && poolState.tick < target.tickUpper,
      principal: {
        spy: formatUnits(removal.amount0Principal, 18),
        pair: formatUnits(removal.amount1Principal, 18),
        markedUsdg: formatUnits(principalValue.totalUsdg, 6),
      },
      accruedFees: {
        spy: formatUnits(fees.spyWei, 18),
        pair: formatUnits(fees.pairWei, 18),
        markedUsdg: formatUnits(feeValue.totalUsdg, 6),
      },
      action: 'remove all liquidity and collect; keep NFT unburned; do not swap',
    },
    protectedPositions: protectedReads.map((item) => ({ tokenId: item.tokenId, liquidity: item.liquidity.toString() })),
    preservedWalletBalances: {
      spy: formatUnits(spyBalance, 18),
      pair: formatUnits(pairBalance, 18),
      usdg: formatUnits(usdgBalance, 6),
    },
    gas: {
      estimatedGas: budget.estimatedGas.toString(),
      gasLimit: budget.gasLimit.toString(),
      safeModeledGasEth: formatEther(safeGasWei),
      safeModeledGasUsdg: formatUnits(modeledGasUsdgAtomic, 6),
      maximumGasUsdg: formatUnits(TARGET_RETIRE_MAX_GAS_USDG_ATOMIC, 6),
      maximumGasEth: formatEther(maximumGasWei),
      minimumFinalEth: formatEther(TARGET_RETIRE_MIN_ETH_RESERVE),
      currentEth: formatEther(ethBalance),
    },
  }
  appendAudit('target_retirement_preflight', report)
  if (print) console.log(stringify(report))
  if (requireReady && status !== 'READY') throw new Error(`指定 NFT 撤仓预检未就绪：${status}`)
  return {
    state,
    report,
    blockNumber,
    target,
    protectedReads,
    poolState,
    ethBalance,
    spyBalance,
    pairBalance,
    usdgBalance,
    removal,
    fees,
    maximumGasWei,
  }
}

async function targetRetirementSend(state, pending, walletClient, args) {
  const budget = await fastTransactionBudget(args.to, args.data, args.value || 0n)
  const sendGasPrice = (budget.gasPrice * TARGET_RETIRE_SEND_GAS_PRICE_BPS + 9_999n) / 10_000n
  const prospectiveBudget = (budget.gasLimit * sendGasPrice * 125n) / 100n
  const spent = receiptGasTotal(await targetRetirementConfirmedTransactions(pending))
  if (spent + prospectiveBudget > BigInt(pending.maximumGasWei)) {
    throw new Error(`${args.label} 将使 Gas 预算超过 ${pending.maximumGasUsdg} USDG`)
  }
  const result = await sendChecked(walletClient, {
    ...args,
    minimumBalanceAfter: TARGET_RETIRE_MIN_ETH_RESERVE,
    fast: true,
    gasPriceMultiplierBps: TARGET_RETIRE_SEND_GAS_PRICE_BPS,
    gasBudgetSafetyBps: 12_500n,
  })
  pending.transactions = [...new Set([...(pending.transactions || []), result.hash])]
  if (pending.currentStep === 'remove') pending.removalTransaction = result.hash
  pending.currentStep = null
  writeState(state)
  return result
}

async function resolveTargetRetirementUnknown(state, pending) {
  if (!pending.unknownTransaction) return
  const unknown = pending.unknownTransaction
  const receipt = await publicClient.getTransactionReceipt({ hash: unknown.hash })
  if (receipt.status !== 'success') {
    pending.failedTransactions = [...new Set([...(pending.failedTransactions || []), unknown.hash])]
    pending.failedStep = unknown.step
    delete pending.unknownTransaction
    pending.status = 'failed_on_chain'
    writeState(state)
    throw new Error(`指定 NFT 撤仓交易已回滚，停止重试：${unknown.hash}`)
  }
  pending.transactions = [...new Set([...(pending.transactions || []), unknown.hash])]
  if (unknown.step === 'remove') pending.removalTransaction = unknown.hash
  delete pending.unknownTransaction
  pending.currentStep = null
  writeState(state)
}

async function finalizeTargetRetirement(state, pending) {
  if (!pending.removalTransaction) throw new Error('指定 NFT 撤仓没有可结算交易')
  const receipt = await publicClient.getTransactionReceipt({ hash: pending.removalTransaction })
  if (receipt.status !== 'success') throw new Error(`指定 NFT 撤仓回执失败：${pending.removalTransaction}`)
  const [owner, liquidityAfter, finalEth, finalSpy, finalPair, finalUsdg, invariants] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [BigInt(pending.tokenId)],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(pending.tokenId)],
    }),
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    readTargetRetirementProtectedInvariants(pending),
  ])
  if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error('指定 NFT 撤仓后 owner 异常')
  if (liquidityAfter !== 0n) throw new Error(`指定 NFT 撤仓后 liquidity=${liquidityAfter}`)
  const removedSpyWei = tokenNetFromReceipt(receipt, SPY)
  const removedPairWei = tokenNetFromReceipt(receipt, PAIR)
  if (removedSpyWei < 0n || removedPairWei < 0n || (removedSpyWei === 0n && removedPairWei === 0n)) {
    throw new Error('指定 NFT 撤仓回执的 SPY/PAIR 到账异常')
  }
  if (
    finalSpy < BigInt(pending.initialSpyWei) + removedSpyWei ||
    finalPair < BigInt(pending.initialPairWei) + removedPairWei
  ) {
    throw new Error('指定 NFT 撤仓后钱包余额低于回执净到账')
  }
  if (finalUsdg < BigInt(pending.initialUsdgAtomic)) throw new Error('指定 NFT 撤仓意外减少了钱包 USDG')
  if (finalEth < TARGET_RETIRE_MIN_ETH_RESERVE) throw new Error('指定 NFT 撤仓后 ETH 低于储备线')
  const transactions = await targetRetirementConfirmedTransactions(pending)
  const gasSpentWei = receiptGasTotal(transactions)
  if (gasSpentWei > BigInt(pending.maximumGasWei)) {
    throw new Error(`指定 NFT 撤仓实际 Gas 超过 ${pending.maximumGasUsdg} USDG 上限`)
  }
  const completedAt = new Date().toISOString()
  const record = {
    id: pending.id,
    status: 'complete',
    completedAt,
    tokenId: pending.tokenId,
    tickLower: pending.tickLower,
    tickUpper: pending.tickUpper,
    liquidityBefore: pending.liquidity,
    liquidityAfter: '0',
    removalTransaction: pending.removalTransaction,
    blockNumber: receipt.blockNumber.toString(),
    removedSpyWei: removedSpyWei.toString(),
    removedPairWei: removedPairWei.toString(),
    accruedFeesAtPreflight: pending.accruedFeesAtPreflight,
    grossAmounts: { spyWei: removedSpyWei.toString(), pairWei: removedPairWei.toString() },
    priceSnapshotAtPreflight: pending.priceSnapshotAtPreflight,
    gasSpentWei: gasSpentWei.toString(),
    gasCapWei: pending.maximumGasWei,
    finalBalances: {
      ethWei: finalEth.toString(),
      spyWei: finalSpy.toString(),
      pairWei: finalPair.toString(),
      usdgAtomic: finalUsdg.toString(),
    },
    protectedPositionInvariants: invariants.map((item) => ({
      tokenId: item.tokenId,
      liquidityAfter: item.liquidity.toString(),
    })),
    policy: {
      burnNft: false,
      swapAssets: false,
      preserveOtherLpLiquidity: true,
      maximumGasUsdg: pending.maximumGasUsdg,
      minimumFinalEthWei: TARGET_RETIRE_MIN_ETH_RESERVE.toString(),
    },
    transactions: pending.transactions,
  }
  if (String(state.position?.tokenId) === pending.tokenId) {
    state.position = {
      ...state.position,
      status: 'retired_manual_empty',
      liquidity: '0',
      retiredAt: completedAt,
      retiredBy: pending.id,
      exit: record,
    }
  } else {
    state.satellites = (state.satellites || []).map((item) =>
      String(item.tokenId) === pending.tokenId
        ? {
            ...item,
            status: 'retired_manual_empty',
            liquidity: '0',
            retiredAt: completedAt,
            retiredBy: pending.id,
            exit: record,
          }
        : item,
    )
  }
  state.retirements = [...(state.retirements || []), record]
  delete state.pendingTargetRetirement
  writeState(state)
  appendAudit('target_retirement_complete', record)
  console.log(
    stringify({
      status: 'TARGET_RETIRED',
      tokenId: pending.tokenId,
      liquidityAfter,
      received: { spy: formatUnits(removedSpyWei, 18), pair: formatUnits(removedPairWei, 18) },
      wallet: {
        eth: formatEther(finalEth),
        spy: formatUnits(finalSpy, 18),
        pair: formatUnits(finalPair, 18),
        usdg: formatUnits(finalUsdg, 6),
      },
      existingPositionsLiquidityUnchanged: true,
      gasSpentEth: formatEther(gasSpentWei),
      transaction: pending.removalTransaction,
    }),
  )
  return record
}

async function continueTargetRetirement(state, pending) {
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  await resolveTargetRetirementUnknown(state, pending)
  if ((pending.failedTransactions || []).length) throw new Error('指定 NFT 撤仓存在失败交易，禁止自动重试')
  if (pending.removalTransaction) return finalizeTargetRetirement(state, pending)
  const [nonceLatest, noncePending, liveEth, liveSpy, livePair, liveUsdg, owner, liquidity, poolState] =
    await Promise.all([
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
      publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
      publicClient.getBalance({ address: WALLET }),
      publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [BigInt(pending.tokenId)],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(pending.tokenId)],
      }),
      getPoolState(),
    ])
  if (nonceLatest !== noncePending)
    throw new Error(`指定 NFT 撤仓执行前存在 pending nonce：latest=${nonceLatest}, pending=${noncePending}`)
  if (liveEth < TARGET_RETIRE_MIN_ETH_RESERVE) throw new Error('指定 NFT 撤仓执行前 ETH 低于储备线')
  if (
    liveSpy !== BigInt(pending.initialSpyWei) ||
    livePair !== BigInt(pending.initialPairWei) ||
    liveUsdg !== BigInt(pending.initialUsdgAtomic)
  ) {
    throw new Error('指定 NFT 撤仓预检后钱包代币余额发生变化')
  }
  if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`待撤 NFT ${pending.tokenId} 所有权发生变化`)
  if (liquidity !== BigInt(pending.liquidity)) throw new Error(`待撤 NFT ${pending.tokenId} liquidity 发生变化`)
  await readTargetRetirementProtectedInvariants(pending)
  const removal = buildFullRemove(pending, liquidity, poolState)
  pending.removalPlan = {
    principalSpyWei: removal.amount0Principal.toString(),
    principalPairWei: removal.amount1Principal.toString(),
    poolTick: poolState.tick,
  }
  pending.currentStep = 'remove'
  pending.status = 'remove_prepared'
  writeState(state)
  const result = await targetRetirementSend(state, pending, walletClient, {
    label: `指定撤出 NFT ${pending.tokenId} 全部流动性并领取费用 (${pending.id})`,
    to: POSITION_MANAGER,
    data: removal.data,
  })
  pending.removalTransaction = result.hash
  pending.status = 'remove_confirmed'
  writeState(state)
  return finalizeTargetRetirement(state, pending)
}

function markTargetRetirementPartial(operationId, error) {
  const state = readState()
  const pending = state?.pendingTargetRetirement
  if (!pending || pending.id !== operationId) return
  const message = error.shortMessage || error.message
  const hash = String(message).match(/0x[0-9a-fA-F]{64}/)?.[0]
  if (hash && String(message).includes('回执未知'))
    pending.unknownTransaction = { hash, step: pending.currentStep || 'unknown' }
  if (hash && String(message).includes('链上回执失败')) {
    pending.failedTransactions = [...new Set([...(pending.failedTransactions || []), hash])]
    pending.failedStep = pending.currentStep || 'unknown'
  }
  const hasChainActivity = Boolean(
    (pending.transactions || []).length || pending.unknownTransaction || (pending.failedTransactions || []).length,
  )
  if (!hasChainActivity) delete state.pendingTargetRetirement
  else {
    pending.status = 'partial'
    pending.lastErrorAt = new Date().toISOString()
    pending.lastError = message
  }
  writeState(state)
  appendAudit('target_retirement_partial', {
    id: operationId,
    message,
    currentStep: pending.currentStep || null,
    transactions: pending.transactions || [],
    failedTransactions: pending.failedTransactions || [],
    unknownTransaction: pending.unknownTransaction || null,
  })
}

async function targetRetirementEnter() {
  const state = readState()
  if (state?.pendingTargetRetirement) return continueTargetRetirement(state, state.pendingTargetRetirement)
  const check = await targetRetirementPreflight({ print: true, requireReady: true })
  const id = `target-retirement-${TARGET_RETIRE_TOKEN_ID}-${new Date().toISOString().replace(/[-:.]/g, '')}`
  check.state.pendingTargetRetirement = {
    id,
    status: 'planned',
    createdAt: new Date().toISOString(),
    preflightBlock: check.blockNumber.toString(),
    tokenId: TARGET_RETIRE_TOKEN_ID,
    tickLower: check.target.tickLower,
    tickUpper: check.target.tickUpper,
    liquidity: String(check.target.liquidity),
    initialEthWei: check.ethBalance.toString(),
    initialSpyWei: check.spyBalance.toString(),
    initialPairWei: check.pairBalance.toString(),
    initialUsdgAtomic: check.usdgBalance.toString(),
    maximumGasWei: check.maximumGasWei.toString(),
    maximumGasUsdg: check.report.gas.maximumGasUsdg,
    accruedFeesAtPreflight: { spyWei: check.fees.spyWei.toString(), pairWei: check.fees.pairWei.toString() },
    priceSnapshotAtPreflight: {
      blockNumber: check.blockNumber.toString(),
      tick: check.poolState.tick,
      spyUsdg: check.report.pool.currentSpyPriceUsdg,
      pairUsdg: check.report.pool.currentPairPriceUsdg,
      quality: 'operation_preflight',
    },
    protectedPositions: check.protectedReads.map((item) => ({
      tokenId: item.tokenId,
      liquidity: item.liquidity.toString(),
    })),
    transactions: [],
    failedTransactions: [],
  }
  writeState(check.state)
  appendAudit('target_retirement_plan_created', check.state.pendingTargetRetirement)
  try {
    return await continueTargetRetirement(check.state, check.state.pendingTargetRetirement)
  } catch (error) {
    markTargetRetirementPartial(id, error)
    throw error
  }
}

async function targetRetirementResume() {
  const state = readState()
  const pending = state?.pendingTargetRetirement
  if (!state || state.status !== 'active' || !pending) throw new Error('没有可恢复的指定 NFT 撤仓计划')
  try {
    return await continueTargetRetirement(state, pending)
  } catch (error) {
    markTargetRetirementPartial(pending.id, error)
    throw error
  }
}

async function targetRetirementStatus() {
  const state = readState()
  const pending = state?.pendingTargetRetirement || null
  const latest = state?.retirements?.filter((item) => String(item.tokenId) === TARGET_RETIRE_TOKEN_ID).at(-1) || null
  const [eth, spy, pair, usdg, liquidity, owner, nonceLatest, noncePending] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(TARGET_RETIRE_TOKEN_ID)],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [BigInt(TARGET_RETIRE_TOKEN_ID)],
    }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  console.log(
    stringify({
      status: pending ? pending.status : latest ? latest.status : 'NOT_STARTED',
      wallet: WALLET,
      tokenId: TARGET_RETIRE_TOKEN_ID,
      owner,
      liquidity,
      nonceLatest,
      noncePending,
      balances: {
        eth: formatEther(eth),
        spy: formatUnits(spy, 18),
        pair: formatUnits(pair, 18),
        usdg: formatUnits(usdg, 6),
      },
      pending,
      latest,
    }),
  )
}

async function status() {
  const state = readState()
  const [ethBalance, spyBalance, pairBalance, poolState] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    getPoolState(),
  ])
  if (!state) {
    console.log(
      stringify({
        status: 'NOT_ENTERED',
        wallet: WALLET,
        eth: formatEther(ethBalance),
        spy: formatUnits(spyBalance, 18),
        pair: formatUnits(pairBalance, 18),
        poolTick: poolState.tick,
      }),
    )
    return
  }
  let liquidity = 0n
  if (state.position?.tokenId) {
    try {
      liquidity = await publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(state.position.tokenId)],
      })
    } catch {
      liquidity = 0n
    }
  }
  const inRange = state.position
    ? poolState.tick >= state.position.tickLower && poolState.tick < state.position.tickUpper
    : null
  const due = state.exitDueAt ? Date.now() >= Date.parse(state.exitDueAt) : false
  let underlying = null
  if (liquidity > 0n && state.position) {
    const pool = makePool(poolState)
    const position = new Position({
      pool,
      liquidity: liquidity.toString(),
      tickLower: state.position.tickLower,
      tickUpper: state.position.tickUpper,
    })
    underlying = { spyWei: position.amount0.quotient.toString(), pairWei: position.amount1.quotient.toString() }
  }
  const satellites = []
  for (const record of (state.satellites || []).filter((item) => item.status === 'active')) {
    try {
      const tokenId = BigInt(record.tokenId)
      const [owner, satelliteLiquidity, fees] = await Promise.all([
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
        getAccruedFees(tokenId, record.tickLower, record.tickUpper),
      ])
      const satellitePosition =
        satelliteLiquidity > 0n
          ? new Position({
              pool: makePool(poolState),
              liquidity: satelliteLiquidity.toString(),
              tickLower: record.tickLower,
              tickUpper: record.tickUpper,
            })
          : null
      satellites.push({
        tokenId: record.tokenId,
        owner,
        liquidity: satelliteLiquidity,
        tickLower: record.tickLower,
        tickUpper: record.tickUpper,
        inRange: poolState.tick >= record.tickLower && poolState.tick < record.tickUpper,
        underlying: satellitePosition
          ? {
              spy: formatUnits(asBigInt(satellitePosition.amount0.quotient), 18),
              pair: formatUnits(asBigInt(satellitePosition.amount1.quotient), 18),
            }
          : null,
        accruedFees: { spy: formatUnits(fees.spyWei, 18), pair: formatUnits(fees.pairWei, 18) },
      })
    } catch (error) {
      satellites.push({ tokenId: record.tokenId, readbackError: error.shortMessage || error.message })
    }
  }
  console.log(
    stringify({
      status: state.status,
      wallet: WALLET,
      tokenId: state.position?.tokenId,
      positionStatus: state.position?.status || 'active',
      liquidity,
      poolTick: poolState.tick,
      tickLower: state.position?.tickLower,
      tickUpper: state.position?.tickUpper,
      inRange,
      due,
      exitDueAt: state.exitDueAt,
      walletBalances: {
        eth: formatEther(ethBalance),
        spy: formatUnits(spyBalance, 18),
        pair: formatUnits(pairBalance, 18),
      },
      underlying,
      satellites,
      pendingSatellite: state.pendingSatellite || null,
      pendingMigration: state.pendingMigration || null,
      pendingUpperRange: state.pendingUpperRange || null,
      pendingFeeBand: state.pendingFeeBand || null,
      pendingAttackRoll: state.pendingAttackRoll || null,
      pendingAttackCompound: state.pendingAttackCompound || null,
      pendingAttackResidual: state.pendingAttackResidual || null,
      pendingMainRoll: state.pendingMainRoll || null,
      pendingRollResidual: state.pendingRollResidual || null,
      pendingCurrentBand: state.pendingCurrentBand || null,
      pendingHighBandRoll: state.pendingHighBandRoll || null,
      pendingUpperExtension: state.pendingUpperExtension || null,
      pendingTargetRetirement: state.pendingTargetRetirement || null,
    }),
  )
}

async function exitPosition() {
  const state = readState()
  if (!state) throw new Error('没有本地建仓收据')
  if (state.status === 'exited') {
    console.log(stringify({ status: 'ALREADY_EXITED', exit: state.exit }))
    return
  }
  if (state.status !== 'active') throw new Error(`当前状态不能退出：${state.status}`)
  if (state.pendingSatellite) throw new Error(`存在未结算的卫星仓计划：${state.pendingSatellite.id}，禁止退出主仓`)
  if (state.pendingMigration) throw new Error(`存在未结算的迁移计划：${state.pendingMigration.id}，禁止退出主仓`)
  if (state.pendingUpperRange) throw new Error(`存在未结算的新区间计划：${state.pendingUpperRange.id}，禁止退出主仓`)
  if (state.pendingFeeBand) throw new Error(`存在未结算的手续费新区间计划：${state.pendingFeeBand.id}，禁止退出主仓`)
  if (state.pendingAttackRoll)
    throw new Error(`存在未结算的进攻仓迁移计划：${state.pendingAttackRoll.id}，禁止退出主仓`)
  if (state.pendingAttackCompound)
    throw new Error(`存在未结算的进攻仓手续费复投计划：${state.pendingAttackCompound.id}，禁止退出主仓`)
  if (state.pendingAttackResidual)
    throw new Error(`存在未结算的进攻仓手续费残余追加计划：${state.pendingAttackResidual.compoundId}，禁止退出主仓`)
  if (state.pendingMainRoll) throw new Error(`存在未结算的主仓迁移计划：${state.pendingMainRoll.id}，禁止退出主仓`)
  if (state.pendingCurrentBand)
    throw new Error(`存在未结算的当前热区仓计划：${state.pendingCurrentBand.id}，禁止退出主仓`)
  if (state.pendingHighBandRoll)
    throw new Error(`存在未结算的高位续航计划：${state.pendingHighBandRoll.id}，禁止退出主仓`)
  if (state.pendingUpperExtension)
    throw new Error(`存在未结算的高位接力仓计划：${state.pendingUpperExtension.id}，禁止退出主仓`)
  if (state.pendingTargetRetirement)
    throw new Error(`存在未结算的指定撤仓计划：${state.pendingTargetRetirement.id}，禁止退出主仓`)
  const tokenId = BigInt(state.position.tokenId)
  const [owner, liquidity, poolState] = await Promise.all([
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
    getPoolState(),
  ])
  if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`LP NFT 不在执行钱包：owner=${owner}`)
  if (liquidity === 0n) throw new Error('LP 流动性已经为 0，但本地状态尚未结算；需人工审计')
  const pool = makePool(poolState)
  const position = new Position({
    pool,
    liquidity: liquidity.toString(),
    tickLower: state.position.tickLower,
    tickUpper: state.position.tickUpper,
  })
  const deadline = BigInt(nowSeconds() + 5 * 60)
  const method = V4PositionManager.removeCallParameters(position, {
    tokenId: tokenId.toString(),
    liquidityPercentage: new Percent(1, 1),
    burnToken: false,
    slippageTolerance: EXIT_SLIPPAGE,
    deadline: deadline.toString(),
    hookData: '0x',
  })
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  const [spyBefore, pairBefore] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
  ])
  const result = await sendChecked(walletClient, {
    label: '撤出全部 PAIR/SPY 流动性并领取费用',
    to: POSITION_MANAGER,
    data: method.calldata,
    minimumBalanceAfter: 0n,
  })
  const [liquidityAfter, spyAfter, pairAfter, ethAfter] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.getBalance({ address: WALLET }),
  ])
  if (liquidityAfter !== 0n) throw new Error(`退出交易成功但 LP liquidity=${liquidityAfter}`)
  state.status = 'exited'
  state.exit = {
    reason:
      Date.now() >= Date.parse(state.exitDueAt)
        ? '24h_due'
        : poolState.tick < state.position.tickLower || poolState.tick >= state.position.tickUpper
          ? 'out_of_range'
          : 'manual',
    transaction: result.hash,
    blockNumber: result.receipt.blockNumber.toString(),
    exitedAt: new Date().toISOString(),
    gasSpentWei: result.gasCost.toString(),
    collectedSpyWei: (spyAfter - spyBefore).toString(),
    collectedPairWei: (pairAfter - pairBefore).toString(),
    finalBalances: { ethWei: ethAfter.toString(), spyWei: spyAfter.toString(), pairWei: pairAfter.toString() },
  }
  writeState(state)
  appendAudit('exit_complete', state.exit)
  console.log(
    stringify({
      status: 'EXITED',
      reason: state.exit.reason,
      transaction: result.hash,
      collectedSpy: formatUnits(spyAfter - spyBefore, 18),
      collectedPair: formatUnits(pairAfter - pairBefore, 18),
      finalEth: formatEther(ethAfter),
      finalSpy: formatUnits(spyAfter, 18),
      finalPair: formatUnits(pairAfter, 18),
    }),
  )
}

async function main() {
  const command = process.argv[2] || 'preflight'
  if (command === 'preflight') return preflight()
  if (command === 'enter') return enter()
  if (command === 'resume') return resumeMint()
  if (command === 'increase-preflight') return increasePreflight()
  if (command === 'increase') return increasePosition()
  if (command === 'satellite-preflight') return satellitePreflight()
  if (command === 'satellite-enter') return satelliteEnter()
  if (command === 'migration-preflight') return migrationPreflight()
  if (command === 'migration-enter') return migrationEnter()
  if (command === 'upper-range-preflight') return upperRangePreflight()
  if (command === 'upper-range-enter') return upperRangeEnter()
  if (command === 'upper-range-resume') return upperRangeResume()
  if (command === 'fee-band-preflight') return feeBandPreflight()
  if (command === 'fee-band-enter') return feeBandEnter()
  if (command === 'fee-band-resume') return feeBandResume()
  if (command === 'attack-roll-preflight') return attackRollPreflight()
  if (command === 'attack-roll-enter') return attackRollEnter()
  if (command === 'attack-roll-resume') return attackRollResume()
  if (command === 'main-roll-preflight') return mainRollPreflight()
  if (command === 'main-roll-enter') return mainRollEnter()
  if (command === 'main-roll-resume') return mainRollResume()
  if (command === 'attack-compound-preflight') return attackCompoundPreflight()
  if (command === 'attack-compound-enter') return attackCompoundEnter()
  if (command === 'attack-compound-resume') return attackCompoundResume()
  if (command === 'attack-compound-residual') return attackResidualSweepEnter()
  if (command === 'attack-compound-residual-resume') return attackResidualSweepResume()
  if (command === 'roll-residual-preflight') return rollResidualSweepPreflight()
  if (command === 'roll-residual-enter') return rollResidualSweepEnter()
  if (command === 'roll-residual-resume') return rollResidualSweepResume()
  if (command === 'current-band-preflight') return currentBandPreflight()
  if (command === 'current-band-enter') return currentBandEnter()
  if (command === 'current-band-resume') return currentBandResume()
  if (command === 'current-band-status') return currentBandStatus()
  if (command === 'high-band-roll-preflight') return highBandRollPreflight()
  if (command === 'high-band-roll-enter') return highBandRollEnter()
  if (command === 'high-band-roll-resume') return highBandRollResume()
  if (command === 'high-band-roll-status') return highBandRollStatus()
  if (command === 'upper-extension-preflight') return upperExtensionPreflight()
  if (command === 'upper-extension-enter') return upperExtensionEnter()
  if (command === 'upper-extension-resume') return upperExtensionResume()
  if (command === 'upper-extension-status') return upperExtensionStatus()
  if (command === 'target-retirement-preflight') return targetRetirementPreflight()
  if (command === 'target-retirement-enter') return targetRetirementEnter()
  if (command === 'target-retirement-resume') return targetRetirementResume()
  if (command === 'target-retirement-status') return targetRetirementStatus()
  if (command === 'status') return status()
  if (command === 'exit') return exitPosition()
  throw new Error(`未知命令：${command}`)
}

main().catch((error) => {
  appendAudit('command_failed', {
    command: process.argv[2] || 'preflight',
    message: error.shortMessage || error.message,
  })
  console.error(`ERROR: ${error.shortMessage || error.message}`)
  process.exitCode = 1
})
