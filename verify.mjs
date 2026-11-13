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

const fakeCtx = (services) => {
  const disposables = []
  return {
    tokenMeter: services.tokenMeter,
    logs: [],
    logger: {
      info(message) { this.owner.logs.push(['info', message]) },
      warn(message) { this.owner.logs.push(['warn', message]) },
      owner: null,
    },
    dispose() {
      while (disposables.length > 0) disposables.pop()()
    },
    inject(names, callback) {
      this.names = names
      callback({
        ...services,
        effect: (setup) => {
          const cleanup = setup()
          if (typeof cleanup === 'function') disposables.push(cleanup)
          return cleanup
        },
      })
    },
  }
}

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
  ctx.dispose()
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

await test('extractSideConstraints: ignores inline, fenced, and unmatched <compacted-summary> delimiters', () => {
  const inlineSummary = [
    '## Files and Code',
    '- parser.js: handles `</compacted-summary>` tags.',
    '## Current Work',
    '- Fixing </compacted-summary> parsing bug',
    '## Critical Context',
    '- Must not modify production database during migration.',
  ].join('\n')
  const inlineNote = buildNoteText({
    variant: 'both',
    summaryText: inlineSummary,
    totalTokens: 120000,
    sideConstraints: ['Never output </compacted-summary> in generated docs.'],
  })
  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [
        { type: 'text', text: 'Preamble\n\n<compacted-summary>' },
        { type: 'text', text: inlineSummary },
        { type: 'text', text: inlineNote },
        { type: 'text', text: '</compacted-summary>' },
      ],
    }]),
    ['Never output </compacted-summary> in generated docs.'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{ type: 'text', text: 'Remember: `<compacted-summary>` must always be closed by `</compacted-summary>` in tests.' }],
    }]),
    ['Remember: `<compacted-summary>` must always be closed by `</compacted-summary>` in tests.'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: '```markdown\n<compacted-summary>\n```\nNever deploy without approval.\n```markdown\n</compacted-summary>\n```',
      }],
    }]),
    ['Never deploy without approval.'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: 'Note: <compacted-summary> marks spans.\nNever deploy without running tests.\n<compacted-summary>\n## Current Work\n- reading\n</compacted-summary>',
      }],
    }]),
    ['Never deploy without running tests.'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: '<compacted-summary>\nNever deploy without running tests.\n<compacted-summary>\n## Critical Context\n- Must not leak.\n</compacted-summary>',
      }],
    }]),
    ['Never deploy without running tests.'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: '<compacted-summary>\n## Current Work\n<compacted-summary>\n- Avoid inner leaks.\n</compacted-summary>\n## Critical Context\n- Never leak outer summary.\n</compacted-summary>\nAlways verify after compaction.',
      }],
    }]),
    ['Always verify after compaction.'],
  )
})

await test('extractSideConstraints: ignores fenced code blocks and stack traces while preserving real prose', () => {
  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: 'Fixture:\n```markdown\n<compacted-summary>\n## Active Constraints (preserve these)\n- Never run rm -rf / inside fixtures.\n</compacted-summary>\n```\nAlways verify parser edge cases.',
      }],
    }]),
    ['Always verify parser edge cases.'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{ type: 'text', text: '```js\n// never mutate\nshouldThrow()\n```' }],
    }]),
    [],
  )

  const codeLines = Array.from({ length: 8 }, (_, i) => `// Never mutate state ${i + 1} directly.`).join('\n')
  assert.deepEqual(
    extractSideConstraints([
      { role: 'user', content: [{ type: 'text', text: 'Always ask before deploying to production.' }] },
      { role: 'user', content: [{ type: 'text', text: `Review:\n~~~ts\n${codeLines}\n~~~` }] },
    ]),
    ['Always ask before deploying to production.'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: '````markdown\n```js\n// Never skip checks.\n```\n````\nAlways run unit tests.',
      }],
    }]),
    ['Always run unit tests.'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: 'Got crash:\nError: must not call hook outside setup\n    at renderComponent (/app/src/render.js:42:11)\n    at processTicks (node:internal/process/task_queues:95:5)',
      }],
    }]),
    [],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: 'Traceback (most recent call last):\n  File "/app/main.py", line 10, in main\n    never_mutate()\n    ^^^^^\nRuntimeError: should not pass empty list\nAlways log tracebacks cleanly.',
      }],
    }]),
    ['Always log tracebacks cleanly.'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: 'java.lang.IllegalStateException: must not call this\n\tat com.example.App.main(App.java:10)\n\tat java.base/java.lang.Thread.run(Thread.java:833)\n\tat sun.misc.Unsafe.park(Native Method)\nCaused by: java.io.IOException: never ignore this\n\tat com.example.Io.open(Io.java:42)\nAlways handle IO exceptions.',
      }],
    }]),
    ['Always handle IO exceptions.'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: 'Uncaught (in promise) TypeError: must not be null\n    at eval (eval at foo (https://example.com/app.js:1:2), <anonymous>:1:1)\n    at https://example.com/bundle.js:10:2\nError: should not leak from firefox trace\nfn@https://example.com/app.js:1:2\n@https://example.com/app.js:1:1\nTypeError: should not leak from safari trace\nglobal code@https://example.com/app.js:42:11\nasyncFunctionResume@[native code]',
      }],
    }]),
    [],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: [
          'Always check at 12:30.',
          'Never connect at https://example.com:8080 without TLS.',
          'Always inspect https://example.com/app.js:10:20 before release.',
          'Never mail security@example.com without approval.',
          'Error handling rule.',
          'Error: never ignore non-zero exit codes.',
        ].join('\n'),
      }],
    }]),
    [
      'Always check at 12:30.',
      'Never connect at https://example.com:8080 without TLS.',
      'Always inspect https://example.com/app.js:10:20 before release.',
      'Never mail security@example.com without approval.',
      'Error: never ignore non-zero exit codes.',
    ],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: '- Always keep database backups.\n```sh\nrm -rf /tmp\n```\n  Never drop staged tables.\nNever bypass review:\nError: must not fail silently\n    at main (/app/index.js:1:1)\nand ensure alerts fire.',
      }],
    }]),
    [
      'Always keep database backups.',
      'Never drop staged tables.',
      'Never bypass review:',
    ],
  )
})

await test('extractSideConstraints: preserves wrapped multi-line user sentences', () => {
  const text = 'Please help me with deployment.\nAlways deploy changes\nto the staging server only.'
  const extracted = extractSideConstraints([{ role: 'user', content: [{ type: 'text', text }] }])
  assert.deepEqual(extracted, ['Always deploy changes to the staging server only.'])
})

await test('extractSideConstraints: splits sentences accurately across wraps, abbreviations, quotes, and multi-block messages', () => {
  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: 'Always run tests. Never skip\nCI checks.' }] }]),
    ['Always run tests.', 'Never skip CI checks.'],
  )

  for (const [text, expected] of [
    ['Never skip\n`verify.mjs` before merging.', ['Never skip `verify.mjs` before merging.']],
    ['Never edit\nREADME.md without review.', ['Never edit README.md without review.']],
    ['Always keep\n3 backups before migrating.', ['Always keep 3 backups before migrating.']],
    ['You must\nNOT modify live profiles.', ['You must NOT modify live profiles.']],
    ['Never deploy unless\nCI checks pass.', ['Never deploy unless CI checks pass.']],
  ]) {
    assert.deepEqual(extractSideConstraints([{ role: 'user', content: [{ type: 'text', text }] }]), expected)
  }

  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: 'Review docs\nNever overwrite production configs' }] }]),
    ['Never overwrite production configs'],
  )

  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: 'Never edit system files, e.g. /etc/passwd or /etc/hosts.' }] }]),
    ['Never edit system files, e.g. /etc/passwd or /etc/hosts.'],
  )

  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: 'Never deploy... unless tests pass.' }] }]),
    ['Never deploy... unless tests pass.'],
  )

  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: 'Always follow "never push to main." Never skip code review.' }] }]),
    ['Always follow "never push to main."', 'Never skip code review.'],
  )

  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: 'Did you ask "should we never deploy on Fridays?"' }] }]),
    [],
  )

  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: 'Never deploy\n1000) Always verify.\n2026) Never push to main.\n1.5) Never skip checks.' }] }]),
    ['Never deploy', '1000) Always verify.', '2026) Never push to main.', '1.5) Never skip checks.'],
  )

  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: 'Never say no. Always verify.\nNever deploy after 5 p.m. Always wait.\nAlways read docs, etc. Never skip tests.' }] }]),
    ['Never say no.', 'Always verify.', 'Never deploy after 5 p.m.', 'Always wait.', 'Always read docs, etc.', 'Never skip tests.'],
  )

  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: 'Always update docs, e.g.\nREADME.md\nNever deploy...\nunless tests pass.\nAlways follow rules...\nNever improvise.' }] }]),
    ['Always update docs, e.g. README.md', 'Never deploy... unless tests pass.', 'Always follow rules...', 'Never improvise.'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [
        { type: 'text', text: 'Never deploy\n<compacted-summary>\n## Current Work\n- working\n</compacted-summary>' },
      ],
    }]),
    ['Never deploy'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{ type: 'text', text: 'Never deploy' }, { type: 'text', text: 'without explicit approval.' }],
    }]),
    ['Never deploy without explicit approval.'],
  )
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

await test('extractSideConstraints: preserves unindented bullet continuations and splits bullet sentences', () => {
  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: '- Never deploy to production\nunless all tests pass.' }] }]),
    ['Never deploy to production unless all tests pass.'],
  )
  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: '+ Never skip checks\nbefore merging.\n1. Always verify staging\nbefore release.' }] }]),
    ['Never skip checks before merging.', 'Always verify staging before release.'],
  )
  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{ type: 'text', text: '<compacted-summary>\n## Active Constraints (preserve these)\n- Never deploy to production\n  without explicit approval\nunless all tests pass.\n</compacted-summary>' }],
    }]),
    ['Never deploy to production without explicit approval unless all tests pass.'],
  )
  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: '- Never deploy without approval.\n  Is staging ready?' }] }]),
    ['Never deploy without approval.'],
  )
  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: '- Never deploy to prod. Can we skip staging?\n- Always verify staging. Never deploy on Fridays.' }] }]),
    ['Never deploy to prod.', 'Always verify staging.', 'Never deploy on Fridays.'],
  )
})

