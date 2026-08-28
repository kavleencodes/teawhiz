import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest.json' with { type: 'json' }

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'ES2020',
  },
  server: {
    hmr: {
      host: 'localhost',
      port: 5173,
      protocol: 'ws'
    },
    middlewareMode: false,
  },
  preview: {
    port: 5173,
  },
})
