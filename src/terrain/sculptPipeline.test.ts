/**
 * End-to-end checks that what the editor authors is what the worker compiles.
 *
 * The viewport preview and the compiler are two evaluations of one kernel, but
 * they are reached by different routes: the preview reads the modifier directly
 * while the compiler receives a copy across a worker boundary. Anything lost on
 * that crossing shows up as an edit that looks right while drawing and then
 * changes the moment it settles.
 */
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { WorldTerrain } from './WorldTerrain'
import { EditorStore } from './editor/EditorStore'
import type { TerrainRenderBackend } from './rendering/TerrainRenderBackend'
import { compileTerrainSection } from './compiler/compileSection'
import { encodeModifiers, type CompileSectionRequest } from './workers/protocol'
import { evaluateHeight } from './compiler/TerrainField'
import type { TerrainModifier } from './modifiers/types'

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
const OriginalWorker = globalThis.Worker
beforeEach(() => {
  globalThis.Worker = FakeWorker as never
})
afterEach(() => {
  globalThis.Worker = OriginalWorker
})

const memoryStorage = {
  load: async () => undefined,
  save: async () => {},
} as never

function backend(previewBrush: TerrainRenderBackend['previewBrush']): TerrainRenderBackend {
  return {
    upload: () => 0, has: () => false, setLod() {}, setVisible() {},
    setSectionState() {}, setOverlay() {}, setRenderMode() {},
    setMaterialSettings() {}, updateOcclusion() {},
    beginBrushPreview() {}, endBrushPreview() {},
    previewBrush, previewWeightPaint() {}, raycast: () => undefined,
    flushDeferredDisposals() {}, flushSectionBatches: () => 0, evict() {},
    stats: () => ({ gpuBytes: 0, residentSections: 0, visibleSections: 0, triangles: 0, trianglesByLod: [0,0,0,0,0] }),
    dispose() {},
  }
}

function compiledLiftAt(modifiers: TerrainModifier[], x: number, z: number): number {
  const request: CompileSectionRequest = {
    kind: 'compile-section', jobId: 1, key: { x: 0, z: 0 }, revision: 1, priority: 1,
    config: { sectionSize: 128, lodResolutions: [88], seed: 17, operationHalo: 12 },
    modifiers: encodeModifiers(modifiers),
  }
  const compiled = compileTerrainSection(request)
  const lod = compiled.lods[0]
  let best = -Infinity
  for (let offset = 0; offset < lod.positions.length; offset += 3) {
    const dx = lod.positions[offset] - x
    const dz = lod.positions[offset + 2] - z
    if (Math.hypot(dx, dz) < 3) best = Math.max(best, lod.positions[offset + 1])
  }
  return best - evaluateHeight(x, z, 17, [])
}

function heldRaiseLift(accumulate: boolean): number {
  const terrain = new WorldTerrain({ workerCount: 1, seed: 17 } as never, memoryStorage)
  terrain.attachRenderer(backend(vi.fn()))
  const editor = new EditorStore()
  editor.patch({
    tool: 'raise',
    brushDomain: 'mesh',
    brushRadius: 22,
    brushStrength: 1,
    brushAccumulate: accumulate,
  })
  const surfaceY = evaluateHeight(64, 64, 17, [])
  terrain.beginStroke({ x: 64, y: surfaceY, z: 64 }, { x: 0, y: 1, z: 0 }, editor.getSnapshot())
  for (let frame = 0; frame < 180; frame += 1) terrain.advanceActiveStroke(1 / 60)
  terrain.endStroke()
  const lift = compiledLiftAt(terrain.modifiers.snapshot(), 64, 64)
  terrain.dispose()
  return lift
}

it('compiles the stroke the editor actually authored, build-up setting included', () => {
  // Continuous build-up drove the preview correctly and then compiled as if it
  // were per-stroke, because the flag never crossed the worker boundary: three
  // seconds of holding settled back to roughly one stroke's worth.
  const perStroke = heldRaiseLift(false)
  const continuous = heldRaiseLift(true)
  expect(perStroke).toBeGreaterThan(0)
  expect(continuous).toBeGreaterThan(perStroke * 1.8)
})
