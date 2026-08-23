import { describe, expect, it } from 'vitest'
import { DEFAULT_TERRAIN_CONFIG } from '../config'
import {
  createBrushStroke,
  createNoiseModifier,
  createSculptLayerModifier,
} from '../modifiers/factories'
import type { BrushStrokeModifier } from '../modifiers/types'
import { CompiledSectionCacheSignatures } from './CompiledSectionCache'

describe('compiled section cache signatures', () => {
  it('ignores editor IDs while preserving geometry and stack order', async () => {
    const first = createNoiseModifier({
      min: { x: 0, y: -10, z: 0 },
      max: { x: 128, y: 80, z: 128 },
    })
    const second = structuredClone(first)
    first.id = 'noise-first-session'
    second.id = 'noise-restored-session'

    const signatures = new CompiledSectionCacheSignatures()
    const left = await signatures.create(
      DEFAULT_TERRAIN_CONFIG,
      { x: 0, z: 0 },
      [first],
      1,
    )
    const right = await signatures.create(
      DEFAULT_TERRAIN_CONFIG,
      { x: 0, z: 0 },
      [second],
      1,
    )

    expect(right).toBe(left)
    second.amplitude += 0.25
    const changed = await signatures.create(
      DEFAULT_TERRAIN_CONFIG,
      { x: 0, z: 0 },
      [second],
      2,
    )
    expect(changed).not.toBe(left)
  })

  it('folds sculpt-layer state into its referenced brush without hashing layer IDs', async () => {
    const firstLayer = createSculptLayerModifier('Detail')
    firstLayer.id = 'layer-one'
    firstLayer.opacity = 0.55
    const firstStroke = createBrush(firstLayer.id)

    const secondLayer = structuredClone(firstLayer)
    secondLayer.id = 'layer-two'
    const secondStroke = structuredClone(firstStroke)
    secondStroke.id = 'stroke-two'
    secondStroke.sculptLayerId = secondLayer.id

    const signatures = new CompiledSectionCacheSignatures()
    const first = await signatures.create(
      DEFAULT_TERRAIN_CONFIG,
      { x: 2, z: -1 },
      [firstLayer, firstStroke],
      1,
    )
    const restored = await signatures.create(
      DEFAULT_TERRAIN_CONFIG,
      { x: 2, z: -1 },
      [secondLayer, secondStroke],
      1,
    )
    expect(restored).toBe(first)

    secondLayer.opacity = 0.9
    const edited = await signatures.create(
      DEFAULT_TERRAIN_CONFIG,
      { x: 2, z: -1 },
      [secondLayer, secondStroke],
      2,
    )
    expect(edited).not.toBe(first)
  })

  it('includes section and compiler config in the cache identity', async () => {
    const signatures = new CompiledSectionCacheSignatures()
    const origin = await signatures.create(
      DEFAULT_TERRAIN_CONFIG,
      { x: 0, z: 0 },
      [],
      0,
    )
    const neighbor = await signatures.create(
      DEFAULT_TERRAIN_CONFIG,
      { x: 1, z: 0 },
      [],
      0,
    )
    const changedResolution = await signatures.create(
      { ...DEFAULT_TERRAIN_CONFIG, lodResolutions: [90, 44, 22, 11, 6] },
      { x: 0, z: 0 },
      [],
      0,
    )
    const changedProfile = await signatures.create(
      { ...DEFAULT_TERRAIN_CONFIG, worldProfile: 'flat' },
      { x: 0, z: 0 },
      [],
      0,
    )

    expect(neighbor).not.toBe(origin)
    expect(changedResolution).not.toBe(origin)
    expect(changedProfile).not.toBe(origin)
  })
})

function createBrush(sculptLayerId: string): BrushStrokeModifier {
  const stroke = createBrushStroke({
    point: { x: 280, y: 42, z: -90 },
    normal: { x: 0, y: 1, z: 0 },
    mode: 'raise',
    radius: 12,
    strength: 0.4,
    falloff: 0.6,
    sculptLayerId,
  })
  stroke.id = 'stroke-one'
  stroke.noiseSeed = 1234
  return stroke
}
