import { dirname, join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

export interface AppSettings {
  modelsDir:        string
  workspaceDir:     string
  workflowsDir:     string
  extensionsDir:    string
  dependenciesDir:  string
  /** Local LLM engine, GGUF models, logs and config used by the agent. */
  agentDir:         string
  hfToken?:         string
}

function settingsPath(userData: string): string {
  return join(userData, 'settings.json')
}

export function getSettings(userData: string): AppSettings {
  const defaults: Omit<AppSettings, 'agentDir'> = {
    modelsDir:        join(userData, 'models'),
    workspaceDir:     join(userData, 'workspace'),
    workflowsDir:     join(userData, 'workflows'),
    extensionsDir:    join(userData, 'extensions'),
    dependenciesDir:  join(userData, 'dependencies'),
  }

  const file = settingsPath(userData)
  if (!existsSync(file)) return withAgentDir(defaults)

  try {
    const saved = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>
    // Migrate legacy outputsDir key
    if (saved['outputsDir'] && !saved['workspaceDir']) {
      saved['workspaceDir'] = saved['outputsDir']
      delete saved['outputsDir']
    }
    return withAgentDir({ ...defaults, ...saved })
  } catch {
    return withAgentDir(defaults)
  }
}

/**
 * Installs set up before agentDir existed have their data folders under the base
 * chosen at first run (<base>/models, <base>/extensions, …). Defaulting agentDir
 * to userData would put the agent's multi-GB engine and models apart from all of
 * them, so it defaults to a sibling of modelsDir instead.
 */
function withAgentDir(settings: Omit<AppSettings, 'agentDir'> & { agentDir?: string }): AppSettings {
  return { ...settings, agentDir: settings.agentDir || join(dirname(settings.modelsDir), 'agent') }
}

/**
 * Create the agent folder, and pin it in settings.json for installs that predate
 * it. Until pinned it is derived from modelsDir, so moving the models folder in
 * Settings → Storage would silently take the agent folder (engine, GGUF models)
 * somewhere else. A fresh install has no settings.json yet: setup writes it.
 */
export function ensureAgentDir(userData: string): string {
  const { agentDir } = getSettings(userData)
  const file = settingsPath(userData)
  if (existsSync(file)) {
    let saved: Record<string, unknown> | null = null
    try {
      saved = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    } catch { /* unreadable: leave it as is */ }
    if (saved && !saved['agentDir']) setSettings(userData, { agentDir })
  }
  mkdirSync(agentDir, { recursive: true })
  return agentDir
}

export function setSettings(userData: string, patch: Partial<AppSettings>): AppSettings {
  const updated = { ...getSettings(userData), ...patch }
  writeFileSync(settingsPath(userData), JSON.stringify(updated, null, 2), 'utf-8')
  return updated
}
