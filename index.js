/**
 * @local/dsh-compaction-force — host half.
 *
 * Two capabilities for the Guarded preset:
 *
 * 1. **Early pressure compaction on large-context models.** For every model
 *    whose adapter reports `contextWindow > minContextWindow` (default
 *    500_000), install a per-model compaction policy with
 *    `thresholdRatio = forceAtTokens / contextWindow` (default
 *    262_144 / window). dsh-compaction-basic then resolves
 *
 *      threshold = min(thresholdRatio * W, W - reserved - headroomTokens)
 *
 *    so a ~256 K target is reached whenever the routed request's output
 *    reservation plus the 64 K headroom leave that much budget (deepseek,
 *    opencode-go and inception 1 M routes do). Models at or below
 *    minContextWindow keep the shipped policy untouched.
 *
 * 2. **A note in the checkpoint the model receives.** The plugin wraps the
 *    compaction engine's public `summarize` and appends one or both of:
 *      - `context`: a footer note stating the earlier span was compacted at
 *        ~N tokens/time and the checkpoint is authoritative;
 *      - `handoff`: a "Note to Self (handoff)" section extracted from the
 *        summary's Current Work / Next Step / Critical Context sections.
 *
 * Both are configurable per row, which also makes them A/B-testable:
 *   config: { forceAtTokens, minContextWindow, note: off|context|handoff|both, heading }
 *
 * The plugin only touches the live compaction service instance
 * (`engine.config` is a frozen object but the property is replaceable) and
 * `engine.summarize`; shipped packages are never modified.
 */

export const name = 'compaction-force'

export const DEFAULTS = Object.freeze({
  forceAtTokens: 262144,
  minContextWindow: 500000,
  note: 'handoff',
  heading: 'Note to Self (handoff)',
  scExtract: 'pattern',
})

const NOTE_VARIANTS = new Set(['off', 'context', 'handoff', 'both'])
const WRAPPED = Symbol.for('@local/dsh-compaction-force/wrapped')
const CATALOG_TTL_MS = 5 * 60 * 1000

/** Cached provider/model catalog per llm service, with an in-flight promise. */
const catalogCache = new WeakMap()

/** Normalize one row config into a complete, validated option set. */
export function normalizeOptions(config = {}) {
  const forceAtTokens = Number.isInteger(config?.forceAtTokens) && config.forceAtTokens > 0
    ? config.forceAtTokens
    : DEFAULTS.forceAtTokens
  const minContextWindow = Number.isInteger(config?.minContextWindow) && config.minContextWindow > 0
    ? config.minContextWindow
    : DEFAULTS.minContextWindow
  const note = NOTE_VARIANTS.has(config?.note) ? config.note : DEFAULTS.note
  const heading = typeof config?.heading === 'string' && config.heading.trim().length > 0
    ? config.heading.replace(/[\r\n<>]+/g, ' ').replace(/\s+/g, ' ').trim()
    : DEFAULTS.heading
  const scExtract = ['off', 'pattern'].includes(config?.scExtract) ? config.scExtract : DEFAULTS.scExtract
  return { forceAtTokens, minContextWindow, note, heading, scExtract }
}

const round6 = (value) => Math.round(value * 1e6) / 1e6

/**
 * Build the per-model policies for one catalog.
 *
 * @param {{ provider: string, model: string, contextWindow: number }[]} models
 * @param {{ forceAtTokens?: number, minContextWindow?: number }} [options]
 * @returns {{ provider: string, model: string, thresholdRatio: number, retainRatio?: number }[]}
 */
