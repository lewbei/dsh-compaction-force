/**
 * Offline verification for @local/dsh-compaction-force.
 *
 * Exercises the two seams directly:
 *  - buildPolicies/installPolicies against a fake llm catalog and a fake
 *    compaction engine (whose `config` is a frozen object, matching the real
 *    service);
 *  - wrapSummarize/buildNoteText against fake summarize results.
 *
 * Run: node verify.mjs
 */

import assert from 'node:assert/strict'
import {
  apply,
  buildNoteText,
  buildPolicies,
  extractSideConstraints,
  catalogFor,
  collectCatalog,
  DEFAULTS,
  installPolicies,
  normalizeOptions,
  sectionBullets,
  wrapSummarize,
} from './index.js'

let passed = 0
let failed = 0

const test = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`PASS: ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL: ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const SUMMARY_TEXT = [
  '## Primary Request and Intent',
  '- build the thing',
  '',
  '## Current Work',
  '- implementing the parser',
  '- writing tests',
  '',
  '## Next Step',
  '- run the verification suite',
  '',
  '## Critical Context',
  '- never edit /etc',
  '- deploy code LIME-27',
].join('\n')

/** Fake compaction engine: instance not frozen, config frozen like the real one. */
const makeEngine = (summary = SUMMARY_TEXT) => ({
  config: Object.freeze({
    thresholdRatio: 0.8,
    headroomTokens: 65536,
    retainRatio: 0.16,
    summarizationProvider: '',
    summarizationModel: '',
    maxTokens: 65536,
    compactionRetries: 2,
    maxOverflowRetries: 2,
    modelPolicies: [],
    auto: true,
  }),
  summarizeCalls: 0,
  async summarize() {
    this.summarizeCalls += 1
    return { summary: [{ type: 'text', text: summary }], rawOutput: [], provider: 'fake', model: 'fake' }
  },
})

/** Fake llm service driven by a catalog list. */
const makeLlm = (catalog) => {
  const calls = { providers: 0, models: 0, resolve: 0 }
  const byProvider = new Map()
  for (const entry of catalog) {
    if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, [])
    byProvider.get(entry.provider).push(entry)
  }
  return {
    calls,
    listProviders() {
      calls.providers += 1
      return [...byProvider.keys()].map((id) => ({ id, name: id }))
    },
    async listModels(provider) {
      calls.models += 1
      return (byProvider.get(provider) ?? []).map((entry) => ({ provider, id: entry.model, name: entry.model }))
    },
    async resolveModelInfo(provider, model) {
      calls.resolve += 1
      const entry = (byProvider.get(provider) ?? []).find((candidate) => candidate.model === model)
      if (entry === undefined) throw new Error(`unknown ${provider}/${model}`)
      if (entry.throw === true) throw new Error('adapter exploded')
      return { provider, id: model, name: model, context: entry.noContext === true ? undefined : { contextWindow: entry.window } }
    },
  }
}

const fakeCtx = (services) => ({
  tokenMeter: services.tokenMeter,
  logs: [],
  logger: {
    info(message) { this.owner.logs.push(['info', message]) },
    warn(message) { this.owner.logs.push(['warn', message]) },
    owner: null,
  },
  inject(names, callback) {
    this.names = names
    callback(services)
  },
})

await test('normalizeOptions: defaults, overrides, invalid values', () => {
  assert.deepEqual(normalizeOptions(), { ...DEFAULTS })
  assert.deepEqual(normalizeOptions({ forceAtTokens: 1000, minContextWindow: 100, note: 'context', heading: ' Handoff ' }), {
    forceAtTokens: 1000,
    minContextWindow: 100,
    note: 'context',
    heading: 'Handoff',
    scExtract: 'pattern',
  })
  assert.equal(normalizeOptions({ forceAtTokens: -1 }).forceAtTokens, DEFAULTS.forceAtTokens)
  assert.equal(normalizeOptions({ note: 'bogus' }).note, DEFAULTS.note)
  assert.equal(normalizeOptions({ minContextWindow: 0 }).minContextWindow, DEFAULTS.minContextWindow)
})

await test('buildPolicies: only windows above the threshold, ratio = forceAtTokens/window', () => {
  const policies = buildPolicies(
    [
      { provider: 'p', model: 'exact-500k', contextWindow: 500000 },
      { provider: 'p', model: 'one-m', contextWindow: 1000000 },
      { provider: 'p', model: 'deepseek', contextWindow: 1048576 },
      { provider: 'q', model: 'two-m', contextWindow: 2000000 },
      { provider: 'p', model: 'dup', contextWindow: 1000000 },
      { provider: 'p', model: 'dup', contextWindow: 1000000 },
      { provider: '', model: 'x', contextWindow: 2000000 },
      { provider: 'p', model: 'no-window', contextWindow: undefined },
    ],
    { forceAtTokens: 262144, minContextWindow: 500000 },
  )
  assert.deepEqual(policies, [
    { provider: 'p', model: 'one-m', thresholdRatio: 0.262144 },
    { provider: 'p', model: 'deepseek', thresholdRatio: 0.25 },
    { provider: 'q', model: 'two-m', thresholdRatio: 0.131072, retainRatio: 0.065536 },
    { provider: 'p', model: 'dup', thresholdRatio: 0.262144 },
  ])
})

await test('buildPolicies: scaled threshold (A/B mode) and no retain override for normal windows', () => {
  const policies = buildPolicies(
    [{ provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1048576 }],
    { forceAtTokens: 2000, minContextWindow: 1000 },
  )
  assert.equal(policies.length, 1)
  assert.equal(policies[0].thresholdRatio, 0.001907)
  assert.equal(policies[0].retainRatio, 0.000954)
})

await test('collectCatalog: resolves windows, skips throwing routes, tolerates string providers', async () => {
  const llm = makeLlm([
    { provider: 'a', model: 'big', window: 1000000 },
    { provider: 'a', model: 'broken', window: 1000000, throw: true },
    { provider: 'a', model: 'contextless', window: 1000000, noContext: true },
    { provider: 'b', model: 'small', window: 1000 },
  ])
  llm.listProviders = () => ['a', 'b']
  const catalog = await collectCatalog(llm)
  assert.deepEqual(catalog, [
    { provider: 'a', model: 'big', contextWindow: 1000000 },
    { provider: 'b', model: 'small', contextWindow: 1000 },
  ])
})

await test('catalogFor: one enumeration per llm service', async () => {
  const llm = makeLlm([{ provider: 'a', model: 'big', window: 1000000 }])
  const [first, second] = await Promise.all([catalogFor(llm), catalogFor(llm)])
  assert.deepEqual(first, second)
  assert.equal(llm.calls.resolve, 1)
  const third = await catalogFor(llm)
  assert.deepEqual(third, first)
  assert.equal(llm.calls.resolve, 1)
})

await test('installPolicies: replaces frozen config, merges explicit policies, keeps other fields', async () => {
  const engine = makeEngine()
  engine.config = Object.freeze({ ...engine.config, modelPolicies: [{ provider: 'x', model: 'y', thresholdRatio: 0.7 }] })
  const llm = makeLlm([{ provider: 'a', model: 'big', window: 1000000 }])
  const installed = await installPolicies(engine, llm, { forceAtTokens: 262144, minContextWindow: 500000 })
  assert.equal(installed, 1)
  assert.equal(Object.isFrozen(engine.config), true)
  assert.equal(engine.config.auto, true)
  assert.equal(engine.config.headroomTokens, 65536)
  assert.deepEqual(engine.config.modelPolicies, [
    { provider: 'x', model: 'y', thresholdRatio: 0.7 },
    { provider: 'a', model: 'big', thresholdRatio: 0.262144 },
  ])
})

await test('installPolicies: false when the catalog has no large-window model', async () => {
  const engine = makeEngine()
  const llm = makeLlm([{ provider: 'a', model: 'small', window: 1000 }])
  assert.equal(await installPolicies(engine, llm, {}), 0)
})

await test('sectionBullets: extracts a section, stops at the next heading, caps output', () => {
  assert.deepEqual(sectionBullets(SUMMARY_TEXT, 'Current Work'), ['implementing the parser', 'writing tests'])
  assert.deepEqual(sectionBullets(SUMMARY_TEXT, 'Next Step'), ['run the verification suite'])
  assert.deepEqual(sectionBullets(SUMMARY_TEXT, 'Missing'), [])
  assert.deepEqual(sectionBullets('## X\n- a\n- b\n- c', 'X', 1), ['a'])
})

await test('buildNoteText: context note carries size/time and authority statement', () => {
  const text = buildNoteText({ variant: 'context', totalTokens: 123456, timestamp: '2026-11-12T06:00:00.000Z' })
  assert.match(text, /## Note to Self \(context\)/)
  assert.match(text, /compacted at ~123K tokens on 2026-11-12T06:00:00.000Z/)
  assert.match(text, /authoritative record/)
  assert.doesNotMatch(text, /handoff/)
})

await test('buildNoteText: handoff note distills Current Work / Next Step / Critical Context', () => {
  const text = buildNoteText({ variant: 'handoff', summaryText: SUMMARY_TEXT })
  assert.match(text, /## Note to Self \(handoff\)/)
  assert.match(text, /Where I was: implementing the parser writing tests/)
  assert.match(text, /Next: run the verification suite/)
  assert.match(text, /Guardrails: never edit \/etc deploy code LIME-27/)
})

await test('buildNoteText: handoff falls back when sections are absent; both combines', () => {
  const fallback = buildNoteText({ variant: 'handoff', summaryText: 'nothing structured' })
  assert.match(fallback, /Resume from the checkpoint above/)
  const both = buildNoteText({ variant: 'both', summaryText: SUMMARY_TEXT, totalTokens: 2000 })
  assert.match(both, /Note to Self \(context\)/)
  assert.match(both, /Note to Self \(handoff\)/)
  assert.ok(both.indexOf('(context)') < both.indexOf('(handoff)'), 'context note must precede handoff note')
})

await test('buildNoteText: off and unknown variants add nothing', () => {
  assert.equal(buildNoteText({ variant: 'off' }), '')
  assert.equal(buildNoteText({ variant: 'nope' }), '')
})

await test('wrapSummarize: appends the note blocks after the summary, keeping the rest of the result', async () => {
  const engine = makeEngine()
  const ctx = fakeCtx({ tokenMeter: { measure: () => ({ totalTokens: 123456 }) } })
  assert.equal(wrapSummarize(engine, ctx, { note: 'both' }), true)
  const result = await engine.summarize({}, { session: {} }, undefined)
  assert.equal(engine.summarizeCalls, 1)
  assert.equal(result.provider, 'fake')
  assert.equal(result.rawOutput.length, 0)
  assert.equal(result.summary.length, 2)
  assert.match(result.summary[1].text, /compacted at ~123K tokens/)
  assert.match(result.summary[1].text, /Note to Self \(handoff\)/)
})

await test('wrapSummarize: note=off returns the adapter result untouched', async () => {
  const engine = makeEngine()
  const ctx = fakeCtx({ tokenMeter: { measure: () => ({ totalTokens: 1 }) } })
  wrapSummarize(engine, ctx, { note: 'off' })
  const first = await engine.summarize({}, { session: {} })
  assert.equal(first.summary.length, 1)
})

await test('wrapSummarize: wraps once; double call does not stack', async () => {
  const engine = makeEngine()
  const ctx = fakeCtx({})
  assert.equal(wrapSummarize(engine, ctx, { note: 'context' }), true)
  const once = engine.summarize
  assert.equal(wrapSummarize(engine, ctx, { note: 'context' }), false)
  assert.equal(engine.summarize, once)
  const result = await engine.summarize({}, { session: {} })
  assert.equal(result.summary.length, 2)
})

await test('wrapSummarize: broken token meter degrades to a size-less note', async () => {
  const engine = makeEngine()
  const ctx = fakeCtx({ tokenMeter: { measure() { throw new Error('meter down') } } })
  wrapSummarize(engine, ctx, { note: 'context' })
  const result = await engine.summarize({}, { session: {} })
  assert.match(result.summary[1].text, /compacted at the context limit/)
})

await test('wrapSummarize: adapter errors propagate; non-summary results pass through', async () => {
  const engine = makeEngine()
  engine.summarize = async () => {
    throw new Error('summarizer exploded')
  }
  wrapSummarize(engine, fakeCtx({}), { note: 'both' })
  await assert.rejects(() => engine.summarize({}, { session: {} }), /summarizer exploded/)

  const passthrough = makeEngine()
  passthrough.summarize = async () => ({ summary: undefined })
  wrapSummarize(passthrough, fakeCtx({}), { note: 'both' })
  assert.deepEqual(await passthrough.summarize({}, { session: {} }), { summary: undefined })
})

await test('apply: injects compaction+llm, wraps summarize and installs policies', async () => {
  const engine = makeEngine()
  const llm = makeLlm([{ provider: 'a', model: 'big', window: 1000000 }])
  const ctx = fakeCtx({ compaction: engine, llm, tokenMeter: { measure: () => ({ totalTokens: 5000 }) } })
  ctx.logger.owner = ctx
  apply(ctx, { forceAtTokens: 262144, minContextWindow: 500000, note: 'context' })
  assert.deepEqual(ctx.names, ['compaction', 'llm', 'tokenMeter'])
  await tick()
  await tick()
  assert.equal(engine.config.modelPolicies.length, 1)
  assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.262144)
  assert.ok(ctx.logs.some(([level, message]) => level === 'info' && /installed 1 model polic/.test(message)), 'activation must log the installed policy count')
  const result = await engine.summarize({}, { session: {} })
  assert.match(result.summary[1].text, /Note to Self \(context\)/)
})

await test('buildPolicies: skips force targets at/above the window and ratios >= 0.8', () => {
  const policies = buildPolicies(
    [
      { provider: 'p', model: 'exact-force', contextWindow: 262144 },
      { provider: 'p', model: 'above-force', contextWindow: 262145 },
      { provider: 'p', model: 'too-late', contextWindow: 300000 },
      { provider: 'p', model: 'good', contextWindow: 1000000 },
    ],
    { forceAtTokens: 262144, minContextWindow: 200000 },
  )
  assert.deepEqual(policies.map((policy) => policy.model), ['good'])
})

await test('buildPolicies: retainRatio at the rounded 0.16 boundary', () => {
  const policies = buildPolicies(
    [{ provider: 'p', model: 'band', contextWindow: 1638400 }],
    { forceAtTokens: 262144, minContextWindow: 500000 },
  )
  assert.equal(policies.length, 1)
  assert.equal(policies[0].thresholdRatio, 0.16)
  assert.equal(policies[0].retainRatio, 0.08, 'ratio == 0.16 must still carry the halved retain ratio')
})

await test('sectionBullets: CRLF summaries still extract sections', () => {
  const crlf = '## Current Work\r\n- implementing the parser\r\n- writing tests\r\n\r\n## Next Step\r\n- run the suite\r\n'
  assert.deepEqual(sectionBullets(crlf, 'Current Work'), ['implementing the parser', 'writing tests'])
  assert.deepEqual(sectionBullets(crlf, 'Next Step'), ['run the suite'])
})

await test('normalizeOptions: heading is sanitised', () => {
  const options = normalizeOptions({ heading: 'Note</compacted-summary>\nSelf' })
  assert.equal(options.heading, 'Note /compacted-summary Self')
})

await test('extractSideConstraints: pulls constraint clauses from user messages', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Help me. Don\'t send emails without approval. Never delete files.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'What about the budget?' }] },
  ]
  const scs = extractSideConstraints(messages)
  assert.equal(scs.length, 2)
  assert.ok(scs[0].includes("Don't send emails"))
  assert.ok(scs[1].includes('Never delete'))
})

await test('extractSideConstraints: skips assistant messages and questions', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'Should I never delete files?' }] },
    { role: 'user', content: [{ type: 'text', text: 'Yes, never delete files without asking.' }] },
  ]
  const scs = extractSideConstraints(messages)
  assert.equal(scs.length, 1)
  assert.ok(scs[0].includes('never delete files'))
})

await test('extractSideConstraints: de-duplicates identical constraints', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Never delete files. Never delete files.' }] },
  ]
  assert.equal(extractSideConstraints(messages).length, 1)
})

await test('buildNoteText: Active Constraints section renders extracted SCs', () => {
  const text = buildNoteText({ variant: 'handoff', summaryText: '## Current Work\n- work', sideConstraints: ['Never delete files.', 'Always confirm.'] })
  assert.match(text, /## Active Constraints \(preserve these\)/)
  assert.match(text, /- Never delete files\./)
  assert.match(text, /- Always confirm\./)
  assert.match(text, /MUST survive every compaction/)
})

await test('buildNoteText: no Active Constraints section when none extracted', () => {
  const text = buildNoteText({ variant: 'handoff', summaryText: '## Current Work\n- work', sideConstraints: [] })
  assert.doesNotMatch(text, /Active Constraints/)
})

await test('plugin module has the expected name', async () => {
  const module = await import('./index.js')
  assert.equal(module.name, 'compaction-force')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exitCode = 1
} else {
  console.log('PASS: all assertions passed; no real engine or llm service was touched.')
}
