import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as plugin from './index.js'

assert(process.argv[2], 'Pass the installed DSH node_modules directory')
const modules = resolve(process.argv[2])
const { Context, Service } = await import(pathToFileURL(join(modules, '@deepseek-ai/cordis/lib/index.js')))
const { BasicCompactionEngine } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-compaction-basic/lib/index.js')))
const { SessionStore } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-session/lib/index.js')))
const { SessionProjectionRegistry } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-session-projection/lib/index.js')))
const { TokenMeter } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-token-meter/lib/index.js')))
const flush = () => new Promise(setImmediate)
const signal = new AbortController().signal
const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Never deploy without approval.' }] }] }
const catalog = () => ({
  listProviders: () => [{ id: 'test' }],
  listModels: async () => [{ id: 'large' }],
  resolveModelInfo: async () => ({ context: { contextWindow: 1000000 } }),
})
function fixture(llm = catalog()) {
  const ctx = new Context()
  const engine = new BasicCompactionEngine(ctx, { auto: false })
  engine.summarize = async () => ({ summary: [{ type: 'text', text: 'Prior work.' }] })
  ctx.provide('llm', llm)
  ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 10000 }) })
  return { ctx, engine }
}
let passed = 0
let failed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('PASS', name) }
  catch (error) { failed += 1; console.error('FAIL', name, error.message) }
}

await test('disposal restores config and summary; remount applies changed options', async () => {
  const { ctx, engine } = fixture()
  const originalConfig = engine.config
  const originalSummary = engine.summarize
  try {
    const first = ctx.plugin(plugin, { note: 'context', forceAtTokens: 200000 })
    await first
    await flush()
    assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.2)
    assert.equal((await engine.summarize(input, {}, signal)).summary.length, 2)
    await first.dispose()
    assert.equal(engine.config, originalConfig, 'disposal must restore the previous config')
    assert.equal(engine.summarize, originalSummary, 'disposal must restore the previous summarizer')
    const second = ctx.plugin(plugin, { note: 'off', forceAtTokens: 100000 })
    await second
    await flush()
    assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.1)
    assert.equal((await engine.summarize(input, {}, signal)).summary.length, 1)
    await second.dispose()
    assert.equal(engine.config, originalConfig)
    assert.equal(engine.summarize, originalSummary)
  } finally { await ctx.fiber.dispose() }
})

await test('disposal prevents writes from an in-flight catalog lookup', async () => {
  let release
  let started
  const ready = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const llm = catalog()
  llm.listModels = async () => { started(); await gate; return [{ id: 'large' }] }
  const { ctx, engine } = fixture(llm)
  const originalConfig = engine.config
  const originalSummary = engine.summarize
  try {
    const fiber = ctx.plugin(plugin, { note: 'context' })
    await fiber
    await ready
    await fiber.dispose()
    release()
    await flush()
    assert.equal(engine.config, originalConfig, 'late catalog completion must not install policies')
    assert.equal(engine.summarize, originalSummary)
  } finally { release(); await ctx.fiber.dispose() }
})

await test('disposal cancels boot retries, including a callback already dequeued', async () => {
  const timers = new Map()
  let callback
  let calls = 0
  const savedSet = globalThis.setTimeout
  const savedClear = globalThis.clearTimeout
  globalThis.setTimeout = (fn, delay, ...args) => {
    if (delay !== 500 && delay !== 2000) return savedSet(fn, delay, ...args)
    const id = {}
    callback = fn
    timers.set(id, fn)
    return id
  }
  globalThis.clearTimeout = id => timers.delete(id) || savedClear(id)
  const llm = { listProviders() { calls += 1; return [] } }
  const { ctx, engine } = fixture(llm)
  const originalConfig = engine.config
  try {
    const fiber = ctx.plugin(plugin, {})
    await fiber
    await flush()
    assert.equal(timers.size, 1, 'empty boot catalog should schedule one retry')
    await fiber.dispose()
    assert.equal(timers.size, 0, 'disposal must clear pending retries')
    callback()
    await flush()
    assert.equal(calls, 1, 'a disposed retry callback must not enumerate the catalog')
    assert.equal(engine.config, originalConfig)
  } finally {
    await ctx.fiber.dispose()
    globalThis.setTimeout = savedSet
    globalThis.clearTimeout = savedClear
  }
})

