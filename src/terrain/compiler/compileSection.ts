import { clamp, lerp, smoothstep } from '../core/bounds'
import type {
  AABB,
  CompiledLOD,
  CompiledSection,
  SectionKey,
} from '../core/types'
import { validateMeshData } from '../mesh/MeshValidation'
import {
  BvhCsgTunnelBooleanBackend,
  type BooleanMeshBuffers,
} from '../modifiers/boolean/MeshBooleanBackend'
import type {
  BooleanSubtractModifier,
  RemeshModifier,
  TerrainModifier,
  TessellateModifier,
} from '../modifiers/types'
import { materializeModifierTransforms } from '../modifiers/transform'
import type { CompileSectionRequest } from '../workers/protocol'
import { decodeModifiers } from '../workers/protocol'
import {
  evaluateTerrainPoint,
  hasLateralDisplacement,
} from './TerrainField'
import {
  evaluateTerrainMaterialFields,
  type TerrainMaterialFields,
} from './TerrainMaterialFields'

export { evaluateHeight } from './TerrainField'

interface GeneratedMesh {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  surfaceFields: readonly [
    Uint16Array,
    Uint16Array,
    Uint16Array,
    Uint16Array,
    Uint16Array,
  ]
  indices: Uint32Array
  warnings: number
  hasArbitraryTopology: boolean
}

const tunnelBackend = new BvhCsgTunnelBooleanBackend()

export function compileTerrainSection(
  request: CompileSectionRequest,
): CompiledSection {
  const started = performance.now()
  const modifiers = materializeModifierTransforms(
    decodeModifiers(request.modifiers),
  )
  const lods: CompiledLOD[] = []
  let minY = Infinity
  let maxY = -Infinity
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  let warnings = 0
  let vertexCount = 0
  let triangleCount = 0
  let hasArbitraryTopology = false
  let cpuBytes = 0
  const materialFieldCache = new Map<string, TerrainMaterialFields>()

  for (let level = 0; level < request.config.lodResolutions.length; level += 1) {
    if (request.levels && !request.levels.includes(level)) continue
    const resolution = request.config.lodResolutions[level]
    const generated = generateSectionMesh(
      request.key,
      request.config.sectionSize,
      resolution,
      level,
      request.config.seed,
      modifiers,
      materialFieldCache,
    )
    const originX = request.key.x * request.config.sectionSize
    const originZ = request.key.z * request.config.sectionSize
    for (let index = 0; index < generated.positions.length; index += 3) {
      minX = Math.min(minX, originX + generated.positions[index])
      maxX = Math.max(maxX, originX + generated.positions[index])
      minY = Math.min(minY, generated.positions[index + 1])
      maxY = Math.max(maxY, generated.positions[index + 1])
      minZ = Math.min(minZ, originZ + generated.positions[index + 2])
      maxZ = Math.max(maxZ, originZ + generated.positions[index + 2])
    }
    const gpuBytes =
      generated.positions.byteLength +
      generated.normals.byteLength +
      generated.colors.byteLength +
      generated.surfaceFields.reduce((bytes, field) => bytes + field.byteLength, 0) +
      generated.indices.byteLength
    lods.push({
      level,
      geometricError:
        (request.config.sectionSize / (resolution * resolution)) *
        (0.18 + level * 0.2),
      positions: generated.positions,
      normals: generated.normals,
      colors: generated.colors,
      surfaceFields: generated.surfaceFields,
      indices: generated.indices,
      triangleCount: generated.indices.length / 3,
      gpuBytes,
    })
    cpuBytes += gpuBytes
    warnings += generated.warnings
    hasArbitraryTopology ||= generated.hasArbitraryTopology
    if (level === 0) {
      vertexCount = generated.positions.length / 3
      triangleCount = generated.indices.length / 3
    }
  }

  const bounds: AABB = {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  }

  return {
    key: request.key,
    sourceRevision: request.revision,
    bounds,
    lods,
    cpuBytes,
    metadata: {
      compileMs: performance.now() - started,
      vertexCount,
      triangleCount,
      density: vertexCount / (request.config.sectionSize * request.config.sectionSize),
      hasArbitraryTopology,
      validationWarnings: warnings,
    },
  }
}

