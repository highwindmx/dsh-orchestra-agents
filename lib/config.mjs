// Config schema for the parent-child-agent bundle.
//
// defineConfig(z) receives the Host's own schemastery instance. When the Host
// cannot be reached, resolveConfig() still produces a complete, valid config
// from DEFAULTS, so the plugin degrades gracefully instead of crashing.

export const BACKENDS = ['same-cloud', 'other-cloud', 'local']

export const DEFAULTS = {
  childBackend: 'same-cloud',
  otherCloud: { provider: 'workbuddy', model: 'hy4std' },
  local: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    apiKey: '',
    timeoutMs: 30000,
    temperature: 0.3,
    maxTokens: 2048,
  },
  fallbackBackend: 'same-cloud',
  memory: {
    enabled: true,
    dataDir: '',
    injectTopK: 5,
    maxHabits: 200,
    captureTraces: true,
    traceRetention: 5000,
    minConfidence: 0.6,
  },
  dispatch: { maxDepth: 2, parallel: 2 },
}

export const CONFIG_KEYS = Object.keys(DEFAULTS)

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function pickBackend(value, fallback) {
  return BACKENDS.includes(value) ? value : fallback
}

/** Merge a (possibly partial or raw) config object into a complete one. */
export function resolveConfig(config) {
  const c = plain(config)
  return {
    childBackend: pickBackend(c.childBackend, DEFAULTS.childBackend),
    otherCloud: { ...DEFAULTS.otherCloud, ...plain(c.otherCloud) },
    local: { ...DEFAULTS.local, ...plain(c.local) },
    fallbackBackend: pickBackend(c.fallbackBackend, DEFAULTS.fallbackBackend),
    memory: { ...DEFAULTS.memory, ...plain(c.memory) },
    dispatch: { ...DEFAULTS.dispatch, ...plain(c.dispatch) },
  }
}

function makeBackend(z, defaultValue, description) {
  return z.union([
    z.const('same-cloud'),
    z.const('other-cloud'),
    z.const('local'),
  ]).default(defaultValue).description(description)
}

export function defineConfig(z) {
  return z.object({
    childBackend: makeBackend(z, DEFAULTS.childBackend,
      'Child execution backend: same-cloud inherits the parent model, other-cloud uses a chosen provider/model, local calls an OpenAI-compatible endpoint on this machine.'),
    otherCloud: z.object({
      provider: z.string().default(DEFAULTS.otherCloud.provider).description('Provider id for the other-cloud child.'),
      model: z.string().default(DEFAULTS.otherCloud.model).description('Model id for the other-cloud child.'),
    }).default({}).description('Settings used when childBackend = other-cloud.'),
    local: z.object({
      baseUrl: z.string().default(DEFAULTS.local.baseUrl).description('OpenAI-compatible base URL of the local runtime (Ollama / LM Studio). Keep 127.0.0.1 so it goes direct, never through the proxy.'),
      model: z.string().default(DEFAULTS.local.model).description('Local model id, e.g. qwen2.5:7b-instruct-q4_K_M. Empty = use the first model the server reports.'),
      apiKey: z.string().default(DEFAULTS.local.apiKey).description('Optional API key. Most local runtimes ignore it.'),
      timeoutMs: z.number().default(DEFAULTS.local.timeoutMs).description('Hard timeout in ms for one local request.'),
      temperature: z.number().default(DEFAULTS.local.temperature).description('Sampling temperature for the local child.'),
      maxTokens: z.number().default(DEFAULTS.local.maxTokens).description('Max tokens in the local child reply.'),
    }).default({}).description('Settings used when childBackend = local.'),
    fallbackBackend: makeBackend(z, DEFAULTS.fallbackBackend,
      'Backend to use when the selected backend fails (e.g. the local endpoint is down).'),
    memory: z.object({
      enabled: z.boolean().default(DEFAULTS.memory.enabled).description('Enable recall / capture / summarize.'),
      dataDir: z.string().default(DEFAULTS.memory.dataDir).description('Directory for memory.json. Empty = ~/.dsh/parent-child-agent.'),
      injectTopK: z.number().default(DEFAULTS.memory.injectTopK).description('How many habits + playbook entries to inject before dispatch.'),
      maxHabits: z.number().default(DEFAULTS.memory.maxHabits).description('Cap on stored habits.'),
      captureTraces: z.boolean().default(DEFAULTS.memory.captureTraces).description('Record a (task, context, action, outcome) trace after every dispatch.'),
      traceRetention: z.number().default(DEFAULTS.memory.traceRetention).description('Max traces kept; oldest are dropped first.'),
      minConfidence: z.number().default(DEFAULTS.memory.minConfidence).description('Habits below this confidence need child_habits_review confirmation before they are auto-applied.'),
    }).default({}).description('Externalized memory and self-improvement settings.'),
    dispatch: z.object({
      maxDepth: z.number().default(DEFAULTS.dispatch.maxDepth).description('Max parent->child recursion depth.'),
      parallel: z.number().default(DEFAULTS.dispatch.parallel).description('Max parallel child dispatches.'),
    }).default({}).description('Dispatch guardrails.'),
  }).default({})
}

export default defineConfig
