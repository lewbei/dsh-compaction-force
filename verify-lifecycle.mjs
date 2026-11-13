import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as plugin from './index.js'

assert(process.argv[2], 'Pass the installed DSH node_modules directory')
const modules = resolve(process.argv[2])
const { Context, Service } = await import(pathToFileURL(join(modules, '@deepseek-ai/cordis/lib/index.js')))
const { BasicCompactionEngine } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-compaction-basic/lib/index.js')))
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

console.log(`${passed} passed, ${failed} failed (real Cordis lifecycle and shipped engine; controlled catalog and summarizer)`)
if (failed) process.exitCode = 1
