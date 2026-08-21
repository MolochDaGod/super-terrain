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
import {
  OUTCROP_ID_PREFIX,
  SUPERSEDED_OUTCROP_PREFIXES,
} from './createOutcropField'
import { encodeModifiers } from '../workers/protocol'

describe('authored topology showcase', () => {
  it(
    'ships distinct cave, window, bridge and escarpment operations',
    () => {
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
          'demo-v3-hero-shard-mass',
          'demo-v3-hero-shard-windows',
        ]),
      )
      // Three around the massif's authored topology, two around the hero shard's
      // two windows.
      expect(modifiers.filter((modifier) => modifier.type === 'remesh')).toHaveLength(5)
      // Cave chamber, natural bridge, escarpment, plus the shard's mass, its
      // bedding partings and its windows, plus one per outcrop cluster.
      const volumes = modifiers.filter(
        (modifier) => modifier.type === 'boolean-volume',
      )
      const outcrops = volumes.filter((modifier) =>
        modifier.id.startsWith(OUTCROP_ID_PREFIX),
      )
      expect(volumes).toHaveLength(6 + outcrops.length)
      // The shard's mass and the outcrop clusters are the operations that add
      // rock; everything else in the stack removes it.
      expect(
        volumes.filter((modifier) => modifier.operation === 'add'),
      ).toHaveLength(1 + outcrops.length)
      // The outcrop field is the demo's actual subject, so it must not quietly
      // collapse to a handful of crags in one corner of the valley.
      expect(outcrops.length).toBeGreaterThanOrEqual(4)

      for (const modifier of modifiers) {
        expect(modifier.enabled).toBe(true)
        expect(modifier.bounds.max.x).toBeGreaterThan(modifier.bounds.min.x)
        expect(modifier.bounds.max.y).toBeGreaterThan(modifier.bounds.min.y)
        expect(modifier.bounds.max.z).toBeGreaterThan(modifier.bounds.min.z)
      }
    },
    15_000,
  )

  it('replaces an outcrop field from an earlier version', () => {
    const seed = 13_371
    const current = createDemoTerrainModifiers(seed)
    const stalePrefix = SUPERSEDED_OUTCROP_PREFIXES.at(-1)!
    const stale = current.map((modifier) =>
      modifier.id.startsWith(OUTCROP_ID_PREFIX)
        ? { ...modifier, id: modifier.id.replace(OUTCROP_ID_PREFIX, stalePrefix) }
        : modifier,
    )
    const edit = createBrushStroke({
      point: { x: 12, y: 4, z: 9 },
      mode: 'raise',
      radius: 8,
      strength: 0.4,
      falloff: 0.5,
    })

    const upgraded = upgradeLegacyDemoTerrainModifiers([...stale, edit], seed)

    expect(upgraded).toBeDefined()
    const ids = upgraded!.map((modifier) => modifier.id)
    expect(ids).toContain(edit.id)
    expect(ids.some((id) => id.startsWith(stalePrefix))).toBe(false)
    expect(ids.filter((id) => id.startsWith(OUTCROP_ID_PREFIX)).length)
      .toBeGreaterThanOrEqual(4)
  })

  it('adds authored terrain that shipped after a world was saved', () => {
    const seed = 13_371
    const current = createDemoTerrainModifiers(seed)
    const saved = current.filter((modifier) => !modifier.id.startsWith('demo-v3-'))

    const upgraded = upgradeLegacyDemoTerrainModifiers(saved, seed)

    expect(upgraded).toBeDefined()
    expect(upgraded?.some((modifier) => modifier.id === 'demo-v3-hero-shard-mass')).toBe(
      true,
    )
    // Everything that was already there survives, by identity.
    for (const modifier of saved) {
      expect(upgraded?.some((entry) => entry.id === modifier.id)).toBe(true)
    }
    // And a world that is already current is left alone entirely.
    expect(upgradeLegacyDemoTerrainModifiers(current, seed)).toBeUndefined()
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
    expect(
      upgraded?.some((modifier) => /^demo-(?!v\d+-)/.test(modifier.id)),
    ).toBe(false)

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
    expect(exteriorCoverage([
      { key: { x: 4, z: 1 }, lod: compiled.lods[0] },
    ], { x: 4, z: 1 })).toBeGreaterThan(0.95)
  })

  it(
    'keeps every ownership cell under the full topology showcase',
    () => {
      const modifiers = createDemoTerrainModifiers(DEFAULT_TERRAIN_CONFIG.seed)
      const compiledCells = new Map<string, {
        key: { x: number; z: number }
        lod: ReturnType<typeof compileTerrainSection>['lods'][number]
      }>()
      const compileCell = (x: number, z: number) => {
        const id = `${x}:${z}`
        const cached = compiledCells.get(id)
        if (cached) return cached
        const compiled = compileTerrainSection({
          kind: 'compile-section',
          jobId: compiledCells.size + 1,
          key: { x, z },
          revision: 1,
          priority: 1,
          config: {
            ...DEFAULT_TERRAIN_CONFIG,
            lodResolutions: [24],
          },
          modifiers: encodeModifiers(modifiers),
        })
        const cell = { key: { x, z }, lod: compiled.lods[0] }
        compiledCells.set(id, cell)
        return cell
      }
      for (let z = -2; z <= 2; z += 1) {
        for (let x = 2; x <= 5; x += 1) {
          // Cross-boundary additive triangles are deliberately owned by the
          // cell containing their centroid. A single section therefore cannot
          // prove coverage at its border: a neighbour-owned triangle may span
          // into it. Assemble the local 3x3 and clip projected area to the
          // target cell, which is the surface the renderer actually presents.
          const neighbourhood = []
          for (let dz = -1; dz <= 1; dz += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              neighbourhood.push(compileCell(x + dx, z + dz))
            }
          }
          // The legacy demo deliberately cuts true cave/bridge apertures into
          // this shell; the assembled 3x3 surface measures about 94.8% in its
          // most-open cell. Keep this as a catastrophic-coverage regression,
          // while allowing those authored voids to remain actual openings.
          expect(
            exteriorCoverage(neighbourhood, { x, z }),
            `section ${x}:${z}`,
          ).toBeGreaterThan(0.94)
        }
      }
    },
    90_000,
  )
})

