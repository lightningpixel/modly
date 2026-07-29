import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: import.meta.dirname,
  server: {
    host: '127.0.0.1',
    port: 4177,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, '../src/shared'),
    },
  },
  plugins: [react()],
})
