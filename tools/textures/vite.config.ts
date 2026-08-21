import { defineConfig } from 'vite'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')

/**
 * SSR-bundles the texture preview harness so it runs the shipped procedural
 * bake code directly under Node.
 */
export default defineConfig({
  root,
  build: {
    ssr: true,
    outDir: resolve(root, '.textures'),
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    rollupOptions: {
      input: {
        preview: resolve(root, 'tools/textures/preview.ts'),
        debugFields: resolve(root, 'tools/textures/debugFields.ts'),
      },
      output: { entryFileNames: '[name].mjs' },
    },
  },
  ssr: { external: ['three'] },
})
