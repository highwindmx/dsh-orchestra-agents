// Parent / Child Agent — DSH Host plugin.
//
// This plugin deliberately uses ONLY the Host seam proven to load in this
// environment: ctx.skills.registerProvider(), a schemastery Config, and
// inject: ['skills']. The parent agent is driven by a bundled playbook skill;
// the memory + dispatch engine ships as zero-dependency Node CLIs that the
// parent invokes through its shell tool using the skill's resourceBase path.
//
// See docs/STAGE0-SEAM.md for why ctx.tools / ctx.storage / ctx.subagents /
// waterfall were NOT used (their signatures cannot be verified in this session).

import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadHostSchemastery } from './host-schema.mjs'
import { buildSkillContent, describeSelection } from './skill-content.mjs'

const name = 'dsh-parent-child-agent'
const inject = ['skills']
const PACKAGED_SKILL_RANK = 550
const SOURCE = 'custom'

let Config
try {
  const z = await loadHostSchemastery()
  if (z) {
    const { defineConfig } = await import('./config.mjs')
    Config = defineConfig(z)
  }
} catch {
  Config = undefined
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end < 0) return null
  const raw = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\r?\n/, '')
  const metadata = {}
  let current = null
  for (const line of raw.split(/\r?\n/)) {
    if (/^[\s]+/.test(line) && current) {
      const key = current
      metadata[key] = (metadata[key] ? metadata[key] + ' ' : '') + line.trim()
      continue
    }
    const m = line.match(/^([\w-]+):\s*(.*)$/)
    if (!m) { current = null; continue }
    current = m[1]
    let value = m[2].trim()
    if (/^[>|]/.test(value)) { metadata[current] = ''; continue }
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    metadata[current] = value
  }
  return { metadata, body }
}

async function parseSkillFile(skillFile, signal) {
  const text = await readFile(skillFile, 'utf8', { signal })
  const parsed = parseFrontmatter(text)
  if (!parsed) throw new Error(`skill missing frontmatter: ${skillFile}`)
  const { metadata, body } = parsed
  if (!metadata.name || !metadata.description) {
    throw new Error(`skill frontmatter needs name + description: ${skillFile}`)
  }
  return {
    name: metadata.name,
    description: metadata.description,
    whenToUse: metadata['when-to-use'] || metadata.whenToUse,
    metadata,
    content: body,
  }
}

function invocationFrom(metadata) {
  if (metadata?.['disable-model-invocation'] === 'true') {
    return { modelInvocable: false, userInvocable: true }
  }
  return { modelInvocable: true, userInvocable: true }
}

async function discoverCandidates(skillsRoot, signal) {
  const out = []
  let entries
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsRoot, entry.name)
    const skillFile = join(skillDir, 'SKILL.md')
    try {
      const parsed = await parseSkillFile(skillFile, signal)
      out.push({
        ...parsed,
        invocation: invocationFrom(parsed.metadata),
        source: SOURCE,
        provider: name,
        rank: PACKAGED_SKILL_RANK,
        locator: skillDir,
        path: skillFile,
      })
    } catch {
      // Skip malformed skill directories rather than breaking the provider.
    }
  }
  return out
}

/** Register the skill provider. The closure keeps `config` live. */
function apply(ctx, config) {
  const skillsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
  const dispose = ctx.skills.registerProvider((control) => ({
    name,
    async list(options) {
      const candidates = await discoverCandidates(skillsRoot, options?.signal)
      return candidates.map((candidate) => ({
        ...candidate,
        description: describeSelection(config),
      }))
    },
    async get(candidate, options) {
      const parsed = await parseSkillFile(candidate.path, options?.signal)
      return {
        name: parsed.name,
        description: parsed.description,
        whenToUse: parsed.whenToUse,
        invocation: invocationFrom(parsed.metadata),
        source: SOURCE,
        provider: name,
        resourceBase: { kind: 'directory', path: candidate.locator },
        path: candidate.path,
        metadata: parsed.metadata,
        content: buildSkillContent(parsed.content, config),
      }
    },
  }))
  return dispose
}

export { Config, apply, name, inject }
export default { Config, apply, name, inject }