await test('extractSideConstraints: scopes synthetic and prior sections across blank lines, summary spans, echoed headings, and custom headings', () => {
  const handoffNote = buildNoteText({ variant: 'handoff', summaryText: '## Current Work\n- working', sideConstraints: [] })
  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: `${handoffNote}\n- Never push directly to main.` }] }]),
    ['Never push directly to main.'],
  )

  const priorEightNote = buildNoteText({
    variant: 'context',
    summaryText: '## Current Work\n- working',
    sideConstraints: Array.from({ length: 8 }, (_, i) => `Never do prior ${i + 1}.`),
  })
  const blankAfterPrior = extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: `${priorEightNote}\n\nNever deploy without checking logs.` }] }])
  assert.equal(blankAfterPrior[0], 'Never deploy without checking logs.')
  assert.equal(blankAfterPrior.length, 8)

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [
        { type: 'text', text: '## Active Constraints (preserve these)\n- Real user rule: never push to main.' },
        { type: 'text', text: '<compacted-summary>\n- Summary bullet before heading: must support legacy format.\n## Current Work\n- work\n</compacted-summary>' },
      ],
    }]),
    ['Real user rule: never push to main.'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: '<compacted-summary>\n## Active Constraints (preserve these)\n- Always verify staging.\n</compacted-summary>\n<compacted-summary>\n- Leaked summary item: never trust prior span.\n</compacted-summary>',
      }],
    }]),
    ['Always verify staging.'],
  )

  const llmSummary = [
    '## Primary Request and Intent',
    '- Build parser.',
    '## Active Constraints (preserve these)',
    ...Array.from({ length: 8 }, (_, i) => `- Stale LLM paraphrase ${i + 1}: must do X${i + 1}.`),
  ].join('\n')
  const echoedNote = buildNoteText({ variant: 'handoff', summaryText: llmSummary, sideConstraints: ['Never touch prod.'] })
  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [
        { type: 'text', text: 'Preamble\n\n<compacted-summary>' },
        { type: 'text', text: llmSummary },
        { type: 'text', text: echoedNote },
        { type: 'text', text: '</compacted-summary>' },
      ],
    }]),
    ['Never touch prod.'],
  )

  const unclosedFenceSummary = '## Current Work\n```js\nconst broken = 1\n'
  const noteAfterUnclosedFence = buildNoteText({ variant: 'handoff', summaryText: unclosedFenceSummary, sideConstraints: ['Always preserve across unclosed fence.'] })
  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [
        { type: 'text', text: '<compacted-summary>' },
        { type: 'text', text: unclosedFenceSummary },
        { type: 'text', text: noteAfterUnclosedFence },
        { type: 'text', text: '</compacted-summary>' },
      ],
    }]),
    ['Always preserve across unclosed fence.'],
  )

  const tracebackSummary = [
    '## Errors and Diagnostics',
    'Traceback (most recent call last):',
    '  File "/tmp/app.py", line 12, in run',
    '    # inspect state before running',
    'ValueError: bad state',
  ].join('\n')
  const noteAfterTraceback = buildNoteText({ variant: 'handoff', summaryText: tracebackSummary, sideConstraints: ['Always preserve across traceback comments.'] })
  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [
        { type: 'text', text: '<compacted-summary>' },
        { type: 'text', text: `${tracebackSummary}\n${noteAfterTraceback}` },
        { type: 'text', text: '</compacted-summary>' },
      ],
    }]),
    ['Always preserve across traceback comments.'],
  )

  const compactEchoedSummary = [
    '## Active Constraints (preserve these)',
    '- Stale LLM paraphrase: must ignore this.',
    '## Next Step',
    '- Run tests.',
  ].join('\n')
  const compactNote = buildNoteText({ variant: 'handoff', compact: true, summaryText: compactEchoedSummary, sideConstraints: ['Never bypass compact gate.'] })
  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [
        { type: 'text', text: '<compacted-summary>' },
        { type: 'text', text: `${compactEchoedSummary}\n${compactNote}` },
        { type: 'text', text: '</compacted-summary>' },
      ],
    }], { heading: 'Next Step' }),
    ['Never bypass compact gate.'],
  )

  assert.deepEqual(
    extractSideConstraints([{
      role: 'user',
      content: [{
        type: 'text',
        text: '<compacted-summary>\n## Primary Request and Intent\n- Build parser.\n## Active Constraints (preserve these)\n- Stale echoed item: never trust this.\n## Next Step\n- Run tests.\n</compacted-summary>',
      }],
    }]),
    [],
  )

  const customNote = buildNoteText({ variant: 'handoff', heading: 'Custom Handoff', summaryText: '## Critical Context\n- never edit /etc' })
  assert.deepEqual(extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: customNote }] }], { heading: '  Custom   Handoff  ' }), [])
  const defaultNote = buildNoteText({ variant: 'handoff', summaryText: '## Critical Context\n- never edit /etc' })
  assert.deepEqual(extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: defaultNote }] }], { heading: '' }), [])
  assert.deepEqual(
    extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: '## Current Work\n- Always run unit tests before editing.' }] }], { heading: 'Current Work' }),
    ['Always run unit tests before editing.'],
  )
})