export function buildPolicies(models, options = {}) {
  const forceAtTokens = Number.isInteger(options.forceAtTokens) && options.forceAtTokens > 0
    ? options.forceAtTokens
    : DEFAULTS.forceAtTokens
  const minContextWindow = Number.isInteger(options.minContextWindow) && options.minContextWindow > 0
    ? options.minContextWindow
    : DEFAULTS.minContextWindow
  const seen = new Set()
  const policies = []
  for (const entry of Array.isArray(models) ? models : []) {
    const provider = entry?.provider
    const model = entry?.model
    const window = entry?.contextWindow
    if (typeof provider !== 'string' || provider.length === 0) continue
    if (typeof model !== 'string' || model.length === 0) continue
    if (!Number.isInteger(window) || window <= minContextWindow) continue
    // A force target at or above the window (misconfigured row) would produce a
    // thresholdRatio > 0.8, i.e. later than the shipped policy: skip it rather
    // than silently installing a meaningless (or invalid >1) ratio.
    if (window <= forceAtTokens) continue
    const key = `${provider}\u0000${model}`
    if (seen.has(key)) continue
    seen.add(key)
    const thresholdRatio = round6(forceAtTokens / window)
    if (thresholdRatio >= 0.8) continue
    const policy = { provider, model, thresholdRatio }
    // dsh-compaction-basic rejects retain >= threshold. Windows above
    // ~1.64 M (and scaled A/B runs) make the force target a smaller fraction
    // than the default retain ratio, so retain half the forced threshold.
    // `<=` (not `<`) covers the 6-decimal rounding band where the ratio lands
    // exactly on 0.16 and retain would otherwise equal the threshold.
    if (thresholdRatio <= 0.16) policy.retainRatio = round6(thresholdRatio / 2)
    policies.push(policy)
  }
  return policies
}

/** Read every registered provider's advertised models with their context windows. */
export async function collectCatalog(llm) {
  const entries = []
  let providers = []
  try {
    providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
  } catch {
    return entries
  }
  for (const providerInfo of Array.isArray(providers) ? providers : []) {
    const provider = typeof providerInfo === 'string' ? providerInfo : providerInfo?.id
    if (typeof provider !== 'string' || provider.length === 0) continue
    let models = []
    try {
      models = await llm.listModels(provider)
    } catch {
      continue
    }
    for (const modelInfo of Array.isArray(models) ? models : []) {
      const model = modelInfo?.id
      if (typeof model !== 'string' || model.length === 0) continue
      try {
        const info = await llm.resolveModelInfo(provider, model)
        const window = info?.context?.contextWindow
        if (Number.isInteger(window) && window > 0) entries.push({ provider, model, contextWindow: window })
      } catch {
        // A route without a resolvable model (offline adapter, stale catalog)
        // is skipped; the remaining models still get policies.
      }
    }
  }
  return entries
}

/** Cached catalog: one enumeration per llm service per TTL, shared by engines. */
export function catalogFor(llm) {
  const hit = catalogCache.get(llm)
  const now = Date.now()
  if (hit !== undefined && hit.models !== undefined && now - hit.at < CATALOG_TTL_MS) return Promise.resolve(hit.models)
  if (hit !== undefined && hit.promise !== undefined) return hit.promise
  const promise = collectCatalog(llm)
    .catch(() => [])
    .then((models) => {
      catalogCache.set(llm, { at: Date.now(), models })
      return models
    })
  catalogCache.set(llm, { at: 0, promise })
  return promise
}

/**
 * Install the per-model early-compaction policies on one compaction engine.
 * The engine object itself is not frozen; `engine.config` is a frozen value
 * but the property is writable, so a new frozen config replaces it atomically.
 */
export async function installPolicies(engine, llm, options = {}) {
  if (engine === null || typeof engine !== 'object') return 0
  const models = await catalogFor(llm)
  const policies = buildPolicies(models, options)
  if (policies.length === 0) return 0
  try {
    const existing = Array.isArray(engine.config?.modelPolicies) ? engine.config.modelPolicies : []
    const merged = new Map(existing.map((policy) => [`${policy.provider}\u0000${policy.model}`, policy]))
    for (const policy of policies) merged.set(`${policy.provider}\u0000${policy.model}`, policy)
    const next = Object.freeze({ ...engine.config, modelPolicies: [...merged.values()] })
    engine.config = next
    return policies.length
  } catch {
    return 0
  }
}

/** Extract up to maxBullets bullet items under one `## Heading` section. */
export function sectionBullets(summaryText, heading, maxBullets = 2, maxChars = 400) {
  const lines = String(summaryText ?? '').replace(/\r\n?/g, '\n').split('\n')
  const target = `## ${heading}`.toLowerCase()
  const start = lines.findIndex((line) => line.trim().toLowerCase() === target)
  if (start < 0) return []
  const bullets = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^#{1,6}\s/.test(line.trim())) break
    const match = line.match(/^\s*[-*]\s+(.*)$/)
    if (match === null) continue
    const text = match[1].trim()
    if (text.length === 0) continue
    bullets.push(text.length > maxChars ? `${text.slice(0, maxChars)}…` : text)
    if (bullets.length >= maxBullets) break
  }
  return bullets
}

