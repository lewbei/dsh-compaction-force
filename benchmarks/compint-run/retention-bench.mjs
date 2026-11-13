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
 * Run: node benchmarks/compint-run/retention-bench.mjs            (quick, default)
 *      node benchmarks/compint-run/retention-bench.mjs --full      (large run)
 *      node benchmarks/compint-run/retention-bench.mjs \
 *        --instances 100 --seeds 101,202,303 --constraints 8 --generations 3
 * Options:
 *   --instances N    scenarios per seed per arm (default 10)
 *   --seeds a,b,c    comma-separated deterministic seeds (default 20261112)
 *   --constraints K  constraints per scenario (default 6)
 *   --generations G  repeated-compaction generations to test (default 2)
 *   --arms a,b,c     arms to run (default off,context,handoff,both)
 *   --full           shorthand for --instances 100 --seeds 101,202,303
 *                    --constraints 8 --generations 3
 */
import { buildNoteText, extractSideConstraints } from '../../index.js'

// ---------------------------------------------------------------------------
// CLI parsing (kept dependency-free)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const get = (name, fallback) => {
    const index = argv.indexOf(name)
    return index === -1 ? fallback : argv[index + 1]
  }
  let instances = Number(get('--instances', 10))
  let seeds = get('--seeds', '20261112').split(',').map((value) => Number(value.trim())).filter(Number.isFinite)
  let constraints = Number(get('--constraints', 6))
  let generations = Number(get('--generations', 2))
  let arms = get('--arms', 'off,context,handoff,both').split(',').map((value) => value.trim()).filter(Boolean)
  if (argv.includes('--full')) {
    instances = 100
    seeds = [101, 202, 303]
    constraints = 8
    generations = 3
    arms = ['off', 'context', 'handoff', 'both']
  }
  if (!Number.isInteger(instances) || instances <= 0) instances = 10
  if (!Number.isInteger(constraints) || constraints <= 0) constraints = 6
  if (!Number.isInteger(generations) || generations <= 0) generations = 2
  if (seeds.length === 0) seeds = [20261112]
  return { instances, seeds, constraints, generations, arms }
}

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
  return [
    '## Primary Request and Intent',
    '- Research the deployment pipeline and prepare a rollout plan.',
    '',
    '## Key Technical Concepts',
    '- Database migrations must run inside isolated transactions.',
    '- Cache invalidation should avoid stale reads across workers.',
    '',
    '## Errors and Fixes',
    '- Connection timeout: must not use default pool size of 5.',
    '- Token validation: should reject expired refresh tokens and prevent replay.',
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
    '- Avoid deploying broken artifacts; require green verification checks.',
  ].join('\n')
}

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
  const full = [
    'This is an automatically generated checkpoint condensing an earlier span.',
    '',
    '<compacted-summary>',
    `${summaryText}${note}`,
    '</compacted-summary>',
  ].join('\n')
  return { summary: `Framed checkpoint.\n${summaryText}`, note, full }
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
function run(cfg) {
  const { instances, constraints, seeds, arms } = cfg
  const perSeed = {}
  const totals = {}
  for (const arm of arms) totals[arm] = { found: 0, intact: 0, total: 0 }
  for (const seed of seeds) {
    const random = mulberry32(seed)
    perSeed[seed] = {}
    for (const arm of arms) {
      const scenarios = Array.from({ length: instances }, () => makeConversation(random, constraints))
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
      perSeed[seed][arm] = { retention: found / total, intactRetention: intact / total }
      totals[arm].found += found
      totals[arm].intact += intact
      totals[arm].total += total
    }
  }
  const aggregate = {}
  for (const arm of arms) {
    const per = seeds.map((seed) => perSeed[seed][arm])
    const retention = per.map((entry) => entry.retention)
    const intact = per.map((entry) => entry.intactRetention)
    aggregate[arm] = {
      retention: totals[arm].found / totals[arm].total,
      intactRetention: totals[arm].intact / totals[arm].total,
      retentionMin: Math.min(...retention),
      retentionMax: Math.max(...retention),
      intactMin: Math.min(...intact),
      intactMax: Math.max(...intact),
      found: totals[arm].found,
      intact: totals[arm].intact,
      total: totals[arm].total,
    }
  }
  return { aggregate, perSeed }
}

