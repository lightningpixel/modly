/** The Modly mark, in its violet gradient. */
export default function ModlyLogo({ size = 64, className }: { size?: number, className?: string }): JSX.Element {
  return (
    <svg className={className} aria-label="Modly" role="img" width={size} height={size} viewBox="0 0 609 609" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="modly-logo-gradient" x1="700" y1="5700" x2="5900" y2="750" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#c084fc"/>
          <stop offset="45%" stopColor="#9333ea"/>
          <stop offset="100%" stopColor="#4c1d95"/>
        </linearGradient>
      </defs>
      <g transform="translate(0,609) scale(0.1,-0.1)" fill="url(#modly-logo-gradient)" stroke="none">
        <path d="M2964 5671 c-20 -9 -918 -521 -1604 -914 -173 -100 -362 -207 -420 -239 -58 -32 -118 -73 -133 -91 -58 -67 -57 -45 -57 -1067 0 -831 2 -938 16 -958 l15 -22 758 0 c417 0 761 3 764 6 12 13 -26 67 -283 399 -64 83 -120 156 -124 163 -5 7 4 32 22 60 16 26 238 396 493 822 254 426 569 951 699 1165 308 506 305 502 290 520 -7 8 -72 48 -144 87 -124 69 -135 73 -201 75 -38 2 -79 -1 -91 -6z"/>
        <path d="M3683 5328 c-18 -23 -833 -1306 -833 -1312 0 -12 83 -15 485 -21 230 -3 420 -7 421 -8 4 -5 451 -755 657 -1102 438 -739 668 -1120 691 -1143 l23 -24 71 36 c91 46 139 88 152 134 14 50 14 2403 0 2453 -20 72 -48 98 -215 193 -766 440 -1414 806 -1427 806 -9 0 -20 -6 -25 -12z"/>
        <path d="M4037 2838 c-25 -33 -443 -702 -467 -747 l-12 -24 -1384 4 c-1247 4 -1385 2 -1399 -12 -44 -44 -21 -170 42 -231 21 -20 203 -132 408 -249 385 -220 1034 -594 1310 -754 88 -51 183 -105 210 -121 28 -15 88 -49 134 -76 158 -90 177 -86 475 84 127 72 416 236 641 363 226 128 507 287 625 354 212 121 250 145 250 163 0 5 -40 73 -88 151 -49 78 -177 286 -284 462 -393 643 -407 664 -430 665 -4 0 -18 -15 -31 -32z"/>
      </g>
    </svg>
  )
}
