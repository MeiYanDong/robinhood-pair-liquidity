import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const runDir = path.join(root, 'runs')
const watchStatePath = path.join(runDir, 'pair-usdg-narrow-watch.json')
const watchAuditPath = path.join(runDir, 'pair-usdg-narrow-watch.jsonl')
const entryStatePath = path.join(runDir, 'pair-usdg-narrow-live-one.json')
const executorPath = path.join(root, 'scripts', 'pair-usdg-narrow.mjs')
const nodePath = process.execPath
const rpcUrl = process.env.RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const dashboardUrl = process.env.PAIR_DASHBOARD_URL || 'http://47.251.187.250/api/snapshot?window=6h'
const pollMs = Math.max(15_000, Number(process.env.PAIR_USDG_WATCH_POLL_MS || 20_000))
const quickSafeGasUnits = 1_700_000
const sendGasMultiplier = 1.1

function stringify(value) {
  return JSON.stringify(value, null, 2)
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeState(state) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const temporary = `${watchStatePath}.tmp`
  fs.writeFileSync(temporary, `${stringify(state)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, watchStatePath)
  fs.chmodSync(watchStatePath, 0o600)
}

function audit(event, details = {}) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  fs.appendFileSync(watchAuditPath, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`, {
    mode: 0o600,
  })
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  return response.json()
}

async function gasPriceWei() {
  const payload = await fetchJson(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }),
  })
  if (!payload.result) throw new Error('eth_gasPrice 没有返回 result')
  return BigInt(payload.result)
}

function selectRange(row) {
  const analysis = row?.rangeAnalysis
  if (!analysis?.recommendation) return null
  const bestScore = Number(analysis.recommendation.score)
  const candidates = [analysis.recommendation, ...(analysis.alternatives || [])]
  const qualified = candidates.filter((candidate) => {
    const oneHour = candidate.metrics?.['1h']
    const sixHours = candidate.metrics?.['6h']
    return (
      Number(candidate.score) >= bestScore * 0.95 &&
      Number(candidate.rangePositionPct) >= 20 &&
      Number(candidate.rangePositionPct) <= 72.5 &&
      Number(oneHour?.volumeCoveragePct || 0) >= 70 &&
      Number(sixHours?.volumeCoveragePct || 0) >= 75 &&
      Number(sixHours?.feeWeightedMarketSharePct || 0) > 0
    )
  })
  qualified.sort((left, right) => Number(right.score) - Number(left.score))
  return qualified[0] || null
}

