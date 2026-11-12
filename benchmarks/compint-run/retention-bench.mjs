#!/usr/bin/env node
/**
 * CompInt-style side-constraint retention benchmark for @local/dsh-compaction-force.
 *
 * Measures what actually survives in the checkpoint the model receives after
 * compaction, per `note` arm (off | context | handoff | both), using the real
 * plugin code (extractSideConstraints + buildNoteText) against a simulated
 * task-centric summarizer that drops user instructions from its own summary —
 * exactly the loss the CompInt paper describes.
 *
 * This is an executable, self-contained harness: no LLM calls, no live profile,
 * deterministic seed, runs in well under a second. It does NOT reproduce the
 * numbers of the external harness (`hype/dsh-compaction-ab/`, not shipped in
 * this repo); it is fresh measured evidence for THIS plugin.
 *
 * Metrics (both defined here, transparently):
 *   retention        — fraction of original constraints found (normalized) in
 *                      the final checkpoint text after compaction.
 *   intact retention — fraction found whose normalized wording is unchanged
 *                      (verbatim), i.e. not garbled or merged with other text.
 *
 * Run: node benchmarks/compint-run/retention-bench.mjs
 */
import { buildNoteText, extractSideConstraints } from '../../index.js'

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) so the benchmark is reproducible.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0
  return function random() {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Scenario generation
// ---------------------------------------------------------------------------
const CONSTRAINT_POOL = [
  'Never deploy without explicit approval.',
  'Always show the diff before applying changes.',
  'Do not install packages without asking first.',
  'Never send messages to customers directly.',
  'Always wait for my approval before merging.',
  'Do not change the live profile without authorization.',
  'Never share credentials with third parties.',
  'Always run the full test suite before pushing.',
  'Do not modify files outside the workspace.',
  'Never delete data without a backup first.',
  'Always confirm the target environment before running.',
  'Do not skip the verification step.',
]

function pick(random, pool, count) {
  const copy = [...pool]
  const out = []
  for (let i = 0; i < count && copy.length > 0; i += 1) {
    out.push(copy.splice(Math.floor(random() * copy.length), 1)[0])
  }
  return out
}

function makeConversation(random, constraintCount = 6) {
  const constraints = pick(random, CONSTRAINT_POOL, constraintCount)
  const messages = []
  // Simulate the raw session: two user turns, one carrying the constraints,
  // plus assistant filler. The "task-centric" summarizer below will NOT
  // reproduce the constraint text in its own summary.
  messages.push({ role: 'user', content: [{ type: 'text', text: 'Please research the deployment pipeline and prepare a summary.' }] })
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'I will start by reading the pipeline docs.' }] })
  messages.push({ role: 'user', content: [{ type: 'text', text: constraints.join(' ') }] })
  messages.push({ role: 'user', content: [{ type: 'text', text: 'Give me the plan when you have it.' }] })
  return { messages, constraints }
}