await test('extractSideConstraints: deduplicates over-long truncated constraints, matches negative contractions, preserves balanced backticks, and orders checkpoints chronologically', () => {
  const longConstraint = 'Never deploy any service modification to the production cluster without first obtaining written sign-off from at least two senior engineers and running the complete end-to-end integration test suite across both staging regions and verifying metrics.'
  const firstLong = extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: longConstraint }] }])
  assert.equal(firstLong.length, 1)
  assert.ok(firstLong[0].length <= 240)
  const cpLong = {
    role: 'user',
    content: [
      { type: 'text', text: '<compacted-summary>' },
      { type: 'text', text: buildNoteText({ variant: 'handoff', summaryText: '## Current Work\n- work', sideConstraints: firstLong }) },
      { type: 'text', text: '</compacted-summary>' },
    ],
  }
  assert.deepEqual(extractSideConstraints([cpLong, { role: 'user', content: [{ type: 'text', text: longConstraint }] }]), firstLong)

  const longCode = `Never run \`${'a/'.repeat(120)}script.sh\` without checking permissions first.`
  const truncCode = extractSideConstraints([{ role: 'user', content: [{ type: 'text', text: longCode }] }])
  assert.equal(truncCode.length, 1)
  assert.ok(truncCode[0].length <= 240)
  assert.equal((truncCode[0].match(/`/g) || []).length % 2, 0)

  const contractions = extractSideConstraints([{
    role: 'user',
    content: [{
      type: 'text',
      text: "You cannot push directly to main.\nYou can't modify files outside src/.\nWe mustn't drop database tables.\nYou shouldn't skip the linter.\nYou can’t bypass checks.\nThis change won't compile cleanly yet.",
    }],
  }])
  assert.deepEqual(contractions, [
    'You cannot push directly to main.',
    "You can't modify files outside src/.",
    "We mustn't drop database tables.",
    "You shouldn't skip the linter.",
    'You can’t bypass checks.',
  ])

  const cp1 = { role: 'user', content: [{ type: 'text', text: `<compacted-summary>\n${buildNoteText({ variant: 'handoff', sideConstraints: ['Never A1.'] })}\n</compacted-summary>` }] }
  const midOlderUser = { role: 'user', content: [{ type: 'text', text: Array.from({ length: 8 }, (_, i) => `Always old ${i + 1}.`).join('\n') }] }
  const cp2Newer = { role: 'user', content: [{ type: 'text', text: `<compacted-summary>\n${buildNoteText({ variant: 'handoff', sideConstraints: ['Never newer C1.'] })}\n</compacted-summary>` }] }
  const ordered = extractSideConstraints([cp1, midOlderUser, cp2Newer])
  assert.equal(ordered[0], 'Never newer C1.')
  assert.equal(ordered.length, 8)
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
  ctx.dispose()
  assert.ok(ctx.logs.some(([level, message]) => level === 'warn' && message.includes('unknown note value 1')))
})

await test('collectCatalog: awaits async listProviders, handles rejections and iterables, deduplicates entries', async () => {
  const asyncIterableLlm = {
    listModelsCalls: 0,
    async listProviders() { return new Set([{ id: 'p' }, 'p']) },
    async listModels() {
      this.listModelsCalls += 1
      return new Set([{ id: 'm' }, 'm'])
    },
    resolveCalls: 0,
    async resolveModelInfo(provider, model) {
      this.resolveCalls += 1
      return { provider, id: model, context: { contextWindow: 1000000 } }
    },
  }
  const catalog = await collectCatalog(asyncIterableLlm)
  assert.deepEqual(catalog, [{ provider: 'p', model: 'm', contextWindow: 1000000 }])
  assert.equal(asyncIterableLlm.listModelsCalls, 1)
  assert.equal(asyncIterableLlm.resolveCalls, 1)

  const throwingIteratorLlm = {
    listProviders() {
      return {
        *[Symbol.iterator]() {
          yield 'p'
          throw new Error('iterator boom')
        },
      }
    },
    async listModels() { return ['m'] },
    async resolveModelInfo(provider, model) { return { provider, id: model, context: { contextWindow: 1000000 } } },
  }
  assert.deepEqual(await collectCatalog(throwingIteratorLlm), [{ provider: 'p', model: 'm', contextWindow: 1000000 }])

  let unhandled = null
  const onUnhandled = (reason) => { unhandled = reason }
  process.once('unhandledRejection', onUnhandled)
  let failedCatalog
  try {
    failedCatalog = await collectCatalog({
      listProviders: () => Promise.reject(new Error('rpc transport failed')),
    })
    await tick()
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
  assert.deepEqual(failedCatalog, [])
  assert.equal(unhandled, null)
})

await test('catalogFor and apply: unwrap Cordis proxy keys, avoid poisoning empty cache, preserve cache on filter miss, and refresh on adapters-updated', async () => {
  const ORIGINAL = Symbol.for('cordis.original')
  const baseLlm = makeLlm([{ provider: 'a', model: 'small', window: 100000 }])
  const proxyA = new Proxy(baseLlm, {
    get(target, prop, receiver) {
      if (prop === ORIGINAL) return target
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const proxyB = new Proxy(baseLlm, {
    get(target, prop, receiver) {
      if (prop === ORIGINAL) return target
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  await catalogFor(proxyA)
  await catalogFor(proxyB)
  assert.equal(baseLlm.calls.resolve, 1)

  const strictCtx = {
    logs: [],
    logger: { info() {}, warn() {} },
    inject(names, cb) { cb({ compaction: makeEngine(), llm: proxyA, effect: (fn) => fn() }) },
  }
  apply(strictCtx, { minContextWindow: 500000 })
  await tick()
  await catalogFor(proxyB)
  assert.equal(baseLlm.calls.resolve, 1)

  let ready = false
  const lateLlm = {
    listProviders: () => [{ id: 'late', name: 'late' }],
    listModels: async () => (ready ? [{ provider: 'late', id: 'big', name: 'big' }] : []),
    resolveModelInfo: async () => ({ provider: 'late', id: 'big', context: { contextWindow: 1000000 } }),
  }
  assert.deepEqual(await catalogFor(lateLlm), [])
  ready = true
  assert.deepEqual(await catalogFor(lateLlm), [{ provider: 'late', model: 'big', contextWindow: 1000000 }])

  let dynamicCatalog = [{ provider: 'a', model: 'm1', window: 1000000 }]
  let firstStarted
  let releaseFirst
  let callIndex = 0
  const firstReady = new Promise((resolve) => { firstStarted = resolve })
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const dynamicLlm = {
    listProviders: () => [{ id: 'a', name: 'a' }],
    async listModels() {
      callIndex += 1
      if (callIndex === 1) {
        firstStarted()
        await firstGate
      }
      return dynamicCatalog.map((m) => ({ provider: m.provider, id: m.model, name: m.model }))
    },
    resolveModelInfo: async (provider, model) => {
      const hit = dynamicCatalog.find((m) => m.provider === provider && m.model === model)
      return { provider, id: model, context: { contextWindow: hit.window } }
    },
  }
  const engine = makeEngine()
  const listeners = new Set()
  let disposeEffect = null
  const eventCtx = {
    logs: [],
    logger: { info() {}, warn() {} },
    inject(names, cb) {
      cb({
        compaction: engine,
        llm: dynamicLlm,
        on(event, fn) {
          if (event === 'llm/adapters-updated') listeners.add(fn)
          return () => listeners.delete(fn)
        },
        effect(fn) {
          disposeEffect = fn()
          return disposeEffect
        },
      })
    },
  }
  apply(eventCtx, { forceAtTokens: 200000, minContextWindow: 500000 })
  await firstReady
  dynamicCatalog = [
    { provider: 'a', model: 'm1', window: 1000000 },
    { provider: 'a', model: 'm2', window: 1000000 },
  ]
  for (const fn of listeners) fn()
  releaseFirst()
  await tick()
  await tick()
  assert.deepEqual(engine.config.modelPolicies.map((p) => p.model), ['m1', 'm2'])
  assert.equal(listeners.size, 1)
  disposeEffect()
  assert.equal(listeners.size, 0)
  assert.deepEqual(engine.config.modelPolicies, [])

  let retryCatalogReady = false
  const timers = []
  const savedSetTimeout = globalThis.setTimeout
  const savedClearTimeout = globalThis.clearTimeout
  const retryEngine = makeEngine()
  let disposeRetry = null
  globalThis.setTimeout = (fn, delay, ...args) => {
    if (delay !== 500 && delay !== 2000) return savedSetTimeout(fn, delay, ...args)
    const id = { fn }
    timers.push(id)
    return id
  }
  globalThis.clearTimeout = (id) => {
    const idx = timers.indexOf(id)
    if (idx !== -1) timers.splice(idx, 1)
    else savedClearTimeout(id)
  }
  try {
    const retryLlm = {
      listProviders: () => [{ id: 'r', name: 'r' }],
      listModels: async () => (retryCatalogReady ? [{ provider: 'r', id: 'big', name: 'big' }] : []),
      resolveModelInfo: async () => ({ provider: 'r', id: 'big', context: { contextWindow: 1000000 } }),
    }
    apply({
      logs: [],
      logger: { info() {}, warn() {} },
      inject(names, cb) {
        cb({
          compaction: retryEngine,
          llm: retryLlm,
          effect(fn) {
            disposeRetry = fn()
            return disposeRetry
          },
        })
      },
    }, { forceAtTokens: 200000, minContextWindow: 500000 })
    await tick()
    assert.equal(timers.length, 1)
    retryCatalogReady = true
    timers.shift().fn()
    await tick()
    assert.deepEqual(retryEngine.config.modelPolicies.map((p) => p.model), ['big'])
  } finally {
    disposeRetry?.()
    globalThis.setTimeout = savedSetTimeout
    globalThis.clearTimeout = savedClearTimeout
  }
})

await test('apply: FIFO disposal across non-extensible Cordis proxies shares receipt tracking without leaking prior rows', async () => {
  const ORIGINAL = Symbol.for('cordis.original')
  const targetEngine = Object.preventExtensions(makeEngine())
  const wrapProxy = (target) => Object.preventExtensions(new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === ORIGINAL) return obj
      return Reflect.get(obj, prop, receiver)
    },
    set(obj, prop, value, receiver) {
      return Reflect.set(obj, prop, value, receiver)
    },
  }))
  const proxy1 = wrapProxy(targetEngine)
  const proxy2 = wrapProxy(targetEngine)
  const llm = makeLlm([{ provider: 'p', model: 'big', window: 1000000 }])
  const disposers = []
  const mount = (engineProxy, forceAtTokens) => apply({
    logs: [],
    logger: { info() {}, warn() {} },
    inject(names, cb) {
      cb({
        compaction: engineProxy,
        llm,
        effect(fn) {
          const dispose = fn()
          disposers.push(dispose)
          return dispose
        },
      })
    },
  }, { forceAtTokens, minContextWindow: 500000, note: 'off' })

  mount(proxy1, 200000)
  await tick()
  mount(proxy2, 100000)
  await tick()
  assert.equal(targetEngine.config.modelPolicies[0].thresholdRatio, 0.1)

  disposers[0]()
  assert.equal(targetEngine.config.modelPolicies[0].thresholdRatio, 0.1)

  disposers[1]()
  assert.deepEqual(targetEngine.config.modelPolicies, [])
})

await test('apply: multi-instance wrapper ownership survives FIFO disposal, option precedence, outer wrappers, non-extensible own summarize, and aborted signals', async () => {
  const ORIGINAL = Symbol.for('cordis.original')
  const baseEngine = makeEngine()
  const wrapProxy = (target) => new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === ORIGINAL) return obj
      return Reflect.get(obj, prop, receiver)
    },
    set(obj, prop, value, receiver) {
      return Reflect.set(obj, prop, value, receiver)
    },
  })
  const llm = makeLlm([])
  const disposers = []
  const mount = (engine, opts) => apply({
    logs: [],
    logger: { info() {}, warn() {} },
    inject(names, cb) {
      cb({
        compaction: engine,
        llm,
        tokenMeter: { measure: () => ({ totalTokens: 10000 }) },
        effect(fn) {
          const d = fn()
          disposers.push(d)
          return d
        },
      })
    },
  }, opts)

  mount(wrapProxy(baseEngine), { note: 'off' })
  mount(wrapProxy(baseEngine), { note: 'handoff', heading: 'Layer Two' })

  const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Never skip tests.' }] }] }
  const activeBoth = await baseEngine.summarize(input, {}, undefined)
  assert.equal(activeBoth.summary.length, 2)
  assert.match(activeBoth.summary[1].text, /## Layer Two/)

  const inner = baseEngine.summarize
  const outer = async function (...args) {
    return { ...(await inner.apply(this, args)), outer: true }
  }
  baseEngine.summarize = outer

  disposers[0]()
  const afterFirst = await baseEngine.summarize(input, {}, undefined)
  assert.equal(afterFirst.outer, true)
  assert.equal(afterFirst.summary.length, 2)
  assert.match(afterFirst.summary[1].text, /## Layer Two/)

  disposers[1]()
  const afterSecond = await baseEngine.summarize(input, {}, undefined)
  assert.equal(baseEngine.summarize, outer)
  assert.equal(afterSecond.outer, true)
  assert.equal(afterSecond.summary.length, 1)

  const sealedEngine = Object.preventExtensions(makeEngine())
  const sealedOriginal = sealedEngine.summarize
  const sealedDisposers = []
  apply({
    logs: [],
    logger: { info() {}, warn() {} },
    inject(names, cb) {
      cb({
        compaction: sealedEngine,
        llm,
        tokenMeter: { measure: () => ({ totalTokens: 10000 }) },
        effect(fn) {
          const d = fn()
          sealedDisposers.push(d)
          return d
        },
      })
    },
  }, { note: 'context' })
  assert.notEqual(sealedEngine.summarize, sealedOriginal)
  const ctrl = new AbortController()
  ctrl.abort(new Error('stopped'))
  const abortedResult = await sealedEngine.summarize(input, {}, ctrl.signal)
  assert.equal(abortedResult.summary.length, 1)
  sealedDisposers[0]()
  assert.equal(sealedEngine.summarize, sealedOriginal)

  const reallySealed = Object.seal(makeEngine())
  const reallySealedOrig = reallySealed.summarize
  const reallySealedDisposers = []
  apply({
    logs: [],
    logger: { info() {}, warn() {} },
    inject(names, cb) {
      cb({
        compaction: reallySealed,
        llm,
        tokenMeter: { measure: () => ({ totalTokens: 10000 }) },
        effect(fn) {
          const d = fn()
          reallySealedDisposers.push(d)
          return d
        },
      })
    },
  }, { note: 'context' })
  assert.notEqual(reallySealed.summarize, reallySealedOrig)
  reallySealedDisposers[0]()
  assert.equal(reallySealed.summarize, reallySealedOrig)

  const proto = { async summarize() { return { summary: [{ type: 'text', text: 'From proto.' }] } } }
  const protoEngine = Object.create(proto)
  protoEngine.config = Object.freeze({ modelPolicies: [] })
  const protoDisposers = []
  const mountProto = (opts) => apply({
    logs: [],
    logger: { info() {}, warn() {} },
    inject(names, cb) {
      cb({
        compaction: protoEngine,
        llm,
        tokenMeter: { measure: () => ({ totalTokens: 10000 }) },
        effect(fn) {
          const d = fn()
          protoDisposers.push(d)
          return d
        },
      })
    },
  }, opts)
  mountProto({ note: 'context' })
  assert.equal(Object.hasOwn(protoEngine, 'summarize'), true)
  mountProto({ note: 'handoff', heading: 'SecondProto' })
  protoDisposers[1]()
  protoDisposers[1]()
  const afterLifo = await protoEngine.summarize(input, {}, undefined)
  assert.match(afterLifo.summary[1].text, /Note to Self \(context\)/)
  protoDisposers[0]()
  assert.equal(Object.hasOwn(protoEngine, 'summarize'), false)

  const frozenProtoEngine = Object.preventExtensions(Object.assign(Object.create(proto), {
    config: Object.freeze({ modelPolicies: [] }),
  }))
  assert.equal(wrapSummarize(frozenProtoEngine, fakeCtx({}), { note: 'context' }), false)
  assert.equal(Object.hasOwn(frozenProtoEngine, 'summarize'), false)

  const sharedBase = makeEngine()
  assert.equal(wrapSummarize(wrapProxy(sharedBase), fakeCtx({}), { note: 'context' }), true)
  assert.equal(wrapSummarize(wrapProxy(sharedBase), fakeCtx({}), { note: 'context' }), false)
  const overlayDisposers = []
  apply({
    logs: [],
    logger: { info() {}, warn() {} },
    inject(names, cb) {
      cb({
        compaction: sharedBase,
        llm,
        tokenMeter: { measure: () => ({ totalTokens: 10000 }) },
        effect(fn) {
          const d = fn()
          overlayDisposers.push(d)
          return d
        },
      })
    },
  }, { note: 'handoff', heading: 'Overlay' })
  const overlayResult = await sharedBase.summarize(input, {}, undefined)
  assert.match(overlayResult.summary[1].text, /## Overlay/)
  overlayDisposers[0]()
  const afterOverlay = await sharedBase.summarize(input, {}, undefined)
  assert.match(afterOverlay.summary[1].text, /Note to Self \(context\)/)

  const accessorOrig = async () => ({ summary: [{ type: 'text', text: 'Accessor base.' }] })
  let backingFn = accessorOrig
  let setterCalls = 0
  const accessorEngine = { config: Object.freeze({ modelPolicies: [] }) }
  Object.defineProperty(accessorEngine, 'summarize', {
    configurable: true,
    enumerable: true,
    get() { return backingFn },
    set(v) { setterCalls += 1; backingFn = v },
  })
  const accessorDisposers = []
  apply({
    logs: [],
    logger: { info() {}, warn() {} },
    inject(_names, cb) {
      cb({
        compaction: accessorEngine,
        llm,
        tokenMeter: { measure: () => ({ totalTokens: 10000 }) },
        effect(fn) {
          const d = fn()
          accessorDisposers.push(d)
          return d
        },
      })
    },
  }, { note: 'context' })
  assert.equal(setterCalls, 0)
  assert.equal(backingFn, accessorOrig)
  assert.equal((await accessorEngine.summarize(input, {}, undefined)).summary.length, 2)
  accessorDisposers[0]()
  const restoredDesc = Object.getOwnPropertyDescriptor(accessorEngine, 'summarize')
  assert.equal(typeof restoredDesc.get, 'function')
  assert.equal(typeof restoredDesc.set, 'function')
  assert.equal(accessorEngine.summarize, accessorOrig)

  const outerAccessorEngine = { config: Object.freeze({ modelPolicies: [] }) }
  let outerAccessorBacking = accessorOrig
  Object.defineProperty(outerAccessorEngine, 'summarize', {
    configurable: true,
    enumerable: true,
    get() { return outerAccessorBacking },
    set(v) { outerAccessorBacking = v },
  })
  const outerAccDisposers = []
  apply({
    logs: [],
    logger: { info() {}, warn() {} },
    inject(_names, cb) {
      cb({
        compaction: outerAccessorEngine,
        llm,
        tokenMeter: { measure: () => ({ totalTokens: 10000 }) },
        effect(fn) {
          const d = fn()
          outerAccDisposers.push(d)
          return d
        },
      })
    },
  }, { note: 'context' })
  const accInner = outerAccessorEngine.summarize
  const accOuter = async function (...args) { return { ...await accInner.apply(this, args), external: true } }
  outerAccessorEngine.summarize = accOuter
  outerAccDisposers[0]()
  assert.equal(outerAccessorEngine.summarize, accOuter)

  let ncBacking = accessorOrig
  const ncAccessorEngine = { config: Object.freeze({ modelPolicies: [] }) }
  Object.defineProperty(ncAccessorEngine, 'summarize', {
    configurable: false,
    enumerable: true,
    get() { return ncBacking },
    set(v) { ncBacking = v },
  })
  assert.equal(wrapSummarize(ncAccessorEngine, fakeCtx({}), { note: 'context' }), true)
  const ncWrapped = ncAccessorEngine.summarize
  assert.notEqual(ncWrapped, accessorOrig)
  const nonExtProto = {
    get summarize() { return ncBacking },
    set summarize(v) { ncBacking = v },
  }
  const nonExtProtoEngine = Object.preventExtensions(Object.assign(Object.create(nonExtProto), {
    config: Object.freeze({ modelPolicies: [] }),
  }))
  const protoAccessorDisposers = []
  apply({
    logs: [],
    logger: { info() {}, warn() {} },
    inject(_names, cb) {
      cb({
        compaction: nonExtProtoEngine,
        llm,
        tokenMeter: { measure: () => ({ totalTokens: 10000 }) },
        effect(fn) {
          const d = fn()
          protoAccessorDisposers.push(d)
          return d
        },
      })
    },
  }, { note: 'context' })
  assert.notEqual(nonExtProtoEngine.summarize, ncWrapped)
  protoAccessorDisposers[0]()
  assert.equal(nonExtProtoEngine.summarize, ncWrapped)

  let ncMountBacking = accessorOrig
  const ncMountEngine = { config: Object.freeze({ modelPolicies: [] }) }
  Object.defineProperty(ncMountEngine, 'summarize', {
    configurable: false,
    enumerable: true,
    get() { return ncMountBacking },
    set(v) { ncMountBacking = v },
  })
  const ncMountDisposers = []
  apply({
    logs: [],
    logger: { info() {}, warn() {} },
    inject(_names, cb) {
      cb({
        compaction: ncMountEngine,
        llm,
        tokenMeter: { measure: () => ({ totalTokens: 10000 }) },
        effect(fn) {
          const d = fn()
          ncMountDisposers.push(d)
          return d
        },
      })
    },
  }, { note: 'context' })
  assert.notEqual(ncMountEngine.summarize, accessorOrig)
  ncMountDisposers[0]()
  assert.equal(ncMountEngine.summarize, accessorOrig)

  let releaseSlow
  let markStarted
  const slowEngine = {
    config: Object.freeze({ modelPolicies: [] }),
    async summarize() {
      markStarted()
      return await new Promise((resolve) => { releaseSlow = resolve })
    },
  }
  const snapshotDisposers = []
  const mountSnapshot = (mountOpts) => apply({
    logs: [],
    logger: { info() {}, warn() {} },
    inject(_names, cb) {
      cb({
        compaction: slowEngine,
        llm,
        tokenMeter: { measure: () => ({ totalTokens: 10000 }) },
        effect(fn) {
          const d = fn()
          snapshotDisposers.push(d)
          return d
        },
      })
    },
  }, mountOpts)

  mountSnapshot({ note: 'context' })
  mountSnapshot({ note: 'off' })
  let startedPromise = new Promise((resolve) => { markStarted = resolve })
  const pendingOff = slowEngine.summarize(input, {}, undefined)
  await startedPromise
  snapshotDisposers[1]()
  releaseSlow({ summary: [{ type: 'text', text: 'Mid-flight off.' }] })
  assert.equal((await pendingOff).summary.length, 1)

  startedPromise = new Promise((resolve) => { markStarted = resolve })
  const pendingContext = slowEngine.summarize(input, {}, undefined)
  await startedPromise
  mountSnapshot({ note: 'handoff', heading: 'Late Mount' })
  releaseSlow({ summary: [{ type: 'text', text: 'Mid-flight mount.' }] })
  const contextRes = await pendingContext
  assert.equal(contextRes.summary.length, 2)
  assert.match(contextRes.summary[1].text, /Note to Self \(context\)/)
  assert.doesNotMatch(contextRes.summary[1].text, /## Late Mount/)
  snapshotDisposers[2]()
  snapshotDisposers[0]()
})

await test('buildNoteText and wrapSummarize: exact small token formatting, text-only blocks, requestHeader forwarding, and engine meter fallback', async () => {
  assert.match(buildNoteText({ variant: 'context', totalTokens: 0 }), /compacted at the context limit/)
  assert.match(buildNoteText({ variant: 'context', totalTokens: 77 }), /~77 tokens\./)
  assert.match(buildNoteText({ variant: 'context', totalTokens: 999 }), /~999 tokens\./)
  assert.match(buildNoteText({ variant: 'context', totalTokens: 1000 }), /~1K tokens\./)

  const engineWithNonText = makeEngine('## Current Work\n- real text\n## Next Step\n- run tests')
  engineWithNonText.summarize = async () => ({
    summary: [
      { type: 'reasoning', text: '## Current Work\n- secret reasoning\n## Next Step\n- leak reasoning' },
      { type: 'custom', text: '## Critical Context\n- leaked custom field' },
      { type: 'text', text: '## Current Work\n- visible work\n## Next Step\n- finish check' },
    ],
    rawOutput: [],
    provider: 'fake',
    model: 'fake',
  })
  const calls = []
  const expectedHeader = { config: { provider: 'test', model: 'large' }, tools: [{ name: 't' }] }
  const meter = {
    measure(...args) {
      calls.push(args)
      return { totalTokens: args[1] ? 4200 : 1000 }
    },
  }
  const isolatedCtx = fakeCtx({ tokenMeter: undefined })
  engineWithNonText.ctx = fakeCtx({ tokenMeter: meter })
  wrapSummarize(engineWithNonText, isolatedCtx, { note: 'both' })

  const sessWithHeader = { requestHeader: () => expectedHeader }
  const resWithHeader = await engineWithNonText.summarize({}, { session: sessWithHeader }, undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 2)
  assert.equal(calls[0][0], sessWithHeader)
  assert.equal(calls[0][1], expectedHeader)
  assert.match(resWithHeader.summary[3].text, /~4K tokens on /)
  assert.match(resWithHeader.summary[3].text, /Where I was: visible work/)
  assert.doesNotMatch(resWithHeader.summary[3].text, /secret reasoning|leak reasoning|leaked custom field/)

  const sessWithoutHeader = {}
  const resWithoutHeader = await engineWithNonText.summarize({}, { session: sessWithoutHeader }, undefined)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].length, 1)
  assert.match(resWithoutHeader.summary[3].text, /~1K tokens on /)

  const throwingSess = { requestHeader() { throw new Error('bad header') } }
  const resThrowing = await engineWithNonText.summarize({}, { session: throwingSess }, undefined)
  assert.match(resThrowing.summary[3].text, /compacted at the context limit/)

  const primaryEngine = makeEngine('## Current Work\n- primary')
  primaryEngine.ctx = fakeCtx({ tokenMeter: { measure: () => ({ totalTokens: 9000 }) } })
  wrapSummarize(primaryEngine, fakeCtx({ tokenMeter: { measure: () => ({ totalTokens: 3000 }) } }), { note: 'context' })
  const resPrimary = await primaryEngine.summarize({}, { session: {} }, undefined)
  assert.match(resPrimary.summary[1].text, /~3K tokens on /)
})

await test('wrapSummarize: fits or drops optional note framing within shadowed token budget', async () => {
  const estimateMessage = (msg) => {
    const content = Array.isArray(msg?.content) ? msg.content : [{ type: 'text', text: String(msg?.content ?? '') }]
    const chars = content.reduce((sum, block) => sum + String(block?.text ?? '').length, 0)
    return Math.ceil(chars / 4) + 4
  }
  const summaryText = [
    '## Current Work',
    '- Refactoring module A cleanly across several helpers and updating interfaces.',
    '## Next Step',
    '- Run end to end verification across all packages and confirm outputs.',
    '## Critical Context',
    '- Maintain backward compatibility with older session logs.',
  ].join('\n')

  const makeMeter = () => ({ measure: () => ({ totalTokens: 500 }), estimateMessage })
  const framedTokens = (blocks) => estimateMessage({
    role: 'user',
    content: [
      { type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>' },
      ...blocks,
      { type: 'text', text: '</compacted-summary>' },
    ],
  })

  const bareTokens = framedTokens([{ type: 'text', text: summaryText }])
  const makeInputWithBudget = (budgetTokens, userText) => ({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'System.' }] },
      { role: 'user', content: [{ type: 'text', text: userText + '\n' + 'a'.repeat(Math.max(0, (budgetTokens - 5) * 4 - userText.length)) }] },
    ],
  })

  const engineCompactBoth = makeEngine(summaryText)
  wrapSummarize(engineCompactBoth, fakeCtx({ tokenMeter: makeMeter() }), { note: 'both', scExtract: 'pattern' })
  const fullOnlyTokens = framedTokens([
    { type: 'text', text: summaryText },
    { type: 'text', text: buildNoteText({ summaryText, variant: 'both', totalTokens: 500, timestamp: '2026-01-01T00:00:00.000Z', sideConstraints: ['Never deploy without approval.'], compact: false }) },
  ])
  const compactBothInput = makeInputWithBudget(fullOnlyTokens, 'Never deploy without approval.')
  const compactBothRes = await engineCompactBoth.summarize(compactBothInput, { session: {} }, undefined)
  assert.equal(compactBothRes.summary.length, 2)
  assert.match(compactBothRes.summary[1].text, /Where I was:/)
  assert.doesNotMatch(compactBothRes.summary[1].text, /MUST survive every compaction/)
  assert.ok(framedTokens(compactBothRes.summary) < fullOnlyTokens)

  const engineHandoff = makeEngine(summaryText)
  wrapSummarize(engineHandoff, fakeCtx({ tokenMeter: makeMeter() }), { note: 'both', scExtract: 'pattern' })
  const compactBothTokens = framedTokens([
    { type: 'text', text: summaryText },
    { type: 'text', text: buildNoteText({ summaryText, variant: 'both', totalTokens: 500, timestamp: '2026-01-01T00:00:00.000Z', sideConstraints: ['Never deploy without approval.'], compact: true }) },
  ])
  const handoffRes = await engineHandoff.summarize(makeInputWithBudget(compactBothTokens, 'Never deploy without approval.'), { session: {} }, undefined)
  assert.equal(handoffRes.summary.length, 2)
  assert.match(handoffRes.summary[1].text, /Where I was:/)
  assert.doesNotMatch(handoffRes.summary[1].text, /Note to Self \(context\)/)
  assert.ok(framedTokens(handoffRes.summary) < compactBothTokens)

  const longHandoffSummary = [
    '## Current Work',
    '- Refactoring module A cleanly across several helpers and updating every exported interface carefully.',
    '## Next Step',
    '- Run end to end verification across all downstream packages and confirm all outputs match specs.',
    '## Critical Context',
    '- Maintain strict backward compatibility with older session logs and custom adapter hooks everywhere.',
  ].join('\n')
  const engineContextArm = makeEngine(longHandoffSummary)
  wrapSummarize(engineContextArm, fakeCtx({ tokenMeter: makeMeter() }), { note: 'both', scExtract: 'pattern' })
  const handoffTooBigTokens = framedTokens([
    { type: 'text', text: longHandoffSummary },
    { type: 'text', text: buildNoteText({ summaryText: longHandoffSummary, variant: 'handoff', totalTokens: 500, timestamp: '2026-01-01T00:00:00.000Z', sideConstraints: ['Never deploy without approval.'], compact: true }) },
  ])
  const contextArmRes = await engineContextArm.summarize(makeInputWithBudget(handoffTooBigTokens, 'Never deploy without approval.'), { session: {} }, undefined)
  assert.equal(contextArmRes.summary.length, 2)
  assert.match(contextArmRes.summary[1].text, /Note to Self \(context\)/)
  assert.match(contextArmRes.summary[1].text, /Never deploy without approval\./)
  assert.doesNotMatch(contextArmRes.summary[1].text, /Where I was:/)
  assert.ok(framedTokens(contextArmRes.summary) < handoffTooBigTokens)

  const engineSliceSc = makeEngine(summaryText)
  wrapSummarize(engineSliceSc, fakeCtx({ tokenMeter: makeMeter() }), { note: 'both', scExtract: 'pattern' })
  const twoScText = 'Never deploy without approval.\nAlways run regression suite.'
  const twoScTokens = framedTokens([
    { type: 'text', text: summaryText },
    { type: 'text', text: '\n\n## Active Constraints (preserve these)\n- Never deploy without approval.\n- Always run regression suite.\n' },
  ])
  const sliceScRes = await engineSliceSc.summarize(makeInputWithBudget(twoScTokens, twoScText), { session: {} }, undefined)
  assert.equal(sliceScRes.summary.length, 2)
  assert.match(sliceScRes.summary[1].text, /Never deploy without approval\./)
  assert.doesNotMatch(sliceScRes.summary[1].text, /Always run regression suite\./)
  assert.doesNotMatch(sliceScRes.summary[1].text, /Where I was:/)
  assert.ok(framedTokens(sliceScRes.summary) < twoScTokens)

  const engineNoSc = makeEngine('## Current Work\n- A.\n## Next Step\n- B.')
  wrapSummarize(engineNoSc, fakeCtx({ tokenMeter: makeMeter() }), { note: 'handoff', scExtract: 'pattern' })
  const longSc = 'Never ' + 'deploy '.repeat(12) + 'without approval.'
  const noScLimit = framedTokens([
    { type: 'text', text: '## Current Work\n- A.\n## Next Step\n- B.' },
    { type: 'text', text: buildNoteText({ summaryText: '## Current Work\n- A.\n## Next Step\n- B.', variant: 'handoff', totalTokens: 500, timestamp: '2026-01-01T00:00:00.000Z', sideConstraints: [], compact: true }) },
  ]) + 2
  const noScRes = await engineNoSc.summarize(makeInputWithBudget(noScLimit, longSc), { session: {} }, undefined)
  assert.equal(noScRes.summary.length, 2)
  assert.match(noScRes.summary[1].text, /Where I was:/)
  assert.doesNotMatch(noScRes.summary[1].text, /Active Constraints/)
  assert.ok(framedTokens(noScRes.summary) < noScLimit)

  const engineContextNoSc = makeEngine(summaryText)
  wrapSummarize(engineContextNoSc, fakeCtx({ tokenMeter: makeMeter() }), { note: 'context', scExtract: 'pattern' })
  const longScCtx = 'Never ' + 'deploy '.repeat(35) + 'without approval.'
  const noScCtxLimit = framedTokens([
    { type: 'text', text: summaryText },
    { type: 'text', text: buildNoteText({ summaryText, variant: 'context', totalTokens: 500, timestamp: '2026-01-01T00:00:00.000Z', sideConstraints: [], compact: true }) },
  ]) + 2
  const noScCtxRes = await engineContextNoSc.summarize(makeInputWithBudget(noScCtxLimit, longScCtx), { session: {} }, undefined)
  assert.equal(noScCtxRes.summary.length, 2)
  assert.match(noScCtxRes.summary[1].text, /Note to Self \(context\)/)
  assert.doesNotMatch(noScCtxRes.summary[1].text, /Active Constraints/)
  assert.ok(framedTokens(noScCtxRes.summary) < noScCtxLimit)

  const engineTiny = makeEngine(summaryText)
  wrapSummarize(engineTiny, fakeCtx({ tokenMeter: makeMeter() }), { note: 'both', scExtract: 'pattern' })
  const tinyRes = await engineTiny.summarize(makeInputWithBudget(bareTokens, 'Never deploy.'), { session: {} }, undefined)
  assert.equal(tinyRes.summary.length, 1)

  const engineThrowingMeter = makeEngine(summaryText)
  wrapSummarize(engineThrowingMeter, fakeCtx({ tokenMeter: {
    measure: () => ({ totalTokens: 500 }),
    estimateMessage: () => { throw new Error('meter boom') },
  } }), { note: 'both', scExtract: 'pattern' })
  const throwingRes = await engineThrowingMeter.summarize(makeInputWithBudget(10, 'Never deploy.'), { session: {} }, undefined)
  assert.equal(throwingRes.summary.length, 2)
  assert.match(throwingRes.summary[1].text, /MUST survive every compaction/)

  const makeSurfaceSession = (nodesData) => ({
    surface: { nodes: nodesData.map((n) => n.seq) },
    eventAt: (seq) => nodesData.find((n) => n.seq === seq),
    deriveEventMessage: (ev) => ev?.msg ?? null,
  })
  const surfaceSession = makeSurfaceSession([
    { seq: 1, type: 'system/message', msg: { role: 'system', content: [{ type: 'text', text: 'Sys1.' }] } },
    { seq: 2, type: 'user/message', msg: { role: 'user', content: [{ type: 'text', text: 'Never deploy without approval.' }] } },
    { seq: 3, type: 'meta/marker', msg: null },
    { seq: 4, type: 'system/message', msg: { role: 'system', content: [{ type: 'text', text: 'Sys2.' }] } },
  ])
  const surfaceInput = {
    messages: [
      surfaceSession.eventAt(1).msg,
      surfaceSession.eventAt(2).msg,
      surfaceSession.eventAt(4).msg,
    ],
  }

  const engineSurfaceBudget = makeEngine(summaryText)
  wrapSummarize(engineSurfaceBudget, fakeCtx({ tokenMeter: {
    measure: (sess) => sess === surfaceSession
      ? { totalTokens: 500, nodes: [{ seq: 1, tokens: 10 }, { seq: 2, tokens: 60 }, { seq: 3, tokens: 40 }, { seq: 4, tokens: 190 }] }
      : { totalTokens: 500 },
    estimateMessage,
  } }), { note: 'both', scExtract: 'pattern' })
  const surfaceRes = await engineSurfaceBudget.summarize(surfaceInput, { session: surfaceSession }, undefined)
  assert.equal(surfaceRes.summary.length, 2)
  assert.ok(framedTokens(surfaceRes.summary) < 290)
  assert.match(surfaceRes.summary[1].text, /Where I was:/)

  const mismatchResEngine = makeEngine(summaryText)
  wrapSummarize(mismatchResEngine, fakeCtx({ tokenMeter: {
    measure: () => ({ totalTokens: 500, nodes: [{ seq: 1, tokens: 10 }] }),
    estimateMessage,
  } }), { note: 'both', scExtract: 'pattern' })
  const mismatchRes = await mismatchResEngine.summarize(surfaceInput, { session: surfaceSession }, undefined)
  assert.equal(mismatchRes.summary.length, 1)

  const badNodeTokensEngine = makeEngine(summaryText)
  wrapSummarize(badNodeTokensEngine, fakeCtx({ tokenMeter: {
    measure: () => ({ totalTokens: 500, nodes: [{ seq: 1, tokens: 10 }, { seq: 2, tokens: Number.NaN }, { seq: 3, tokens: 40 }, { seq: 4, tokens: 90 }] }),
    estimateMessage,
  } }), { note: 'both', scExtract: 'pattern' })
  const badNodeTokensRes = await badNodeTokensEngine.summarize(surfaceInput, { session: surfaceSession }, undefined)
  assert.equal(badNodeTokensRes.summary.length, 1)

  const seqMismatchEngine = makeEngine(summaryText)
  wrapSummarize(seqMismatchEngine, fakeCtx({ tokenMeter: {
    measure: () => ({ totalTokens: 500, nodes: [{ seq: 1, tokens: 10 }, { seq: 99, tokens: 1000 }, { seq: 3, tokens: 40 }, { seq: 4, tokens: 90 }] }),
    estimateMessage,
  } }), { note: 'both', scExtract: 'pattern' })
  const seqMismatchRes = await seqMismatchEngine.summarize(surfaceInput, { session: surfaceSession }, undefined)
  assert.equal(seqMismatchRes.summary.length, 1)

  const zeroSurfaceEngine = makeEngine(summaryText)
  wrapSummarize(zeroSurfaceEngine, fakeCtx({ tokenMeter: {
    measure: () => ({ totalTokens: 500, nodes: [{ seq: 1, tokens: 0 }, { seq: 2, tokens: 0 }, { seq: 3, tokens: 0 }, { seq: 4, tokens: 0 }] }),
    estimateMessage,
  } }), { note: 'both', scExtract: 'pattern' })
  const zeroSurfaceRes = await zeroSurfaceEngine.summarize(surfaceInput, { session: surfaceSession }, undefined)
  assert.equal(zeroSurfaceRes.summary.length, 2)
  assert.match(zeroSurfaceRes.summary[1].text, /MUST survive every compaction/)

  const noMeasureEngine = makeEngine(summaryText)
  wrapSummarize(noMeasureEngine, fakeCtx({ tokenMeter: { estimateMessage } }), { note: 'both', scExtract: 'pattern' })
  const noMeasureRes = await noMeasureEngine.summarize(surfaceInput, { session: surfaceSession }, undefined)
  assert.equal(noMeasureRes.summary.length, 1)

  const skipHugeEngine = makeEngine('## Current Work\n- Doing X.\n## Next Step\n- Test X.')
  wrapSummarize(skipHugeEngine, fakeCtx({ tokenMeter: makeMeter() }), { note: 'both', scExtract: 'pattern' })
  const longScItem = 'Never ' + 'deploy '.repeat(30) + 'to production without rollback.'
  const shortScItem = 'Always keep SQLite WAL.'
  const shortOnlyTokens = framedTokens([
    { type: 'text', text: '## Current Work\n- Doing X.\n## Next Step\n- Test X.' },
    { type: 'text', text: `\n\n## Active Constraints (preserve these)\n- ${shortScItem}\n` },
  ])
  const skipHugeInput = makeInputWithBudget(shortOnlyTokens + 2, `${longScItem}\n${shortScItem}`)
  const skipHugeRes = await skipHugeEngine.summarize(skipHugeInput, { session: {} }, undefined)
  assert.equal(skipHugeRes.summary.length, 2)
  assert.match(skipHugeRes.summary[1].text, /Always keep SQLite WAL\./)
  assert.doesNotMatch(skipHugeRes.summary[1].text, /rollback/)
  assert.doesNotMatch(skipHugeRes.summary[1].text, /Where I was:/)

  const framingWithSurvivingScEngine = makeEngine('## Current Work\n- Doing Y.\n## Next Step\n- Ship Y.')
  wrapSummarize(framingWithSurvivingScEngine, fakeCtx({ tokenMeter: makeMeter() }), { note: 'both', scExtract: 'pattern' })
  const shortScTwo = 'Never mutate global cache.'
  const handoffPlusTwoShort = buildNoteText({
    variant: 'handoff',
    heading: DEFAULTS.heading,
    summaryText: '## Current Work\n- Doing Y.\n## Next Step\n- Ship Y.',
    sideConstraints: [shortScItem, shortScTwo],
    compact: true,
  })
  const framingPlusSurvivingTokens = framedTokens([
    { type: 'text', text: '## Current Work\n- Doing Y.\n## Next Step\n- Ship Y.' },
    { type: 'text', text: handoffPlusTwoShort },
  ])
  const multiSurvivingInput = makeInputWithBudget(
    framingPlusSurvivingTokens + 2,
    `${longScItem}\n${shortScItem}\n${'Never '.concat('rebuild '.repeat(30), 'live schema.')}\n${shortScTwo}`,
  )
  const multiSurvivingRes = await framingWithSurvivingScEngine.summarize(multiSurvivingInput, { session: {} }, undefined)
  assert.equal(multiSurvivingRes.summary.length, 2)
  assert.match(multiSurvivingRes.summary[1].text, /Where I was: Doing Y/)
  assert.match(multiSurvivingRes.summary[1].text, /Always keep SQLite WAL\./)
  assert.match(multiSurvivingRes.summary[1].text, /Never mutate global cache\./)
  assert.doesNotMatch(multiSurvivingRes.summary[1].text, /rollback|live schema/)
})