await test('disposal preserves later config changes and an outer summary wrapper', async () => {
  const { ctx, engine } = fixture()
  const prior = { provider: 'test', model: 'large', thresholdRatio: 0.7 }
  engine.config = Object.freeze({ ...engine.config, modelPolicies: [prior] })
  try {
    const first = ctx.plugin(plugin, { note: 'context' })
    await first
    await flush()
    const extra = { provider: 'other', model: 'small', thresholdRatio: 0.6 }
    engine.config = Object.freeze({ ...engine.config, headroomTokens: 1234, modelPolicies: [...engine.config.modelPolicies, extra] })
    const inner = engine.summarize
    const outer = async function (...args) { return { ...await inner.apply(this, args), external: true } }
    engine.summarize = outer
    await first.dispose()
    assert.equal(engine.summarize, outer)
    assert.equal(engine.config.headroomTokens, 1234)
    assert.deepEqual(engine.config.modelPolicies, [prior, extra])
    const result = await engine.summarize(input, {}, signal)
    assert.equal(result.summary.length, 1, 'retained inner wrapper must be inactive')
    assert.equal(result.external, true)
    const second = ctx.plugin(plugin, { note: 'context', forceAtTokens: 100000 })
    await second
    await flush()
    assert.equal((await engine.summarize(input, {}, signal)).summary.length, 2, 'remount adds exactly one note')
    await second.dispose()
    assert.equal(engine.summarize, outer)
  } finally { await ctx.fiber.dispose() }
})

await test('disposal preserves another writer replacement, mutation, or deletion of a policy', async () => {
  for (const kind of ['replace', 'mutate', 'delete']) {
    const { ctx, engine } = fixture()
    try {
      const fiber = ctx.plugin(plugin, {})
      await fiber
      await flush()
      if (kind === 'replace') {
        engine.config = Object.freeze({ ...engine.config, modelPolicies: [{ ...engine.config.modelPolicies[0], thresholdRatio: 0.4 }] })
      } else if (kind === 'mutate') {
        engine.config.modelPolicies[0].thresholdRatio = 0.4
      } else {
        engine.config = Object.freeze({ ...engine.config, modelPolicies: [] })
      }
      const external = engine.config
      await fiber.dispose()
      assert.equal(engine.config, external, kind)
    } finally { await ctx.fiber.dispose() }
  }
})

await test('a summary completing after disposal receives no stale note', async () => {
  const { ctx, engine } = fixture()
  let release
  let started
  const ready = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const base = { summary: [{ type: 'text', text: 'Original summary.' }] }
  engine.summarize = async () => { started(); await gate; return base }
  try {
    const fiber = ctx.plugin(plugin, { note: 'context' })
    await fiber
    const pending = engine.summarize(input, {}, signal)
    await ready
    await fiber.dispose()
    release()
    assert.equal(await pending, base)
  } finally { release(); await ctx.fiber.dispose() }
})

await test('remount wins over a disposed installation sharing the pending catalog', async () => {
  let release
  let started
  const ready = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const llm = catalog()
  llm.listModels = async () => { started(); await gate; return [{ id: 'large' }] }
  const { ctx, engine } = fixture(llm)
  const original = engine.config
  try {
    const first = ctx.plugin(plugin, { forceAtTokens: 200000 })
    await first
    await ready
    await first.dispose()
    const second = ctx.plugin(plugin, { forceAtTokens: 100000 })
    await second
    release()
    await flush()
    assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.1)
    await second.dispose()
    assert.equal(engine.config, original)
  } finally { release(); await ctx.fiber.dispose() }
})

await test('activates and installs policies when tokenMeter is absent and resolves late tokenMeter', async () => {
  const ctx = new Context()
  const engine = new BasicCompactionEngine(ctx, { auto: false })
  engine.summarize = async () => ({ summary: [{ type: 'text', text: 'Prior work.' }] })
  ctx.provide('llm', catalog())
  try {
    const fiber = ctx.plugin(plugin, { note: 'context', forceAtTokens: 200000 })
    await fiber
    await flush()
    assert.equal(engine.config.modelPolicies.length, 1)
    assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.2)
    const noMeter = await engine.summarize(input, {}, signal)
    assert.match(noMeter.summary[1].text, /compacted at the context limit/)
    ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 42000 }) })
    await flush()
    const withMeter = await engine.summarize(input, {}, signal)
    assert.match(withMeter.summary[1].text, /compacted at ~42K tokens/)
    await fiber.dispose()
  } finally { await ctx.fiber.dispose() }
})

await test('disposing overlapping instances in FIFO order restores original config without zombie policies', async () => {
  const { ctx, engine } = fixture()
  const original = engine.config
  try {
    const first = ctx.plugin(plugin, { forceAtTokens: 200000 })
    await first
    await flush()
    assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.2)
    const second = ctx.plugin(plugin, { forceAtTokens: 100000 })
    await second
    await flush()
    assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.1)
    await first.dispose()
    assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.1)
    await second.dispose()
    assert.equal(engine.config, original)
  } finally { await ctx.fiber.dispose() }
})