function generateSectionMesh(
  key: SectionKey,
  sectionSize: number,
  resolution: number,
  level: number,
  seed: number,
  modifiers: TerrainModifier[],
  materialFieldCache: Map<string, TerrainMaterialFields>,
): GeneratedMesh {
  const originX = key.x * sectionSize
  const originZ = key.z * sectionSize
  const densityModifiers = modifiers.filter(
    (modifier): modifier is RemeshModifier | TessellateModifier =>
      modifier.type === 'remesh' || modifier.type === 'tessellate',
  )
  const tunnels = modifiers.filter(
    (modifier): modifier is BooleanSubtractModifier =>
      modifier.type === 'boolean-subtract',
  )
  const xAxis = createAdaptiveAxis(
    originX,
    sectionSize,
    resolution,
    level,
    densityModifiers,
    'x',
  )
  const zAxis = createAdaptiveAxis(
    originZ,
    sectionSize,
    resolution,
    level,
    densityModifiers,
    'z',
  )
  const positions: number[] = []
  const parameters: number[] = []
  const indices: number[] = []

  for (const worldZ of zAxis) {
    for (const worldX of xAxis) {
      const point = evaluateTerrainPoint(worldX, worldZ, seed, modifiers)
      positions.push(
        point.x - originX,
        point.y,
        point.z - originZ,
      )
      parameters.push(worldX, worldZ)
    }
  }

  const width = xAxis.length
  for (let z = 0; z < zAxis.length - 1; z += 1) {
    for (let x = 0; x < xAxis.length - 1; x += 1) {
      const a = z * width + x
      const b = a + 1
      const c = a + width
      const d = c + 1
      if ((x + z) % 2 === 0) {
        indices.push(a, c, b, b, c, d)
      } else {
        indices.push(a, c, d, a, d, b)
      }
    }
  }

  const positionArray = Float32Array.from(positions)
  const indexArray = Uint32Array.from(indices)
  const surfaceNormals = calculateNormals(positionArray, indexArray)
  stabilizeBoundaryNormals(
    surfaceNormals,
    parameters,
    originX,
    originZ,
    sectionSize,
    seed,
    modifiers,
  )
  const baseBuffers: BooleanMeshBuffers = {
    positions: positionArray,
    normals: surfaceNormals,
    indices: indexArray,
    interiorVertices: new Uint8Array(positionArray.length / 3),
  }
  const result =
    tunnels.length > 0
      ? tunnelBackend.subtract(
          baseBuffers,
          tunnels,
          originX,
          originZ,
          sectionSize,
          Math.max(0.5, 1 - level * 0.12),
        )
      : baseBuffers

  const colors = calculateColors(
    result.positions,
    result.normals,
    result.interiorVertices,
  )
  const surfaceFields = calculateSurfaceFields(
    result.positions,
    result.normals,
    result.indices,
    result.interiorVertices,
    originX,
    originZ,
    materialFieldCache,
  )
  const validation = validateMeshData(result.positions, result.indices)
  if (!validation.valid) throw new Error(validation.errors.join('; '))
  return {
    positions: result.positions,
    normals: result.normals,
    colors,
    surfaceFields,
    indices: result.indices,
    warnings: validation.warnings.length,
    hasArbitraryTopology:
      tunnels.length > 0 || hasLateralDisplacement(modifiers),
  }
}

const PACKED_UNIT_MAX = 65_535
const BEDDED_OFFSET_RANGE = 16

function calculateSurfaceFields(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  interiorVertices: Uint8Array,
  originX: number,
  originZ: number,
  cache: Map<string, TerrainMaterialFields>,
): readonly [Uint16Array, Uint16Array, Uint16Array, Uint16Array, Uint16Array] {
  const vertexCount = positions.length / 3
  const packed: [Uint16Array, Uint16Array, Uint16Array, Uint16Array, Uint16Array] = [
    new Uint16Array(vertexCount * 4),
    new Uint16Array(vertexCount * 4),
    new Uint16Array(vertexCount * 4),
    new Uint16Array(vertexCount * 4),
    new Uint16Array(vertexCount * 4),
  ]
  const occlusion = calculateMeshOcclusion(
    positions,
    normals,
    indices,
    interiorVertices,
  )

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const source = vertex * 3
    const target = vertex * 4
    const x = originX + positions[source]
    const y = positions[source + 1]
    const z = originZ + positions[source + 2]
    const key = `${x}:${y}:${z}`
    let fields = cache.get(key)
    if (!fields) {
      fields = evaluateTerrainMaterialFields(x, y, z)
      cache.set(key, fields)
    }

    packed[0].set([
      packUnit(fields.regional * 0.5 + 0.5),
      packUnit(fields.patch),
      packUnit(fields.moisture),
      packUnit(fields.macro),
    ], target)
    packed[1].set([
      packUnit(fields.dipAngle),
      packUnit(fields.dipAzimuth),
      packUnit(fields.bedThickness),
      packUnit(fields.bedExposure),
    ], target)
    packed[2].set([
      packUnit(fields.jointing),
      packUnit(fields.lichen),
      packUnit(fields.outcrop),
      packUnit(fields.mottle),
    ], target)
    packed[3].set([
      packSigned(fields.beddedOffsetX, BEDDED_OFFSET_RANGE),
      packSigned(fields.beddedOffsetY, BEDDED_OFFSET_RANGE),
      packSigned(fields.beddedOffsetZ, BEDDED_OFFSET_RANGE),
      packUnit(fields.regionalTint),
    ], target)
    packed[4][target] = packUnit(fields.buttress)
    packed[4][target + 1] = packUnit(occlusion[vertex])
    packed[4][target + 2] = 0
    packed[4][target + 3] = 0
  }
  return packed
}