function executor(command, range, state) {
  const env = {
    ...process.env,
    PAIR_USDG_TICK_LOWER: String(range.tickLower),
    PAIR_USDG_TICK_UPPER: String(range.tickUpper),
    PAIR_USDG_PRINCIPAL_ETH: state.principalEth,
    PAIR_USDG_MAX_GAS_USDG: state.maximumGasUsdg,
  }
  const result = spawnSync(nodePath, [executorPath, command], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 20 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function parseExecutorReport(output) {
  const start = output.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(output.slice(start))
  } catch {
    return null
  }
}

function arm() {
  const existingEntry = readJson(entryStatePath)
  if (existingEntry && existingEntry.status !== 'exited')
    throw new Error(`PAIR/USDG 执行账本已存在：${existingEntry.status}`)
  const now = Date.now()
  const state = {
    schemaVersion: 1,
    status: 'armed',
    armedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    wallet: '0xe864237f450E3C813EB6C5652106EC3AFd9Bc919',
    poolId: '0x97f48c8d9639b7940874b6c6a43b3d606d070a694920b545acff9c35926593a6',
    principalEth: '0.04',
    maximumGasUsdg: '5',
    policy: {
      oneShot: true,
      rangeSource: 'live dashboard PAIR/USDG 1% tick volume plus current market-liquidity share',
      maximumSnapshotAgeSeconds: 75,
      noAutoExit: true,
      preserveExistingWalletUsdg: true,
      preserveExistingWalletPair: true,
    },
    lastCheck: null,
    selectedRange: null,
    execution: null,
  }
  writeState(state)
  audit('armed', state)
  console.log(stringify(state))
}

function disarm() {
  const state = readJson(watchStatePath)
  if (!state) throw new Error('没有 watcher 状态')
  state.status = 'disarmed'
  state.disarmedAt = new Date().toISOString()
  writeState(state)
  audit('disarmed')
  console.log(stringify(state))
}

function status() {
  console.log(stringify({ watcher: readJson(watchStatePath), entry: readJson(entryStatePath) }))
}

async function watch() {
  let consecutiveFailures = 0
  while (true) {
    const state = readJson(watchStatePath)
    if (!state || state.status !== 'armed') return
    if (Date.now() >= Date.parse(state.expiresAt)) {
      state.status = 'expired'
      state.expiredAt = new Date().toISOString()
      writeState(state)
      audit('expired')
      return
    }
    const entry = readJson(entryStatePath)
    if (entry?.status === 'active') {
      state.status = 'completed'
      state.completedAt = new Date().toISOString()
      state.execution = { operationId: entry.operationId, tokenId: entry.position?.tokenId || null }
      writeState(state)
      audit('completed', state.execution)
      return
    }
    try {
      const [snapshot, gasWei] = await Promise.all([fetchJson(dashboardUrl), gasPriceWei()])
      const row = snapshot.comparison?.rows?.find((item) => item.id === 'pair-usdg-1')
      const liveRange = selectRange(row)
      const persistedRange =
        entry && entry.status !== 'exited' && entry.target
          ? {
              tickLower: Number(entry.target.tickLower),
              tickUpper: Number(entry.target.tickUpper),
              priceLowUsdg: Number(entry.target.executablePriceLowUsdg),
              priceHighUsdg: Number(entry.target.executablePriceHighUsdg),
              rangePositionPct: null,
              score: null,
              metrics: null,
            }
          : null
      const range = persistedRange || liveRange
      const ageSeconds = Number(snapshot.runtime?.ageSeconds)
      const ethUsdg = Number(snapshot.comparison?.migrationEstimate?.ethQuote?.ethUsdg)
      if (
        snapshot.runtime?.status !== 'LIVE' ||
        !Number.isFinite(ageSeconds) ||
        ageSeconds > state.policy.maximumSnapshotAgeSeconds
      ) {
        throw new Error(`面板快照不够新鲜：status=${snapshot.runtime?.status}, age=${ageSeconds}`)
      }
      if (!range) throw new Error('没有同时通过成交覆盖、市场份额和价格安全位的区间')
      if (!Number.isFinite(ethUsdg) || ethUsdg <= 0) throw new Error('ETH/USDG 实时报价不可用')
      const quickGasUsdg = (Number(gasWei) / 1e18) * quickSafeGasUnits * sendGasMultiplier * ethUsdg
      state.lastCheck = {
        at: new Date().toISOString(),
        blockNumber: snapshot.pool?.blockNumber || null,
        snapshotAgeSeconds: ageSeconds,
        gasPriceGwei: Number(gasWei) / 1e9,
        quickFullWorkflowGasUsdg: quickGasUsdg,
        pairUsdg: row.pairUsdg,
      }
      state.selectedRange = {
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        priceLowUsdg: range.priceLowUsdg,
        priceHighUsdg: range.priceHighUsdg,
        rangePositionPct: range.rangePositionPct,
        score: range.score,
        metrics: range.metrics,
      }
      writeState(state)
      consecutiveFailures = 0
      if (quickGasUsdg > Number(state.maximumGasUsdg)) {
        await delay(pollMs)
        continue
      }

      audit('gas_candidate', { lastCheck: state.lastCheck, selectedRange: state.selectedRange, resume: Boolean(entry) })
      let report = null
      if (!entry) {
        const preflight = executor('preflight', range, state)
        report = parseExecutorReport(preflight.stdout)
        state.lastPreflight = {
          at: new Date().toISOString(),
          ok: preflight.ok,
          status: report?.status || null,
          gas: report?.gas || null,
          error: preflight.ok ? null : preflight.stderr.trim().slice(-1_000),
        }
        writeState(state)
        audit('preflight', state.lastPreflight)
        if (!preflight.ok || report?.status !== 'READY') {
          await delay(pollMs)
          continue
        }
      } else {
        const originalMaximumGasPriceWei = BigInt(entry.gasPolicy?.maximumGasPriceWei || 0)
        if (originalMaximumGasPriceWei <= 0n || gasWei > originalMaximumGasPriceWei) {
          await delay(pollMs)
          continue
        }
        report = { gas: { resumedUnderOriginalGasPolicy: true } }
      }

      state.execution = { startedAt: new Date().toISOString(), command: entry ? 'resume' : 'enter' }
      writeState(state)
      audit('execution_started', { execution: state.execution, range: state.selectedRange, gas: report.gas })
      const result = executor(entry ? 'resume' : 'enter', range, state)
      const refreshedEntry = readJson(entryStatePath)
      state.execution.finishedAt = new Date().toISOString()
      state.execution.ok = result.ok
      state.execution.entryStatus = refreshedEntry?.status || null
      state.execution.output = result.stdout.trim().slice(-12_000)
      state.execution.error = result.stderr.trim().slice(-4_000)
      if (result.ok && refreshedEntry?.status === 'active') {
        state.status = 'completed'
        state.completedAt = new Date().toISOString()
        state.execution.operationId = refreshedEntry.operationId
        state.execution.tokenId = refreshedEntry.position?.tokenId || null
        writeState(state)
        audit('completed', state.execution)
        return
      }
      const retryable = /等待 Gas|RPC|timeout|timed out|回执.*未知|network|HTTP/iu.test(
        refreshedEntry?.lastError || result.stderr,
      )
      if (!retryable) {
        state.status = 'attention'
        writeState(state)
        audit('attention_required', state.execution)
        return
      }
      writeState(state)
      audit('retryable_partial', state.execution)
    } catch (error) {
      consecutiveFailures += 1
      state.lastError = { at: new Date().toISOString(), message: error.message, consecutiveFailures }
      writeState(state)
      audit('check_failed', state.lastError)
      await delay(Math.min(120_000, pollMs * Math.max(1, consecutiveFailures)))
      continue
    }
    await delay(pollMs)
  }
}

const command = process.argv[2] || 'status'
if (command === 'arm') arm()
else if (command === 'disarm') disarm()
else if (command === 'status') status()
else if (command === 'watch') await watch()
else throw new Error(`未知命令：${command}`)
