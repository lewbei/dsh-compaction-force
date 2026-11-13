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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
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

  const runCatalogReport = (args, dshRoot = '') =>
    spawnSync(node, [join(root, 'catalog-report.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin', DSH_INSTALL_ROOT: dshRoot },
    })

  const createFakeDshRoot = (name, { yamlPkgDir, yamlPkgName = 'yaml', yamlCode, dshScript }) => {
    const dir = join(fixture, name)
    mkdirSync(join(dir, '@deepseek-ai', 'dsh-web-app', 'presets'), { recursive: true })
    mkdirSync(join(dir, '.bin'), { recursive: true })
    writeFileSync(join(dir, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml'), '- id: standard\n')
    if (yamlPkgDir && yamlCode) {
      const modDir = join(dir, yamlPkgDir)
      mkdirSync(modDir, { recursive: true })
      writeFileSync(join(modDir, 'index.js'), yamlCode)
      writeFileSync(join(modDir, 'package.json'), JSON.stringify({ name: yamlPkgName, main: './index.js' }) + '\n')
    }
    const stubDsh = join(dir, '.bin', 'dsh')
    writeFileSync(stubDsh, dshScript)
    chmodSync(stubDsh, 0o755)
    return dir
  }

  const missingProfile = runCatalogReport(['--profile'])
  assert.notEqual(missingProfile.status, 0, '--profile without argument must exit non-zero')
  assert(!/profile "undefined"/.test(missingProfile.stderr), '--profile without argument must fail before invoking dsh')
  ok('catalog-report rejects --profile without a name')

  const fakeRoot = createFakeDshRoot('dsh-root', {
    yamlPkgDir: join('node_modules', 'yaml'),
    yamlCode: 'export default { parseDocument: () => ({ toJS: () => [] }) }\n',
    dshScript: '#!/bin/sh\necho "stub-dsh-called:$*" >&2\nexit 2\n',
  })
  const reportRun = runCatalogReport(['--profile', 'fake'], fakeRoot)
  assert.notEqual(reportRun.status, 0)
  assert(reportRun.stderr.includes('stub-dsh-called:--profile fake --dump-config'), `expected resolved .bin/dsh stderr, got: ${reportRun.stderr}`)
  ok('catalog-report invokes resolved DSH_INSTALL_ROOT/.bin/dsh even when dsh is off PATH')

  const helpReport = runCatalogReport(['--help'])
  assert.equal(helpReport.status, 0, helpReport.stderr)
  assert(/Usage:/i.test(helpReport.stderr + helpReport.stdout))

  const noRootReport = runCatalogReport([])
  assert.notEqual(noRootReport.status, 0)
  assert(!/at installRoot/.test(noRootReport.stderr), 'missing DSH root must not emit raw stacktrace')

  const invalidRootReport = runCatalogReport([], join(fixture, 'does-not-exist'))
  assert.notEqual(invalidRootReport.status, 0)
  assert(invalidRootReport.stderr.includes('DSH_INSTALL_ROOT'))

  const nestedBogusSubdir = join(fakeRoot, 'nested-subdir', 'leaf')
  mkdirSync(nestedBogusSubdir, { recursive: true })
  for (const badRoot of [nestedBogusSubdir, '   ']) {
    const strictFail = runCatalogReport([], badRoot)
    assert.notEqual(strictFail.status, 0, `explicit DSH_INSTALL_ROOT=${JSON.stringify(badRoot)} must fail without ancestor fallback`)
    assert(strictFail.stderr.includes('DSH_INSTALL_ROOT'))
  }

  for (const badArgs of [
    ['--bogus'],
    ['--profile', '-x'],
    ['--profile='],
    ['--profile', 'a', '--profile', 'b'],
    ['--preset', '-x'],
    ['--preset='],
    ['--preset', 'a', '--preset', 'b'],
    ['extra-arg'],
  ]) {
    const badRun = runCatalogReport(badArgs, fakeRoot)
    assert.notEqual(badRun.status, 0, `${JSON.stringify(badArgs)} must fail`)
    assert(!badRun.stderr.includes('stub-dsh-called:'), `${JSON.stringify(badArgs)} must fail before calling dsh`)
  }
  ok('catalog-report CLI validates help, flags, values, and missing DSH root cleanly')

  const rowsPayload = [
    {
      id: 'preset-disabled',
      name: '@deepseek-ai/dsh-agent-preset',
      disabled: true,
      config: {
        id: 'offpreset',
        plugins: [{ id: 'compaction-force', config: { forceAtTokens: 888888, minContextWindow: 500000 } }],
      },
    },
    {
      id: 'preset-minimal',
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: 'minimal',
        plugins: [
          {
            id: 'compaction',
            group: true,
            isolate: { compaction: true },
            config: [
              { id: 'compaction-force', disabled: true, config: { forceAtTokens: 999999, minContextWindow: 500000 } },
            ],
          },
          {
            id: 'compaction-disabled-group',
            group: true,
            disabled: true,
            config: [{ id: 'compaction-force', config: { forceAtTokens: 777777, minContextWindow: 500000 } }],
          },
        ],
      },
    },
    {
      id: 'preset-standard',
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: 'standard',
        plugins: [
          {
            id: 'compaction',
            group: true,
            isolate: { compaction: true },
            config: [
              { id: 'compaction-force', config: { forceAtTokens: 262144, minContextWindow: 500000, note: 'handoff' } },
            ],
          },
        ],
      },
    },
    {
      id: 'nested-presets-group',
      group: true,
      config: [
        {
          id: 'preset-custom',
          name: '@deepseek-ai/dsh-agent-preset',
          config: {
            id: 'custom',
            plugins: [
              {
                id: 'compaction',
                group: true,
                config: [{ id: 'compaction-force', config: { forceAtTokens: 333333, minContextWindow: 500000, note: 'context' } }],
              },
            ],
          },
        },
      ],
    },
  ]
  const dynamicRoot = createFakeDshRoot('dsh-dynamic', {
    yamlPkgDir: join('@deepseek-ai', 'dsh-config-editor', 'node_modules', 'yaml'),
    yamlCode: 'export default { parseDocument: (s) => ({ toJS: () => JSON.parse(s) }) }\n',
    dshScript: `#!/bin/sh\necho '${JSON.stringify(rowsPayload)}'\n`,
  })

  const dynamicRun = runCatalogReport(['--profile=dev'], dynamicRoot)
  assert.equal(dynamicRun.status, 0, `expected dynamic preset report to succeed: ${dynamicRun.stderr}`)
  assert(dynamicRun.stdout.includes('Multiple active compaction-force scopes found; reporting Preset standard (others: Preset custom; pass --preset <id> to select)'))
  assert(dynamicRun.stdout.includes('Preset standard compaction-force: forceAtTokens=262144'))
  for (const forbidden of ['999999', '888888', '777777']) {
    assert(!dynamicRun.stdout.includes(forbidden), `disabled compaction-force row ${forbidden} must be skipped`)
  }

  const targetedPreset = runCatalogReport(['--profile', 'dev', '--preset', 'custom'], dynamicRoot)
  assert.equal(targetedPreset.status, 0, `expected --preset custom to succeed: ${targetedPreset.stderr}`)
  assert(targetedPreset.stdout.includes('Preset custom compaction-force: forceAtTokens=333333'))
  assert(!targetedPreset.stdout.includes('Multiple active compaction-force scopes found'))

  for (const target of ['minimal', 'offpreset']) {
    const disabledTarget = runCatalogReport(['--profile', 'dev', `--preset=${target}`], dynamicRoot)
    assert.notEqual(disabledTarget.status, 0, `disabled preset target ${target} must fail`)
  }

  const rootPayload = [
    { id: 'compaction-force', config: { forceAtTokens: 300000, minContextWindow: 500000, note: 'handoff' } },
  ]
  const jsYamlParent = join(fixture, 'parent-nm-root')
  const jsYamlNm = join(jsYamlParent, 'node_modules')
  mkdirSync(join(jsYamlNm, '@deepseek-ai', 'dsh-app-boot', 'node_modules', 'yaml'), { recursive: true })
  mkdirSync(join(jsYamlNm, '@deepseek-ai', 'dsh-app-boot', 'node_modules', 'js-yaml'), { recursive: true })
  mkdirSync(join(jsYamlNm, '.bin'), { recursive: true })
  writeFileSync(join(jsYamlNm, '@deepseek-ai', 'dsh-app-boot', 'package.json'), '{"name":"@deepseek-ai/dsh-app-boot"}\n')
  writeFileSync(join(jsYamlNm, '@deepseek-ai', 'dsh-app-boot', 'node_modules', 'yaml', 'package.json'), '{"name":"yaml","main":"./index.js"}\n')
  writeFileSync(join(jsYamlNm, '@deepseek-ai', 'dsh-app-boot', 'node_modules', 'yaml', 'index.js'), 'export default {}\n')
  writeFileSync(join(jsYamlNm, '@deepseek-ai', 'dsh-app-boot', 'node_modules', 'js-yaml', 'package.json'), '{"name":"js-yaml","main":"./index.js"}\n')
  writeFileSync(
    join(jsYamlNm, '@deepseek-ai', 'dsh-app-boot', 'node_modules', 'js-yaml', 'index.js'),
    `
class Type { constructor(tag, opts) { this.tag = tag; this.opts = opts } }
const DEFAULT_SCHEMA = { extend(tags) { return { tags } } }
function load(s, opts) {
  const tags = opts?.schema?.tags?.map((t) => t.tag) ?? []
  for (const req of ['tag:yaml.org,2002:js', 'tag:yaml.org,2002:js/undefined', 'tag:yaml.org,2002:js/regexp', 'tag:yaml.org,2002:js/function']) {
    if (!tags.includes(req)) throw new Error('missing ' + req)
  }
  return JSON.parse(s)
}
export default { Type, DEFAULT_SCHEMA, load }
`,
  )
  writeFileSync(join(jsYamlNm, '.bin', 'dsh'), `#!/bin/sh\necho '${JSON.stringify(rootPayload)}'\n`)
  chmodSync(join(jsYamlNm, '.bin', 'dsh'), 0o755)

  const jsYamlRun = runCatalogReport(['--profile', 'headless'], jsYamlParent)
  assert.equal(jsYamlRun.status, 0, `expected js-yaml + nestedNm + root scope report to succeed: ${jsYamlRun.stderr}`)
  assert(jsYamlRun.stdout.includes('Profile root compaction-force: forceAtTokens=300000'))

  const pnpmRoot = join(fixture, 'pnpm-root')
  const pnpmStoreMod = join(pnpmRoot, '.pnpm', 'dsh-pkg', 'node_modules')
  mkdirSync(join(pnpmStoreMod, '@deepseek-ai', 'dsh'), { recursive: true })
  mkdirSync(join(pnpmStoreMod, 'yaml'), { recursive: true })
  mkdirSync(join(pnpmRoot, '@deepseek-ai'), { recursive: true })
  mkdirSync(join(pnpmRoot, '.bin'), { recursive: true })
  writeFileSync(join(pnpmStoreMod, '@deepseek-ai', 'dsh', 'package.json'), '{"name":"@deepseek-ai/dsh"}\n')
  writeFileSync(join(pnpmStoreMod, 'yaml', 'package.json'), '{"name":"yaml","main":"./index.js"}\n')
  writeFileSync(join(pnpmStoreMod, 'yaml', 'index.js'), 'export default { parseDocument: (s) => ({ toJS: () => JSON.parse(s) }) }\n')
  symlinkSync(join(pnpmStoreMod, '@deepseek-ai', 'dsh'), join(pnpmRoot, '@deepseek-ai', 'dsh'))
  writeFileSync(join(pnpmRoot, '.bin', 'dsh'), `#!/bin/sh\necho '${JSON.stringify(rootPayload)}'\n`)
  chmodSync(join(pnpmRoot, '.bin', 'dsh'), 0o755)
  const pnpmRun = runCatalogReport([], pnpmRoot)
  assert.equal(pnpmRun.status, 0, `expected symlinked pnpm store root to succeed: ${pnpmRun.stderr}`)
  assert(pnpmRun.stdout.includes('Profile root compaction-force: forceAtTokens=300000'))

  rmSync(join(dynamicRoot, '@deepseek-ai', 'dsh-config-editor'), { recursive: true, force: true })
  const missingYamlRun = runCatalogReport([], dynamicRoot)
  assert.notEqual(missingYamlRun.status, 0)
  assert(!/Cannot find module|node:internal\/modules/.test(missingYamlRun.stderr), 'missing yaml must fail cleanly without stacktrace')
  ok('catalog-report discovers non-guarded presets and root scopes dynamically, skips disabled rows, and handles non-hoisted yaml/js-yaml')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

console.log(`\n${passed} passed, 0 failed`)
console.log('LIMIT: no live profile, DSH server, or real bundle was mounted or changed.')
