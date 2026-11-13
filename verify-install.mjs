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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
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
  assert(patch.includes(`name: "${fixtureModule}"`), 'patch must name the absolute fixture module in a quoted scalar')
  assert(patch.includes('id: compaction-force'), 'patch must keep the row id')
  assert(patch.includes('forceAtTokens: 262144'), 'patch must keep the default config')
  const nameLine = patch.split('\n').find((line) => line.trim().startsWith('name:'))
  const nameValue = nameLine.split('name:')[1].split('#')[0].trim().replace(/^"|"$/g, '')
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

  // 3b. refusal of a directory named like a module --------------------------
  const dirModule = join(fixture, 'dir.js')
  mkdirSync(dirModule)
  const dirRun = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), dirModule], { encoding: 'utf8' })
  assert.notEqual(dirRun.status, 0, 'a directory must be refused')
  ok('prepare-patch refuses a directory posing as a module')

  // 3c. a colon-space path stays a valid quoted scalar ----------------------
  const colonDir = join(fixture, 'c: d')
  mkdirSync(colonDir)
  const colonModule = join(colonDir, 'index.js')
  writeFileSync(colonModule, 'export const name = "compaction-force"\n')
  const colonRun = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), colonModule], { encoding: 'utf8' })
  assert.equal(colonRun.status, 0, colonRun.stderr)
  assert(colonRun.stdout.includes(`name: "${colonModule}"`), 'colon-space path must be emitted as a quoted scalar')
  ok('prepare-patch quotes a colon-space path')

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
  const bundlePatchRel = pkg.dsh?.bundle?.patch
  assert.equal(typeof bundlePatchRel, 'string', 'package must declare dsh.bundle.patch')
  assert((pkg.files ?? []).includes(bundlePatchRel.replace(/^\.\//, '')), 'package.json files must include dsh.bundle.patch')
  const bundlePatchText = readFileSync(join(root, bundlePatchRel), 'utf8')
  assert(!bundlePatchText.includes('/path/to/dsh-compaction-force/index.js'), 'bundle patch must not contain placeholder path')
  assert(/name:\s*(?:\.\/index\.js|"@local\/dsh-compaction-force"|@local\/dsh-compaction-force)\b/.test(bundlePatchText), 'bundle patch must resolve to packaged entry module')
  ok('package.json includes prepare, verification, and valid bundle patch')

  const missingOut = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), fixtureModule, '--out'], { encoding: 'utf8' })
  assert.notEqual(missingOut.status, 0, '--out without argument must exit non-zero')
  assert(!/TypeError/.test(missingOut.stderr), '--out without argument must fail cleanly without TypeError')
  ok('prepare-patch rejects --out without a path cleanly')

  const outFirst = join(fixture, 'out-first.patch.yml')
  const outFirstRun = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), '--out', outFirst, fixtureModule], { encoding: 'utf8' })
  assert.equal(outFirstRun.status, 0, outFirstRun.stderr)
  assert.equal(readFileSync(outFirst, 'utf8'), patch)

  const outEq = join(fixture, 'out-eq.patch.yml')
  const outEqRun = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), fixtureModule, `--out=${outEq}`], { encoding: 'utf8' })
  assert.equal(outEqRun.status, 0, outEqRun.stderr)
  assert.equal(readFileSync(outEq, 'utf8'), patch)

  const helpSecond = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), fixtureModule, '--help'], { encoding: 'utf8' })
  assert.equal(helpSecond.status, 0, helpSecond.stderr)
  assert(!helpSecond.stdout.includes('id: compaction-force'))

  const unknownFlag = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), fixtureModule, '--bogus-flag'], { encoding: 'utf8' })
  assert.notEqual(unknownFlag.status, 0, 'unknown flag must fail')

  const dashOut = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), fixtureModule, '--out', '-h'], { encoding: 'utf8', cwd: fixture })
  assert.notEqual(dashOut.status, 0, '--out -h must fail')
  assert(!existsSync(join(fixture, '-h')), '--out -h must not create a file named -h')

  const missingDirOut = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), fixtureModule, '--out', join(fixture, 'missing-dir', 'out.yml')], { encoding: 'utf8' })
  assert.notEqual(missingDirOut.status, 0)
  assert(!/at Object\.writeFileSync|node:fs:\d+/.test(missingDirOut.stderr), 'missing parent dir should fail without stacktrace')

  const dirOutTarget = join(fixture, 'out-dir')
  mkdirSync(dirOutTarget)
  const dirOutRun = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), fixtureModule, '--out', dirOutTarget], { encoding: 'utf8' })
  assert.notEqual(dirOutRun.status, 0)
  assert(!/at Object\.writeFileSync|node:fs:\d+/.test(dirOutRun.stderr), 'directory --out target should fail without stacktrace')

  const nlDir = join(fixture, 'dir\n  injected: oops\n#x')
  mkdirSync(nlDir, { recursive: true })
  const nlModule = join(nlDir, 'index.js')
  writeFileSync(nlModule, 'export const name = "compaction-force"\n')
  const nlRun = spawnSync(node, [join(root, 'scripts/prepare-patch.mjs'), nlModule], { encoding: 'utf8' })
  assert.equal(nlRun.status, 0, nlRun.stderr)
  assert(nlRun.stdout.includes(`name: ${JSON.stringify(nlModule)}`), 'newline path must be JSON-escaped inside YAML scalar')
  ok('prepare-patch handles flag ordering, = syntax, help, unknown flags, write errors, and newline paths')

  const missingProfile = spawnSync(node, [join(root, 'catalog-report.mjs'), '--profile'], { encoding: 'utf8' })
  assert.notEqual(missingProfile.status, 0, '--profile without argument must exit non-zero')
  assert(!/profile "undefined"/.test(missingProfile.stderr), '--profile without argument must fail before invoking dsh')
  ok('catalog-report rejects --profile without a name')

  const fakeRoot = join(fixture, 'dsh-root')
  mkdirSync(join(fakeRoot, '@deepseek-ai', 'dsh-web-app', 'presets'), { recursive: true })
  mkdirSync(join(fakeRoot, '.bin'), { recursive: true })
  mkdirSync(join(fakeRoot, 'node_modules', 'yaml'), { recursive: true })
  writeFileSync(join(fakeRoot, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml'), '- id: guarded\n')
  writeFileSync(join(fakeRoot, 'node_modules', 'yaml', 'index.js'), 'export default { parseDocument: () => ({ toJS: () => [] }) }\n')
  writeFileSync(join(fakeRoot, 'node_modules', 'yaml', 'package.json'), '{"name":"yaml","main":"./index.js"}\n')
  const stubDsh = join(fakeRoot, '.bin', 'dsh')
  writeFileSync(stubDsh, `#!/bin/sh
echo "stub-dsh-called:$*" >&2
exit 2
`)
  chmodSync(stubDsh, 0o755)
  const reportRun = spawnSync(node, [join(root, 'catalog-report.mjs'), '--profile', 'fake'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/usr/bin:/bin', DSH_INSTALL_ROOT: fakeRoot },
  })
  assert.notEqual(reportRun.status, 0)
  assert(reportRun.stderr.includes('stub-dsh-called:--profile fake --dump-config'), `expected resolved .bin/dsh stderr, got: ${reportRun.stderr}`)
  ok('catalog-report invokes resolved DSH_INSTALL_ROOT/.bin/dsh even when dsh is off PATH')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

console.log(`\n${passed} passed, 0 failed`)
console.log('LIMIT: no live profile, DSH server, or real bundle was mounted or changed.')
