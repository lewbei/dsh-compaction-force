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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PLACEHOLDER = '/path/to/dsh-compaction-force/index.js'
const templatePath = resolve(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.error(`Usage: node scripts/prepare-patch.mjs <absolute-path-to-index.js> [--out <file>]

Substitutes the placeholder name in cordis.patch.yml with the absolute path of
the plugin entry module and prints the resulting patch. Use --out to write it
to a file instead of stdout. Does not touch any profile, bundle, or server.`)
  process.exit(args.length === 0 ? 1 : 0)
}

const source = resolve(args[0])
if (!existsSync(source)) {
  console.error(`prepare-patch: module not found: ${source}`)
  process.exit(1)
}
if (extname(source) !== '.js') {
  console.error(`prepare-patch: expected a .js entry module, got: ${source}`)
  process.exit(1)
}

const template = readFileSync(templatePath, 'utf8')
if (!template.includes(PLACEHOLDER)) {
  console.error(`prepare-patch: template ${templatePath} no longer contains the placeholder ${PLACEHOLDER}`)
  process.exit(1)
}
const patch = template.split(PLACEHOLDER).join(source)
if (!patch.includes(`name: ${source}`) || !patch.includes('id: compaction-force')) {
  console.error('prepare-patch: generated patch is missing the expected row structure')
  process.exit(1)
}

const outIndex = args.indexOf('--out')
if (outIndex !== -1) {
  const out = resolve(args[outIndex + 1])
  writeFileSync(out, patch)
  console.log(`prepared patch written to ${out}`)
} else {
  process.stdout.write(patch)
}
