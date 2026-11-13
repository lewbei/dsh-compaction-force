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
 * the composed configuration (pi-ai and deepseek routes), applies the same
 * policy math with compaction-basic headroom/retention defaults, and shows which
 * models really reach the forced threshold.
 */
import { existsSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildPolicies, normalizeOptions } from './index.js'

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

const DEFAULT_HEADROOM = 65536
const DEFAULT_RETAIN_RATIO = 0.16
const DEFAULT_THRESHOLD_RATIO = 0.8
const round6 = (value) => Math.round(value * 1e6) / 1e6
const DEEPSEEK_DEFAULT_MODELS = [
  { id: 'deepseek-flash', contextWindow: 1048576 },
  { id: 'deepseek-v4-pro', contextWindow: 1048576 },
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

function isCompactionBasicRow(row) {
  return isPlainRow(row) && (row.id === 'compaction-basic' || row.name === '@deepseek-ai/dsh-compaction-basic')
}

function isPiAiRow(row) {
  return isPlainRow(row) && (row.id === 'llm-pi-ai' || row.name === '@deepseek-ai/dsh-llm-pi-ai')
}

function isDeepseekApiKeyRow(row) {
  return isPlainRow(row) && (
    row.id === 'llm-deepseek' ||
    row.id === 'llm-deepseek-api-key' ||
    row.name === '@deepseek-ai/dsh-llm-deepseek' ||
    row.name === '@deepseek-ai/dsh-llm-deepseek-api-key'
  )
}

function isDeepseekAccountRow(row) {
  return isPlainRow(row) && (row.id === 'llm-deepseek-account' || row.name === '@deepseek-ai/dsh-llm-deepseek-account')
}

async function loadPiAiCatalog(root) {
  const tryLoad = async (base) => {
    for (const candidate of [
      join(base, '@earendil-works', 'pi-ai', 'dist', 'providers', 'all.js'),
      join(base, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'all.js'),
    ]) {
      if (!existsSync(candidate)) continue
      try {
        return await import(pathToFileURL(candidate).href)
      } catch {}
    }
    return null
  }
  const direct = await tryLoad(root)
  if (direct) return direct
  const pkgPaths = [
    join(root, '@deepseek-ai', 'dsh-llm-pi-ai'),
    join(root, '@deepseek-ai', 'dsh-app-boot'),
    join(root, '@deepseek-ai', 'dsh-web-app'),
    join(root, '@deepseek-ai', 'dsh'),
  ]
  for (const pkgPath of pkgPaths) {
    if (!existsSync(pkgPath)) continue
    let dir = realpathSync(pkgPath)
    for (let depth = 0; depth < 6; depth += 1) {
      const loaded = await tryLoad(dir)
      if (loaded) return loaded
      const parent = dirname(dir)
      if (parent === dir) break
      if (basename(dir) === 'node_modules' && !dir.includes('.pnpm')) break
      dir = parent
    }
  }
  return null
}

function collectScopes(rows, scopeLabel, presetId, allScopes, checkedPresets, inheritedBasic = null) {
  if (!Array.isArray(rows)) return
  const localBasic = rows.find((r) => isCompactionBasicRow(r) && r.disabled !== true)
  const basicRow = localBasic ?? inheritedBasic
  const basicConfig = isPlainRow(basicRow?.config) ? basicRow.config : {}
  for (const row of rows) {
    if (!isPlainRow(row)) continue
    if (isPresetRow(row)) {
      const id = row.config?.id ?? row.id
      if (typeof id === 'string') checkedPresets.push(id)
      if (row.disabled !== true) {
        collectScopes(row.config?.plugins, `Preset ${id}`, id, allScopes, checkedPresets, null)
      }
      continue
    }
    if (row.disabled === true) continue
    if (isCompactionForceRow(row)) {
      allScopes.push({ scopeLabel, presetId, force: row, basicConfig })
    } else if (Array.isArray(row.config)) {
      const nextBasic = row.isolate?.compaction === true ? null : basicRow
      collectScopes(row.config, scopeLabel, presetId, allScopes, checkedPresets, nextBasic)
    }
  }
}

function collectProviderRows(rows, targetPresetId, state) {
  if (!Array.isArray(rows)) return
  for (const row of rows) {
    if (!isPlainRow(row)) continue
    if (isPresetRow(row)) {
      const id = row.config?.id ?? row.id
      if (row.disabled !== true && targetPresetId !== null && id === targetPresetId) {
        collectProviderRows(row.config?.plugins, targetPresetId, state)
      }
      continue
    }
    if (row.disabled === true) continue
    if (isDeepseekApiKeyRow(row)) {
      state.deepseekApiKeyRows.push(row)
    } else if (isDeepseekAccountRow(row)) {
      state.deepseekAccountRows.push(row)
    } else if (isPiAiRow(row)) {
      state.piAiRows.push(row)
    } else if (Array.isArray(row.config)) {
      collectProviderRows(row.config, targetPresetId, state)
    }
  }
}

function addDeepseekRouteModels(modelMap, provider, entries, defaultWindow, routeMaxTokens) {
  for (const entry of entries) {
    if (!isPlainRow(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue
    const contextWindow = entry.contextWindow ?? defaultWindow
    const maxTokens = entry.maxTokens ?? routeMaxTokens
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) continue
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) continue
    modelMap.set(`${provider}\u0000${entry.id}`, {
      provider,
      model: entry.id,
      contextWindow,
      maxTokens,
      reservedTokens: maxTokens,
    })
  }
}

function resolveModels(composed, targetPresetId, piAiCatalog) {
  const providerState = { piAiRows: [], deepseekApiKeyRows: [], deepseekAccountRows: [] }
  collectProviderRows(composed, targetPresetId, providerState)
  const modelMap = new Map()
  for (const dsRow of providerState.deepseekApiKeyRows) {
    const cfg = isPlainRow(dsRow.config) ? dsRow.config : {}
    const defaultWindow = Number.isInteger(cfg.defaultContextWindow) && cfg.defaultContextWindow > 0 ? cfg.defaultContextWindow : 1000000
    const routeMaxTokens = Number.isInteger(cfg.maxTokens) && cfg.maxTokens > 0 ? cfg.maxTokens : 256000
    const entries = Array.isArray(cfg.models) ? cfg.models : DEEPSEEK_DEFAULT_MODELS
    addDeepseekRouteModels(modelMap, 'deepseek-official', entries, defaultWindow, routeMaxTokens)
  }
  for (const dsRow of providerState.deepseekAccountRows) {
    const cfg = isPlainRow(dsRow.config) ? dsRow.config : {}
    const defaultWindow = Number.isInteger(cfg.defaultContextWindow) && cfg.defaultContextWindow > 0 ? cfg.defaultContextWindow : 1000000
    const routeMaxTokens = Number.isInteger(cfg.maxTokens) && cfg.maxTokens > 0 ? cfg.maxTokens : 256000
    const overrides = isPlainRow(cfg.modelOverrides) ? cfg.modelOverrides : {}
    const entries = DEEPSEEK_DEFAULT_MODELS.map((m) => ({
      ...m,
      ...(isPlainRow(overrides[m.id]) ? overrides[m.id] : {}),
      id: m.id,
    }))
    addDeepseekRouteModels(modelMap, 'deepseek-account', entries, defaultWindow, routeMaxTokens)
  }
  for (const piAi of providerState.piAiRows) {
    for (const [provider, route] of Object.entries(piAi?.config?.providers ?? {})) {
      if (!isPlainRow(route)) continue
      const builtinList = typeof piAiCatalog?.getBuiltinModels === 'function' ? piAiCatalog.getBuiltinModels(provider) : []
      const defaults = new Map((Array.isArray(builtinList) ? builtinList : []).map((m) => [m.id, m]))
      const configured = Array.isArray(route.models) ? route.models : []
      const overrides = isPlainRow(route.modelOverrides) ? route.modelOverrides : {}
      const entries = configured.length > 0
        ? configured
        : [...defaults.values()].map((m) => ({ id: m.id, ...(isPlainRow(overrides[m.id]) ? overrides[m.id] : {}) }))
      for (const entry of entries) {
        if (!isPlainRow(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue
        const base = defaults.get(entry.id)
        const contextWindow = entry.contextWindow ?? base?.contextWindow ?? route.defaultContextWindow ?? 1000000
        const maxTokens = entry.maxTokens ?? base?.maxTokens ?? route.defaultMaxTokens ?? 128000
        if (!Number.isInteger(contextWindow) || contextWindow <= 0) continue
        if (!Number.isInteger(maxTokens) || maxTokens <= 0) continue
        modelMap.set(`${provider}\u0000${entry.id}`, {
          provider,
          model: entry.id,
          contextWindow,
          maxTokens,
          reservedTokens: Number.isInteger(entry.maxTokens) ? entry.maxTokens : 0,
        })
      }
    }
  }
  return [...modelMap.values()]
}

function isPositiveRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function resolveRetainTokens(policy, prior, basicConfig, messageBudget) {
  if (policy.retainTokens !== undefined) return policy.retainTokens
  if (policy.retainRatio !== undefined) return Math.floor(messageBudget * policy.retainRatio)
  if (prior?.retainTokens !== undefined) return prior.retainTokens
  if (prior?.retainRatio !== undefined) return Math.floor(messageBudget * prior.retainRatio)
  if (Number.isInteger(basicConfig.retainTokens)) return basicConfig.retainTokens
  const ratio = isPositiveRatio(basicConfig.retainRatio)
    ? basicConfig.retainRatio
    : DEFAULT_RETAIN_RATIO
  return Math.floor(messageBudget * ratio)
}

function describeSkipReason(model, forceAtTokens, prior, basicConfig) {
  const ratio = round6(forceAtTokens / model.contextWindow)
  if (model.contextWindow <= forceAtTokens) return `window <= forceAtTokens (${forceAtTokens})`
  if (isPositiveRatio(prior?.thresholdRatio)) {
    if (ratio >= prior.thresholdRatio) return `existing policy thresholdRatio=${prior.thresholdRatio} already tighter`
  } else if (isPositiveRatio(basicConfig.thresholdRatio) && ratio >= basicConfig.thresholdRatio) {
    return `compaction-basic thresholdRatio=${basicConfig.thresholdRatio} already tighter`
  }
  if (ratio >= DEFAULT_THRESHOLD_RATIO) return `ratio ${ratio} >= ${DEFAULT_THRESHOLD_RATIO}`
  return 'not emitted by buildPolicies'
}

const { profile, preset: targetPreset } = parseArgs(process.argv.slice(2))
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

const { scopeLabel, presetId: selectedPresetId, force, basicConfig } = matchingScopes[0]
if (matchingScopes.length > 1) {
  const others = matchingScopes.slice(1).map((entry) => entry.scopeLabel).join(', ')
  console.log(`Multiple active compaction-force scopes found; reporting ${scopeLabel} (others: ${others}; pass --preset <id> to select)`)
}
const opts = normalizeOptions(force.config)
const { forceAtTokens, minContextWindow, note } = opts
console.log(`${scopeLabel} compaction-force: forceAtTokens=${forceAtTokens} minContextWindow=${minContextWindow} note=${note}`)

const piAiCatalog = await loadPiAiCatalog(root)
const models = resolveModels(composed, selectedPresetId, piAiCatalog)

const existingPolicies = Array.isArray(basicConfig.modelPolicies) ? basicConfig.modelPolicies.filter(isPlainRow) : []
const existingByKey = new Map()
for (const policy of existingPolicies) {
  const key = `${policy.provider}\u0000${policy.model}`
  if (!existingByKey.has(key)) existingByKey.set(key, policy)
}
const policies = buildPolicies(models, opts, { previousRows: existingPolicies, serviceConfig: basicConfig })
const policyByKey = new Map(policies.map((policy) => [`${policy.provider}\u0000${policy.model}`, policy]))
const rows = []
const skipped = []
const unusable = []
const untouched = []
for (const model of models) {
  if (!Number.isInteger(model.contextWindow) || model.contextWindow <= minContextWindow) {
    untouched.push(model)
    continue
  }
  const key = `${model.provider}\u0000${model.model}`
  const policy = policyByKey.get(key)
  const prior = existingByKey.get(key)
  if (policy === undefined) {
    const effectiveRatio = isPositiveRatio(prior?.thresholdRatio)
      ? prior.thresholdRatio
      : (isPositiveRatio(basicConfig.thresholdRatio) ? basicConfig.thresholdRatio : DEFAULT_THRESHOLD_RATIO)
    skipped.push({ ...model, effectiveRatio, reason: describeSkipReason(model, forceAtTokens, prior, basicConfig) })
    continue
  }
  const reserved = model.reservedTokens
  const headroom = Number.isInteger(prior?.headroomTokens) && prior.headroomTokens >= 0
    ? prior.headroomTokens
    : (Number.isInteger(basicConfig.headroomTokens) && basicConfig.headroomTokens >= 0 ? basicConfig.headroomTokens : DEFAULT_HEADROOM)
  const messageBudget = model.contextWindow - reserved
  const pressureBudget = messageBudget - headroom
  if (messageBudget <= 0 || pressureBudget <= 0) {
    unusable.push({
      ...model,
      reserved,
      ratio: policy.thresholdRatio,
      headroom,
      reason: messageBudget <= 0 ? 'no message budget (reserve >= window)' : 'no pressure budget (reserve + headroom >= window)',
    })
    continue
  }
  const threshold = Math.floor(Math.min(policy.thresholdRatio * model.contextWindow, pressureBudget))
  const retainTokens = resolveRetainTokens(policy, prior, basicConfig, messageBudget)
  if (threshold <= 0 || retainTokens >= threshold) {
    unusable.push({
      ...model,
      reserved,
      ratio: policy.thresholdRatio,
      headroom,
      reason: threshold <= 0 ? 'non-positive threshold' : `no pressure budget (retain ${retainTokens} >= threshold ${threshold})`,
    })
    continue
  }
  const pct = (100 * threshold) / model.contextWindow
  const targetThreshold = Math.floor(policy.thresholdRatio * model.contextWindow)
  const budgetLimited = pressureBudget < targetThreshold
  rows.push({
    ...model,
    reserved,
    ratio: policy.thresholdRatio,
    headroom,
    threshold,
    pct,
    budgetLimited,
  })
}
rows.sort((a, b) => a.threshold - b.threshold || a.provider.localeCompare(b.provider))

const forced = rows.filter((row) => !row.budgetLimited)
const lower = rows.filter((row) => row.budgetLimited)

const summaryExtras = []
if (skipped.length > 0) summaryExtras.push(`skipped by compaction-force: ${skipped.length}`)
if (unusable.length > 0) summaryExtras.push(`no pressure budget: ${unusable.length}`)
const extraSuffix = summaryExtras.length > 0 ? `, ${summaryExtras.join(', ')}` : ''
console.log(`\nmodels > ${minContextWindow} window: ${rows.length} (forced at ${forceAtTokens}: ${forced.length}, lower because reserve+headroom leaves less: ${lower.length}${extraSuffix})`)
console.log(`models <= ${minContextWindow} window left untouched: ${untouched.length}`)
if (rows.length > 0) {
  console.log('\nprovider/model                       window      max   ratio     threshold   pct')
  for (const row of rows.slice(0, 40)) {
    console.log(
      `${(row.provider + '/' + row.model).padEnd(36)} ${String(row.contextWindow).padStart(8)} ${String(row.reserved).padStart(8)} ${row.ratio.toFixed(6)} ${String(row.threshold).padStart(10)} ${row.pct.toFixed(1).padStart(5)}%`,
    )
  }
  if (rows.length > 40) console.log(`... ${rows.length - 40} more`)
}
if (lower.length > 0) {
  console.log('\nNot reaching the forced threshold (declared output cap + headroom eats the budget):')
  for (const row of lower.slice(0, 12)) console.log(`  ${row.provider}/${row.model}: window ${row.contextWindow}, maxTokens ${row.reserved}, headroom ${row.headroom} -> threshold ${row.threshold} (${row.pct.toFixed(1)}%)`)
}
if (unusable.length > 0) {
  console.log('\nNo usable pressure budget (BasicCompactionEngine TargetPressureConfigError):')
  for (const row of unusable.slice(0, 12)) console.log(`  ${row.provider}/${row.model}: window ${row.contextWindow}, maxTokens ${row.reserved}, headroom ${row.headroom} -> ${row.reason}`)
}
if (skipped.length > 0) {
  console.log('\nSkipped by compaction-force:')
  for (const row of skipped.slice(0, 12)) console.log(`  ${row.provider}/${row.model}: window ${row.contextWindow} -> ${row.reason} (effective ratio ${row.effectiveRatio})`)
}
