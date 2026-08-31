import { MeshoptSimplifier } from 'meshoptimizer/simplifier'
import { clamp, lerp, smoothstep } from '../core/bounds'
import type {
  AABB,
  CompiledLOD,
  CompiledSection,
  SectionKey,
} from '../core/types'
import type { EditableSectionSourceSnapshot } from '../mesh/EditableMesh'
import { boundaryWeldKey } from '../partition/boundary'
import {
  dropDegenerateTriangles,
  validateMeshData,
} from '../mesh/MeshValidation'
import {
  BvhCsgTunnelBooleanBackend,
  PATCH_SURFACE_TRIANGLE,
  tunnelCutterVolumes,
  type BooleanMeshBuffers,
  type MeshBooleanOperation,
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
import { setWorldProfile } from './heightField'
import {
  evaluateEditableTerrainPoint,
  evaluateTerrainPoint,
  hasLateralDisplacement,
} from './TerrainField'
import {
  evaluateTerrainLayerWeights,
  evaluateTerrainMaterialFields,
  type TerrainLayerWeights,
} from './TerrainMaterialFields'
import {
  hasNearbyBrushSample,
} from './BrushSampleIndex'
import { createMeshTopology, type MeshTopology } from './MeshTopology'
import { calculatePaintWeights } from './PaintWeights'
import { createErrorBoundedHeightMesh } from './AdaptiveHeightMesh'

export { evaluateHeight } from './TerrainField'

interface GeneratedMesh {
  positions: Float32Array
  /** Two u32 words per vertex. */
  stableVertexIds: Uint32Array
  /** Vertex in the authoritative source from which this one was retained. */
  sourceVertexIndices: Uint32Array
  normals: Float32Array
  colors: Float32Array
  surfaceFields: readonly [
    Uint16Array,
    Uint16Array,
    Uint16Array,
    Uint16Array,
    Uint16Array,
  ]
  paintWeights: Uint16Array
  indices: Uint32Array
  /** Vertices authored by a modifier that must survive every LOD. */
  featureLocks: Uint8Array
  /** Sampled deviation introduced before QEM simplification. */
  approximationError: number
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
  // The worker is long-lived and compiles for whichever world is current, so
  // the profile is applied per request rather than once at worker startup.
  setWorldProfile(request.config.worldProfile ?? 'natural')
  const started = performance.now()
  const modifiers = materializeModifierTransforms(
    decodeModifiers(request.modifiers),
  )
  const requestedLevels = normalizedRequestedLevels(request)
  if (requestedLevels.length === 0) {
    throw new Error('Section compile requested no valid LOD levels')
  }
  const requiresAuthoritativeSource = modifiers.some(
    (modifier) =>
      modifier.enabled &&
      (modifier.type === 'brush-stroke' || modifier.type === 'weight-paint'),
  ) || request.source?.kind === 'editable-mesh'
  // A brush can fall between coarse grid samples, so it must simplify from the
  // authoritative source. Exact CSG intersects triangle faces directly and is
  // safe to evaluate on the requested screen-error grid, then refine later.
  const sourceLevel = requiresAuthoritativeSource ? 0 : requestedLevels[0]
  const sourceResolution = request.config.lodResolutions[sourceLevel]
  const source = generateSectionMesh(
    request.key,
    request.config.sectionSize,
    sourceResolution,
    request.config.seed,
    modifiers,
    request.source,
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
  let gpuBytesTotal = 0
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

  const sourceGeometricError =
    (sourceLevel === 0
      ? 0
      : lodErrorBudget(request.config.sectionSize, sourceResolution)) +
    source.approximationError
  let previousError = sourceGeometricError
  let previousMesh = source
  for (const level of requestedLevels) {
    const resolution = request.config.lodResolutions[level]
    const simplified = level === sourceLevel
      ? { mesh: source, geometricError: previousError }
      : simplifyGeneratedMesh(
          previousMesh,
          targetIndexCount(
            source.indices.length,
            sourceResolution,
            resolution,
          ),
          request.config.sectionSize,
          resolution,
          previousError,
        )
    const generated = simplified.mesh
    previousError = Math.max(previousError, simplified.geometricError)
    previousMesh = generated
    const gpuBytes = generatedMeshBytes(generated)
    lods.push({
      level,
      sourceLevel,
      geometricError: previousError,
      positions: generated.positions,
      stableVertexIds: generated.stableVertexIds,
      sourceVertexIndices: generated.sourceVertexIndices,
      normals: generated.normals,
      colors: generated.colors,
      surfaceFields: generated.surfaceFields,
      paintWeights: generated.paintWeights,
      indices: generated.indices,
      triangleCount: generated.indices.length / 3,
      gpuBytes,
    })
    cpuBytes +=
      gpuBytes +
      generated.stableVertexIds.byteLength +
      generated.sourceVertexIndices.byteLength
    gpuBytesTotal += gpuBytes
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
    gpuBytes: gpuBytesTotal,
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
  desiredIndexCount: number,
  sectionSize: number,
  targetResolution: number,
  sourceGeometricError: number,
): { mesh: GeneratedMesh; geometricError: number } {
  if (!meshSimplifierAvailable || desiredIndexCount >= source.indices.length) {
    return {
      mesh: cloneGeneratedMesh(source),
      geometricError: sourceGeometricError,
    }
  }

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
      desiredIndexCount,
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

function targetIndexCount(
  sourceIndexCount: number,
  sourceResolution: number,
  targetResolution: number,
): number {
  const triangleRatio = (targetResolution / sourceResolution) ** 2
  return Math.max(
    3,
    Math.min(
      sourceIndexCount,
      Math.floor((sourceIndexCount * triangleRatio) / 3) * 3,
    ),
  )
}

function cloneGeneratedMesh(source: GeneratedMesh): GeneratedMesh {
  return {
    positions: new Float32Array(source.positions),
    stableVertexIds: new Uint32Array(source.stableVertexIds),
    sourceVertexIndices: new Uint32Array(source.sourceVertexIndices),
    normals: new Float32Array(source.normals),
    colors: new Float32Array(source.colors),
    surfaceFields: source.surfaceFields.map((field) =>
      new Uint16Array(field),
    ) as unknown as GeneratedMesh['surfaceFields'],
    paintWeights: new Uint16Array(source.paintWeights),
    indices: new Uint32Array(source.indices),
    featureLocks: new Uint8Array(source.featureLocks),
    approximationError: source.approximationError,
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
  const stableVertexIds = remapUint32Stream(
    source.stableVertexIds,
    2,
    remap,
    vertexCount,
  )
  const sourceVertexIndices = remapUint32Stream(
    source.sourceVertexIndices,
    1,
    remap,
    vertexCount,
  )
  const normals = remapFloatStream(source.normals, 3, remap, vertexCount)
  const colors = remapFloatStream(source.colors, 3, remap, vertexCount)
  const surfaceFields = source.surfaceFields.map((field) =>
    remapUint16Stream(field, 4, remap, vertexCount),
  ) as unknown as GeneratedMesh['surfaceFields']
  const paintWeights = remapUint16Stream(
    source.paintWeights,
    4,
    remap,
    vertexCount,
  )
  const featureLocks = remapUint8Stream(
    source.featureLocks,
    remap,
    vertexCount,
  )
  const repaired = dropDegenerateTriangles(positions, indices)
  const validation = validateMeshData(positions, repaired.indices, {
    rejectDegenerateTriangles: true,
  })
  if (!validation.valid) throw new Error(validation.errors.join('; '))
  return {
    positions,
    stableVertexIds,
    sourceVertexIndices,
    normals,
    colors,
    surfaceFields,
    paintWeights,
    indices: repaired.indices,
    featureLocks,
    approximationError: source.approximationError,
    warnings: validation.warnings.length + repaired.dropped,
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

function remapUint32Stream(
  source: Uint32Array,
  stride: number,
  remap: Uint32Array,
  vertexCount: number,
): Uint32Array {
  const target = new Uint32Array(vertexCount * stride)
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
  source: Float32Array | Uint32Array | Uint16Array | Uint8Array,
  target: Float32Array | Uint32Array | Uint16Array | Uint8Array,
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

function sequentialVertexIndices(vertexCount: number): Uint32Array {
  const indices = new Uint32Array(vertexCount)
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    indices[vertex] = vertex
  }
  return indices
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
    generated.paintWeights.byteLength +
    generated.indices.byteLength
  )
}

function generateSectionMesh(
  key: SectionKey,
  sectionSize: number,
  resolution: number,
  seed: number,
  modifiers: TerrainModifier[],
  source?: CompileSectionRequest['source'],
): GeneratedMesh {
  if (source?.kind === 'editable-mesh') {
    return generateEditableSectionMesh(
      key,
      sectionSize,
      resolution,
      seed,
      modifiers,
      source,
    )
  }
  const originX = key.x * sectionSize
  const originZ = key.z * sectionSize
  const densityModifiers = modifiers.filter(
    (modifier): modifier is RemeshModifier | TessellateModifier =>
      modifier.enabled &&
      (modifier.type === 'remesh' || modifier.type === 'tessellate') &&
      densityModifierOverlapsSection(
        modifier,
        originX,
        originZ,
        sectionSize,
      ),
  )
  // Arbitrary topology is authored through bounded modifiers. Keeping cutters
  // in the modifier stack is what makes the height-derived base cheap, keeps
  // unrelated sections untouched, and preserves non-destructive build order.
  // Procedural content can still create these modifiers, but the compiler must
  // never inject world-wide booleans behind the stack's back.
  const booleanOperations = collectBooleanOperations(modifiers)
  const adaptive = supportsAdaptiveSourceMesh(modifiers, densityModifiers)
    ? createErrorBoundedHeightMesh({
        originX,
        originZ,
        size: sectionSize,
        resolution,
        errorTolerance: lodErrorBudget(sectionSize, resolution),
        evaluate: (worldX, worldZ) =>
          evaluateTerrainPoint(worldX, worldZ, seed, modifiers),
      })
    : undefined
  let positionArray: Float32Array
  let indexArray: Uint32Array
  let parameters: number[]
  if (adaptive) {
    positionArray = adaptive.positions
    indexArray = adaptive.indices
    parameters = adaptive.parameters
  } else {
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
    parameters = []
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
    positionArray = Float32Array.from(positions)
    indexArray = Uint32Array.from(indices)
  }
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
    booleanOperations.length > 0
      ? tunnelBackend.evaluate(
          baseBuffers,
          booleanOperations,
          originX,
          originZ,
          sectionSize,
          1,
          seed,
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
    result.triangleSurfaceKinds,
    originX,
    originZ,
    seed,
  )
  const paintWeights = calculatePaintWeights(
    result.positions,
    originX,
    originZ,
    modifiers,
  )
  // Sculpting can pull two grid vertices onto each other and leave a triangle
  // with no area. Dropping it costs nothing -- it drew nothing -- whereas
  // rejecting the compile deletes the section outright, and a section that
  // fails to compile cannot be restored by anything the user can do.
  const repaired = dropDegenerateTriangles(result.positions, result.indices)
  result.indices = repaired.indices
  const validation = validateMeshData(result.positions, result.indices, {
    rejectDegenerateTriangles: true,
  })
  if (!validation.valid) throw new Error(validation.errors.join('; '))
  return {
    positions: result.positions,
    stableVertexIds: result === baseBuffers
      ? createParametricStableVertexIds(
          `procedural:${key.x}:${key.z}:${resolution}`,
          result.positions,
          parameters,
          originX,
          originZ,
          sectionSize,
        )
      : createDerivedStableVertexIds(
          `procedural:${key.x}:${key.z}:${resolution}:boolean`,
          result.positions,
          key,
          sectionSize,
        ),
    sourceVertexIndices: sequentialVertexIndices(result.positions.length / 3),
    normals: result.normals,
    colors,
    surfaceFields,
    paintWeights,
    indices: result.indices,
    featureLocks: createFeatureLocks(
      result.positions,
      originX,
      originZ,
      sectionSize,
      sectionSize / resolution,
      modifiers,
    ),
    approximationError: adaptive?.sampledError ?? 0,
    warnings: validation.warnings.length + repaired.dropped,
    hasArbitraryTopology:
      booleanOperations.length > 0 || hasLateralDisplacement(modifiers),
  }
}

function generateEditableSectionMesh(
  key: SectionKey,
  sectionSize: number,
  resolution: number,
  seed: number,
  modifiers: TerrainModifier[],
  source: EditableSectionSourceSnapshot,
): GeneratedMesh {
  validateEditableSourceSnapshot(source)
  if (source.positions.length === 0 || source.triangles.length === 0) {
    throw new Error('Editable terrain source must contain renderable topology')
  }
  const sourceValidation = validateMeshData(source.positions, source.triangles, {
    boundaryMode: source.boundaryMode,
    sectionSize,
    rejectDegenerateTriangles: true,
  })
  if (!sourceValidation.valid) {
    throw new Error(`Invalid editable terrain source: ${sourceValidation.errors.join('; ')}`)
  }

  const originX = key.x * sectionSize
  const originZ = key.z * sectionSize
  const suppliedNormals = sourceVertexAttribute(source, 'normal', 3)
  const baseNormals = suppliedNormals
    ? normalizedNormals(suppliedNormals)
    : calculateNormals(source.positions, source.triangles)
  const positions = new Float32Array(source.positions.length)
  let displaced = false
  for (let vertex = 0; vertex < source.positions.length / 3; vertex += 1) {
    const offset = vertex * 3
    const base = {
      x: originX + source.positions[offset],
      y: source.positions[offset + 1],
      z: originZ + source.positions[offset + 2],
    }
    const point = evaluateEditableTerrainPoint(
      base,
      {
        x: baseNormals[offset],
        y: baseNormals[offset + 1],
        z: baseNormals[offset + 2],
      },
      modifiers,
    )
    positions[offset] = point.x - originX
    positions[offset + 1] = point.y
    positions[offset + 2] = point.z - originZ
    displaced ||=
      point.x !== base.x || point.y !== base.y || point.z !== base.z
  }

  const indices = source.triangles.slice()
  const surfaceNormals = displaced
    ? calculateNormals(positions, indices)
    : baseNormals
  const baseBuffers: BooleanMeshBuffers = {
    positions,
    normals: surfaceNormals,
    indices,
    interiorVertices: new Uint8Array(positions.length / 3),
  }
  const booleanOperations = collectBooleanOperations(modifiers)
  const result = booleanOperations.length > 0
    ? tunnelBackend.evaluate(
        baseBuffers,
        booleanOperations,
        originX,
        originZ,
        sectionSize,
        1,
        seed,
      )
    : baseBuffers
  const topologyChanged = result !== baseBuffers
  const suppliedColors = sourceVertexAttribute(source, 'color')
  const colors = !topologyChanged && suppliedColors
    ? normalizedColors(suppliedColors, source.positions.length / 3)
    : calculateColors(
        result.positions,
        result.normals,
        result.interiorVertices,
      )
  const surfaceFields = calculateSurfaceFields(
    result.positions,
    result.normals,
    result.indices,
    result.interiorVertices,
    result.triangleSurfaceKinds,
    originX,
    originZ,
    seed,
  )
  const paintWeights = calculatePaintWeights(
    result.positions,
    originX,
    originZ,
    modifiers,
  )
  const repaired = dropDegenerateTriangles(result.positions, result.indices)
  result.indices = repaired.indices
  const validation = validateMeshData(result.positions, result.indices, {
    boundaryMode: topologyChanged ? 'allow' : source.boundaryMode,
    sectionSize,
    rejectDegenerateTriangles: true,
  })
  if (!validation.valid) throw new Error(validation.errors.join('; '))

  const featureLocks = createFeatureLocks(
    result.positions,
    originX,
    originZ,
    sectionSize,
    sectionSize / Math.max(1, resolution),
    modifiers,
  )
  if (!topologyChanged && featureLocks.length === source.boundaryEdgeMasks.length) {
    for (let vertex = 0; vertex < featureLocks.length; vertex += 1) {
      if (source.boundaryEdgeMasks[vertex] !== 0) featureLocks[vertex] = 1
    }
  }

  return {
    positions: result.positions,
    stableVertexIds: topologyChanged
      ? createDerivedStableVertexIds(
          `editable:${source.sourceId}:boolean`,
          result.positions,
          key,
          sectionSize,
        )
      : createSourceStableVertexIds(
          source.sourceId,
          source.vertexIds,
          source.boundaryEdgeMasks,
          source.boundaryWeldKeys,
        ),
    sourceVertexIndices: sequentialVertexIndices(result.positions.length / 3),
    normals: result.normals,
    colors,
    surfaceFields,
    paintWeights,
    indices: result.indices,
    featureLocks,
    approximationError: 0,
    warnings: sourceValidation.warnings.length + validation.warnings.length,
    hasArbitraryTopology: true,
  }
}

function collectBooleanOperations(
  modifiers: readonly TerrainModifier[],
): MeshBooleanOperation[] {
  const operations: MeshBooleanOperation[] = []
  for (const modifier of modifiers) {
    if (!modifier.enabled) continue
    if (modifier.type === 'boolean-subtract') {
      operations.push({
        operation: 'subtract',
        cutters: tunnelCutterVolumes(modifier),
      })
    } else if (modifier.type === 'boolean-volume') {
      operations.push({
        operation: modifier.operation ?? 'subtract',
        cutters: modifier.volumes,
      })
    }
  }
  return operations
}

function validateEditableSourceSnapshot(source: EditableSectionSourceSnapshot): void {
  if (!source.sourceId || !Number.isInteger(source.revision) || source.revision < 0) {
    throw new Error('Editable source identity or revision is invalid')
  }
  const vertexCount = source.positions.length / 3
  const triangleCount = source.triangles.length / 3
  if (
    source.vertexIds.length !== vertexCount ||
    source.triangleIds.length !== triangleCount
  ) {
    throw new Error('Editable source stable IDs do not match its topology')
  }
  if (
    source.boundaryEdgeMasks.length !== vertexCount ||
    source.ownedBoundaryEdgeMasks.length !== vertexCount ||
    source.boundaryWeldKeys.length !== vertexCount * 2
  ) {
    throw new Error('Editable source boundary metadata does not match its vertices')
  }
  validateUniqueIds(source.vertexIds, 'vertex')
  validateUniqueIds(source.triangleIds, 'triangle')
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const boundary = source.boundaryEdgeMasks[vertex]
    const owned = source.ownedBoundaryEdgeMasks[vertex]
    if ((boundary & ~0x0f) !== 0 || (owned & ~0x0f) !== 0) {
      throw new Error(`Editable source vertex ${vertex} has an invalid boundary mask`)
    }
    if ((owned & boundary) !== owned) {
      throw new Error(`Editable source vertex ${vertex} owns a non-boundary edge`)
    }
    if (
      boundary !== 0 &&
      source.boundaryWeldKeys[vertex * 2] === 0 &&
      source.boundaryWeldKeys[vertex * 2 + 1] === 0
    ) {
      throw new Error(`Editable source boundary vertex ${vertex} has no weld key`)
    }
  }
  validateAttributes(source.vertexAttributes, vertexCount, 'vertex')
  validateAttributes(source.triangleAttributes, triangleCount, 'triangle')
}

function validateUniqueIds(ids: Uint32Array, label: string): void {
  const unique = new Set<number>()
  for (const id of ids) {
    if (id === 0) throw new Error(`Editable source ${label} ID 0 is reserved`)
    if (unique.has(id)) throw new Error(`Editable source repeats ${label} ID ${id}`)
    unique.add(id)
  }
}

function validateAttributes(
  attributes: readonly EditableSectionSourceSnapshot['vertexAttributes'][number][],
  elementCount: number,
  label: string,
): void {
  const names = new Set<string>()
  for (const attribute of attributes) {
    if (names.has(attribute.name)) {
      throw new Error(`Editable source repeats ${label} attribute ${attribute.name}`)
    }
    names.add(attribute.name)
    if (
      !Number.isInteger(attribute.itemSize) ||
      attribute.itemSize < 1 ||
      attribute.values.length !== elementCount * attribute.itemSize
    ) {
      throw new Error(`Editable source ${label} attribute ${attribute.name} is malformed`)
    }
    for (const value of attribute.values) {
      if (!Number.isFinite(value)) {
        throw new Error(
          `Editable source ${label} attribute ${attribute.name} is not finite`,
        )
      }
    }
  }
}

function sourceVertexAttribute(
  source: EditableSectionSourceSnapshot,
  name: string,
  requiredItemSize?: number,
): Float32Array | undefined {
  const attribute = source.vertexAttributes.find((candidate) => candidate.name === name)
  if (!attribute) return undefined
  if (requiredItemSize !== undefined && attribute.itemSize !== requiredItemSize) {
    return undefined
  }
  return attribute.values
}

function normalizedNormals(source: Float32Array): Float32Array {
  const normals = source.slice()
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(
      normals[offset],
      normals[offset + 1],
      normals[offset + 2],
    ) || 1
    normals[offset] /= length
    normals[offset + 1] /= length
    normals[offset + 2] /= length
  }
  return normals
}

function normalizedColors(source: Float32Array, vertexCount: number): Float32Array {
  const itemSize = source.length / vertexCount
  if (itemSize !== 3 && itemSize !== 4) {
    return new Float32Array(vertexCount * 3).fill(1)
  }
  const colors = new Float32Array(vertexCount * 3)
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    colors[vertex * 3] = clamp(source[vertex * itemSize], 0, 1)
    colors[vertex * 3 + 1] = clamp(source[vertex * itemSize + 1], 0, 1)
    colors[vertex * 3 + 2] = clamp(source[vertex * itemSize + 2], 0, 1)
  }
  return colors
}

function createSourceStableVertexIds(
  sourceId: string,
  localIds: Uint32Array,
  boundaryMasks: Uint8Array,
  boundaryWeldKeys: Uint32Array,
): Uint32Array {
  const ids = new Uint32Array(localIds.length * 2)
  const namespace = hashString(sourceId) || 1
  for (let vertex = 0; vertex < localIds.length; vertex += 1) {
    if (boundaryMasks[vertex] !== 0) {
      ids[vertex * 2] = boundaryWeldKeys[vertex * 2]
      ids[vertex * 2 + 1] = boundaryWeldKeys[vertex * 2 + 1]
    } else {
      ids[vertex * 2] = namespace
      ids[vertex * 2 + 1] = localIds[vertex]
    }
  }
  return ids
}

function createDerivedStableVertexIds(
  namespaceValue: string,
  positions: Float32Array,
  sectionKey?: SectionKey,
  sectionSize?: number,
): Uint32Array {
  const vertexCount = positions.length / 3
  const ids = new Uint32Array(vertexCount * 2)
  const namespace = hashString(namespaceValue) || 1
  const boundaryEpsilon = sectionSize === undefined
    ? 0
    : Math.max(1e-4, sectionSize * 1e-5)
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3
    if (
      sectionKey &&
      sectionSize !== undefined &&
      (
        Math.abs(positions[offset]) <= boundaryEpsilon ||
        Math.abs(positions[offset] - sectionSize) <= boundaryEpsilon ||
        Math.abs(positions[offset + 2]) <= boundaryEpsilon ||
        Math.abs(positions[offset + 2] - sectionSize) <= boundaryEpsilon
      )
    ) {
      const [low, high] = boundaryWeldKey(
        sectionKey.x * sectionSize + positions[offset],
        positions[offset + 1],
        sectionKey.z * sectionSize + positions[offset + 2],
      )
      ids[vertex * 2] = low
      ids[vertex * 2 + 1] = high
      continue
    }
    let local = 0x811c9dc5
    local = hashNumber(local, Math.round(positions[offset] * 10_000))
    local = hashNumber(local, Math.round(positions[offset + 1] * 10_000))
    local = hashNumber(local, Math.round(positions[offset + 2] * 10_000))
    local = hashNumber(local, vertex + 1)
    ids[vertex * 2] = namespace
    ids[vertex * 2 + 1] = (local >>> 0) || 1
  }
  return ids
}

function createParametricStableVertexIds(
  namespaceValue: string,
  positions: Float32Array,
  parameters: readonly number[],
  originX: number,
  originZ: number,
  sectionSize: number,
): Uint32Array {
  const ids = createDerivedStableVertexIds(namespaceValue, positions)
  const epsilon = Math.max(1e-4, sectionSize * 1e-5)
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const worldX = parameters[vertex * 2]
    const worldZ = parameters[vertex * 2 + 1]
    if (
      Math.abs(worldX - originX) > epsilon &&
      Math.abs(worldX - (originX + sectionSize)) > epsilon &&
      Math.abs(worldZ - originZ) > epsilon &&
      Math.abs(worldZ - (originZ + sectionSize)) > epsilon
    ) {
      continue
    }
    const [low, high] = boundaryWeldKey(worldX, 0, worldZ)
    ids[vertex * 2] = low
    ids[vertex * 2 + 1] = high
  }
  return ids
}

function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return hash >>> 0
}

