import { useLayoutEffect, useRef, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { WFNodeData } from '@shared/types/electron.d'
import { useAgentStore } from '@shared/stores/agentStore'
import LlmModelSelect from '@shared/components/ui/LlmModelSelect'
import { useWorkflowRunStore } from '../workflowRunStore'
import { HANDLE_COLOR } from '../portColors'
import BaseNode from './BaseNode'

const TEXT_COLOR = HANDLE_COLOR.text

const inputCls = 'nodrag w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus:border-amber-500/40'

/**
 * LLM node — runs a prompt through a local llama.cpp model and outputs text.
 * The user prompt is the incoming text connection when present, otherwise the
 * node's own Prompt field. Model list comes from the local model library.
 */
export default function LLMNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData } = useReactFlow()
  const ioRowRef = useRef<HTMLDivElement>(null)
  const [handleTop, setHandleTop] = useState('50%')

  const defaultModel = useAgentStore((s) => s.localModel)
  const lastOutput   = useWorkflowRunStore((s) => s.nodeTextOutputs[id])

  useLayoutEffect(() => {
    if (ioRowRef.current) {
      const center = ioRowRef.current.offsetTop + ioRowRef.current.offsetHeight / 2
      setHandleTop(`${center}px`)
    }
  }, [])

  const model       = (data.params.model as string | undefined) ?? defaultModel
  const system      = (data.params.system as string | undefined) ?? ''
  const prompt      = (data.params.prompt as string | undefined) ?? ''
  const temperature = (data.params.temperature as number | undefined) ?? 0.7
  const maxTokens   = (data.params.maxTokens as number | undefined) ?? undefined

  const patch = (key: string, value: unknown) => {
    const params = { ...data.params, [key]: value }
    updateNodeData(id, { params })
    // Push live so a paused/looping run picks up the change on the next node start.
    useWorkflowRunStore.getState().setLiveNodeParams(id, params)
  }

  return (
    <BaseNode
      id={id}
      selected={selected}
      title="LLM"
      badge="llama.cpp"
      enabled={data.enabled ?? true}
      showInGenerate={data.showInGenerate ?? false}
      minWidth={230}
      autoHeight
      icon={
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={TEXT_COLOR} strokeWidth="2">
          <path d="M9.9 2.8l1.6 4.2 4.2 1.6-4.2 1.6-1.6 4.2-1.6-4.2-4.2-1.6 4.2-1.6z"/>
          <path d="M18 13l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z"/>
        </svg>
      }
      subheader={
        <div ref={ioRowRef} className="flex items-center justify-between px-3 py-2">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-amber-500/30 bg-amber-500/10 text-amber-400">text</span>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600 shrink-0">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border border-amber-500/30 bg-amber-500/10 text-amber-400">text</span>
        </div>
      }
      handles={
        <>
          <Handle type="target" position={Position.Left}
            style={{ background: TEXT_COLOR, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }} />
          <Handle type="source" position={Position.Right}
            style={{ background: TEXT_COLOR, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }} />
          {/* Model-provider output: feeds an extension's llm-model port instead of
              text, so one LLM node can configure the model for several nodes. */}
          <Handle id="llm" type="source" position={Position.Bottom}
            style={{ background: HANDLE_COLOR.llm, width: 12, height: 12, border: '2.5px solid #18181b' }} />
        </>
      }
    >
      <div className="px-3 pb-3 pt-2.5 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-zinc-500 w-16 shrink-0">Model</label>
          <div className="flex-1">
            <LlmModelSelect value={model} className={`${inputCls} w-full`} onChange={(v) => patch('model', v)} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-zinc-500 w-16 shrink-0">Temp</label>
          <input
            type="number" min={0} max={2} step={0.1} value={temperature}
            onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) patch('temperature', Math.min(2, Math.max(0, v))) }}
            className={`${inputCls} flex-1`}
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-zinc-500 w-16 shrink-0">Max tokens</label>
          <input
            type="number" min={1} step={64} value={maxTokens ?? ''} placeholder="unlimited"
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              patch('maxTokens', Number.isFinite(v) && v > 0 ? v : undefined)
            }}
            className={`${inputCls} flex-1`}
          />
        </div>
        <textarea
          value={system}
          onChange={(e) => patch('system', e.target.value)}
          placeholder="Instructions (system prompt, optional)…"
          rows={2}
          className={`${inputCls} resize-none leading-relaxed`}
        />
        <textarea
          value={prompt}
          onChange={(e) => patch('prompt', e.target.value)}
          placeholder="Prompt — ignored when a text connection is present…"
          rows={2}
          className={`${inputCls} resize-none leading-relaxed`}
        />
        {lastOutput !== undefined && (
          <div className="nodrag max-h-32 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/60 px-2.5 py-2">
            <p className="text-[10px] text-zinc-300 whitespace-pre-wrap leading-relaxed">{lastOutput}</p>
          </div>
        )}
      </div>
    </BaseNode>
  )
}
