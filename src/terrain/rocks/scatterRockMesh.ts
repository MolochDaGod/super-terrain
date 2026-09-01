import { displacement, massSdf } from './glacialGraniteField'
import { graniteMassingOfSeed } from './types'

/**
 * Granite boulders fast enough to scatter.
 *
 * `generateGraniteRock` produces the real thing — the analytic field
 * materialised through a QEF dual contour and repaired into a closed
 * two-manifold suitable for exact CSG — and it takes seconds. That is the
 * correct price for a hero outcrop the camera walks up to, and it is an
 * impossible one for the several thousand rocks a hillside needs.
 *
 * The saving here comes from giving up the one property the slow path exists
 * to guarantee. Dual contouring can extract *any* isosurface: handles, voids,
 * overhangs, the arch formation's hole. Paying for that means sampling a
 * volume — sixty-four cubed is a quarter of a million field evaluations before
 * a single triangle exists. A boulder lying on a hillside is star-shaped
 * almost by definition: it is what is left after everything that could break
 * off has, so from a point inside it every direction leaves the solid exactly
 * once. Under that assumption the surface is a *function of direction*, and
 * finding it means one bisection along each ray rather than a search through a
 * volume.
 *
 * Six hundred and forty-two directions at fourteen bisection steps is nine
 * thousand evaluations against a quarter of a million, and the evaluations are
 * cheaper as well: the bisection runs against `massSdf` alone, which is the
 * envelope and the joint planes and nothing else, while the Worley searches
 * and fBm stacks in `displacement` are paid once per vertex at the end. The
 * result is the same shape language as the hero rocks — same envelopes, same
 * three joint sets, same spall scars, same grain — from the same field, in
 * about two milliseconds.
 *
 * What it cannot do is the arch. `graniteMassingOfSeed` can return a formation
 * whose defining feature is a hole through it, and a radial solve will close
 * that hole silently rather than fail. So the formation is chosen here rather
 * than accepted from the seed, and the genus-one one is not on the list.
 */

/** Formations whose surface is star-shaped about their own centre. */
const SCATTER_FORMATIONS = ['erratic', 'tor', 'bench', 'prow', 'monolith'] as const

/**
 * A seed whose formation is one this method can represent.
 *
 * Walks forward rather than picking from the list directly, because the
 * formation is only one of the things a seed decides — the joint-plane
 * wobble, the scar placement and the noise are all keyed to it too, and
 * choosing the seed keeps all of them consistent with the formation.
 */
export function scatterRockSeed(requested: number): number {
  const allowed = new Set<string>(SCATTER_FORMATIONS)
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const seed = requested + attempt
    if (allowed.has(graniteMassingOfSeed(seed))) return seed
  }
  return requested
}

export interface ScatterRockOptions {
  seed: number
  /**
   * Icosphere subdivisions. Each step quadruples the triangle count:
   * 1 is 80 triangles, 2 is 320, 3 is 1,280, 4 is 5,120.
   */
  subdivisions: number
  /**
   * Shortest noise band to resolve, in field units. Bands finer than this are
   * skipped, which is both a saving and a requirement: displacing a mesh with
   * detail it has no vertices to carry produces noise, not grain. Derived from
   * the tessellation by `scatterRockWavelength` unless overridden.
   */
  minimumWavelength?: number
  /**
   * Dihedral angle, in degrees, above which an edge stays sharp. Granite's
   * whole character is flat fracture facets meeting rounded weathered ones, so
   * a single smoothing rule loses one or the other: average everything and the
   * facets round off into a potato, average nothing and the weathered backs
   * turn into a geodesic dome.
   */
  sharpAngleDegrees?: number
}

export interface ScatterRockMesh {
  /** Non-indexed, three vertices per triangle. */
  positions: Float32Array
  normals: Float32Array
  /** Half-extents of the mesh, in field units, about the local origin. */
  extent: readonly [number, number, number]
  triangles: number
}

/**
 * Finest band worth resolving at a given tessellation.
 *
 * An icosahedron inscribed in the unit sphere has an edge of 1.0515, halved by
 * each subdivision, and a displacement band needs about two and a half
 * vertices across it before it describes a shape rather than a jitter.
 *
 * The first cut of this used the sphere's *diameter* in place of the edge and
 * so overstated the spacing by a factor of two. The effect was not subtle and
 * not obviously a bug: every band in `BANDS` fell below the threshold at every
 * subdivision this generator uses, so the rocks came out as bare `massSdf` —
 * correctly faceted envelopes with no grain on them at all, which reads as
 * smooth lumps rather than as granite. A guard against detail the mesh cannot
 * carry has to be measured against what the mesh actually carries.
 */
export function scatterRockWavelength(subdivisions: number): number {
  return (1.0515 / 2 ** subdivisions) * 2.5
}

