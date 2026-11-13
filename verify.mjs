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
    callback({ ...services, effect: (setup) => setup() })
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
  assert.deepEqual(ctx.names, ['compaction', 'llm'])
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

await test('buildPolicies: tiny scaled targets keep valid retention or skip a zero threshold', () => {
  const catalog = (window) => [{ provider: 'p', model: 'scaled', contextWindow: window }]
  const policies = buildPolicies(catalog(1000000), { forceAtTokens: 1 })
  assert.equal(policies.length, 1)
  assert.equal(policies[0].thresholdRatio, 0.000001)
  assert.ok(policies[0].retainRatio > 0 && policies[0].retainRatio < policies[0].thresholdRatio)
  assert.deepEqual(buildPolicies(catalog(3000000), { forceAtTokens: 1 }), [])
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

await test('buildPolicies: resolves customized retention instead of assuming the default 0.16', () => {
  const models = [{ provider: 'p', model: 'm', contextWindow: 1000000 }]
  // A service-level retainRatio of 0.3 is valid alone but >= the forced
  // 0.262144 threshold; the generated row must carry a valid explicit retention.
  const policies = buildPolicies(models, { forceAtTokens: 262144, minContextWindow: 500000 }, {
    serviceConfig: { retainRatio: 0.3 },
  })
  assert.equal(policies.length, 1)
  assert.equal(policies[0].thresholdRatio, 0.262144)
  assert.equal(policies[0].retainRatio, 0.131072)
  assert.ok(policies[0].retainRatio > 0 && policies[0].retainRatio < policies[0].thresholdRatio)
})

await test('buildPolicies: a valid inherited ratio stays lean; an invalid one is overridden', () => {
  const models = [{ provider: 'p', model: 'm', contextWindow: 1000000 }]
  const lean = buildPolicies(models, { forceAtTokens: 262144, minContextWindow: 500000 }, {
    serviceConfig: { retainRatio: 0.1 },
  })
  assert.equal(lean[0].retainRatio, undefined, 'a valid inherited ratio needs no explicit override')
  const overridden = buildPolicies(models, { forceAtTokens: 262144, minContextWindow: 500000 }, {
    serviceConfig: { retainRatio: 0.5 },
  })
  assert.ok(overridden[0].retainRatio > 0 && overridden[0].retainRatio < 0.262144)
})

await test('buildPolicies: retainTokens mode keeps a valid tail and shrinks an impossible one', () => {
  const models = [{ provider: 'p', model: 'm', contextWindow: 1000000 }]
  const valid = buildPolicies(models, { forceAtTokens: 262144, minContextWindow: 500000 }, {
    serviceConfig: { retainTokens: 2000 },
  })
  assert.equal(valid[0].retainTokens, undefined, 'a valid retained tail needs no override')
  assert.equal(valid[0].retainRatio, undefined, 'retainTokens mode must not emit retainRatio')
  const impossible = buildPolicies(models, { forceAtTokens: 262144, minContextWindow: 500000 }, {
    serviceConfig: { retainTokens: 300000 },
  })
  assert.equal(impossible[0].retainTokens, 131072, 'a tail at/above the max threshold tokens must shrink below it')
})

await test('installPolicies: same-key replacement preserves unrelated per-model fields', async () => {
  const engine = makeEngine()
  const existing = {
    provider: 'test', model: 'scaled',
    headroomTokens: 12345, maxTokens: 99999,
    summarizationProvider: 'octo', summarizationModel: 'squid',
    retainTokens: 2000,
    thresholdRatio: 0.4,
  }
  engine.config = Object.freeze({ ...engine.config, modelPolicies: [existing] })
  const llm = makeLlm([{ provider: 'test', model: 'scaled', window: 1000000 }])
  const installed = await installPolicies(engine, llm, { forceAtTokens: 262144, minContextWindow: 500000 })
  assert.equal(installed, 1)
  const row = engine.config.modelPolicies[0]
  assert.equal(row.headroomTokens, 12345)
  assert.equal(row.maxTokens, 99999)
  assert.equal(row.summarizationProvider, 'octo')
  assert.equal(row.summarizationModel, 'squid')
  assert.equal(row.retainTokens, 2000)
  assert.equal(row.thresholdRatio, 0.262144)
  assert.equal(row.retainRatio, undefined, 'tokens mode must not gain a ratio')
})

await test('installPolicies: same-key merge replaces a now-invalid retention with a valid one', async () => {
  const engine = makeEngine()
  engine.config = Object.freeze({ ...engine.config, retainRatio: 0.3, modelPolicies: [] })
  const llm = makeLlm([{ provider: 'test', model: 'scaled', window: 1000000 }])
  await installPolicies(engine, llm, { forceAtTokens: 262144, minContextWindow: 500000 })
  const row = engine.config.modelPolicies[0]
  assert.equal(row.thresholdRatio, 0.262144)
  assert.ok(row.retainRatio > 0 && row.retainRatio < row.thresholdRatio)
})

await test('extractSideConstraints: multiline unpunctuated bullets all survive', () => {
  const bullets = [
    'Never deploy without explicit approval',
    'Always run the full test suite first',
    'Do not touch the live profile',
    'Never push directly to main',
    'Always create a branch for changes',
    'Do not send emails without review',
    'Never share credentials in chat',
    'Always wait for review before merging',
  ]
  const extracted = extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: bullets.join('\n') }] }])
  assert.equal(extracted.length, bullets.length, `expected ${bullets.length} constraints, got ${extracted.length}`)
  for (const bullet of bullets) {
    assert.ok(extracted.some((candidate) => candidate.toLowerCase().includes(bullet.toLowerCase())), `missing bullet: ${bullet}`)
  }
})

