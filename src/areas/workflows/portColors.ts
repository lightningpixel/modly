/**
 * Port colours, shared by node handles, type badges and edge gradients so the
 * three can't drift apart (they used to be copy-pasted in each file).
 */
export const HANDLE_COLOR: Record<string, string> = {
  audio: '#34d399',
  image: '#38bdf8',
  mesh:  '#a78bfa',
  text:  '#fbbf24',
}

export const FALLBACK_COLOR = '#52525b'

export const TAG_CLS: Record<string, string> = {
  audio: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  image: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
  mesh:  'border-violet-500/30 bg-violet-500/10 text-violet-400',
  text:  'border-amber-500/30 bg-amber-500/10 text-amber-400',
}

export const TAG_FALLBACK = 'border-zinc-700 bg-zinc-800 text-zinc-400'