function hashNumber(hash: number, value: number): number {
  return Math.imul(hash ^ (value | 0), 0x01000193)
}

function createFeatureLocks(
  positions: Float32Array,
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
        // Only the portal rims need explicit locks. Locking the complete tunnel
        // AABB (and every interior vertex) prevented QEM from reducing a cave at
        // all, leaving thousands of near-field triangles in distant LODs. The
        // material seam around each opening is also a mesh border protected by
        // LockBorder; this small spatial lock makes that contract explicit.
        const portalRadius = modifier.radius * 1.4 + padding
        for (const portal of modifier.portals) {
          if (
            Math.hypot(
              x - portal.x,
              y - portal.y,
              z - portal.z,
            ) <= portalRadius
          ) {
            locks[vertex] = 1
            break
          }
        }
        if (locks[vertex] === 1) break
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
      if (hasNearbyBrushSample(modifier, { x, y, z }, radius)) {
        locks[vertex] = 1
      }
      if (locks[vertex] === 1) break
    }
  }
  return locks
}

const PACKED_UNIT_MAX = 65_535
const BEDDED_OFFSET_RANGE = 16
const PATCH_MATERIAL_TRANSITION_METRES = 12

/**
 * Geodesic distance from the fused terrain/patch curve, evaluated only across
 * additive-patch triangles. The returned value is 1 on the exact junction and
 * reaches 0 twelve metres into the operand. This gives the patch terrain's
 * broad material classification at its root while leaving its exposed crest
 * as rock; world-space texture coordinates remain unchanged throughout.
 */