await test('extractSideConstraints: repeated checkpoints carry prior constraints forward without synthetic text', () => {
  const seven = [
    'Never share credentials with third parties.',
    'Always show the diff before applying changes.',
    'Do not install packages without asking first.',
    'Never send messages to customers directly.',
    'Always wait for my approval before merging.',
    'Do not change the live profile without authorization.',
    'Never delete files outside the workspace.',
  ]
  const firstRound = [{ role: 'user', content: [{ type: 'text', text: seven.join(' ') }] }]
  const prior = extractSideConstraints(firstRound)
  assert.equal(prior.length, 7)
  const note = buildNoteText({ variant: 'handoff', summaryText: '## Current Work\n- work', sideConstraints: prior })
  const checkpointText = `Framed checkpoint text.\n${note}`
  const secondRound = [
    { role: 'user', content: [{ type: 'text', text: checkpointText }] },
    { role: 'user', content: [{ type: 'text', text: 'Never deploy without approval.' }] },
  ]
  const extracted = extractSideConstraints(secondRound)
  assert.ok(extracted.some((candidate) => /never deploy without approval/i.test(candidate)), 'new genuine instruction must survive repeated compaction')
  assert.ok(extracted.some((candidate) => /never share credentials with third parties/i.test(candidate)), 'prior genuine constraints must be carried forward')
  assert.ok(!extracted.some((candidate) => /MUST survive every compaction/i.test(candidate)), 'generated footer must never be counted as a constraint')
  assert.ok(!extracted.some((candidate) => /authoritative record of that span/i.test(candidate)), 'generated authority line must never be counted')
  assert.ok(!extracted.some((candidate) => /Active Constraints \(preserve these\)/i.test(candidate)), 'generated section heading must never be scooped up')
  assert.equal(extracted.length, 8, `7 prior + 1 new constraint expected, got ${extracted.length}`)
})

await test('extractSideConstraints: genuine constraints survive across three compactions', () => {
  const first = ['Never merge without a second review.', 'Always keep a backup before refactors.']
  const note1 = buildNoteText({ variant: 'handoff', summaryText: '## Current Work\n- work', sideConstraints: first })
  const round2 = [
    { role: 'user', content: [{ type: 'text', text: `Framed.\n${note1}` }] },
    { role: 'user', content: [{ type: 'text', text: 'Do not touch prod directly.' }] },
  ]
  const second = extractSideConstraints(round2)
  assert.equal(second.length, 3)
  const note2 = buildNoteText({ variant: 'handoff', summaryText: '## Current Work\n- work', sideConstraints: second })
  const round3 = [
    { role: 'user', content: [{ type: 'text', text: `Framed.\n${note2}` }] },
    { role: 'user', content: [{ type: 'text', text: 'Always wait for sign-off before shipping.' }] },
  ]
  const third = extractSideConstraints(round3)
  assert.ok(third.some((candidate) => /never merge without a second review/i.test(candidate)))
  assert.ok(third.some((candidate) => /do not touch prod directly/i.test(candidate)))
  assert.ok(third.some((candidate) => /wait for sign-off before shipping/i.test(candidate)))
  assert.equal(third.length, 4)
})