await test('disposing non-extensible Cordis Service proxies in FIFO order restores original config cleanly', async () => {
  const inner = Object.preventExtensions({
    config: Object.freeze({ modelPolicies: [] }),
    async summarize() { return { summary: [{ type: 'text', text: 'Prior work.' }] } },
  })
  class BridgeService extends Service {
    constructor(ctx, opts) {
      super(ctx, 'compaction')
      this._inner = opts.inner
      Object.preventExtensions(this)
    }
    get config() { return this._inner.config }
    set config(value) { this._inner.config = value }
    summarize(inputArg, agent, sig) { return this._inner.summarize(inputArg, agent, sig) }
  }
  const ctx = new Context()
  await ctx.plugin(BridgeService, { inner })
  ctx.provide('llm', catalog())
  try {
    const scope1 = ctx.isolate('toolResultPruner')
    const scope2 = ctx.isolate('toolResultPrunerB')
    assert.notEqual(scope1.get('compaction'), scope2.get('compaction'))
    const first = await scope1.plugin(plugin, { note: 'off', forceAtTokens: 200000 })
    await flush()
    const second = await scope2.plugin(plugin, { note: 'off', forceAtTokens: 100000 })
    await flush()
    assert.equal(inner.config.modelPolicies[0].thresholdRatio, 0.1)
    await first.dispose()
    assert.equal(inner.config.modelPolicies[0].thresholdRatio, 0.1)
    await second.dispose()
    assert.deepEqual(inner.config.modelPolicies, [])
  } finally { await ctx.fiber.dispose() }
})

await test('overlapping instances preserve active wrapper layer across FIFO disposal and outer wrappers on Cordis Service proxies', async () => {
  const ctx = new Context()
  ctx.provide('llm', catalog())
  ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 10000 }) })
  ctx.provide('sessions', { registerMessageProjection: () => () => {} })
  await ctx.plugin(BasicCompactionEngine, { auto: false })
  const rawEngine = ctx.get('compaction')[Symbol.for('cordis.original')]
  rawEngine.summarize = async function () {
    return { summary: [{ type: 'text', text: '## Current Work\n- keep active wrapper' }] }
  }
  const scopeA = ctx.isolate('toolResultPruner')
  const scopeB = ctx.isolate('toolResultPrunerB')
  try {
    const first = await scopeA.plugin(plugin, { note: 'off', forceAtTokens: 200000 })
    const second = await scopeB.plugin(plugin, { note: 'handoff', heading: 'Second Active', forceAtTokens: 100000 })
    await flush()

    const duringBoth = await ctx.get('compaction').summarize(input, {}, signal)
    assert.equal(duringBoth.summary.length, 2)
    assert.match(duringBoth.summary[1].text, /## Second Active/)

    const inner = rawEngine.summarize
    const outer = async function (...args) {
      return { ...(await inner.apply(this, args)), external: true }
    }
    rawEngine.summarize = outer

    await first.dispose()
    const afterFirst = await scopeB.get('compaction').summarize(input, {}, signal)
    assert.equal(afterFirst.external, true)
    assert.equal(afterFirst.summary.length, 2)
    assert.match(afterFirst.summary[1].text, /## Second Active/)

    await second.dispose()
    assert.equal(rawEngine.summarize, outer)
    const afterSecond = await ctx.get('compaction').summarize(input, {}, signal)
    assert.equal(afterSecond.external, true)
    assert.equal(afterSecond.summary.length, 1)

    const protoCtx = new Context()
    try {
      protoCtx.provide('llm', catalog())
      const protoEngine = new BasicCompactionEngine(protoCtx, { auto: false })
      assert.equal(Object.hasOwn(protoEngine, 'summarize'), false)
      const protoPlugin = await protoCtx.plugin(plugin, { note: 'off' })
      assert.equal(Object.hasOwn(protoEngine, 'summarize'), true)
      await protoPlugin.dispose()
      assert.equal(Object.hasOwn(protoEngine, 'summarize'), false)
    } finally { await protoCtx.fiber.dispose() }
  } finally { await ctx.fiber.dispose() }
})

await test('tiny forceAtTokens policies never trigger TargetPressureConfigError during compactPressure', async () => {
  for (const [forceAtTokens, window] of [[1, 700000], [2, 600000]]) {
    const ctx = new Context()
    const engine = new BasicCompactionEngine(ctx, { auto: false })
    ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 0 }) })
    ctx.provide('llm', {
      resolveModelInfo: async () => ({ context: { contextWindow: window }, defaultMaxTokens: 1000 }),
    })
    const policies = plugin.buildPolicies([{ provider: 'test', model: 'large', contextWindow: window }], { forceAtTokens })
    engine.config = Object.freeze({ ...engine.config, modelPolicies: policies })
    const result = await engine.compactPressure({ session: { surface: {} } }, { config: { provider: 'test', model: 'large' } }, signal, false)
    assert.equal(result, null)
  }
})

