import { describe, expect, it } from 'vitest'
import { DEFAULT_TERRAIN_CONFIG } from '../config'
import { sampleHeight } from '../compiler/heightField'
import { cutterBounds } from '../modifiers/boolean/CutterVolume'
import {
  OUTCROP_ID_PREFIX,
  createOutcropFieldModifiers,
  outcropFieldModifierIds,
} from './createOutcropField'
import { THRUST_CENTER } from './createThrustFormation'
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

  it('keeps patches out of the portal core and leaves the deep water clear', () => {
    for (const modifier of modifiers) {
      if (modifier.type !== 'boolean-volume') continue
      for (const volume of modifier.volumes) {
        const bounds = cutterBounds(volume)
        const x = (bounds.min.x + bounds.max.x) * 0.5
        const z = (bounds.min.z + bounds.max.z) * 0.5
        expect(
          Math.hypot(x - THRUST_CENTER.x, z - THRUST_CENTER.z),
          // Bedrock cells are allowed to meet the landmark's buried root; that
          // connected join is what prevents it reading as a prop. The portal
          // core itself remains clear for the subtractive topology.
        ).toBeGreaterThan(70)
        expect(sampleHeight(x, z, seed)).toBeGreaterThan(WATER_LEVEL - 12)
      }
    }
  })

  it('uses generated natural meshes for every terrain patch', () => {
    for (const modifier of modifiers) {
      if (modifier.type !== 'boolean-volume') continue
      expect(modifier.volumes.every((volume) => volume.kind === 'mesh')).toBe(true)
    }
  })

  it('grows the source terrain into every authored slab footprint', () => {
    const aprons = modifiers.flatMap((modifier) =>
      modifier.type === 'boolean-volume'
        ? modifier.volumes.flatMap((volume) =>
            volume.terrainApron ? [volume.terrainApron] : [],
          )
        : [],
    )
    expect(aprons.length).toBeGreaterThanOrEqual(12)
    // The authored secondary structures must read at terrain scale in the
    // shipped frame instead of shrinking back into scattered rock props.
    expect(Math.max(...aprons.map((apron) => apron.halfLength))).toBeGreaterThan(45)
    // Most of the thrust train shares the landmark's dip, but the basin-right
    // counter-sheet demonstrates that a patch can grow through terrain in the
    // opposite XYZ direction as well.
    expect(aprons.some((apron) => apron.forward.y < -0.25)).toBe(true)
    expect(aprons.some((apron) => apron.forward.y > 0.25)).toBe(true)
    for (const apron of aprons) {
      expect(apron.halfLength).toBeGreaterThan(apron.halfWidth)
      expect(apron.falloff).toBeGreaterThan(4)
      expect(apron.lift).toBeGreaterThan(1)
    }
  })

  it('breaks the surface where it is planted', () => {
    // A cluster may contain a deliberately buried root whose only job is to
    // connect a cantilever to the base solid. The authored patch as a whole,
    // however, must cross the height-field surface; otherwise it would be an
    // expensive Boolean that changes no visible terrain.
    let threeDimensionalIntersections = 0
    for (const modifier of modifiers) {
      if (modifier.type !== 'boolean-volume') continue
      let visibleVolumes = 0
      for (const volume of modifier.volumes) {
        const bounds = cutterBounds(volume)
        const ground = sampleHeight(
          (bounds.min.x + bounds.max.x) * 0.5,
          (bounds.min.z + bounds.max.z) * 0.5,
          seed,
        )
        if (bounds.max.y > ground) visibleVolumes += 1
        if (bounds.min.y < ground - 3 && bounds.max.y > ground + 3) {
          threeDimensionalIntersections += 1
        }
      }
      expect(visibleVolumes, `${modifier.id} has no exposed patch body`).toBeGreaterThan(0)
    }
    // These bodies enter the terrain below the sampled surface and leave it in
    // a different XYZ direction. They are not XY decals or height samples.
    expect(threeDimensionalIntersections).toBeGreaterThanOrEqual(12)
  })
})