await test('extractSideConstraints: a pure plugin checkpoint carries its genuine constraints, never the footer', () => {
  const note = buildNoteText({
    variant: 'both',
    summaryText: '## Current Work\n- work',
    sideConstraints: ['Never deploy without approval.'],
  })
  const extracted = extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: note }] }])
  assert.equal(extracted.length, 1, 'the genuine prior constraint must be carried forward')
  assert.ok(/never deploy without approval/i.test(extracted[0]))
  assert.ok(!/MUST survive every compaction/i.test(extracted[0]), 'the generated footer must never be extracted')
})

await test('extractSideConstraints: numbered bullets are normalized before extraction', () => {
  const extracted = extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: '1. Never deploy without approval.\n2. Always show the diff.' }] }])
  assert.equal(extracted.length, 2)
  assert.ok(extracted[0].startsWith('Never deploy'))
  assert.ok(extracted[1].startsWith('Always show'))
})

await test('extractSideConstraints: genuine text after a generated note in the same block survives', () => {
  const note = buildNoteText({
    variant: 'handoff',
    summaryText: '## Current Work\n- work',
    sideConstraints: ['Never deploy without approval.'],
  })
  const block = `${note}\nAlso, never edit /etc.`
  const extracted = extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: block }] }])
  assert.equal(extracted.length, 2, 'prior constraint plus trailing genuine constraint must both survive')
  assert.ok(/never edit \/etc/i.test(extracted.some((candidate) => /never edit \/etc/i.test(candidate)) ? extracted.find((candidate) => /never edit \/etc/i.test(candidate)) : ''))
})

await test('extractSideConstraints: custom handoff heading is also skipped', () => {
  const heading = 'Note to Self (checkpoint)'
  const note = buildNoteText({ variant: 'handoff', heading, summaryText: '## Critical Context\n- never edit /etc', sideConstraints: [] })
  const extracted = extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: note }] }], { heading })
  assert.equal(extracted.length, 0, 'the configured handoff section must not leak constraint-looking bullets')
})

await test('extractSideConstraints: the cap keeps the newest constraints', () => {
  const oldest = Array.from({ length: 8 }, (_, i) => `Never do action ${i + 1} outside the workspace.`)
  const newest = 'Never deploy to production on Fridays.'
  const extracted = extractSideConstraints([
    { role: 'user', content: [{ type: 'text', text: oldest.join(' ') }] },
    { role: 'user', content: [{ type: 'text', text: newest }] },
  ])
  assert.equal(extracted.length, 8)
  assert.ok(extracted.includes(newest), 'freshest constraint must survive the cap')
  assert.ok(!extracted.includes(oldest[7]), 'the oldest message should yield its last slot')
})

await test('extractSideConstraints: an over-long single-line bullet is truncated, not dropped', () => {
  const long = ('Never deploy a change that has not been reviewed by at least two independent reviewers and validated end to end in staging before it reaches the production fleet, since a single unverified deploy can corrupt user data for hours. ').repeat(3).trim()
  assert.ok(long.length > 400)
  const extracted = extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: long }] }])
  assert.equal(extracted.length, 1)
  assert.ok(extracted[0].startsWith('Never deploy a change'))
  assert.ok(extracted[0].length <= 240 || extracted[0].endsWith('...'))
})

await test('normalizeOptions: numeric strings are coerced, not silently ignored', () => {
  assert.equal(normalizeOptions({ forceAtTokens: '1000', minContextWindow: '2000' }).forceAtTokens, 1000)
  assert.equal(normalizeOptions({ forceAtTokens: '1000', minContextWindow: '2000' }).minContextWindow, 2000)
  assert.equal(normalizeOptions({ forceAtTokens: 'not-a-number' }).forceAtTokens, DEFAULTS.forceAtTokens)
  assert.equal(normalizeOptions({ forceAtTokens: '' }).forceAtTokens, DEFAULTS.forceAtTokens)
})