await test('mountSummary filters non-text blocks, avoids ~0K rounding, forwards requestHeader, and falls back to engine meter in isolated scopes', async () => {
  const ctx = new Context()
  const measureCalls = []
  const meter = {
    measure(session, header) {
      measureCalls.push([session, header])
      return { totalTokens: header ? 320 : 1200 }
    },
  }
  const llm = {
    listProviders: () => [{ id: 'test' }],
    listModels: async () => [{ id: 'large' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 1000000 }, defaultMaxTokens: 1000 }),
  }
  ctx.provide('llm', llm)
  ctx.provide('tokenMeter', meter)
  ctx.provide('sessions', {})
  await ctx.plugin(BasicCompactionEngine, { auto: false })
  const compaction = ctx.get('compaction')
  compaction.summarize = async () => ({
    summary: [
      { type: 'reasoning', text: '## Current Work\n- hidden thought\n## Next Step\n- hidden step' },
      { type: 'text', text: '## Current Work\n- public work\n## Next Step\n- ship patch' },
    ],
  })
  const isolatedPluginScope = ctx.isolate('tokenMeter')
  await isolatedPluginScope.plugin(plugin, { note: 'both', minContextWindow: 500000, forceAtTokens: 200000 })
  await flush()
  try {
    const reqHeader = { config: { provider: 'test', model: 'large' } }
    const session = { requestHeader: () => reqHeader }
    const result = await ctx.get('compaction').summarize({}, { session }, signal)
    assert.equal(measureCalls.length, 1)
    assert.equal(measureCalls[0][1], reqHeader)
    assert.match(result.summary[2].text, /compacted at ~320 tokens/)
    assert.doesNotMatch(result.summary[2].text, /~0K tokens|hidden thought|hidden step/)
    assert.match(result.summary[2].text, /Where I was: public work/)
    assert.match(result.summary[2].text, /Next: ship patch/)
  } finally {
    await ctx.fiber.dispose()
  }
})

