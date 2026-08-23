import { expect, it } from 'vitest'
import { appendBrushPoint, createBrushStroke } from '../modifiers/factories'
import { materializeModifierTransforms } from '../modifiers/transform'
import { evaluateHeight, evaluateTerrainPoint } from './TerrainField'
import type { BrushMode, BrushDomain } from '../modifiers/types'

/** Surface normal the editor's raycast would report at this ground point. */
function surfaceNormal(x: number, z: number) {
  const e = 0.5
  const dx = evaluateHeight(x + e, z, 17, []) - evaluateHeight(x - e, z, 17, [])
  const dz = evaluateHeight(x, z + e, 17, []) - evaluateHeight(x, z - e, 17, [])
  const length = Math.hypot(-dx, 2 * e, -dz)
  return { x: -dx / length, y: (2 * e) / length, z: -dz / length }
}

function foldReport(mode: BrushMode, domain: BrushDomain, strength: number) {
  const stroke = createBrushStroke({
    point: { x: 40, y: evaluateHeight(40, 40, 17, []), z: 40 },
    normal: surfaceNormal(40, 40),
    domain,
    mode,
    radius: 22,
    strength,
    falloff: 0.55,
    sampleWeight: 0.22,
  })
  for (let step = 1; step <= 20; step += 1) {
    const x = 40 + step * 2
    const z = 40 + step * 1
    appendBrushPoint(stroke, { x, y: evaluateHeight(x, z, 17, []), z }, surfaceNormal(x, z), 0.22)
  }
  const modifiers = materializeModifierTransforms([stroke])

  const resolution = 88
  const spacing = 128 / resolution
  const width = resolution + 1
  const points: { x: number; z: number }[] = []
  for (let z = 0; z <= resolution; z += 1) {
    for (let x = 0; x <= resolution; x += 1) {
      points.push(evaluateTerrainPoint(x * spacing, z * spacing, 17, modifiers))
    }
  }
  const area = (a: number, b: number, c: number) =>
    (points[b].x - points[a].x) * (points[c].z - points[a].z) -
    (points[c].x - points[a].x) * (points[b].z - points[a].z)

  let folded = 0
  let total = 0
  let maxLateral = 0
  for (let z = 0; z < resolution; z += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const a = z * width + x
      const b = a + 1
      const c = a + width
      const d = c + 1
      // The flat grid gives both triangles a consistent sign; a flip means the
      // triangle has turned inside out in the XZ plane, i.e. the surface folded.
      for (const [i, j, k] of [[a, c, b], [b, c, d]] as const) {
        total += 1
        if (area(i, j, k) >= 0) folded += 1
      }
    }
  }
  for (let z = 0; z <= resolution; z += 1) {
    for (let x = 0; x <= resolution; x += 1) {
      const point = points[z * width + x]
      maxLateral = Math.max(maxLateral, Math.hypot(point.x - x * spacing, point.z - z * spacing))
    }
  }
  return `${mode}/${domain} s=${strength}: folded=${folded}/${total} maxLateral=${maxLateral.toFixed(1)}m`
}

