# @local/dsh-compaction-force

Requested behavior (2026-11-12):

1. **Force pressure compaction at ~256K tokens on models whose context window
   is > 500K.** Models at or below 500K keep the shipped compaction policy.
2. **Leave a note for itself in the checkpoint** the model receives after
   compaction. Two styles are implemented and A/B-testable:
   - `context` — a footer note stating the earlier span was compacted at ~N
     tokens/time and that the checkpoint is authoritative;
   - `handoff` — a `## Note to Self (handoff)` section distilled from the
     checkpoint's own Current Work / Next Step / Critical Context sections.

Mounted in the **Guarded** preset only (inside its `compaction` isolate group).
The Standard preset is untouched.

## Why a plugin instead of preset config

The shipped formula is

```
threshold = min(thresholdRatio * W, W - reserved - headroomTokens)
```

with `headroomTokens = 65536` and `thresholdRatio = 0.8` by default. A static
`modelPolicies` list in the preset would need one entry per model and would go
stale on every catalog sync (`opencode-go`, `codex`, `openrouter` routes are
synced). Instead the plugin, at activation:

1. enumerates the live catalog via `llm.listProviders()` /
   `llm.listModels(provider)` / `llm.resolveModelInfo(provider, model)`;
2. builds `{ provider, model, thresholdRatio: forceAtTokens / W }` for every
   model with `W > minContextWindow` (adding `retainRatio = ratio / 2` when the
   ratio drops below the shipped 0.16 retention ratio, which would otherwise be
   rejected as `retain >= threshold`);
3. replaces the compaction engine's frozen `config` value with a new frozen
   config carrying those policies (the engine object and its `config` property
   are writable; the shipped package stays untouched).

The catalog enumeration is cached per `llm` service for 5 minutes and shared by
every compaction engine in the process. The install is retried twice when the
boot catalog is still empty (the web profile's pi-ai adapters register slightly
after the llm service), and the result is logged, so a post-restart operator can
tell activation from silence. `agent/pre-step` runs before every step: a fresh
session starts far below the threshold, but a resumed session already above it
can see one shipped-policy step before the asynchronous install lands.

Examples on the 2026-11-12 catalog:

| route/model | window | ratio | resolved threshold |
|---|---|---|---|
| `deepseek-official/deepseek-flash` | 1,048,576 | 0.25 | 262,144 |
| `opencode-go/deepseek-v4.1-flash` | 1,000,000 | 0.262144 | 262,144 (reserve 384K still leaves 550K budget) |
| `inception/mercury-3` | 1,000,000 | 0.262144 | 262,144 |
| `openrouter` 1M models with 943K output caps | 1,048,576 | 0.25 | ~39K — the formula's reserve term wins; a fixed 256K target is impossible without lowering the declared output cap |
| `codex/gpt-6-astra` (272K) | 272,000 | — | untouched (≤ 500K) |

## Notes inside the checkpoint

The plugin wraps the engine's public `summarize`. The appended text blocks land
inside the shipped `<compacted-summary>` framing, so the model sees them as part
of the checkpoint. `context` uses `tokenMeter.measure(session)` for the size and
the current time; `handoff` extracts bullets from the standard summary sections
and falls back to "Resume from the checkpoint above…" when they are absent.

Config: `forceAtTokens` (default 262144), `minContextWindow` (default 500000),
`note` = `off | context | handoff | both` (default `handoff`), `heading`
(default `Note to Self (handoff)`), `scExtract` = `pattern | off` (default
`pattern`, the side-constraint extractor).

## Verification

- `node verify.mjs` — 40 assertions covering option normalization, policy
  math/filtering/retention (including customized and retainTokens retention
  modes and same-key field preservation), catalog caching and error skipping,
  frozen-config replacement + merge, section extraction, both note styles,
  degraded token meter, error propagation, idempotent wrap, multiline and
  repeated-checkpoint constraint extraction, and the cordis wiring. Exit 0.
- `node verify-policy-boundaries.mjs <installed DSH node_modules>` — 48
  policy configurations plus a 72-combination retention matrix, all accepted by
  the shipped `BasicCompactionEngine` constructor.
- `node verify-lifecycle.mjs <installed DSH node_modules>` — 7 real-Cordis
  lifecycle groups with the shipped engine and controlled catalog/summarizer
  I/O.
