import { clamp, lerp, smoothstep } from '../core/bounds'
import type { AABB, CompiledLOD, CompiledSection, SectionKey } from '../core/types'
import { validateMeshData } from '../mesh/MeshValidation'
import { AnalyticTunnelBooleanBackend } from '../modifiers/boolean/MeshBooleanBackend'
import type {
  BooleanSubtractModifier,
  BrushStrokeModifier,
  RemeshModifier,
  TerrainModifier,
  TessellateModifier,
} from '../modifiers/types'
import type { CompileSectionRequest } from '../workers/protocol'
import { decodeModifiers } from '../workers/protocol'

interface GeneratedMesh {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  indices: Uint32Array
  warnings: number
  hasArbitraryTopology: boolean
}

const tunnelBackend = new AnalyticTunnelBooleanBackend()

export function compileTerrainSection(
  request: CompileSectionRequest,
): CompiledSection {
  const started = performance.now()
  const modifiers = decodeModifiers(request.modifiers)
  const lods: CompiledLOD[] = []
  let minY = Infinity
  let maxY = -Infinity
  let warnings = 0
  let vertexCount = 0
  let triangleCount = 0
  let hasArbitraryTopology = false
  let cpuBytes = 0

  for (let level = 0; level < request.config.lodResolutions.length; level += 1) {
    const resolution = request.config.lodResolutions[level]
    const generated = generateSectionMesh(
      request.key,
      request.config.sectionSize,
      resolution,
      level,
      request.config.seed,
      modifiers,
    )
    for (let index = 1; index < generated.positions.length; index += 3) {
      minY = Math.min(minY, generated.positions[index])
      maxY = Math.max(maxY, generated.positions[index])
    }
    const gpuBytes =
      generated.positions.byteLength +
      generated.normals.byteLength +
      generated.colors.byteLength +
      generated.indices.byteLength
    lods.push({
      level,
      geometricError:
        (request.config.sectionSize / resolution) * (0.32 + level * 0.48),
      positions: generated.positions,
      normals: generated.normals,
      colors: generated.colors,
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

  const originX = request.key.x * request.config.sectionSize
  const originZ = request.key.z * request.config.sectionSize
  const bounds: AABB = {
    min: { x: originX, y: minY, z: originZ },
    max: {
      x: originX + request.config.sectionSize,
      y: maxY,
      z: originZ + request.config.sectionSize,
    },
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
  const indices: number[] = []

  for (const worldZ of zAxis) {
    for (const worldX of xAxis) {
      positions.push(
        worldX - originX,
        evaluateHeight(worldX, worldZ, seed, modifiers),
        worldZ - originZ,
      )
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
        appendSurfaceTriangle(indices, positions, a, c, b, originX, originZ, tunnels)
        appendSurfaceTriangle(indices, positions, b, c, d, originX, originZ, tunnels)
      } else {
        appendSurfaceTriangle(indices, positions, a, c, d, originX, originZ, tunnels)
        appendSurfaceTriangle(indices, positions, a, d, b, originX, originZ, tunnels)
      }
    }
  }

  appendSkirts(positions, indices, width, zAxis.length, sectionSize, level)
  const surfaceVertexCount = positions.length / 3
  const target = { positions, indices, surfaceVertexCount }
  for (const tunnel of tunnels) {
    tunnelBackend.appendSubtractionInterior(
      target,
      tunnel,
      originX,
      originZ,
      sectionSize,
      Math.max(0.5, 1 - level * 0.12),
    )
  }

  const positionArray = Float32Array.from(positions)
  const indexArray = Uint32Array.from(indices)
  const normals = calculateNormals(positionArray, indexArray)
  const colors = calculateColors(
    positionArray,
    normals,
    surfaceVertexCount,
    level,
  )
  const validation = validateMeshData(positionArray, indexArray)
  if (!validation.valid) throw new Error(validation.errors.join('; '))
  return {
    positions: positionArray,
    normals,
    colors,
    indices: indexArray,
    warnings: validation.warnings.length,
    hasArbitraryTopology: tunnels.length > 0,
  }
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
      const spacing = clamp(
        modifier.targetEdgeLength * 2 ** level,
        size / 96,
        size / 6,
      )
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

export function evaluateHeight(
  worldX: number,
  worldZ: number,
  seed: number,
  modifiers: TerrainModifier[],
): number {
  const lowFrequency = broadTerrainHeight(worldX, worldZ, seed)
  let height = lowFrequency + surfaceDetail(worldX, worldZ, seed)

  for (const modifier of modifiers) {
    if (!modifier.enabled) continue
    switch (modifier.type) {
      case 'brush-stroke':
        height = applyBrush(height, lowFrequency, worldX, worldZ, modifier)
        break
      case 'noise': {
        const noise = valueNoise(
          worldX * modifier.frequency,
          worldZ * modifier.frequency,
          modifier.seed,
        )
        height += (noise * 2 - 1) * modifier.amplitude
        break
      }
      case 'field-displacement':
        height +=
          Math.sin(worldX * 0.018 + worldZ * 0.011) * modifier.scale * 0.5
        break
      case 'boolean-subtract':
        height += tunnelOverburden(worldX, worldZ, modifier)
        break
      case 'remesh':
      case 'tessellate':
        break
    }
  }
  return height
}

function broadTerrainHeight(x: number, z: number, seed: number): number {
  const phase = seed * 0.00013
  const rolling =
    Math.sin(x * 0.0061 + phase) * 8 +
    Math.cos(z * 0.0053 - phase * 2) * 7 +
    Math.sin((x + z) * 0.0028) * 10
  const ridgeDistance = z - (x * 0.28 + 44)
  const ridge = Math.exp(-(ridgeDistance * ridgeDistance) / (2 * 105 * 105))
  const ridgeShape = ridge * (34 + Math.sin(x * 0.019) * 9)
  const cliffBand = Math.exp(-((z + 55) * (z + 55)) / (2 * 250 * 250))
  const cliff = smoothstep(-85, -24, x + Math.sin(z * 0.017) * 22) * 27 * cliffBand
  const basin = -18 * Math.exp(-((x - 250) ** 2 + (z - 80) ** 2) / 95_000)
  return 10 + rolling + ridgeShape + cliff + basin
}

function surfaceDetail(x: number, z: number, seed: number): number {
  const first = valueNoise(x * 0.022, z * 0.022, seed)
  const second = valueNoise(x * 0.061, z * 0.061, seed + 97)
  return (first - 0.5) * 7 + (second - 0.5) * 2.2
}

function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x)
  const z0 = Math.floor(z)
  const tx = smoothstep(0, 1, x - x0)
  const tz = smoothstep(0, 1, z - z0)
  const a = hash2(x0, z0, seed)
  const b = hash2(x0 + 1, z0, seed)
  const c = hash2(x0, z0 + 1, seed)
  const d = hash2(x0 + 1, z0 + 1, seed)
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz)
}

function hash2(x: number, z: number, seed: number): number {
  let value = Math.imul(x, 374_761_393) + Math.imul(z, 668_265_263)
  value = (value ^ (value >>> 13)) + Math.imul(seed, 1_443_053)
  value = Math.imul(value ^ (value >>> 16), 1_274_126_177)
  return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_295
}

function applyBrush(
  height: number,
  smoothTarget: number,
  x: number,
  z: number,
  modifier: BrushStrokeModifier,
): number {
  let next = height
  for (const point of modifier.points) {
    const distance = Math.hypot(x - point.x, z - point.z)
    if (distance >= modifier.radius) continue
    const radial = 1 - distance / modifier.radius
    const weight = smoothstep(0, 1, radial) ** (0.55 + modifier.falloff * 2.4)
    const amount = clamp(modifier.strength, 0.01, 1) * weight
    switch (modifier.mode) {
      case 'raise':
        next += amount * 2.8
        break
      case 'lower':
        next -= amount * 2.8
        break
      case 'smooth':
        next = lerp(next, smoothTarget, amount * 0.34)
        break
      case 'flatten':
        next = lerp(next, modifier.targetY ?? point.y, amount * 0.48)
        break
    }
  }
  return next
}

function tunnelOverburden(
  x: number,
  z: number,
  modifier: BooleanSubtractModifier,
): number {
  const dx = x - modifier.center.x
  const dz = z - modifier.center.z
  const along = dx * modifier.direction.x + dz * modifier.direction.z
  const perpendicular = Math.abs(-dx * modifier.direction.z + dz * modifier.direction.x)
  const half = modifier.length * 0.5
  if (Math.abs(along) > half || perpendicular > modifier.radius * 2.2) return 0
  const arch = Math.sin(((along + half) / modifier.length) * Math.PI)
  const lateral = 1 - smoothstep(modifier.radius * 0.8, modifier.radius * 2.2, perpendicular)
  return arch * lateral * modifier.radius * 2.35
}

function appendSurfaceTriangle(
  indices: number[],
  positions: number[],
  a: number,
  b: number,
  c: number,
  originX: number,
  originZ: number,
  tunnels: BooleanSubtractModifier[],
): void {
  const centroidX =
    originX + (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3
  const centroidY =
    (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3
  const centroidZ =
    originZ +
    (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3
  for (const tunnel of tunnels) {
    if (pointInsideTunnel(centroidX, centroidY, centroidZ, tunnel)) return
  }
  indices.push(a, b, c)
}

function pointInsideTunnel(
  x: number,
  y: number,
  z: number,
  tunnel: BooleanSubtractModifier,
): boolean {
  const dx = x - tunnel.center.x
  const dz = z - tunnel.center.z
  const half = tunnel.length * 0.5
  const along = clamp(
    dx * tunnel.direction.x + dz * tunnel.direction.z,
    -half,
    half,
  )
  const closestX = tunnel.center.x + tunnel.direction.x * along
  const closestZ = tunnel.center.z + tunnel.direction.z * along
  return Math.hypot(x - closestX, y - tunnel.center.y, z - closestZ) < tunnel.radius * 1.04
}

function appendSkirts(
  positions: number[],
  indices: number[],
  width: number,
  height: number,
  sectionSize: number,
  level: number,
): void {
  const north = Array.from({ length: width }, (_, index) => index)
  const east = Array.from({ length: height }, (_, index) => index * width + width - 1)
  const south = Array.from(
    { length: width },
    (_, index) => (height - 1) * width + (width - 1 - index),
  )
  const west = Array.from(
    { length: height },
    (_, index) => (height - 1 - index) * width,
  )
  const skirtDepth = Math.max(4, sectionSize * (0.035 + level * 0.012))
  for (const edge of [north, east, south, west]) {
    let previousTop = -1
    let previousBottom = -1
    for (const top of edge) {
      const source = top * 3
      const bottom = positions.length / 3
      positions.push(
        positions[source],
        positions[source + 1] - skirtDepth,
        positions[source + 2],
      )
      if (previousTop !== -1) {
        indices.push(previousTop, previousBottom, top, top, previousBottom, bottom)
      }
      previousTop = top
      previousBottom = bottom
    }
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
  surfaceVertexCount: number,
  level: number,
): Float32Array {
  const colors = new Float32Array(positions.length)
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const offset = vertex * 3
    if (vertex >= surfaceVertexCount) {
      const variation = 0.82 + Math.sin(positions[offset] * 0.14 + positions[offset + 2] * 0.11) * 0.08
      colors[offset] = 0.23 * variation
      colors[offset + 1] = 0.2 * variation
      colors[offset + 2] = 0.16 * variation
      continue
    }
    const slope = 1 - Math.abs(normals[offset + 1])
    const altitude = smoothstep(20, 78, positions[offset + 1])
    const detailFade = 1 - level * 0.025
    const grass = { r: 0.23, g: 0.35, b: 0.2 }
    const rock = { r: 0.36, g: 0.32, b: 0.27 }
    const high = { r: 0.48, g: 0.48, b: 0.43 }
    const rockMix = smoothstep(0.2, 0.72, slope)
    colors[offset] = lerp(lerp(grass.r, rock.r, rockMix), high.r, altitude) * detailFade
    colors[offset + 1] = lerp(lerp(grass.g, rock.g, rockMix), high.g, altitude) * detailFade
    colors[offset + 2] = lerp(lerp(grass.b, rock.b, rockMix), high.b, altitude) * detailFade
  }
  return colors
}