/**
 * Where the surface lies along one direction.
 *
 * Bisection rather than sphere tracing. The mass SDF is built from `smax` and
 * `smin`, which are not distance-preserving — a smooth-minimum of two boxoids
 * reports a value well under the true distance near the join — so a sphere
 * trace would either overshoot through a thin facet or crawl. Bisection needs
 * only a sign change, which the star-shape assumption guarantees exists.
 */
function surfaceRadius(
  dx: number,
  dy: number,
  dz: number,
  seed: number,
  steps: number,
): number {
  let low = 0.02
  let high = 2.4
  // The envelope radii top out near 1, and the joint planes only ever cut
  // inward, so 2.4 is outside every formation. Confirm rather than assume:
  // a direction that is somehow still inside at `high` would otherwise
  // bisect onto the wrong side and pull a spike out of the mesh.
  if (massSdf(dx * high, dy * high, dz * high, seed) < 0) return high
  for (let step = 0; step < steps; step += 1) {
    const middle = (low + high) * 0.5
    if (massSdf(dx * middle, dy * middle, dz * middle, seed) < 0) low = middle
    else high = middle
  }
  return (low + high) * 0.5
}

export function createScatterRockMesh(
  options: ScatterRockOptions,
): ScatterRockMesh {
  const seed = options.seed
  const subdivisions = Math.max(0, Math.min(5, Math.floor(options.subdivisions)))
  const minimumWavelength =
    options.minimumWavelength ?? scatterRockWavelength(subdivisions)
  const sharpCosine = Math.cos(
    ((options.sharpAngleDegrees ?? 34) * Math.PI) / 180,
  )

  const sphere = icosphere(subdivisions)
  const directions = sphere.directions
  const vertexCount = directions.length / 3
  const vertices = new Float64Array(vertexCount * 3)

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3
    const dx = directions[offset]!
    const dy = directions[offset + 1]!
    const dz = directions[offset + 2]!
    const radius = surfaceRadius(dx, dy, dz, seed, 14)
    // One noise evaluation, at the mass surface, applied along the ray.
    //
    // Displacing along the *direction* rather than along the surface normal is
    // an approximation, and on a facet cut steeply across the ray it
    // understates the offset by the cosine between them. It is the right
    // approximation to make: recovering the true normal would mean four more
    // field evaluations per vertex to build a gradient, for a correction that
    // moves a two-centimetre grain feature by a few millimetres on the minority
    // of vertices where the two directions differ appreciably.
    const grain = displacement(
      dx * radius,
      dy * radius,
      dz * radius,
      seed,
      minimumWavelength,
    )
    const finalRadius = Math.max(0.05, radius + grain)
    vertices[offset] = dx * finalRadius
    vertices[offset + 1] = dy * finalRadius
    vertices[offset + 2] = dz * finalRadius
  }

  return buildMesh(vertices, sphere.indices, sharpCosine)
}

/**
 * Expands the indexed sphere into the non-indexed mesh the instanced draw
 * wants, and assigns normals by the smoothing rule described on
 * `sharpAngleDegrees`.
 *
 * The normal of a vertex on a given face is the area-weighted average of every
 * face that shares that vertex and lies within the smoothing angle of it. Face
 * area comes in through using the raw cross product rather than a normalised
 * one, which is what keeps a sliver triangle at the apex of a facet from
 * outvoting the facet itself.
 */
