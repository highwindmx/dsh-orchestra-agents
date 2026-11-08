#!/usr/bin/env node
// pca — Parent / Child Agent CLI (zero dependencies).
//
// The parent agent calls this from its shell tool using an ABSOLUTE path built
// from the skill's reported base directory (resourceBase). See SKILL.md.
//
// Commands:
//   recall        --task <text> [--context <json>]     -> recall memory text + prompt
//   dispatch      --task <text> [--context <json>]     -> plan (cloud) or execute (local)
//   capture       --task <text> --action <text> --outcome <text> [--...]
//   summarize     [--habit <json> ...]                 -> derive + optionally upsert habits
//   review        [--confirm <id>] [--list]            -> confirm low-confidence habits
//   export        [--kind traces|habits|playbook] [--out <file>]
//   status                                            -> memory summary
//
// Global: --config <json> --data-dir <dir> --json
//
// Windows/GBK note: all output is written as UTF-8 (process.stdout) and all
// files use UTF-8 + LF. No BOM, no ANSI code page assumptions.

import { writeFileSync } from 'node:fs'
import { resolveConfig, DEFAULTS } from '../lib/config.mjs'
import {
  loadMemory, saveMemory, preferredDataDir, recall, captureTrace, derive,
  upsertHabit, confirmHabit, exportJsonl, summary,
} from '../lib/memory.mjs'
import { buildChildPrompt, cloudPlan, callLocal } from '../lib/backends.mjs'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        out[key] = true
      } else {
        out[key] = next
        i += 1
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

function jsonParse(value, fallback) {
  if (value === undefined || value === true) return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function loadConfig(args) {
  const raw = jsonParse(args.config, {})
  return resolveConfig({ ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) })
}

function dataDir(args, config) {
  return args['data-dir'] || preferredDataDir(config)
}

function output(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  process.stdout.write(text + '\n')
}

function fail(message) {
  output({ ok: false, error: message })
  process.exitCode = 2
}

function normalizeCtx(args) {
  return jsonParse(args.context, args.context && typeof args.context === 'string' ? args.context : {})
}

function usage() {
  return `pca — parent/child agent CLI

Commands:
  recall      --task <text> [--context <json>]
  dispatch    --task <text> [--context <json>]
  capture     --task <text> --action <text> --outcome <text>
              [--backend <name>] [--success <true|false>] [--tokens <n>]
              [--latency-ms <n>] [--notes <text>]
  summarize   [--habit <json> ...]
  review      --confirm <id> | --list
  export      [--kind traces|habits|playbook] [--out <file>]
  status

Global: --config <json>  --data-dir <dir>  --json`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  if (!command || command === 'help') { output(usage()); return }
  const config = loadConfig(args)
  const dir = dataDir(args, config)
  const state = loadMemory(dir)

  if (command === 'status') {
    output({ ok: true, ...summary(state), dataDir: dir, config })
    return
  }

  if (command === 'recall') {
    const task = String(args.task || '')
    const context = normalizeCtx(args)
    const r = recall(state, task, context, config)
    output({
      ok: true,
      recalled: r,
      prompt: buildChildPrompt(r.text, task, context),
      childBackend: config.childBackend,
    })
    return
  }

  if (command === 'dispatch') {
    const task = String(args.task || '')
    if (!task) { fail('dispatch requires --task'); return }
    const context = normalizeCtx(args)
    const r = recall(state, task, context, config)
    const prompt = buildChildPrompt(r.text, task, context)
    const backend = args.backend && ['same-cloud', 'other-cloud', 'local'].includes(args.backend)
      ? args.backend : config.childBackend

    if (backend === 'local') {
      const result = await callLocal(config, prompt)
      if (result.ok) {
        output({
          ok: true, backend, executed: true, model: result.model,
          text: result.text, tokens: result.tokens, latencyMs: result.latencyMs,
          recall: r, fallbackBackend: config.fallbackBackend,
          hint: 'Record this outcome with the capture command.',
        })
      } else {
        const fb = config.fallbackBackend === 'local' ? 'same-cloud' : config.fallbackBackend
        const plan = cloudPlan(fb, config, prompt)
        output({
          ok: true, backend, executed: false, degraded: true,
          error: result.error, latencyMs: result.latencyMs,
          fallbackBackend: fb, fallbackPlan: plan,
          recall: r,
          hint: `Local backend failed; re-dispatch with ${fb} (${plan.tool}) and pass --backend ${fb} to capture.`,
        })
      }
      return
    }

    const plan = cloudPlan(backend, config, prompt)
    output({
      ok: true, backend, executed: false, plan, recall: r,
      hint: `Run this with the native ${plan.tool} tool, then call capture with the outcome.`,
    })
    return
  }

  if (command === 'capture') {
    const task = String(args.task || '')
    const action = String(args.action || '')
    const outcome = String(args.outcome || '')
    if (!task || !action || !outcome) { fail('capture requires --task --action --outcome'); return }
    const entry = captureTrace(state, {
      task, action, outcome,
      context: normalizeCtx(args),
      backend: args.backend || config.childBackend,
      success: args.success === undefined ? true : args.success !== 'false',
      tokens: args.tokens !== undefined ? Number(args.tokens) : undefined,
      latencyMs: args['latency-ms'] !== undefined ? Number(args['latency-ms']) : undefined,
      notes: args.notes,
    }, config)
    derive(state, config)
    const saved = saveMemory(dir, state)
    output({
      ok: true, captured: entry, saved: saved.ok, dataDir: saved.dir,
      warning: saved.warning, ...summary(state),
    })
    return
  }

  if (command === 'summarize') {
    const habits = []
    const one = jsonParse(args.habit, undefined)
    if (one && typeof one === 'object' && !Array.isArray(one)) habits.push(one)
    const many = jsonParse(args.habits, undefined)
    if (Array.isArray(many)) habits.push(...many.filter((h) => h && typeof h === 'object'))
    for (const h of habits) upsertHabit(state, h, config)
    derive(state, config)
    const saved = saveMemory(dir, state)
    output({
      ok: true, upserted: habits.length, saved: saved.ok, dataDir: saved.dir,
      warning: saved.warning, ...summary(state),
    })
    return
  }

  if (command === 'review') {
    if (args.confirm) {
      const habit = confirmHabit(state, String(args.confirm))
      const saved = saveMemory(dir, state)
      output({
        ok: Boolean(habit), confirmed: habit || null, saved: saved.ok,
        dataDir: saved.dir, warning: saved.warning,
      })
      return
    }
    output({
      ok: true,
      pending: (state.habits || []).filter((h) => !h.autoApply),
      confirmed: (state.habits || []).filter((h) => h.autoApply),
    })
    return
  }

  if (command === 'export') {
    const kind = ['traces', 'habits', 'playbook'].includes(args.kind) ? args.kind : 'traces'
    const text = exportJsonl(state, kind)
    if (args.out && args.out !== true) {
      writeFileSync(args.out, text + (text ? '\n' : ''), 'utf8')
      output({ ok: true, kind, rows: (state[kind] || []).length, file: args.out })
    } else {
      output(text)
    }
    return
  }

  fail(`unknown command: ${command}. Run "pca help".`)
}

main().catch((error) => fail(String(error?.stack || error)))
