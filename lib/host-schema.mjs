// Locate the Host's own @deepseek-ai/schemastery copy.
//
// A linked (workspace) bundle cannot always resolve the Host's dependency by a
// bare import, so we try a direct import first and then walk the profile anchors
// with createRequire().resolve(). Cross-realm safety is guaranteed by schemastery's
// global Symbol.for('schemastery') registry: any copy produces compatible schemas.

import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

const SPEC = '@deepseek-ai/schemastery'

function anchors() {
  const out = []
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p)
  }
  push(process.env.DSH_PROFILE_DIR)
  if (process.env.DSH_HOME && process.env.DSH_PROFILE) {
    push(join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE))
  }
  const profilesRoot = join(homedir(), '.dsh', 'profiles')
  try {
    if (existsSync(profilesRoot)) {
      for (const name of readdirSync(profilesRoot)) {
        push(join(profilesRoot, name))
      }
    }
  } catch {
    // Non-fatal: a missing profiles directory just means this anchor is skipped.
  }
  return out
}

async function loadFromAnchor(anchor) {
  const requireFrom = createRequire(join(anchor, 'package.json'))
  const pkgPath = requireFrom.resolve(`${SPEC}/package.json`)
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const entry = pkg.exports?.['.'] ?? pkg.module ?? pkg.main
  const target = typeof entry === 'string'
    ? entry
    : (entry?.import ?? entry?.require ?? entry?.default)
  if (!target) return undefined
  const abs = join(dirname(pkgPath), target)
  const mod = await import(pathToFileURL(abs).href)
  return mod.default ?? mod
}

export async function loadHostSchemastery() {
  try {
    const mod = await import(SPEC)
    const z = mod.default ?? mod
    if (typeof z?.object === 'function') return z
  } catch {
    // Fall through to anchor resolution.
  }
  for (const anchor of anchors()) {
    try {
      const z = await loadFromAnchor(anchor)
      if (typeof z?.object === 'function') return z
    } catch {
      // Try the next anchor.
    }
  }
  return undefined
}
