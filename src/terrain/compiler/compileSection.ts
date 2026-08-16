import { MeshoptSimplifier } from 'meshoptimizer/simplifier'
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
  BrushStrokeModifier,
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
  /** Vertices authored by a modifier that must survive every LOD. */
  featureLocks: Uint8Array
  warnings: number
  hasArbitraryTopology: boolean
}

const tunnelBackend = new BvhCsgTunnelBooleanBackend()
const MISSING_VERTEX = 0xffff_ffff
const POSITION_ERROR_FRACTION = 0.075

let meshSimplifierAvailable = false
try {
  await MeshoptSimplifier.ready
  meshSimplifierAvailable = MeshoptSimplifier.supported
} catch {
  // Retaining the authoritative mesh is a safe fallback on platforms without
  // WebAssembly. It costs memory, but never drops authored terrain topology.
}

export function compileTerrainSection(
  request: CompileSectionRequest,
): CompiledSection {
  const started = performance.now()
  const modifiers = materializeModifierTransforms(
    decodeModifiers(request.modifiers),
  )
  const requestedLevels = normalizedRequestedLevels(request)
  if (requestedLevels.length === 0) {
    throw new Error('Section compile requested no valid LOD levels')
  }
  const hasLocalAuthoring = modifiers.some(
    (modifier) =>
      modifier.enabled &&
      (modifier.type === 'brush-stroke' ||
        modifier.type === 'boolean-subtract' ||
        modifier.type === 'remesh' ||
        modifier.type === 'tessellate'),
  )
  // Local edits must always be sampled by the finest authoritative grid, even
  // when a caller asks for only a distant LOD. Procedural capture requests can
  // start at their finest requested level and avoid compiling hidden detail.
  const sourceLevel = hasLocalAuthoring ? 0 : requestedLevels[0]
  const sourceResolution = request.config.lodResolutions[sourceLevel]
  const source = generateSectionMesh(
    request.key,
    request.config.sectionSize,
    sourceResolution,
    request.config.seed,
    modifiers,
    new Map<string, TerrainMaterialFields>(),
  )
  const lods: CompiledLOD[] = []
  let minY = Infinity
  let maxY = -Infinity
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  let warnings = source.warnings
  let cpuBytes = 0
  const originX = request.key.x * request.config.sectionSize
  const originZ = request.key.z * request.config.sectionSize
  for (let index = 0; index < source.positions.length; index += 3) {
    minX = Math.min(minX, originX + source.positions[index])
    maxX = Math.max(maxX, originX + source.positions[index])
    minY = Math.min(minY, source.positions[index + 1])
    maxY = Math.max(maxY, source.positions[index + 1])
    minZ = Math.min(minZ, originZ + source.positions[index + 2])
    maxZ = Math.max(maxZ, originZ + source.positions[index + 2])
  }

  const sourceGeometricError = sourceLevel === 0
    ? 0
    : lodErrorBudget(request.config.sectionSize, sourceResolution)
  let previousError = sourceGeometricError
  for (const level of requestedLevels) {
    const resolution = request.config.lodResolutions[level]
    const simplified = level === sourceLevel
      ? { mesh: source, geometricError: previousError }
      : simplifyGeneratedMesh(
          source,
          sourceResolution,
          resolution,
          request.config.sectionSize,
          sourceGeometricError,
        )
    const generated = simplified.mesh
    previousError = Math.max(previousError, simplified.geometricError)
    const gpuBytes = generatedMeshBytes(generated)
    lods.push({
      level,
      geometricError: previousError,
      positions: generated.positions,
      normals: generated.normals,
      colors: generated.colors,
      surfaceFields: generated.surfaceFields,
      indices: generated.indices,
      triangleCount: generated.indices.length / 3,
      gpuBytes,
    })
    cpuBytes += gpuBytes
    if (generated !== source) warnings += generated.warnings
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
      vertexCount: source.positions.length / 3,
      triangleCount: source.indices.length / 3,
      density:
        source.positions.length /
        3 /
        (request.config.sectionSize * request.config.sectionSize),
      hasArbitraryTopology: source.hasArbitraryTopology,
      validationWarnings: warnings,
    },
  }
}

function normalizedRequestedLevels(request: CompileSectionRequest): number[] {
  const configured = request.config.lodResolutions.length
  const levels = request.levels ?? Array.from(
    { length: configured },
    (_, level) => level,
  )
  return [...new Set(levels)]
    .filter((level) => Number.isInteger(level) && level >= 0 && level < configured)
    .sort((a, b) => a - b)
}

