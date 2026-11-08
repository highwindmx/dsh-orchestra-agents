// Backend dispatch logic.
//
// Two of the three backends are CLOUD and are executed by the parent agent via
// its NATIVE subagent tools (this plugin does not re-implement an LLM client and
// does not register a provider). For those, `cloudPlan()` returns the exact tool
// + params the parent should use. The LOCAL backend is a real OpenAI-compatible
// HTTP endpoint that this CLI calls directly with fetch + a hard timeout.
//
// Every path is bounded: a dead or slow local endpoint never hangs the agent.

import { resolveConfig } from './config.mjs'

/** Build the child prompt = recalled memory (if any) + task + context. */
export function buildChildPrompt(memoryText, task, context) {
  const parts = []
  if (memoryText) {
    parts.push('# Memory from previous tasks (apply where relevant)\n\n' + memoryText)
  }
  parts.push('# Task\n\n' + String(task || ''))
  if (context && (typeof context !== 'object' || Object.keys(context).length)) {
    parts.push('# Context\n\n' + (typeof context === 'string' ? context : JSON.stringify(context, null, 2)))
  }
  return parts.join('\n\n---\n\n')
}

/**
 * For cloud backends, return the plan the parent executes with its native
 * subagent tools. `recalled` is the memory text already injected into prompt.
 */
export function cloudPlan(backend, config, prompt) {
  const c = resolveConfig(config)
  if (backend === 'other-cloud') {
    return {
      tool: 'subagent',
      params: { prompt, provider: c.otherCloud.provider, model: c.otherCloud.model },
      label: `other-cloud ${c.otherCloud.provider}/${c.otherCloud.model}`,
    }
  }
  return {
    tool: 'subagent_fork',
    params: { prompt },
    label: 'same-cloud (inherits parent model + context)',
  }
}

function localHeaders(c) {
  const headers = { 'content-type': 'application/json' }
  if (c.local.apiKey) headers.authorization = `Bearer ${c.local.apiKey}`
  return headers
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 400)
      throw new Error(`HTTP ${res.status}: ${body}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Resolve the model id: use the configured one, else the server's first model. */
async function resolveLocalModel(c, timeoutMs) {
  if (c.local.model) return c.local.model
  const base = c.local.baseUrl.replace(/\/+$/, '')
  const data = await fetchJson(`${base}/models`, { headers: localHeaders(c), method: 'GET' }, timeoutMs)
  const first = data?.data?.[0]?.id
  if (!first) throw new Error('local server reported no models and local.model is empty')
  return first
}

/**
 * Call the local OpenAI-compatible endpoint.
 * Returns { ok, text, model, tokens, latencyMs, error }. Never throws: any
 * failure is captured in `.ok=false, .error` so the caller can fall back.
 *
 * NOTE: 127.0.0.1 is in NO_PROXY. Node's global fetch does not read HTTP_PROXY
 * unless explicitly configured, so this call goes DIRECT to the loopback and is
 * never routed through the 10808 proxy.
 */
export async function callLocal(config, prompt) {
  const c = resolveConfig(config)
  const timeoutMs = Math.max(1000, Number(c.local.timeoutMs) || 30000)
  const started = Date.now()
  try {
    const model = await resolveLocalModel(c, timeoutMs)
    const base = c.local.baseUrl.replace(/\/+$/, '')
    const data = await fetchJson(`${base}/chat/completions`, {
      method: 'POST',
      headers: localHeaders(c),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: Number(c.local.temperature),
        max_tokens: Number(c.local.maxTokens),
        stream: false,
      }),
    }, timeoutMs)
    const text = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new Error('local reply had no choices[0].message.content')
    return {
      ok: true,
      text,
      model,
      tokens: typeof data?.usage?.total_tokens === 'number' ? data.usage.total_tokens : undefined,
      latencyMs: Date.now() - started,
    }
  } catch (error) {
    return {
      ok: false,
      error: error?.name === 'AbortError'
        ? `local request timed out after ${timeoutMs}ms`
        : String(error?.message || error),
      latencyMs: Date.now() - started,
    }
  }
}
