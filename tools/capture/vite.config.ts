import { defineConfig } from 'vite'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')

/**
 * The capture harness imports the app's TypeScript terrain modules directly so
 * screenshots always reflect the shipped code. Vite's SSR build is only used to
 * transpile+bundle them for Node; every dependency stays external.
 */
export default defineConfig({
  root,
  build: {
    ssr: resolve(root, 'tools/capture/main.ts'),
    outDir: resolve(root, '.capture'),
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
