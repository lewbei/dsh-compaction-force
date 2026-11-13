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
import { existsSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPolicies } from './index.js'

function printUsage() {
  console.error(`Usage: node catalog-report.mjs [--profile <name>] [--preset <id>]

Reports resolved compaction-force policy thresholds from a composed DSH profile
without booting the runtime or making network requests.`)
}

function parseArgs(argv) {
  const values = { profile: null, preset: null }
  let endOfFlags = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!endOfFlags && arg === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags) {
      if (arg === '--help' || arg === '-h') {
        printUsage()
        process.exit(0)
      }
      const eq = arg.indexOf('=')
      const flag = eq === -1 ? arg : arg.slice(0, eq)
      if (flag === '--profile' || flag === '--preset') {
        const key = flag.slice(2)
        if (values[key] !== null) {
          console.error(`catalog-report: ${flag} specified more than once`)
          process.exit(1)
        }
        const val = eq === -1 ? argv[++i] : arg.slice(eq + 1)
        if (typeof val !== 'string' || val.length === 0 || val.startsWith('-')) {
          console.error(`catalog-report: ${flag} requires a ${key === 'profile' ? 'profile name' : 'preset id'}`)
          process.exit(1)
        }
        values[key] = val
        continue
      }
      if (arg.startsWith('-')) {
        console.error(`catalog-report: unknown option: ${arg}`)
        process.exit(1)
      }
    }
    console.error(`catalog-report: unexpected argument: ${arg}`)
    process.exit(1)
  }
  return { profile: values.profile ?? 'web', preset: values.preset }
}

const { profile, preset: targetPreset } = parseArgs(process.argv.slice(2))
const HEADROOM = 65536
const DEEPSEEK_ROUTES = [
  { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1048576, maxTokens: 256000 },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro', contextWindow: 1048576, maxTokens: 256000 },
]

