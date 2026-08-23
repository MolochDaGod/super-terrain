import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves this project from the repository subpath. Keep the
  // Vite dev server at the root while making production assets portable there.
  base: process.env.NODE_ENV === 'production' ? '/super-terrain/' : '/',
  plugins: [react(), tailwindcss()],
  assetsInclude: ['**/*.bin.gz'],
  worker: {
    format: 'es',
  },
})
