import { useState, useEffect, useCallback } from 'react'
import {
  useAgentStore, PROVIDERS,
  type ThinkingMode, type ProviderId, type ExternalConfig,
} from '@shared/stores/agentStore'
import { useAppStore } from '@shared/stores/appStore'
import { consumeSse, type SseEvent } from '@shared/services/llmDownloads'
import { SseProgressBar } from '@shared/components/ui/SseProgressBar'
import { ModelLibraryModal } from '@shared/components/ui/ModelLibraryModal'
import type { LlmModel } from '@shared/stores/llmModelsStore'
import { formatBytes } from '@shared/utils/format'
import { Section, Card, SegmentedControl } from '@shared/ui'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A labelled block inside a Card, for controls that need the full width. */
function Block({ label, description, hint, action, children }: {
  label?: string
  description?: string
  hint?: string
  action?: React.ReactNode
  children?: React.ReactNode
}): JSX.Element {
  return (
    <div className="px-4 py-3 flex flex-col gap-2">
      {(label || action) && (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {label && <p className="text-xs font-medium text-zinc-300">{label}</p>}
            {description && <p className="text-[11px] text-zinc-500 mt-0.5">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
      {hint && <p className="text-[11px] text-zinc-500 leading-relaxed">{hint}</p>}
    </div>
  )
}

function Badge({ tone, children }: { tone: 'accent' | 'warn' | 'muted'; children: React.ReactNode }): JSX.Element {
  const cls = tone === 'accent'
    ? 'bg-accent/15 text-accent-light border-accent/30'
    : tone === 'warn'
      ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
      : 'bg-zinc-800 text-zinc-400 border-zinc-700'
  const dot = tone === 'accent' ? 'bg-accent-light' : tone === 'warn' ? 'bg-amber-400' : null
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[10.5px] font-medium ${cls}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
      {children}
    </span>
  )
}

function CopyButton({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      onClick={() => { void navigator.clipboard.writeText(text); setCopied(true) }}
      className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-200 transition-colors"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function StepTitle({ n, children }: { n: number; children: React.ReactNode }): JSX.Element {
  return (
    <p className="text-xs font-medium text-zinc-300">
      <span className="mr-2 text-accent-light">{n}</span>{children}
    </p>
  )
}

const inputCls = 'w-full bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-accent/50'
const secondaryBtnCls = 'px-2.5 py-1 rounded-md text-[11px] font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-50'
const primaryBtnCls = 'px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-dark text-white text-xs font-medium transition-colors'

type McpClient = 'claude' | 'codex' | 'opencode'

const MCP_CLIENTS: { value: McpClient; label: string; path: string; config: string }[] = [
  {
    value:  'claude',
    label:  'Claude Desktop',
    path:   '~/.config/claude/claude_desktop_config.json',
    config: `{\n  "mcpServers": {\n    "modly": {\n      "command": "modly-mcp"\n    }\n  }\n}`,
  },
  {
    value:  'codex',
    label:  'Codex CLI',
    path:   '~/.codex/config.toml',
    config: `[mcp_servers.modly]\ncommand = "modly-mcp"`,
  },
  {
    value:  'opencode',
    label:  'OpenCode',
    path:   '~/.config/opencode/config.json',
    config: `{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "modly": {\n      "type": "local",\n      "command": ["modly-mcp"]\n    }\n  }\n}`,
  },
]

const MCP_INSTALL = 'npm install -g modly-cli-mcp'

const THINKING_OPTIONS: { value: ThinkingMode; label: string; desc: string }[] = [
  { value: 'auto', label: 'Auto',     desc: 'The model decides whether to think' },
  { value: 'on',   label: 'Enabled',  desc: 'Forces thinking on every response' },
  { value: 'off',  label: 'Disabled', desc: 'Disables thinking (faster responses)' },
]

// ─── Component ────────────────────────────────────────────────────────────────

export function AgentSection(): JSX.Element {
  const {
    provider, localModel, external, defaultThinking,
    setProvider, setExternal, setDefaultThinking,
  } = useAgentStore()
  const apiUrl = useAppStore((s) => s.apiUrl)

  // Local engine
  const [engineInstalled, setEngineInstalled] = useState<boolean | null>(null)
  const [engineInstall, setEngineInstall]     = useState<SseEvent | null>(null)
  const [engineError, setEngineError]         = useState<string | null>(null)
  const [models, setModels]                   = useState<LlmModel[]>([])
  const [showLibrary, setShowLibrary]         = useState(false)
  const [maxModels, setMaxModels]             = useState<string>('auto')
  const [resolvedMax, setResolvedMax]         = useState<number | null>(null)
  const [vramGb, setVramGb]                   = useState<number | null>(null)

  // External provider drafts
  const extCfg = external[provider]
  const [keyDraft, setKeyDraft]           = useState(extCfg?.apiKey ?? '')
  const [extModelDraft, setExtModelDraft] = useState(extCfg?.model ?? '')
  const [baseUrlDraft, setBaseUrlDraft]   = useState(extCfg?.baseUrl ?? '')
  const [extModels, setExtModels]         = useState<string[]>([])
  const [extTesting, setExtTesting]       = useState(false)
  const [extResult, setExtResult]         = useState<'ok' | 'error' | null>(null)

  const [mcpClient, setMcpClient] = useState<McpClient>('claude')

  const refreshLocal = useCallback(async () => {
    try {
      const [s, m, c] = await Promise.all([
        fetch(`${apiUrl}/llm/status`).then((r) => r.json()),
        fetch(`${apiUrl}/llm/models?downloaded=true`).then((r) => r.json()),
        fetch(`${apiUrl}/llm/config`).then((r) => r.json()),
      ])
      setEngineInstalled(Boolean(s.binary_installed))
      setModels(m.models ?? [])
      setMaxModels(String(c.max_models ?? 'auto'))
      setResolvedMax(c.resolved_max_models ?? null)
      setVramGb(c.vram_gb ?? null)
    } catch {
      setEngineInstalled(null)
    }
  }, [apiUrl])

  async function installEngine() {
    setEngineInstall({ percent: 0, status: 'Starting…' })
    setEngineError(null)
    try {
      await consumeSse(`${apiUrl}/llm/binary/install`, (e) => {
        if (e.error) setEngineError(e.error)
        else setEngineInstall(e)
      })
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : String(e))
    } finally {
      setEngineInstall(null)
      void refreshLocal()
    }
  }

  async function changeMaxModels(value: string) {
    setMaxModels(value)
    try {
      const res = await fetch(`${apiUrl}/llm/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_models: value === 'auto' ? 'auto' : Number(value) }),
      })
      const data = await res.json()
      setResolvedMax(data.resolved_max_models ?? null)
    } catch { /* API unreachable — keep the optimistic value, refreshLocal will resync */ }
  }

  useEffect(() => { void refreshLocal() }, [refreshLocal])

  // Sync drafts when switching provider
  useEffect(() => {
    const cfg = useAgentStore.getState().external[provider]
    setKeyDraft(cfg?.apiKey ?? '')
    setExtModelDraft(cfg?.model ?? '')
    setBaseUrlDraft(cfg?.baseUrl ?? '')
    setExtModels([])
    setExtResult(null)
  }, [provider])

  function saveExternal() {
    const cfg: ExternalConfig = { apiKey: keyDraft.trim(), model: extModelDraft.trim() }
    if (provider === 'custom') cfg.baseUrl = baseUrlDraft.trim().replace(/\/$/, '')
    setExternal(provider, cfg)
  }

  async function handleTestExternal() {
    setExtTesting(true)
    setExtResult(null)
    try {
      const base = provider === 'custom' ? baseUrlDraft.trim().replace(/\/$/, '') : PROVIDERS[provider].baseUrl
      // POST, not a query string: a GET would put the API key in the uvicorn
      // access log, which ends up in runtime.log and in users' bug reports.
      const res = await fetch(`${apiUrl}/agent/external/models`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ base_url: base, api_key: keyDraft.trim() }),
      })
      const data: { models?: string[] } = await res.json()
      const found = (data.models ?? []).length > 0
      setExtModels(data.models ?? [])
      setExtResult(found ? 'ok' : 'error')
    } catch {
      setExtResult('error')
    } finally {
      setExtTesting(false)
    }
  }

  const selectedModel = models.find((m) => m.id === localModel)
  const client        = MCP_CLIENTS.find((c) => c.value === mcpClient) ?? MCP_CLIENTS[0]

  return (
    <Section title="Agent" subtitle="Configure the LLM powering the chat — fully local by default.">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">

        {/* ── Left column ── */}
        <div className="flex flex-col gap-4 min-w-0">

          <Card title="Provider" description="Which model answers in the chat.">
            <Block label="LLM provider" hint="Local runs entirely on this machine via llama.cpp. External providers require an API key.">
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as ProviderId)}
                className={`${inputCls} cursor-pointer`}
              >
                {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => (
                  <option key={p} value={p}>{PROVIDERS[p].label}</option>
                ))}
              </select>
            </Block>
          </Card>

          {provider === 'local' ? (
            <Card
              title="Local engine"
              description="llama.cpp runtime and the models it can load."
              aside={
                engineInstalled === null ? <Badge tone="muted">API unreachable</Badge>
                  : engineInstalled ? <Badge tone="accent">Engine installed</Badge>
                  : <Badge tone="warn">Engine missing</Badge>
              }
            >
              {engineInstalled === false && (
                <Block>
                  {engineInstall ? (
                    <SseProgressBar event={engineInstall} />
                  ) : (
                    <button onClick={() => void installEngine()} className={`self-start ${primaryBtnCls}`}>
                      Install engine
                    </button>
                  )}
                  {engineError && <p className="text-[11px] text-red-400">{engineError}</p>}
                </Block>
              )}
              {engineInstalled === null && (
                <Block>
                  <button onClick={() => void refreshLocal()} className={`self-start ${secondaryBtnCls}`}>Retry</button>
                </Block>
              )}

              <Block
                label="Models"
                description="GGUF weights available to the agent."
                action={<button onClick={() => setShowLibrary(true)} className={secondaryBtnCls}>Browse…</button>}
              >
                {selectedModel ? (
                  <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-500 border border-zinc-800">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-500 shrink-0">
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                      <polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" />
                    </svg>
                    <div className="min-w-0 flex-1 flex items-baseline gap-2">
                      <span className="text-xs font-medium text-zinc-200 truncate">{selectedModel.name}</span>
                      <span className="text-[10px] text-zinc-500 font-mono truncate">
                        {[
                          selectedModel.size_bytes ? formatBytes(selectedModel.size_bytes) : null,
                          selectedModel.quant,
                          selectedModel.vram_estimate_mb ? `~${(selectedModel.vram_estimate_mb / 1000).toFixed(1)} GB VRAM` : null,
                        ].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <Badge tone="accent">In use</Badge>
                  </div>
                ) : (
                  <p className="px-3 py-2 rounded-lg bg-surface-500 border border-zinc-800 text-[11px] text-zinc-500">
                    {models.length === 0
                      ? 'No model yet — open Browse… to add or download one.'
                      : 'No model selected — open Browse… and select one.'}
                  </p>
                )}
              </Block>

              <Block
                label="Simultaneous models"
                hint="How many local models may stay loaded at once (one llama-server process each). Auto sizes it from your GPU's VRAM — on 8 GB cards keep 1 so 3D generation always has room."
              >
                <select
                  value={maxModels}
                  onChange={(e) => void changeMaxModels(e.target.value)}
                  className={`${inputCls} cursor-pointer`}
                >
                  <option value="auto">
                    Auto{resolvedMax != null ? ` — ${resolvedMax} model${resolvedMax > 1 ? 's' : ''}${vramGb != null ? ` (${vramGb} GB VRAM)` : ''}` : ''}
                  </option>
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={String(n)}>{n}</option>
                  ))}
                </select>
              </Block>
            </Card>
          ) : (
            <Card title={PROVIDERS[provider].label} description="Connection used for the chat.">
              {provider === 'custom' && (
                <Block label="Base URL" hint="Any OpenAI-compatible endpoint (llama-server, vLLM, LM Studio…). Without the trailing /chat/completions.">
                  <input
                    value={baseUrlDraft}
                    onChange={(e) => { setBaseUrlDraft(e.target.value); setExtResult(null) }}
                    placeholder="http://192.168.1.20:8080/v1"
                    className={inputCls}
                  />
                </Block>
              )}

              <Block
                label={PROVIDERS[provider].noKey ? 'API key (optional)' : 'API key'}
                hint={PROVIDERS[provider].noKey
                  ? 'Not needed for a local Ollama — models already pulled with it are reused as-is.'
                  : 'Stored locally on this machine only.'}
              >
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={keyDraft}
                    onChange={(e) => { setKeyDraft(e.target.value); setExtResult(null) }}
                    placeholder={PROVIDERS[provider].noKey ? '' : 'sk-…'}
                    className={inputCls}
                  />
                  <button onClick={handleTestExternal} disabled={extTesting} className={`shrink-0 ${secondaryBtnCls}`}>
                    {extTesting ? 'Testing…' : 'Test'}
                  </button>
                </div>
                {extResult === 'ok' && (
                  <p className="text-[11px] text-emerald-400">Connected — {extModels.length} model{extModels.length > 1 ? 's' : ''} available</p>
                )}
                {extResult === 'error' && (
                  <p className="text-[11px] text-red-400">
                    {provider === 'ollama'
                      ? 'Could not list models — is Ollama running?'
                      : `Could not list models — check the key${provider === 'custom' ? ' and URL' : ''}`}
                  </p>
                )}
              </Block>

              <Block label="Model" hint="Model name used for the chat.">
                {extModels.length > 0 ? (
                  <select value={extModelDraft} onChange={(e) => setExtModelDraft(e.target.value)} className={`${inputCls} cursor-pointer`}>
                    {/* Without it the browser shows the first model while the draft
                      * stays '' — Save then persisted an empty model name. */}
                    {!extModelDraft && <option value="" disabled>Select a model…</option>}
                    {!extModels.includes(extModelDraft) && extModelDraft && <option value={extModelDraft}>{extModelDraft}</option>}
                    {extModels.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input
                    value={extModelDraft}
                    onChange={(e) => setExtModelDraft(e.target.value)}
                    placeholder={provider === 'anthropic' ? 'claude-sonnet-5' : provider === 'openai' ? 'gpt-5.2' : provider === 'ollama' ? 'qwen2.5:3b' : 'model name'}
                    className={inputCls}
                  />
                )}
              </Block>

              <Block>
                <button onClick={saveExternal} className={`self-start ${primaryBtnCls}`}>Save</button>
              </Block>
            </Card>
          )}

          <Card title="Thinking" description="Default mode — can be changed on the fly in the chat via the brain icon.">
            <div className="px-4 py-3 flex flex-col gap-3">
              {THINKING_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-start gap-3 cursor-pointer group">
                  <input
                    type="radio"
                    name="thinking"
                    value={opt.value}
                    checked={defaultThinking === opt.value}
                    onChange={() => setDefaultThinking(opt.value)}
                    className="mt-0.5 accent-violet-500"
                  />
                  <div>
                    <p className="text-xs font-medium text-zinc-300 group-hover:text-zinc-100 transition-colors">{opt.label}</p>
                    <p className="text-[11px] text-zinc-500">{opt.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </Card>
        </div>

        {/* ── Right column ── */}
        <div className="flex flex-col gap-4 min-w-0">
          <Card
            title="MCP server"
            description={<>Control Modly from Claude Desktop, Codex or OpenCode. Community package by <span className="text-zinc-300">DrHepa</span>.</>}
            aside={<Badge tone="muted">Community</Badge>}
          >
            <Block>
              <StepTitle n={1}>Install the package</StepTitle>
              <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-surface-500 border border-zinc-800">
                <code className="text-[11px] font-mono text-zinc-300 truncate">
                  <span className="text-zinc-600 mr-2">$</span>{MCP_INSTALL}
                </code>
                <CopyButton text={MCP_INSTALL} />
              </div>
            </Block>

            <Block>
              <StepTitle n={2}>Add it to your client</StepTitle>
              <div>
                <SegmentedControl
                  value={mcpClient}
                  onChange={setMcpClient}
                  options={MCP_CLIENTS.map(({ value, label }) => ({ value, label }))}
                  ariaLabel="MCP client"
                />
              </div>
              <div className="rounded-lg bg-surface-500 border border-zinc-800 overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-zinc-800/80">
                  <p className="text-[11px] text-zinc-300 truncate">
                    {client.label}
                    <span className="ml-2 font-mono text-[10px] text-zinc-600">{client.path}</span>
                  </p>
                  <CopyButton text={client.config} />
                </div>
                <pre className="px-3 py-3 text-[11px] font-mono text-zinc-400 leading-relaxed overflow-x-auto whitespace-pre">
                  {client.config}
                </pre>
              </div>
            </Block>
          </Card>
        </div>
      </div>

      {showLibrary && (
        <ModelLibraryModal onClose={() => { setShowLibrary(false); void refreshLocal() }} />
      )}
    </Section>
  )
}