export function calculatePatchFoundationBlend(
  positions: Float32Array,
  indices: Uint32Array,
  triangleSurfaceKinds: Uint8Array | undefined,
  transition = PATCH_MATERIAL_TRANSITION_METRES,
): Float32Array {
  const vertexCount = positions.length / 3
  const blend = new Float32Array(vertexCount)
  if (
    !triangleSurfaceKinds ||
    triangleSurfaceKinds.length !== indices.length / 3 ||
    !triangleSurfaceKinds.includes(PATCH_SURFACE_TRIANGLE)
  ) {
    return blend
  }

  const incident = new Uint8Array(vertexCount)
  const adjacency: Array<number[] | undefined> = new Array(vertexCount)
  const connect = (a: number, b: number) => {
    const neighbours = adjacency[a]
    if (neighbours) neighbours.push(b)
    else adjacency[a] = [b]
  }
  for (let offset = 0; offset < indices.length; offset += 3) {
    const triangle = offset / 3
    const a = indices[offset]!
    const b = indices[offset + 1]!
    const c = indices[offset + 2]!
    if (triangleSurfaceKinds[triangle] === PATCH_SURFACE_TRIANGLE) {
      incident[a] |= 2
      incident[b] |= 2
      incident[c] |= 2
      connect(a, b)
      connect(b, a)
      connect(b, c)
      connect(c, b)
      connect(c, a)
      connect(a, c)
    } else {
      incident[a] |= 1
      incident[b] |= 1
      incident[c] |= 1
    }
  }

  // Material groups may duplicate a CSG intersection vertex. Reunite only for
  // finding the boundary; the render topology and deliberate hard edges stay
  // untouched.
  const POSITION_EPSILON = 1e-4
  const positionGroups = new Map<string, number[]>()
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (incident[vertex] === 0) continue
    const source = vertex * 3
    const key = `${Math.round(positions[source]! / POSITION_EPSILON)}:` +
      `${Math.round(positions[source + 1]! / POSITION_EPSILON)}:` +
      `${Math.round(positions[source + 2]! / POSITION_EPSILON)}`
    const group = positionGroups.get(key)
    if (group) group.push(vertex)
    else positionGroups.set(key, [vertex])
  }

  const distance = new Float32Array(vertexCount)
  distance.fill(Number.POSITIVE_INFINITY)
  const heapVertices: number[] = []
  const heapDistances: number[] = []
  const push = (vertex: number, value: number) => {
    let index = heapVertices.length
    heapVertices.push(vertex)
    heapDistances.push(value)
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (heapDistances[parent]! <= value) break
      heapVertices[index] = heapVertices[parent]!
      heapDistances[index] = heapDistances[parent]!
      index = parent
    }
    heapVertices[index] = vertex
    heapDistances[index] = value
  }
  const pop = (): [number, number] | undefined => {
    if (heapVertices.length === 0) return undefined
    const vertex = heapVertices[0]!
    const value = heapDistances[0]!
    const lastVertex = heapVertices.pop()!
    const lastDistance = heapDistances.pop()!
    if (heapVertices.length > 0) {
      let index = 0
      while (true) {
        const left = index * 2 + 1
        if (left >= heapVertices.length) break
        const right = left + 1
        const child = right < heapVertices.length &&
          heapDistances[right]! < heapDistances[left]!
          ? right
          : left
        if (heapDistances[child]! >= lastDistance) break
        heapVertices[index] = heapVertices[child]!
        heapDistances[index] = heapDistances[child]!
        index = child
      }
      heapVertices[index] = lastVertex
      heapDistances[index] = lastDistance
    }
    return [vertex, value]
  }

  for (const vertices of positionGroups.values()) {
    let mask = 0
    for (const vertex of vertices) mask |= incident[vertex]!
    if (mask !== 3) continue
    for (const vertex of vertices) {
      if ((incident[vertex]! & 2) === 0 || distance[vertex] === 0) continue
      distance[vertex] = 0
      push(vertex, 0)
    }
  }

  const transitionDistance = Math.max(0.25, transition)
  let entry: [number, number] | undefined
  while ((entry = pop())) {
    const [vertex, current] = entry
    if (current !== distance[vertex] || current >= transitionDistance) continue
    const source = vertex * 3
    for (const neighbour of adjacency[vertex] ?? []) {
      const target = neighbour * 3
      const edge = Math.hypot(
        positions[target]! - positions[source]!,
        positions[target + 1]! - positions[source + 1]!,
        positions[target + 2]! - positions[source + 2]!,
      )
      const next = current + edge
      if (next >= distance[neighbour] || next > transitionDistance) continue
      distance[neighbour] = next
      push(neighbour, next)
    }
  }

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if ((incident[vertex]! & 2) === 0 || !Number.isFinite(distance[vertex])) continue
    const amount = clamp(distance[vertex]! / transitionDistance, 0, 1)
    blend[vertex] = 1 - amount * amount * (3 - 2 * amount)
  }
  return blend
}

