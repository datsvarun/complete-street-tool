import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative base + a dedicated assets dir so the built site can be committed
  // at the repo root for GitHub Pages (served from /complete-street-tool/,
  // and the root /assets folder already holds IRC reference documents).
  base: './',
  build: {
    assetsDir: 'app-assets',
  },
})
