import { MODLY_LOGO_PATHS, MODLY_LOGO_PATH_TRANSFORM, MODLY_LOGO_VIEWBOX_SIZE } from './modlyLogoPaths'

/** The Modly mark, in its violet gradient. */
export default function ModlyLogo({ size = 64, className }: { size?: number, className?: string }): JSX.Element {
  return (
    <svg className={className} aria-label="Modly" role="img" width={size} height={size} viewBox={`0 0 ${MODLY_LOGO_VIEWBOX_SIZE} ${MODLY_LOGO_VIEWBOX_SIZE}`} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="modly-logo-gradient" x1="700" y1="5700" x2="5900" y2="750" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#c084fc"/>
          <stop offset="45%" stopColor="#9333ea"/>
          <stop offset="100%" stopColor="#4c1d95"/>
        </linearGradient>
      </defs>
      <g transform={MODLY_LOGO_PATH_TRANSFORM} fill="url(#modly-logo-gradient)" stroke="none">
        {MODLY_LOGO_PATHS.map((d) => <path key={d} d={d}/>)}
      </g>
    </svg>
  )
}
