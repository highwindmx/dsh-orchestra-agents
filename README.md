# dsh-orchestra-agents

> Repository: https://github.com/highwindmx/dsh-orchestra-agents — standalone
> DSH plugin bundle (npm package id: `dsh-parent-child-agent`).

A DeepSeek Harness (DSH) plugin bundle that implements a **parent / child agent**
workflow:

- The **parent** (your current high-intelligence model) thinks, decomposes,
  dispatches, and verifies.
- The **child** executes a single self-contained task on a **switchable
  backend**: the same cloud model, another cloud model, or a local
  OpenAI-compatible model (Ollama / LM Studio / llama.cpp server).
- After each dispatch the outcome is recorded as a normalized **trace**. Traces
  are distilled into **user habits** and a **playbook**, which are injected into
  the next dispatch — so the child gets faster and more tailored over time.
  Trajectories can be exported as JSONL for a future LoRA fine-tune; this
  plugin never trains or changes model weights.

## Why it is built this way

The plugin uses only the Host seam proven to load in this environment
(`ctx.skills.registerProvider` + a schemastery `Config` + `inject: ['skills']`),
the same pattern as the working `dsh-win-env-kit` plugin. The parent is driven
by a bundled **playbook skill** and uses its **native** `subagent_fork` /
`subagent` tools for cloud backends. The local backend and the memory engine are
zero-dependency Node CLIs invoked by the parent through its shell tool. See
[docs/STAGE0-SEAM.md](docs/STAGE0-SEAM.md) for the full architectural decision.

## Install (on the host, requires a DSH restart)

This is a standalone repository. Clone it anywhere, then from inside DSH install
the bundle by its **absolute package directory** (adjust the path to where you
cloned it):

```
plugin_manager action=install_bundle target="D:\Share\Scripts\Explore\useAI\DSH\packages\dsh-parent-child-agent"
```

Then enable it (`list_plugins` → exact id → `set_plugin enabled=true`) and
**restart DSH** so the new Host JS module generation is loaded. Verify the
`application: applied` state in the Host log, not just the manifest entry.

## Configure

Settings are a schemastery `Config` on the plugin entry. Key fields:

| Field | Default | Meaning |
|---|---|---|
| `childBackend` | `same-cloud` | `same-cloud` \| `other-cloud` \| `local` |
| `otherCloud.provider` / `.model` | `workbuddy` / `hy4std` | Model for `other-cloud` |
| `local.baseUrl` | `http://127.0.0.1:11434/v1` | Local OpenAI-compatible endpoint |
| `local.model` | `""` (auto-detect) | Model id; empty = use server's first model |
| `local.apiKey` | `""` | Optional bearer token |
| `local.timeoutMs` | `30000` | Hard per-request timeout |
| `local.temperature` / `.maxTokens` | `0.3` / `2048` | Generation params |
| `fallbackBackend` | `same-cloud` | Used when the local endpoint is down |
| `memory.enabled` | `true` | Toggle the whole memory loop |
| `memory.dataDir` | `""` (`~/.dsh/parent-child-agent`) | Where `memory.json` lives |
| `memory.injectTopK` | `5` | Max habits injected per dispatch |
| `memory.minConfidence` | `0.6` | Below this, a habit needs `review --confirm` |
| `memory.traceRetention` | `5000` | Max traces kept |
| `dispatch.maxDepth` / `.parallel` | `2` / `2` | Playbook guardrails |

For the local backend, install a runtime yourself (e.g. Ollama + a 7B Q4
model on an 8 GB+ GPU, or a 3B Q4 model on a smaller GPU / iGPU). This bundle
ships **no model weights**. `127.0.0.1` is in `NO_PROXY`, so the local call is
always direct and never goes through the `10808` proxy.

You can also override config at the profile level with an id-targeted patch.
Because `config` is a composition base layer that is **replaced as a whole**
(not deep-merged), restate every field you want to keep, e.g.:

```yaml
- id: parent-child-agent
  config:
    childBackend: local
    otherCloud: { provider: workbuddy, model: hy4std }
    local: { baseUrl: 'http://127.0.0.1:11434/v1', model: qwen2.5:7b, apiKey: '', timeoutMs: 30000, temperature: 0.3, maxTokens: 2048 }
    fallbackBackend: same-cloud
    memory: { enabled: true, dataDir: '', injectTopK: 5, maxHabits: 200, captureTraces: true, traceRetention: 5000, minConfidence: 0.6 }
    dispatch: { maxDepth: 2, parallel: 2 }
```

Switching `childBackend` in the settings page takes effect on the next skill
read (no restart needed for config-only changes).

## The loop

```
recall -> dispatch -> [child executes] -> capture -> summarize -> verify
```

The parent reads the bundled `parent-child-agent` skill (which has the live
config prepended), then:

1. `pca recall --task ...` → builds a prompt with relevant habits/playbook.
2. `pca dispatch --task ...` → returns a plan for cloud backends (executed by
   the parent with its native `subagent*` tool) or actually calls the local
   endpoint; on local failure it returns a degraded fallback plan.
3. `pca capture --task ... --action ... --outcome ...` → appends a normalized
   `(task, context, action, outcome, backend, success, latencyMs, tokens)` trace
   and re-derives habits + playbook.
4. `pca summarize --habit '{...}'` → add explicit habits; `pca review --confirm
   <id>` → confirm low-confidence habits.
5. `pca export --kind traces --out traces.jsonl` → LoRA-ready trajectory.

All commands live at `scripts/pca.mjs` and are zero-dependency. The parent
resolves them through the skill's reported base directory (see the "How to
resolve the bundled tools" section in `SKILL.md`).

## Offline self-check

```
node scripts/verify-bundle.mjs
```

Covers static consistency, provider load with a stub `ctx`, Config defaults for
all three backends, settings-page content switching, memory round-trip, cloud
plans, and local success + degraded paths. It never contacts a real model.

## Host prerequisites (read before switching backends)

- **`same-cloud`** works out of the box: the parent uses `subagent_fork`, which
  inherits the parent's model and context.
- **`other-cloud`** needs the chosen `provider`/`model` to be a model that the
  `subagent` tool is allowed to use. In this profile `list_subagent_models`
  currently reports only `workbuddy/hy4free`, while the main WorkBuddy catalog
  lists many models (hy4std, hy3, deepseek-v4.1-flash, …). Those are **two
  different registries**. Enable the extra model for subagent delegation in the
  DSH **Subagent settings page** ("models agents may choose for subagents"),
  or set `otherCloud.model` to one that is registered. If a dispatch with
  `other-cloud` fails, the playbook tells the parent to fall back to
  `fallbackBackend` (default `same-cloud`).
- **`local`** needs a running OpenAI-compatible endpoint (see above). If it is
  down, the CLI returns a degraded plan and the parent falls back automatically
  — it never hangs.

## Host limitations / deferred verification

Installing and enabling the bundle, switching the three backends end-to-end,
confirming memory persistence across sessions, and the local-failure fallback
all require the running DSH GUI and a real local model. Those are ⏳ host-side
steps and are not covered by the offline self-check. See
[docs/STAGE0-SEAM.md](docs/STAGE0-SEAM.md#verification).

## License

MIT — see [LICENSE](LICENSE).
