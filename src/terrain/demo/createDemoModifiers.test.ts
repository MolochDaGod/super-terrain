import { describe, expect, it } from 'vitest'
import { DEFAULT_TERRAIN_CONFIG } from '../config'
import { compileTerrainSection } from '../compiler/compileSection'
import { evaluateHeight } from '../compiler/TerrainField'
import {
  createBrushStroke,
  createRemeshModifier,
  createTunnelModifier,
} from '../modifiers/factories'
import {
  createDemoTerrainModifiers,
  isLegacyDemoTerrainModifiers,
  upgradeLegacyDemoTerrainModifiers,
} from './createDemoModifiers'
import { encodeModifiers } from '../workers/protocol'

describe('authored topology showcase', () => {
  it('ships distinct cave, window, bridge and escarpment operations', () => {
    const seed = 13_371
    const modifiers = createDemoTerrainModifiers(seed)
    const ids = modifiers.map((modifier) => modifier.id)

    expect(ids).toEqual(
      expect.arrayContaining([
        'demo-v2-cave-lower-massif',
        'demo-v2-cave-lower-chamber',
        'demo-v2-window-middle-bench',
        'demo-v2-natural-bridge-high-massif',
        'demo-v2-escarpment-west-face',
      ]),
    )
    expect(modifiers.filter((modifier) => modifier.type === 'remesh')).toHaveLength(3)
    expect(
      modifiers.filter((modifier) => modifier.type === 'boolean-volume'),
    ).toHaveLength(3)

    for (const modifier of modifiers) {
      expect(modifier.enabled).toBe(true)
      expect(modifier.bounds.max.x).toBeGreaterThan(modifier.bounds.min.x)
      expect(modifier.bounds.max.y).toBeGreaterThan(modifier.bounds.min.y)
      expect(modifier.bounds.max.z).toBeGreaterThan(modifier.bounds.min.z)
    }
  })

  it('places tunnel portals on the generated surface with outward normals', () => {
    const seed = 13_371
    const tunnels = createDemoTerrainModifiers(seed).filter(
      (modifier) => modifier.type === 'boolean-subtract',
    )
    expect(tunnels).toHaveLength(2)
    for (const tunnel of tunnels) {
      for (const portal of tunnel.portals) {
        expect(portal.y).toBeCloseTo(
          evaluateHeight(portal.x, portal.z, seed, []),
          6,
        )
        expect(
          Math.hypot(portal.normal.x, portal.normal.y, portal.normal.z),
        ).toBeCloseTo(1, 6)
        expect(portal.normal.y).toBeGreaterThan(0)
      }
    }
  })

  it('only migrates the exact legacy one-tunnel showcase', () => {
    const legacy = createTunnelModifier({
      center: { x: 14, y: 20, z: 34 },
      radius: 9,
      length: 76,
    })
    expect(isLegacyDemoTerrainModifiers([legacy])).toBe(true)
    expect(isLegacyDemoTerrainModifiers(createDemoTerrainModifiers(13_371))).toBe(false)
  })

  it('upgrades legacy demo entries inside a dirty saved stack without losing edits', () => {
    const seed = 13_371
    const legacyTunnel = createTunnelModifier({
      center: { x: 14, y: 20, z: 34 },
      radius: 9,
      length: 76,
    })
    const legacyDensity = createRemeshModifier({
      center: { x: -52, y: 12, z: -12 },
      radius: 34,
      targetEdgeLength: 2.4,
    })
    const userStroke = createBrushStroke({
      point: { x: 10, y: 5, z: 12 },
      mode: 'raise',
      radius: 8,
      strength: 0.5,
      falloff: 0.4,
    })
    userStroke.id = 'user-authored-stroke'

    const upgraded = upgradeLegacyDemoTerrainModifiers(
      [legacyDensity, userStroke, legacyTunnel],
      seed,
    )
    expect(upgraded).toBeDefined()
    expect(upgraded?.some((modifier) => modifier.id === userStroke.id)).toBe(true)
    expect(upgraded?.some((modifier) => modifier.id === legacyTunnel.id)).toBe(false)
    expect(upgraded?.some((modifier) => modifier.id === legacyDensity.id)).toBe(false)
    expect(
      upgraded?.some(
        (modifier) => modifier.id === 'demo-v2-natural-bridge-high-massif',
      ),
    ).toBe(true)
    expect(upgradeLegacyDemoTerrainModifiers(upgraded ?? [], seed)).toBeUndefined()
  })

  it('removes persisted torture-benchmark strokes from an already upgraded demo', () => {
    const seed = 13_371
    const benchmarkStroke = createBrushStroke({
      point: { x: 510, y: 180, z: 120 },
      normal: { x: 0, y: 1, z: 0 },
      mode: 'raise',
      radius: 17,
      strength: 0.22,
      falloff: 0.58,
    })
    const userStroke = createBrushStroke({
      point: { x: 520, y: 180, z: 120 },
      mode: 'raise',
      radius: 12,
      strength: 0.4,
      falloff: 0.5,
    })
    userStroke.id = 'real-user-stroke'

    const upgraded = upgradeLegacyDemoTerrainModifiers(
      [...createDemoTerrainModifiers(seed), benchmarkStroke, userStroke],
      seed,
    )

    expect(upgraded).toBeDefined()
    expect(upgraded?.some((modifier) => modifier.id === benchmarkStroke.id)).toBe(false)
    expect(upgraded?.some((modifier) => modifier.id === userStroke.id)).toBe(true)
    expect(upgradeLegacyDemoTerrainModifiers(upgraded ?? [], seed)).toBeUndefined()
  })

  it('replaces every unversioned shipped entry regardless of its saved shape', () => {
    const seed = 13_371
    const outdated = createDemoTerrainModifiers(seed).map((modifier) => {
      const clone = structuredClone(modifier)
      clone.id = clone.id.replace('demo-v2-', 'demo-')
      return clone
    })
    const bridge = outdated.find(
      (modifier) => modifier.id === 'demo-natural-bridge-high-massif',
    )
    expect(bridge?.type).toBe('boolean-volume')
    if (!bridge || bridge.type !== 'boolean-volume') return
    bridge.volumes = [
      {
        kind: 'sweep',
        rings: Array.from({ length: 21 }, (_, index) => ({
          x: 516 + (index / 20) * 152,
          y: 244 + Math.sin((index / 20) * Math.PI * 1.4) * 5,
          z: 224 + Math.sin((index / 20) * Math.PI * 2) * 3.5,
          horizontalRadius: 27 + Math.sin(Math.PI * (index / 20)) * 8,
          verticalRadius: 27 + Math.sin(Math.PI * (index / 20)) * 11,
        })),
        surface: 'arch',
      },
    ]
    const escarpment = outdated.find(
      (modifier) => modifier.id === 'demo-escarpment-west-face',
    )
    expect(escarpment?.type).toBe('boolean-volume')
    if (!escarpment || escarpment.type !== 'boolean-volume') return
    escarpment.volumes = [
      {
        kind: 'ellipsoid',
        center: {
          x: 462,
          y: evaluateHeight(462, -88, seed, []) - 16,
          z: -88,
        },
        radii: { x: 104, y: 31, z: 43 },
        forward: { x: 0, y: 0, z: 1 },
        surface: 'overhang',
      },
    ]

    const userStroke = createBrushStroke({
      point: { x: 520, y: 180, z: 120 },
      mode: 'raise',
      radius: 11,
      strength: 0.4,
      falloff: 0.5,
    })
    userStroke.id = 'keep-this-user-edit'

    const upgraded = upgradeLegacyDemoTerrainModifiers(
      [...outdated, userStroke],
      seed,
    )
    expect(upgraded).toBeDefined()
    expect(upgraded?.some((modifier) => modifier.id === userStroke.id)).toBe(true)
    expect(upgraded?.some((modifier) => /^demo-(?!v2-)/.test(modifier.id))).toBe(
      false,
    )

    const upgradedBridge = upgraded?.find(
      (modifier) => modifier.id === 'demo-v2-natural-bridge-high-massif',
    )
    expect(upgradedBridge?.type).toBe('boolean-volume')
    if (!upgradedBridge || upgradedBridge.type !== 'boolean-volume') return
    expect(upgradedBridge.volumes[0].kind).toBe('sweep')
    if (upgradedBridge.volumes[0].kind !== 'sweep') return
    expect(upgradedBridge.volumes[0].rings[0].x).toBe(528)
    expect(upgradedBridge.volumes[0].rings.at(-1)?.x).toBe(652)

    const upgradedEscarpment = upgraded?.find(
      (modifier) => modifier.id === 'demo-v2-escarpment-west-face',
    )
    expect(upgradedEscarpment?.type).toBe('boolean-volume')
    if (!upgradedEscarpment || upgradedEscarpment.type !== 'boolean-volume') return
    expect(upgradedEscarpment.volumes[0].kind).toBe('ellipsoid')
    if (upgradedEscarpment.volumes[0].kind !== 'ellipsoid') return
    expect(upgradedEscarpment.volumes[0].center.y).toBeCloseTo(
      evaluateHeight(462, -88, seed, []) - 50,
      8,
    )
    expect(upgradedEscarpment.volumes[0].radii).toEqual({ x: 68, y: 15, z: 21 })
    expect(upgraded).toHaveLength(outdated.length + 1)
    expect(upgradeLegacyDemoTerrainModifiers(upgraded ?? [], seed)).toBeUndefined()
  })

  it('keeps the bridge ownership cell while carving its undercut', () => {
    const bridge = createDemoTerrainModifiers(DEFAULT_TERRAIN_CONFIG.seed).find(
      (modifier) => modifier.id === 'demo-v2-natural-bridge-high-massif',
    )
    expect(bridge).toBeDefined()
    if (!bridge) return
    const compiled = compileTerrainSection({
      kind: 'compile-section',
      jobId: 1,
      key: { x: 4, z: 1 },
      revision: 1,
      priority: 1,
      config: {
        ...DEFAULT_TERRAIN_CONFIG,
        lodResolutions: [24],
      },
      modifiers: encodeModifiers([bridge]),
    })
    expect(exteriorCoverage(compiled.lods[0])).toBeGreaterThan(0.95)
  })

  it(
    'keeps every ownership cell under the full topology showcase',
    () => {
      const modifiers = createDemoTerrainModifiers(DEFAULT_TERRAIN_CONFIG.seed)
      for (let z = -2; z <= 2; z += 1) {
        for (let x = 2; x <= 5; x += 1) {
          const compiled = compileTerrainSection({
            kind: 'compile-section',
            jobId: 1,
            key: { x, z },
            revision: 1,
            priority: 1,
            config: {
              ...DEFAULT_TERRAIN_CONFIG,
              lodResolutions: [24],
            },
            modifiers: encodeModifiers(modifiers),
          })
          expect(
            exteriorCoverage(compiled.lods[0]),
            `section ${x}:${z}`,
          ).toBeGreaterThan(0.95)
        }
      }
    },
    20_000,
  )
})

function exteriorCoverage(lod: {
  positions: Float32Array
  colors: Float32Array
  indices: Uint32Array
}): number {
  let exteriorProjectedArea = 0
  for (let index = 0; index < lod.indices.length; index += 3) {
    const vertices = [
      lod.indices[index],
      lod.indices[index + 1],
      lod.indices[index + 2],
    ]
    // Cave vertices use the deliberately dark interior palette. Only count
    // the retained height-derived shell in this top-down coverage guard.
    if (vertices.every((vertex) => lod.colors[vertex * 3] < 0.21)) continue
    const a = vertices[0] * 3
    const b = vertices[1] * 3
    const c = vertices[2] * 3
    exteriorProjectedArea += Math.abs(
      (lod.positions[b] - lod.positions[a]) *
        (lod.positions[c + 2] - lod.positions[a + 2]) -
        (lod.positions[b + 2] - lod.positions[a + 2]) *
          (lod.positions[c] - lod.positions[a]),
    ) * 0.5
  }
  const sectionArea = DEFAULT_TERRAIN_CONFIG.sectionSize ** 2
  return exteriorProjectedArea / sectionArea
}
