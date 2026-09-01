import type { PickerIntent } from '@shared/types/electron.d'

/**
 * Glyph for a param's browse button, matching the dialog it opens so the button
 * advertises what it does (folder = the historical default).
 */
export function PickerIcon({ intent, size = 11 }: { intent: PickerIntent; size?: number }): JSX.Element {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2 }

  if (intent === 'image') {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
    )
  }
  if (intent === 'mesh') {
    return (
      <svg {...common}>
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
      </svg>
    )
  }
  if (intent === 'text') {
    return (
      <svg {...common}>
        <path d="M17 6.1H3M21 12.1H3M15.1 18H3"/>
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
    </svg>
  )
}
