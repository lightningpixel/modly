import { useEffect, useState } from 'react'
import { Section, Card, Row } from '@shared/ui'

export function IntegrationsSection(): JSX.Element {
  const [token,    setToken]    = useState('')
  const [visible,  setVisible]  = useState(false)
  const [status,   setStatus]   = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  useEffect(() => {
    window.electron.settings.get().then((s) => {
      setToken(s.hfToken ?? '')
    })
  }, [])

  async function handleSave() {
    setStatus('saving')
    try {
      await window.electron.settings.set({ hfToken: token.trim() })
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 2500)
    } catch {
      setStatus('error')
      setTimeout(() => setStatus('idle'), 3000)
    }
  }

  async function handleClear() {
    setToken('')
    setStatus('saving')
    try {
      await window.electron.settings.set({ hfToken: '' })
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 2500)
    } catch {
      setStatus('error')
      setTimeout(() => setStatus('idle'), 3000)
    }
  }

  return (
    <Section title="Integrations" subtitle="API keys and tokens for external services.">
      <div className="grid grid-cols-2 gap-4">
        <Card
          title="HuggingFace Hub"
          description="Required to download gated models such as Stable Fast 3D. Generate a token at huggingface.co/settings/tokens."
        >
          <Row label="Access Token" description="Must have at least 'Read' permission.">
            <div className="flex items-center gap-2 w-full">
              <div className="relative flex-1">
                <input
                  type={visible ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => { setToken(e.target.value); setStatus('idle') }}
                  onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                  placeholder="hf_…"
                  spellCheck={false}
                  className="w-full px-3 py-1.5 pr-8 rounded-lg bg-zinc-800 border border-zinc-700/60 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setVisible((v) => !v)}
                  title={visible ? 'Hide token' : 'Show token'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400 transition-colors"
                >
                  {visible ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/>
                      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  )}
                </button>
              </div>

              {token && (
                <button
                  onClick={handleClear}
                  title="Remove token"
                  className="text-zinc-600 hover:text-red-400 transition-colors shrink-0"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              )}

              <button
                onClick={handleSave}
                disabled={status === 'saving'}
                className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-50 ${
                  status === 'saved' ? 'bg-emerald-500/15 text-emerald-400' :
                  status === 'error' ? 'bg-red-500/15 text-red-400' :
                  'bg-accent/15 hover:bg-accent/25 text-accent-light'
                }`}
              >
                {status === 'saving' ? 'Saving…' :
                 status === 'saved'  ? 'Saved'   :
                 status === 'error'  ? 'Failed'  :
                 'Save'}
              </button>
            </div>
          </Row>
        </Card>
      </div>
    </Section>
  )
}