/** Several overlapping strokes worked over the same ground, as a user does. */
function workedAreaReport(mode: BrushMode, strokeCount: number) {
  const strokes = []
  for (let index = 0; index < strokeCount; index += 1) {
    const angle = (index / strokeCount) * Math.PI * 2
    const originX = 64 + Math.cos(angle) * 12
    const originZ = 64 + Math.sin(angle) * 12
    const stroke = createBrushStroke({
      point: { x: originX, y: evaluateHeight(originX, originZ, 17, []), z: originZ },
      normal: surfaceNormal(originX, originZ),
      domain: 'mesh',
      mode,
      radius: 22,
      strength: 0.6,
      falloff: 0.55,
      sampleWeight: 0.22,
    })
    for (let step = 1; step <= 14; step += 1) {
      const x = originX - Math.cos(angle) * step * 1.8
      const z = originZ - Math.sin(angle) * step * 1.8
      appendBrushPoint(stroke, { x, y: evaluateHeight(x, z, 17, []), z }, surfaceNormal(x, z), 0.22)
    }
    strokes.push(stroke)
  }
  const modifiers = materializeModifierTransforms(strokes)
  const resolution = 88
  const spacing = 128 / resolution
  const width = resolution + 1
  const points: { x: number; y: number; z: number }[] = []
  for (let z = 0; z <= resolution; z += 1) {
    for (let x = 0; x <= resolution; x += 1) {
      points.push(evaluateTerrainPoint(x * spacing, z * spacing, 17, modifiers))
    }
  }
  const area = (a: number, b: number, c: number) =>
    (points[b].x - points[a].x) * (points[c].z - points[a].z) -
    (points[c].x - points[a].x) * (points[b].z - points[a].z)
  let folded = 0
  let total = 0
  let maxLateral = 0
  for (let z = 0; z < resolution; z += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const a = z * width + x
      const b = a + 1
      const c = a + width
      const d = c + 1
      for (const [i, j, k] of [[a, c, b], [b, c, d]] as const) {
        total += 1
        if (area(i, j, k) >= 0) folded += 1
      }
    }
  }
  for (let index = 0; index < points.length; index += 1) {
    const x = (index % width) * spacing
    const z = Math.floor(index / width) * spacing
    maxLateral = Math.max(maxLateral, Math.hypot(points[index].x - x, points[index].z - z))
  }
  return `${mode} x${strokeCount} strokes: folded=${folded}/${total} maxLateral=${maxLateral.toFixed(1)}m`
}

/** The pointer pressed and held in one spot, as when hesitating mid-edit. */
function heldBrushReport(mode: BrushMode, seconds: number) {
  const stroke = createBrushStroke({
    point: { x: 64, y: evaluateHeight(64, 64, 17, []), z: 64 },
    normal: surfaceNormal(64, 64),
    domain: 'mesh',
    mode,
    radius: 22,
    strength: 1,
    falloff: 0.55,
    sampleWeight: 0.1,
  })
  // advanceActiveStroke appends dabs of at most 0.25 at 1.5 weight per second.
  const dabs = Math.round((seconds * 1.5) / 0.25)
  for (let index = 0; index < dabs; index += 1) {
    appendBrushPoint(stroke, { x: 64, y: evaluateHeight(64, 64, 17, []), z: 64 }, surfaceNormal(64, 64), 0.25)
  }
  const modifiers = materializeModifierTransforms([stroke])
  const base = evaluateTerrainPoint(64, 64, 17, [])
  const point = evaluateTerrainPoint(64, 64, 17, modifiers)
  return `${mode} held ${seconds}s (${dabs} dabs): moved=${Math.hypot(point.x - base.x, point.y - base.y, point.z - base.z).toFixed(1)}m (brush radius 22)`
}

it('repro: folding by tool', () => {
  for (const line of [
    heldBrushReport('raise', 2),
    heldBrushReport('raise', 5),
    heldBrushReport('lower', 5),
    heldBrushReport('clay', 5),
    foldReport('lower', 'mesh', 1),
    foldReport('pinch', 'mesh', 1),
    workedAreaReport('lower', 4),
    workedAreaReport('lower', 8),
    workedAreaReport('raise', 8),
    workedAreaReport('clay', 8),
    workedAreaReport('pinch', 4),
    workedAreaReport('pinch', 12),
    workedAreaReport('pinch', 24),
    workedAreaReport('lower', 24),
    workedAreaReport('raise', 24),
    workedAreaReport('noise', 24),
    workedAreaReport('scrape', 24),
    workedAreaReport('flatten', 24),
    workedAreaReport('smooth', 24),
    workedAreaReport('terrace', 24),
  ]) {
    console.error(line)
  }
  expect(true).toBe(true)
})
