import type { SseEvent } from '@shared/services/llmDownloads'
import { formatBytes } from '@shared/utils/format'

/** Progress of an SSE-driven download or install (engine, GGUF models). */
export function SseProgressBar({ event }: { event: SseEvent }): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px] text-zinc-500">
        <span className="truncate">{event.status}</span>
        <span className="shrink-0">
          {event.totalBytes
            ? `${formatBytes(event.bytesDownloaded ?? 0)} / ${formatBytes(event.totalBytes)}`
            : `${event.percent ?? 0}%`}
        </span>
      </div>
      <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full bg-accent rounded-full transition-all" style={{ width: `${event.percent ?? 0}%` }} />
      </div>
    </div>
  )
}
