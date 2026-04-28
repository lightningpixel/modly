import { useState, useEffect } from 'react'
import { useAgentStore, type ThinkingMode } from '@shared/stores/agentStore'
import { useAppStore } from '@shared/stores/appStore'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-medium text-zinc-300">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-zinc-600">{hint}</p>}
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">{title}</h3>
      {children}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AgentSection(): JSX.Element {
  const { ollamaUrl, defaultModel, defaultThinking, setOllamaUrl, setDefaultModel, setDefaultThinking } = useAgentStore()
  const apiUrl = useAppStore((s) => s.apiUrl)

  const [urlDraft, setUrlDraft]     = useState(ollamaUrl)
  const [modelDraft, setModelDraft] = useState(defaultModel)
  const [models, setModels]         = useState<string[]>([])
  const [testing, setTesting]       = useState(false)
  const [testResult, setTestResult] = useState<'ok' | 'error' | null>(null)

  useEffect(() => {
    setUrlDraft(ollamaUrl)
  }, [ollamaUrl])

  useEffect(() => {
    setModelDraft(defaultModel)
  }, [defaultModel])

  async function fetchModels(url: string) {
    try {
      const res = await fetch(`${apiUrl}/agent/models?ollama_url=${encodeURIComponent(url)}`)
      const data = await res.json()
      setModels(data.models ?? [])
    } catch {
      setModels([])
    }
  }

  async function handleTestConnection() {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch(`${apiUrl}/agent/models?ollama_url=${encodeURIComponent(urlDraft)}`)
      const data = await res.json()
      const found = (data.models ?? []).length > 0
      setTestResult(found ? 'ok' : 'error')
      if (found) setModels(data.models)
    } catch {
      setTestResult('error')
    } finally {
      setTesting(false)
    }
  }

  function handleSaveOllama() {
    setOllamaUrl(urlDraft)
    setDefaultModel(modelDraft)
    fetchModels(urlDraft)
  }

  const THINKING_OPTIONS: { value: ThinkingMode; label: string; desc: string }[] = [
    { value: 'auto', label: 'Auto',     desc: 'The model decides whether to think' },
    { value: 'on',   label: 'Enabled',  desc: 'Forces thinking on every response' },
    { value: 'off',  label: 'Disabled', desc: 'Disables thinking (faster responses)' },
  ]

  const mcpConfigs = {
    opencode: `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "modly": {\n      "type": "local",\n      "command": ["modly-mcp"]\n    }\n  }\n}`,
    codex: `[mcp_servers.modly]\ncommand = "modly-mcp"`,
    claude: `{\n  "mcpServers": {\n    "modly": {\n      "command": "modly-mcp"\n    }\n  }\n}`,
  }

  return (
    <div className="flex flex-col gap-8 max-w-xl">
      <div>
        <h2 className="text-[18px] font-semibold text-zinc-100 mb-1">Agent</h2>
        <p className="text-[12px] text-zinc-500">Configure the local LLM and Chat mode settings.</p>
      </div>

      {/* Ollama */}
      <Group title="Ollama">
        <Field label="Ollama URL" hint="Address of the Ollama server. Change this if you run Ollama on a remote machine.">
          <div className="flex gap-2">
            <input
              value={urlDraft}
              onChange={(e) => { setUrlDraft(e.target.value); setTestResult(null) }}
              className="flex-1 bg-zinc-900 border border-zinc-700/60 rounded-lg px-3 py-2 text-[12.5px] text-zinc-200 focus:outline-none focus:border-zinc-500"
              placeholder="http://localhost:11434"
            />
            <button
              onClick={handleTestConnection}
              disabled={testing}
              className="px-3 py-2 rounded-lg border border-zinc-700/60 bg-zinc-900 text-[12px] text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors disabled:opacity-50 shrink-0"
            >
              {testing ? 'Testing…' : 'Test'}
            </button>
          </div>
          {testResult === 'ok' && (
            <p className="text-[11px] text-emerald-400">Connection successful — {models.length} model{models.length > 1 ? 's' : ''} found</p>
          )}
          {testResult === 'error' && (
            <p className="text-[11px] text-red-400">Could not reach Ollama at this address</p>
          )}
        </Field>

        <Field label="Default model" hint="Model used when opening the chat. Can be changed on the fly in the chat.">
          {models.length > 0 ? (
            <select
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              className="bg-zinc-900 border border-zinc-700/60 rounded-lg px-3 py-2 text-[12.5px] text-zinc-200 focus:outline-none focus:border-zinc-500"
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <input
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              className="bg-zinc-900 border border-zinc-700/60 rounded-lg px-3 py-2 text-[12.5px] text-zinc-200 focus:outline-none focus:border-zinc-500"
              placeholder="gemma4:e4b"
            />
          )}
        </Field>

        <button
          onClick={handleSaveOllama}
          className="self-start px-4 py-2 rounded-lg bg-accent hover:bg-accent-dark text-white text-[12px] font-medium transition-colors"
        >
          Save
        </button>
      </Group>

      {/* Thinking */}
      <Group title="Thinking">
        <Field label="Default mode" hint="Can be changed on the fly in the chat via the brain icon.">
          <div className="flex flex-col gap-2">
            {THINKING_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-start gap-3 cursor-pointer group">
                <div className="mt-0.5">
                  <input
                    type="radio"
                    name="thinking"
                    value={opt.value}
                    checked={defaultThinking === opt.value}
                    onChange={() => setDefaultThinking(opt.value)}
                    className="accent-violet-500"
                  />
                </div>
                <div>
                  <p className="text-[12.5px] text-zinc-200 group-hover:text-white transition-colors">{opt.label}</p>
                  <p className="text-[11px] text-zinc-600">{opt.desc}</p>
                </div>
              </label>
            ))}
          </div>
        </Field>
      </Group>

      {/* MCP */}
      <Group title="MCP Server">
        <p className="text-[12px] text-zinc-400 leading-relaxed">
          Install this community package (made by <span className="text-zinc-300">DrHepa</span>) to control Modly from Claude Desktop, Codex or OpenCode:
        </p>
        <div className="relative">
          <pre className="bg-zinc-900 border border-zinc-700/60 rounded-lg px-4 py-3 text-[11px] text-zinc-400">npm install -g modly-cli-mcp</pre>
          <button
            onClick={() => navigator.clipboard.writeText('npm install -g modly-cli-mcp')}
            title="Copier"
            className="absolute top-2 right-2 text-zinc-600 hover:text-zinc-300 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-3">
          {([
            { label: 'Claude Desktop', key: 'claude'   as const, hint: '~/.config/claude/claude_desktop_config.json' },
            { label: 'Codex CLI',      key: 'codex'    as const, hint: '~/.codex/config.toml' },
            { label: 'OpenCode',       key: 'opencode' as const, hint: '~/.config/opencode/config.json' },
          ] as const).map(({ label, key, hint }) => (
            <div key={key}>
              <p className="text-[11px] text-zinc-500 mb-1.5">{label} <span className="text-zinc-700">— {hint}</span></p>
              <div className="relative">
                <pre className="bg-zinc-900 border border-zinc-700/60 rounded-lg px-4 py-3 text-[11px] text-zinc-400 overflow-x-auto leading-relaxed whitespace-pre">
                  {mcpConfigs[key]}
                </pre>
                <button
                  onClick={() => navigator.clipboard.writeText(mcpConfigs[key])}
                  title="Copier"
                  className="absolute top-2 right-2 text-zinc-600 hover:text-zinc-300 transition-colors"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      </Group>
    </div>
  )
}
