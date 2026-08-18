import { describe, expect, it } from 'vitest'
import {
  generateGraniteRock,
  transformGraniteRockPositions,
} from './generateGraniteRock'
import {
  DEFAULT_GRANITE_ROCK_PARAMETERS,
  graniteMassingPreset,
  normalizeGraniteRockParameters,
  normalizeGraniteRockTransform,
} from './types'

describe('procedural granite topology', () => {
  it('is deterministic while distinct seeds change the authored mass', () => {
    const first = generateGraniteRock({
      ...DEFAULT_GRANITE_ROCK_PARAMETERS,
      seed: 91,
    })
    const repeated = generateGraniteRock({
      ...DEFAULT_GRANITE_ROCK_PARAMETERS,
      seed: 91,
    })
    const other = generateGraniteRock({
      ...DEFAULT_GRANITE_ROCK_PARAMETERS,
      seed: 92,
    })

    expect([...repeated.positions]).toEqual([...first.positions])
    expect([...other.positions]).not.toEqual([...first.positions])
  })

  it('keeps material controls off the topology hot path', () => {
    const base = graniteMassingPreset('erratic', 1, 2)
    const dry = generateGraniteRock(base)
    const weathered = generateGraniteRock({
      ...base,
      wetness: 1,
      lichen: 0.9,
      moss: 0.8,
      snow: 0.7,
      detailStrength: 0.2,
    })

    expect(weathered).toBe(dry)
  })

  it('carries more small-scale fracture at a higher topology tier', () => {
    const base = graniteMassingPreset('erratic', 1, 2)
    const standard = generateGraniteRock({ ...base, topologyDetail: 30 })
    const micro = generateGraniteRock({ ...base, topologyDetail: 72 })

    expect(micro.indices.length).toBeGreaterThan(standard.indices.length * 3)
  }, 120_000)

  it('takes topology from the tier alone, not from the render LOD', () => {
    const base = graniteMassingPreset('bench', 5, 2)
    const draftLod = generateGraniteRock({ ...base, detail: 2, topologyDetail: 30 })
    const fineLod = generateGraniteRock({ ...base, detail: 4, topologyDetail: 30 })

    expect(fineLod).toBe(draftLod)
  })

  it('derives the tier from the render LOD for rocks saved before it existed', () => {
    expect(normalizeGraniteRockParameters({ detail: 4 }).topologyDetail).toBe(44)
    expect(normalizeGraniteRockParameters({ detail: 2 }).topologyDetail).toBe(20)
    expect(
      normalizeGraniteRockParameters({ detail: 2, topologyDetail: 72 }).topologyDetail,
    ).toBe(72)
    expect(
      normalizeGraniteRockParameters({ topologyDetail: 999 as 72 }).topologyDetail,
    ).toBe(72)
  })

  it('applies only the source metre conversion and uniform placement scale', () => {
    const base = { ...graniteMassingPreset('prow', 2, 2), placementScale: 1 }
    const doubled = generateGraniteRock({ ...base, placementScale: 2 })
    const original = generateGraniteRock(base)

    for (let index = 0; index < original.positions.length; index += 1) {
      expect(doubled.positions[index]).toBeCloseTo(original.positions[index]! * 2, 5)
    }
  })

  it('keeps a closed two-manifold index topology at CSG quality', () => {
    const mesh = generateGraniteRock(graniteMassingPreset('tor', 284, 4))
    const edgeUse = new Map<string, { count: number; balance: number }>()

    expect(mesh.positions.length / 3).toBeGreaterThan(2_000)
    expect(mesh.indices.length / 3).toBeGreaterThan(4_000)
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      const triangle = [
        mesh.indices[offset]!,
        mesh.indices[offset + 1]!,
        mesh.indices[offset + 2]!,
      ]
      for (let edge = 0; edge < 3; edge += 1) {
        const a = triangle[edge]!
        const b = triangle[(edge + 1) % 3]!
        const key = a < b ? `${a}:${b}` : `${b}:${a}`
        const use = edgeUse.get(key) ?? { count: 0, balance: 0 }
        use.count += 1
        use.balance += a < b ? 1 : -1
        edgeUse.set(key, use)
      }
      expect(
        triangleArea(
          mesh.positions,
          triangle[0]!,
          triangle[1]!,
          triangle[2]!,
        ),
      ).toBeGreaterThan(1e-8)
    }

    expect(
      [...edgeUse.values()].every(
        ({ count, balance }) => count === 2 && balance === 0,
      ),
    ).toBe(true)
    expect(signedVolume(mesh.positions, mesh.indices)).toBeGreaterThan(0)
    expect([...mesh.positions].every(Number.isFinite)).toBe(true)
    expect([...mesh.normals].every(Number.isFinite)).toBe(true)
  })

  it('creates a stable planted base region without opening the mesh', () => {
    const mesh = generateGraniteRock(graniteMassingPreset('monolith', 733, 3))
    let contactVertices = 0
    const height = mesh.bounds.max.y - mesh.bounds.min.y
    for (let offset = 1; offset < mesh.positions.length; offset += 3) {
      if (mesh.positions[offset]! <= mesh.bounds.min.y + height * 0.04) {
        contactVertices += 1
      }
    }
    expect(contactVertices).toBeGreaterThanOrEqual(3)
    expect(height).toBeGreaterThan(8)
  })

  it('preserves the source arch as real negative-space topology', () => {
    const mesh = generateGraniteRock(graniteMassingPreset('arch', 3, 2))
    const edges = new Set<string>()
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      for (let edge = 0; edge < 3; edge += 1) {
        const a = mesh.indices[offset + edge]!
        const b = mesh.indices[offset + ((edge + 1) % 3)]!
        edges.add(a < b ? `${a}:${b}` : `${b}:${a}`)
      }
    }
    const eulerCharacteristic =
      mesh.positions.length / 3 - edges.size + mesh.indices.length / 3
    expect(eulerCharacteristic).toBe(0)
  })

  it('bakes the scene transform into a topology snapshot', () => {
    expect(
      transformGraniteRockPositions([1, 0, 0], {
        position: { x: 10, y: 3, z: -4 },
        rotation: { x: 0, y: Math.PI * 0.5, z: 0 },
        scale: { x: 2, y: 2, z: 2 },
      }),
    ).toEqual([10, 3, -6])
  })

  it('stretches one axis at a time, before rotation, in object space', () => {
    expect(
      transformGraniteRockPositions([1, 1, 1], {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 3, y: 1, z: 1 },
      }),
    ).toEqual([3, 1, 1])

    const [x, y, z] = transformGraniteRockPositions([1, 0, 0], {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: Math.PI * 0.5, z: 0 },
      scale: { x: 4, y: 1, z: 1 },
    })
    expect(x).toBeCloseTo(0, 10)
    expect(y).toBeCloseTo(0, 10)
    expect(z).toBeCloseTo(-4, 10)
  })

  it('reads rocks saved with a single uniform scale number', () => {
    expect(
      normalizeGraniteRockTransform({
        scale: 2.5 as unknown as { x: number; y: number; z: number },
      }),
    ).toEqual({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 2.5, y: 2.5, z: 2.5 },
    })
  })
})