await test('sectionBullets: handles fences, subheadings, numbered/+ bullets, continuations, placeholders, whitespace, and bounds', () => {
  assert.deepEqual(sectionBullets('## Current Work\n1. implementing parser\n2. writing tests', 'Current Work'), ['implementing parser', 'writing tests'])
  assert.deepEqual(sectionBullets('## Next Step\n* check lint\n+ run suite\n• check output', 'Next Step', 3), ['check lint', 'run suite', 'check output'])
  assert.deepEqual(sectionBullets('## Current Work\n- implementing the parser for\n  nested constraint blocks\nand continuation line.\n- writing tests', 'Current Work'), [
    'implementing the parser for nested constraint blocks and continuation line.',
    'writing tests',
  ])
  assert.deepEqual(sectionBullets('## Current Work\n- working on\n  ***important*** parser\n---\n___\n* * *\n> quoted note', 'Current Work', 3), ['working on ***important*** parser'])
  assert.deepEqual(sectionBullets('## Critical Context\n### Security\n- never edit /etc\n- always require auth\n## Next Step\n- ignored', 'Critical Context', 3), [
    'never edit /etc',
    'always require auth',
  ])
  assert.deepEqual(sectionBullets([
    '## Files and Code',
    '```markdown',
    '## Current Work',
    '- fake bullet from fence',
    '```',
    '## Current Work',
    '- updating script:',
    '  ```bash',
    '  # bash comment',
    '  -flag',
    '  ```',
    '  ~~~sh',
    '  ## Current Work',
    '  - tilde fake',
    '  ~~~',
    '- running tests',
  ].join('\n'), 'Current Work', 3), ['updating script:', 'running tests'])
  assert.deepEqual(sectionBullets('## Next Step\n- (none)\n- None\n- (None).', 'Next Step'), [])
  assert.deepEqual(sectionBullets('## Next Step\n- (none)\n- run verifier', 'Next Step', 1), ['run verifier'])
  assert.deepEqual(sectionBullets('## Current Work\n- item 1', 'Current Work', 0), [])
  assert.deepEqual(sectionBullets('## Current Work\n- item 1', 'Current Work', -1), [])
  assert.deepEqual(sectionBullets('## Current Work\n- item 1', 'Current Work', 2, 0), [])
  assert.deepEqual(sectionBullets('## Current Work\n- item 1', 'Current Work', 2, -5), [])
  assert.deepEqual(sectionBullets('##  Current   Work \n- item 1', '  Current   Work  '), ['item 1'])
  const codeTrunc = sectionBullets(`## Current Work\n- Avoid \`${'a/'.repeat(60)}file.js\``, 'Current Work', 2, 40)
  assert.equal(codeTrunc.length, 1)
  assert.ok(codeTrunc[0].length <= 40)
  assert.equal((codeTrunc[0].match(/`/g) || []).length % 2, 0)
  assert.deepEqual(sectionBullets('## Current Work\n- Use ``a`b`` extra words', 'Current Work', 2, 11), ['Use ``a``…'])
  assert.deepEqual(sectionBullets('## Current Work\n- Use `a``b` extra words', 'Current Work', 2, 10), ['Use `a`…'])
  assert.deepEqual(sectionBullets('## Current Work\n- Avoid ``a```b`` extra words', 'Current Work', 2, 14), ['Avoid ``a``…'])
  const surrogateBullet = 'x'.repeat(398) + '🧪' + 'tail'
  const sbSurrogate = sectionBullets(`## Current Work\n- ${surrogateBullet}`, 'Current Work', 2, 400)
  assert.equal(sbSurrogate.length, 1)
  assert.equal(sbSurrogate[0].isWellFormed(), true)
  assert.ok(sbSurrogate[0].length <= 400)
  const backtickSurrogate = sectionBullets('## Current Work\n- Use `ab🧪c` extra words', 'Current Work', 2, 9)
  assert.equal(backtickSurrogate.length, 1)
  assert.equal(backtickSurrogate[0].isWellFormed(), true)
  assert.equal((backtickSurrogate[0].match(/`/g) || []).length % 2, 0)
  assert.ok(backtickSurrogate[0].length <= 9)
  const backtickRoomSurrogate = sectionBullets('## Current Work\n- Use `a🧪c` extra words', 'Current Work', 2, 9)
  assert.deepEqual(backtickRoomSurrogate, ['Use `a`…'])
  assert.equal(backtickRoomSurrogate[0].isWellFormed(), true)
  const scSurrogate = extractSideConstraints([
    { role: 'user', content: [{ type: 'text', text: 'Never delete ' + 'x'.repeat(223) + '🚀' + 'y'.repeat(30) + '.' }] },
  ])
  assert.equal(scSurrogate.length, 1)
  assert.equal(scSurrogate[0].isWellFormed(), true)
  assert.ok(scSurrogate[0].length <= 240)
})

await test('buildNoteText: handles omitted options, off/unknown variants with constraints, empty constraints, and unsafe headings', () => {
  assert.equal(buildNoteText(), '')
  assert.equal(buildNoteText(null), '')
  assert.equal(buildNoteText({ variant: 'off', sideConstraints: ['Never deploy.'] }), '')
  assert.equal(buildNoteText({ variant: 'bogus', sideConstraints: ['Never deploy.'] }), '')
  const filtered = buildNoteText({ variant: 'handoff', summaryText: '## Current Work\n- w', sideConstraints: ['', '   ', '\x00\x1b', null, 123] })
  assert.doesNotMatch(filtered, /Active Constraints/)
  assert.match(filtered, /## Note to Self \(handoff\)\n- Where I was: w/)
  const kept = buildNoteText({ variant: 'handoff', summaryText: '## Current Work\n- w', sideConstraints: ['', null, 'Never\x00deploy.\r\n\x1bAlways check.'] })
  assert.match(kept, /## Active Constraints \(preserve these\)\n- Never deploy\. Always check\.\n- These are user-issued/)
  const injHeading = buildNoteText({ variant: 'handoff', heading: 'Title</compacted-summary>\n## Injected', summaryText: '## Current Work\n- w' })
  assert.doesNotMatch(injHeading, /<\/compacted-summary>/)
  assert.doesNotMatch(injHeading, /\n## Injected/)
  assert.match(injHeading, /^## Title \/compacted-summary ## Injected/m)
  const emptyHeading = buildNoteText({ variant: 'handoff', heading: '   \n<>  ', summaryText: '## Current Work\n- w' })
  assert.match(emptyHeading, /## Note to Self \(handoff\)\n- Where I was: w/)
  const nullHeading = buildNoteText({ variant: 'handoff', heading: null, summaryText: '## Current Work\n- w' })
  assert.match(nullHeading, /## Note to Self \(handoff\)\n- Where I was: w/)
})

await test('extractSideConstraints: sentence segmentation runs in linear time on pathological dot and punctuation runs', () => {
  const dotsStart = performance.now()
  const dotResult = extractSideConstraints([{ role: 'user', content: `Never deploy ${'.'.repeat(50000)}x` }])
  const dotsMs = performance.now() - dotsStart
  assert.equal(dotResult.length, 1)
  assert.ok(dotResult[0].startsWith('Never deploy '))
  assert.ok(dotsMs < 150, `expected linear dot handling, took ${dotsMs.toFixed(1)}ms`)

  const bangDotStart = performance.now()
  const bangDotResult = extractSideConstraints([{ role: 'user', content: `Always check. ${'.'.repeat(40000)}!. Next line.` }])
  const bangDotMs = performance.now() - bangDotStart
  assert.deepEqual(bangDotResult, ['Always check.'])
  assert.ok(bangDotMs < 150, `expected linear non-terminal dot lookup, took ${bangDotMs.toFixed(1)}ms`)

  const repeatedStart = performance.now()
  const repeatedResult = extractSideConstraints([{ role: 'user', content: `Always ${'keep. '.repeat(5000)}Never drop.` }])
  const repeatedMs = performance.now() - repeatedStart
  assert.deepEqual(repeatedResult, ['Always keep.', 'Never drop.'])
  assert.ok(repeatedMs < 200, `expected linear repeated sentence splitting, took ${repeatedMs.toFixed(1)}ms`)
})

await test('extractSideConstraints: stack-frame and error-header matching runs in linear time without backtracking ReDoS', () => {
  const cases = [
    [`Always check.\nat a${' '.repeat(50000)}x`, ['Always check.']],
    [`Always check.\nat f (${'/a'.repeat(25000)}`, ['Always check.']],
    [`Always check.\nat ${'fn (foo '.repeat(6000)}a.js:1:1`, ['Always check.']],
    [`Always check.\na@${'a/'.repeat(25000)}`, ['Always check.']],
    [`at a (a.js:1:1)\nUncaught${' (a)'.repeat(24)}`, []],
    [`at a (a.js:1:1)\nUncaught${' ('.repeat(100000)}`, []],
  ]
  for (const [text, expected] of cases) {
    const start = performance.now()
    const got = extractSideConstraints([{ role: 'user', content: text }])
    const elapsedMs = performance.now() - start
    assert.deepEqual(got, expected)
    assert.ok(elapsedMs < 150, `expected linear stack/error check, took ${elapsedMs.toFixed(1)}ms`)
  }
  assert.deepEqual(extractSideConstraints([{
    role: 'user',
    content: [
      'Crash log:',
      'Uncaught (in promise) TypeError: must not mutate config',
      'Uncaught (a)(b) Error: must not ignore chained parens',
      'Uncaught (a)b Error: must not skip glued suffix',
      'Uncaught (in promise): Error: must not reject colon after group',
      '  at Foo.bar() (/tmp/dir(1)/app.js:10:2)',
      '  at render (Native Method)',
      '  at helper (Unknown Source)',
      '  fn@file:///app/index.js:12:4',
      '  run@https://example.com/bundle.js:1:9',
      '  native@[native code]',
      'Always log structured stack traces.',
    ].join('\n'),
  }]), ['Always log structured stack traces.'])
})

await test('reserved headings and unsafe timestamp/control characters are rejected or sanitized', () => {
  assert.equal(normalizeOptions({ heading: 'Active Constraints (preserve these)' }).heading, DEFAULTS.heading)
  assert.equal(normalizeOptions({ heading: 'note to self (context)' }).heading, DEFAULTS.heading)
  assert.equal(normalizeOptions({ heading: 'Custom\x00\x1bHeading\x9f' }).heading, 'Custom Heading')

  const rendered = buildNoteText({
    variant: 'both',
    heading: 'active constraints (preserve these)',
    summaryText: '## Current Work\n- Always prefer fast builds.',
    totalTokens: 12000,
    timestamp: '2026-01-01</compacted-summary>\r\n\x00\x1b## Injected',
    sideConstraints: ['Never deploy without approval.'],
  })
  assert.equal(rendered.match(/^## Active Constraints \(preserve these\)$/gm)?.length, 1)
  assert.match(rendered, /^## Note to Self \(handoff\)$/m)
  assert.doesNotMatch(rendered, /<\/compacted-summary>/)
  assert.doesNotMatch(rendered, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
  assert.doesNotMatch(rendered, /^## Injected$/m)

  const contextBlankTs = buildNoteText({
    variant: 'context',
    totalTokens: 12000,
    timestamp: '   \n\x00<>  ',
  })
  assert.match(contextBlankTs, /compacted at ~12K tokens\./)

  const recovered = extractSideConstraints([{
    role: 'user',
    content: `<compacted-summary>${rendered}</compacted-summary>`,
  }], { heading: 'Active Constraints (preserve these)' })
  assert.deepEqual(recovered, ['Never deploy without approval.'])
})

await test('wrapSummarize: non-leading surface regions price against the matched region rather than earlier turns', async () => {
  const estimateMessage = (msg) => {
    const content = Array.isArray(msg?.content) ? msg.content : [{ type: 'text', text: String(msg?.content ?? '') }]
    const chars = content.reduce((sum, block) => sum + String(block?.text ?? '').length, 0)
    return Math.ceil(chars / 4) + 4
  }
  const summaryText = [
    '## Current Work',
    '- Refactoring module B cleanly across helpers.',
    '## Next Step',
    '- Run integration checks.',
  ].join('\n')
  const framedTokens = (blocks) => estimateMessage({
    role: 'user',
    content: [
      { type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>' },
      ...blocks,
      { type: 'text', text: '</compacted-summary>' },
    ],
  })
  const makeSession = (records) => ({
    surface: { nodes: records.map((r) => r.seq) },
    eventAt: (seq) => records.find((r) => r.seq === seq),
    deriveEventMessage: (ev) => ev?.msg ?? null,
  })

  const bareTokens = framedTokens([{ type: 'text', text: summaryText }])
  const recordsA = [
    { seq: 1, type: 'system/message', tokens: 20, msg: { role: 'system', content: [{ type: 'text', text: 'System.' }] } },
    { seq: 2, type: 'user/message', tokens: 2000, msg: { role: 'user', content: [{ type: 'text', text: 'Huge earlier prompt' }] } },
    { seq: 3, type: 'meta/marker', tokens: 500, msg: null },
    { seq: 4, type: 'user/message', tokens: 12, msg: { role: 'user', content: [{ type: 'text', text: 'Never deploy without approval.' }] } },
    { seq: 5, type: 'assistant/message', tokens: Math.max(bareTokens + 2 - 12, 20), msg: { role: 'assistant', content: [{ type: 'text', text: 'Okay.' }] } },
  ]
  const sessA = makeSession(recordsA)
  const regionBudgetA = recordsA[3].tokens + recordsA[4].tokens
  const engineA = makeEngine(summaryText)
  wrapSummarize(engineA, fakeCtx({ tokenMeter: {
    measure: () => ({ totalTokens: 3000, nodes: recordsA.map(({ seq, tokens }) => ({ seq, tokens })) }),
    estimateMessage,
  } }), { note: 'both', scExtract: 'pattern' })
  const resA = await engineA.summarize({
    messages: [recordsA[0].msg, recordsA[3].msg, recordsA[4].msg],
  }, { session: sessA }, undefined)
  assert.ok(framedTokens(resA.summary) < regionBudgetA)
  assert.equal(resA.summary.length, 1)

  const recordsB = [
    { seq: 1, type: 'system/message', tokens: 20, msg: { role: 'system', content: [{ type: 'text', text: 'System.' }] } },
    { seq: 2, type: 'user/message', tokens: 5, msg: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { seq: 3, type: 'assistant/message', tokens: 5, msg: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    { seq: 4, type: 'user/message', tokens: 900, msg: { role: 'user', content: [{ type: 'text', text: 'Never skip regression tests.' }] } },
    { seq: 5, type: 'meta/marker', tokens: 200, msg: null },
    { seq: 6, type: 'assistant/message', tokens: 400, msg: { role: 'assistant', content: [{ type: 'text', text: 'Understood.' }] } },
  ]
  const sessB = makeSession(recordsB)
  const engineB = makeEngine(summaryText)
  wrapSummarize(engineB, fakeCtx({ tokenMeter: {
    measure: () => ({ totalTokens: 1530, nodes: recordsB.map(({ seq, tokens }) => ({ seq, tokens })) }),
    estimateMessage,
  } }), { note: 'both', scExtract: 'pattern' })
  const resB = await engineB.summarize({
    messages: [recordsB[0].msg, recordsB[3].msg, recordsB[5].msg],
  }, { session: sessB }, undefined)
  assert.equal(resB.summary.length, 2)
  assert.match(resB.summary[1].text, /Never skip regression tests\./)

  const recordsC = [
    { seq: 1, type: 'system/message', tokens: 20, msg: { role: 'system', content: [{ type: 'text', text: 'System.' }] } },
    { seq: 2, type: 'user/message', tokens: 2000, msg: { role: 'user', content: [{ type: 'text', text: 'Repeated question' }] } },
    { seq: 3, type: 'assistant/message', tokens: 2000, msg: { role: 'assistant', content: [{ type: 'text', text: 'Repeated answer' }] } },
    { seq: 4, type: 'user/message', tokens: 12, msg: { role: 'user', content: [{ type: 'text', text: 'Repeated question' }] } },
    { seq: 5, type: 'assistant/message', tokens: Math.max(bareTokens + 2 - 12, 20), msg: { role: 'assistant', content: [{ type: 'text', text: 'Repeated answer' }] } },
  ]
  const sessC = makeSession(recordsC)
  const engineC = makeEngine(summaryText)
  wrapSummarize(engineC, fakeCtx({ tokenMeter: {
    measure: () => ({ totalTokens: 5000, nodes: recordsC.map(({ seq, tokens }) => ({ seq, tokens })) }),
    estimateMessage,
  } }), { note: 'both', scExtract: 'pattern' })
  const resC = await engineC.summarize({
    messages: [recordsC[0].msg, recordsC[3].msg, recordsC[4].msg],
  }, { session: sessC }, undefined)
  assert.equal(resC.summary.length, 1)
  assert.ok(framedTokens(resC.summary) < recordsC[3].tokens + recordsC[4].tokens)
})

await test('apply: downward contextWindow updates shrink or revert policies and tighter-then-looser disposal preserves remaining mount', async () => {
  let window = 1000000
  const handlers = new Set()
  const prior = { provider: 'p', model: 'm1', thresholdRatio: 0.7 }
  const engine = makeEngine()
  const initialConfig = Object.freeze({ ...engine.config, modelPolicies: [prior] })
  engine.config = initialConfig
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm1' }],
    resolveModelInfo: async () => ({ context: { contextWindow: window } }),
  }
  const makeScope = () => {
    const disposers = []
    return {
      logger: { info() {}, warn() {} },
      inject(_names, cb) {
        cb({
          compaction: engine,
          llm,
          on(event, fn) {
            if (event === 'llm/adapters-updated') handlers.add(fn)
            return () => handlers.delete(fn)
          },
          effect(setup) {
            disposers.push(setup())
          },
        })
      },
      dispose() {
        for (const fn of disposers.splice(0)) fn()
      },
    }
  }

  const scope = makeScope()
  apply(scope, { forceAtTokens: 200000, minContextWindow: 500000 })
  await tick(); await tick()
  assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.2)

  window = 800000
  for (const fn of handlers) fn()
  await tick(); await tick()
  assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.25)

  window = 300000
  for (const fn of handlers) fn()
  await tick(); await tick()
  assert.deepEqual(engine.config.modelPolicies, [prior])
  assert.equal(engine.config, initialConfig)

  window = 1000000
  for (const fn of handlers) fn()
  await tick(); await tick()
  assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.2)

  const tightScope = makeScope()
  apply(tightScope, { forceAtTokens: 100000, minContextWindow: 500000 })
  await tick(); await tick()
  assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.1)

  tightScope.dispose()
  assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.2)

  scope.dispose()
  assert.equal(engine.config, initialConfig)

  const externalCfg = Object.freeze({ thresholdRatio: 0.8, modelPolicies: [], headroomTokens: 4096 })
  const reMountA = makeScope()
  apply(reMountA, { forceAtTokens: 200000, minContextWindow: 500000 })
  await tick(); await tick()
  engine.config = externalCfg
  reMountA.dispose()
  assert.equal(engine.config, externalCfg)

  const reMountB = makeScope()
  apply(reMountB, { forceAtTokens: 100000, minContextWindow: 500000 })
  await tick(); await tick()
  assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.1)
  reMountB.dispose()
  assert.equal(engine.config, externalCfg)

  const dupA = { provider: 'p', model: 'm1', thresholdRatio: 0.1 }
  const dupB = { provider: 'p', model: 'm1', thresholdRatio: 0.7 }
  const dupCfg = Object.freeze({ ...engine.config, modelPolicies: [dupA, dupB] })
  engine.config = dupCfg
  const dupScope = makeScope()
  apply(dupScope, { forceAtTokens: 200000, minContextWindow: 500000 })
  await tick(); await tick()
  assert.equal(engine.config, dupCfg)
  dupScope.dispose()
  assert.equal(engine.config, dupCfg)

  const unkeyedCfg = Object.freeze({ ...engine.config, modelPolicies: [{ foo: 1 }, { bar: 2 }] })
  engine.config = unkeyedCfg
  window = 300000
  const unkeyedScope = makeScope()
  apply(unkeyedScope, { forceAtTokens: 200000, minContextWindow: 500000 })
  await tick(); await tick()
  for (const fn of handlers) fn()
  await tick(); await tick()
  assert.equal(engine.config, unkeyedCfg)
  unkeyedScope.dispose()
  assert.equal(engine.config, unkeyedCfg)

  window = 1000000
  engine.config = externalCfg
  const extMaskScope = makeScope()
  apply(extMaskScope, { forceAtTokens: 200000, minContextWindow: 500000 })
  await tick(); await tick()
  for (const fn of handlers) fn()
  await tick(); await tick()
  const ownedRow = engine.config.modelPolicies[0]
  const extOverride = { provider: 'p', model: 'm1', thresholdRatio: 0.05 }
  const maskedCfg = Object.freeze({ ...engine.config, modelPolicies: [extOverride, ownedRow] })
  engine.config = maskedCfg
  extMaskScope.dispose()
  assert.equal(engine.config, maskedCfg)
})

await test('apply: invalidates catalogCache on unmount so unmounted adapters-updated is never stale while preserving overlapping share', async () => {
  const handlers = new Set()
  const emitter = {}
  let catalogList = [{ id: 'm1', window: 1000000 }]
  let listCalls = 0
  const engine = makeEngine()
  const originalConfig = engine.config
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => {
      listCalls += 1
      return catalogList.map((m) => ({ id: m.id }))
    },
    resolveModelInfo: async (_p, m) => ({ context: { contextWindow: catalogList.find((x) => x.id === m).window } }),
  }
  const makeScope = () => {
    const disposers = []
    return {
      events: emitter,
      logger: { info() {}, warn() {} },
      inject(_names, cb) {
        cb({
          compaction: engine,
          llm,
          events: emitter,
          on(event, fn) {
            if (event === 'llm/adapters-updated') handlers.add(fn)
            return () => handlers.delete(fn)
          },
          effect(setup) {
            disposers.push(setup())
          },
        })
      },
      dispose() {
        for (const fn of disposers.splice(0)) fn()
      },
    }
  }

  const s1 = makeScope()
  apply(s1, { forceAtTokens: 200000, minContextWindow: 500000 })
  await tick(); await tick()
  assert.equal(listCalls, 1)
  assert.deepEqual(engine.config.modelPolicies.map((p) => p.model), ['m1'])
  assert.equal(handlers.size, 1)
  s1.dispose()
  assert.equal(handlers.size, 0)
  assert.equal(engine.config, originalConfig)

  catalogList = [{ id: 'm1', window: 1000000 }, { id: 'm2', window: 2000000 }]
  for (const fn of handlers) fn()

  const s2 = makeScope()
  apply(s2, { forceAtTokens: 200000, minContextWindow: 500000 })
  await tick(); await tick()
  assert.equal(listCalls, 2)
  assert.deepEqual(engine.config.modelPolicies.map((p) => [p.model, p.thresholdRatio]), [['m1', 0.2], ['m2', 0.1]])

  const sOverlap = makeScope()
  apply(sOverlap, { forceAtTokens: 100000, minContextWindow: 500000 })
  await tick(); await tick()
  assert.equal(listCalls, 2)
  s2.dispose()
  assert.equal(handlers.size, 1)

  const sOverlap2 = makeScope()
  apply(sOverlap2, { forceAtTokens: 100000, minContextWindow: 500000 })
  await tick(); await tick()
  assert.equal(listCalls, 2)

  sOverlap.dispose()
  sOverlap2.dispose()
  assert.equal(handlers.size, 0)
  assert.equal(engine.config, originalConfig)

  const s3 = makeScope()
  apply(s3, { forceAtTokens: 200000, minContextWindow: 500000 })
  await tick(); await tick()
  assert.equal(listCalls, 3)
  s3.dispose()
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exitCode = 1
} else {
  console.log('PASS: all assertions passed; no real engine or llm service was touched.')
}
