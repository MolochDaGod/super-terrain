import { describe, expect, it } from 'vitest'
import { createWeightPaintStroke } from '../modifiers/factories'
import { encodeModifiers, type CompileSectionRequest } from '../workers/protocol'
import { compileTerrainSection, evaluateHeight } from './compileSection'
import { repaintCompiledSection } from './PaintWeights'

describe('compiled paint weights', () => {
  it('repaints every LOD exactly from provenance without rebuilding geometry', () => {
    const initial = compileTerrainSection(request([]))
    const point = { x: 64, y: evaluateHeight(64, 64, 17, []), z: 64 }
    const paint = createWeightPaintStroke({
      point,
      channel: 'channel3',
      mode: 'add',
      radius: 31,
      strength: 0.7,
      falloff: 0.35,
    })

    const repainted = repaintCompiledSection(initial, 2, 128, [paint])!
    const rebuilt = compileTerrainSection(request([paint], 2))

    expect(repainted.sourceRevision).toBe(2)
    expect(repainted.metadata.compileMs).toBe(0)
    for (let index = 0; index < initial.lods.length; index += 1) {
      expect(repainted.lods[index].positions).toBe(initial.lods[index].positions)
      expect(repainted.lods[index].indices).toBe(initial.lods[index].indices)
      expect(repainted.lods[index].normals).toBe(initial.lods[index].normals)
      expect(repainted.lods[index].surfaceFields).toBe(
        initial.lods[index].surfaceFields,
      )
      expect(repainted.lods[index].paintWeights).toEqual(
        rebuilt.lods[index].paintWeights,
      )
    }
  })

  it('repaints a coarse-only legacy artifact directly without rebuilding it', () => {
    const coarseOnly = compileTerrainSection({ ...request([]), levels: [2] })
    const repainted = repaintCompiledSection(coarseOnly, 2, 128, [])!
    expect(repainted.sourceRevision).toBe(2)
    expect(repainted.lods[0].positions).toBe(coarseOnly.lods[0].positions)
    expect(repainted.lods[0].paintWeights).toEqual(
      new Uint16Array((coarseOnly.lods[0].positions.length / 3) * 4),
    )
  })
})

function request(
  modifiers: Parameters<typeof encodeModifiers>[0],
  revision = 1,
): CompileSectionRequest {
  return {
    kind: 'compile-section',
    jobId: 1,
    key: { x: 0, z: 0 },
    revision,
    priority: 1,
    config: {
      sectionSize: 128,
      lodResolutions: [16, 8, 4],
      seed: 17,
      operationHalo: 8,
    },
    modifiers: encodeModifiers(modifiers),
  }
}