await test('mountSummary keeps real BasicCompactionEngine compactPressure and compactNow under tight shadowed token budgets', async () => {
  const summaryText = [
    '## Primary Request and Intent',
    '- Build the feature carefully.',
    '## Current Work',
    '- Working on module A.',
    '## Next Step',
    '- Run tests.',
    '## Critical Context',
    '- Check edge cases.',
  ].join('\n')

  class FakeLlm extends Service {
    constructor(ctx) { super(ctx, 'llm') }
    listProviders() { return [{ id: 'test', name: 'test' }] }
    async listModels() { return [{ provider: 'test', id: 'large', name: 'large' }] }
    async resolveModelInfo() {
      return { provider: 'test', id: 'large', name: 'large', context: { contextWindow: 1000000 }, defaultMaxTokens: 1000 }
    }
    imageRequestPricing() { return undefined }
    fileRequestText(ref) { return `[file:${ref?.id ?? 'x'}]` }
    async *stream() {
      yield { type: 'text-delta', index: 0, text: summaryText }
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 10 } }
    }
  }

  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(FakeLlm)
  const isolated = ctx.isolate('compaction').isolate('toolResultPruner')
  await isolated.plugin(BasicCompactionEngine, { auto: false })
  await isolated.plugin(plugin, { note: 'both', forceAtTokens: 262144, minContextWindow: 500000, scExtract: 'pattern' })
  await flush()
  const textStream = (text) => [{ type: 'text-chunks', time0: 0, index: 0, dt: [0], texts: [text] }]
  const header = { config: { provider: 'test', model: 'large', maxTokens: 1000 } }
  const userText = [
    'Never deploy without explicit approval from the release manager first.',
    'Always run the complete regression test suite before merging any pull request.',
    'Do not modify any production database schema without a rollback plan.',
    'Never share customer credentials or API tokens in logs or chat output.',
    'Keep compatibility with Node 20 and existing exports intact.',
    'Background context filler: ' + 'token '.repeat(160),
  ].join(' ')
  try {
    const sessions = ctx.get('sessions')
    const meter = ctx.get('tokenMeter')
    const compaction = isolated.get('compaction')
    assert.equal(compaction.config.modelPolicies.length, 1)
    assert.equal(compaction.config.modelPolicies[0].thresholdRatio, 0.262144)

    const framedTokens = (summaryBlocks) => meter.estimateMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>' },
        ...summaryBlocks,
        { type: 'text', text: '</compacted-summary>' },
      ],
    })

    const sPressure = sessions.create(undefined, { meta: { cwd: '/tmp' } })
    sPressure.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'System.' }] } }, { surfaceOp: 'append' })
    sPressure.append('request/header', { header })
    sPressure.append('turn/start', { turn: 1 })
    sPressure.append('user/message', { role: 'user', content: [{ type: 'text', text: userText }] }, { surfaceOp: 'append' })
    sPressure.append('step/start', { turn: 1, step: 1 })
    sPressure.append('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Acknowledged.' }] },
      stream: textStream('Acknowledged.'),
    }, { surfaceOp: 'append' })
    sPressure.append('step/end', { turn: 1, step: 1 })
    sPressure.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Log:\n' + 'A'.repeat(1047200) }] }, { surfaceOp: 'append' })

    const pressureBudget = meter.measure(sPressure).nodes.slice(1, 3).reduce((sum, n) => sum + n.tokens, 0)
    const pressureRes = await compaction.compactPressure({ session: sPressure, options: { provider: 'test', model: 'large' } }, header, signal, false)
    assert.ok(pressureRes !== null)
    assert.equal(pressureRes.summary.length, 2)
    assert.match(pressureRes.summary[1].text, /Active Constraints|Never deploy/)
    assert.doesNotMatch(pressureRes.summary[1].text, /MUST survive every compaction/)
    assert.ok(framedTokens(pressureRes.summary) < pressureBudget)
    const pressureCheckpoint = sPressure.deriveEventMessage(sPressure.eventAt(sPressure.surface.nodes[1]))
    assert.match(pressureCheckpoint.content.map((b) => b.text).join('\n'), /Never deploy/)

    const sShort = sessions.create(undefined, { meta: { cwd: '/tmp' } })
    sShort.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'System.' }] } }, { surfaceOp: 'append' })
    sShort.append('request/header', { header })
    sShort.append('user/message', { role: 'user', content: [{ type: 'text', text: userText }] }, { surfaceOp: 'append' })
    sShort.append('step/start', { turn: 1, step: 1 })
    sShort.append('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Okay.' }] },
      stream: textStream('Okay.'),
    }, { surfaceOp: 'append' })
    sShort.append('step/end', { turn: 1, step: 1 })

    const shortBudget = meter.measure(sShort).nodes[1].tokens
    const shortRes = await compaction.compactNow({
      session: sShort,
      options: { provider: 'test', model: 'large' },
      runMaintenance: (fn) => fn(signal),
    }, signal)
    assert.ok(shortRes !== null)
    assert.equal(shortRes.summary.length, 2)
    assert.match(shortRes.summary[1].text, /Active Constraints|Never deploy/)
    assert.doesNotMatch(shortRes.summary[1].text, /MUST survive every compaction/)
    assert.ok(framedTokens(shortRes.summary) < shortBudget)
    const shortCheckpoint = sShort.deriveEventMessage(sShort.eventAt(sShort.surface.nodes[1]))
    assert.match(shortCheckpoint.content.map((b) => b.text).join('\n'), /Never deploy/)

    const sTiny = sessions.create(undefined, { meta: { cwd: '/tmp' } })
    sTiny.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'System.' }] } }, { surfaceOp: 'append' })
    sTiny.append('request/header', { header })
    sTiny.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Never deploy.\n' + 'x'.repeat(600) }] }, { surfaceOp: 'append' })
    sTiny.append('step/start', { turn: 1, step: 1 })
    sTiny.append('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      stream: textStream('Done.'),
    }, { surfaceOp: 'append' })
    sTiny.append('step/end', { turn: 1, step: 1 })

    const tinyBudget = meter.measure(sTiny).nodes[1].tokens
    const tinyRes = await compaction.compactNow({
      session: sTiny,
      options: { provider: 'test', model: 'large' },
      runMaintenance: (fn) => fn(signal),
    }, signal)
    assert.ok(tinyRes !== null)
    assert.equal(tinyRes.summary.length, 1)
    assert.ok(framedTokens(tinyRes.summary) < tinyBudget)

    const sNonLeadingTight = sessions.create(undefined, { meta: { cwd: '/tmp' } })
    sNonLeadingTight.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'System.' }] } }, { surfaceOp: 'append' })
    sNonLeadingTight.append('request/header', { header })
    sNonLeadingTight.append('turn/start', { turn: 1 })
    sNonLeadingTight.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Earlier huge message: ' + 'word '.repeat(2000) }] }, { surfaceOp: 'append' })
    sNonLeadingTight.append('step/start', { turn: 1, step: 1 })
    sNonLeadingTight.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier huge reply.' }] }, stream: textStream('Earlier huge reply.') }, { surfaceOp: 'append' })
    sNonLeadingTight.append('step/end', { turn: 1, step: 1 })
    const uTight = sNonLeadingTight.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Never deploy without release approval first. ' + 'x'.repeat(500) }] }, { surfaceOp: 'append' })
    sNonLeadingTight.append('step/start', { turn: 1, step: 2 })
    const aTight = sNonLeadingTight.append('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'Understood.' }] }, stream: textStream('Understood.') }, { surfaceOp: 'append' })
    sNonLeadingTight.append('step/end', { turn: 1, step: 2 })
    sNonLeadingTight.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Trailing message.' }] }, { surfaceOp: 'append' })

    const tightNodes = meter.measure(sNonLeadingTight).nodes
    const tightBudget = tightNodes[3].tokens + tightNodes[4].tokens
    const nonLeadingTightRes = await compaction.compactRegion(uTight.seq, aTight.seq, { session: sNonLeadingTight, options: { provider: 'test', model: 'large' } }, signal)
    assert.ok(framedTokens(nonLeadingTightRes.summary) < tightBudget)
    assert.equal(nonLeadingTightRes.summary.length, 1)

    const sNonLeadingLarge = sessions.create(undefined, { meta: { cwd: '/tmp' } })
    sNonLeadingLarge.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'System.' }] } }, { surfaceOp: 'append' })
    sNonLeadingLarge.append('request/header', { header })
    sNonLeadingLarge.append('turn/start', { turn: 1 })
    sNonLeadingLarge.append('user/message', { role: 'user', content: [{ type: 'text', text: 'hi' }] }, { surfaceOp: 'append' })
    sNonLeadingLarge.append('step/start', { turn: 1, step: 1 })
    sNonLeadingLarge.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, stream: textStream('ok') }, { surfaceOp: 'append' })
    sNonLeadingLarge.append('step/end', { turn: 1, step: 1 })
    const uLarge = sNonLeadingLarge.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Never deploy without QA signoff. ' + 'huge '.repeat(2000) }] }, { surfaceOp: 'append' })
    sNonLeadingLarge.append('step/start', { turn: 1, step: 2 })
    const aLarge = sNonLeadingLarge.append('assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] }, stream: textStream('Noted.') }, { surfaceOp: 'append' })
    sNonLeadingLarge.append('step/end', { turn: 1, step: 2 })
    sNonLeadingLarge.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Trailing.' }] }, { surfaceOp: 'append' })

    const nonLeadingLargeRes = await compaction.compactRegion(uLarge.seq, aLarge.seq, { session: sNonLeadingLarge, options: { provider: 'test', model: 'large' } }, signal)
    assert.equal(nonLeadingLargeRes.summary.length, 2)
    assert.match(nonLeadingLargeRes.summary[1].text, /Never deploy without QA signoff\./)
  } finally {
    await ctx.fiber.dispose()
  }
})

