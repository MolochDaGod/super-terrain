import { describe, expect, it } from 'vitest'
import { DEFAULT_TERRAIN_CONFIG } from '../config'
import { sampleHeight } from '../compiler/heightField'
import { cutterBounds } from '../modifiers/boolean/CutterVolume'
import { SHARD_CENTER } from './createHeroShard'
import {
  OUTCROP_ID_PREFIX,
  createOutcropFieldModifiers,
  outcropFieldModifierIds,
} from './createOutcropField'
import { WATER_LEVEL } from './valleyFloor'

const seed = DEFAULT_TERRAIN_CONFIG.seed

describe('outcrop field', () => {
  const modifiers = createOutcropFieldModifiers(seed)

  it('patches rock topology across the valley rather than in one clump', () => {
    expect(modifiers.length).toBeGreaterThanOrEqual(4)
    for (const modifier of modifiers) {
      expect(modifier.type).toBe('boolean-volume')
      expect(modifier.enabled).toBe(true)
    }
    const centres = modifiers.map((modifier) => ({
      x: (modifier.bounds.min.x + modifier.bounds.max.x) * 0.5,
      z: (modifier.bounds.min.z + modifier.bounds.max.z) * 0.5,
    }))
    const spanX = Math.max(...centres.map((c) => c.x)) - Math.min(...centres.map((c) => c.x))
    const spanZ = Math.max(...centres.map((c) => c.z)) - Math.min(...centres.map((c) => c.z))
    expect(spanX).toBeGreaterThan(250)
    expect(spanZ).toBeGreaterThan(250)
  })

  it('names every cluster with the field version', () => {
    for (const modifier of modifiers) {
      expect(modifier.id.startsWith(OUTCROP_ID_PREFIX)).toBe(true)
    }
  })

  it('adds rock instead of removing it', () => {
    for (const modifier of modifiers) {
      expect(modifier.type === 'boolean-volume' && modifier.operation).toBe('add')
    }
  })

  it('predicts its own ids without building any geometry', () => {
    expect(new Set(outcropFieldModifierIds(seed))).toEqual(
      new Set(modifiers.map((modifier) => modifier.id)),
    )
  })

  it('keeps every crag out of the hero shard, and leaves the deep water clear', () => {
    for (const modifier of modifiers) {
      if (modifier.type !== 'boolean-volume') continue
      for (const volume of modifier.volumes) {
        const bounds = cutterBounds(volume)
        const x = (bounds.min.x + bounds.max.x) * 0.5
        const z = (bounds.min.z + bounds.max.z) * 0.5
        expect(
          Math.hypot(x - SHARD_CENTER.x, z - SHARD_CENTER.z),
        ).toBeGreaterThan(120)
        expect(sampleHeight(x, z, seed)).toBeGreaterThan(WATER_LEVEL - 12)
      }
    }
  })

  it('breaks the surface where it is planted', () => {
    // Every crag has to reach above the ground it is buried in, or it is an
    // expensive Boolean against terrain that hides all of it.
    for (const modifier of modifiers) {
      if (modifier.type !== 'boolean-volume') continue
      for (const volume of modifier.volumes) {
        const bounds = cutterBounds(volume)
        const ground = sampleHeight(
          (bounds.min.x + bounds.max.x) * 0.5,
          (bounds.min.z + bounds.max.z) * 0.5,
          seed,
        )
        expect(bounds.max.y).toBeGreaterThan(ground)
      }
    }
  })
})
