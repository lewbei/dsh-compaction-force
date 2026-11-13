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

  const fidelityPayload = [
    { id: 'custom-ds-key', name: '@deepseek-ai/dsh-llm-deepseek-api-key', disabled: true, config: {} },
    { id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account', config: { maxTokens: 64000, modelOverrides: { 'deepseek-flash': { contextWindow: 1200000 } } } },
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          anthropic: {
            apiKeyEnv: 'DUMMY',
            modelOverrides: { 'claude-opus-4-6': { maxTokens: 64000 } },
          },
          'opencode-go': {
            apiKeyEnv: 'DUMMY',
          },
          'custom-explicit': {
            api: 'openai-completions',
            baseURL: 'https://example.invalid/v1',
            apiKeyEnv: 'DUMMY',
            models: [
              { id: 'big-reserve-model', contextWindow: 600000, maxTokens: 550000 },
              { id: 'headroom-affected-model', contextWindow: 600000, maxTokens: 256000 },
              { id: 'tight-existing-model', contextWindow: 1000000, maxTokens: 64000 },
              { id: 'unconfigured-cap-model', contextWindow: 1000000 },
              { id: 'zero-mt-invalid', contextWindow: 600000, maxTokens: 0 },
              { id: 'retain-exceeds-threshold', contextWindow: 1000000, maxTokens: 64000 },
            ],
          },
          'deepseek-official': {
            api: 'openai-completions',
            baseURL: 'https://example.invalid/v1',
            apiKeyEnv: 'DUMMY',
            models: [
              { id: 'deepseek-flash', contextWindow: 2000000, maxTokens: 64000 },
            ],
          },
        },
      },
    },
    {
      id: 'preset-guarded',
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: 'guarded',
        plugins: [
          {
            id: 'compaction',
            group: true,
            isolate: { compaction: true },
            config: [
              {
                id: 'compaction-basic',
                name: '@deepseek-ai/dsh-compaction-basic',
                config: {
                  headroomTokens: 131072,
                  retainRatio: 0.2,
                  modelPolicies: [
                    { provider: 'custom-explicit', model: 'tight-existing-model', thresholdRatio: 0.2 },
                    { provider: 'opencode-go', model: 'minimax-m3.1-flash', headroomTokens: 450000 },
                    { provider: 'custom-explicit', model: 'retain-exceeds-threshold', retainTokens: 300000 },
                  ],
                },
              },
              {
                id: 'compaction-force',
                config: {
                  forceAtTokens: '262144',
                  minContextWindow: '500000',
                  note: 'handoff',
                },
              },
            ],
          },
        ],
      },
    },
  ]
  const fidelityRoot = createFakeDshRoot('dsh-fidelity', {
    yamlPkgDir: join('node_modules', 'yaml'),
    yamlCode: 'export default { parseDocument: (s) => ({ toJS: () => JSON.parse(s) }) }\n',
    dshScript: `#!/bin/sh\necho '${JSON.stringify(fidelityPayload)}'\n`,
  })
  const fakePiAiDir = join(fidelityRoot, '@deepseek-ai', 'dsh-llm-pi-ai', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers')
  mkdirSync(fakePiAiDir, { recursive: true })
  mkdirSync(join(fidelityRoot, '@deepseek-ai', 'dsh-llm-pi-ai'), { recursive: true })
  writeFileSync(join(fidelityRoot, '@deepseek-ai', 'dsh-llm-pi-ai', 'package.json'), '{"name":"@deepseek-ai/dsh-llm-pi-ai"}\n')
  writeFileSync(
    join(fakePiAiDir, 'all.js'),
    `export function getBuiltinModels(p) {
      if (p === "anthropic") return [{ id: "claude-opus-4-6", contextWindow: 1000000, maxTokens: 128000 }]
      if (p === "opencode-go") return [{ id: "minimax-m3.1-flash", contextWindow: 1000000, maxTokens: 512000 }]
      return []
    }\n`,
  )

  const fidelityRun = runCatalogReport(['--profile', 'dev'], fidelityRoot)
  assert.equal(fidelityRun.status, 0, fidelityRun.stderr)
  assert(/anthropic\/claude-opus-4-6\s+1000000\s+64000\s+0\.262144\s+262144/.test(fidelityRun.stdout), 'builtin pi-ai model with modelOverrides must reserve overridden 64000 maxTokens')
  assert(/opencode-go\/minimax-m3\.1-flash\s+1000000\s+0\s+0\.262144\s+262144/.test(fidelityRun.stdout), 'un-overridden builtin pi-ai model must reserve 0 (not builtin maxTokens)')
  assert(/custom-explicit\/unconfigured-cap-model\s+1000000\s+0\s+0\.262144\s+262144/.test(fidelityRun.stdout), 'pi-ai route model omitting maxTokens must reserve 0')
  assert(!fidelityRun.stdout.includes('zero-mt-invalid'), 'pi-ai model with maxTokens <= 0 must be excluded')
  assert(fidelityRun.stdout.includes('custom-explicit/headroom-affected-model') && fidelityRun.stdout.includes('212928'), 'sibling headroomTokens=131072 must cap threshold to 212928')
  assert(!fidelityRun.stdout.includes('-81072'), 'negative pressureBudget must not be rendered as negative threshold')
  assert(fidelityRun.stdout.includes('custom-explicit/big-reserve-model') && /no pressure budget/i.test(fidelityRun.stdout), 'zero/negative pressureBudget must report no pressure budget')
  assert(fidelityRun.stdout.includes('custom-explicit/retain-exceeds-threshold') && /retain .* >= threshold|no pressure budget/i.test(fidelityRun.stdout), 'retainTokens >= threshold must report unusable budget')
  assert(/forced at 262144: [1-9]/.test(fidelityRun.stdout), 'string forceAtTokens must match integer thresholds')
  assert(fidelityRun.stdout.includes('deepseek-account/deepseek-flash') && fidelityRun.stdout.includes('1200000'), 'enabled llm-deepseek-account must emit deepseek-account models with modelOverrides')
  assert(fidelityRun.stdout.includes('deepseek-official/deepseek-flash') && !fidelityRun.stdout.includes('deepseek-official/deepseek-v4-pro'), 'disabled custom dsh-llm-deepseek-api-key must not seed deepseek-v4-pro while preserving explicit pi-ai route')
  assert(fidelityRun.stdout.includes('custom-explicit/tight-existing-model') && /skipped/i.test(fidelityRun.stdout), 'tighter pre-existing threshold must stay skipped and visible')

  const dedupPayload = [
    { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { maxTokens: 64000, models: [{ id: 'deepseek-flash', contextWindow: 1048576 }] } },
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          'deepseek-official': {
            models: [
              { id: 'deepseek-flash', contextWindow: 2000000, maxTokens: 64000 },
              { id: 'high-ratio-skip', contextWindow: 550000, maxTokens: 32000 },
              { id: 'isolate-check', contextWindow: 600000, maxTokens: 100000 },
            ],
          },
        },
      },
    },
    { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { headroomTokens: 200000 } },
    {
      id: 'isolated-group',
      group: true,
      isolate: { compaction: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { thresholdRatio: 0 } },
        { id: 'compaction-force', config: { forceAtTokens: 450000, minContextWindow: 500000 } },
      ],
    },
  ]
  const dedupRoot = createFakeDshRoot('dsh-dedup', {
    yamlPkgDir: join('node_modules', 'yaml'),
    yamlCode: 'export default { parseDocument: (s) => ({ toJS: () => JSON.parse(s) }) }\n',
    dshScript: `#!/bin/sh\necho '${JSON.stringify(dedupPayload)}'\n`,
  })
  const dedupRun = runCatalogReport([], dedupRoot)
  assert.equal(dedupRun.status, 0, dedupRun.stderr)
  assert.equal(dedupRun.stdout.match(/deepseek-official\/deepseek-flash/g)?.length ?? 0, 1, 'duplicate provider/model must appear once with overridden contextWindow')
  assert(!dedupRun.stdout.includes('deepseek-v4-pro'), 'custom llm-deepseek models list must not inject default deepseek-v4-pro')
  assert(dedupRun.stdout.includes('2000000'))
  assert(dedupRun.stdout.includes('434464') && dedupRun.stdout.includes('headroom 65536'), 'isolate.compaction=true must block parent compaction-basic headroomTokens')
  assert(dedupRun.stdout.includes('deepseek-official/high-ratio-skip') && /ratio 0\.818182 >= 0\.8 \(effective ratio 0\.8\)/.test(dedupRun.stdout), 'invalid thresholdRatio <= 0 must fall back to 0.8 in skip diagnostics')

  const priorOverridePayload = [
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          'custom-explicit': {
            models: [
              { id: 'prior-over-tight-basic', contextWindow: 550000, maxTokens: 32000 },
              { id: 'tight-basic-skip', contextWindow: 550000, maxTokens: 32000 },
            ],
          },
        },
      },
    },
    {
      id: 'compaction-basic',
      name: '@deepseek-ai/dsh-compaction-basic',
      config: {
        thresholdRatio: 0.5,
        modelPolicies: [{ provider: 'custom-explicit', model: 'prior-over-tight-basic', thresholdRatio: 0.9 }],
      },
    },
    { id: 'compaction-force', config: { forceAtTokens: 450000, minContextWindow: 500000 } },
  ]
  const priorOverrideRoot = createFakeDshRoot('dsh-prior-override', {
    yamlPkgDir: join('node_modules', 'yaml'),
    yamlCode: 'export default { parseDocument: (s) => ({ toJS: () => JSON.parse(s) }) }\n',
    dshScript: `#!/bin/sh\necho '${JSON.stringify(priorOverridePayload)}'\n`,
  })
  const priorOverrideRun = runCatalogReport([], priorOverrideRoot)
  assert.equal(priorOverrideRun.status, 0, priorOverrideRun.stderr)
  assert(/prior-over-tight-basic: window 550000 -> ratio 0\.818182 >= 0\.8 \(effective ratio 0\.9\)/.test(priorOverrideRun.stdout), 'valid prior thresholdRatio must override tighter service thresholdRatio in skip diagnostics')
  assert(/tight-basic-skip: window 550000 -> compaction-basic thresholdRatio=0\.5 already tighter \(effective ratio 0\.5\)/.test(priorOverrideRun.stdout), 'model without prior thresholdRatio must cite compaction-basic thresholdRatio')
  ok('catalog-report mirrors BasicCompactionEngine headroom, budget checks, option coercion, pi-ai builtins, and dedup')

  const runBench = (args) =>
    spawnSync(node, [join(root, 'benchmarks/compint-run/retention-bench.mjs'), ...args], {
      encoding: 'utf8',
    })

  for (const helpFlag of ['--help', '-h']) {
    const helpRun = runBench([helpFlag])
    assert.equal(helpRun.status, 0, helpRun.stderr)
    assert(/Usage:/i.test(helpRun.stdout + helpRun.stderr), `${helpFlag} must print usage`)
    assert(!helpRun.stdout.includes('| Arm |'), `${helpFlag} must not execute benchmark`)
  }

  const eqRun = runBench(['--instances=2', '--arms=handoff', '--constraints=4', '--generations=2', '--seeds=101'])
  assert.equal(eqRun.status, 0, eqRun.stderr)
  assert(eqRun.stdout.includes('seeds=101 instances/seed=2 constraints/scenario=4 generations=2 arms=handoff'), eqRun.stdout)
  assert(eqRun.stdout.includes('| handoff | 100 % | 100 % | 8/8 |'), eqRun.stdout)

  const zeroSeedRun = runBench(['--seeds', '0', '--instances', '1', '--arms', 'handoff'])
  assert.equal(zeroSeedRun.status, 0, zeroSeedRun.stderr)
  assert(zeroSeedRun.stdout.includes('seeds=0 instances/seed=1'), zeroSeedRun.stdout)

  for (const fullArgs of [
    ['--full', '--instances', '2', '--arms', 'handoff'],
    ['--instances', '2', '--arms', 'handoff', '--full'],
  ]) {
    const fullOverrideRun = runBench(fullArgs)
    assert.equal(fullOverrideRun.status, 0, fullOverrideRun.stderr)
    assert(fullOverrideRun.stdout.includes('seeds=101,202,303 instances/seed=2 constraints/scenario=8 generations=3 arms=handoff'), fullOverrideRun.stdout)
    assert(fullOverrideRun.stdout.includes('48/48'), fullOverrideRun.stdout)
  }

  const oneGenRun = runBench(['--generations', '1', '--instances', '2', '--arms', 'handoff'])
  assert.equal(oneGenRun.status, 0, oneGenRun.stderr)
  assert(oneGenRun.stdout.includes('12/12'), oneGenRun.stdout)
  assert(!oneGenRun.stdout.includes('NaN'), oneGenRun.stdout)

  const invalidBenchCases = [
    ['--unknown-flag'],
    ['unexpected-positional'],
    ['--arms'],
    ['--seeds'],
    ['--instances'],
    ['--arms', '--instances'],
    ['--arms', 'bogus'],
    ['--arms', ''],
    ['--arms', 'handoff,'],
    ['--arms', 'handoff,handoff'],
    ['--seeds', ''],
    ['--seeds', '101,,202'],
    ['--seeds', 'abc'],
    ['--seeds', '101,101'],
    ['--instances', '0'],
    ['--instances', '1.5'],
    ['--constraints', '0'],
    ['--constraints', '-1'],
    ['--constraints', '20'],
    ['--generations', '0'],
    ['--instances', '1', '--instances', '2'],
    ['--full=1'],
    ['--full', '--full'],
  ]
  for (const badArgs of invalidBenchCases) {
    const badRun = runBench(badArgs)
    assert.notEqual(badRun.status, 0, `expected non-zero exit for ${JSON.stringify(badArgs)}`)
    assert(!/TypeError/.test(badRun.stderr), `unexpected TypeError for ${JSON.stringify(badArgs)}: ${badRun.stderr}`)
  }
  ok('retention-bench validates CLI options, equals syntax, --full overrides, help, and error exits cleanly')

  const indexSrc = readFileSync(join(root, 'index.js'), 'utf8')
  const readyDoc = readFileSync(join(root, 'READY'), 'utf8')
  const resultsDoc = readFileSync(join(root, 'benchmarks/compint-run/RESULTS.md'), 'utf8')
  const resultsFullDoc = readFileSync(join(root, 'benchmarks/compint-run/RESULTS-full.md'), 'utf8')
  for (const [docName, text] of [
    ['index.js', indexSrc],
    ['README.md', readme],
    ['READY', readyDoc],
    ['cordis.patch.yml', template],
  ]) {
    assert(!/\bGuarded\b/.test(text), `${docName} must not reference nonexistent Guarded preset`)
  }
  assert(/\bstandard\b.*\bptc\b.*\bminimal\b.*\bcordis\b/i.test(readme), 'README must document real stock DSH presets')
  assert(/75 assertions|75 passed|75\/75/.test(readme) && /14\s+real-Cordis|14\/14/.test(readme), 'README must state updated verifier counts')
  assert(/75\/75/.test(readyDoc) && /14\/14/.test(readyDoc), 'READY must state updated verifier counts')
  assert(!/at repo head after PR #8|at repo `3a171b0`/.test(resultsDoc + '\n' + resultsFullDoc), 'benchmark RESULTS must carry updated post-fix provenance rather than stale PR #8 / 3a171b0 claims')
  ok('documentation accurately reflects real DSH presets, updated suite counts, and fresh benchmark provenance')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

console.log(`\n${passed} passed, 0 failed`)
console.log('LIMIT: no live profile, DSH server, or real bundle was mounted or changed.')