await test('buildPolicies: numeric string forceAtTokens is honored', () => {
  const policies = buildPolicies(
    [{ provider: 'p', model: 'm', contextWindow: 1000000 }],
    { forceAtTokens: '1000', minContextWindow: '500000' },
  )
  assert.equal(policies[0].thresholdRatio, 0.001)
})

await test('normalizeOptions: heading that sanitizes to empty falls back to the default', () => {
  assert.equal(normalizeOptions({ heading: '<>' }).heading, DEFAULTS.heading)
  assert.equal(normalizeOptions({ heading: '<>\n' }).heading, DEFAULTS.heading)
  assert.equal(normalizeOptions({ heading: 'Real Heading' }).heading, 'Real Heading')
})

await test('extractSideConstraints: de-duplication ignores trailing punctuation', () => {
  const extracted = extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: 'Never deploy. never deploy! Never deploy?' }] }])
  assert.equal(extracted.length, 1)
})

await test('buildNoteText: sanitizes constraints so injected markdown cannot escape', () => {
  const text = buildNoteText({ variant: 'handoff', summaryText: '## Current Work\n- work', sideConstraints: ['Never deploy.\n## Injected heading'] })
  assert.match(text, /- Never deploy\. ## Injected heading/)
  assert.doesNotMatch(text, /## Injected heading\s*$/)
})

await test('installPolicies: tolerates a malformed pre-existing row instead of aborting', async () => {
  const engine = makeEngine()
  engine.config = Object.freeze({ ...engine.config, modelPolicies: [null, { provider: 'x', model: 'y', thresholdRatio: 0.7 }] })
  const llm = makeLlm([{ provider: 'a', model: 'big', window: 1000000 }])
  const installed = await installPolicies(engine, llm, { forceAtTokens: 262144, minContextWindow: 500000 })
  assert.equal(installed, 1)
  assert.deepEqual(engine.config.modelPolicies, [
    { provider: 'x', model: 'y', thresholdRatio: 0.7 },
    { provider: 'a', model: 'big', thresholdRatio: 0.262144 },
  ])
})

await test('apply: installs policies even when summarize is not a function', async () => {
  const engine = makeEngine()
  engine.summarize = undefined
  const llm = makeLlm([{ provider: 'a', model: 'big', window: 1000000 }])
  const ctx = fakeCtx({ compaction: engine, llm, tokenMeter: { measure: () => ({ totalTokens: 5000 }) } })
  ctx.logger.owner = ctx
  apply(ctx, { forceAtTokens: 262144, minContextWindow: 500000, note: 'context' })
  await tick()
  await tick()
  assert.equal(engine.config.modelPolicies.length, 1)
  assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.262144)
})

await test('apply: a second instance still installs policies while the first holds the wrapper', async () => {
  const engine = makeEngine()
  const llmA = makeLlm([{ provider: 'a', model: 'mA', window: 1000000 }])
  const llmB = makeLlm([{ provider: 'b', model: 'mB', window: 2000000 }])
  const ctxA = fakeCtx({ compaction: engine, llm: llmA, tokenMeter: { measure: () => ({ totalTokens: 5000 }) } })
  const ctxB = fakeCtx({ compaction: engine, llm: llmB, tokenMeter: { measure: () => ({ totalTokens: 5000 }) } })
  ctxA.logger.owner = ctxA
  ctxB.logger.owner = ctxB
  apply(ctxA, { forceAtTokens: 262144, minContextWindow: 500000, note: 'context' })
  apply(ctxB, { forceAtTokens: 262144, minContextWindow: 500000, note: 'handoff' })
  await tick()
  await tick()
  const rows = engine.config.modelPolicies.map((row) => row.model)
  assert.ok(rows.includes('mA'), 'first instance must still install its policies')
  assert.ok(rows.includes('mB'), 'second instance must install its policies despite the active wrapper')
  assert.equal(engine.summarizeCalls, 0, 'owned wrapper must not stack')
  const result = await engine.summarize({}, { session: {} })
  assert.equal(result.summary.length, 2, 'exactly one wrapper must append its note')
})

await test('apply: with no llm service installs nothing and does not crash', async () => {
  const engine = makeEngine()
  const ctx = fakeCtx({ compaction: engine, tokenMeter: { measure: () => ({ totalTokens: 5000 }) } })
  ctx.logger.owner = ctx
  apply(ctx, { forceAtTokens: 262144, minContextWindow: 500000 })
  await tick()
  await tick()
  assert.equal(engine.config.modelPolicies.length, 0, 'no llm means no policies')
  assert.deepEqual(await catalogFor(undefined), [])
  assert.deepEqual(await catalogFor(null), [])
})

await test('plugin module has the expected name', async () => {
  const module = await import('./index.js')
  assert.equal(module.name, 'compaction-force')
})

await test('extractSideConstraints: ignores framed <compacted-summary> sections across blocks and keeps prior constraints', () => {
  const summaryBody = [
    '## Primary Request and Intent',
    '- We must support multi-tenant isolation.',
    '- The system should not expose internal metrics.',
    '## Key Technical Concepts',
    '- We must ensure connection pooling is configured properly.',
    '- Microservices should avoid tight coupling.',
    '## Errors and Fixes',
    '- Connection timeout: should not use default pool size of 5.',
    '- Migration failed: must not run without transaction wrapper.',
    '- Auth bug: avoid caching invalid JWT tokens.',
    '- Redis sync: prevent stale cache reads by invalidating on write.',
    '## Critical Context',
    '- Avoid modifying production config without peer review.',
  ].join('\n')
  const noteBlock = buildNoteText({
    variant: 'both',
    summaryText: summaryBody,
    totalTokens: 120000,
    sideConstraints: ['Never deploy without explicit approval.', 'Always ask before deleting any file.'],
  })
  const checkpointMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'Automatically generated checkpoint.\n\n<compacted-summary>' },
      { type: 'text', text: summaryBody },
      { type: 'text', text: noteBlock },
      { type: 'text', text: '</compacted-summary>\nNever push to main.' },
    ],
  }
  const extracted = extractSideConstraints([checkpointMessage])
  assert.deepEqual(extracted, [
    'Never push to main.',
    'Never deploy without explicit approval.',
    'Always ask before deleting any file.',
  ])
  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: 'Inspect <compacted-summary> format.\nAlways validate inputs.' }] }]),
    ['Always validate inputs.'],
  )
})

