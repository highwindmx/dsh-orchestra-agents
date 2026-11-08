// Build the skill text the parent agent actually sees.
//
// Following the proven win-env-kit pattern: config is live in the provider
// closure, and get() re-renders the skill body every time so a settings-page
// change (childBackend / model / memory) is reflected on the next skill read
// without restarting the Host.

import { resolveConfig, BACKENDS } from './config.mjs'

export function describeSelection(config) {
  const c = resolveConfig(config)
  const label = {
    'same-cloud': 'same cloud model as the parent',
    'other-cloud': `other cloud model ${c.otherCloud.provider}/${c.otherCloud.model}`,
    local: `local endpoint ${c.local.baseUrl} (${c.local.model || 'auto'})`,
  }[c.childBackend]
  return `Active child backend: ${c.childBackend} — ${label}. Fallback: ${c.fallbackBackend}. Memory: ${c.memory.enabled ? 'on' : 'off'}.`
}

function backendHint(c) {
  if (c.childBackend === 'same-cloud') {
    return '- Dispatch with the native `subagent_fork` tool (inherits your context, same model). Do NOT set a provider/model override.'
  }
  if (c.childBackend === 'other-cloud') {
    return `- Dispatch with the native \`subagent\` tool and set \`provider: "${c.otherCloud.provider}"\` and \`model: "${c.otherCloud.model}"\`.`
  }
  return `- Dispatch by running the bundled \`dispatch\` command against the local endpoint (see below). It has a hard ${c.local.timeoutMs}ms timeout and never hangs.`
}

/** Return the full skill content = runtime-config header + playbook body. */
export function buildSkillContent(body, config) {
  const c = resolveConfig(config)
  const header = `# Parent / Child Agent — runtime configuration

> Auto-generated from the plugin Config. Re-read this skill after changing settings.

${describeSelection(config)}

## Current settings (read these values into every CLI call)

\`\`\`json
${JSON.stringify(c, null, 2)}
\`\`\`

Compact form — pass this whole line as \`--config '<PCA_CONFIG>'\` to every CLI call
(single quotes keep the JSON intact in the shell):

\`\`\`text
PCA_CONFIG=${JSON.stringify(c)}
\`\`\`

If the settings above are all defaults you may omit \`--config\` entirely.

- \`childBackend\` is one of ${BACKENDS.map((b) => `\`${b}\``).join(', ')}.
${backendHint(c)}
- On any backend failure, re-dispatch using \`fallbackBackend\` = \`${c.fallbackBackend}\` and record the fallback in the trace.
- Local endpoint \`127.0.0.1\` is in NO_PROXY: the bundled CLI calls it directly with \`fetch\` and never routes it through the proxy.
- Memory data dir: \`${c.memory.dataDir || '~/.dsh/parent-child-agent'}\` (file \`memory.json\`). Pass it as \`--data-dir\`.
- All bundled scripts live under this skill's base directory. Resolve them to absolute paths before running (see "How to resolve the bundled tools").

---

`
  return header + body
}