await test('dynamic LlmRuntime window shrink or removal and tighter-then-looser disposal update shipped engine thresholds', async () => {
  const { LlmRuntime } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-llm/lib/index.js')))
  const textStream = (text) => [{ type: 'text-chunks', time0: 0, index: 0, dt: [0], texts: [text] }]
  const modelsMap = new Map([['m1', 1000000]])
  const resolveModel = async (_p, model) => {
    const cw = modelsMap.get(model)
    return cw ? { provider: 'p1', id: model, name: model, context: { contextWindow: cw }, defaultMaxTokens: 1000 } : undefined
  }
  const adapter = {
    providerInfo: (id) => ({ id, name: id }),
    providerRetryPolicy: () => undefined,
    listModels: async () => [...modelsMap.keys()].map((id) => ({ provider: 'p1', id, name: id })),
    resolveModel,
    prepareCall: async (p, model) => ({ model: await resolveModel(p, model), async *stream() {} }),
    imageRequestPricing: () => undefined,
    fileRequestText: (ref) => `[file:${ref?.id ?? 'x'}]`,
  }

  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(LlmRuntime)
  await flush()
  const regHandle = ctx.get('llm').registerAdapter(['p1'], adapter)
  await ctx.plugin(BasicCompactionEngine, { auto: false })
  const engine = ctx.get('compaction')
  const originalConfig = engine.config
  try {
    const fTight = await ctx.plugin(plugin, { note: 'off', forceAtTokens: 100000, minContextWindow: 500000 })
    const fLoose = await ctx.plugin(plugin, { note: 'off', forceAtTokens: 200000, minContextWindow: 500000 })
    await flush()
    assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.1)

    await fTight.dispose()
    await flush()
    assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.2)

    modelsMap.set('m1', 800000)
    regHandle.replace(['p1'])
    await flush()
    await flush()
    assert.equal(engine.config.modelPolicies[0].thresholdRatio, 0.25)

    const sessions = ctx.get('sessions')
    const header = { config: { provider: 'p1', model: 'm1', maxTokens: 1000 } }
    const s800 = sessions.create(undefined, { meta: { cwd: '/tmp' } })
    s800.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'Sys.' }] } }, { surfaceOp: 'append' })
    s800.append('request/header', { header })
    s800.append('turn/start', { turn: 1 })
    s800.append('user/message', { role: 'user', content: [{ type: 'text', text: 'a'.repeat(160000) }] }, { surfaceOp: 'append' })
    s800.append('step/start', { turn: 1, step: 1 })
    s800.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p1', model: 'm1' }, content: [{ type: 'text', text: 'ok' }] }, stream: textStream('ok') }, { surfaceOp: 'append' })
    s800.append('step/end', { turn: 1, step: 1 })
    s800.append('turn/end', { turn: 1 })
    s800.append('turn/start', { turn: 2 })
    s800.append('user/message', { role: 'user', content: [{ type: 'text', text: 'b'.repeat(540000) }] }, { surfaceOp: 'append' })
    s800.append('step/start', { turn: 2, step: 1 })
    s800.append('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p1', model: 'm1' }, content: [{ type: 'text', text: 'ok2' }] }, stream: textStream('ok2') }, { surfaceOp: 'append' })
    s800.append('step/end', { turn: 2, step: 1 })
    s800.append('user/message', { role: 'user', content: [{ type: 'text', text: 'latest' }] }, { surfaceOp: 'append' })
    assert.equal(await engine.compactPressure({ session: s800, options: header.config }, header, signal, false), null)

    modelsMap.set('m1', 300000)
    regHandle.replace(['p1'])
    await flush()
    await flush()
    assert.deepEqual(engine.config.modelPolicies, [])
    assert.equal(engine.config, originalConfig)

    const s300 = sessions.create(undefined, { meta: { cwd: '/tmp' } })
    s300.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'Sys.' }] } }, { surfaceOp: 'append' })
    s300.append('request/header', { header })
    s300.append('turn/start', { turn: 1 })
    s300.append('user/message', { role: 'user', content: [{ type: 'text', text: 'a'.repeat(100000) }] }, { surfaceOp: 'append' })
    s300.append('step/start', { turn: 1, step: 1 })
    s300.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p1', model: 'm1' }, content: [{ type: 'text', text: 'ok' }] }, stream: textStream('ok') }, { surfaceOp: 'append' })
    s300.append('step/end', { turn: 1, step: 1 })
    s300.append('turn/end', { turn: 1 })
    s300.append('turn/start', { turn: 2 })
    s300.append('user/message', { role: 'user', content: [{ type: 'text', text: 'b'.repeat(200000) }] }, { surfaceOp: 'append' })
    s300.append('step/start', { turn: 2, step: 1 })
    s300.append('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p1', model: 'm1' }, content: [{ type: 'text', text: 'ok2' }] }, stream: textStream('ok2') }, { surfaceOp: 'append' })
    s300.append('step/end', { turn: 2, step: 1 })
    s300.append('user/message', { role: 'user', content: [{ type: 'text', text: 'latest' }] }, { surfaceOp: 'append' })
    assert.equal(await engine.compactPressure({ session: s300, options: header.config }, header, signal, false), null)

    await fLoose.dispose()
    assert.equal(engine.config, originalConfig)
  } finally {
    await ctx.fiber.dispose()
  }
})

