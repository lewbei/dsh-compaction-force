import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildPolicies } from './index.js'

// Optional installed DSH node_modules path enables validation by the shipped
// engine in a disposable Cordis Context; no profile or model requests are used.
const modules = process.argv[2] && resolve(process.argv[2])
const Context = modules && (await import(pathToFileURL(join(modules, '@deepseek-ai/cordis/lib/index.js')))).Context
const BasicCompactionEngine = modules && (await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-compaction-basic/lib/index.js')))).BasicCompactionEngine

const catalog = window => [{ provider: 'test', model: 'scaled', contextWindow: window }]
const tiny = buildPolicies(catalog(1000000), { forceAtTokens: 1 })
assert.equal(tiny.length, 1, 'a positive representable threshold must keep its policy')
assert.equal(tiny[0].thresholdRatio, 0.000001)
assert(tiny[0].retainRatio > 0 && tiny[0].retainRatio < tiny[0].thresholdRatio,
  'retention must remain strictly below the threshold after rounding')
assert.deepEqual(buildPolicies(catalog(3000000), { forceAtTokens: 1 }), [],
  'a threshold rounded to zero must leave the shipped policy untouched')
console.log('PASS tiny positive threshold and zero-rounding regressions')

let checked = 0
for (const forceAtTokens of [1, 2, 3, 500, 2000, 262144]) {
  for (const window of [500000, 500001, 600000, 700000, 900000, 1000000, 1048576, 1640000, 2000000, 3000000, 10000000]) {
    const policies = buildPolicies(catalog(window), { forceAtTokens })
    for (const policy of policies) {
      assert(policy.thresholdRatio > 0 && policy.thresholdRatio < 0.8)
      const thresholdTokens = Math.floor(window * policy.thresholdRatio)
      assert(thresholdTokens >= 1, `expected thresholdTokens >= 1 for ${forceAtTokens}/${window}`)
      if (policy.retainRatio !== undefined) {
        assert(policy.retainRatio > 0 && policy.retainRatio < policy.thresholdRatio)
        assert(Math.floor(window * policy.retainRatio) < thresholdTokens,
          `expected floor(window * retainRatio) < thresholdTokens for ${forceAtTokens}/${window}`)
      }
      if (policy.retainTokens !== undefined) {
        assert(Number.isInteger(policy.retainTokens) && policy.retainTokens >= 0)
        assert(policy.retainRatio === undefined, 'retainTokens and retainRatio must stay mutually exclusive')
      }
    }
    if (BasicCompactionEngine) {
      new BasicCompactionEngine(new Context(), { auto: false, modelPolicies: policies })
    }
    checked += 1
  }
}
console.log(`PASS ${checked} policy configurations${BasicCompactionEngine ? ' accepted by shipped BasicCompactionEngine' : ' (offline invariants only)'}`)

// Decisive matrix: the shipped engine must accept the merged config the plugin
// would produce under every admissible service-level retention mode and preset
// per-model row, including customized retention the old code invalidated.
const serviceRetentions = [
  {},
  { retainRatio: 0.16 },
  { retainRatio: 0.3 },
  { retainRatio: 0.5 },
  { retainTokens: 2000 },
  { retainTokens: 300000 },
]
const priorRowsByMode = [
  [],
  [{ provider: 'test', model: 'scaled', thresholdRatio: 0.4, headroomTokens: 12345, maxTokens: 99999, summarizationProvider: 'octo', summarizationModel: 'squid', retainRatio: 0.1 }],
  [{ provider: 'test', model: 'scaled', thresholdRatio: 0.4, headroomTokens: 12345, maxTokens: 99999, summarizationProvider: 'octo', summarizationModel: 'squid', retainTokens: 2000 }],
]
let matrixChecked = 0
for (const service of serviceRetentions) {
  for (const priorRows of priorRowsByMode) {
    for (const window of [1000000, 1048576, 2000000, 10000000]) {
      const policies = buildPolicies(catalog(window), { forceAtTokens: 262144 }, {
        previousRows: priorRows,
        serviceConfig: service,
      })
      const merged = new Map(priorRows.map((row) => [`${row.provider}\u0000${row.model}`, row]))
      for (const policy of policies) {
        const key = `${policy.provider}\u0000${policy.model}`
        merged.set(key, merged.has(key) ? { ...merged.get(key), ...policy } : policy)
      }
      const config = { auto: false, ...service, modelPolicies: [...merged.values()] }
      let accepted = true
      if (BasicCompactionEngine) {
        try {
          new BasicCompactionEngine(new Context(), config)
        } catch {
          accepted = false
        }
      }
      assert(accepted, `shipped engine must accept merged config under ${JSON.stringify(service)} + ${JSON.stringify(priorRows)} + window ${window}`)
      matrixChecked += 1
    }
  }
}
console.log(`PASS ${matrixChecked} retained-config matrix combinations${BasicCompactionEngine ? ' accepted by shipped BasicCompactionEngine' : ' (offline invariants only)'}`)
console.log('LIMIT: no live profile, automatic activation, pressure event, or LLM request exercised')
