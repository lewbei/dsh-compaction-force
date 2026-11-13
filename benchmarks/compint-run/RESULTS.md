# CompInt-style side-constraint retention — measured results

Harness: `retention-bench.mjs` (self-contained, deterministic seed `20261112`,
10 instances × 6 constraints per scenario per arm, no LLM calls, no live
profile). It uses the real plugin code — `extractSideConstraints` +
`buildNoteText` — against a simulated task-centric summarizer that drops user
instructions from its own summary, which is exactly the loss the CompInt paper
describes. Run it yourself: `node benchmarks/compint-run/retention-bench.mjs`.

## Metrics

- **retention** — fraction of original constraints found (normalized) in the
  final checkpoint text after compaction.
- **intact retention** — fraction found whose normalized wording is unchanged
  (standalone line/bullet).

## Results (2026-11-13T07:49:36Z, commit `d270716` with PRs #11–#30 applied)

| Arm | Retention | Intact retention | found/total |
|---|---:|---:|---:|
| off | 0 % | 0 % | 0/60 |
| context | 100 % | 100 % | 60/60 |
| handoff | 100 % | 100 % | 60/60 |
| both | 100 % | 100 % | 60/60 |

Observations:

- `off` loses everything, as designed (the summarizer drops instructions and no
  note re-injects them).
- Every note-bearing arm reaches 100 % retention and 100 % intact retention in
  this simulation. Note: the `context` arm also carries the `Active
  Constraints` section — the plugin re-injects side constraints regardless of
  the `note` variant (only `off` disables the note entirely).

### Repeated-compaction experiment (2 generations)

Each generation sees the previous checkpoint as a framed replacement user
message plus one new instruction. Measured across all 4 arms:

| Arm | All prior constraints survive | Per-constraint prior survival | Added instructions survive |
|---|---:|---:|---:|
| off | 0/10 scenarios | 0/60 (0 %) | 0/10 |
| context | 10/10 scenarios | 60/60 (100 %) | 10/10 |
| handoff | 10/10 scenarios | 60/60 (100 %) | 10/10 |
| both | 10/10 scenarios | 60/60 (100 %) | 10/10 |

> Historical regression fixed in PR #8: the initial harness measured **0/10**
> for prior-constraint survival because the section-skip heuristic treated the
> plugin's own `Active Constraints` bullets as synthetic and dropped them. PR #8
> and subsequent hardening in PRs #20–#26 preserve genuine prior-constraint
> bullets across balanced `<compacted-summary>` spans while still excluding
> generated footers, headings, fences, and context/handoff notes.

## Limits

- Local simulation with a synthetic, deliberately lossy summarizer; no LLM, no
  live profile. Retention depends on the summarizer's behavior in a real
  session.
- This does **not** reproduce the numbers of the external
  `hype/dsh-compaction-ab/` harness (not shipped in this repo). Those remain
  recorded external evidence; this table is fresh measured evidence for this
  plugin.