function simplifyGeneratedMesh(
  source: GeneratedMesh,
  sourceResolution: number,
  targetResolution: number,
  sectionSize: number,
  sourceGeometricError: number,
): { mesh: GeneratedMesh; geometricError: number } {
  if (!meshSimplifierAvailable || targetResolution >= sourceResolution) {
    return {
      mesh: cloneGeneratedMesh(source),
      geometricError: sourceGeometricError,
    }
  }

  const triangleRatio = (targetResolution / sourceResolution) ** 2
  const targetIndexCount = Math.max(
    3,
    Math.min(
      source.indices.length,
      Math.floor((source.indices.length * triangleRatio) / 3) * 3,
    ),
  )
  const absoluteErrorLimit = Math.max(
    0.01,
    lodErrorBudget(sectionSize, targetResolution) - sourceGeometricError,
  )
  try {
    const [indices, measuredError] = MeshoptSimplifier.simplifyWithAttributes(
      source.indices,
      source.positions,
      3,
      source.normals,
      3,
      [0.5, 0.5, 0.5],
      source.featureLocks,
      targetIndexCount,
      absoluteErrorLimit,
      ['LockBorder', 'ErrorAbsolute'],
    )
    const safeError = Number.isFinite(measuredError)
      ? Math.max(0, measuredError)
      : absoluteErrorLimit
    return {
      mesh: compactGeneratedMesh(source, indices),
      geometricError: sourceGeometricError + safeError,
    }
  } catch {
    // Invalid or unusually fragmented topology should cost detail, not make a
    // section disappear. The source mesh is always a valid renderable LOD.
    return {
      mesh: cloneGeneratedMesh(source),
      geometricError: sourceGeometricError,
    }
  }
}

function cloneGeneratedMesh(source: GeneratedMesh): GeneratedMesh {
  return {
    positions: new Float32Array(source.positions),
    normals: new Float32Array(source.normals),
    colors: new Float32Array(source.colors),
    surfaceFields: source.surfaceFields.map((field) =>
      new Uint16Array(field),
    ) as unknown as GeneratedMesh['surfaceFields'],
    indices: new Uint32Array(source.indices),
    featureLocks: new Uint8Array(source.featureLocks),
    warnings: source.warnings,
    hasArbitraryTopology: source.hasArbitraryTopology,
  }
}

function compactGeneratedMesh(
  source: GeneratedMesh,
  simplifiedIndices: Uint32Array,
): GeneratedMesh {
  const indices = new Uint32Array(simplifiedIndices)
  const [remap, vertexCount] = MeshoptSimplifier.compactMesh(indices)
  const positions = remapFloatStream(source.positions, 3, remap, vertexCount)
  const normals = remapFloatStream(source.normals, 3, remap, vertexCount)
  const colors = remapFloatStream(source.colors, 3, remap, vertexCount)
  const surfaceFields = source.surfaceFields.map((field) =>
    remapUint16Stream(field, 4, remap, vertexCount),
  ) as unknown as GeneratedMesh['surfaceFields']
  const featureLocks = remapUint8Stream(
    source.featureLocks,
    remap,
    vertexCount,
  )
  const validation = validateMeshData(positions, indices)
  if (!validation.valid) throw new Error(validation.errors.join('; '))
  return {
    positions,
    normals,
    colors,
    surfaceFields,
    indices,
    featureLocks,
    warnings: validation.warnings.length,
    hasArbitraryTopology: source.hasArbitraryTopology,
  }
}

function remapFloatStream(
  source: Float32Array,
  stride: number,
  remap: Uint32Array,
  vertexCount: number,
): Float32Array {
  const target = new Float32Array(vertexCount * stride)
  remapVertexStream(source, target, stride, remap)
  return target
}

function remapUint16Stream(
  source: Uint16Array,
  stride: number,
  remap: Uint32Array,
  vertexCount: number,
): Uint16Array {
  const target = new Uint16Array(vertexCount * stride)
  remapVertexStream(source, target, stride, remap)
  return target
}

function remapUint8Stream(
  source: Uint8Array,
  remap: Uint32Array,
  vertexCount: number,
): Uint8Array {
  const target = new Uint8Array(vertexCount)
  remapVertexStream(source, target, 1, remap)
  return target
}

function remapVertexStream(
  source: Float32Array | Uint16Array | Uint8Array,
  target: Float32Array | Uint16Array | Uint8Array,
  stride: number,
  remap: Uint32Array,
): void {
  for (let sourceVertex = 0; sourceVertex < remap.length; sourceVertex += 1) {
    const targetVertex = remap[sourceVertex]
    if (targetVertex === MISSING_VERTEX) continue
    const sourceOffset = sourceVertex * stride
    const targetOffset = targetVertex * stride
    for (let component = 0; component < stride; component += 1) {
      target[targetOffset + component] = source[sourceOffset + component]
    }
  }
}

