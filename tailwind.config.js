/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        surface: {
          50:  '#f4f4f5',
          100: '#e4e4e7',
          200: '#27272a',
          300: '#1e1e21',
          400: '#18181b',
          500: '#111113',
        },
        accent: {
          DEFAULT: '#7c3aed',
          light:   '#a78bfa',
          dark:    '#5b21b6',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      keyframes: {
        slide: {
          '0%':   { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
      },
      animation: {
        slide: 'slide 1.5s ease-in-out infinite',
      },
    }
  },
  plugins: []
}