await test('unmounted LlmRuntime adapters-updated invalidates catalogCache cleanly without leaking root listeners', async () => {
  const { LlmRuntime } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-llm/lib/index.js')))
  const modelsMap = new Map([['m1', 1000000]])
  let listCalls = 0
  const resolveModel = async (_p, model) => {
    const cw = modelsMap.get(model)
    return cw ? { provider: 'p1', id: model, name: model, context: { contextWindow: cw }, defaultMaxTokens: 1000 } : undefined
  }
  const adapter = {
    providerInfo: (id) => ({ id, name: id }),
    providerRetryPolicy: () => undefined,
    listModels: async () => {
      listCalls += 1
      return [...modelsMap.keys()].map((id) => ({ provider: 'p1', id, name: id }))
    },
    resolveModel,
    prepareCall: async (p, model) => ({ model: await resolveModel(p, model), async *stream() {} }),
    imageRequestPricing: () => undefined,
    fileRequestText: (ref) => `[file:${ref?.id ?? 'x'}]`,
  }

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await flush()
  const regHandle = ctx.get('llm').registerAdapter(['p1'], adapter)
  ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 10000 }) })
  ctx.provide('sessions', { registerMessageProjection: () => () => {} })
  await ctx.plugin(BasicCompactionEngine, { auto: false })
  const engine = ctx.get('compaction')
  const originalConfig = engine.config
  try {
    const f1 = await ctx.plugin(plugin, { note: 'off', forceAtTokens: 200000, minContextWindow: 500000 })
    await flush()
    assert.equal(listCalls, 1)
    assert.deepEqual(engine.config.modelPolicies.map((p) => p.model), ['m1'])
    await f1.dispose()
    assert.equal(engine.config, originalConfig)
    assert.equal(ctx.events._hooks['llm/adapters-updated'], undefined)

    modelsMap.set('m2', 2000000)
    regHandle.replace(['p1'])
    await flush()

    const f2 = await ctx.plugin(plugin, { note: 'off', forceAtTokens: 200000, minContextWindow: 500000 })
    await flush()
    assert.equal(listCalls, 2)
    assert.deepEqual(engine.config.modelPolicies.map((p) => [p.model, p.thresholdRatio]), [['m1', 0.2], ['m2', 0.1]])

    const scopeA = ctx.isolate('toolResultPruner')
    const fOverlap = await scopeA.plugin(plugin, { note: 'off', forceAtTokens: 100000, minContextWindow: 500000 })
    await flush()
    assert.equal(listCalls, 2)
    assert.deepEqual(engine.config.modelPolicies.map((p) => [p.model, p.thresholdRatio]), [['m1', 0.1], ['m2', 0.05]])

    await f2.dispose()
    const scopeB = ctx.isolate('toolResultPrunerB')
    const fOverlap2 = await scopeB.plugin(plugin, { note: 'off', forceAtTokens: 150000, minContextWindow: 500000 })
    await flush()
    assert.equal(listCalls, 2)

    await fOverlap.dispose()
    await fOverlap2.dispose()
    assert.equal(engine.config, originalConfig)
    assert.equal(ctx.events._hooks['llm/adapters-updated'], undefined)
  } finally {
    await ctx.fiber.dispose()
  }
})