// ---------------------------------------------------------------------------
// Simulated task-centric summarizer: drops user instructions.
// ---------------------------------------------------------------------------
function summarize(conversation) {
  // The summarizer keeps the task narrative but drops side constraints.
  return [
    '## Primary Request and Intent',
    '- research the deployment pipeline and prepare a summary',
    '',
    '## Current Work',
    '- reading the pipeline docs',
    '- drafting the deployment plan',
    '',
    '## Next Step',
    '- present the plan',
    '',
    '## Critical Context',
    '- pipeline docs are in ./docs',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Checkpoint assembly (mirrors mountSummary's append behavior)
// ---------------------------------------------------------------------------
function assembleCheckpoint(conversation, variant, options = {}) {
  const summaryText = summarize(conversation)
  // Mirror the real mountSummary gate: the off arm appends no note at all.
  const note = variant === 'off'
    ? ''
    : buildNoteText({
        variant,
        heading: options.heading,
        summaryText,
        totalTokens: 120000,
        timestamp: '2026-11-12T22:30:00.000Z',
        sideConstraints: options.scExtract === 'off'
          ? []
          : extractSideConstraints(conversation.messages, { heading: options.heading }),
      })
  return { summary: `Framed checkpoint.\n${summaryText}`, note, full: `Framed checkpoint.\n${summaryText}${note}` }
}

// ---------------------------------------------------------------------------
// Normalized matching
// ---------------------------------------------------------------------------
const normalize = (text) => text.toLowerCase().replace(/\s+/g, ' ').replace(/[!?.,;:]+$/g, '').trim()

// Strip markdown bullet/number markers for chunk comparison.
const stripMarkers = (text) => text.replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/, '').trim()

function constraintScore(checkpoint, constraints) {
  const haystack = normalize(checkpoint.full)
  const lines = checkpoint.full
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => normalize(stripMarkers(line)))
  let found = 0
  let intact = 0
  for (const constraint of constraints) {
    const needle = normalize(constraint)
    if (haystack.includes(needle)) {
      found += 1
      // intact: the normalized clause appears as its own line/bullet, i.e.
      // the exact wording survived as a standalone item.
      if (lines.includes(needle)) intact += 1
    }
  }
  return { found, intact }
}

// ---------------------------------------------------------------------------
// Benchmark driver
// ---------------------------------------------------------------------------
const SEED = 20261112
const INSTANCES = 10
const CONSTRAINTS_PER_SCENARIO = 6
const ARMS = ['off', 'context', 'handoff', 'both']

function run() {
  const random = mulberry32(SEED)
  const scenarios = Array.from({ length: INSTANCES }, () => makeConversation(random, CONSTRAINTS_PER_SCENARIO))
  const results = {}
  for (const arm of ARMS) {
    let found = 0
    let intact = 0
    let total = 0
    for (const scenario of scenarios) {
      const checkpoint = assembleCheckpoint(scenario, arm)
      const { found: f, intact: i } = constraintScore(checkpoint, scenario.constraints)
      found += f
      intact += i
      total += scenario.constraints.length
    }
    results[arm] = {
      retention: found / total,
      intactRetention: intact / total,
      found,
      intact,
      total,
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Repeated-compaction experiment: a second compaction sees the first
// checkpoint as a framed replacement user message, plus one new instruction.
// ---------------------------------------------------------------------------
function runRepeated(arm = 'handoff') {
  const random = mulberry32(SEED ^ 0x5F3759DF)
  let priorSurvived = 0
  let newSurvived = 0
  const total = INSTANCES
  for (let i = 0; i < INSTANCES; i += 1) {
    const scenario = makeConversation(random, CONSTRAINTS_PER_SCENARIO)
    const first = assembleCheckpoint(scenario, arm)
    const newInstruction = 'Never deploy on weekends without a reviewer present.'
    const secondRoundMessages = [
      { role: 'user', content: [{ type: 'text', text: first.full }] },
      { role: 'user', content: [{ type: 'text', text: newInstruction }] },
    ]
    const second = assembleCheckpoint({ messages: secondRoundMessages }, arm)
    const oldScore = constraintScore(second, scenario.constraints)
    if (oldScore.found === scenario.constraints.length) priorSurvived += 1
    if (constraintScore(second, [newInstruction]).found === 1) newSurvived += 1
  }
  return { priorSurvived, newSurvived, total }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const pct = (value) => `${(value * 100).toFixed(0)} %`

const results = run()

console.log('CompInt-style side-constraint retention benchmark')
console.log(`seed=${SEED} instances=${INSTANCES} constraints/scenario=${CONSTRAINTS_PER_SCENARIO} arms=${ARMS.join(',')}`)
console.log('simulated task-centric summarizer drops instructions; real extractSideConstraints + buildNoteText used')
console.log('')
console.log('| Arm | Retention | Intact retention | found/total |')
console.log('|---|---:|---:|---:|')
for (const arm of ARMS) {
  const r = results[arm]
  console.log(`| ${arm} | ${pct(r.retention)} | ${pct(r.intactRetention)} | ${r.found}/${r.total} |`)
}
console.log('')
console.log('Metric definitions: retention = fraction of original constraints found (normalized) in the')
console.log('final checkpoint; intact retention = fraction found with unchanged normalized wording.')
console.log('')

const repeated = runRepeated('handoff')
console.log('Repeated-compaction experiment (handoff arm):')
console.log(`- prior constraints surviving a second compaction: ${repeated.priorSurvived}/${repeated.total} scenarios`)
console.log(`- a new instruction added before the second compaction surviving it: ${repeated.newSurvived}/${repeated.total}`)
console.log('')
console.log('LIMIT: local simulation, no LLM, no live profile; not a reproduction of the external')
console.log('hype/dsh-compaction-ab/ harness numbers.')

// exit 0 always; benchmark output is the record
process.exitCode = 0
