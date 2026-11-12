#!/usr/bin/env node
/**
 * Report what the shipped formula resolves once compaction-force's policies are
 * installed, computed from the LIVE composed profile (no boot, no network).
 *
 * Usage:
 *   node catalog-report.mjs                 # --profile web by default
 *   node catalog-report.mjs --profile web
 *
 * The plugin itself enumerates the catalog at runtime through
 * llm.listProviders()/listModels()/resolveModelInfo(); this script instead reads
 * the composed configuration (pi-ai routes) plus the two known dsh-llm-deepseek
 * routes, applies the same policy math, and shows which models really reach the
 * forced threshold. Reservation = the model's declared maxTokens (the value the
 * adapter materializes into the routed request header); headroom = 65,536.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const profileFlag = args.indexOf('--profile')
const profile = profileFlag === -1 ? 'web' : args[profileFlag + 1]
const HEADROOM = 65536
// dsh-llm-deepseek routes carry their models from the adapter, not the composed
// profile. Values observed through a real headless enumeration (2026-11-12):
// deepseek-official advertises deepseek-flash and deepseek-v4-pro, both window
// 1,048,576 / defaultMaxTokens 256,000. deepseek-account advertised no models in
// that process; the runtime plugin enumerates whatever the live process lists,
// so this report is a LOWER BOUND for the deepseek routes.
const DEEPSEEK_ROUTES = [
  { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1048576, maxTokens: 256000 },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro', contextWindow: 1048576, maxTokens: 256000 },
]

function installRoot() {
  const explicit = process.env.DSH_INSTALL_ROOT
  const candidates = []
  if (explicit) candidates.push(explicit)
  const which = spawnSync('which', ['dsh'], { encoding: 'utf8' })
  if (which.status === 0) candidates.push(dirname(realpathSync(which.stdout.trim())))
  for (const start of candidates) {
    let dir = start
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(join(dir, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml'))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  throw new Error('cannot locate the installed @deepseek-ai/dsh-web-app package; set DSH_INSTALL_ROOT')
}

const root = installRoot()
const require = createRequire(join(root, 'resolve-from-root.cjs'))
const yaml = require('yaml')
const dump = spawnSync('dsh', ['--profile', profile, '--dump-config'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (dump.status !== 0) {
  console.error(`dsh --profile ${profile} --dump-config failed: ${String(dump.stderr).slice(0, 400)}`)
  process.exit(1)
}
const composed = yaml.parseDocument(dump.stdout).toJS()
if (!Array.isArray(composed)) {
  console.error('composed profile did not parse to a row list')
  process.exit(1)
}

const guarded = composed.find((row) => row?.config?.id === 'guarded')
if (guarded === undefined) {
  console.error('composed profile has no Guarded preset declaration')
  process.exit(1)
}
const compaction = (guarded.config.plugins ?? []).find((row) => row?.id === 'compaction')
const force = (Array.isArray(compaction?.config) ? compaction.config : []).find((row) => row?.id === 'compaction-force')
if (force === undefined) {
  console.error('Guarded preset has no compaction-force row')
  process.exit(1)
}
const forceAtTokens = force.config?.forceAtTokens ?? 262144
const minContextWindow = force.config?.minContextWindow ?? 500000
console.log(`Guarded compaction-force: forceAtTokens=${forceAtTokens} minContextWindow=${minContextWindow} note=${force.config?.note ?? 'both'}`)

const models = [...DEEPSEEK_ROUTES]
const piAi = composed.find((row) => row?.id === 'llm-pi-ai')
for (const [provider, route] of Object.entries(piAi?.config?.providers ?? {})) {
  for (const model of route?.models ?? []) {
    if (Number.isInteger(model?.contextWindow) && Number.isInteger(model?.maxTokens)) {
      models.push({ provider, model: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens })
    }
  }
}

const rows = []
for (const model of models) {
  if (!Number.isInteger(model.contextWindow) || model.contextWindow <= minContextWindow) continue
  const ratio = Math.round((forceAtTokens / model.contextWindow) * 1e6) / 1e6
  const pressureBudget = model.contextWindow - model.maxTokens - HEADROOM
  const threshold = Math.floor(Math.min(ratio * model.contextWindow, pressureBudget))
  rows.push({ ...model, ratio, threshold, pct: (100 * threshold) / model.contextWindow })
}
rows.sort((a, b) => a.threshold - b.threshold || a.provider.localeCompare(b.provider))

const forced = rows.filter((row) => row.threshold === forceAtTokens)
const lower = rows.filter((row) => row.threshold !== forceAtTokens)
const untouched = models.filter((model) => !Number.isInteger(model.contextWindow) || model.contextWindow <= minContextWindow)

console.log(`\nmodels > ${minContextWindow} window: ${rows.length} (forced at ${forceAtTokens}: ${forced.length}, lower because reserve+headroom leaves less: ${lower.length})`)
console.log(`models <= ${minContextWindow} window left untouched: ${untouched.length}`)
if (rows.length > 0) {
  console.log('\nprovider/model                       window      max   ratio     threshold   pct')
  for (const row of rows.slice(0, 40)) {
    console.log(
      `${(row.provider + '/' + row.model).padEnd(36)} ${String(row.contextWindow).padStart(8)} ${String(row.maxTokens).padStart(8)} ${row.ratio.toFixed(6)} ${String(row.threshold).padStart(10)} ${row.pct.toFixed(1).padStart(5)}%`,
    )
  }
  if (rows.length > 40) console.log(`... ${rows.length - 40} more`)
}
if (lower.length > 0) {
  console.log('\nNot reaching the forced threshold (declared output cap + 64K headroom eats the budget):')
  for (const row of lower.slice(0, 12)) console.log(`  ${row.provider}/${row.model}: window ${row.contextWindow}, maxTokens ${row.maxTokens} -> threshold ${row.threshold} (${row.pct.toFixed(1)}%)`)
}