function lodErrorBudget(sectionSize: number, resolution: number): number {
  return (sectionSize / Math.max(1, resolution)) * POSITION_ERROR_FRACTION
}

function generatedMeshBytes(generated: GeneratedMesh): number {
  return (
    generated.positions.byteLength +
    generated.normals.byteLength +
    generated.colors.byteLength +
    generated.surfaceFields.reduce(
      (bytes, field) => bytes + field.byteLength,
      0,
    ) +
    generated.indices.byteLength
  )
}

function generateSectionMesh(
  key: SectionKey,
  sectionSize: number,
  resolution: number,
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
    densityModifiers,
    'x',
  )
  const zAxis = createAdaptiveAxis(
    originZ,
    sectionSize,
    resolution,
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
          1,
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
    seed,
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
    featureLocks: createFeatureLocks(
      result.positions,
      result.interiorVertices,
      originX,
      originZ,
      sectionSize,
      sectionSize / resolution,
      modifiers,
    ),
    warnings: validation.warnings.length,
    hasArbitraryTopology:
      tunnels.length > 0 || hasLateralDisplacement(modifiers),
  }
}

function createFeatureLocks(
  positions: Float32Array,
  interiorVertices: Uint8Array,
  originX: number,
  originZ: number,
  sectionSize: number,
  sourceSpacing: number,
  modifiers: TerrainModifier[],
): Uint8Array {
  const locks = new Uint8Array(positions.length / 3)
  const localModifiers = modifiers.filter(
    (
      modifier,
    ): modifier is BrushStrokeModifier | BooleanSubtractModifier =>
      modifier.enabled &&
      (modifier.type === 'brush-stroke' ||
        modifier.type === 'boolean-subtract'),
  )
  const padding = Math.max(0.05, sourceSpacing * 1.25)
  const boundaryEpsilon = Math.max(1e-4, sectionSize * 1e-5)

  for (let vertex = 0; vertex < locks.length; vertex += 1) {
    const offset = vertex * 3
    const localX = positions[offset]
    const y = positions[offset + 1]
    const localZ = positions[offset + 2]
    if (
      interiorVertices[vertex] === 1 ||
      localX <= boundaryEpsilon ||
      localX >= sectionSize - boundaryEpsilon ||
      localZ <= boundaryEpsilon ||
      localZ >= sectionSize - boundaryEpsilon
    ) {
      locks[vertex] = 1
      continue
    }

    const x = originX + localX
    const z = originZ + localZ
    for (const modifier of localModifiers) {
      if (modifier.type === 'boolean-subtract') {
        if (insideExpandedBounds(x, y, z, modifier.bounds, padding)) {
          locks[vertex] = 1
          break
        }
        continue
      }

      if (
        x < modifier.bounds.min.x - padding ||
        x > modifier.bounds.max.x + padding ||
        z < modifier.bounds.min.z - padding ||
        z > modifier.bounds.max.z + padding
      ) {
        continue
      }
      // Brush evaluation can move a point by up to 2.8 m before locks are
      // calculated. Include that displacement so edge vertices cannot escape
      // the authored region and then be simplified away.
      const radius = modifier.radius + padding + 2.8
      for (const sample of modifier.points) {
        const dx = x - sample.x
        const dz = z - sample.z
        const distance = modifier.domain === 'heightfield'
          ? Math.hypot(dx, dz)
          : Math.hypot(dx, y - sample.y, dz)
        if (distance <= radius) {
          locks[vertex] = 1
          break
        }
      }
      if (locks[vertex] === 1) break
    }
  }
  return locks
}

