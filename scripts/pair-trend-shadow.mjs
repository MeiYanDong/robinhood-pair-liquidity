import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createPublicClient, defineChain, getAddress, http, keccak256, parseAbi } from 'viem'
import { evaluateTrendDecision } from '../lib/trend-lp-policy.mjs'
import { advanceTrendSequence } from '../lib/trend-lp-sequence.mjs'
import { deriveFlowSignals, selectUpwardRange } from '../lib/trend-lp-signals.mjs'

const require = createRequire(import.meta.url)
const { Pool, Position, V4PositionManager } = require('@uniswap/v4-sdk')
const { Percent, Token } = require('@uniswap/sdk-core')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = path.join(ROOT, 'dashboard', 'config', 'pair-spy.json')
const LEDGER_PATH = path.join(ROOT, 'dashboard', 'config', 'lp-portfolio-ledger.json')
const SCENARIOS_PATH = path.join(ROOT, 'test', 'fixtures', 'trend-lp-breakout-scenarios.json')
const HISTORY_PATH = path.join(ROOT, 'runs', 'pair-dashboard', 'history.sqlite')
const DECISION_LEDGER_PATH = path.join(ROOT, 'runs', 'pair-trend-shadow-decisions.jsonl')
const SEQUENCE_STATE_PATH = path.join(ROOT, 'runs', 'pair-trend-shadow-state.json')
const SCENARIO_REPORT_PATH = path.join(ROOT, 'reports', 'trend-lp-shadow-scenarios-latest.json')
const HISTORY_REPORT_PATH = path.join(ROOT, 'reports', 'trend-lp-shadow-history-latest.json')
const LIVE_REPORT_PATH = path.join(ROOT, 'reports', 'trend-lp-shadow-live-latest.json')
const SERIES_REPORT_PATH = path.join(ROOT, 'reports', 'trend-lp-shadow-series-latest.json')
const DEFAULT_DASHBOARD_URL = 'http://47.251.187.250'
const MULTICALL3 = getAddress('0xcA11bde05977b3631167028862bE2a173976CA11')
const UNIVERSAL_ROUTER = getAddress('0x8876789976dEcBfCbBbe364623C63652db8C0904')

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
])
const POSITION_MANAGER_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
])
const V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
])

function stringify(value, indentation = 2) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), indentation)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) return { value: null, error: null }
  try {
    return { value: readJson(filePath), error: null }
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${stringify(value)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, filePath)
}

function appendDecision(value) {
  fs.mkdirSync(path.dirname(DECISION_LEDGER_PATH), { recursive: true })
  fs.appendFileSync(DECISION_LEDGER_PATH, `${stringify(value, 0)}\n`, { mode: 0o600 })
}

function hasFlag(name) {
  return process.argv.slice(3).includes(name)
}

