import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The API is served by server/index.js; in dev, Vite proxies to it so the
// frontend talks to the same URLs in both modes.
export default defineConfig({
  plugins: [react()],
  server: { port: 4302, proxy: { '/api': 'http://127.0.0.1:4300' } },
  build: { outDir: 'dist', emptyOutDir: true },
})
