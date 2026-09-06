import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PairDashboardCollector, safePublicError, snapshotWindow, stringifySnapshot } from './lib/collector.mjs'
import { evaluateRuntimeStatus } from './lib/runtime-status.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PUBLIC_DIR = path.join(HERE, 'public')
const CONFIG_PATH = path.resolve(process.env.PAIR_DASHBOARD_CONFIG || path.join(HERE, 'config', 'pair-spy.json'))
const STATE_DIR = path.resolve(process.env.PAIR_DASHBOARD_STATE_DIR || path.join(ROOT, 'runs', 'pair-dashboard'))
const DB_PATH = path.resolve(process.env.PAIR_DASHBOARD_DB || path.join(STATE_DIR, 'history.sqlite'))
const SNAPSHOT_PATH = path.resolve(process.env.PAIR_DASHBOARD_SNAPSHOT || path.join(STATE_DIR, 'latest.json'))
const PORT = Number(process.env.PAIR_DASHBOARD_PORT || 8080)
const HOST = process.env.PAIR_DASHBOARD_HOST || '127.0.0.1'
const REFRESH_MS = Math.max(5_000, Number(process.env.PAIR_DASHBOARD_REFRESH_MS || 30_000))
// The transport already retries individual RPC requests. Re-running the whole
// snapshot immediately after a public-RPC throttle multiplies load and delays
// recovery, so the default is to preserve the last good snapshot and wait for
// the next scheduled refresh.
const REFRESH_RETRIES = Math.max(0, Math.min(5, Number(process.env.PAIR_DASHBOARD_RETRIES || 0)))

fs.mkdirSync(STATE_DIR, { recursive: true })

const runtime = {
  service: 'pair-liquidity-dashboard',
  status: 'INITIALIZING',
  startedAt: new Date().toISOString(),
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  progress: { phase: 'startup', message: '等待首次链上快照' },
  refreshMs: REFRESH_MS,
  snapshot: null,
}

function loadLastSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return
  try {
    runtime.snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'))
    runtime.status = 'STALE'
    runtime.lastSuccessAt = runtime.snapshot.generatedAt || null
    runtime.progress = { phase: 'startup', message: '已加载上次快照，正在刷新' }
  } catch (error) {
    runtime.lastError = safePublicError(error)
  }
}

function atomicWrite(filePath, contents) {
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, contents, { mode: 0o640 })
  fs.renameSync(temporary, filePath)
}

loadLastSnapshot()

const collector = new PairDashboardCollector({
  configPath: CONFIG_PATH,
  databasePath: DB_PATH,
  rpcUrl: process.env.RH_RPC_URL,
  confirmations: process.env.PAIR_DASHBOARD_CONFIRMATIONS,
  rpcMinimumIntervalMs: process.env.PAIR_DASHBOARD_RPC_MIN_INTERVAL_MS,
  rpcBatchSize: process.env.PAIR_DASHBOARD_RPC_BATCH_SIZE,
  rpcBatchWaitMs: process.env.PAIR_DASHBOARD_RPC_BATCH_WAIT_MS,
  onProgress(progress) {
    runtime.progress = { ...progress, at: new Date().toISOString() }
  },
})

let refreshPromise = null

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function refresh() {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    runtime.lastAttemptAt = new Date().toISOString()
    runtime.status = runtime.snapshot ? 'REFRESHING' : 'INITIALIZING'
    runtime.lastError = null
    for (let attempt = 0; attempt <= REFRESH_RETRIES; attempt += 1) {
      try {
        const snapshot = await collector.refresh()
        atomicWrite(SNAPSHOT_PATH, `${stringifySnapshot(snapshot)}\n`)
        runtime.snapshot = snapshot
        runtime.status = 'LIVE'
        runtime.lastSuccessAt = new Date().toISOString()
        runtime.progress = {
          phase: 'ready',
          message: `安全区块 ${snapshot.pool.blockNumber} 已发布`,
          at: runtime.lastSuccessAt,
        }
        return
      } catch (error) {
        const message = safePublicError(error)
        const failedProgress = runtime.progress
        if (attempt < REFRESH_RETRIES) {
          runtime.progress = {
            phase: 'retry',
            message: `RPC 读取暂时失败，正在重试 ${attempt + 1}/${REFRESH_RETRIES}`,
            failedPhase: failedProgress?.phase || null,
            at: new Date().toISOString(),
          }
          await delay(750 * (attempt + 1))
          continue
        }
        runtime.status = runtime.snapshot ? 'STALE' : 'ERROR'
        runtime.lastError = message
        runtime.progress = {
          phase: 'error',
          message,
          failedPhase: failedProgress?.phase || null,
          at: new Date().toISOString(),
        }
        process.stderr.write(`[dashboard] refresh failed after ${attempt + 1} attempts: ${message}\n`)
      }
    }
  })().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
])

function headers(extra = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'content-security-policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ...extra,
  }
}