function signedVolume(
  positions: Float32Array,
  indices: Uint32Array,
): number {
  let volume = 0
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]! * 3
    const b = indices[offset + 1]! * 3
    const c = indices[offset + 2]! * 3
    volume +=
      positions[a]! *
        (positions[b + 1]! * positions[c + 2]! -
          positions[b + 2]! * positions[c + 1]!) +
      positions[a + 1]! *
        (positions[b + 2]! * positions[c]! -
          positions[b]! * positions[c + 2]!) +
      positions[a + 2]! *
        (positions[b]! * positions[c + 1]! -
          positions[b + 1]! * positions[c]!)
  }
  return volume / 6
}

function triangleArea(
  positions: Float32Array,
  a: number,
  b: number,
  c: number,
): number {
  const ai = a * 3
  const bi = b * 3
  const ci = c * 3
  const ab = {
    x: positions[bi]! - positions[ai]!,
    y: positions[bi + 1]! - positions[ai + 1]!,
    z: positions[bi + 2]! - positions[ai + 2]!,
  }
  const ac = {
    x: positions[ci]! - positions[ai]!,
    y: positions[ci + 1]! - positions[ai + 1]!,
    z: positions[ci + 2]! - positions[ai + 2]!,
  }
  return Math.hypot(
    ab.y * ac.z - ab.z * ac.y,
    ab.z * ac.x - ab.x * ac.z,
    ab.x * ac.y - ab.y * ac.x,
  ) * 0.5
}