function exteriorCoverage(
  sections: Array<{
    key: { x: number; z: number }
    lod: {
      positions: Float32Array
      colors: Float32Array
      indices: Uint32Array
    }
  }>,
  target: { x: number; z: number },
): number {
  const sectionSize = DEFAULT_TERRAIN_CONFIG.sectionSize
  const minX = target.x * sectionSize
  const minZ = target.z * sectionSize
  const maxX = minX + sectionSize
  const maxZ = minZ + sectionSize
  let exteriorProjectedArea = 0
  for (const { key, lod } of sections) {
    const originX = key.x * sectionSize
    const originZ = key.z * sectionSize
    for (let index = 0; index < lod.indices.length; index += 3) {
      const vertices = [
        lod.indices[index],
        lod.indices[index + 1],
        lod.indices[index + 2],
      ]
      // Cave vertices use the deliberately dark interior palette. Only count
      // the retained height-derived shell in this top-down coverage guard.
      if (vertices.every((vertex) => lod.colors[vertex * 3] < 0.21)) continue
      let polygon = vertices.map((vertex) => ({
        x: originX + lod.positions[vertex * 3],
        z: originZ + lod.positions[vertex * 3 + 2],
      }))
      polygon = clipProjectedPolygon(polygon, 'x', minX, true)
      polygon = clipProjectedPolygon(polygon, 'x', maxX, false)
      polygon = clipProjectedPolygon(polygon, 'z', minZ, true)
      polygon = clipProjectedPolygon(polygon, 'z', maxZ, false)
      exteriorProjectedArea += projectedPolygonArea(polygon)
    }
  }
  return exteriorProjectedArea / (sectionSize ** 2)
}

interface ProjectedPoint {
  x: number
  z: number
}

function clipProjectedPolygon(
  polygon: ProjectedPoint[],
  axis: 'x' | 'z',
  boundary: number,
  keepGreater: boolean,
): ProjectedPoint[] {
  if (polygon.length === 0) return polygon
  const output: ProjectedPoint[] = []
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]
    const previous = polygon[(index + polygon.length - 1) % polygon.length]
    const currentInside = keepGreater
      ? current[axis] >= boundary
      : current[axis] <= boundary
    const previousInside = keepGreater
      ? previous[axis] >= boundary
      : previous[axis] <= boundary
    if (currentInside !== previousInside) {
      const denominator = current[axis] - previous[axis]
      const amount = denominator === 0
        ? 0
        : (boundary - previous[axis]) / denominator
      output.push({
        x: previous.x + (current.x - previous.x) * amount,
        z: previous.z + (current.z - previous.z) * amount,
        [axis]: boundary,
      })
    }
    if (currentInside) output.push(current)
  }
  return output
}

function projectedPolygonArea(polygon: ProjectedPoint[]): number {
  let twiceArea = 0
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]
    const next = polygon[(index + 1) % polygon.length]
    twiceArea += current.x * next.z - next.x * current.z
  }
  return Math.abs(twiceArea) * 0.5
}
