import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

function source(relativePath) {
  return fs.readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8')
}

const collector = source('dashboard/lib/collector.mjs')
const server = source('dashboard/server.mjs')
const application = source('dashboard/public/app.js')
const page = source('dashboard/public/index.html')

test('dashboard exposes automatic inventory and versioned trend read models', () => {
  assert.match(server, /url\.pathname === '\/api\/inventory'/u)
  assert.match(server, /url\.pathname === '\/api\/strategies'/u)
  assert.match(server, /url\.pathname === '\/api\/trend'/u)
  assert.match(collector, /POSITION_TRANSFER_EVENT/u)
  assert.match(collector, /functionName: 'balanceOf'/u)
  assert.match(collector, /schemaVersion: 5/u)
  assert.match(collector, /executionAuthorized: false/u)
})

test('public page renders the trend model and skips unchanged snapshots', () => {
  assert.match(page, /id="trend-chart"/u)
  assert.match(page, /id="strategy-positions"/u)
  assert.match(page, /Shadow 建议，不会自动交易/u)
  assert.match(application, /renderExternalStrategy/u)
  assert.match(application, /payload\.snapshotId/u)
  assert.match(application, /snapshotKey === state\.snapshotKey/u)
  assert.match(application, /document\.hidden \? 30_000 : 5_000/u)
})

test('read-only dashboard contains no account or transaction broadcast primitives', () => {
  const dashboardRuntime = [collector, server].join('\n')
  assert.doesNotMatch(dashboardRuntime, /privateKeyToAccount|createWalletClient|sendTransaction|writeContract/u)
})
