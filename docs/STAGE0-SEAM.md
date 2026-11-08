# Stage 0 — Seam decision (ADR)

**Status:** decided, implemented.
**Context:** DSH Desktop `2.0.22-next` / `dsh 0.2.2-rc.1`, profile `desktop`.
We are building `dsh-parent-child-agent`: a parent (high-intelligence) agent
that thinks and dispatches, a switchable child backend, and a memory/learning
loop. The question in stage 0 was: which Host extension seam do we build on?

## What we could actually verify in this session

`dsh-win-env-kit` is a **real, installed, working** Host plugin in this profile.
Reading its `lib/index.js` shows the entire Host API it uses:

- `apply(ctx, config)` +
  `ctx.skills.registerProvider((control) => ({ name, async list(o){}, async get(c,o){} }))`
- a schemastery `Config` export (loaded via `lib/host-schema.mjs`, the host copy
  located with `createRequire` because linked installs cannot resolve
  `@deepseek-ai/schemastery` directly)
- `export const inject = ['skills']`

We also proved (with a zero-dependency probe against the real
`C:\Users\KaishengMao\.dsh\profiles\desktop\node_modules\@deepseek-ai\schemastery`,
version 3.18.5) that `z.object`, `z.union`, `z.const`, nested `.default()` and
`z.resolve` all work — so the switchable three-backend `Config` is valid.

## What we could NOT verify, and why

The documentation (`cordis-plugin-development/references/practices.md`,
`cordis-composition-reference/references/packages.md`) names many richer seams:

- `ctx.tools` / `ctx.tools.register` / `ctx.tools.guard` / `ctx.tools.restrict`
- `ctx.storage.domain` (schema-validated KV domains), `ctx.storage`
- `ctx.subagents` (named-provider registry), `dsh-subagent-acp`, OAR
- `ctx.systemPrompt.section()`, `agent.inject()`, `waterfall`
- `dsh-mcp-client` MCP tool registration, `dsh-llm-*` providers

But **none of these packages are on disk**: they are sealed inside
`app.asar` (237 MB), `@electron/asar` is not installed, no `*.d.ts` ships under
`app.asar.unpacked/node_modules/@deepseek-ai`, and this session has no
`cordis_inspect_query` tool. We could find those names only in Markdown
documentation, never in loadable implementation code. Guessing their exact
signatures would produce a plugin that fails to load.

Additionally, `list_subagent_models()` reports exactly one provider
(`workbuddy`) with one model (`hy4free`), and `dsh-connect-workbuddy`'s
`baseUrl` is bound to the WorkBuddy loopback gateway — it is **not** a general
OpenAI-compatible BYOK endpoint. So registering a "local LLM provider" through
the existing catalog is not a clean path.

## Decision

Build on the **single proven seam**:

1. **Host plugin** = `apply(ctx, config)` + `Config` + `inject: ['skills']`,
   registering one bundled playbook skill. Config is live in the provider
   closure; `get()` re-renders the skill body each read, so a settings-page
   change (`childBackend`, models, memory) takes effect on the next skill read
   without a Host restart. This is the exact pattern from `dsh-win-env-kit`.

2. **Parent orchestration** lives in the **playbook skill**, not in Host code.
   The skill instructs the parent to use its **native** `subagent_fork` /
   `subagent` tools for the two cloud backends. We do **not** re-implement an
   LLM client or register a provider.

3. **Local backend + memory engine** ship as **zero-dependency Node CLIs**
   (`scripts/pca.mjs`, `lib/memory.mjs`, `lib/backends.mjs`) that the parent
   invokes via its shell tool using the skill's `resourceBase` absolute path.
   The local call uses `fetch` directly to the OpenAI-compatible endpoint with
   a hard `AbortController` timeout; `127.0.0.1` is in `NO_PROXY` so it is
   never routed through the `10808` proxy. Memory is a plain UTF-8 JSON file
   (`~/.dsh/parent-child-agent/memory.json`) with atomic rename; traces are the
   source of truth, habits/playbook are derived caches that can be rebuilt and
   exported as JSONL for a future LoRA fine-tune. This phase does **not** train
   or change any model weights.

4. We do **not** touch `ctx.tools`, `ctx.storage`, `ctx.subagents`,
   `waterfall`, `systemPrompt`, new session-event types, or the profile's
   `cordis.patch.yml` from plugin code.

## Consequences

- The plugin is guaranteed to load because it uses only the seam a working
  plugin already uses in this exact profile.
- Behavior is driven by a skill + CLI, which is easy to inspect, test offline
  (`scripts/verify-bundle.mjs`), and portable.
- Trade-off: no native "tool" in the tool list and no hosted KV storage; the
  parent must follow the playbook and call the CLI through its shell tool.
  That is acceptable and is explicitly documented in `SKILL.md`.
- When a future DSH build exposes the richer seams (or a `cordis_inspect_query`
  tool is available), we can promote the CLI into native tools / `ctx.storage`
  domains without changing the data model.

## Verification

- Real host schemastery probe: nested defaults + `z.union`/`z.const` resolve.
- `node scripts/verify-bundle.mjs` — static consistency, provider load with a
  stub ctx, Config defaults for all three backends, settings-page content
  switch, memory capture→derive→recall→export round-trip, cloudPlan for all
  backends, and `callLocal` success + degraded paths.
- On-host (deferred to the user): `plugin_manager install_bundle` → `applied`,
  toggle, restart DSH, run one dispatch per backend, confirm memory persists,
  confirm local failure degrades to the fallback.
