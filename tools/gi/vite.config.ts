import { defineConfig } from 'vite'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')

export default defineConfig({
  root,
  build: {
    ssr: resolve(root, 'tools/gi/capture.ts'),
    outDir: resolve(root, '.capture-gi'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      output: { entryFileNames: 'capture.mjs' },
    },
  },
  ssr: {
    external: ['three', '@kmamal/gpu'],
  },
})