function numericFlag(name, fallback) {
  const prefix = `${name}=`
  const raw = process.argv.slice(3).find((argument) => argument.startsWith(prefix))
  if (!raw) return fallback
  const value = Number(raw.slice(prefix.length))
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be numeric`)
  return value
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function scenarioBaseObservation() {
  return {
    portfolioComplete: true,
    snapshotFresh: true,
    rpcConsistent: true,
    receiptUnknown: false,
    pendingNonce: false,
    cooldownActive: false,
    nearUpper: false,
    crossedUpper: true,
    breakoutPct: 1.2,
    confirmationBlocks: 3,
    secondsAboveUpper: 60,
    volumeMultiple: 1.7,
    netBuySharePct: 60,
    activeCoverageLossPct: 55,
    existingHigherBandCoverage: false,
    targetQualified: true,
    skippedBands: 0,
    reversalConfirmed: false,
    gasUsdg: 3,
    frictionUsdg: 1,
    exitPriceImpactPct: 0,
    withdrawGasUsdg: 0,
  }
}

function activePairSpyPositions(ledger) {
  return ledger.positions
    .filter((position) => position.poolKind === 'pair-spy' && BigInt(position.lastKnownLiquidity || 0) > 0n)
    .map((position) => ({
      tokenId: String(position.tokenId),
      tickLower: Number(position.tickLower),
      tickUpper: Number(position.tickUpper),
      ledgerLiquidity: String(position.lastKnownLiquidity),
      ledgerStatus: position.lastKnownStatus,
    }))
}

function pairPriceAtTick(spyUsdg, tick) {
  return spyUsdg / Math.pow(1.0001, tick)
}

function v3HumanPriceFromSqrt(sqrtPriceX96, token0Decimals = 18, token1Decimals = 6) {
  const q96 = 2 ** 96
  const rawToken1PerToken0 = Math.pow(Number(sqrtPriceX96) / q96, 2)
  return rawToken1PerToken0 * Math.pow(10, token0Decimals - token1Decimals)
}

function makePairSpyPool(config, slot0, liquidity) {
  const spy = new Token(config.chain.id, getAddress(config.tokens.spy.address), 18, 'SPY', 'Robinhood SPY')
  const pair = new Token(config.chain.id, getAddress(config.tokens.pair.address), 18, 'PAIR', 'PAIR')
  const pool = new Pool(
    spy,
    pair,
    config.pool.fee,
    config.pool.tickSpacing,
    getAddress(config.pool.hooks),
    String(slot0[0]),
    String(liquidity),
    Number(slot0[1]),
  )
  if (pool.poolId.toLowerCase() !== config.pool.poolId.toLowerCase()) {
    throw new Error(`SDK pool id mismatch: expected ${config.pool.poolId}, received ${pool.poolId}`)
  }
  return pool
}

async function probeUnsignedRemoval({ client, wallet, positionManager, pool, position, blockNumber, deadline }) {
  try {
    const sdkPosition = new Position({
      pool,
      liquidity: position.liquidity,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
    })
    const method = V4PositionManager.removeCallParameters(sdkPosition, {
      tokenId: position.tokenId,
      liquidityPercentage: new Percent(1, 1),
      burnToken: false,
      slippageTolerance: new Percent(200, 10_000),
      deadline: String(deadline),
      hookData: '0x',
    })
    const request = {
      account: wallet,
      to: positionManager,
      data: method.calldata,
      value: BigInt(method.value || 0),
    }
    const callResult = await client.call({ ...request, blockNumber })
    let estimatedGas = null
    let estimateError = null
    try {
      estimatedGas = await client.estimateGas(request)
    } catch (error) {
      estimateError = error instanceof Error ? error.message : String(error)
    }
    return {
      tokenId: position.tokenId,
      status: 'ETH_CALL_SUCCEEDED',
      target: positionManager,
      calldata: method.calldata,
      calldataHash: keccak256(method.calldata),
      calldataBytes: (method.calldata.length - 2) / 2,
      valueWei: String(method.value || 0),
      returnData: callResult.data || '0x',
      estimatedGas: estimatedGas === null ? null : String(estimatedGas),
      estimateError,
      blockNumber: String(blockNumber),
      executionAuthorized: false,
    }
  } catch (error) {
    return {
      tokenId: position.tokenId,
      status: 'ETH_CALL_FAILED',
      error: error instanceof Error ? error.message : String(error),
      executionAuthorized: false,
    }
  }
}

function ratioPct(numerator, denominator) {
  if (denominator === 0n) return null
  return (Number(numerator) / Number(denominator)) * 100
}

function sameStringSet(left, right) {
  return [...left].sort().join(',') === [...right].sort().join(',')
}

function recursivelyContains(value, expected) {
  if (value === expected) return true
  if (Array.isArray(value)) return value.some((item) => recursivelyContains(item, expected))
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => recursivelyContains(item, expected))
  }
  return false
}

function localReceiptUncertainty() {
  const runsPath = path.join(ROOT, 'runs')
  if (!fs.existsSync(runsPath)) return { found: false, inspected: [] }
  const files = fs
    .readdirSync(runsPath)
    .filter((name) => /^pair-.*-live.*\.json$/.test(name))
    .sort()
  const uncertain = []
  const inspected = []
  for (const name of files) {
    const filePath = path.join(runsPath, name)
    try {
      const state = readJson(filePath)
      inspected.push(name)
      if (recursivelyContains(state, 'receipt_unknown')) uncertain.push(name)
    } catch {
      uncertain.push(name)
    }
  }
  return { found: uncertain.length > 0, inspected, uncertain }
}

async function safeFetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { value: await response.json(), error: null }
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function requireCall(result, label) {
  if (result.status !== 'success') {
    const message = result.error instanceof Error ? result.error.message : String(result.error)
    throw new Error(`${label} read failed: ${message}`)
  }
  return result.result
}

function observedAtKey(row) {
  return [Number(row.block_number), Number(row.transaction_index), Number(row.log_index)]
}

function compareKeys(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function coverageGaps(positions, minimumTick, maximumTick, spyUsdg) {
  const boundaries = new Set([minimumTick, maximumTick + 1])
  for (const position of positions) {
    boundaries.add(Math.max(minimumTick, position.tickLower))
    boundaries.add(Math.min(maximumTick + 1, position.tickUpper))
  }
  const ordered = [...boundaries].filter((tick) => tick >= minimumTick && tick <= maximumTick + 1).sort((a, b) => a - b)
  const gaps = []
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const tickLower = ordered[index]
    const tickUpper = ordered[index + 1]
    if (tickLower === tickUpper) continue
    const midpoint = Math.floor((tickLower + tickUpper - 1) / 2)
    const covered = positions.some((position) => midpoint >= position.tickLower && midpoint < position.tickUpper)
    if (covered) continue
    const previous = gaps.at(-1)
    if (previous?.tickUpper === tickLower) {
      previous.tickUpper = tickUpper
      previous.priceLowUsdg = pairPriceAtTick(spyUsdg, tickUpper)
      continue
    }
    gaps.push({
      tickLower,
      tickUpper,
      priceLowUsdg: pairPriceAtTick(spyUsdg, tickUpper),
      priceHighUsdg: pairPriceAtTick(spyUsdg, tickLower),
    })
  }
  return gaps
}

function sampleEdges(items, maximum = 200) {
  if (items.length <= maximum) return items
  const half = Math.floor(maximum / 2)
  return [...items.slice(0, half), ...items.slice(-half)]
}

async function runScenarios(write) {
  const scenarios = readJson(SCENARIOS_PATH)
  const rows = scenarios.map((scenario) => {
    const observation = { ...scenarioBaseObservation(), ...scenario.overrides }
    const decision = evaluateTrendDecision(observation)
    return {
      id: scenario.id,
      expectedAction: scenario.expectedAction,
      actualAction: decision.action,
      passed: decision.action === scenario.expectedAction,
      policyAssessment:
        decision.action === scenario.expectedAction ? 'CONFORMS_TO_REVIEWED_POLICY' : 'POLICY_REGRESSION',
      observation,
      decision,
    }
  })
  const failed = rows.filter((row) => !row.passed)
  const actionCounts = Object.fromEntries(
    [...new Set(rows.map((row) => row.actualAction))]
      .sort()
      .map((action) => [action, rows.filter((row) => row.actualAction === action).length]),
  )
  const report = {
    schemaVersion: 1,
    kind: 'trend_lp_scenario_replay',
    generatedAt: new Date().toISOString(),
    evidenceLevel: 'deterministic_fixture_simulation',
    executionAuthorized: false,
    summary: {
      total: rows.length,
      passed: rows.length - failed.length,
      failed: failed.length,
      actionCounts,
    },
    optimalityBoundary: {
      policyOptimal: failed.length === 0,
      globallyOptimal: 'UNKNOWN',
      explanation:
        'Expected actions are optimal only relative to the reviewed constraints; future profitability and globally optimal timing are not proven.',
    },
    rows,
    limitations: [
      'Passing fixtures proves deterministic policy behavior, not future profitability.',
      'Fixtures do not prove transaction construction, inclusion, receipts, or post-state.',
    ],
  }
  if (write) atomicWriteJson(SCENARIO_REPORT_PATH, report)
  process.stdout.write(`${stringify(report)}\n`)
  if (failed.length > 0) process.exitCode = 1
}

async function runHistory(write) {
  const ledger = readJson(LEDGER_PATH)
  const positions = activePairSpyPositions(ledger)
  const database = new DatabaseSync(HISTORY_PATH, { readOnly: true })
  let swaps
  let marks
  try {
    swaps = database
      .prepare(
        `SELECT s.transaction_hash, s.log_index, s.transaction_index, s.block_number,
                s.amount0, s.tick, b.timestamp
           FROM pair_swaps s
           JOIN blocks b ON b.block_number = s.block_number
          ORDER BY s.block_number, s.transaction_index, s.log_index`,
      )
      .all()
    marks = database
      .prepare(
        `SELECT block_number, transaction_index, log_index, spy_usdg
           FROM spy_marks
          ORDER BY block_number, transaction_index, log_index`,
      )
      .all()
  } finally {
    database.close()
  }
  if (swaps.length === 0 || marks.length === 0) throw new Error('history database has no usable swaps or SPY marks')

  let markIndex = 0
  let currentMark = null
  let coveredSwapCount = 0
  let totalVolumeUsdg = 0
  let coveredVolumeUsdg = 0
  let previousSignature = null
  let previousIds = []
  const transitions = []
  let minimumTick = Number.POSITIVE_INFINITY
  let maximumTick = Number.NEGATIVE_INFINITY

  for (const swap of swaps) {
    const swapKey = observedAtKey(swap)
    while (markIndex < marks.length && compareKeys(observedAtKey(marks[markIndex]), swapKey) <= 0) {
      currentMark = marks[markIndex]
      markIndex += 1
    }
    if (!currentMark) currentMark = marks[0]
    const tick = Number(swap.tick)
    minimumTick = Math.min(minimumTick, tick)
    maximumTick = Math.max(maximumTick, tick)
    const activeIds = positions
      .filter((position) => tick >= position.tickLower && tick < position.tickUpper)
      .map((position) => position.tokenId)
      .sort()
    const signature = activeIds.join(',')
    const spyUsdg = Number(currentMark.spy_usdg)
    const volumeUsdg = (Math.abs(Number(swap.amount0)) / 1e18) * spyUsdg
    totalVolumeUsdg += volumeUsdg
    if (activeIds.length > 0) {
      coveredSwapCount += 1
      coveredVolumeUsdg += volumeUsdg
    }
    if (signature !== previousSignature) {
      transitions.push({
        at: new Date(Number(swap.timestamp) * 1000).toISOString(),
        blockNumber: String(swap.block_number),
        tick,
        pairUsdg: pairPriceAtTick(spyUsdg, tick),
        entered: activeIds.filter((id) => !previousIds.includes(id)),
        exited: previousIds.filter((id) => !activeIds.includes(id)),
        activeTokenIds: activeIds,
      })
      previousSignature = signature
      previousIds = activeIds
    }
  }

  const lastSpyUsdg = Number(marks.at(-1).spy_usdg)
  const report = {
    schemaVersion: 1,
    kind: 'counterfactual_current_ladder_history_replay',
    generatedAt: new Date().toISOString(),
    evidenceLevel: 'local_chain_event_history_plus_current_ledger_snapshot',
    executionAuthorized: false,
    classification: {
      portfolioPath: 'counterfactual_current_ladder',
      feeAndPnl: 'not_calculated',
      reason: 'The local database contains market swaps, not a block-by-block historical position ledger.',
    },
    evidence: {
      historyDatabase: path.relative(ROOT, HISTORY_PATH),
      firstBlock: String(swaps[0].block_number),
      lastBlock: String(swaps.at(-1).block_number),
      firstTime: new Date(Number(swaps[0].timestamp) * 1000).toISOString(),
      lastTime: new Date(Number(swaps.at(-1).timestamp) * 1000).toISOString(),
      swapRows: swaps.length,
      portfolioLedgerGeneratedAt: ledger.generatedAt,
      portfolioLedgerSafeBlock: ledger.audit?.safeBlock || null,
      currentLadderTokenIds: positions.map((position) => position.tokenId),
    },
    summary: {
      coveredSwapCount,
      totalSwapCount: swaps.length,
      coveredSwapPct: (coveredSwapCount / swaps.length) * 100,
      coveredVolumeUsdg,
      totalVolumeUsdg,
      coveredVolumePct: totalVolumeUsdg > 0 ? (coveredVolumeUsdg / totalVolumeUsdg) * 100 : null,
      observedTickMinimum: minimumTick,
      observedTickMaximum: maximumTick,
      transitionCount: transitions.length,
    },
    currentLadder: positions,
    uncoveredSegmentsWithinObservedTicks: coverageGaps(positions, minimumTick, maximumTick, lastSpyUsdg),
    transitionSample: sampleEdges(transitions),
    limitations: [
      'This is not the wallet actual historical LP path because old position ownership and liquidity changed during the period.',
      'The swap table does not retain event active-liquidity, so historical market share is not reconstructed here.',
      'No fee, gas, execution friction, impermanent loss, or strategy PnL claim is made.',
    ],
  }
  if (write) atomicWriteJson(HISTORY_REPORT_PATH, report)
  process.stdout.write(`${stringify(report)}\n`)
}

async function runLiveOnce(write, { print = true, sequenceStateOverride } = {}) {
  const config = readJson(CONFIG_PATH)
  const ledger = readJson(LEDGER_PATH)
  const rpcUrl = process.env.RH_RPC_URL || config.chain.defaultRpcUrl
  const dashboardBase = process.env.PAIR_DASHBOARD_URL || DEFAULT_DASHBOARD_URL
  const chain = defineChain({
    id: config.chain.id,
    name: config.chain.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, { retryCount: 2, timeout: 20_000 }),
  })
  const [oneHourDashboardResult, sixHourDashboardResult] = await Promise.all([
    safeFetchJson(`${dashboardBase}/api/snapshot?window=1h`),
    safeFetchJson(`${dashboardBase}/api/snapshot?window=6h`),
  ])
  const positionManager = getAddress(config.contracts.positionManager)
  const stateView = getAddress(config.contracts.stateView)
  const wallet = getAddress(config.wallet)
  const allPositions = ledger.positions.map((position) => ({
    tokenId: String(position.tokenId),
    poolKind: position.poolKind,
    tickLower: Number(position.tickLower),
    tickUpper: Number(position.tickUpper),
    ledgerLiquidity: String(position.lastKnownLiquidity || 0),
  }))
  const [headBlock, nonceLatest, noncePending] = await Promise.all([
    client.getBlockNumber(),
    client.getTransactionCount({ address: wallet, blockTag: 'latest' }),
    client.getTransactionCount({ address: wallet, blockTag: 'pending' }),
  ])
  const block = await client.getBlock({ blockNumber: headBlock })
  const contracts = [
    {
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [config.pool.poolId],
    },
    {
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [config.pool.poolId],
    },
    {
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: 'balanceOf',
      args: [wallet],
    },
    {
      address: getAddress(config.contracts.spyUsdgV3Pool),
      abi: V3_POOL_ABI,
      functionName: 'slot0',
    },
    ...allPositions.flatMap((position) => [
      {
        address: positionManager,
        abi: POSITION_MANAGER_ABI,
        functionName: 'ownerOf',
        args: [BigInt(position.tokenId)],
      },
      {
        address: positionManager,
        abi: POSITION_MANAGER_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(position.tokenId)],
      },
    ]),
  ]
  const [calls, positionManagerCode, routerCode] = await Promise.all([
    client.multicall({
      contracts,
      allowFailure: true,
      blockNumber: headBlock,
      multicallAddress: MULTICALL3,
    }),
    client.getCode({ address: positionManager, blockNumber: headBlock }),
    client.getCode({ address: UNIVERSAL_ROUTER, blockNumber: headBlock }),
  ])
  const slot0 = requireCall(calls[0], 'PAIR/SPY slot0')
  const poolLiquidity = requireCall(calls[1], 'PAIR/SPY active liquidity')
  const walletNftBalance = requireCall(calls[2], 'position NFT balance')
  const spySlot0 = requireCall(calls[3], 'SPY/USDG slot0')
  const currentTick = Number(slot0[1])
  const spyUsdg = v3HumanPriceFromSqrt(spySlot0[0])
  const pairUsdg = pairPriceAtTick(spyUsdg, currentTick)

  const livePositions = allPositions.map((position, index) => {
    const ownerCall = calls[4 + index * 2]
    const liquidityCall = calls[5 + index * 2]
    const owner = ownerCall.status === 'success' ? getAddress(ownerCall.result) : null
    const liquidity = liquidityCall.status === 'success' ? liquidityCall.result : null
    return {
      ...position,
      owner,
      ownerRead: ownerCall.status,
      liquidityRead: liquidityCall.status,
      liquidity: liquidity === null ? null : String(liquidity),
      ownedByWallet: owner?.toLowerCase() === wallet.toLowerCase(),
      inRange:
        position.poolKind === 'pair-spy' &&
        liquidity !== null &&
        liquidity > 0n &&
        currentTick >= position.tickLower &&
        currentTick < position.tickUpper,
      priceLowUsdg: position.poolKind === 'pair-spy' ? pairPriceAtTick(spyUsdg, position.tickUpper) : null,
      priceHighUsdg: position.poolKind === 'pair-spy' ? pairPriceAtTick(spyUsdg, position.tickLower) : null,
    }
  })
  const owned = livePositions.filter((position) => position.ownedByWallet)
  const directPairPositions = livePositions.filter(
    (position) => position.poolKind === 'pair-spy' && position.ownedByWallet && BigInt(position.liquidity || 0) > 0n,
  )
  const inRangePositions = directPairPositions.filter((position) => position.inRange)
  const ourActiveLiquidity = inRangePositions.reduce((total, position) => total + BigInt(position.liquidity || 0), 0n)
  const positionReadsComplete = livePositions.every(
    (position) => position.ownerRead === 'success' && position.liquidityRead === 'success',
  )
  const ledgerIdsAgree = sameStringSet(ledger.audit?.localIds || [], ledger.audit?.chainIds || [])
  const portfolioComplete =
    ledger.audit?.inventoryStatus === 'verified_complete_at_safe_block' &&
    positionReadsComplete &&
    ledgerIdsAgree &&
    BigInt(owned.length) === walletNftBalance
  const receiptState = localReceiptUncertainty()
  const oneHourDashboard = oneHourDashboardResult.value
  const sixHourDashboard = sixHourDashboardResult.value
  const dashboardAges = [oneHourDashboard?.generatedAt, sixHourDashboard?.generatedAt]
    .filter(Boolean)
    .map((generatedAt) => Math.max(0, (Date.now() - Date.parse(generatedAt)) / 1000))
  const dashboardAgeSeconds = dashboardAges.length === 2 ? Math.max(...dashboardAges) : null
  const dashboardTick = Number.isFinite(Number(oneHourDashboard?.pool?.currentTick))
    ? Number(oneHourDashboard.pool.currentTick)
    : null
  const sixHourDashboardTick = Number.isFinite(Number(sixHourDashboard?.pool?.currentTick))
    ? Number(sixHourDashboard.pool.currentTick)
    : null
  const snapshotFresh = dashboardAgeSeconds !== null && dashboardAgeSeconds <= 180
  const rpcConsistent =
    dashboardTick !== null &&
    sixHourDashboardTick !== null &&
    Math.abs(currentTick - dashboardTick) <= Number(config.pool.tickSpacing) * 2 &&
    Math.abs(currentTick - sixHourDashboardTick) <= Number(config.pool.tickSpacing) * 2
  const dashboardIds = (oneHourDashboard?.positions || [])
    .filter((position) => BigInt(position.liquidity || 0) > 0n)
    .map((position) => String(position.tokenId))
    .sort()
  const directIds = directPairPositions.map((position) => position.tokenId).sort()
  const nearestUpsideExit =
    inRangePositions
      .map((position) => ({
        tokenId: position.tokenId,
        boundaryTick: position.tickLower,
        boundaryPriceUsdg: position.priceHighUsdg,
        distancePct: (Math.pow(1.0001, currentTick - position.tickLower) - 1) * 100,
      }))
      .sort((left, right) => left.distancePct - right.distancePct)[0] || null
  const sdkPool = makePairSpyPool(config, slot0, poolLiquidity)
  const unsignedRemovalProbes = await Promise.all(
    directPairPositions.map((position) =>
      probeUnsignedRemoval({
        client,
        wallet,
        positionManager,
        pool: sdkPool,
        position,
        blockNumber: headBlock,
        deadline: Number(block.timestamp) + 3_600,
      }),
    ),
  )
  const allRemovalCallsSucceeded = unsignedRemovalProbes.every((probe) => probe.status === 'ETH_CALL_SUCCEEDED')
  const flowSignals = deriveFlowSignals({
    oneHourTotals: oneHourDashboard?.windowSummaries?.['1h']?.totals || {},
    sixHourTotals: sixHourDashboard?.windowSummaries?.['6h']?.totals || {},
    spyUsdg,
    pairUsdg,
  })
  const referenceAddedLiquidity = (ourActiveLiquidity * 2_500n) / 10_000n
  const rangeSearch = selectUpwardRange({
    currentTick,
    tickSpacing: Number(config.pool.tickSpacing),
    spyUsdg,
    oneHourBins: oneHourDashboard?.analytics?.bins || [],
    sixHourBins: sixHourDashboard?.analytics?.bins || [],
    referenceAddedLiquidity,
  })
  const targetRange = {
    ...rangeSearch,
    referenceAddedLiquidity: String(referenceAddedLiquidity),
    selected: rangeSearch.selected
      ? {
          ...rangeSearch.selected,
          modeledAddedLiquidity: String(Math.round(rangeSearch.selected.modeledAddedLiquidity)),
          priceLowUsdg: pairPriceAtTick(spyUsdg, rangeSearch.selected.tickUpper),
          priceHighUsdg: pairPriceAtTick(spyUsdg, rangeSearch.selected.tickLower),
        }
      : null,
    candidates: rangeSearch.candidates.map((candidate) => ({
      ...candidate,
      modeledAddedLiquidity: String(Math.round(candidate.modeledAddedLiquidity)),
    })),
  }
  const gasModel = oneHourDashboard?.comparison?.migrationEstimate
  const modeledGasUsdg = Number(gasModel?.gasCostUsdg)
  const modeledFrictionUsdg = Number(gasModel?.swapFrictionUsdg)
  const sequenceStateRead =
    sequenceStateOverride === undefined
      ? readOptionalJson(SEQUENCE_STATE_PATH)
      : { value: sequenceStateOverride, error: null }
  const sequence = advanceTrendSequence({
    state: sequenceStateRead.value,
    poolId: config.pool.poolId,
    trusted: portfolioComplete && snapshotFresh && rpcConsistent,
    sample: {
      observedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
      blockNumber: headBlock,
      currentTick,
      pairUsdg,
      ourActiveLiquidity,
      positions: directPairPositions.map((position) => ({
        tokenId: position.tokenId,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: position.liquidity || '0',
        inRange: position.inRange,
      })),
    },
  })
  const observation = {
    portfolioComplete,
    snapshotFresh,
    rpcConsistent,
    receiptUnknown: receiptState.found,
    pendingNonce: noncePending !== nonceLatest,
    cooldownActive: false,
    nearUpper: nearestUpsideExit !== null && nearestUpsideExit.distancePct <= 3,
    crossedUpper: sequence.signals.crossedUpper,
    breakoutPct: sequence.signals.breakoutPct,
    confirmationBlocks: sequence.signals.confirmationBlocks,
    secondsAboveUpper: sequence.signals.secondsAboveUpper,
    volumeMultiple: flowSignals.volumeMultiple ?? 0,
    netBuySharePct: flowSignals.oneHourPairBuySharePct ?? 0,
    activeCoverageLossPct: sequence.signals.activeCoverageLossPct,
    existingHigherBandCoverage: sequence.signals.existingHigherBandCoverage,
    targetQualified: targetRange.anyQualified,
    skippedBands: sequence.signals.skippedBands,
    reversalConfirmed: false,
    gasUsdg: Number.isFinite(modeledGasUsdg) && modeledGasUsdg >= 0 ? modeledGasUsdg : 0,
    frictionUsdg: Number.isFinite(modeledFrictionUsdg) && modeledFrictionUsdg >= 0 ? modeledFrictionUsdg : 0,
  }
  const decision = evaluateTrendDecision(observation)
  const report = {
    schemaVersion: 1,
    kind: 'trend_lp_live_single_snapshot',
    generatedAt: new Date().toISOString(),
    evidenceLevel: 'same_block_read_only_chain_observation_plus_public_dashboard_cross_check',
    executionAuthorized: false,
    chain: {
      chainId: config.chain.id,
      headBlock: String(headBlock),
      blockHash: block.hash,
      blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
      nonceLatest,
      noncePending,
      pendingNonce: noncePending !== nonceLatest,
    },
    market: {
      poolId: config.pool.poolId,
      currentTick,
      sqrtPriceX96: String(slot0[0]),
      spyUsdg,
      pairUsdg,
      poolActiveLiquidity: String(poolLiquidity),
      ourActiveLiquidity: String(ourActiveLiquidity),
      ourActiveSharePct: ratioPct(ourActiveLiquidity, poolLiquidity),
      nearestUpsideExit,
      flowSignals,
      targetRange,
      gasEvidence: {
        status: gasModel?.status || 'UNKNOWN',
        gasUnits: gasModel?.gasUnits || null,
        gasPriceGwei: gasModel?.gasPriceGwei || null,
        gasCostUsdg: Number.isFinite(modeledGasUsdg) ? modeledGasUsdg : null,
        frictionUsdg: Number.isFinite(modeledFrictionUsdg) ? modeledFrictionUsdg : null,
        usedOnlyAsAnomalyFuse: true,
        feePaybackForecastUsed: false,
      },
    },
    inventory: {
      portfolioComplete,
      walletNftBalance: String(walletNftBalance),
      locallyKnownOwnedCount: owned.length,
      positionReadsComplete,
      ledgerIdsAgree,
      ledgerSafeBlock: ledger.audit?.safeBlock || null,
      nonzeroPairSpyTokenIds: directIds,
      inRangePairSpyTokenIds: inRangePositions.map((position) => position.tokenId),
      positions: livePositions,
    },
    dashboardCrossCheck: {
      urls: {
        oneHour: `${dashboardBase}/api/snapshot?window=1h`,
        sixHour: `${dashboardBase}/api/snapshot?window=6h`,
      },
      fetchErrors: {
        oneHour: oneHourDashboardResult.error,
        sixHour: sixHourDashboardResult.error,
      },
      generatedAt: {
        oneHour: oneHourDashboard?.generatedAt || null,
        sixHour: sixHourDashboard?.generatedAt || null,
      },
      ageSeconds: dashboardAgeSeconds,
      snapshotFresh,
      currentTicks: { oneHour: dashboardTick, sixHour: sixHourDashboardTick },
      rpcConsistent,
      reportedNonzeroTokenIds: dashboardIds,
      directNonzeroTokenIds: directIds,
      inventoryMatches: sameStringSet(dashboardIds, directIds),
      missingFromDashboard: directIds.filter((id) => !dashboardIds.includes(id)),
      extraOnDashboard: dashboardIds.filter((id) => !directIds.includes(id)),
    },
    reconciliation: receiptState,
    sequence: {
      statePath: path.relative(ROOT, SEQUENCE_STATE_PATH),
      stateReadError: sequenceStateRead.error,
      signals: sequence.signals,
      state: sequence.state,
    },
    deployedCodeReadback: {
      positionManager: {
        address: positionManager,
        present: Boolean(positionManagerCode && positionManagerCode !== '0x'),
        codeHash: positionManagerCode && positionManagerCode !== '0x' ? keccak256(positionManagerCode) : null,
      },
      universalRouter: {
        address: UNIVERSAL_ROUTER,
        present: Boolean(routerCode && routerCode !== '0x'),
        codeHash: routerCode && routerCode !== '0x' ? keccak256(routerCode) : null,
      },
      fullRemovalLeg: allRemovalCallsSucceeded ? 'PROVEN_BY_ETH_CALL_AT_RECORDED_BLOCK' : 'PARTIAL_OR_FAILED',
      atomicWithdrawSwapRemint: 'NOT_YET_PROVEN',
      unsignedRemovalProbes,
    },
    observation,
    decision,
    limitations: [
      'A single snapshot cannot confirm a breakout, volume acceleration, order-flow persistence, or reversal.',
      'The decision is advisory only and cannot cause a chain transaction.',
      'Successful full-removal calls prove only the withdrawal leg at the recorded block, not an atomic rebalance and remint path.',
      'Gas is an anomaly fuse only; this policy does not wait for a cheaper normal transaction or forecast fee payback.',
    ],
  }
  if (write) {
    atomicWriteJson(LIVE_REPORT_PATH, report)
    atomicWriteJson(SEQUENCE_STATE_PATH, sequence.state)
    appendDecision({
      generatedAt: report.generatedAt,
      blockNumber: report.chain.headBlock,
      evidenceLevel: report.evidenceLevel,
      observation,
      decision,
      market: {
        currentTick,
        pairUsdg,
        flowSignals,
        targetRange: targetRange.selected,
      },
      sequence: sequence.signals,
      executionAuthorized: false,
    })
  }
  if (print) process.stdout.write(`${stringify(report)}\n`)
  return report
}

async function runSeries(write) {
  const samples = numericFlag('--samples', 3)
  const intervalMs = numericFlag('--interval-ms', 15_000)
  if (!Number.isInteger(samples) || samples < 1 || samples > 30) {
    throw new TypeError('--samples must be an integer from 1 through 30')
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 300_000) {
    throw new TypeError('--interval-ms must be an integer from 0 through 300000')
  }
  const reports = []
  let sequenceState = readOptionalJson(SEQUENCE_STATE_PATH).value
  for (let index = 0; index < samples; index += 1) {
    const sample = await runLiveOnce(write, { print: false, sequenceStateOverride: sequenceState })
    reports.push(sample)
    sequenceState = sample.sequence.state
    if (index + 1 < samples) await wait(intervalMs)
  }
  const first = reports[0]
  const last = reports.at(-1)
  const report = {
    schemaVersion: 1,
    kind: 'trend_lp_bounded_live_series',
    generatedAt: new Date().toISOString(),
    evidenceLevel: 'bounded_read_only_observation_series',
    executionAuthorized: false,
    requested: { samples, intervalMs },
    summary: {
      completedSamples: reports.length,
      distinctBlocks: new Set(reports.map((item) => item.chain.headBlock)).size,
      distinctDashboardSnapshots: new Set(reports.map((item) => item.dashboardCrossCheck.generatedAt.oneHour)).size,
      firstPairUsdg: first.market.pairUsdg,
      lastPairUsdg: last.market.pairUsdg,
      pairMovePct: (last.market.pairUsdg / first.market.pairUsdg - 1) * 100,
      decisions: reports.map((item) => item.decision.action),
      selectedRanges: reports.map((item) => ({
        blockNumber: item.chain.headBlock,
        tickLower: item.market.targetRange.selected?.tickLower ?? null,
        tickUpper: item.market.targetRange.selected?.tickUpper ?? null,
        qualified: item.market.targetRange.anyQualified,
      })),
    },
    samples: reports.map((item) => ({
      generatedAt: item.generatedAt,
      blockNumber: item.chain.headBlock,
      dashboardGeneratedAt: item.dashboardCrossCheck.generatedAt,
      currentTick: item.market.currentTick,
      pairUsdg: item.market.pairUsdg,
      flowSignals: item.market.flowSignals,
      selectedRange: item.market.targetRange.selected,
      sequence: item.sequence.signals,
      decision: item.decision,
    })),
    limitations: [
      'A bounded series collects evidence but does not schedule itself or submit transactions.',
      'Repeated reads of one cached dashboard generation are not independent market confirmations.',
      'Cross-snapshot breakout and reversal state is not yet promoted into executable authority.',
    ],
  }
  if (write) atomicWriteJson(SERIES_REPORT_PATH, report)
  process.stdout.write(`${stringify(report)}\n`)
}

function usage() {
  return 'Usage: node scripts/pair-trend-shadow.mjs <scenarios|history|live-once|series> [--write] [--samples=N] [--interval-ms=N]'
}

async function main() {
  const command = process.argv[2]
  const write = hasFlag('--write')
  if (command === 'scenarios') return runScenarios(write)
  if (command === 'history') return runHistory(write)
  if (command === 'live-once') return runLiveOnce(write)
  if (command === 'series') return runSeries(write)
  throw new Error(usage())
}

main().catch((error) => {
  process.stderr.write(
    `${stringify({ status: 'ERROR', message: error instanceof Error ? error.message : String(error) })}\n`,
  )
  process.exitCode = 1
})