await test('extractSideConstraints: preserves wrapped multi-line user sentences', () => {
  const text = 'Please help me with deployment.\nAlways deploy changes\nto the staging server only.'
  const extracted = extractSideConstraints([{ role: 'user', content: [{ type: 'text', text }] }])
  assert.deepEqual(extracted, ['Always deploy changes to the staging server only.'])
})

await test('extractSideConstraints: skips indented continuations inside synthetic notes', () => {
  const block = [
    '## Note to Self (handoff)',
    '- Where I was: Refactoring auth.',
    '  We must ensure all security checks pass before deployment.',
    '- Next: Run the verification suite.',
  ].join('\n')
  assert.deepEqual(extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: block }] }]), [])
})

await test('wrapSummarize: uses normalized defaults when options are omitted or partial', async () => {
  const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Never deploy without approval.' }] }] }
  const defaultsEngine = makeEngine()
  assert.equal(wrapSummarize(defaultsEngine, fakeCtx({})), true)
  const defRes = await defaultsEngine.summarize(input, { session: {} })
  assert.equal(defRes.summary.length, 2)
  assert.match(defRes.summary[1].text, /Note to Self \(handoff\)/)
  assert.match(defRes.summary[1].text, /Never deploy without approval\./)

  const partialEngine = makeEngine()
  assert.equal(wrapSummarize(partialEngine, fakeCtx({}), { note: 'handoff' }), true)
  const partRes = await partialEngine.summarize(input, { session: {} })
  assert.match(partRes.summary[1].text, /Active Constraints \(preserve these\)/)
  assert.match(partRes.summary[1].text, /Never deploy without approval\./)
})

