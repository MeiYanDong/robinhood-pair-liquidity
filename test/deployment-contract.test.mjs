import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const service = fs.readFileSync(
  fileURLToPath(new URL('../dashboard/deploy/pair-liquidity-dashboard.service', import.meta.url)),
  'utf8',
)
const installer = fs.readFileSync(
  fileURLToPath(new URL('../dashboard/deploy/install-release.sh', import.meta.url)),
  'utf8',
)

test('production service uses the rate-limit-safe refresh contract', () => {
  assert.match(service, /^Environment=PAIR_DASHBOARD_REFRESH_MS=60000$/m)
  assert.match(service, /^Environment=PAIR_DASHBOARD_RETRIES=0$/m)
})

test('release installation requires and preserves exact Git provenance', () => {
  assert.match(installer, /GIT_COMMIT is missing/u)
  assert.match(installer, /\^\[0-9a-f\]\{40\}\$/u)
  assert.match(installer, /"\$\{release_dir\}\/GIT_COMMIT"/u)
})