await test('in-flight collectCatalog unmounted before resolution never repopulates stale cache after remount', async () => {
  const { LlmRuntime } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-llm/lib/index.js')))
  let firstStarted
  let releaseFirst
  const firstReady = new Promise((resolve) => { firstStarted = resolve })
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  let callNum = 0
  let modelsMap = new Map([['m1', 1000000]])
  const resolveModel = async (_p, model) => {
    const cw = modelsMap.get(model)
    return cw ? { provider: 'p1', id: model, name: model, context: { contextWindow: cw }, defaultMaxTokens: 1000 } : undefined
  }
  const adapter = {
    providerInfo: (id) => ({ id, name: id }),
    providerRetryPolicy: () => undefined,
    listModels: async () => {
      callNum += 1
      if (callNum === 1) {
        const snapshot = [...modelsMap.keys()]
        firstStarted()
        await firstGate
        return snapshot.map((id) => ({ provider: 'p1', id, name: id }))
      }
      return [...modelsMap.keys()].map((id) => ({ provider: 'p1', id, name: id }))
    },
    resolveModel,
    prepareCall: async (p, model) => ({ model: await resolveModel(p, model), async *stream() {} }),
    imageRequestPricing: () => undefined,
    fileRequestText: (ref) => `[file:${ref?.id ?? 'x'}]`,
  }

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await flush()
  const regHandle = ctx.get('llm').registerAdapter(['p1'], adapter)
  ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 10000 }) })
  ctx.provide('sessions', { registerMessageProjection: () => () => {} })
  await ctx.plugin(BasicCompactionEngine, { auto: false })
  const engine = ctx.get('compaction')
  try {
    const f1 = await ctx.plugin(plugin, { note: 'off', forceAtTokens: 200000, minContextWindow: 500000 })
    await firstReady
    await f1.dispose()

    modelsMap = new Map([['m1', 1000000], ['m2', 2000000]])
    regHandle.replace(['p1'])
    releaseFirst()
    await flush()
    await flush()

    const f2 = await ctx.plugin(plugin, { note: 'off', forceAtTokens: 200000, minContextWindow: 500000 })
    await flush()
    assert.deepEqual(engine.config.modelPolicies.map((p) => p.model), ['m1', 'm2'])
    await f2.dispose()
  } finally {
    releaseFirst()
    await ctx.fiber.dispose()
  }
})

console.log(`${passed} passed, ${failed} failed (real Cordis lifecycle and shipped engine; controlled catalog and summarizer)`)
if (failed) process.exitCode = 1