function insideExpandedBounds(
  x: number,
  y: number,
  z: number,
  bounds: AABB,
  padding: number,
): boolean {
  return (
    x >= bounds.min.x - padding &&
    x <= bounds.max.x + padding &&
    y >= bounds.min.y - padding &&
    y <= bounds.max.y + padding &&
    z >= bounds.min.z - padding &&
    z <= bounds.max.z + padding
  )
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
  seed: number,
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
  const curvature = calculateMeshCurvature(positions, normals, indices)

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const source = vertex * 3
    const target = vertex * 4
    const x = originX + positions[source]
    const y = positions[source + 1]
    const z = originZ + positions[source + 2]
    const key = `${x}:${y}:${z}`
    let fields = cache.get(key)
    if (!fields) {
      fields = evaluateTerrainMaterialFields(x, y, z, seed)
      cache.set(key, fields)
    }

    packed[0].set([
      packUnit(fields.regional * 0.5 + 0.5),
      packUnit(fields.deposition),
      packUnit(fields.moisture),
      packUnit(fields.macro),
    ], target)
    packed[1].set([
      packUnit(fields.beddingX * 0.5 + 0.5),
      packUnit(fields.beddingY * 0.5 + 0.5),
      packUnit(fields.beddingZ * 0.5 + 0.5),
      packUnit(fields.bedThickness),
    ], target)
    packed[2].set([
      packUnit(fields.jointing),
      packUnit(fields.lichen),
      packUnit(curvature[vertex] * 0.5 + 0.5),
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
    packed[4][target + 2] = packUnit(fields.flow)
    packed[4][target + 3] = packUnit(fields.bedExposure)
  }
  return packed
}

/**
 * Mean curvature at every vertex, signed, in roughly 1/m and remapped to
 * [-1, 1].
 *
 * Positive is convex — ridge crests, rib noses, the lip of a bench — where
 * weathering is fastest and nothing loose can stay, so bare rock outcrops.
 * Negative is concave — gully floors, the foot of a face, the back of a ledge —
 * where debris, soil, water and snow all collect. Almost every honest material
 * boundary on a mountainside follows this quantity, and it is the field a
 * thresholded noise mask is standing in for when it happens to look right.
 *
 * Measured as the divergence of the normal field over each vertex's edge ring,
 * normalised by edge length so the value does not change with LOD.
 */
function calculateMeshCurvature(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const vertexCount = positions.length / 3
  const sum = new Float32Array(vertexCount)
  const counts = new Uint32Array(vertexCount)

  for (let index = 0; index < indices.length; index += 3) {
    for (let edge = 0; edge < 3; edge += 1) {
      const a = indices[index + edge]
      const b = indices[index + ((edge + 1) % 3)]
      const pa = a * 3
      const pb = b * 3
      const dx = positions[pb] - positions[pa]
      const dy = positions[pb + 1] - positions[pa + 1]
      const dz = positions[pb + 2] - positions[pa + 2]
      const length = Math.hypot(dx, dy, dz)
      if (length < 1e-6) continue
      // How much the normal turns away from the neighbour over that edge.
      // Dividing twice by the length converts a turn per edge into a turn per
      // metre per metre, which is what makes this LOD-independent.
      const turn =
        (normals[pb] - normals[pa]) * dx +
        (normals[pb + 1] - normals[pa + 1]) * dy +
        (normals[pb + 2] - normals[pa + 2]) * dz
      const value = turn / (length * length)
      sum[a] += value
      sum[b] += value
      counts[a] += 1
      counts[b] += 1
    }
  }

  const raw = new Float32Array(vertexCount)
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (counts[vertex] === 0) continue
    raw[vertex] = sum[vertex] / counts[vertex]
  }

  // Curvature measured over a single edge is dominated by whatever noise the
  // height stack put at the triangle scale, and saturates instantly. What
  // decides where debris rests is the shape of the *slope*, over tens of
  // metres, so the field is relaxed across the vertex ring a few times to reach
  // that scale before it is used.
  const smoothed = new Float32Array(raw)
  const accumulation = new Float32Array(vertexCount)
  for (let iteration = 0; iteration < 6; iteration += 1) {
    accumulation.fill(0)
    counts.fill(0)
    for (let index = 0; index < indices.length; index += 3) {
      for (let edge = 0; edge < 3; edge += 1) {
        const a = indices[index + edge]
        const b = indices[index + ((edge + 1) % 3)]
        accumulation[a] += smoothed[b]
        accumulation[b] += smoothed[a]
        counts[a] += 1
        counts[b] += 1
      }
    }
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      if (counts[vertex] === 0) continue
      smoothed[vertex] = accumulation[vertex] / counts[vertex]
    }
  }

  const curvature = new Float32Array(vertexCount)
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    // Scaled so an ordinary hillside sits near zero and only a real rib nose or
    // gully floor approaches the ends of the range.
    curvature[vertex] = clamp(smoothed[vertex] * 9, -1, 1)
  }
  return curvature
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
  modifiers: (RemeshModifier | TessellateModifier)[],
  axis: 'x' | 'z',
): number[] {
  const coordinates = new Set<number>()
  for (let index = 0; index <= resolution; index += 1) {
    coordinates.add(roundCoordinate(origin + (index / resolution) * size))
  }
  for (const modifier of modifiers) {
    const center = modifier.center[axis]
    const minimum = Math.max(origin, center - modifier.radius)
    const maximum = Math.min(origin + size, center + modifier.radius)
    const spacing = clamp(modifier.targetEdgeLength, size / 96, size / 6)
    const maxLines = 48
    let lines = 0
    for (let coordinate = minimum; coordinate <= maximum && lines < maxLines; coordinate += spacing) {
      coordinates.add(roundCoordinate(coordinate))
      lines += 1
    }
    coordinates.add(roundCoordinate(maximum))
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
