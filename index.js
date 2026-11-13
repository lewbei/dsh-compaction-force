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
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const CATALOG_TTL_MS = 5 * 60 * 1000

/** Cached provider/model catalog per llm service, with an in-flight promise. */
const catalogCache = new WeakMap()

const unwrapService = (value) => {
  let current = value
  const seen = new Set()
  while (current !== null && (typeof current === 'object' || typeof current === 'function') && !seen.has(current)) {
    seen.add(current)
    let next
    try { next = current[CORDIS_ORIGINAL] } catch { break }
    if (next === null || (typeof next !== 'object' && typeof next !== 'function') || next === current) break
    current = next
  }
  return current
}

/** Accept a positive integer, or a numeric string (e.g. YAML `"1000"`). */
const toPositiveInt = (value, fallback) => {
  let parsed = value
  if (typeof parsed === 'string' && parsed.trim() !== '') parsed = Number(parsed)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const normalizeHeading = (value) => (
  typeof value === 'string' ? value.replace(/[\r\n<>]+/g, ' ').replace(/\s+/g, ' ').trim() : ''
)

/** Normalize one row config into a complete, validated option set. */
export function normalizeOptions(config = {}) {
  const forceAtTokens = toPositiveInt(config?.forceAtTokens, DEFAULTS.forceAtTokens)
  const minContextWindow = toPositiveInt(config?.minContextWindow, DEFAULTS.minContextWindow)
  const note = NOTE_VARIANTS.has(config?.note) ? config.note : DEFAULTS.note
  const sanitizedHeading = normalizeHeading(config?.heading)
  const heading = sanitizedHeading.length > 0 ? sanitizedHeading : DEFAULTS.heading
  const scExtract = ['off', 'pattern'].includes(config?.scExtract) ? config.scExtract : DEFAULTS.scExtract
  return { forceAtTokens, minContextWindow, note, heading, scExtract }
}

const round6 = (value) => Math.round(value * 1e6) / 1e6

/** Shipped retention ratio assumed when a config row or service default omits it. */
const DEFAULT_RETAIN_RATIO = 0.16

const isObjectRecord = (value) => value !== null && typeof value === 'object'

/** Bound an emitted retention so it is strictly below the threshold and positive. */
const validRetention = (thresholdRatio, window) => {
  const halved = round6(thresholdRatio / 2)
  if (halved <= 0 || halved >= thresholdRatio) return thresholdRatio / 2
  if (Number.isInteger(window) && Math.floor(window * halved) >= Math.floor(window * thresholdRatio)) {
    return thresholdRatio / 2
  }
  return halved
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
  const safeOptions = options ?? {}
  const safeContext = context ?? {}
  const forceAtTokens = toPositiveInt(safeOptions.forceAtTokens, DEFAULTS.forceAtTokens)
  const minContextWindow = toPositiveInt(safeOptions.minContextWindow, DEFAULTS.minContextWindow)
  const previousRows = safeContext.previousRows instanceof Map
    ? safeContext.previousRows
    : new Map(Array.isArray(safeContext.previousRows)
        ? safeContext.previousRows.filter((row) => row !== null && typeof row === 'object').map((row) => [policyKey(row), row])
        : [])
  const serviceConfig = safeContext.serviceConfig ?? {}
  const serviceThreshold = typeof serviceConfig.thresholdRatio === 'number' && Number.isFinite(serviceConfig.thresholdRatio) && serviceConfig.thresholdRatio > 0
    ? serviceConfig.thresholdRatio
    : 0.8
  const seen = new Set()
  const policies = []
  for (const entry of Array.isArray(models) ? models : []) {
    const provider = entry?.provider
    const model = entry?.model
    const window = entry?.contextWindow
    if (typeof provider !== 'string' || provider.length === 0) continue
    if (typeof model !== 'string' || model.length === 0) continue
    if (!Number.isInteger(window) || window <= minContextWindow) continue
    if (window <= forceAtTokens) continue
    const key = `${provider}\u0000${model}`
    if (seen.has(key)) continue
    seen.add(key)
    const prior = previousRows.get(key)
    const existingThreshold = typeof prior?.thresholdRatio === 'number' && Number.isFinite(prior.thresholdRatio) && prior.thresholdRatio > 0
      ? prior.thresholdRatio
      : serviceThreshold
    const thresholdRatio = round6(forceAtTokens / window)
    const thresholdTokens = Math.floor(window * thresholdRatio)
    if (thresholdRatio <= 0 || thresholdRatio >= Math.min(existingThreshold, 0.8) || thresholdTokens <= 0) continue
    const policy = { provider, model, thresholdRatio }
    // @deepseek-ai/dsh-compaction-basic rejects retainRatio >= thresholdRatio,
    // forbids combining retainRatio with retainTokens, and gives per-row
    // overrides precedence over service defaults.
    const mode = prior?.retainTokens !== undefined ? 'tokens'
      : prior?.retainRatio !== undefined ? 'ratio'
        : serviceConfig.retainTokens !== undefined ? 'tokens'
          : 'ratio'
    if (mode === 'tokens') {
      const retainTokens = prior?.retainTokens ?? serviceConfig.retainTokens
      if (Number.isInteger(retainTokens) && retainTokens >= thresholdTokens) {
        policy.retainTokens = Math.max(Math.floor(thresholdTokens / 2), 0)
      }
    } else {
      const inherited = typeof prior?.retainRatio === 'number' && Number.isFinite(prior.retainRatio)
        ? prior.retainRatio
        : typeof serviceConfig.retainRatio === 'number' && Number.isFinite(serviceConfig.retainRatio)
          ? serviceConfig.retainRatio
          : DEFAULT_RETAIN_RATIO
      // Match @deepseek-ai/dsh-compaction-basic validateRatioRetention + resolveCompactSpec.
      if (!(inherited > 0) || inherited >= thresholdRatio || Math.floor(window * inherited) >= thresholdTokens) {
        policy.retainRatio = validRetention(thresholdRatio, window)
      }
    }
    policies.push(policy)
  }
  return policies
}

const iterableEntries = (value) => (
  value !== null && value !== undefined && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function'
    ? value
    : []
)

/** Read every registered provider's advertised models with their context windows. */
export async function collectCatalog(llm) {
  const entries = []
  if (typeof llm?.listProviders !== 'function') return entries
  let providers = []
  try {
    providers = await llm.listProviders()
  } catch {
    return entries
  }
  if (typeof llm?.listModels !== 'function' || typeof llm?.resolveModelInfo !== 'function') return entries
  const seenProviders = new Set()
  const seen = new Set()
  try {
    for (const providerInfo of iterableEntries(providers)) {
      const provider = typeof providerInfo === 'string' ? providerInfo : providerInfo?.id
      if (typeof provider !== 'string' || provider.length === 0) continue
      if (seenProviders.has(provider)) continue
      seenProviders.add(provider)
      let models = []
      try {
        models = await llm.listModels(provider)
      } catch {
        continue
      }
      try {
        for (const modelInfo of iterableEntries(models)) {
          const model = typeof modelInfo === 'string' ? modelInfo : modelInfo?.id
          if (typeof model !== 'string' || model.length === 0) continue
          const key = `${provider}\u0000${model}`
          if (seen.has(key)) continue
          seen.add(key)
          try {
            const info = await llm.resolveModelInfo(provider, model)
            const window = info?.context?.contextWindow
            if (Number.isInteger(window) && window > 0) entries.push({ provider, model, contextWindow: window })
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return entries
}

/** Cached catalog: one enumeration per llm service per TTL, shared by engines. */
export function catalogFor(llm) {
  if (llm === null || typeof llm !== 'object') return Promise.resolve([])
  const cacheKey = unwrapService(llm)
  const hit = catalogCache.get(cacheKey)
  const now = Date.now()
  if (hit !== undefined && hit.models !== undefined && now - hit.at < CATALOG_TTL_MS) return Promise.resolve(hit.models)
  if (hit !== undefined && hit.promise !== undefined) return hit.promise
  const promise = collectCatalog(llm)
    .catch(() => [])
    .then((models) => {
      if (catalogCache.get(cacheKey)?.promise === promise) {
        if (models.length > 0) catalogCache.set(cacheKey, { at: Date.now(), models })
        else catalogCache.delete(cacheKey)
      }
      return models
    })
  catalogCache.set(cacheKey, { at: 0, promise })
  return promise
}

async function runInstallPolicies(engine, llm, options = {}, commit) {
  if (engine === null || typeof engine !== 'object') return { installed: 0, catalogCount: 0 }
  let catalogCount = 0
  try {
    const models = await catalogFor(llm)
    catalogCount = models.length
    const previous = engine.config
    const existing = Array.isArray(previous?.modelPolicies) ? previous.modelPolicies.filter((row) => row !== null && typeof row === 'object') : []
    const policies = buildPolicies(models, options, { previousRows: existing, serviceConfig: previous })
    if (policies.length === 0) return { installed: 0, catalogCount }
    const merged = new Map(existing.map((policy) => [policyKey(policy), policy]))
    const written = []
    for (const policy of policies) {
      const key = policyKey(policy)
      const prior = merged.get(key)
      // Preserve unrelated per-model fields (headroomTokens, maxTokens,
      // summarizationProvider/Model, retention) on a same-key replacement;
      // only the generated fields override them.
      const row = prior === undefined ? policy : { ...prior, ...policy }
      merged.set(key, row)
      written.push(row)
    }
    const rows = [...merged.values()]
    const next = Object.freeze({ ...previous, modelPolicies: rows })
    if (commit === undefined) engine.config = next
    else if (!commit(previous, next, written)) return { installed: 0, catalogCount }
    return { installed: policies.length, catalogCount }
  } catch {
    return { installed: 0, catalogCount }
  }
}

/**
 * Install the per-model early-compaction policies on one compaction engine.
 * The engine object itself is not frozen; `engine.config` is a frozen value
 * but the property is writable, so a new frozen config replaces it atomically.
 */
export async function installPolicies(engine, llm, options = {}, commit) {
  return (await runInstallPolicies(engine, llm, options, commit)).installed
}

const BULLET_RE = /^(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/

function parseFenceOpen(trimmed) {
  const match = trimmed.match(/^(`{3,}|~{3,})(.*)$/)
  if (match === null) return null
  const char = match[1][0]
  if (char === '`' && match[2].includes('`')) return null
  return { char, len: match[1].length }
}

function isFenceClose(trimmed, fence) {
  if (fence === null) return false
  const match = trimmed.match(/^(`{3,}|~{3,})\s*$/)
  return match !== null && match[1][0] === fence.char && match[1].length >= fence.len
}

function scanBlockLines(text) {
  const rawLines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const entries = []
  let fence = null
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim()
    if (fence !== null) {
      const closed = isFenceClose(trimmed, fence)
      entries.push({ rawLine, trimmed, inFence: true })
      if (closed) fence = null
      continue
    }
    const opened = parseFenceOpen(trimmed)
    if (opened !== null) {
      fence = opened
      entries.push({ rawLine, trimmed, inFence: true })
      continue
    }
    entries.push({ rawLine, trimmed, inFence: false })
  }
  return entries
}

function truncateBalanced(text, maxChars, suffix = '…') {
  if (text.length <= maxChars) return text
  if (maxChars <= 0) return ''
  if (maxChars <= suffix.length) return suffix.slice(0, maxChars)
  let cut = text.slice(0, maxChars - suffix.length)
  let openRunLen = 0
  let openAt = -1
  let idx = 0
  while (idx < cut.length) {
    if (cut[idx] === '`') {
      let end = idx
      while (end < cut.length && cut[end] === '`') end += 1
      const runLen = end - idx
      if (openRunLen === 0) {
        openRunLen = runLen
        openAt = idx
      } else if (runLen === openRunLen) {
        openRunLen = 0
        openAt = -1
      }
      idx = end
    } else {
      idx += 1
    }
  }
  if (openRunLen > 0) {
    if (openAt + openRunLen >= cut.length) {
      cut = cut.slice(0, openAt).trimEnd()
    } else {
      const room = maxChars - suffix.length - openRunLen
      const body = room > openAt + openRunLen ? cut.slice(0, room).replace(/`+$/, '') : ''
      if (body.length > openAt + openRunLen) cut = `${body}${'`'.repeat(openRunLen)}`
      else cut = cut.slice(0, openAt).trimEnd()
    }
  }
  return `${cut}${suffix}`
}

/** Extract up to maxBullets bullet items under one `## Heading` section. */
export function sectionBullets(summaryText, heading, maxBullets = 2, maxChars = 400) {
  if (!Number.isFinite(maxBullets) || maxBullets <= 0) return []
  if (!Number.isFinite(maxChars) || maxChars <= 0) return []
  const target = normalizeHeading(heading).toLowerCase()
  if (target.length === 0) return []
  const lines = scanBlockLines(summaryText)
  let inSection = false
  const collected = []
  let activeBullet = false
  for (const { rawLine, trimmed, inFence } of lines) {
    if (inFence) {
      activeBullet = false
      continue
    }
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch !== null) {
      const level = headingMatch[1].length
      const title = normalizeHeading(headingMatch[2]).toLowerCase()
      if (!inSection) {
        if (level === 2 && title === target) inSection = true
        continue
      }
      if (level <= 2) break
      activeBullet = false
      continue
    }
    if (!inSection) continue
    if (trimmed.length === 0 || /^(?:(?:-(?:\s*-){2,}|\*(?:\s*\*){2,}|_(?:\s*_){2,})$|>)/.test(trimmed)) {
      activeBullet = false
      continue
    }
    const match = trimmed.match(BULLET_RE)
    if (match !== null) {
      const item = match[1].trim()
      if (item.length > 0) {
        collected.push(item)
        activeBullet = true
      } else {
        activeBullet = false
      }
      continue
    }
    if (activeBullet && collected.length > 0 && (rawLine !== rawLine.trimStart() || !/[.!?]$/.test(collected[collected.length - 1]))) {
      collected[collected.length - 1] = `${collected[collected.length - 1]} ${trimmed}`
    } else {
      activeBullet = false
    }
  }
  return collected
    .filter((item) => !/^\(?none\)?\.?$/i.test(item))
    .slice(0, maxBullets)
    .map((item) => truncateBalanced(item, maxChars))
}

/** Heading of the plugin's own Active Constraints section (generated, not user). */
const SC_SECTION_HEADING = 'Active Constraints (preserve these)'
/** Heading of the plugin's own context note section (generated, not user). */
const SC_CONTEXT_NOTE_HEADING = 'Note to Self (context)'
/** The plugin's generated footer must never be counted as a user constraint. */
const SC_FOOTER = 'these are user-issued side constraints for this session; they must survive every compaction.'
/** The plugin's generated authority line must never be counted as a constraint. */
const SC_AUTHORITY_LINE = 'this checkpoint is the authoritative record of that span; do not restate it.'

const COMPACT_OPEN_TAG = '<compacted-summary>'
const COMPACT_CLOSE_TAG = '</compacted-summary>'

function frameSummarySpans(texts) {
  const entries = []
  for (let blockIdx = 0; blockIdx < texts.length; blockIdx += 1) {
    for (const line of scanBlockLines(texts[blockIdx])) {
      entries.push({ blockIdx, ...line })
    }
  }
  const openStack = []
  const delimiters = new Set()
  const spans = []
  for (let idx = 0; idx < entries.length; idx += 1) {
    const entry = entries[idx]
    if (entry.inFence) continue
    const lower = entry.trimmed.toLowerCase()
    if (lower === COMPACT_OPEN_TAG) {
      openStack.push(idx)
    } else if (lower === COMPACT_CLOSE_TAG && openStack.length > 0) {
      const start = openStack.pop()
      delimiters.add(start)
      delimiters.add(idx)
      spans.push([start, idx])
    }
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const spanIds = new Array(entries.length).fill(0)
  let maxEnd = -1
  let spanIdx = 0
  let nextSpanId = 0
  for (let idx = 0; idx < entries.length; idx += 1) {
    while (spanIdx < spans.length && spans[spanIdx][0] <= idx) {
      if (spans[spanIdx][1] > maxEnd) {
        if (idx >= maxEnd) nextSpanId += 1
        maxEnd = spans[spanIdx][1]
      }
      spanIdx += 1
    }
    if (idx < maxEnd && !delimiters.has(idx)) spanIds[idx] = nextSpanId
  }
  const segments = []
  let activeBlock = -1
  let activeSpanId = 0
  let lines = []
  const flush = () => {
    if (lines.length === 0) return
    segments.push({ text: lines.join('\n'), inSummary: activeSpanId > 0, spanId: activeSpanId })
    lines = []
  }
  for (let idx = 0; idx < entries.length; idx += 1) {
    if (delimiters.has(idx)) {
      flush()
      activeBlock = -1
      continue
    }
    const { blockIdx, rawLine } = entries[idx]
    const spanId = spanIds[idx]
    if (blockIdx !== activeBlock || spanId !== activeSpanId) {
      flush()
      activeBlock = blockIdx
      activeSpanId = spanId
    }
    lines.push(rawLine)
  }
  flush()
  return segments
}

const AT_PAREN_FRAME_RE = /^at\s+.+?\s*\((?:Native Method|Unknown Source|.*(?:[\/\\]|node:|file:\/\/|https?:\/\/|\.[A-Za-z0-9_]+|<anonymous>)\S*:\d+(?::\d+)?)\)$/
const AT_BARE_FRAME_RE = /^at\s+(?:(?:node:|file:\/\/|[A-Za-z]:\\|\.\.?\/|\/)\S*:\d+(?::\d+)?|https?:\/\/\S+:\d+:\d+|\S+\.[A-Za-z0-9_]+:\d+:\d+|<anonymous>(?::\d+(?::\d+)?)?|\[[^\]]+\](?::\d+(?::\d+)?)?)$/
const AT_SIGN_FRAME_RE = /^(?:[A-Za-z0-9_$.<>-]+(?:\s+[A-Za-z0-9_$.<>-]+){0,2})?@(?:https?:\/\/\S+:\d+:\d+|(?:file:\/\/\S+|\S+[\/\\]\S+|node:\S+|\S+\.[A-Za-z0-9_]+):\d+(?::\d+)?|\[native code\])$/
const PYTHON_FRAME_RE = /^File\s+"[^"]+",\s+line\s+\d+(?:,\s+in\s+\S+)?$/
const ERROR_HEADER_RE = /^(?:(?:Uncaught(?:\s+\([^)]+\)|\s+\S+)*\s+)?[A-Za-z0-9_.$]*(?:Error|Exception|Panic|Throwable)|Traceback(?:\s*\(most recent call last\))?|Caused by)\s*:/i

function isStackFrameLine(trimmed) {
  return AT_PAREN_FRAME_RE.test(trimmed)
    || AT_BARE_FRAME_RE.test(trimmed)
    || AT_SIGN_FRAME_RE.test(trimmed)
    || PYTHON_FRAME_RE.test(trimmed)
}

function markTraceLines(entries) {
  const dropped = new Array(entries.length).fill(false)
  for (let i = 0; i < entries.length; i += 1) {
    if (!entries[i].inFence && isStackFrameLine(entries[i].trimmed)) dropped[i] = true
  }
  for (let i = 0; i < entries.length; i += 1) {
    if (!dropped[i] || !/^File\s+"/.test(entries[i].trimmed)) continue
    let j = i + 1
    while (
      j < entries.length
      && j <= i + 2
      && !entries[j].inFence
      && entries[j].trimmed.length > 0
      && entries[j].rawLine !== entries[j].rawLine.trimStart()
      && !isStackFrameLine(entries[j].trimmed)
    ) {
      j += 1
    }
    if (j > i + 1 && j < entries.length && !entries[j].inFence && (dropped[j] || ERROR_HEADER_RE.test(entries[j].trimmed))) {
      for (let k = i + 1; k < j; k += 1) dropped[k] = true
    }
  }
  for (let i = 1; i < entries.length; i += 1) {
    if (dropped[i - 1] && !entries[i].inFence && ERROR_HEADER_RE.test(entries[i].trimmed)) dropped[i] = true
  }
  for (let i = entries.length - 2; i >= 0; i -= 1) {
    if (dropped[i + 1] && !entries[i].inFence && ERROR_HEADER_RE.test(entries[i].trimmed)) dropped[i] = true
  }
  return dropped
}

const UNCONDITIONAL_ABBR_RE = /^(?:vs|cf|dr|mr|mrs|ms|prof|sr|jr|fig|st)$/i
const CONTEXT_ABBR_RE = /^(?:etc|al|inc|ltd|corp|co|no|eq|sec|vol|ch|app|ref)$/i
const DOTTED_INITIALISM_RE = /^(?:[A-Za-z]\.)+[A-Za-z]$/
const ELLIPSIS_PUNCT_RE = /^\.{2,}$/
const CONTINUATION_AFTER_RE = /^[a-z0-9`(\[,;:]/
const LINE_CONTINUATION_START_RE = /^(?:[a-z(\[`"'~\/]|\.\.?\/|\d+(?:\.\d+)?(?!\d|\.\d)(?![.)](?:\s|$)))/
const TRAILING_CONNECTOR_RE = /\b(?:and|or|nor|but|yet|so|to|for|of|in|on|at|by|with|without|from|into|onto|upon|about|against|between|through|during|before|after|until|unless|while|when|where|if|whether|that|which|who|whom|whose|than|as|via|per|under|over|above|below|within|outside|inside|near|around|across|among|beyond|the|a|an|this|these|those|my|your|our|their|his|her|its|not|never|must|should|can|cannot|could|will|would|may|might|shall|do|does|did|be|is|are|was|were|been|being|have|has|had|having|skip|edit|run|check|touch|use|keep|read|write|open|close|push|pull|merge|deploy|send|share|delete|remove|drop|modify|change|call|pass|verify|test|commit|show|ask|wait|ensure|avoid|prevent|require|follow|inspect|include|exclude|allow|block|print|log|save|store|load|fetch|update|create|build|start|stop|leave|set|get|overwrite|expose|leak|grant|revoke|bypass|ignore|disable|enable|install|uninstall|publish|release|apply|revert|reset|restart|kill|terminate)$/i

function isNonTerminalDot(before, after, hasAfter) {
  const token = before.match(/([A-Za-z0-9_.@-]+)$/)?.[1] ?? ''
  if (token.length === 0) return false
  if (DOTTED_INITIALISM_RE.test(token)) {
    return !hasAfter || /^(?:e\.g|i\.e)$/i.test(token) || CONTINUATION_AFTER_RE.test(after)
  }
  if (UNCONDITIONAL_ABBR_RE.test(token)) return true
  if (CONTEXT_ABBR_RE.test(token)) return !hasAfter || CONTINUATION_AFTER_RE.test(after)
  return false
}

function endsWithSentencePunctuation(text) {
  const trimmed = text.trimEnd()
  const match = trimmed.match(/([.!?]+)(["'”’)\]]*)$/)
  if (match === null) return false
  const [, punct, closer] = match
  if (punct.length >= 2 && ELLIPSIS_PUNCT_RE.test(punct)) return false
  if (punct === '.' && closer === '') {
    const before = trimmed.slice(0, trimmed.length - match[0].length)
    if (isNonTerminalDot(before, '', false)) return false
  }
  return true
}

function splitSentences(text) {
  const out = []
  let start = 0
  const re = /([.!?]+)(["'”’)\]]*)(\s+)/g
  let match
  while ((match = re.exec(text)) !== null) {
    const [, punct, closer, ws] = match
    const end = match.index + punct.length + closer.length
    const after = text.slice(end + ws.length)
    if (punct.length >= 2 && ELLIPSIS_PUNCT_RE.test(punct) && CONTINUATION_AFTER_RE.test(after)) continue
    if (punct === '.' && closer === '') {
      const before = text.slice(0, match.index)
      if (isNonTerminalDot(before, after, true)) continue
    }
    const piece = text.slice(start, end).trim()
    if (piece.length > 0) out.push(piece)
    start = end + ws.length
  }
  const rest = text.slice(start).trim()
  if (rest.length > 0) out.push(rest)
  return out
}

function isContinuation(pending, line) {
  if (endsWithSentencePunctuation(pending)) return false
  if (/^\d+(?:\.\d+)*[.)](?:\s|$)/.test(line)) return false
  if (LINE_CONTINUATION_START_RE.test(line)) return true
  const trimmed = pending.trimEnd()
  if (/[,:;(\-—–]$/.test(trimmed)) return true
  const abbrBeforeDot = trimmed.match(/^(.*)\.$/)
  if (abbrBeforeDot !== null && isNonTerminalDot(abbrBeforeDot[1], line, true)) return true
  return TRAILING_CONNECTOR_RE.test(trimmed)
}

function flushPendingCandidates(candidates, state) {
  if (state.pending === null) return
  for (const sentence of splitSentences(state.pending)) {
    if (sentence.length > 0) candidates.push({ text: sentence, prior: state.section === 'prior' })
  }
  state.pending = null
}

function emitCompletedPending(candidates, state) {
  if (state.pending === null) return
  const sentences = splitSentences(state.pending)
  if (sentences.length === 0) {
    state.pending = null
    return
  }
  for (let i = 0; i < sentences.length - 1; i += 1) {
    candidates.push({ text: sentences[i], prior: state.section === 'prior' })
  }
  const tail = sentences[sentences.length - 1]
  if (endsWithSentencePunctuation(tail)) {
    candidates.push({ text: tail, prior: state.section === 'prior' })
    state.pending = null
  } else {
    state.pending = tail
  }
}

const PLUGIN_HANDOFF_BULLET_RE = /^(?:Where I was|Next|Guardrails):\s|^Resume from the checkpoint above/i

function flushLastBulletCandidates(candidates, state) {
  if (state.lastBullet === null) return
  for (const sentence of splitSentences(state.lastBullet.text)) {
    if (sentence.length > 0) candidates.push({ text: sentence, prior: state.lastBullet.prior })
  }
  state.lastBullet = null
}

function isPluginHandoffSection(entries, startIdx) {
  let bullets = 0
  for (let j = startIdx + 1; j < entries.length; j += 1) {
    const { rawLine, trimmed, inFence } = entries[j]
    if (inFence) continue
    if (trimmed.length === 0) break
    if (/^#{1,6}\s+/.test(trimmed)) break
    const bullet = trimmed.match(BULLET_RE)
    if (bullet !== null) {
      bullets += 1
      if (!PLUGIN_HANDOFF_BULLET_RE.test(bullet[1].trim())) return false
      continue
    }
    if (rawLine === rawLine.trimStart()) return false
  }
  return bullets > 0
}

function resolvePriorHeadingIdx(spanSegments, customHeading = DEFAULTS.heading.toLowerCase()) {
  const builtInSynthetic = new Set([
    SC_CONTEXT_NOTE_HEADING.toLowerCase(),
    DEFAULTS.heading.toLowerCase(),
  ])
  const records = []
  let current = null
  for (const seg of spanSegments) {
    const entries = scanBlockLines(seg.text)
    const dropped = markTraceLines(entries)
    for (let idx = 0; idx < entries.length; idx += 1) {
      const { trimmed, inFence } = entries[idx]
      if (inFence || dropped[idx]) continue
      const heading = trimmed.match(/^#{1,6}\s+(.*)$/)
      if (heading !== null) {
        const name = normalizeHeading(heading[1]).toLowerCase()
        current = {
          ordinal: records.length,
          isPriorCandidate: name === SC_SECTION_HEADING.toLowerCase(),
          isSynthetic: builtInSynthetic.has(name) || (name === customHeading && isPluginHandoffSection(entries, idx)),
          hasFooter: false,
        }
        records.push(current)
        continue
      }
      if (current !== null && trimmed.toLowerCase().includes(SC_FOOTER)) {
        current.hasFooter = true
      }
    }
  }
  const priorRecords = records.filter((rec) => rec.isPriorCandidate)
  if (priorRecords.length === 0) return -1
  const withFooter = priorRecords.filter((rec) => rec.hasFooter)
  if (withFooter.length > 0) return withFooter.at(-1).ordinal
  if (priorRecords.length === records.length) return priorRecords.at(-1).ordinal
  const trailing = priorRecords.filter((rec) => (
    !records.slice(rec.ordinal + 1).some((later) => !later.isSynthetic && !later.isPriorCandidate)
  ))
  return trailing.length > 0 ? trailing.at(-1).ordinal : -1
}

/**
 * Split one text block into extraction candidates.
 *
 * The plugin's own previously-generated checkpoint sections are handled so
 * their headings and footer are never re-counted as user constraints (that
 * previously consumed the cap and dropped genuine new instructions). The
 * `## Active Constraints (preserve these)` section is special: its bullets are
 * GENUINE prior constraints that must be carried forward into the next
 * checkpoint — otherwise a lossy summarizer erases them on the next compaction.
 * Context/handoff note sections remain fully skipped.
 *
 * Lines and paragraphs are split before bounded sentence extraction so a
 * multiline, unpunctuated constraint list is not discarded as one over-long
 * candidate.
 *
 * @returns {Array<{ text: string, prior: boolean }>}
 */
function splitSCCandidates(
  text,
  state = {
    inSummary: false,
    section: 'none',
    pending: null,
    lastBullet: null,
    inSyntheticBullet: false,
    authorizedPriorHeadingIdx: -1,
    headingOrdinal: -1,
  },
  customHeading = DEFAULTS.heading.toLowerCase(),
) {
  if (!('pending' in state)) state.pending = null
  if (!('lastBullet' in state)) state.lastBullet = null
  if (!('inSyntheticBullet' in state)) state.inSyntheticBullet = false
  const builtInSynthetic = new Set([
    SC_CONTEXT_NOTE_HEADING.toLowerCase(),
    DEFAULTS.heading.toLowerCase(),
  ])
  const entries = scanBlockLines(text)
  const dropped = markTraceLines(entries)
  const candidates = []
  for (let idx = 0; idx < entries.length; idx += 1) {
    const { rawLine, trimmed: line, inFence } = entries[idx]
    if (inFence || dropped[idx]) {
      flushPendingCandidates(candidates, state)
      flushLastBulletCandidates(candidates, state)
      state.inSyntheticBullet = false
      continue
    }
    if (line.length === 0) {
      flushPendingCandidates(candidates, state)
      flushLastBulletCandidates(candidates, state)
      state.inSyntheticBullet = false
      if (!state.inSummary) state.section = 'none'
      continue
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    if (heading !== null) {
      flushPendingCandidates(candidates, state)
      flushLastBulletCandidates(candidates, state)
      state.inSyntheticBullet = false
      const name = normalizeHeading(heading[1]).toLowerCase()
      if (state.inSummary) {
        state.headingOrdinal += 1
        if (name === SC_SECTION_HEADING.toLowerCase() && state.headingOrdinal === state.authorizedPriorHeadingIdx) {
          state.section = 'prior'
        } else {
          state.section = 'synthetic'
        }
      } else if (name === SC_SECTION_HEADING.toLowerCase()) {
        state.section = 'prior'
      } else if (builtInSynthetic.has(name) || (name === customHeading && isPluginHandoffSection(entries, idx))) {
        state.section = 'synthetic'
      } else {
        state.section = 'none'
      }
      continue
    }
    if (state.section === 'synthetic') {
      if (BULLET_RE.test(line)) {
        state.inSyntheticBullet = true
        continue
      }
      if (state.inSummary || (state.inSyntheticBullet && rawLine !== rawLine.trimStart())) continue
      state.section = 'none'
      state.inSyntheticBullet = false
    }
    const bullet = line.match(BULLET_RE)
    if (bullet !== null) {
      flushPendingCandidates(candidates, state)
      flushLastBulletCandidates(candidates, state)
      state.lastBullet = { text: bullet[1].trim(), prior: state.section === 'prior' }
      continue
    }
    if (state.lastBullet !== null && (rawLine !== rawLine.trimStart() || isContinuation(state.lastBullet.text, line))) {
      state.lastBullet.text = `${state.lastBullet.text} ${line}`
      continue
    }
    flushLastBulletCandidates(candidates, state)
    if (state.pending === null) {
      state.pending = line
      emitCompletedPending(candidates, state)
      continue
    }
    if (isContinuation(state.pending, line)) {
      state.pending = `${state.pending} ${line}`
      emitCompletedPending(candidates, state)
    } else {
      flushPendingCandidates(candidates, state)
      state.pending = line
      emitCompletedPending(candidates, state)
    }
  }
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
  const constraintRe = /\b(don['’]?t|do not|never|always|cannot|can['’]?t|must(?:\s+not)?|mustn['’]?t|should(?:\s+not)?|shouldn['’]?t|before (?:you|any)|wait for (?:my|your)|confirm (?:with|before)|ask (?:me|before)|show me (?:the|what)|until i (?:say|tell|confirm)|unless i|only (?:when|if|after)|no (?:emails?|messages?|files?|changes?|deletions?|emails|sending)|avoid|prevent|ensure (?:that|you)|require(?:d)? (?:that|to)|from now on|for the rest of (?:this )?session)\b/i
  const sanitizedHeading = normalizeHeading(options?.heading)
  const customHeading = (sanitizedHeading.length > 0 ? sanitizedHeading : DEFAULTS.heading).toLowerCase()
  const seen = new Set()
  const out = []
  const stage = (candidate) => {
    if (out.length >= 8) return
    if (candidate.length < 8) return
    if (/\?["'”’)\]\s]*$/.test(candidate)) return
    const lower = candidate.toLowerCase()
    if (lower === SC_FOOTER || lower.includes(SC_FOOTER)) return
    if (lower === SC_AUTHORITY_LINE || lower.includes(SC_AUTHORITY_LINE)) return
    // Match against the full text; store a truncated copy for over-long
    // single-line candidates instead of dropping them.
    if (!constraintRe.test(candidate)) return
    const item = truncateBalanced(candidate, 240, '...')
    // Dedup ignoring trailing punctuation ("Never deploy." ≡ "never deploy!").
    const key = item.toLowerCase().replace(/[!?.,;:]+$/g, '')
    if (seen.has(key)) return
    seen.add(key)
    out.push(item)
  }
  // Scan newest messages first so the 8-slot cap keeps the freshest constraints
  // (the ones most likely to still bind), instead of silently dropping them.
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (out.length >= 8) break
    const msg = list[index]
    if (msg === null || typeof msg !== 'object') continue
    if (msg.role !== 'user') continue
    const content = Array.isArray(msg.content) ? msg.content : (typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [])
    const texts = content
      .filter((block) => block !== null && typeof block === 'object' && typeof block.text === 'string')
      .map((block) => block.text)
    const segments = frameSummarySpans(texts)
    const state = {
      inSummary: false,
      section: 'none',
      pending: null,
      lastBullet: null,
      inSyntheticBullet: false,
      authorizedPriorHeadingIdx: -1,
      headingOrdinal: -1,
    }
    const msgFresh = []
    const msgPrior = []
    const stageCandidate = ({ text, prior: fromPrior }) => {
      const normalized = text.replace(/\s+/g, ' ').trim()
      if (normalized.length > 0) (fromPrior ? msgPrior : msgFresh).push(normalized)
    }
    const flushStateBuffers = () => {
      const tail = []
      flushPendingCandidates(tail, state)
      flushLastBulletCandidates(tail, state)
      for (const item of tail) stageCandidate(item)
    }
    let activeSpanId = 0
    for (const seg of segments) {
      if (seg.spanId !== activeSpanId) {
        flushStateBuffers()
        activeSpanId = seg.spanId
        state.inSummary = seg.inSummary
        state.section = seg.inSummary ? 'synthetic' : 'none'
        state.inSyntheticBullet = false
        state.headingOrdinal = -1
        state.authorizedPriorHeadingIdx = seg.inSummary
          ? resolvePriorHeadingIdx(segments.filter((other) => other.spanId === seg.spanId), customHeading)
          : -1
      }
      for (const candidate of splitSCCandidates(seg.text, state, customHeading)) {
        stageCandidate(candidate)
      }
    }
    flushStateBuffers()
    for (const candidate of msgFresh) stage(candidate)
    for (const candidate of msgPrior) stage(candidate)
  }
  return out
}

const ACTIVE_NOTE_VARIANTS = new Set(['context', 'handoff', 'both'])

function renderActiveConstraints(sideConstraints, compact = false) {
  if (!Array.isArray(sideConstraints) || sideConstraints.length === 0) return ''
  const cleaned = []
  for (const sc of sideConstraints) {
    if (typeof sc !== 'string') continue
    const normalized = sc.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (normalized.length > 0) cleaned.push(`- ${normalized}`)
  }
  if (cleaned.length === 0) return ''
  const lines = ['## Active Constraints (preserve these)', ...cleaned]
  if (!compact) lines.push('- These are user-issued side constraints for this session; they MUST survive every compaction.')
  return lines.join('\n')
}

/** Build the note text appended to a checkpoint (empty string when nothing to add). */
export function buildNoteText(options = {}) {
  const safeOptions = options ?? {}
  const {
    variant,
    heading = DEFAULTS.heading,
    summaryText = '',
    totalTokens = null,
    timestamp = null,
    sideConstraints = [],
    compact = false,
  } = safeOptions
  if (!ACTIVE_NOTE_VARIANTS.has(variant)) return ''
  const normalizedHeading = normalizeHeading(heading)
  const resolvedHeading = normalizedHeading.length > 0 ? normalizedHeading : DEFAULTS.heading
  const parts = []
  if (variant === 'context' || variant === 'both') {
    const size = Number.isInteger(totalTokens) && totalTokens > 0
      ? (totalTokens >= 1000 ? `~${Math.round(totalTokens / 1000)}K tokens` : `~${totalTokens} tokens`)
      : 'the context limit'
    const when = typeof timestamp === 'string' && timestamp.length > 0 ? ` on ${timestamp}` : ''
    parts.push(compact
      ? [
          '## Note to Self (context)',
          `- Compacted at ${size}${when}; authoritative checkpoint above, re-read files before editing.`,
        ].join('\n')
      : [
          '## Note to Self (context)',
          `- The earlier conversation was compacted at ${size}${when}.`,
          '- This checkpoint is the authoritative record of that span; do not restate it.',
          '- Re-read a file before editing it if you are relying on a pre-compaction memory.',
        ].join('\n'))
  }
  const scBlock = renderActiveConstraints(sideConstraints, compact)
  if (scBlock.length > 0) parts.push(scBlock)
  if (variant === 'handoff' || variant === 'both') {
    const maxChars = compact ? 100 : 300
    const where = sectionBullets(summaryText, 'Current Work', compact ? 2 : 3, maxChars)
    const next = sectionBullets(summaryText, 'Next Step', 1, maxChars)
    const guard = sectionBullets(summaryText, 'Critical Context', compact ? 2 : 3, maxChars)
    const lines = [`## ${resolvedHeading}`]
    if (where.length > 0) lines.push(`- Where I was: ${where.join(' ')}`)
    if (next.length > 0) lines.push(`- Next: ${next.join(' ')}`)
    if (guard.length > 0) lines.push(`- Guardrails: ${guard.join(' ')}`)
    if (lines.length === 1 && !compact) lines.push('- Resume from the checkpoint above; its "Current Work" and "Next Step" sections are authoritative.')
    if (lines.length > 1) parts.push(lines.join('\n'))
  }
  return parts.length === 0 ? '' : `\n\n${parts.join('\n\n')}\n`
}

function readMeter(ctx) {
  return typeof ctx?.get === 'function' ? ctx.get('tokenMeter') : ctx?.tokenMeter
}

function resolveMeter(ctx, engine) {
  return readMeter(ctx) ?? readMeter(unwrapService(engine)?.ctx)
}

function measureTokensFromMeter(meter, agent) {
  try {
    if (meter === null || meter === undefined || typeof meter.measure !== 'function') return null
    const header = typeof agent?.session?.requestHeader === 'function' ? agent.session.requestHeader() : undefined
    const measurement = header !== undefined ? meter.measure(agent?.session, header) : meter.measure(agent?.session)
    const total = measurement?.totalTokens
    return Number.isInteger(total) && total > 0 ? total : null
  } catch {
    return null
  }
}

const FRAME_OPEN_TEXT = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>'
const FRAME_CLOSE_TEXT = '</compacted-summary>'

function computeShadowedBudget(input, agent, meter) {
  if (typeof meter?.estimateMessage !== 'function') return Infinity
  const messages = input?.messages
  if (!Array.isArray(messages) || messages.length === 0) return Infinity
  const session = agent?.session
  const nodes = session?.surface?.nodes
  if (
    Array.isArray(nodes)
    && typeof session?.eventAt === 'function'
    && typeof session?.deriveEventMessage === 'function'
    && typeof meter?.measure === 'function'
  ) {
    try {
      const measurement = meter.measure(session)
      if (Array.isArray(measurement?.nodes) && measurement.nodes.length === nodes.length) {
        const head = nodes.length > 0 ? session.eventAt(nodes[0]) : undefined
        const firstIdx = head?.type === 'system/message' ? 1 : 0
        const hasSys = firstIdx === 1 && session.deriveEventMessage(head) !== null
        const regionMsgs = hasSys ? messages.slice(1) : messages
        if (regionMsgs.length > 0) {
          let sum = 0
          let matched = 0
          for (let i = firstIdx; i < measurement.nodes.length; i += 1) {
            const node = measurement.nodes[i]
            if (typeof node?.tokens !== 'number' || !Number.isFinite(node.tokens) || node.tokens < 0 || (node?.seq !== undefined && node.seq !== nodes[i])) break
            sum += node.tokens
            if (session.deriveEventMessage(session.eventAt(nodes[i])) !== null) {
              matched += 1
              if (matched === regionMsgs.length) return sum > 0 ? sum : Infinity
            }
          }
        }
      }
    } catch {}
  }
  try {
    const body = messages.length > 1 && messages[0]?.role === 'system' ? messages.slice(1) : messages
    let sum = 0
    for (const msg of body) {
      const tokens = meter.estimateMessage(msg)
      if (!Number.isFinite(tokens) || tokens < 0) return Infinity
      sum += tokens
    }
    return sum > 0 ? sum : Infinity
  } catch {
    return Infinity
  }
}

function fitNoteToBudget(noteArgs, baseSummary, budget, meter) {
  if (!Number.isFinite(budget) || typeof meter?.estimateMessage !== 'function') {
    return buildNoteText(noteArgs)
  }
  const fits = (extraText) => {
    const content = extraText.length > 0
      ? [...baseSummary, { type: 'text', text: extraText }]
      : baseSummary
    const tokens = meter.estimateMessage({
      role: 'user',
      content: [
        { type: 'text', text: FRAME_OPEN_TEXT },
        ...content,
        { type: 'text', text: FRAME_CLOSE_TEXT },
      ],
    })
    return Number.isFinite(tokens) && tokens < budget
  }
  try {
    if (!fits('')) return ''
    const full = buildNoteText({ ...noteArgs, compact: false })
    if (full.length === 0 || fits(full)) return full
    const compactBoth = buildNoteText({ ...noteArgs, compact: true })
    if (compactBoth.length > 0 && fits(compactBoth)) return compactBoth
    if (noteArgs.variant === 'both') {
      for (const variant of ['handoff', 'context']) {
        const candidate = buildNoteText({ ...noteArgs, variant, compact: true })
        if (candidate.length > 0 && fits(candidate)) return candidate
      }
    }
    const constraints = Array.isArray(noteArgs.sideConstraints) ? noteArgs.sideConstraints : []
    for (let count = constraints.length; count >= 1; count -= 1) {
      const scBlock = renderActiveConstraints(constraints.slice(0, count), true)
      const candidate = scBlock.length > 0 ? `\n\n${scBlock}\n` : ''
      if (candidate.length > 0 && fits(candidate)) return candidate
    }
    if (noteArgs.variant !== 'off') {
      const variants = noteArgs.variant === 'both' ? ['handoff', 'context'] : [noteArgs.variant]
      for (const variant of variants) {
        const candidate = buildNoteText({ ...noteArgs, variant, sideConstraints: [], compact: true })
        if (candidate.length > 0 && fits(candidate)) return candidate
      }
    }
    return ''
  } catch {
    return buildNoteText(noteArgs)
  }
}

const wrapperRegistry = new WeakMap()

function mountSummary(engine, ctx, options = {}) {
  const target = unwrapService(engine)
  if (!isObjectRecord(target) || typeof target.summarize !== 'function') return null
  const resolved = normalizeOptions(options)
  const layer = { ctx, options: resolved }
  const makeDispose = (entry) => {
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const idx = entry.layers.indexOf(layer)
      if (idx !== -1) entry.layers.splice(idx, 1)
      if (entry.layers.length === 0) entry.restore()
    }
  }
  const existing = wrapperRegistry.get(target)
  if (existing !== undefined) {
    existing.layers.push(layer)
    return makeDispose(existing)
  }
  const original = target.summarize
  const descriptor = Object.getOwnPropertyDescriptor(target, 'summarize')
  const layers = [layer]
  const wrapper = async function (input, agent, signal) {
    const result = await original.call(this, input, agent, signal)
    if (signal?.aborted === true) return result
    const top = layers.at(-1)
    if (!top || top.options.note === 'off' || !isObjectRecord(result) || !Array.isArray(result.summary)) return result
    const summaryText = result.summary
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    const sideConstraints = top.options.scExtract === 'pattern'
      ? extractSideConstraints(Array.isArray(input?.messages) ? input.messages : [], { heading: top.options.heading })
      : []
    const meter = resolveMeter(top.ctx, target)
    const budget = computeShadowedBudget(input, agent, meter)
    const text = fitNoteToBudget({
      variant: top.options.note,
      heading: top.options.heading,
      summaryText,
      totalTokens: measureTokensFromMeter(meter, agent),
      timestamp: new Date().toISOString(),
      sideConstraints,
    }, result.summary, budget, meter)
    if (text.length === 0) return result
    return { ...result, summary: [...result.summary, { type: 'text', text }] }
  }
  const restore = () => {
    if (wrapperRegistry.get(target) === entry) wrapperRegistry.delete(target)
    if (Object.getOwnPropertyDescriptor(target, 'summarize')?.value !== wrapper) return
    if (descriptor) {
      if (descriptor.configurable) Object.defineProperty(target, 'summarize', descriptor)
      else target.summarize = descriptor.value
    } else {
      delete target.summarize
    }
  }
  const entry = { layers, restore }
  try {
    target.summarize = wrapper
    wrapperRegistry.set(target, entry)
    return makeDispose(entry)
  } catch {
    restore()
    return null
  }
}

export function wrapSummarize(engine, ctx, options = {}) {
  const target = unwrapService(engine)
  if (!isObjectRecord(target) || wrapperRegistry.has(target)) return false
  return mountSummary(engine, ctx, options) !== null
}

const policyKey = policy => `${policy.provider}\u0000${policy.model}`

const activeReceipts = new WeakMap()

const getActiveReceipts = (engine) => {
  const key = unwrapService(engine)
  let list = activeReceipts.get(key)
  if (list === undefined) {
    list = []
    activeReceipts.set(key, list)
  }
  return list
}

function restorePolicies(engine, receipt) {
  const list = activeReceipts.get(unwrapService(engine))
  let laterReceipts = []
  if (list !== undefined) {
    const idx = list.indexOf(receipt)
    if (idx !== -1) {
      laterReceipts = list.slice(idx + 1)
      list.splice(idx, 1)
    }
  }
  const handedOff = new Set()
  let handoffTargets = null
  for (const [key, owned] of receipt.rows) {
    if (!isDeepStrictEqual(owned.installed, owned.snapshot)) continue
    for (const later of laterReceipts) {
      const laterOwned = later.rows.get(key)
      if (laterOwned !== undefined && laterOwned.previous === owned.installed) {
        laterOwned.previous = owned.previous
        handedOff.add(key)
        if (handoffTargets === null) handoffTargets = new Set()
        handoffTargets.add(later)
        break
      }
    }
  }
  if (handoffTargets !== null && handoffTargets.size === 1 && handedOff.size === receipt.rows.size) {
    const [successor] = handoffTargets
    if (successor.previous === receipt.next) successor.previous = receipt.previous
  }

  const current = engine.config
  if (!Array.isArray(current?.modelPolicies)) return
  let changed = false
  const restored = current.modelPolicies.flatMap(policy => {
    if (!isObjectRecord(policy)) return [policy]
    const key = policyKey(policy)
    const owned = receipt.rows.get(key)
    if (!owned || handedOff.has(key) || policy !== owned.installed || !isDeepStrictEqual(policy, owned.snapshot)) return [policy]
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
    } catch {}
  }
  if (config?.note !== undefined && !NOTE_VARIANTS.has(config.note)) {
    let noteText
    try { noteText = JSON.stringify(config.note) } catch { noteText = String(config.note) }
    log('warn', `compaction-force: unknown note value ${noteText}; using "${options.note}"`)
  }
  ctx.inject(['compaction', 'llm'], (scope) => {
    const engine = scope?.compaction
    const llm = scope?.llm
    if (engine === undefined || engine === null || typeof engine !== 'object') return
    scope.effect(() => {
      const disposeSummary = mountSummary(engine, scope, options) ?? (() => {})
      let active = true
      let inFlight = false
      let rerunRequested = false
      let installEpoch = 0
      const timers = new Set()
      const receipts = []
      const llmKey = llm !== null && typeof llm === 'object' ? unwrapService(llm) : null
      const commit = (previous, next, policies) => {
        const priorList = Array.isArray(previous?.modelPolicies) ? previous.modelPolicies.filter(isObjectRecord) : []
        const previousRows = new Map(priorList.map(row => [policyKey(row), row]))
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
        getActiveReceipts(engine).push(receipt)
        return true
      }
      const installLoop = async (initialAttempt) => {
        if (!active) return
        if (inFlight) {
          rerunRequested = true
          return
        }
        inFlight = true
        let attempt = initialAttempt
        try {
          while (active) {
            rerunRequested = false
            const runEpoch = installEpoch
            const { installed, catalogCount } = await runInstallPolicies(engine, llm, options, (previous, next, policies) => {
              if (!active || runEpoch !== installEpoch) return false
              return commit(previous, next, policies)
            })
            if (!active) return
            if (rerunRequested || runEpoch !== installEpoch) {
              attempt = 0
              continue
            }
            if (installed > 0) {
              log('info', `compaction-force: installed ${installed} model policies (forceAtTokens=${options.forceAtTokens}, minContextWindow=${options.minContextWindow})`)
              return
            }
            if (catalogCount > 0) {
              if (receipts.length === 0) {
                log('info', `compaction-force: no new model policies installed (no catalog model qualifies above minContextWindow=${options.minContextWindow} or tighter policy already active)`)
              }
              return
            }
            if (attempt < 2) {
              const timer = globalThis.setTimeout(() => {
                timers.delete(timer)
                void installLoop(attempt + 1)
              }, attempt === 0 ? 500 : 2000)
              timers.add(timer)
              return
            }
            log('warn', `compaction-force: no model policies installed (empty catalog or no window > ${options.minContextWindow}); compaction keeps the shipped threshold`)
            return
          }
        } catch (error) {
          if (active) log('warn', `compaction-force: policy installation failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          inFlight = false
        }
      }
      const unsubscribe = typeof scope.on === 'function'
        ? scope.on('llm/adapters-updated', () => {
            if (!active) return
            installEpoch += 1
            if (llmKey !== null) catalogCache.delete(llmKey)
            for (const timer of timers) globalThis.clearTimeout(timer)
            timers.clear()
            void installLoop(0)
          })
        : null
      void installLoop(0)
      return () => {
        active = false
        try { if (typeof unsubscribe === 'function') unsubscribe() } catch {}
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