function blendTerrainLayerWeights(
  target: TerrainLayerWeights,
  foundation: TerrainLayerWeights,
  amount: number,
): void {
  target.grass = lerp(target.grass, foundation.grass, amount)
  target.meadow = lerp(target.meadow, foundation.meadow, amount)
  target.soil = lerp(target.soil, foundation.soil, amount)
  target.scree = lerp(target.scree, foundation.scree, amount)
  target.rock = lerp(target.rock, foundation.rock, amount)
  target.snow = lerp(target.snow, foundation.snow, amount)
  target.slope = lerp(target.slope, foundation.slope, amount)
  target.lichen = lerp(target.lichen, foundation.lichen, amount)
}

function calculateSurfaceFields(
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  interiorVertices: Uint8Array,
  triangleSurfaceKinds: Uint8Array | undefined,
  originX: number,
  originZ: number,
  seed: number,
): readonly [Uint16Array, Uint16Array, Uint16Array, Uint16Array, Uint16Array] {
  const vertexCount = positions.length / 3
  const topology = createMeshTopology(vertexCount, indices)
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
    topology,
    interiorVertices,
  )
  const curvature = calculateMeshCurvature(positions, normals, topology)
  const patchFoundationBlend = calculatePatchFoundationBlend(
    positions,
    indices,
    triangleSurfaceKinds,
  )

  // Faces that came from a CSG cut rather than from the height field.
  //
  // A freshly cut face has no soil on it, because soil is what has accumulated
  // on a surface over time and this surface has no time. That is not a
  // stylistic preference about the hero formation — it is why a road cutting,
  // a quarry wall and a fresh landslide scar are all bare, and why they stay
  // bare for years while the ground a metre away is pasture.
  //
  // Without it the authored thrust slab classified from its own gentle upper
  // faces and grew turf on them, so orbiting the camera swung the formation
  // between rock and meadow as different faces came into view. The old
  // hardcoded showcase ellipse had been hiding this by suppressing vegetation
  // over the whole basin; removing the ellipse is what exposed it.
  const patchSurfaceVertices = new Uint8Array(vertexCount)
  if (
    triangleSurfaceKinds &&
    triangleSurfaceKinds.length === indices.length / 3
  ) {
    for (let offset = 0; offset < indices.length; offset += 3) {
      if (triangleSurfaceKinds[offset / 3] !== PATCH_SURFACE_TRIANGLE) continue
      patchSurfaceVertices[indices[offset]!] = 1
      patchSurfaceVertices[indices[offset + 1]!] = 1
      patchSurfaceVertices[indices[offset + 2]!] = 1
    }
  }

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const source = vertex * 3
    const target = vertex * 4
    const x = originX + positions[source]
    const y = positions[source + 1]
    const z = originZ + positions[source + 2]
    // No memo here. Every vertex of a section is at a distinct position, so the
    // map this used to consult could not hit even once; it only ever built a
    // key string per vertex and grew.
    // Upslope bearing, for the talus probe. For a height field the surface
    // normal is proportional to (-dh/dx, 1, -dh/dz), so its horizontal part
    // points straight downhill and negating it costs nothing — the alternative
    // is four more height-field samples per vertex to rebuild a gradient the
    // mesh is already carrying.
    const normalX = normals[source]
    const normalZ = normals[source + 2]
    const horizontal = Math.hypot(normalX, normalZ)
    const upslopeX = horizontal > 1e-4 ? -normalX / horizontal : 0
    const upslopeZ = horizontal > 1e-4 ? -normalZ / horizontal : 0
    const fields = evaluateTerrainMaterialFields(
      x,
      y,
      z,
      seed,
      upslopeX,
      upslopeZ,
    )

    const weights = evaluateTerrainLayerWeights(
      x,
      y,
      z,
      normals[source + 1],
      curvature[vertex],
      fields,
      patchSurfaceVertices[vertex] === 1 ? 1 : 0,
    )
    const foundationBlend = patchFoundationBlend[vertex]!
    if (foundationBlend > 0) {
      // The foundation exists to stop a material step at the join between a
      // CSG patch and the terrain it was cut into, by blending the patch's
      // classification toward what the ground underneath would have been. It
      // must not, however, hand the patch the ground's *slope*: a vertical
      // wall cut into a valley floor is still a vertical wall, and classifying
      // it with the floor's gentle height-field normal is what put pasture on
      // the hero formation's faces and made it turn green as the camera
      // orbited past the blend band.
      //
      // Taking the steeper of the two normals keeps the seam smoothing — a
      // patch face gentler than the ground below still blends to the ground's
      // material — while making a face steeper than its surroundings shed
      // vegetation exactly as any other face that steep would.
      const foundation = evaluateTerrainLayerWeights(
        x,
        y,
        z,
        Math.min(fields.baseNormalY, normals[source + 1]!),
        0,
        fields,
        patchSurfaceVertices[vertex] === 1 ? 1 : 0,
      )
      blendTerrainLayerWeights(weights, foundation, foundationBlend)
    }

    packed[0].set([
      packUnitPair(weights.grass, weights.meadow),
      packUnitPair(weights.soil, weights.scree),
      packUnitPair(weights.rock, weights.snow),
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
      packUnitPair(fields.moisture, weights.lichen),
      packUnit(curvature[vertex] * 0.5 + 0.5),
      // Mottling and climate share a channel. Both are slow masks read through
      // a smoothstep, so eight bits is well past what either can show; adding a
      // seventh vertex buffer for the biome selector would have cost a real
      // attribute slot for no visible precision.
      packUnitPair(fields.mottle, fields.aridity),
    ], target)
    packed[3].set([
      packSigned(fields.beddedOffsetX, BEDDED_OFFSET_RANGE),
      packSigned(fields.beddedOffsetY, BEDDED_OFFSET_RANGE),
      packSigned(fields.beddedOffsetZ, BEDDED_OFFSET_RANGE),
      packUnit(fields.regionalTint),
    ], target)
    // The high byte is a material tag carried by the CSG-generated chamber
    // surface. Pairing it with buttress preserves the five-buffer layout and
    // proves the glow belongs to terrain topology rather than a backing card.
    packed[4][target] = packUnitPair(
      fields.buttress,
      interiorVertices[vertex] === 2 ? 1 : 0,
    )
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
  topology: MeshTopology,
): Float32Array {
  const vertexCount = topology.vertexCount
  const sum = new Float32Array(vertexCount)
  const validCounts = new Uint32Array(vertexCount)

  for (let a = 0; a < vertexCount; a += 1) {
    for (
      let neighbor = topology.neighborOffsets[a];
      neighbor < topology.neighborOffsets[a + 1];
      neighbor += 1
    ) {
      const b = topology.neighbors[neighbor]
      // Every triangle contributes both directions to the CSR. Visiting the
      // lower endpoint retains one occurrence per triangle edge without a
      // second edge buffer.
      if (a >= b) continue
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
      validCounts[a] += 1
      validCounts[b] += 1
    }
  }

  const raw = new Float32Array(vertexCount)
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (validCounts[vertex] === 0) continue
    raw[vertex] = sum[vertex] / validCounts[vertex]
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
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      for (
        let neighbor = topology.neighborOffsets[vertex];
        neighbor < topology.neighborOffsets[vertex + 1];
        neighbor += 1
      ) {
        accumulation[vertex] += smoothed[topology.neighbors[neighbor]]
      }
    }
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const count =
        topology.neighborOffsets[vertex + 1] -
        topology.neighborOffsets[vertex]
      if (count === 0) continue
      smoothed[vertex] = accumulation[vertex] / count
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
  topology: MeshTopology,
  interiorVertices: Uint8Array,
): Float32Array {
  const vertexCount = topology.vertexCount
  let smoothed = new Float32Array(positions)
  let next = new Float32Array(smoothed.length)
  const cavity = new Float32Array(vertexCount)
  const accumulation = new Float32Array(positions.length)

  for (let iteration = 0; iteration < 8; iteration += 1) {
    accumulation.fill(0)
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const target = vertex * 3
      for (
        let neighbor = topology.neighborOffsets[vertex];
        neighbor < topology.neighborOffsets[vertex + 1];
        neighbor += 2
      ) {
        const first = topology.neighbors[neighbor] * 3
        const second = topology.neighbors[neighbor + 1] * 3
        accumulation[target] += smoothed[first] + smoothed[second]
        accumulation[target + 1] += smoothed[first + 1] + smoothed[second + 1]
        accumulation[target + 2] += smoothed[first + 2] + smoothed[second + 2]
      }
    }

    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const target = vertex * 3
      const count = Math.max(
        1,
        topology.neighborOffsets[vertex + 1] -
          topology.neighborOffsets[vertex],
      )
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
    const previous = smoothed
    smoothed = next
    next = previous
  }

  const occlusion = new Float32Array(vertexCount)
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const broadCavity = 1 - smoothstepNumber(0.015, 4.5, cavity[vertex]) * 0.58
    const interiorVisibility = interiorVertices[vertex] > 0 ? 0.52 : 1
    occlusion[vertex] = clamp(broadCavity * interiorVisibility, 0.32, 1)
  }
  return occlusion
}