/**
 * Multiscale object-space cavity. Unlike GTAO this is tied to the compiled
 * surface, so it is paid once and remains stable as the camera moves. Repeated
 * cotangent-like neighbourhood relaxation measures how far a point sits below
 * its surroundings at progressively wider radii; tunnel interiors additionally
 * retain the low ambient visibility that their enclosing geometry implies.
 */
function calculateMeshOcclusion(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  interiorVertices: Uint8Array,
): Float32Array {
  const vertexCount = positions.length / 3
  let smoothed = new Float32Array(positions)
  const cavity = new Float32Array(vertexCount)
  const accumulation = new Float32Array(positions.length)
  const counts = new Uint32Array(vertexCount)

  for (let iteration = 0; iteration < 8; iteration += 1) {
    accumulation.fill(0)
    counts.fill(0)
    for (let offset = 0; offset < indices.length; offset += 3) {
      const a = indices[offset]
      const b = indices[offset + 1]
      const c = indices[offset + 2]
      accumulateNeighbours(accumulation, counts, smoothed, a, b, c)
      accumulateNeighbours(accumulation, counts, smoothed, b, c, a)
      accumulateNeighbours(accumulation, counts, smoothed, c, a, b)
    }

    const next = new Float32Array(smoothed.length)
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const target = vertex * 3
      const count = Math.max(1, counts[vertex])
      const meanX = accumulation[target] / count
      const meanY = accumulation[target + 1] / count
      const meanZ = accumulation[target + 2] / count
      next[target] = smoothed[target] * 0.38 + meanX * 0.62
      next[target + 1] = smoothed[target + 1] * 0.38 + meanY * 0.62
      next[target + 2] = smoothed[target + 2] * 0.38 + meanZ * 0.62

      if (iteration === 0 || iteration === 1 || iteration === 3 || iteration === 7) {
        const dx = next[target] - positions[target]
        const dy = next[target + 1] - positions[target + 1]
        const dz = next[target + 2] - positions[target + 2]
        const inward =
          dx * normals[target] +
          dy * normals[target + 1] +
          dz * normals[target + 2]
        cavity[vertex] = Math.max(cavity[vertex], inward)
      }
    }
    smoothed = next
  }

  const occlusion = new Float32Array(vertexCount)
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const broadCavity = 1 - smoothstepNumber(0.015, 4.5, cavity[vertex]) * 0.58
    const interiorVisibility = interiorVertices[vertex] === 1 ? 0.52 : 1
    occlusion[vertex] = clamp(broadCavity * interiorVisibility, 0.32, 1)
  }
  return occlusion
}

function accumulateNeighbours(
  accumulation: Float32Array,
  counts: Uint32Array,
  positions: Float32Array,
  targetVertex: number,
  firstNeighbour: number,
  secondNeighbour: number,
): void {
  const target = targetVertex * 3
  const first = firstNeighbour * 3
  const second = secondNeighbour * 3
  accumulation[target] += positions[first] + positions[second]
  accumulation[target + 1] += positions[first + 1] + positions[second + 1]
  accumulation[target + 2] += positions[first + 2] + positions[second + 2]
  counts[targetVertex] += 2
}

function smoothstepNumber(low: number, high: number, value: number): number {
  const amount = clamp((value - low) / (high - low), 0, 1)
  return amount * amount * (3 - 2 * amount)
}

function packUnit(value: number): number {
  return Math.round(clamp(value, 0, 1) * PACKED_UNIT_MAX)
}

function packSigned(value: number, range: number): number {
  return packUnit(value / (range * 2) + 0.5)
}

function createAdaptiveAxis(
  origin: number,
  size: number,
  resolution: number,
  level: number,
  modifiers: (RemeshModifier | TessellateModifier)[],
  axis: 'x' | 'z',
): number[] {
  const coordinates = new Set<number>()
  for (let index = 0; index <= resolution; index += 1) {
    coordinates.add(roundCoordinate(origin + (index / resolution) * size))
  }
  if (level <= 2) {
    for (const modifier of modifiers) {
      const center = modifier.center[axis]
      const minimum = Math.max(origin, center - modifier.radius)
      const maximum = Math.min(origin + size, center + modifier.radius)
      // Keep modifier-authored boundary samples identical across every LOD.
      // The nested base grid still becomes coarser, but a density region may
      // not introduce a different edge tessellation on each side of a seam.
      const spacing = clamp(modifier.targetEdgeLength, size / 96, size / 6)
      const maxLines = 48
      let lines = 0
      for (let coordinate = minimum; coordinate <= maximum && lines < maxLines; coordinate += spacing) {
        coordinates.add(roundCoordinate(coordinate))
        lines += 1
      }
      coordinates.add(roundCoordinate(maximum))
    }
  }
  return [...coordinates].sort((a, b) => a - b)
}