function buildMesh(
  vertices: Float64Array,
  indices: Uint32Array,
  sharpCosine: number,
): ScatterRockMesh {
  const triangles = indices.length / 3
  const faceNormals = new Float64Array(triangles * 3)
  for (let face = 0; face < triangles; face += 1) {
    const a = indices[face * 3]! * 3
    const b = indices[face * 3 + 1]! * 3
    const c = indices[face * 3 + 2]! * 3
    const ux = vertices[b]! - vertices[a]!
    const uy = vertices[b + 1]! - vertices[a + 1]!
    const uz = vertices[b + 2]! - vertices[a + 2]!
    const vx = vertices[c]! - vertices[a]!
    const vy = vertices[c + 1]! - vertices[a + 1]!
    const vz = vertices[c + 2]! - vertices[a + 2]!
    faceNormals[face * 3] = uy * vz - uz * vy
    faceNormals[face * 3 + 1] = uz * vx - ux * vz
    faceNormals[face * 3 + 2] = ux * vy - uy * vx
  }

  // Faces per vertex, as a flat CSR-style table so the averaging below does no
  // allocation per vertex.
  const vertexCount = vertices.length / 3
  const faceCounts = new Uint32Array(vertexCount + 1)
  for (let index = 0; index < indices.length; index += 1) {
    faceCounts[indices[index]! + 1] += 1
  }
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    faceCounts[vertex + 1] += faceCounts[vertex]!
  }
  const faceList = new Uint32Array(indices.length)
  const cursor = faceCounts.slice(0, vertexCount)
  for (let index = 0; index < indices.length; index += 1) {
    const vertex = indices[index]!
    faceList[cursor[vertex]!] = (index / 3) | 0
    cursor[vertex] += 1
  }

  const positions = new Float32Array(triangles * 9)
  const normals = new Float32Array(triangles * 9)
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity

  for (let face = 0; face < triangles; face += 1) {
    const fx = faceNormals[face * 3]!
    const fy = faceNormals[face * 3 + 1]!
    const fz = faceNormals[face * 3 + 2]!
    const faceLength = Math.hypot(fx, fy, fz) || 1
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices[face * 3 + corner]!
      let nx = 0
      let ny = 0
      let nz = 0
      for (
        let slot = faceCounts[vertex]!;
        slot < faceCounts[vertex + 1]!;
        slot += 1
      ) {
        const other = faceList[slot]!
        const ox = faceNormals[other * 3]!
        const oy = faceNormals[other * 3 + 1]!
        const oz = faceNormals[other * 3 + 2]!
        const otherLength = Math.hypot(ox, oy, oz) || 1
        const alignment = (fx * ox + fy * oy + fz * oz) / (faceLength * otherLength)
        if (alignment < sharpCosine) continue
        nx += ox
        ny += oy
        nz += oz
      }
      const length = Math.hypot(nx, ny, nz)
      const scale = length > 1e-12 ? 1 / length : 0
      const out = face * 9 + corner * 3
      const source = vertex * 3
      const px = vertices[source]!
      const py = vertices[source + 1]!
      const pz = vertices[source + 2]!
      positions[out] = px
      positions[out + 1] = py
      positions[out + 2] = pz
      if (scale === 0) {
        normals[out] = fx / faceLength
        normals[out + 1] = fy / faceLength
        normals[out + 2] = fz / faceLength
      } else {
        normals[out] = nx * scale
        normals[out + 1] = ny * scale
        normals[out + 2] = nz * scale
      }
      if (px < minX) minX = px
      if (py < minY) minY = py
      if (pz < minZ) minZ = pz
      if (px > maxX) maxX = px
      if (py > maxY) maxY = py
      if (pz > maxZ) maxZ = pz
    }
  }

  // Recentre horizontally and stand the rock on y = 0, matching the planting
  // convention `generateGraniteRock` uses so the two can be placed by the same
  // code.
  const centreX = (minX + maxX) * 0.5
  const centreZ = (minZ + maxZ) * 0.5
  for (let offset = 0; offset < positions.length; offset += 3) {
    positions[offset] -= centreX
    positions[offset + 1] -= minY
    positions[offset + 2] -= centreZ
  }

  return {
    positions,
    normals,
    extent: [
      (maxX - minX) * 0.5,
      maxY - minY,
      (maxZ - minZ) * 0.5,
    ],
    triangles,
  }
}

interface Icosphere {
  directions: Float64Array
  indices: Uint32Array
}

const icosphereCache = new Map<number, Icosphere>()

/**
 * A unit icosphere, as directions plus a triangle list.
 *
 * An icosahedron subdivided on its edges, rather than a UV sphere, because a
 * UV sphere's poles carry a hundred slivers meeting at one vertex and its
 * equator carries quads twice their height — both of which show up as
 * artefacts once the surface is displaced. Every triangle here is within a few
 * per cent of every other.
 */
function icosphere(subdivisions: number): Icosphere {
  const cached = icosphereCache.get(subdivisions)
  if (cached) return cached

  const t = (1 + Math.sqrt(5)) / 2
  let vertices: number[] = [
    -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0,
    0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t,
    t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1,
  ]
  let faces: number[] = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ]

  for (let step = 0; step < subdivisions; step += 1) {
    const midpoints = new Map<number, number>()
    const next: number[] = []
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 1_000_000 + b : b * 1_000_000 + a
      const existing = midpoints.get(key)
      if (existing !== undefined) return existing
      const index = vertices.length / 3
      vertices.push(
        (vertices[a * 3]! + vertices[b * 3]!) * 0.5,
        (vertices[a * 3 + 1]! + vertices[b * 3 + 1]!) * 0.5,
        (vertices[a * 3 + 2]! + vertices[b * 3 + 2]!) * 0.5,
      )
      midpoints.set(key, index)
      return index
    }
    for (let face = 0; face < faces.length; face += 3) {
      const a = faces[face]!
      const b = faces[face + 1]!
      const c = faces[face + 2]!
      const ab = midpoint(a, b)
      const bc = midpoint(b, c)
      const ca = midpoint(c, a)
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca)
    }
    faces = next
  }

  const directions = new Float64Array(vertices.length)
  for (let offset = 0; offset < vertices.length; offset += 3) {
    const x = vertices[offset]!
    const y = vertices[offset + 1]!
    const z = vertices[offset + 2]!
    const length = Math.hypot(x, y, z) || 1
    directions[offset] = x / length
    directions[offset + 1] = y / length
    directions[offset + 2] = z / length
  }

  const sphere: Icosphere = { directions, indices: new Uint32Array(faces) }
  icosphereCache.set(subdivisions, sphere)
  return sphere
}
