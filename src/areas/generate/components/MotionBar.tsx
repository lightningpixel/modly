export interface MotionClip {
  name: string
}

interface MotionBarProps {
  clips:       MotionClip[]
  activeIndex: number
  onChange:    (index: number) => void
}

function clipLabel(clip: MotionClip, index: number): string {
  return clip.name || `Motion ${index + 1}`
}

/** Bottom-left overlay for scrubbing a rigged model's animation clips. */
export function MotionBar({ clips, activeIndex, onChange }: MotionBarProps): JSX.Element | null {
  if (clips.length === 0) return null

  if (clips.length === 1) {
    return (
      <div className="flex items-center gap-2 bg-zinc-900/70 border border-zinc-700/50 backdrop-blur-sm rounded-xl px-3 py-1.5 pointer-events-none">
        <span className="text-[10px] text-zinc-500">Playing</span>
        <span className="text-xs text-zinc-300">{clipLabel(clips[0], 0)}</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 bg-zinc-900/70 border border-zinc-700/50 backdrop-blur-sm rounded-xl px-2 py-1.5">
      <span className="text-[10px] text-zinc-500 pl-1">Motion</span>
      <select
        value={activeIndex}
        onChange={(e) => onChange(Number(e.target.value))}
        className="bg-zinc-800 text-zinc-200 border border-zinc-700 rounded-md px-2 py-1 text-xs focus:outline-none focus:border-accent/60"
      >
        {clips.map((clip, i) => (
          <option key={i} value={i}>{clipLabel(clip, i)}</option>
        ))}
      </select>
      <button
        onClick={() => onChange((activeIndex + 1) % clips.length)}
        className="px-2 py-1 rounded-md text-[11px] font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors"
      >
        Next
      </button>
    </div>
  )
}
