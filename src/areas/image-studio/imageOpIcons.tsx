// Header icons of the image ops, keyed by op id. An op the front end does not
// know yet (added to the backend registry) gets the wand.

const PATHS: Record<string, string> = {
  // Two crossing corner marks, as in photo editors.
  crop: 'M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14',
  // A subject cut out of a dashed backdrop.
  remove_background: 'M4 4h2M10 4h4M18 4h2v2M20 10v4M20 18v2h-2M14 20h-4M6 20H4v-2M4 14v-4M4 6V4M12 8a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM7.5 17.5a4.5 4.5 0 0 1 9 0',
  // Viewfinder corners around a centred square.
  auto_frame: 'M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M9 9h6v6H9z',
}

const WAND = 'M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5'

export function ImageOpIcon({ opId, size = 16 }: { opId: string, size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[opId] ?? WAND} />
    </svg>
  )
}
