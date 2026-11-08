// Externalized memory for the child agent.
//
// Design rules (see docs/STAGE0-SEAM.md):
//  - traces are the truth source (session log), habits + playbook are a derived
//    cache that can always be rebuilt from traces.
//  - everything is a plain UTF-8/LF JSON file; zero dependencies, no daemon.
//  - every read/write degrades gracefully: a missing, locked or corrupt memory
//    file must NEVER block a dispatch.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { resolveConfig } from './config.mjs'

export function preferredDataDir(config) {
  const c = resolveConfig(config)
  return c.memory.dataDir || join(homedir(), '.dsh', 'parent-child-agent')
}

export function memoryPath(dir) {
  return join(dir, 'memory.json')
}

export function emptyState() {
  return { version: 1, habits: [], playbook: [], traces: [] }
}

export function loadMemory(dir) {
  try {
    const raw = readFileSync(memoryPath(dir), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return emptyState()
    return {
      version: 1,
      habits: Array.isArray(parsed.habits) ? parsed.habits : [],
      playbook: Array.isArray(parsed.playbook) ? parsed.playbook : [],
      traces: Array.isArray(parsed.traces) ? parsed.traces : [],
    }
  } catch {
    return emptyState()
  }
}

/**
 * Persist state. Returns { ok, dir, warning }.
 * On a sandbox/permission failure it retries once inside the current working
 * directory (which is normally the agent workspace and therefore writable),
 * and finally gives up WITHOUT throwing so dispatch can continue.
 */
export function saveMemory(dir, state) {
  const candidates = [dir, join(process.cwd(), '.pca-memory')]
  for (const target of candidates) {
    try {
      mkdirSync(target, { recursive: true })
      const file = memoryPath(target)
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
      renameSync(tmp, file)
      return {
        ok: true,
        dir: target,
        warning: target === dir ? undefined : `Primary data dir "${dir}" was not writable; used "${target}" instead.`,
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { ok: false, dir, warning: 'Memory storage is unavailable; this dispatch will not be remembered.' }
}

function stableId(prefix, key) {
  let h = 2166136261
  const s = `${prefix}:${key}`
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${prefix}-${(h >>> 0).toString(36)}`
}

export function normalizeContext(value) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { note: value }
    } catch {
      return { note: value }
    }
  }
  return { note: String(value) }
}

function taskPattern(task) {
  const words = String(task || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 6)
  return words.join(' ') || '(empty task)'
}

/** Capture one (task, context, action, outcome) trace. */
export function captureTrace(state, trace, config) {
  const c = resolveConfig(config)
  const entry = {
    ts: trace.ts || new Date().toISOString(),
    task: String(trace.task ?? ''),
    context: normalizeContext(trace.context),
    action: String(trace.action ?? ''),
    outcome: String(trace.outcome ?? ''),
    backend: String(trace.backend ?? c.childBackend),
    success: trace.success !== false,
    latencyMs: typeof trace.latencyMs === 'number' ? trace.latencyMs : undefined,
    tokens: typeof trace.tokens === 'number' ? trace.tokens : undefined,
    notes: trace.notes ? String(trace.notes) : undefined,
  }
  state.traces.push(entry)
  const cap = Math.max(1, Number(c.memory.traceRetention) || 5000)
  if (state.traces.length > cap) state.traces.splice(0, state.traces.length - cap)
  return entry
}

function signalCounts(state) {
  const counts = new Map()
  for (const t of state.traces) {
    const ctx = normalizeContext(t.context)
    const signals = []
    for (const [k, v] of Object.entries(ctx)) {
      if (v == null || typeof v === 'object') continue
      signals.push(`${k}=${String(v)}`)
    }
    if (t.notes) {
      for (const m of String(t.notes).matchAll(/\[habit:([^\]]+)\]/g)) signals.push(String(m[1]).trim())
    }
    for (const key of new Set(signals)) {
      const prev = counts.get(key) || { hits: 0, lastSeenAt: '', sourceTraceIds: [] }
      prev.hits += 1
      if (!t.ts || t.ts > prev.lastSeenAt) prev.lastSeenAt = t.ts || ''
      prev.sourceTraceIds.push(t.ts)
      counts.set(key, prev)
    }
  }
  return counts
}

/** Derive habits + playbook from traces. Confirmed habits are carried forward. */
export function derive(state, config) {
  const c = resolveConfig(config)
  const confirmed = new Map(
    (state.habits || []).filter((h) => h && h.confirmed).map((h) => [h.key, h]),
  )
  const habits = []
  for (const [key, info] of signalCounts(state)) {
    if (info.hits < 2) continue
    const confidence = Math.min(1, info.hits / 3)
    const prev = confirmed.get(key)
    habits.push({
      id: stableId('habit', key),
      key,
      category: key.split('=')[0] || 'general',
      description: `User tends to prefer ${key} (observed ${info.hits} times).`,
      confidence: Number(confidence.toFixed(3)),
      hits: info.hits,
      lastSeenAt: info.lastSeenAt,
      sourceTraceIds: info.sourceTraceIds.slice(-10),
      autoApply: prev ? true : confidence >= Number(c.memory.minConfidence),
      confirmed: Boolean(prev),
    })
  }
  for (const [key, h] of confirmed) {
    if (!habits.some((x) => x.key === key)) habits.push({ ...h, autoApply: true })
  }
  habits.sort((a, b) => (b.confidence - a.confidence) || (b.hits - a.hits))
  const maxHabits = Math.max(1, Number(c.memory.maxHabits) || 200)

  const groups = new Map()
  for (const t of state.traces) {
    const pattern = taskPattern(t.task)
    const g = groups.get(pattern) || { success: 0, fail: 0, steps: [], tokens: [], lastUsedAt: '' }
    if (t.success) {
      g.success += 1
      if (t.action && !g.steps.includes(t.action)) g.steps.push(t.action)
      if (typeof t.tokens === 'number') g.tokens.push(t.tokens)
    } else {
      g.fail += 1
    }
    if (!t.ts || t.ts > g.lastUsedAt) g.lastUsedAt = t.ts || ''
    groups.set(pattern, g)
  }
  const playbook = []
  for (const [pattern, g] of groups) {
    if (g.success < 1) continue
    const avgTokens = g.tokens.length
      ? Math.round(g.tokens.reduce((a, b) => a + b, 0) / g.tokens.length)
      : undefined
    playbook.push({
      id: stableId('play', pattern),
      taskPattern: pattern,
      preferredSteps: g.steps.slice(0, 5),
      successCount: g.success,
      failCount: g.fail,
      avgTokens,
      lastUsedAt: g.lastUsedAt,
    })
  }
  playbook.sort((a, b) => (b.successCount - b.failCount) - (a.successCount - a.failCount))

  state.habits = habits.slice(0, maxHabits)
  state.playbook = playbook
  return state
}

/** Recall the most relevant habits + playbook entries for a new task. */
export function recall(state, task, context, config) {
  const c = resolveConfig(config)
  if (!c.memory.enabled) return { text: '', habits: [], playbook: [] }
  const haystack = `${String(task || '')} ${JSON.stringify(normalizeContext(context))}`.toLowerCase()
  const topK = Math.max(1, Number(c.memory.injectTopK) || 5)

  const scoredHabits = (state.habits || []).map((h) => {
    const key = String(h.key || '').toLowerCase()
    const match = haystack.includes(key) || key.split('=').some((p) => p.length > 3 && haystack.includes(p))
    return { h, score: (Number(h.confidence) || 0) * (1 + Math.log1p(Number(h.hits) || 0)) + (match ? 3 : 0) }
  }).sort((a, b) => b.score - a.score).slice(0, topK)

  const taskWords = taskPattern(task).split(' ')
  const scoredPlay = (state.playbook || []).map((p) => {
    const words = String(p.taskPattern || '').split(' ')
    const overlap = words.filter((w) => w.length > 2 && taskWords.includes(w)).length
    return { p, score: (p.successCount - p.failCount) + overlap * 2 }
  }).sort((a, b) => b.score - a.score).slice(0, topK)

  const lines = []
  if (scoredHabits.length) {
    lines.push('## Recalled user habits')
    lines.push('Apply these unless the current task contradicts them.')
    for (const { h } of scoredHabits) {
      const flag = h.autoApply
        ? `confidence ${Number(h.confidence).toFixed(2)}`
        : `LOW CONFIDENCE ${Number(h.confidence).toFixed(2)} — needs child_habits_review, do not auto-apply`
      lines.push(`- [${h.key}] ${h.description} (${flag}, hits ${h.hits})`)
    }
  }
  if (scoredPlay.length) {
    lines.push('')
    lines.push('## Playbook (proven steps for similar past tasks)')
    for (const { p } of scoredPlay) {
      const steps = (p.preferredSteps || []).length ? ` Steps: ${p.preferredSteps.join(' | ')}.` : ''
      lines.push(`- "${p.taskPattern}": success ${p.successCount}, fail ${p.failCount}.${steps}`)
    }
  }
  return {
    text: lines.length ? lines.join('\n') : '',
    habits: scoredHabits.map((x) => x.h),
    playbook: scoredPlay.map((x) => x.p),
  }
}

/** Add or confirm an explicit habit (from child_summarize / child_habits_review). */
export function upsertHabit(state, input, config) {
  const c = resolveConfig(config)
  const key = String(input.key || '').trim()
  if (!key) throw new Error('habit requires a non-empty "key"')
  const existing = (state.habits || []).find((h) => h.key === key)
  const confidence = typeof input.confidence === 'number'
    ? Math.min(1, Math.max(0, input.confidence))
    : Number(c.memory.minConfidence)
  const habit = {
    id: existing?.id || stableId('habit', key),
    key,
    category: input.category || key.split('=')[0] || 'general',
    description: input.description || `User prefers ${key}.`,
    confidence: Number(confidence.toFixed(3)),
    hits: (existing?.hits || 0) + (input.countAsHit ? 1 : 0),
    lastSeenAt: new Date().toISOString(),
    sourceTraceIds: existing?.sourceTraceIds || [],
    autoApply: Boolean(input.confirm) || confidence >= Number(c.memory.minConfidence),
    confirmed: Boolean(input.confirm) || Boolean(existing?.confirmed),
  }
  state.habits = (state.habits || []).filter((h) => h.key !== key)
  state.habits.unshift(habit)
  const maxHabits = Math.max(1, Number(c.memory.maxHabits) || 200)
  state.habits = state.habits.slice(0, maxHabits)
  return habit
}

export function confirmHabit(state, id) {
  const h = (state.habits || []).find((x) => x.id === id || x.key === id)
  if (!h) return undefined
  h.confirmed = true
  h.autoApply = true
  h.confidence = Math.max(Number(h.confidence) || 0, Number(0.9))
  return h
}

export function exportJsonl(state, kind = 'traces') {
  const rows = kind === 'habits' ? state.habits : kind === 'playbook' ? state.playbook : state.traces
  return (rows || []).map((r) => JSON.stringify(r)).join('\n')
}

export function summary(state) {
  return {
    version: state.version || 1,
    traces: (state.traces || []).length,
    habits: (state.habits || []).length,
    autoApplyHabits: (state.habits || []).filter((h) => h.autoApply).length,
    pendingReview: (state.habits || []).filter((h) => !h.autoApply).length,
    playbook: (state.playbook || []).length,
    lastTraceAt: (state.traces || []).at(-1)?.ts || null,
  }
}