/**
 * Heuristic extraction of side constraints (SCs) from the conversation being
 * compacted. SCs are user-issued instructions that bind the agent's behaviour
 * for the rest of the session ("don't send without approval", "show me the
 * draft first", ...). The shipped summarizer is task-centric and drops most of
 * them; extracting them from the raw input (before compaction) and re-injecting
 * them into the checkpoint is the "architectural separation" that closes the
 * gap the CompInt benchmark measures (17% -> 90%+ retention).
 *
 * @param {Array} messages - the conversation prefix being compacted.
 * @returns {string[]} de-duplicated constraint clauses (each trimmed, <=240 chars).
 */
export function extractSideConstraints(messages) {
  const constraintRe = /\b(don'?t|do not|never|always|must(?:\s+not)?|should(?:\s+not)?|before (?:you|any)|wait for (?:my|your)|confirm (?:with|before)|ask (?:me|before)|show me (?:the|what)|until i (?:say|tell|confirm)|unless i|only (?:when|if|after)|no (?:emails?|messages?|files?|changes?|deletions?|emails|sending)|avoid|prevent|ensure (?:that|you)|require(?:d)? (?:that|to)|from now on|for the rest of (?:this )?session)\b/i
  const seen = new Set()
  const out = []
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (msg === null || typeof msg !== 'object') continue
    if (msg.role !== 'user') continue
    const content = Array.isArray(msg.content) ? msg.content : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [])
    for (const block of content) {
      if (block === null || typeof block !== 'object' || typeof block.text !== 'string') continue
      // Split into sentences; keep those that look like constraints.
      const sentences = block.text.split(/(?<=[.!?])\s+/)
      for (const raw of sentences) {
        const sentence = raw.trim()
        if (sentence.length < 8 || sentence.length > 400) continue
        if (!constraintRe.test(sentence)) continue
        // Skip the probe/question itself (ends with ?) — those are tests, not constraints.
        if (sentence.endsWith('?')) continue
        const key = sentence.toLowerCase().replace(/\s+/g, ' ')
        if (seen.has(key)) continue
        seen.add(key)
        out.push(sentence.length > 240 ? `${sentence.slice(0, 237)}...` : sentence)
        if (out.length >= 8) return out
      }
    }
  }
  return out
}

/** Build the note text appended to a checkpoint (empty string when nothing to add). */
export function buildNoteText({ variant, heading = DEFAULTS.heading, summaryText = '', totalTokens = null, timestamp = null, sideConstraints = [] }) {
  const parts = []
  if (variant === 'context' || variant === 'both') {
    const size = Number.isInteger(totalTokens) && totalTokens > 0
      ? `~${Math.round(totalTokens / 1000)}K tokens`
      : 'the context limit'
    const when = typeof timestamp === 'string' && timestamp.length > 0 ? ` on ${timestamp}` : ''
    parts.push([
      '## Note to Self (context)',
      `- The earlier conversation was compacted at ${size}${when}.`,
      '- This checkpoint is the authoritative record of that span; do not restate it.',
      '- Re-read a file before editing it if you are relying on a pre-compaction memory.',
    ].join('\n'))
  }
  if (Array.isArray(sideConstraints) && sideConstraints.length > 0) {
    const scLines = ['## Active Constraints (preserve these)']
    for (const sc of sideConstraints) scLines.push(`- ${sc}`)
    scLines.push('- These are user-issued side constraints for this session; they MUST survive every compaction.')
    parts.push(scLines.join('\n'))
  }
  if (variant === 'handoff' || variant === 'both') {
    const where = sectionBullets(summaryText, 'Current Work')
    const next = sectionBullets(summaryText, 'Next Step', 1, 300)
    const guard = sectionBullets(summaryText, 'Critical Context', 3, 300)
    const lines = [`## ${heading}`]
    if (where.length > 0) lines.push(`- Where I was: ${where.join(' ')}`)
    if (next.length > 0) lines.push(`- Next: ${next.join(' ')}`)
    if (guard.length > 0) lines.push(`- Guardrails: ${guard.join(' ')}`)
    if (lines.length === 1) lines.push('- Resume from the checkpoint above; its "Current Work" and "Next Step" sections are authoritative.')
    parts.push(lines.join('\n'))
  }
  return parts.length === 0 ? '' : `\n\n${parts.join('\n\n')}\n`
}