function isInstallRootCandidate(dir) {
  return (
    existsSync(join(dir, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')) ||
    existsSync(join(dir, '@deepseek-ai', 'dsh-app-boot', 'package.json')) ||
    (existsSync(join(dir, '.bin', 'dsh')) && existsSync(join(dir, '@deepseek-ai', 'dsh', 'package.json')))
  )
}

function installRoot() {
  const explicit = process.env.DSH_INSTALL_ROOT
  if (typeof explicit === 'string' && explicit.length > 0) {
    const trimmed = explicit.trim()
    if (trimmed.length > 0) {
      const start = resolve(trimmed)
      if (isInstallRootCandidate(start)) return start
      const nestedNm = join(start, 'node_modules')
      if (isInstallRootCandidate(nestedNm)) return nestedNm
    }
    console.error(`catalog-report: DSH_INSTALL_ROOT does not point to a valid DSH installation: ${explicit}`)
    process.exit(1)
  }
  const candidates = []
  const which = spawnSync('which', ['dsh'], { encoding: 'utf8' })
  if (which.status === 0 && which.stdout.trim()) {
    try {
      candidates.push(dirname(realpathSync(which.stdout.trim())))
    } catch {}
  }
  candidates.push(dirname(fileURLToPath(import.meta.url)))
  for (const start of candidates) {
    let dir = start
    for (let depth = 0; depth < 8; depth += 1) {
      if (isInstallRootCandidate(dir)) return dir
      const nestedNm = join(dir, 'node_modules')
      if (isInstallRootCandidate(nestedNm)) return nestedNm
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  console.error('catalog-report: cannot locate DSH installation; set DSH_INSTALL_ROOT')
  process.exit(1)
}

function loadModuleFromRoot(root, id) {
  const anchors = [
    join(root, 'resolve-from-root.cjs'),
    join(root, '@deepseek-ai', 'dsh-config-editor', 'package.json'),
    join(root, '@deepseek-ai', 'dsh-app-boot', 'package.json'),
    join(root, '@deepseek-ai', 'dsh-web-app', 'package.json'),
    join(root, '@deepseek-ai', 'dsh', 'package.json'),
    join(root, '@deepseek-ai', 'dsh-agent-preset', 'package.json'),
    join(root, '@deepseek-ai', 'cordis-plugin-include', 'package.json'),
  ]
  for (const anchor of anchors) {
    try {
      const target = existsSync(anchor) ? realpathSync(anchor) : anchor
      const mod = createRequire(target)(id)
      return mod?.default ?? mod
    } catch {}
  }
  return null
}

function parseComposedConfig(root, rawText) {
  const rawYaml = loadModuleFromRoot(root, 'yaml')
  const yamlMod = typeof rawYaml?.parseDocument === 'function' ? rawYaml : null
  const jsYaml = yamlMod ? null : loadModuleFromRoot(root, 'js-yaml')
  if (!yamlMod && typeof jsYaml?.load !== 'function') {
    console.error(`catalog-report: cannot locate yaml or js-yaml in DSH installation (${root})`)
    process.exit(1)
  }
  try {
    if (yamlMod) {
      const doc = yamlMod.parseDocument(rawText)
      if (Array.isArray(doc?.errors) && doc.errors.length > 0) throw doc.errors[0]
      return doc.toJS()
    }
    const jsTags = typeof jsYaml.Type === 'function'
      ? ['tag:yaml.org,2002:js', 'tag:yaml.org,2002:js/undefined', 'tag:yaml.org,2002:js/regexp', 'tag:yaml.org,2002:js/function']
          .flatMap((tag) => ['scalar', 'sequence', 'mapping'].map((kind) => new jsYaml.Type(tag, { kind, construct: (data) => data })))
      : []
    const schema = jsYaml.DEFAULT_SCHEMA?.extend ? jsYaml.DEFAULT_SCHEMA.extend(jsTags) : undefined
    return jsYaml.load(rawText, schema ? { schema } : undefined)
  } catch (error) {
    console.error(`catalog-report: failed to parse composed profile: ${error?.message ?? error}`)
    process.exit(1)
  }
}

function isPlainRow(row) {
  return Boolean(row && typeof row === 'object' && !Array.isArray(row))
}

function isPresetRow(row) {
  return isPlainRow(row) && (row.name === '@deepseek-ai/dsh-agent-preset' || (typeof row.config?.id === 'string' && Array.isArray(row.config?.plugins)))
}

function isCompactionForceRow(row) {
  return isPlainRow(row) && (
    row.id === 'compaction-force' ||
    row.name === '@local/dsh-compaction-force' ||
    (typeof row.name === 'string' && /(?:^|[\\/])dsh-compaction-force(?:[\\/]index\.js)?$/.test(row.name))
  )
}

function collectScopes(rows, scopeLabel, presetId, allScopes, checkedPresets) {
  if (!Array.isArray(rows)) return
  for (const row of rows) {
    if (!isPlainRow(row)) continue
    if (isPresetRow(row)) {
      const id = row.config?.id ?? row.id
      if (typeof id === 'string') checkedPresets.push(id)
      if (row.disabled !== true) {
        collectScopes(row.config?.plugins, `Preset ${id}`, id, allScopes, checkedPresets)
      }
      continue
    }
    if (row.disabled === true) continue
    if (isCompactionForceRow(row)) {
      allScopes.push({ scopeLabel, presetId, force: row })
    } else if (Array.isArray(row.config)) {
      collectScopes(row.config, scopeLabel, presetId, allScopes, checkedPresets)
    }
  }
}

const root = installRoot()
const localDsh = join(root, '.bin', 'dsh')
const dshBin = existsSync(localDsh) ? localDsh : 'dsh'
const dump = spawnSync(dshBin, ['--profile', profile, '--dump-config'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (dump.status !== 0) {
  const detail = dump.error ? dump.error.message : String(dump.stderr || '')
  console.error(`dsh --profile ${profile} --dump-config failed: ${detail.slice(0, 400)}`)
  process.exit(1)
}
const composed = parseComposedConfig(root, dump.stdout)
if (!Array.isArray(composed)) {
  console.error('composed profile did not parse to a row list')
  process.exit(1)
}

const allScopes = []
const checkedPresets = []
collectScopes(composed, 'Profile root', null, allScopes, checkedPresets)

const matchingScopes = targetPreset === null
  ? allScopes
  : allScopes.filter((entry) => entry.presetId === targetPreset)

if (matchingScopes.length === 0) {
  if (targetPreset !== null) {
    console.error(`catalog-report: preset "${targetPreset}" has no active compaction-force row in profile "${profile}"`)
  } else {
    const presetList = checkedPresets.length > 0 ? checkedPresets.join(', ') : 'none'
    console.error(`catalog-report: no active compaction-force row in profile "${profile}" (checked presets: ${presetList})`)
  }
  process.exit(1)
}

const { scopeLabel, force } = matchingScopes[0]
if (matchingScopes.length > 1) {
  const others = matchingScopes.slice(1).map((entry) => entry.scopeLabel).join(', ')
  console.log(`Multiple active compaction-force scopes found; reporting ${scopeLabel} (others: ${others}; pass --preset <id> to select)`)
}
const forceAtTokens = force.config?.forceAtTokens ?? 262144
const minContextWindow = force.config?.minContextWindow ?? 500000
console.log(`${scopeLabel} compaction-force: forceAtTokens=${forceAtTokens} minContextWindow=${minContextWindow} note=${force.config?.note ?? 'handoff'}`)

const models = [...DEEPSEEK_ROUTES]
const piAi = composed.find((row) => row?.id === 'llm-pi-ai')
for (const [provider, route] of Object.entries(piAi?.config?.providers ?? {})) {
  for (const model of route?.models ?? []) {
    if (Number.isInteger(model?.contextWindow) && Number.isInteger(model?.maxTokens)) {
      models.push({ provider, model: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens })
    }
  }
}

// Use the plugin's own policy builder so filtering and retention math stay
// identical to what installPolicies actually installs.
const policies = buildPolicies(models, { forceAtTokens, minContextWindow })
const policyByKey = new Map(policies.map((policy) => [`${policy.provider}\u0000${policy.model}`, policy]))
const rows = []
for (const model of models) {
  if (!Number.isInteger(model.contextWindow) || model.contextWindow <= minContextWindow) continue
  const policy = policyByKey.get(`${model.provider}\u0000${model.model}`)
  if (policy === undefined) continue
  const pressureBudget = model.contextWindow - model.maxTokens - HEADROOM
  const threshold = Math.floor(Math.min(policy.thresholdRatio * model.contextWindow, pressureBudget))
  rows.push({ ...model, ratio: policy.thresholdRatio, retention: policy.retainRatio ?? policy.retainTokens ?? null, threshold, pct: (100 * threshold) / model.contextWindow })
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