function roundCoordinate(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function stabilizeBoundaryNormals(
  normals: Float32Array,
  parameters: number[],
  originX: number,
  originZ: number,
  sectionSize: number,
  seed: number,
  modifiers: TerrainModifier[],
): void {
  const epsilon = 0.35
  const maximumX = originX + sectionSize
  const maximumZ = originZ + sectionSize
  for (let vertex = 0; vertex < parameters.length / 2; vertex += 1) {
    const worldX = parameters[vertex * 2]
    const worldZ = parameters[vertex * 2 + 1]
    const boundary =
      Math.abs(worldX - originX) < 1e-4 ||
      Math.abs(worldX - maximumX) < 1e-4 ||
      Math.abs(worldZ - originZ) < 1e-4 ||
      Math.abs(worldZ - maximumZ) < 1e-4
    if (!boundary) continue

    const left = evaluateTerrainPoint(worldX - epsilon, worldZ, seed, modifiers)
    const right = evaluateTerrainPoint(worldX + epsilon, worldZ, seed, modifiers)
    const north = evaluateTerrainPoint(worldX, worldZ - epsilon, seed, modifiers)
    const south = evaluateTerrainPoint(worldX, worldZ + epsilon, seed, modifiers)
    const tx = {
      x: right.x - left.x,
      y: right.y - left.y,
      z: right.z - left.z,
    }
    const tz = {
      x: south.x - north.x,
      y: south.y - north.y,
      z: south.z - north.z,
    }
    let nx = tz.y * tx.z - tz.z * tx.y
    let ny = tz.z * tx.x - tz.x * tx.z
    let nz = tz.x * tx.y - tz.y * tx.x
    if (ny < 0) {
      nx *= -1
      ny *= -1
      nz *= -1
    }
    const length = Math.hypot(nx, ny, nz) || 1
    const offset = vertex * 3
    normals[offset] = nx / length
    normals[offset + 1] = ny / length
    normals[offset + 2] = nz / length
  }
}

function calculateNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length)
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index] * 3
    const b = indices[index + 1] * 3
    const c = indices[index + 2] * 3
    const abx = positions[b] - positions[a]
    const aby = positions[b + 1] - positions[a + 1]
    const abz = positions[b + 2] - positions[a + 2]
    const acx = positions[c] - positions[a]
    const acy = positions[c + 1] - positions[a + 1]
    const acz = positions[c + 2] - positions[a + 2]
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    normals[a] += nx
    normals[a + 1] += ny
    normals[a + 2] += nz
    normals[b] += nx
    normals[b + 1] += ny
    normals[b + 2] += nz
    normals[c] += nx
    normals[c + 1] += ny
    normals[c + 2] += nz
  }
  for (let index = 0; index < normals.length; index += 3) {
    const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]) || 1
    normals[index] /= length
    normals[index + 1] /= length
    normals[index + 2] /= length
  }
  return normals
}

function calculateColors(
  positions: Float32Array,
  normals: Float32Array,
  interiorVertices: Uint8Array,
): Float32Array {
  const colors = new Float32Array(positions.length)
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const offset = vertex * 3
    if (interiorVertices[vertex] === 1) {
      const variation = 0.82 + Math.sin(positions[offset] * 0.14 + positions[offset + 2] * 0.11) * 0.08
      colors[offset] = 0.23 * variation
      colors[offset + 1] = 0.2 * variation
      colors[offset + 2] = 0.16 * variation
      continue
    }
    const slope = 1 - Math.abs(normals[offset + 1])
    const altitude = smoothstep(20, 78, positions[offset + 1])
    const grass = { r: 0.23, g: 0.35, b: 0.2 }
    const rock = { r: 0.36, g: 0.32, b: 0.27 }
    const high = { r: 0.48, g: 0.48, b: 0.43 }
    const rockMix = smoothstep(0.2, 0.72, slope)
    colors[offset] = lerp(lerp(grass.r, rock.r, rockMix), high.r, altitude)
    colors[offset + 1] = lerp(lerp(grass.g, rock.g, rockMix), high.g, altitude)
    colors[offset + 2] = lerp(lerp(grass.b, rock.b, rockMix), high.b, altitude)
  }
  return colors
}
