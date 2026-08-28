import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderCpuFrame, regionMean } from './cpuRender.ts'
import { createSimpleRoom, createSponzaAtrium, warmPipeline } from './scenes.ts'

describe('simple room color bleeding', () => {
  it('fills an unlit wall with bounced light once GI has run', () => {
    const scene = createSimpleRoom()
    warmPipeline(scene, 9)
    const camera = {
      position: scene.camera.position,
      target: scene.camera.target,
      fovY: scene.camera.fovY,
    }
    const off = renderCpuFrame(scene.pipeline, scene.voxel, camera, 128, 80, false)
    const on = renderCpuFrame(scene.pipeline, scene.voxel, camera, 128, 80, true)
    const [x0, y0, x1, y1] = scene.unlitRegion
    const meanOff = regionMean(off, x0, y0, x1, y1)
    const meanOn = regionMean(on, x0, y0, x1, y1)
    const lumaOff = meanOff[0] + meanOff[1] + meanOff[2]
    const lumaOn = meanOn[0] + meanOn[1] + meanOn[2]
    expect(lumaOff).toBeLessThan(40)
    expect(lumaOn).toBeGreaterThan(lumaOff + 8)
    // Red bleed from the lit wall onto the unlit (green) side.
    expect(meanOn[0]).toBeGreaterThan(meanOff[0] + 2)
  })
})

describe('sponza-like harder scene', () => {
  it('produces non-black indirect fill in the shadowed gallery', () => {
    const scene = createSponzaAtrium()
    warmPipeline(scene, 9)
    const camera = {
      position: scene.camera.position,
      target: scene.camera.target,
      fovY: scene.camera.fovY,
    }
    const off = renderCpuFrame(scene.pipeline, scene.voxel, camera, 96, 64, false)
    const on = renderCpuFrame(scene.pipeline, scene.voxel, camera, 96, 64, true)
    const [x0, y0, x1, y1] = scene.unlitRegion
    const meanOff = regionMean(off, x0, y0, x1, y1)
    const meanOn = regionMean(on, x0, y0, x1, y1)
    const lumaOn = meanOn[0] + meanOn[1] + meanOn[2]
    expect(lumaOn).toBeGreaterThan(meanOff[0] + meanOff[1] + meanOff[2])
    expect(lumaOn).toBeGreaterThan(6)
  })
})

describe('editor isolation', () => {
  const root = resolve(import.meta.dirname, '../../..')

  it('keeps the GI package out of the editor entry point', () => {
    const app = readFileSync(resolve(root, 'src/App.tsx'), 'utf8')
    const main = readFileSync(resolve(root, 'src/main.tsx'), 'utf8')
    const index = readFileSync(resolve(root, 'index.html'), 'utf8')
    expect(app).not.toMatch(/idtech-gi|SousaGI/)
    expect(main).not.toMatch(/idtech-gi|SousaGI/)
    expect(index).not.toMatch(/idtech-gi|gi\.html/)
    const giHtml = readFileSync(resolve(root, 'gi.html'), 'utf8')
    expect(giHtml).toMatch(/packages\/idtech-gi\/src\/demo\/main\.ts/)
    expect(giHtml).not.toMatch(/src\/main\.tsx/)
    expect(readFileSync(resolve(root, 'src/terrain/react/GraniteRockScene.tsx'), 'utf8')).not.toMatch(
      /idtech-gi|SousaGI/,
    )
  })

  it('loads the forest GI rig lazily, so switching it off costs nothing', () => {
    // The forest workspace may use the GI, but only behind a dynamic import:
    // it ships off by default and the tracing package — volume builders, probe
    // kernels, a distance transform — has no business in the editor's startup
    // path until someone asks for it.
    const scene = readFileSync(resolve(root, 'src/tree/TreeScene.tsx'), 'utf8')
    expect(scene).toMatch(/lazy\(/)
    expect(scene).toMatch(/import\('\.\/gi\/ForestGi'\)/)
    const staticImports = scene.matchAll(/^import[^\n]*from '([^']+)'/gm)
    for (const [, specifier] of staticImports) {
      expect(specifier).not.toMatch(/idtech-gi|\/gi\//)
    }
  })

  it('defaults the forest GI toggle to off', () => {
    const store = readFileSync(resolve(root, 'src/tree/TreeEditorStore.ts'), 'utf8')
    expect(store).toMatch(/\bgi: false,/)
  })
})
