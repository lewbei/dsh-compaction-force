# Full benchmark run — measured results

Run: `node benchmarks/compint-run/retention-bench.mjs --full`
(config: seeds `101,202,303`; 100 instances per seed per arm; 8 constraints per
scenario; 3 repeated-compaction generations; arms `off,context,handoff,both`).
Timestamp: `2026-11-13T07:49:36Z`, commit `d270716` (PRs #11–#30 applied).
Reproduce with the identical command; determinism was verified byte-identical
across repeated runs.

## Single-pass retention (3 seeds × 100 instances × 8 constraints = 2400 per arm)

| Arm | Retention | Intact retention | found/total |
|---|---:|---:|---:|
| off | 0 % (0 %–0 % across seeds) | 0 % (0 %–0 %) | 0/2400 |
| context | 100 % (100 %–100 % across seeds) | 100 % (100 %–100 %) | 2400/2400 |
| handoff | 100 % (100 %–100 % across seeds) | 100 % (100 %–100 %) | 2400/2400 |
| both | 100 % (100 %–100 % across seeds) | 100 % (100 %–100 %) | 2400/2400 |

## Repeated-compaction (3 generations)

| Arm | All prior constraints survive every generation | Per-constraint prior survival | Added instructions survive |
|---|---:|---:|---:|
| off | 0/300 | 0/2400 (0 %) | 0/600 |
| context | 0/300 | 1800/2400 (75 %) | 600/600 |
| handoff | 0/300 | 1800/2400 (75 %) | 600/600 |
| both | 0/300 | 1800/2400 (75 %) | 600/600 |

### What the 75 % means (cap eviction, by design)

The extractor keeps a fixed 8-slot cap. Each generation adds one new
instruction, which is guaranteed a slot (newest-first), and the prior
constraints are carried forward into the remaining slots. With 8 original
constraints:

- generation 1: 8 originals;
- generation 2: 1 new + 8 prior candidates → 1 oldest original evicted;
- generation 3: another new + the resulting 8 → a second oldest original
  evicted, leaving 6/8 originals = 75 %.

Every added instruction survives (600/600), and the *freshest* constraints are
always retained. Older constraints are evicted oldest-first once the total
exceeds 8 — a documented bound, not a data loss bug. If unbounded preservation
is ever required, the cap (or a per-generation reservation policy) is the
tuning point.

## Limits

- Local simulation with a synthetic, deliberately lossy summarizer; no LLM, no
  live profile. Real-session retention depends on the actual summarizer.
- Does not reproduce the external `hype/dsh-compaction-ab/` harness numbers
  (not shipped in this repo); those remain recorded external evidence.
