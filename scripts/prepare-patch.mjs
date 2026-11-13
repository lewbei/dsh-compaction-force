#!/usr/bin/env node
/**
 * Prepare a mountable cordis.patch.yml row for @local/dsh-compaction-force.
 *
 * The tracked `cordis.patch.yml` is a template whose `name` points at a
 * placeholder path; installing it unchanged would mount a nonexistent module.
 * This script deterministically substitutes the real absolute path to
 * `index.js` and prints the resulting patch (or writes it with --out).
 *
 * Usage:
 *   node scripts/prepare-patch.mjs /abs/path/to/dsh-compaction-force/index.js
 *   node scripts/prepare-patch.mjs /abs/path/to/dsh-compaction-force/index.js --out /tmp/compaction-force.patch.yml
 *
 * It never modifies a live profile, plugin bundle, or running server. Mounting
 * the produced patch still requires a disposable profile test and a full DSH
 * restart of that profile (see README "Live mounting").
 */
import { extname, resolve } from 'node:path'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PLACEHOLDER = '/path/to/dsh-compaction-force/index.js'
const templatePath = resolve(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))

function printUsage() {
  console.error(`Usage: node scripts/prepare-patch.mjs <absolute-path-to-index.js> [--out <file>]

Substitutes the placeholder name in cordis.patch.yml with the absolute path of
the plugin entry module and prints the resulting patch. Use --out to write it
to a file instead of stdout. Does not touch any profile, bundle, or server.`)
}

const args = process.argv.slice(2)
if (args.length === 0) {
  printUsage()
  process.exit(1)
}

let moduleArg = null
let outArg = null
let endOfFlags = false

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (!endOfFlags && arg === '--') {
    endOfFlags = true
    continue
  }
  if (!endOfFlags) {
    if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      if (outArg !== null) {
        console.error('prepare-patch: --out specified more than once')
        process.exit(1)
      }
      const next = arg === '--out' ? args[++i] : arg.slice('--out='.length)
      if (typeof next !== 'string' || next.length === 0 || next.startsWith('-')) {
        console.error('prepare-patch: --out requires an output file path')
        process.exit(1)
      }
      outArg = next
      continue
    }
    if (arg.startsWith('-')) {
      console.error(`prepare-patch: unknown option: ${arg}`)
      process.exit(1)
    }
  }
  if (moduleArg !== null) {
    console.error(`prepare-patch: unexpected argument: ${arg}`)
    process.exit(1)
  }
  moduleArg = arg
}

if (moduleArg === null) {
  printUsage()
  process.exit(1)
}

const source = resolve(moduleArg)
let sourceStat
try {
  sourceStat = statSync(source)
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.error(`prepare-patch: module not found: ${source}`)
  } else {
    console.error(`prepare-patch: cannot inspect module ${source}: ${error?.message ?? error}`)
  }
  process.exit(1)
}
if (extname(source) !== '.js' || !sourceStat.isFile()) {
  console.error(`prepare-patch: expected a .js entry module file, got: ${source}`)
  process.exit(1)
}

let template
try {
  template = readFileSync(templatePath, 'utf8')
} catch (error) {
  console.error(`prepare-patch: cannot read template ${templatePath}: ${error?.message ?? error}`)
  process.exit(1)
}
if (!template.includes(PLACEHOLDER)) {
  console.error(`prepare-patch: template ${templatePath} no longer contains the placeholder ${PLACEHOLDER}`)
  process.exit(1)
}

const quotedPath = JSON.stringify(source)
const patch = template.split(PLACEHOLDER).join(quotedPath)
if (!patch.includes(`name: ${quotedPath}`) || !patch.includes('id: compaction-force')) {
  console.error('prepare-patch: generated patch is missing the expected row structure')
  process.exit(1)
}

if (outArg !== null) {
  const out = resolve(outArg)
  try {
    writeFileSync(out, patch)
  } catch (error) {
    console.error(`prepare-patch: failed to write ${out}: ${error?.message ?? error}`)
    process.exit(1)
  }
  console.log(`prepared patch written to ${out}`)
} else {
  process.stdout.write(patch)
}