function sendJson(response, statusCode, body, extraHeaders = {}) {
  const payload = `${JSON.stringify(body)}\n`
  response.writeHead(
    statusCode,
    headers({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'content-length': Buffer.byteLength(payload),
      ...extraHeaders,
    }),
  )
  response.end(payload)
}

function publicRuntime() {
  const generatedAt = runtime.snapshot?.generatedAt
  const evaluated = evaluateRuntimeStatus({ status: runtime.status, generatedAt, refreshMs: REFRESH_MS })
  return {
    service: runtime.service,
    status: evaluated.status,
    ready: evaluated.ready,
    startedAt: runtime.startedAt,
    lastAttemptAt: runtime.lastAttemptAt,
    lastSuccessAt: runtime.lastSuccessAt,
    ageSeconds: evaluated.ageSeconds,
    staleAfterSeconds: evaluated.staleAfterSeconds,
    refreshMs: REFRESH_MS,
    lastError: runtime.lastError,
    progress: runtime.progress,
    blockNumber: runtime.snapshot?.pool?.blockNumber || null,
    blockTime: runtime.snapshot?.pool?.blockTime || null,
  }
}

function safeAssetPath(urlPath) {
  const decoded = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath)
  const normalized = path.posix.normalize(decoded).replace(/^\/+/, '')
  if (normalized.startsWith('..') || normalized.includes('/../')) return null
  const resolved = path.resolve(PUBLIC_DIR, normalized)
  return resolved.startsWith(`${PUBLIC_DIR}${path.sep}`) ? resolved : null
}

const server = http.createServer((request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { status: 'METHOD_NOT_ALLOWED' }, { allow: 'GET, HEAD' })
      return
    }
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
    if (url.pathname === '/livez') {
      sendJson(response, 200, { service: runtime.service, status: 'ALIVE', startedAt: runtime.startedAt })
      return
    }
    if (url.pathname === '/healthz' || url.pathname === '/readyz') {
      const health = publicRuntime()
      sendJson(response, health.ready ? 200 : 503, health)
      return
    }
    if (url.pathname === '/api/sources') {
      sendJson(response, 200, {
        runtime: publicRuntime(),
        sources: runtime.snapshot
          ? {
              chain: runtime.snapshot.chain,
              history: runtime.snapshot.history,
              comparison: runtime.snapshot.comparison
                ? {
                    method: runtime.snapshot.comparison.method,
                    policy: runtime.snapshot.comparison.policy,
                    migrationEstimate: runtime.snapshot.comparison.migrationEstimate,
                    pools: runtime.snapshot.comparison.rows.map((pool) => ({
                      id: pool.id,
                      label: pool.label,
                      feeLabel: pool.feeLabel,
                      poolId: pool.poolId,
                      hooks: pool.hooks,
                      initializedAtBlock: pool.initializedAtBlock || null,
                      exploreUrl: pool.exploreUrl || null,
                    })),
                  }
                : null,
              dataQuality: runtime.snapshot.dataQuality,
              portfolio: runtime.snapshot.portfolio
                ? {
                    audit: runtime.snapshot.portfolio.audit,
                    accountingBoundary: runtime.snapshot.portfolio.accountingBoundary,
                  }
                : null,
              caveats: runtime.snapshot.caveats,
            }
          : null,
      })
      return
    }
    if (url.pathname === '/api/portfolio') {
      if (!runtime.snapshot?.portfolio) {
        sendJson(response, 503, { status: runtime.status, runtime: publicRuntime() }, { 'retry-after': '5' })
        return
      }
      sendJson(response, 200, {
        runtime: publicRuntime(),
        portfolio: runtime.snapshot.portfolio,
      })
      return
    }
    if (url.pathname === '/api/snapshot') {
      if (!runtime.snapshot) {
        sendJson(response, 503, { status: runtime.status, runtime: publicRuntime() }, { 'retry-after': '5' })
        return
      }
      sendJson(response, 200, {
        runtime: publicRuntime(),
        ...snapshotWindow(runtime.snapshot, url.searchParams.get('window') || '24h'),
      })
      return
    }

    const assetPath = safeAssetPath(url.pathname)
    if (!assetPath || !fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
      sendJson(response, 404, { status: 'NOT_FOUND' })
      return
    }
    const extension = path.extname(assetPath).toLowerCase()
    const stat = fs.statSync(assetPath)
    response.writeHead(
      200,
      headers({
        'content-type': contentTypes.get(extension) || 'application/octet-stream',
        'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=3600',
        'content-length': stat.size,
      }),
    )
    if (request.method === 'HEAD') response.end()
    else fs.createReadStream(assetPath).pipe(response)
  } catch (error) {
    sendJson(response, 500, { status: 'INTERNAL_ERROR', message: safePublicError(error) })
  }
})

server.listen(PORT, HOST, () => {
  process.stdout.write(`[dashboard] listening on http://${HOST}:${PORT}\n`)
  void refresh()
})

const interval = setInterval(() => void refresh(), REFRESH_MS)
interval.unref()

function shutdown(signal) {
  process.stdout.write(`[dashboard] ${signal}; shutting down\n`)
  clearInterval(interval)
  server.close(() => {
    collector.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