- `node verify-install.mjs` — 8 portable-mount fixture checks (see "Live
  mounting") run against disposable temporary modules, never against a live
  profile.
- Real boot check (disposable headless profile + `--patch`, scaled
  `forceAtTokens: 500`, `minContextWindow: 1000`): pressure compaction fired on
  a tiny session (it would never fire under the default 0.8 ratio at that
  size), and both notes appeared inside the checkpoint:
  ```
  ## Note to Self (context)
  - The earlier conversation was compacted at ~7K tokens on 2026-11-12T06:21:15.414Z.
  ...
  ## Note to Self (handoff)
  - Where I was: No tool call has been executed yet; the request is still entirely outstanding.
  - Next: Call bash with command `python3 -c "print('A'*600)"`, ...
  ```
- Guarded preset structural suite `node verify.mjs --profile web`: S1–S8 green
  (Standard verbatim + exactly three intended rows: two pruner-spill rows and
  the `compaction-force` row inside the compaction group).
- `node catalog-report.mjs` (live composed profile, no boot): of 104 models with
  a >500K window, **93 resolve exactly 262,144**, 11 (openrouter models whose
  catalog declares a 943,718 output cap) resolve to 39,322 because the reserve
  term wins, and 35 models at or below 500K are untouched. The two deepseek
  routes are adapter-owned: a headless enumeration showed
  `deepseek-official/{deepseek-flash,deepseek-v4-pro}` (both 1,048,576 / 256,000)
  and no models on `deepseek-account`, so the report is a lower bound for those
  routes; the runtime plugin enumerates whatever the live process lists. The
  report prints the per-model table so a catalog change is visible without a
  live session.
- Reviewer hardening (2026-11-12): activation logs
  `compaction-force: installed N model policies ...` (or a warning when none
  installed) and retries the catalog enumeration twice when the boot catalog is
  still empty; `retainRatio` is also applied at the exact 0.16 rounding
  boundary; a force target at/above the window or a ratio >= 0.8 is skipped (a
  misconfigured row can never install a later-than-shipped threshold); handoff
  extraction normalises CRLF; `heading` strips newlines and angle brackets.

## A/B test

`hype/dsh-compaction-ab/` (separate disposable harness) runs the scaled
threshold with `note` = `off | context | handoff | both` and scores
post-compaction recall + continuation. See that directory's `RESULTS.md`.

## Benchmark result (CompInt side-constraint retention, 10 instances, beam-free)

| Arm | Retention | Effective retention |
|---|---:|---:|
| off (no note) | 50 % | 50 % |
| context | 50 % | 33 % |
| **handoff (recommended)** | **100 %** | **100 %** |
| both | 90 % | 100 % |

The `handoff` note's "Active Constraints" section extracts side constraints from
the raw conversation before compaction and re-injects them, closing the gap the
CompInt paper measures (17 % -> 90 %+).

These numbers come from a separate disposable harness (`hype/dsh-compaction-ab/`)
that is **not** shipped in this public repository; the table is recorded
evidence, not reproduced by the suites in this repo. The in-repo `verify*.mjs`
suites validate the mechanics (retention, extraction, lifecycle), not the
benchmark percentages.

## Live mounting

The tracked `cordis.patch.yml` is a **template**: the row mounts the host
plugin by absolute path, so a path must be substituted before use. Generate the
patch with the shipped helper (it never touches a profile or server):

```sh
node scripts/prepare-patch.mjs /abs/path/to/dsh-compaction-force/index.js \
  --out /tmp/compaction-force.patch.yml
```

A generated patch looks like:

```yaml
- insert:
    - id: compaction-force
      name: "/abs/path/to/dsh-compaction-force/index.js"
      config:
        forceAtTokens: 262144
        minContextWindow: 500000
        note: handoff
```

Mounting rules:
- The row **must** sit inside the compaction isolate group (the `compaction`
  service is isolated there). The Guarded preset does exactly that. Applied at
  a profile root the patch is inert in the web profile (its root
  compaction-basic row is disabled) and only meaningful in a profile whose root
  engine exists, e.g. the headless harness.
- The patch takes effect only after a **full DSH restart** of the target
  profile (the live process keeps previously imported modules in its ESM
  cache; the preset grid and its compaction engine are rebuilt at boot).
- Validate the procedure on a disposable profile clone first (`node
  verify-install.mjs` checks the patch generation and template/README
  consistency without mounting anything). No live profile, link, or server is
  changed by any of these steps — the profile's **default preset is Standard**,
  so Standard sessions get none of this: select **Guarded** when creating a
  session.

## Caveats

- Windows whose routed output reservation plus 64K headroom leave less than
  256K compact earlier than 256K; raising that would require lowering the
  declared output cap (`maxTokens`) of those models, which also lowers the
  request's `max_tokens`.
- The note is appended *inside* the `<compacted-summary>` block, not as a
  separate message; the shipped framing tells the model not to acknowledge the
  checkpoint, and the note is part of the checkpoint content.
- `handoff` is extraction-based (same conversation, no extra model call); it
  surfaces the summarizer's own resume guidance at the end of the checkpoint.
- The plugin replaces the engine config value on that instance. If another
  plugin also replaces `engine.config`, last write wins; nothing else in this
  profile does.
- The note is part of `result.summary`, so it also appears in the durable
  `compaction/summary` session-log record, not only in the checkpoint message
  the model reads. That keeps the log truthful about what the model saw; a
  consumer that treats the recorded summary as the model's verbatim output will
  see the plugin's note text.
