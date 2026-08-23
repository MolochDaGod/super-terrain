import { describe, expect, it } from 'vitest'
import { appendBrushPoint, createBrushStroke } from '../modifiers/factories'
import { materializeModifierTransforms } from '../modifiers/transform'
import type { BrushMode } from '../modifiers/types'
import { evaluateHeight, evaluateTerrainPoint } from './TerrainField'

/**
 * Sculpting must not tear the surface open.
 *
 * A section is triangulated over its XZ footprint, so a vertex that travels far
 * enough sideways passes its own neighbours and its triangles turn inside out.
 * Inverted triangles are backface-culled, and what the user sees is the terrain
 * ripped apart with the sky showing through. These tests work an area over the
 * way someone actually would and assert the triangulation survives it.
 */

const SEED = 17
const SECTION_SIZE = 128
const RESOLUTION = 88

/** Surface normal the editor's raycast reports, which is what a dab records. */
function surfaceNormal(x: number, z: number) {
  const epsilon = 0.5
  const dx = evaluateHeight(x + epsilon, z, SEED, []) - evaluateHeight(x - epsilon, z, SEED, [])
  const dz = evaluateHeight(x, z + epsilon, SEED, []) - evaluateHeight(x, z - epsilon, SEED, [])
  const length = Math.hypot(-dx, 2 * epsilon, -dz)
  return { x: -dx / length, y: (2 * epsilon) / length, z: -dz / length }
}

function strokeAcross(mode: BrushMode, angle: number, strength: number) {
  const originX = 64 + Math.cos(angle) * 12
  const originZ = 64 + Math.sin(angle) * 12
  const stroke = createBrushStroke({
    point: { x: originX, y: evaluateHeight(originX, originZ, SEED, []), z: originZ },
    normal: surfaceNormal(originX, originZ),
    domain: 'mesh',
    mode,
    radius: 22,
    strength,
    falloff: 0.55,
    sampleWeight: 0.22,
  })
  for (let step = 1; step <= 14; step += 1) {
    const x = originX - Math.cos(angle) * step * 1.8
    const z = originZ - Math.sin(angle) * step * 1.8
    appendBrushPoint(
      stroke,
      { x, y: evaluateHeight(x, z, SEED, []), z },
      surfaceNormal(x, z),
      0.22,
    )
  }
  return stroke
}

/** Triangles whose XZ winding has flipped: the surface folded over itself. */
function foldedTriangles(mode: BrushMode, strokeCount: number): number {
  const strokes = Array.from({ length: strokeCount }, (_unused, index) =>
    strokeAcross(mode, (index / strokeCount) * Math.PI * 2, 0.6),
  )
  const modifiers = materializeModifierTransforms(strokes)
  const spacing = SECTION_SIZE / RESOLUTION
  const width = RESOLUTION + 1
  const points: { x: number; y: number; z: number }[] = []
  for (let z = 0; z <= RESOLUTION; z += 1) {
    for (let x = 0; x <= RESOLUTION; x += 1) {
      points.push(evaluateTerrainPoint(x * spacing, z * spacing, SEED, modifiers))
    }
  }
  const doubleArea = (a: number, b: number, c: number) =>
    (points[b].x - points[a].x) * (points[c].z - points[a].z) -
    (points[c].x - points[a].x) * (points[b].z - points[a].z)

  let folded = 0
  for (let z = 0; z < RESOLUTION; z += 1) {
    for (let x = 0; x < RESOLUTION; x += 1) {
      const a = z * width + x
      const b = a + 1
      const c = a + width
      const d = c + 1
      // The unsculpted grid gives both triangles a negative double area.
      for (const [i, j, k] of [[a, c, b], [b, c, d]] as const) {
        if (doubleArea(i, j, k) >= 0) folded += 1
      }
    }
  }
  return folded
}

describe('sculpt integrity', () => {
  it('never folds the triangulation, whichever tool works the same ground', () => {
    for (const mode of [
      'raise',
      'lower',
      'clay',
      'flatten',
      'smooth',
      'scrape',
      'terrace',
      'noise',
      'pinch',
    ] as const) {
      expect(`${mode}: ${foldedTriangles(mode, 8)}`).toBe(`${mode}: 0`)
    }
  })

  it('shapes a held stroke into a dome instead of a slab with a hard rim', () => {
    // Convergence targets are shaped by the brush profile, not flat. When they
    // were flat, every point inside the footprint saturated at the same depth
    // and the surface inflated into a box: a plateau with a crease around it.
    const radius = 22
    const centre = { x: 64, z: 64 }
    const stroke = createBrushStroke({
      point: { x: centre.x, y: evaluateHeight(centre.x, centre.z, SEED, []), z: centre.z },
      normal: { x: 0, y: 1, z: 0 },
      domain: 'mesh',
      mode: 'raise',
      radius,
      strength: 1,
      falloff: 0.55,
      sampleWeight: 0.25,
    })
    for (let dab = 0; dab < 150; dab += 1) {
      appendBrushPoint(
        stroke,
        { x: centre.x, y: evaluateHeight(centre.x, centre.z, SEED, []), z: centre.z },
        { x: 0, y: 1, z: 0 },
        0.25,
      )
    }
    const modifiers = materializeModifierTransforms([stroke])
    const liftAt = (offset: number) =>
      evaluateTerrainPoint(centre.x + offset, centre.z, SEED, modifiers).y -
      evaluateHeight(centre.x + offset, centre.z, SEED, [])

    // Strictly decreasing from the middle out: a dome, with no flat shelf and
    // no step at the rim.
    let previous = Infinity
    for (let offset = 0; offset <= radius; offset += 2) {
      const lift = liftAt(offset)
      if (offset > radius * 0.25) expect(lift).toBeLessThan(previous)
      previous = lift
    }
    expect(liftAt(0)).toBeGreaterThan(radius * 0.3)
    expect(liftAt(radius)).toBeCloseTo(0, 5)
  })

  it('keeps a held brush inside the depth its footprint can taper', () => {
    // advanceActiveStroke appends a dab per frame while the pointer is held, so
    // hesitating mid-edit used to drive a single point out by a full brush
    // radius and leave a spike the surrounding surface could not follow down.
    const radius = 22
    const stroke = createBrushStroke({
      point: { x: 64, y: evaluateHeight(64, 64, SEED, []), z: 64 },
      normal: surfaceNormal(64, 64),
      domain: 'mesh',
      mode: 'raise',
      radius,
      strength: 1,
      falloff: 0.55,
      sampleWeight: 0.25,
    })
    for (let dab = 0; dab < 120; dab += 1) {
      // Faithful to the editor: every dab is raycast against the surface as
      // this stroke has already left it, so the dab planes climb the mound
      // being built. Convergence must not be measured against something the
      // stroke itself is moving, or each dab reopens a full allowance.
      const surface = evaluateTerrainPoint(
        64,
        64,
        SEED,
        materializeModifierTransforms([stroke]),
      )
      appendBrushPoint(
        stroke,
        { x: 64, y: surface.y, z: 64 },
        surfaceNormal(64, 64),
        0.25,
      )
    }
    const modifiers = materializeModifierTransforms([stroke])
    const before = evaluateTerrainPoint(64, 64, SEED, [])
    const after = evaluateTerrainPoint(64, 64, SEED, modifiers)
    const moved = Math.hypot(
      after.x - before.x,
      after.y - before.y,
      after.z - before.z,
    )
    expect(moved).toBeGreaterThan(radius * 0.2)
    expect(moved).toBeLessThan(radius * 0.5)
  })
})
