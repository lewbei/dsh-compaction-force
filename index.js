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

import { isDeepStrictEqual } from 'node:util'

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

/** Accept a positive integer, or a numeric string (e.g. YAML `"1000"`). */
const toPositiveInt = (value, fallback) => {
  let parsed = value
  if (typeof parsed === 'string' && parsed.trim() !== '') parsed = Number(parsed)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Normalize one row config into a complete, validated option set. */
export function normalizeOptions(config = {}) {
  const forceAtTokens = toPositiveInt(config?.forceAtTokens, DEFAULTS.forceAtTokens)
  const minContextWindow = toPositiveInt(config?.minContextWindow, DEFAULTS.minContextWindow)
  const note = NOTE_VARIANTS.has(config?.note) ? config.note : DEFAULTS.note
  const rawHeading = typeof config?.heading === 'string' ? config.heading : ''
  const sanitizedHeading = rawHeading.replace(/[\r\n<>]+/g, ' ').replace(/\s+/g, ' ').trim()
  const heading = sanitizedHeading.length > 0 ? sanitizedHeading : DEFAULTS.heading
  const scExtract = ['off', 'pattern'].includes(config?.scExtract) ? config.scExtract : DEFAULTS.scExtract
  return { forceAtTokens, minContextWindow, note, heading, scExtract }
}

const round6 = (value) => Math.round(value * 1e6) / 1e6

/** Shipped retention ratio assumed when a config row or service default omits it. */
const DEFAULT_RETAIN_RATIO = 0.16

/** Bound an emitted retention so it is strictly below the threshold and positive. */
const validRetention = (thresholdRatio) => {
  const halved = round6(thresholdRatio / 2)
  return halved > 0 && halved < thresholdRatio ? halved : thresholdRatio / 2
}

/**
 * Build the per-model policies for one catalog.
 *
 * @param {{ provider: string, model: string, contextWindow: number }[]} models
 * @param {{ forceAtTokens?: number, minContextWindow?: number }} [options]
 * @param {{ previousRows?: Map<string, object>|object[], serviceConfig?: object }} [context]
 *   The engine's current rows and config, so generated rows resolve the actual
 *   retention mode (retainRatio vs retainTokens) and never rely on an inherited
 *   retention that the new threshold would make invalid.
 * @returns {{ provider: string, model: string, thresholdRatio: number, retainRatio?: number, retainTokens?: number }[]}
 */
export function buildPolicies(models, options = {}, context = {}) {
  const forceAtTokens = toPositiveInt(options.forceAtTokens, DEFAULTS.forceAtTokens)
  const minContextWindow = toPositiveInt(options.minContextWindow, DEFAULTS.minContextWindow)
  const previousRows = context.previousRows instanceof Map
    ? context.previousRows
    : new Map(Array.isArray(context.previousRows)
        ? context.previousRows.filter((row) => row !== null && typeof row === 'object').map((row) => [policyKey(row), row])
        : [])
  const serviceConfig = context.serviceConfig ?? {}
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
    if (thresholdRatio <= 0 || thresholdRatio >= 0.8) continue
    const policy = { provider, model, thresholdRatio }
    const prior = previousRows.get(key)
    // Resolve the retention mode the installed row would actually inherit.
    // The engine rejects retainRatio >= thresholdRatio and forbids combining
    // retainRatio with retainTokens, so the emitted row must pick one mode and
    // carry a value that stays valid under the new threshold.
    // A row's own retention mode wins over the service config, matching the
    // engine's per-row override resolution.
    const mode = prior?.retainTokens !== undefined ? 'tokens'
      : prior?.retainRatio !== undefined ? 'ratio'
        : serviceConfig.retainTokens !== undefined ? 'tokens'
          : 'ratio'
    if (mode === 'tokens') {
      const retainTokens = prior?.retainTokens ?? serviceConfig.retainTokens
      // Max possible threshold tokens is floor(window * thresholdRatio); any
      // retained tail at/above it can never be valid, so shrink it explicitly.
      if (Number.isInteger(retainTokens) && retainTokens >= Math.floor(window * thresholdRatio)) {
        policy.retainTokens = Math.max(Math.floor(window * thresholdRatio / 2), 0)
      }
    } else {
      const inherited = typeof prior?.retainRatio === 'number' && Number.isFinite(prior.retainRatio)
        ? prior.retainRatio
        : typeof serviceConfig.retainRatio === 'number' && Number.isFinite(serviceConfig.retainRatio)
          ? serviceConfig.retainRatio
          : DEFAULT_RETAIN_RATIO
      // dsh-compaction-basic requires 0 < retain < threshold. Keep the usual
      // rounding unless it collapses the gap at a tiny scaled threshold, and
      // emit an explicit retention whenever the inherited ratio would be
      // invalid under the new threshold.
      if (thresholdRatio <= 0.16 || round6(inherited) >= thresholdRatio) {
        policy.retainRatio = validRetention(thresholdRatio)
      }
    }
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
export async function installPolicies(engine, llm, options = {}, commit) {
  if (engine === null || typeof engine !== 'object') return 0
  const models = await catalogFor(llm)
  const previous = engine.config
  // Drop malformed rows (e.g. null entries) instead of aborting installation; a
  // healthy reinstall replaces the config wholesale and self-heals.
  const existing = Array.isArray(previous?.modelPolicies) ? previous.modelPolicies.filter((row) => row !== null && typeof row === 'object') : []
  const policies = buildPolicies(models, options, { previousRows: existing, serviceConfig: previous })
  if (policies.length === 0) return 0
  try {
    const merged = new Map(existing.map((policy) => [policyKey(policy), policy]))
    for (const policy of policies) {
      const key = policyKey(policy)
      const prior = merged.get(key)
      // Preserve unrelated per-model fields (headroomTokens, maxTokens,
      // summarizationProvider/Model, retention) on a same-key replacement;
      // only the generated fields override them.
      merged.set(key, prior === undefined ? policy : { ...prior, ...policy })
    }
    const rows = [...merged.values()]
    const next = Object.freeze({ ...previous, modelPolicies: rows })
    // Pass the exact row objects that land in `next` so a commit receipt's
    // ownership identity matches what disposal will compare against.
    if (commit === undefined) engine.config = next
    else if (!commit(previous, next, rows)) return 0
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

/** Heading of the plugin's own Active Constraints section (generated, not user). */
const SC_SECTION_HEADING = 'Active Constraints (preserve these)'
/** Heading of the plugin's own context note section (generated, not user). */
const SC_CONTEXT_NOTE_HEADING = 'Note to Self (context)'
/** The plugin's generated footer must never be counted as a user constraint. */
const SC_FOOTER = 'these are user-issued side constraints for this session; they must survive every compaction.'
/** The plugin's generated authority line must never be counted as a constraint. */
const SC_AUTHORITY_LINE = 'this checkpoint is the authoritative record of that span; do not restate it.'

/**
 * Split one text block into extraction candidates.
 *
 * The plugin's own previously-generated checkpoint sections are skipped so
 * their headings, bullets and footer are never re-counted as user constraints
 * (that previously consumed the cap and dropped genuine new instructions).
 * Lines and paragraphs are split before bounded sentence extraction so a
 * multiline, unpunctuated constraint list is not discarded as one over-long
 * candidate.
 */
function splitSCCandidates(text, syntheticHeadings) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const candidates = []
  let paragraph = []
  let inSynthetic = false
  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const joined = paragraph.join(' ')
    for (const sentence of joined.split(/(?<=[.!?])\s+/)) {
      const trimmed = sentence.trim()
      if (trimmed.length > 0) candidates.push(trimmed)
    }
    paragraph = []
  }
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0) {
      flushParagraph()
      continue
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    if (heading !== null) {
      flushParagraph()
      inSynthetic = syntheticHeadings.has(heading[1].replace(/\s+/g, ' ').trim().toLowerCase())
      continue
    }
    if (inSynthetic) {
      // Only bullets and blank continuation belong to a generated section;
      // genuine prose appended after the note must not be swallowed.
      if (/^(?:[-*+•]|\d{1,3}[.)])\s+/.test(line) || line.length === 0) continue
      inSynthetic = false
    }
    const bullet = line.match(/^(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/)
    if (bullet !== null) {
      flushParagraph()
      candidates.push(bullet[1].trim())
      continue
    }
    // A line that ends a sentence belongs to a flowing paragraph; an
    // unpunctuated line is a standalone fragment (a bare constraint bullet)
    // that must survive on its own.
    if (/[.!?]$/.test(line)) paragraph.push(line)
    else candidates.push(line)
  }
  flushParagraph()
  return candidates
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
 * @param {{ heading?: string }} [options] - the plugin's configured handoff
 *   heading, so its previously-generated section is skipped too.
 * @returns {string[]} de-duplicated constraint clauses (each trimmed, <=240 chars).
 */
export function extractSideConstraints(messages, options = {}) {
  const constraintRe = /\b(don'?t|do not|never|always|must(?:\s+not)?|should(?:\s+not)?|before (?:you|any)|wait for (?:my|your)|confirm (?:with|before)|ask (?:me|before)|show me (?:the|what)|until i (?:say|tell|confirm)|unless i|only (?:when|if|after)|no (?:emails?|messages?|files?|changes?|deletions?|emails|sending)|avoid|prevent|ensure (?:that|you)|require(?:d)? (?:that|to)|from now on|for the rest of (?:this )?session)\b/i
  const syntheticHeadings = new Set([
    SC_SECTION_HEADING.toLowerCase(),
    SC_CONTEXT_NOTE_HEADING.toLowerCase(),
    String(options.heading ?? DEFAULTS.heading).toLowerCase(),
  ])
  const seen = new Set()
  const out = []
  // Scan newest messages first so the 8-slot cap keeps the freshest constraints
  // (the ones most likely to still bind), instead of silently dropping them.
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const msg = list[index]
    if (msg === null || typeof msg !== 'object') continue
    if (msg.role !== 'user') continue
    const content = Array.isArray(msg.content) ? msg.content : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [])
    for (const block of content) {
      if (block === null || typeof block !== 'object' || typeof block.text !== 'string') continue
      for (const raw of splitSCCandidates(block.text, syntheticHeadings)) {
        const candidate = raw.replace(/\s+/g, ' ').trim()
        if (candidate.length < 8) continue
        if (candidate.endsWith('?')) continue
        const lower = candidate.toLowerCase()
        if (lower === SC_FOOTER || lower.includes(SC_FOOTER)) continue
        if (lower === SC_AUTHORITY_LINE || lower.includes(SC_AUTHORITY_LINE)) continue
        // Match against the full text; store a truncated copy for over-long
        // single-line candidates instead of dropping them.
        if (!constraintRe.test(candidate)) continue
        const display = candidate.length > 400 ? `${candidate.slice(0, 397)}...` : candidate
        // Dedup ignoring trailing punctuation ("Never deploy." ≡ "never deploy!").
        const key = lower.replace(/[!?.,;:]+$/g, '')
        if (seen.has(key)) continue
        seen.add(key)
        out.push(display.length > 240 ? `${display.slice(0, 237)}...` : display)
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
    for (const sc of sideConstraints) {
      // Sanitize so a constraint cannot inject extra markdown/newlines into the note.
      scLines.push(`- ${String(sc).replace(/\s+/g, ' ').trim()}`)
    }
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
function mountSummary(engine, ctx, options = {}) {
  if (engine === null || typeof engine !== 'object' || engine[WRAPPED]) return null
  const original = engine.summarize
  if (typeof original !== 'function') return null
  const descriptor = Object.getOwnPropertyDescriptor(engine, 'summarize')
  const markerDescriptor = Object.getOwnPropertyDescriptor(engine, WRAPPED)
  const token = {}
  let active = true
  const variant = options.note
  const heading = options.heading ?? DEFAULTS.heading
  const summarize = async function (input, agent, signal) {
    const result = await original.call(this, input, agent, signal)
    if (!active || variant === 'off' || result === null || typeof result !== 'object' || !Array.isArray(result.summary)) return result
    const summaryText = result.summary
      .map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
      .join('\n')
    const sideConstraints = options.scExtract === 'pattern'
      ? extractSideConstraints(Array.isArray(input?.messages) ? input.messages : [], { heading: options.heading })
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
  const dispose = () => {
    active = false
    try {
      if (Object.getOwnPropertyDescriptor(engine, 'summarize')?.value === summarize) {
        if (descriptor) Object.defineProperty(engine, 'summarize', descriptor)
        else delete engine.summarize
      }
    } finally {
      if (engine[WRAPPED] === token) {
        if (markerDescriptor) Object.defineProperty(engine, WRAPPED, markerDescriptor)
        else delete engine[WRAPPED]
      }
    }
  }
  try {
    engine.summarize = summarize
    engine[WRAPPED] = token
    return dispose
  } catch {
    dispose()
    return null
  }
}

export function wrapSummarize(engine, ctx, options = {}) {
  return mountSummary(engine, ctx, options) !== null
}

const policyKey = policy => `${policy.provider}\u0000${policy.model}`

function restorePolicies(engine, receipt) {
  const current = engine.config
  if (!Array.isArray(current?.modelPolicies)) return
  let changed = false
  const restored = current.modelPolicies.flatMap(policy => {
    const owned = receipt.rows.get(policyKey(policy))
    if (!owned || policy !== owned.installed || !isDeepStrictEqual(policy, owned.snapshot)) return [policy]
    changed = true
    return owned.previous === undefined ? [] : [owned.previous]
  })
  if (!changed) return
  const previousRows = receipt.previous?.modelPolicies ?? []
  const matchesPrevious = restored.length === previousRows.length && restored.every((row, index) => row === previousRows[index])
  engine.config = current === receipt.next && matchesPrevious
    ? receipt.previous
    : Object.freeze({ ...current, modelPolicies: restored })
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
    scope.effect(() => {
      // Policy installation is independent of the summary wrapper: a second
      // instance on the same engine (or an engine whose summarize is not a
      // function) must still install its policies.
      const disposeSummary = mountSummary(engine, scope, options) ?? (() => {})
      let active = true
      const timers = new Set()
      const receipts = []
      const commit = (previous, next, policies) => {
        const previousRows = new Map((previous?.modelPolicies ?? []).map(row => [policyKey(row), row]))
        const receipt = {
          previous,
          next,
          rows: new Map(policies.map(row => [policyKey(row), {
            previous: previousRows.get(policyKey(row)), installed: row, snapshot: { ...row },
          }])),
        }
        if (!active) return false
        engine.config = next
        receipts.push(receipt)
        return true
      }
      const install = async (attempt) => {
        if (!active) return
        try {
          const installed = await installPolicies(engine, llm, options, commit)
          if (!active) return
          if (installed > 0) {
            log('info', `compaction-force: installed ${installed} model policies (forceAtTokens=${options.forceAtTokens}, minContextWindow=${options.minContextWindow})`)
            return
          }
          if (attempt < 2) {
            catalogCache.delete(llm)
            const timer = globalThis.setTimeout(() => {
              timers.delete(timer)
              void install(attempt + 1)
            }, attempt === 0 ? 500 : 2000)
            timers.add(timer)
            return
          }
          log('warn', `compaction-force: no model policies installed (empty catalog or no window > ${options.minContextWindow}); compaction keeps the shipped threshold`)
        } catch (error) {
          if (active) log('warn', `compaction-force: policy installation failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      void install(0)
      return () => {
        active = false
        for (const timer of timers) globalThis.clearTimeout(timer)
        timers.clear()
        try {
          disposeSummary()
        } finally {
          for (const receipt of receipts.reverse()) restorePolicies(engine, receipt)
        }
      }
    })
  })
}