// ---------------------------------------------------------------------------
// Repeated-compaction experiment: each generation sees the previous checkpoint
// as a framed replacement user message plus one new instruction.
// ---------------------------------------------------------------------------
function runRepeated(arm, cfg) {
  const { instances, constraints, generations, seeds } = cfg
  let priorAllSurvived = 0
  let priorFound = 0
  let priorTotal = 0
  let newSurvived = 0
  let newTotal = 0
  let total = 0
  for (const seed of seeds) {
    const random = mulberry32(seed ^ 0x5F3759DF)
    for (let i = 0; i < instances; i += 1) {
      const scenario = makeConversation(random, constraints)
      let checkpoint = assembleCheckpoint(scenario, arm)
      const addedInstructions = []
      for (let g = 2; g <= generations; g += 1) {
        const instruction = `Always wait for approval before step ${g} of this task.`
        addedInstructions.push(instruction)
        checkpoint = assembleCheckpoint({
          messages: [
            { role: 'user', content: [{ type: 'text', text: checkpoint.full }] },
            { role: 'user', content: [{ type: 'text', text: instruction }] },
          ],
        }, arm)
      }
      const oldScore = constraintScore(checkpoint, scenario.constraints)
      if (oldScore.found === scenario.constraints.length) priorAllSurvived += 1
      priorFound += oldScore.found
      priorTotal += scenario.constraints.length
      const newOk = addedInstructions.filter((instruction) => constraintScore(checkpoint, [instruction]).found === 1).length
      newSurvived += newOk
      newTotal += addedInstructions.length
      total += 1
    }
  }
  return { priorAllSurvived, priorFound, priorTotal, newSurvived, newTotal, total }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const pct = (value) => `${(value * 100).toFixed(0)} %`

const cfg = parseArgs(process.argv.slice(2))
const { aggregate, perSeed } = run(cfg)
const repeated = {}
for (const arm of cfg.arms) repeated[arm] = runRepeated(arm, cfg)

console.log('CompInt-style side-constraint retention benchmark')
console.log(`seeds=${cfg.seeds.join(',')} instances/seed=${cfg.instances} constraints/scenario=${cfg.constraints} generations=${cfg.generations} arms=${cfg.arms.join(',')}`)
console.log('simulated task-centric summarizer drops instructions; real extractSideConstraints + buildNoteText used')
console.log('')
console.log('| Arm | Retention | Intact retention | found/total |')
console.log('|---|---:|---:|---:|')
for (const arm of cfg.arms) {
  const r = aggregate[arm]
  const spread = cfg.seeds.length > 1
    ? ` (${pct(r.retentionMin)}–${pct(r.retentionMax)} across seeds)`
    : ''
  const spreadIntact = cfg.seeds.length > 1
    ? ` (${pct(r.intactMin)}–${pct(r.intactMax)})`
    : ''
  console.log(`| ${arm} | ${pct(r.retention)}${spread} | ${pct(r.intactRetention)}${spreadIntact} | ${r.found}/${r.total} |`)
}
console.log('')
console.log('Metric definitions: retention = fraction of original constraints found (normalized) in the')
console.log('final checkpoint; intact retention = fraction found with unchanged normalized wording.')
console.log('')
console.log(`Repeated-compaction experiment (${cfg.generations} generations):`)
for (const arm of cfg.arms) {
  const r = repeated[arm]
  console.log(`- ${arm}: all prior constraints surviving every generation: ${r.priorAllSurvived}/${r.total} scenarios;`)
  console.log(`  per-constraint prior survival: ${r.priorFound}/${r.priorTotal} (${pct(r.priorFound / r.priorTotal)});`)
  console.log(`  instructions added across generations surviving: ${r.newSurvived}/${r.newTotal}`)
}
console.log('')
console.log('LIMIT: local simulation, no LLM, no live profile; not a reproduction of the external')
console.log('hype/dsh-compaction-ab/ harness numbers.')

// exit 0 always; benchmark output is the record
process.exitCode = 0