await test('buildPolicies: avoids zero-token thresholds and retain >= threshold collisions', () => {
  assert.deepEqual(buildPolicies([{ provider: 'p', model: 'm700k', contextWindow: 700000 }], { forceAtTokens: 1 }), [])
  const tiny = buildPolicies([{ provider: 'p', model: 'm600k', contextWindow: 600000 }], { forceAtTokens: 2 })
  assert.equal(tiny.length, 1)
  const thresholdTokens = Math.floor(600000 * tiny[0].thresholdRatio)
  const retainTokens = Math.floor(600000 * tiny[0].retainRatio)
  assert.ok(thresholdTokens >= 1, `expected thresholdTokens >= 1, got ${thresholdTokens}`)
  assert.ok(retainTokens < thresholdTokens, `expected retainTokens (${retainTokens}) < thresholdTokens (${thresholdTokens})`)
  const inheritedCollision = buildPolicies(
    [{ provider: 'p', model: 'm600k1', contextWindow: 600001 }],
    { forceAtTokens: 96001 },
    { serviceConfig: { retainRatio: 0.16 } },
  )
  assert.equal(inheritedCollision.length, 1)
  assert.ok(
    Math.floor(600001 * inheritedCollision[0].retainRatio) < Math.floor(600001 * inheritedCollision[0].thresholdRatio),
    'inherited 0.16 colliding with floor(600001 * 0.160001) must emit a lower explicit retainRatio',
  )
})

await test('apply: tolerates malformed null rows inside commit path and self-heals', async () => {
  const engine = makeEngine()
  engine.config = Object.freeze({ ...engine.config, modelPolicies: [null, { provider: 'x', model: 'y', thresholdRatio: 0.7 }] })
  const llm = makeLlm([{ provider: 'a', model: 'big', window: 1000000 }])
  const ctx = fakeCtx({ compaction: engine, llm })
  ctx.logger.owner = ctx
  apply(ctx, { forceAtTokens: 262144, minContextWindow: 500000 })
  await tick()
  await tick()
  assert.deepEqual(engine.config.modelPolicies, [
    { provider: 'x', model: 'y', thresholdRatio: 0.7 },
    { provider: 'a', model: 'big', thresholdRatio: 0.262144 },
  ])
})

await test('apply: FIFO and partial-overlap disposal of instances leaves no zombie policy', async () => {
  const engine = makeEngine()
  const llm = makeLlm([{ provider: 'a', model: 'big', window: 1000000 }])
  const disposers = []
  const makeCtx = (svcLlm = llm) => ({
    logs: [],
    logger: { info() {}, warn() {} },
    inject(_names, cb) {
      cb({
        compaction: engine,
        llm: svcLlm,
        effect(setup) {
          disposers.push(setup())
        },
      })
    },
  })
  apply(makeCtx(), { forceAtTokens: 200000 })
  await tick()
  await tick()
  assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.2)
  apply(makeCtx(), { forceAtTokens: 100000 })
  await tick()
  await tick()
  assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.1)
  disposers[0]()
  assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.1)
  disposers[1]()
  assert.deepEqual(engine.config.modelPolicies, [])

  const partialDisposers = []
  const makePartialCtx = (models) => ({
    logs: [],
    logger: { info() {}, warn() {} },
    inject(_names, cb) {
      cb({
        compaction: engine,
        llm: makeLlm(models),
        effect(setup) {
          partialDisposers.push(setup())
        },
      })
    },
  })
  apply(makePartialCtx([{ provider: 'p', model: 'mA', window: 1000000 }, { provider: 'p', model: 'mB', window: 1000000 }]), { forceAtTokens: 300000 })
  await tick(); await tick()
  apply(makePartialCtx([{ provider: 'p', model: 'mA', window: 1000000 }]), { forceAtTokens: 200000 })
  await tick(); await tick()
  apply(makePartialCtx([{ provider: 'p', model: 'mB', window: 1000000 }]), { forceAtTokens: 100000 })
  await tick(); await tick()
  partialDisposers[1]()
  assert.equal(engine.config.modelPolicies.find((r) => r.model === 'mA').thresholdRatio, 0.3)
  assert.equal(engine.config.modelPolicies.find((r) => r.model === 'mB').thresholdRatio, 0.1)
  partialDisposers[0]()
  assert.deepEqual(engine.config.modelPolicies.map((r) => [r.model, r.thresholdRatio]), [['mB', 0.1]])
  partialDisposers[2]()
  assert.deepEqual(engine.config.modelPolicies, [])
})

