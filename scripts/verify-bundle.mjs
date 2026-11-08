#!/usr/bin/env node
// verify-bundle — zero-dependency static + unit self-check for this bundle.
// Mirrors the verify-provider.mjs pattern from dsh-win-env-kit.
// Run: node scripts/verify-bundle.mjs
//
// Checks:
//   1. package.json / dsh.plugin.json / cordis.patch.yml / locale / icon / SKILL.md / docs exist + parse
//   2. Host provider loads with a stub ctx.skills.registerProvider; list/get/resourceBase work
//   3. Config (real host schemastery) resolves defaults and all three backends
//   4. buildSkillContent reflects the active backend (settings-page switch)
//   5. memory engine round-trip: capture -> derive -> recall hit -> export jsonl
//   6. backends: cloudPlan for all three; callLocal success (ephemeral server) + degraded (dead port)

import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const checks = []
function ok(label, cond, detail) {
  checks.push({ label, pass: Boolean(cond), detail })
  if (!cond) failures.push(`${label}${detail ? ': ' + detail : ''}`)
}
function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')) }
function jimport(p) { return import(pathToFileURL(p).href) }

// --- 1. static consistency -------------------------------------------------
const pkg = readJson(join(ROOT, 'package.json'))
const manifest = readJson(join(ROOT, 'dsh.plugin.json'))
ok('package.json dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
ok('package.json exports', typeof pkg.exports === 'object' && Boolean(pkg.exports?.['.']))
ok('manifest id matches package', manifest.id === pkg.name, manifest.id)
ok('manifest contributes skill', manifest.contributes?.skills?.includes('parent-child-agent'))
for (const rel of [
  'cordis.patch.yml', 'dsh.plugin.json', 'icon.svg', 'locale/en.json', 'locale/zh.json',
  'lib/index.js', 'lib/host-schema.mjs', 'lib/config.mjs', 'lib/skill-content.mjs',
  'lib/memory.mjs', 'lib/backends.mjs', 'scripts/pca.mjs',
  'skills/parent-child-agent/SKILL.md', 'docs/STAGE0-SEAM.md', 'README.md', 'LICENSE',
]) {
  ok(`file exists ${rel}`, existsSync(join(ROOT, rel)))
}
for (const rel of ['locale/en.json', 'locale/zh.json', 'dsh.plugin.json']) {
  try { readJson(join(ROOT, rel)); ok(`${rel} valid JSON`, true) }
  catch (e) { ok(`${rel} valid JSON`, false, String(e.message)) }
}
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
ok('cordis.patch.yml has insert', /- insert:/.test(patch))
ok('cordis.patch.yml sets childBackend', /childBackend:/.test(patch))
const skillMd = readFileSync(join(ROOT, 'skills/parent-child-agent/SKILL.md'), 'utf8')
ok('SKILL.md frontmatter', skillMd.startsWith('---'))
ok('SKILL.md playbook body', /# Parent \/ Child Agent playbook/.test(skillMd))

// --- 2. provider loads with stub ctx --------------------------------------
const mod = await jimport(join(ROOT, 'lib/index.js'))
ok('module exports name', mod.name === 'dsh-parent-child-agent')
ok('module exports inject', Array.isArray(mod.inject) && mod.inject.includes('skills'))
ok('module exports apply', typeof mod.apply === 'function')
ok('module exports Config', Boolean(mod.Config), 'Config is undefined -> host schemastery not found')

function startProvider(config) {
  let provider
  const ctx = { skills: { registerProvider(factory) { provider = factory({}); return () => {} } } }
  const dispose = mod.apply(ctx, config)
  return { provider, dispose }
}

function cfg(overrides) {
  return {
    childBackend: 'same-cloud',
    otherCloud: { provider: 'workbuddy', model: 'hy4std' },
    local: { baseUrl: 'http://127.0.0.1:11434/v1', model: '', apiKey: '', timeoutMs: 30000, temperature: 0.3, maxTokens: 2048 },
    fallbackBackend: 'same-cloud',
    memory: { enabled: true, dataDir: '', injectTopK: 5, maxHabits: 200, captureTraces: true, traceRetention: 5000, minConfidence: 0.6 },
    dispatch: { maxDepth: 2, parallel: 2 },
    ...overrides,
  }
}

{
  const { provider, dispose } = startProvider(cfg())
  ok('provider.list returns candidates', typeof provider.list === 'function')
  const list = await provider.list({})
  ok('provider.list has 1 skill', Array.isArray(list) && list.length === 1, `got ${list?.length}`)
  const cand = list?.[0]
  ok('candidate resourceBase directory', cand?.locator && existsSync(cand.locator))
  const got = await provider.get(cand, {})
  ok('get.resourceBase.kind', got.resourceBase?.kind === 'directory', got.resourceBase?.kind)
  ok('get.content has config header', /runtime configuration/.test(got.content))
  ok('get.content has playbook', /# Parent \/ Child Agent playbook/.test(got.content))
  ok('get.content has same-cloud hint', /same-cloud/.test(got.content))
  ok('get.content has PCA_CONFIG', /PCA_CONFIG=/.test(got.content))
  ok('dispose is function', typeof dispose === 'function')
  dispose()
}

// --- 3. Config schema (real host schemastery) ------------------------------
const hostSchema = await jimport(join(ROOT, 'lib/host-schema.mjs'))
const z = await hostSchema.loadHostSchemastery()
if (z) {
  const { defineConfig } = await jimport(join(ROOT, 'lib/config.mjs'))
  const built = defineConfig(z)
  // A schemastery object schema is itself callable: built(input) === Schema.resolve(input, built, {})[0]
  const resolve = (input) => built(input)
  const d = resolve({})
  ok('Config default childBackend', d.childBackend === 'same-cloud', d.childBackend)
  ok('Config default otherCloud.model', d.otherCloud?.model === 'hy4std', d.otherCloud?.model)
  ok('Config default local.timeoutMs', d.local?.timeoutMs === 30000, String(d.local?.timeoutMs))
  ok('Config default memory.injectTopK', d.memory?.injectTopK === 5, String(d.memory?.injectTopK))
  for (const b of ['same-cloud', 'other-cloud', 'local']) {
    const r = resolve({ childBackend: b })
    ok(`Config accepts ${b}`, r.childBackend === b, r.childBackend)
  }
  ok('Config rejects bad backend', (() => {
    try { const r = resolve({ childBackend: 'nope' }); return r.childBackend !== 'nope' }
    catch { return true }
  })())
} else {
  ok('host schemastery reachable', false, 'loadHostSchemastery() returned undefined')
}

// --- 4. settings-page switch reflected in injected content -----------------
{
  const { buildSkillContent } = await jimport(join(ROOT, 'lib/skill-content.mjs'))
  const body = 'PLAYBOOK_BODY'
  const a = buildSkillContent(body, cfg({ childBackend: 'other-cloud' }))
  const b = buildSkillContent(body, cfg({ childBackend: 'local' }))
  ok('other-cloud content mentions subagent', /native `subagent`/.test(a))
  ok('local content mentions dispatch', /bundled `dispatch`/.test(b))
  ok('other-cloud != local content', a !== b)
  ok('body preserved', a.includes('PLAYBOOK_BODY') && b.includes('PLAYBOOK_BODY'))
}

// --- 5. memory engine round-trip -------------------------------------------
const mem = await jimport(join(ROOT, 'lib/memory.mjs'))
{
  const dir = join(tmpdir(), 'pca-verify-' + Date.now())
  mkdirSync(dir, { recursive: true })
  const config = cfg()
  config.memory.dataDir = dir
  let state = mem.loadMemory(dir)
  ok('loadMemory empty', state.habits.length === 0 && state.traces.length === 0)
  mem.captureTrace(state, { task: 'format report', context: { 'habit:no-color': 'true', lang: 'zh' }, action: 'sent prompt', outcome: 'ok', backend: 'local', success: true }, config)
  mem.captureTrace(state, { task: 'format report', context: { 'habit:no-color': 'true', lang: 'zh' }, action: 'sent prompt 2', outcome: 'ok', backend: 'local', success: true }, config)
  mem.derive(state, config)
  ok('derive produced habit', state.habits.length >= 1, `${state.habits.length}`)
  ok('derive produced playbook', state.playbook.length >= 1, `${state.playbook.length}`)
  const saved = mem.saveMemory(dir, state)
  ok('saveMemory ok', saved.ok, saved.warning)
  const reloaded = mem.loadMemory(dir)
  ok('reload keeps traces', reloaded.traces.length === 2, `${reloaded.traces.length}`)
  const r = mem.recall(reloaded, 'format report', { lang: 'zh' }, config)
  ok('recall returns text', typeof r.text === 'string' && r.text.length > 0)
  ok('recall has habits section', /Recalled user habits/.test(r.text))
  const jsonl = mem.exportJsonl(reloaded, 'traces')
  ok('exportJsonl lines', jsonl.split('\n').filter(Boolean).length === 2)
  ok('exportJsonl task field', jsonl.includes('format report'))
  const up = mem.upsertHabit(reloaded, { key: 'explicit', category: 'style', description: 'explicit habit' }, config)
  ok('upsertHabit', reloaded.habits.some((h) => h.key === 'explicit'))
  ok('review confirm works', (() => {
    const low = reloaded.habits.find((h) => !h.autoApply)
    if (!low) return true
    return Boolean(mem.confirmHabit(reloaded, low.id))
  })())
  rmSync(dir, { recursive: true, force: true })
}

// --- 6. backends: cloudPlan + callLocal success/degraded -------------------
const back = await jimport(join(ROOT, 'lib/backends.mjs'))
{
  ok('cloudPlan same-cloud', back.cloudPlan('same-cloud', cfg(), 'P').tool === 'subagent_fork')
  ok('cloudPlan other-cloud', (() => { const p = back.cloudPlan('other-cloud', cfg(), 'P'); return p.tool === 'subagent' && p.params.model === 'hy4std' })())
  ok('cloudPlan local is not cloud tool', back.cloudPlan('local', cfg(), 'P').tool === 'subagent_fork')
}

async function withServer(handler) {
  const server = createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(r)) }
}

{
  const s = await withServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url.endsWith('/models')) {
        res.end(JSON.stringify({ data: [{ id: 'test-model' }] }))
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: 'CHILD_OK' } }], usage: { total_tokens: 42 } }))
      }
    })
  })
  const c = cfg({ childBackend: 'local' })
  c.local.baseUrl = s.baseUrl
  c.local.timeoutMs = 5000
  const r = await back.callLocal(c, 'do it')
  ok('callLocal success', r.ok === true, r.error)
  ok('callLocal text', r.text === 'CHILD_OK', r.text)
  ok('callLocal model resolved', r.model === 'test-model', r.model)
  ok('callLocal tokens', r.tokens === 42, String(r.tokens))
  await s.close()
}

{
  const c = cfg({ childBackend: 'local' })
  // Port 1 on loopback is almost certainly closed; 1500ms bound keeps it quick.
  c.local.baseUrl = 'http://127.0.0.1:1/v1'
  c.local.timeoutMs = 1500
  c.local.model = 'x'
  const r = await back.callLocal(c, 'do it')
  ok('callLocal degraded on dead port', r.ok === false, r.error)
  ok('callLocal returns error (no throw)', typeof r.error === 'string' && r.error.length > 0)
}

// --- report ----------------------------------------------------------------
const passed = checks.filter((c) => c.pass).length
for (const c of checks) {
  process.stdout.write(`${c.pass ? 'PASS' : 'FAIL'}  ${c.label}${c.detail && !c.pass ? ' — ' + c.detail : ''}\n`)
}
process.stdout.write(`\n${passed}/${checks.length} checks passed\n`)
if (failures.length) {
  process.stdout.write(`FAILURES:\n- ${failures.join('\n- ')}\n`)
  process.exitCode = 1
}
