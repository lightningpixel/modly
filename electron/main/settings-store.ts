import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

export interface AppSettings {
  modelsDir:        string
  workspaceDir:     string
  workflowsDir:     string
  extensionsDir:    string
  dependenciesDir:  string
}

function settingsPath(userData: string): string {
  return join(userData, 'settings.json')
}

export function getSettings(userData: string): AppSettings {
  const defaults: AppSettings = {
    modelsDir:        join(userData, 'models'),
    workspaceDir:     join(userData, 'workspace'),
    workflowsDir:     join(userData, 'workflows'),
    extensionsDir:    join(userData, 'extensions'),
    dependenciesDir:  join(userData, 'dependencies'),
  }

  const file = settingsPath(userData)
  if (!existsSync(file)) return defaults

  try {
    const saved = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>
    // Migrate legacy outputsDir key
    if (saved['outputsDir'] && !saved['workspaceDir']) {
      saved['workspaceDir'] = saved['outputsDir']
      delete saved['outputsDir']
    }
    return { ...defaults, ...saved }
  } catch {
    return defaults
  }
}

export function setSettings(userData: string, patch: Partial<AppSettings>): AppSettings {
  const updated = { ...getSettings(userData), ...patch }
  writeFileSync(settingsPath(userData), JSON.stringify(updated, null, 2), 'utf-8')
  return updated
}