await test('buildPolicies: preserves leaner inherited retainRatio when thresholdRatio <= 0.16', () => {
  const models = [{ provider: 'p', model: 'band', contextWindow: 1638400 }]
  const serviceLean = buildPolicies(models, { forceAtTokens: 262144, minContextWindow: 500000 }, {
    serviceConfig: { retainRatio: 0.05 },
  })
  assert.equal(serviceLean[0].thresholdRatio, 0.16)
  assert.equal(serviceLean[0].retainRatio, undefined)

  const rowLean = buildPolicies(
    [{ provider: 'p', model: 'large', contextWindow: 2000000 }],
    { forceAtTokens: 262144, minContextWindow: 500000 },
    { previousRows: [{ provider: 'p', model: 'large', retainRatio: 0.01 }] },
  )
  assert.equal(rowLean[0].thresholdRatio, 0.131072)
  assert.equal(rowLean[0].retainRatio, undefined)

  const invalidZero = buildPolicies(
    [{ provider: 'p', model: 'zero', contextWindow: 2000000 }],
    { forceAtTokens: 262144, minContextWindow: 500000 },
    { serviceConfig: { retainRatio: 0 } },
  )
  assert.equal(invalidZero[0].retainRatio, 0.065536)

  const unroundedLean = buildPolicies(
    [{ provider: 'p', model: 'unrounded', contextWindow: 2000000 }],
    { forceAtTokens: 262144, minContextWindow: 500000 },
    { serviceConfig: { retainRatio: 0.1310719 } },
  )
  assert.equal(unroundedLean[0].retainRatio, undefined)
})

await test('buildPolicies and apply: preserve tighter thresholds and tolerate null args or BigInt note', () => {
  const models = [{ provider: 'p', model: 'm', contextWindow: 1000000 }]
  assert.deepEqual(
    buildPolicies(models, { forceAtTokens: 262144, minContextWindow: 500000 }, { serviceConfig: { thresholdRatio: 0.2 } }),
    [],
  )
  assert.deepEqual(
    buildPolicies(models, { forceAtTokens: 262144, minContextWindow: 500000 }, {
      previousRows: [{ provider: 'p', model: 'm', thresholdRatio: 0.1, retainRatio: 0.05 }],
      serviceConfig: { thresholdRatio: 0.8 },
    }),
    [],
  )
  assert.equal(buildPolicies(models, null, null)[0].thresholdRatio, 0.262144)

  const engine = makeEngine()
  const ctx = fakeCtx({ compaction: engine, llm: makeLlm([]) })
  ctx.logger.owner = ctx
  assert.doesNotThrow(() => apply(ctx, { note: 1n }))
  assert.ok(ctx.logs.some(([level, message]) => level === 'warn' && message.includes('unknown note value 1')))
})

await test('collectCatalog: awaits async listProviders, handles rejections and iterables, deduplicates entries', async () => {
  const asyncIterableLlm = {
    async listProviders() { return new Set([{ id: 'p' }, { id: 'p' }]) },
    async listModels() { return new Set([{ id: 'm' }, { id: 'm' }]) },
    resolveCalls: 0,
    async resolveModelInfo(provider, model) {
      this.resolveCalls += 1
      return { provider, id: model, context: { contextWindow: 1000000 } }
    },
  }
  const catalog = await collectCatalog(asyncIterableLlm)
  assert.deepEqual(catalog, [{ provider: 'p', model: 'm', contextWindow: 1000000 }])
  assert.equal(asyncIterableLlm.resolveCalls, 1)

  let unhandled = null
  const onUnhandled = (reason) => { unhandled = reason }
  process.once('unhandledRejection', onUnhandled)
  const failedCatalog = await collectCatalog({
    listProviders: () => Promise.reject(new Error('rpc transport failed')),
  })
  await tick()
  process.removeListener('unhandledRejection', onUnhandled)
  assert.deepEqual(failedCatalog, [])
  assert.equal(unhandled, null)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exitCode = 1
} else {
  console.log('PASS: all assertions passed; no real engine or llm service was touched.')
}
