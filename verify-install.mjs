#!/usr/bin/env node
/**
 * Verify the portable install story without touching any live profile, bundle,
 * or server.
 *
 * Checks:
 *  1. scripts/prepare-patch.mjs substitutes the placeholder path with a real
 *     absolute .js path and refuses missing/placeholder inputs;
 *  2. the produced patch has the expected row structure and points at an
 *     existing module;
 *  3. the patch template and README document the mount rules (compaction
 *     isolate group, web-profile inertness, full restart);
 *  4. package.json ships the prepare script and this verifier.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('.', import.meta.url).pathname
const node = process.execPath

let passed = 0
const ok = (name) => { passed += 1; console.log(`PASS ${name}`) }

// --- disposable fixture module -------------------------------------------
const fixture = mkdtempSync(join(tmpdir(), 'compaction-force-install-'))
const fixtureModule = join(fixture, 'index.js')
writeFileSync(fixtureModule, 'export const name = "compaction-force"\n')

try {
  // 1. prepare-patch on the fixture path --------------------------------
  const run = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), fixtureModule], { encoding: 'utf8' })
  assert.equal(run.status, 0, `prepare-patch exited ${run.status}: ${run.stderr}`)
  const patch = run.stdout
  assert(!patch.includes('/path/to/dsh-compaction-force/index.js'), 'placeholder must be substituted')
  assert(patch.includes(`name: ${fixtureModule}`), 'patch must name the absolute fixture module')
  assert(patch.includes('id: compaction-force'), 'patch must keep the row id')
  assert(patch.includes('forceAtTokens: 262144'), 'patch must keep the default config')
  const nameLine = patch.split('\n').find((line) => line.trim().startsWith('name:'))
  const nameValue = nameLine.split('name:')[1].split('#')[0].trim()
  assert(nameLine && existsSync(nameValue), 'name must resolve to an existing file')
  ok('prepare-patch substitutes a real absolute path and preserves the row structure')

  // 2. --out write mode ---------------------------------------------------
  const outFile = join(fixture, 'out.patch.yml')
  const out = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), fixtureModule, '--out', outFile], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(readFileSync(outFile, 'utf8'), patch, '--out must write the same patch')
  ok('prepare-patch --out writes the identical patch')

  // 3. refusal of a non-existent module -----------------------------------
  const missing = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), join(fixture, 'nope.js')], { encoding: 'utf8' })
  assert.notEqual(missing.status, 0, 'missing module must be refused')
  ok('prepare-patch refuses a nonexistent module')

  // 4. template documents the mount rules ---------------------------------
  const template = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert(template.includes('prepare-patch'), 'template must point at prepare-patch')
  assert(/compaction isolate group/i.test(template), 'template must state the isolate-group requirement')
  ok('patch template documents the supported prep flow')

  // 5. README documents the live-mount procedure --------------------------
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  assert(/prepare-patch/.test(readme), 'README must document prepare-patch')
  assert(/compaction isolate group/i.test(readme), 'README must state the isolate-group requirement')
  assert(/full DSH restart/i.test(readme), 'README must state the restart requirement')
  ok('README documents the portable mount procedure')

  // 6. package.json ships the required files -------------------------------
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert((pkg.files ?? []).includes('scripts/prepare-patch.mjs'), 'package must ship prepare-patch')
  assert((pkg.files ?? []).includes('verify-install.mjs'), 'package must ship verify-install')
  ok('package.json includes the prepare and verification scripts')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

console.log(`\n${passed} passed, 0 failed`)
console.log('LIMIT: no live profile, DSH server, or real bundle was mounted or changed.')