function smoothstepNumber(low: number, high: number, value: number): number {
  const amount = clamp((value - low) / (high - low), 0, 1)
  return amount * amount * (3 - 2 * amount)
}

function packUnit(value: number): number {
  return Math.round(clamp(value, 0, 1) * PACKED_UNIT_MAX)
}

function packUnitPair(low: number, high: number): number {
  const lowByte = Math.round(clamp(low, 0, 1) * 255)
  const highByte = Math.round(clamp(high, 0, 1) * 255)
  return lowByte | (highByte << 8)
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
    // ModifierStack queries with an operation halo so a worker can rebuild
    // neighbouring ownership borders. A density sphere inside that halo may
    // still have no overlap with this section itself. Without this guard the
    // inverted interval inserted the modifier edge *outside* the section,
    // stretching the cell across its neighbour before CSG ran.
    if (maximum <= minimum) continue
    const spacing = clamp(modifier.targetEdgeLength, size / 256, size / 6)
    const maxLines = 48
    const lineCount = Math.max(
      1,
      Math.min(maxLines, Math.ceil((maximum - minimum) / spacing)),
    )
    for (let line = 0; line <= lineCount; line += 1) {
      coordinates.add(
        roundCoordinate(minimum + ((maximum - minimum) * line) / lineCount),
      )
    }
  }
  return [...coordinates].sort((a, b) => a - b)
}

