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
  for (const window of [500000, 500001, 1000000, 1048576, 1640000, 2000000, 3000000, 10000000]) {
    const policies = buildPolicies(catalog(window), { forceAtTokens })
    for (const policy of policies) {
      assert(policy.thresholdRatio > 0 && policy.thresholdRatio < 0.8)
      if (policy.retainRatio !== undefined) {
        assert(policy.retainRatio > 0 && policy.retainRatio < policy.thresholdRatio)
      }
    }
    if (BasicCompactionEngine) {
      new BasicCompactionEngine(new Context(), { auto: false, modelPolicies: policies })
    }
    checked += 1
  }
}
console.log(`PASS ${checked} policy configurations${BasicCompactionEngine ? ' accepted by shipped BasicCompactionEngine' : ' (offline invariants only)'}`)
console.log('LIMIT: no live profile, automatic activation, pressure event, or LLM request exercised')
