import { describe, expect, it } from 'vitest'
import { DEFAULT_TERRAIN_CONFIG } from '../config'
import { compileTerrainSection } from '../compiler/compileSection'
import { createBrushStroke } from '../modifiers/factories'
import { encodeModifiers } from '../workers/protocol'
import { OUTCROP_ID_PREFIX } from './createOutcropField'
import {
  THRUST_MODIFIER_IDS,
} from './createThrustFormation'
import {
  createShowcaseTerrainModifiers,
  upgradeShowcaseTerrainModifiers,
} from './createShowcaseModifiers'

const seed = 13_371

describe('showcase modifier migration', () => {
  it('replaces the former natural-mesh generation without duplicating patches', () => {
    const current = createShowcaseTerrainModifiers(seed)
    const stale = current.map((modifier) => {
      if (modifier.id.startsWith('showcase-v13-')) {
        return { ...modifier, id: modifier.id.replace('showcase-v13-', 'showcase-v12-') }
      }
      if (modifier.id.startsWith(OUTCROP_ID_PREFIX)) {
        return { ...modifier, id: modifier.id.replace(OUTCROP_ID_PREFIX, 'demo-v8-outcrop-') }
      }
      return modifier
    })
    const edit = createBrushStroke({
      point: { x: 12, y: 3, z: 8 },
      mode: 'raise',
      radius: 6,
      strength: 0.3,
      falloff: 0.5,
    })

    const upgraded = upgradeShowcaseTerrainModifiers([...stale, edit], seed)

    expect(upgraded).toBeDefined()
    const ids = upgraded!.map((modifier) => modifier.id)
    expect(ids).toContain(edit.id)
    expect(THRUST_MODIFIER_IDS.every((id) => ids.includes(id))).toBe(true)
    expect(ids.some((id) => id.startsWith('showcase-v12-'))).toBe(false)
    expect(ids.some((id) => id.startsWith('demo-v8-outcrop-'))).toBe(false)
    expect(new Set(ids).size).toBe(ids.length)
  }, 20_000)

  it('leaves a complete current showcase untouched', () => {
    const current = createShowcaseTerrainModifiers(seed)
    expect(upgradeShowcaseTerrainModifiers(current, seed)).toBeUndefined()
  })

  it('compiles the showcase cells with the deepest overlapping CSG stacks', () => {
    const modifiers = createShowcaseTerrainModifiers(seed).sort((left, right) =>
      left.priority - right.priority || left.id.localeCompare(right.id),
    )

    for (const key of [{ x: 3, z: 0 }, { x: 3, z: 1 }]) {
      const compiled = compileTerrainSection({
        kind: 'compile-section',
        jobId: key.z + 1,
        key,
        revision: 1,
        priority: 1,
        config: {
          sectionSize: DEFAULT_TERRAIN_CONFIG.sectionSize,
          lodResolutions: [DEFAULT_TERRAIN_CONFIG.lodResolutions[1]],
          seed,
          operationHalo: DEFAULT_TERRAIN_CONFIG.operationHalo,
          worldProfile: DEFAULT_TERRAIN_CONFIG.worldProfile,
        },
        modifiers: encodeModifiers(modifiers),
      })

      expect(compiled.lods[0].positions.length, `${key.x}:${key.z} positions`)
        .toBeGreaterThan(0)
      expect(compiled.lods[0].indices.length, `${key.x}:${key.z} indices`)
        .toBeGreaterThan(0)
    }
  }, 30_000)
})