function supportsAdaptiveSourceMesh(
  modifiers: readonly TerrainModifier[],
  localDensityModifiers: readonly (RemeshModifier | TessellateModifier)[],
): boolean {
  if (localDensityModifiers.length > 0) return false
  return modifiers.every(
    (modifier) =>
      !modifier.enabled ||
      ((modifier.type !== 'brush-stroke' || modifier.strength <= 0) &&
        modifier.type !== 'boolean-subtract' &&
        modifier.type !== 'boolean-volume' &&
        // Density modifiers inside the operation halo but outside this section
        // must not change its otherwise identical topology.
        (modifier.type !== 'remesh' || localDensityModifiers.length === 0) &&
        (modifier.type !== 'tessellate' || localDensityModifiers.length === 0)),
  )
}

function densityModifierOverlapsSection(
  modifier: RemeshModifier | TessellateModifier,
  originX: number,
  originZ: number,
  sectionSize: number,
): boolean {
  const nearestX = clamp(modifier.center.x, originX, originX + sectionSize)
  const nearestZ = clamp(modifier.center.z, originZ, originZ + sectionSize)
  return Math.hypot(
    modifier.center.x - nearestX,
    modifier.center.z - nearestZ,
  ) < modifier.radius
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
    if (interiorVertices[vertex] > 0) {
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
