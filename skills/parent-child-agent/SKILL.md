---
name: parent-child-agent
description: >-
  Delegate child tasks from a high-intelligence parent agent to a switchable
  child backend (same cloud model, another cloud model, or a local OpenAI-
  compatible model), and accumulate user habits + a trace log so that later
  dispatches are faster and better tailored. Use when a task can be split into
  a parent (plan/dispatch/verify) and a child (execute) with memory carry-over.
---

# Parent / Child Agent playbook

You are the **parent**: you think, decompose, dispatch, and verify.
A **child** executes a single self-contained task. The child backend is
switchable in the plugin settings between:

| `childBackend` | How you (the parent) dispatch |
|---|---|
| `same-cloud` | native `subagent_fork` tool — inherits your context + model |
| `other-cloud` | native `subagent` tool with `provider` + `model` override |
| `local` | run the bundled `dispatch` command (real local HTTP call) |

Read the **runtime configuration header** prepended above this body: it holds
the active `childBackend`, the model names, the memory data dir, and a ready-
to-paste `PCA_CONFIG=...` line. Use those values; do not guess them.

The bundled engine is a zero-dependency Node CLI: `scripts/pca.mjs`. It handles
memory (recall / capture / summarize / review / export) and, for the local
backend, the actual child execution. Cloud execution is done by you with the
native subagent tools — the CLI only *plans* those calls.

## How to resolve the bundled tools

The harness reports `Base directory for this skill: <SKILL_BASE>` — that is the
`resourceBase`. All bundled paths are relative to **that** base, NOT the current
working directory. Convert to an absolute path first, e.g. on Windows:

```
node "<SKILL_BASE>\scripts\pca.mjs" status --config '<PCA_CONFIG>'
```

Replace `<PCA_CONFIG>` with the JSON from the runtime header. On PowerShell,
use `--config "<PCA_CONFIG>"` (double quotes) and keep the JSON on one line.
The scripts ship inside this package and need **no** `npm install` / `pip`.
All file output is UTF-8 + LF; the CLI writes to stdout only.

Set `--data-dir <dir>` once per session (from the runtime header's "Memory data
dir") if you want a stable location; otherwise the CLI uses
`~/.dsh/parent-child-agent/memory.json`.

## The loop (run for every child task)

```
recall -> dispatch -> [child executes] -> capture -> (summarize) -> verify
```

### 1. recall — inject memory before dispatch

```
node "<SKILL_BASE>\scripts\pca.mjs" recall --task "<TASK>" --context '<CTX_JSON>' --config '<PCA_CONFIG>'
```

Returns `{ recalled, prompt, childBackend }`. `recalled.text` contains the
user habits and playbook learned so far. **Always dispatch using `prompt`** (it
already has memory prepended), not the raw task. Low-confidence habits are
marked "do not auto-apply" — respect that and call `review` (step 5) instead.

### 2. dispatch — run the child

**`same-cloud`**: call the native `subagent_fork` tool with `prompt` from step 1.
Do NOT pass a provider/model.

**`other-cloud`**: call the native `subagent` tool with `prompt`, and set
`provider` and `model` from the runtime header (`otherCloud.provider` /
`otherCloud.model`). That model must be enabled for subagent delegation in the
DSH Subagent settings page — the main Model catalog and the subagent model
registry are different lists. If the call fails, fall back to
`fallbackBackend` and record it in the trace.

**`local`**: run

```
node "<SKILL_BASE>\scripts\pca.mjs" dispatch --task "<TASK>" --context '<CTX_JSON>' --config '<PCA_CONFIG>'
```

The CLI calls the local OpenAI-compatible endpoint with a hard timeout. If it
returns `degraded: true`, the local model was unreachable/slow — re-dispatch
with the `fallbackBackend` plan it gives you (a cloud `subagent*` tool), and
record that backend in the capture step. Never loop or hang waiting for the
local server.

For cloud backends the `dispatch` command is optional: it just returns the same
`plan` you would build yourself. You may call it to get a canonical plan and
its `recall` payload in one shot.

### 3. capture — record the outcome (the "memory" write)

After the child finishes, ALWAYS record a trace (this is the source of truth
for all later learning):

```
node "<SKILL_BASE>\scripts\pca.mjs" capture \
  --task "<TASK>" --action "<WHAT_YOU_SENT>" --outcome "<CHILD_RESULT_SUMMARY>" \
  --backend <backend_used> --success true --context '<CTX_JSON>' \
  --latency-ms <n> --config '<PCA_CONFIG>'
```

`--backend` is the backend actually used (important when a fallback happened).
`--success false` marks a failed trace. The CLI appends a normalized
`(ts, task, context, action, outcome, backend, success, latencyMs, tokens)`
record, trims to `traceRetention`, and re-derives habits + playbook.

### 4. summarize — turn traces into habits (self-improvement)

Habits are derived automatically from repeated context signals in traces. To
add an explicit habit (e.g. the user corrected you), run:

```
node "<SKILL_BASE>\scripts\pca.mjs" summarize \
  --habit '{"key":"prefer-pwsh","category":"style","description":"Use PowerShell 5.1 syntax, not bash"}' \
  --config '<PCA_CONFIG>'
```

or pass several with `--habits '[{...},{...}]'`. You can also embed habit
signals directly in `--context` as `{"habit:prefer-pwsh": "..."}`; the derive
step promotes signals seen ≥2 times into a habit. Habits with confidence
below `minConfidence` are NOT auto-applied — see step 5.

The derived **playbook** remembers which steps succeeded/failed per task
pattern, so recurring tasks get a preferred recipe injected on the next recall.

### 5. review — human-in-the-loop for low-confidence habits

```
node "<SKILL_BASE>\scripts\pca.mjs" review --list --config '<PCA_CONFIG>'
node "<SKILL_BASE>\scripts\pca.mjs" review --confirm <id> --config '<PCA_CONFIG>'
```

Confirm only habits the user actually agrees with. Confirmed habits are auto-
applied on future recalls.

### 6. export — get the LoRA-ready trajectory (no training this phase)

```
node "<SKILL_BASE>\scripts\pca.mjs" export --kind traces --out "<ABS_PATH>\traces.jsonl" --config '<PCA_CONFIG>'
```

`--kind` is `traces` (default), `habits`, or `playbook`. JSONL, one object per
line, UTF-8. These `(task, context, action, outcome)` records are the dataset
for a future fine-tune; this plugin never trains or changes model weights.

## Rules / guardrails

- The parent does the thinking; the child only executes the dispatched task.
- One trace per dispatch. Never fabricate `outcome` — summarize the child's
  real result.
- Memory failures (unwritable data dir, corrupt file) are non-fatal: the CLI
  still dispatches and warns. Do not stall because of memory.
- `127.0.0.1` local endpoints are reached DIRECTLY (NO_PROXY); never route the
  local call through the proxy.
- Do not spawn more than `dispatch.maxDepth` levels; keep `dispatch.parallel`
  children at once (values in the runtime header).
- Never bundle model weights or attempt LoRA training in this phase.
- Switching `childBackend` is a settings-page change; re-read this skill so the
  runtime header refreshes. Per-task override is a future enhancement; for now
  pass `--config` matching the active settings.