/** Measure the session's current tokens, tolerating a missing/broken meter. */
function measureTokens(ctx, agent) {
  try {
    const meter = ctx?.tokenMeter
    if (meter === null || meter === undefined || typeof meter.measure !== 'function') return null
    const measurement = meter.measure(agent?.session)
    const total = measurement?.totalTokens
    return Number.isInteger(total) && total > 0 ? total : null
  } catch {
    return null
  }
}

/** Wrap one engine's public summarize; appended note blocks land inside the checkpoint. */
export function wrapSummarize(engine, ctx, options = {}) {
  if (engine === null || typeof engine !== 'object') return false
  if (engine[WRAPPED] === true) return false
  const original = engine.summarize
  if (typeof original !== 'function') return false
  const variant = options.note
  const heading = options.heading ?? DEFAULTS.heading
  const scExtract = options.scExtract ?? DEFAULTS.scExtract
  try {
    engine.summarize = async function summarize(input, agent, signal) {
      const result = await original.call(this, input, agent, signal)
      if (variant === 'off' || result === null || typeof result !== 'object' || !Array.isArray(result.summary)) return result
      const summaryText = result.summary
        .map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
        .join('\n')
      const sideConstraints = options.scExtract === 'pattern'
        ? extractSideConstraints(Array.isArray(input?.messages) ? input.messages : [])
        : []
      const text = buildNoteText({
        variant,
        heading,
        summaryText,
        totalTokens: measureTokens(ctx, agent),
        timestamp: new Date().toISOString(),
        sideConstraints,
      })
      if (text.length === 0) return result
      return { ...result, summary: [...result.summary, { type: 'text', text }] }
    }
    engine[WRAPPED] = true
    return true
  } catch {
    return false
  }
}

/**
 * Cordis entry point. Wraps the isolated compaction engine (so the row must be
 * mounted inside the preset's compaction group) and installs the catalog-driven
 * policies asynchronously and logs the installed count; `agent/pre-step` fires
 * before every step, so a resumed session already above the threshold may see
 * one shipped-policy step before the install completes (the install retries
 * when the boot catalog is still empty).
 */
export function apply(ctx, config = {}) {
  const options = normalizeOptions(config)
  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (logger !== null && logger !== undefined && typeof logger[level] === 'function') logger[level](message)
    } catch {
      // logging is best-effort; never let it affect activation
    }
  }
  if (config?.note !== undefined && !NOTE_VARIANTS.has(config.note)) {
    log('warn', `compaction-force: unknown note value ${JSON.stringify(config.note)}; using "${options.note}"`)
  }
  ctx.inject(['compaction', 'llm', 'tokenMeter'], (scope) => {
    const engine = scope?.compaction
    const llm = scope?.llm
    if (engine === undefined || engine === null || typeof engine !== 'object') return
    // `scope` carries tokenMeter; the note's token count comes from it.
    if (wrapSummarize(engine, scope, options)) {
      // The catalog is enumerated asynchronously. Log the activation so a
      // post-restart operator can tell "installed 94 policies" from "installed
      // none"; retry twice when the boot catalog was still empty (the llm
      // adapters of the web profile register slightly after the service).
      const install = async (attempt) => {
        const installed = await installPolicies(engine, llm, options)
        if (installed > 0) {
          log('info', `compaction-force: installed ${installed} model policies (forceAtTokens=${options.forceAtTokens}, minContextWindow=${options.minContextWindow})`)
          return
        }
        if (attempt < 2) {
          catalogCache.delete(llm)
          globalThis.setTimeout?.(() => void install(attempt + 1), attempt === 0 ? 500 : 2000)
          return
        }
        log('warn', `compaction-force: no model policies installed (empty catalog or no window > ${options.minContextWindow}); compaction keeps the shipped threshold`)
      }
      void install(0)
    }
  })
}
