import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  Float32BufferAttribute,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGFormat,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
} from 'three/webgpu'
import { MeshoptSimplifier } from 'meshoptimizer/simplifier'
import {
  graniteSourceSeed,
  type GraniteSourceSeed,
} from './types'

const SOURCE_WORLD_SCALE = [1.82, 1.62, 1.7] as const
const QUANTIZED_SCALE = 0xffff
// Valid chart triangles are tightly clustered below 0.025 UV span. Atlas-backed
// LODs keep a guard for the handful of malformed source faces.
const MAX_CONTINUOUS_ATLAS_TRIANGLE_SPAN = 0.08

export type GraniteLodLevel = 0 | 1 | 2

interface GraniteTopologyLod {
  level: 1 | 2
  indices: Uint32Array
  maxGeometricError: number
}

export interface DecodedGraniteTopology {
  topologyKey: string
  domainCoordinates: Float32Array
  indices: Uint32Array
  bakeUvs: Float32Array
  lods: GraniteTopologyLod[]
}

type GraniteBakeSemantic =
  | 'normal-object'
  | 'normal-tangent'
  | 'height'
  | 'ambient-occlusion'
  | 'curvature'
  | 'region-mask'

interface GraniteBakeChannel {
  semantic: GraniteBakeSemantic
  components: number
  data: Uint8Array
}

export interface DecodedGraniteBake {
  topologyKey: string
  domain: 'uv-atlas' | 'triplanar'
  width: number
  height: number
  channels: GraniteBakeChannel[]
}

export interface GraniteBakeTextures {
  normalAo: DataTexture
  heightCurvature: DataTexture
}

export interface GraniteDetailTextures {
  normalHeightAo: DataTexture
  bytes: number
}

export interface GraniteRockResources {
  sourceSeed: GraniteSourceSeed
  topologyKey: string
  geometries: readonly [BufferGeometry, BufferGeometry, BufferGeometry]
  bakeTextures: GraniteBakeTextures
  detailTextures: GraniteDetailTextures
  lodErrors: readonly [number, number]
  textureBaseBytes: number
}

const SOURCE_URLS: Record<GraniteSourceSeed, { topology: URL; bake: URL }> = {
  1: {
    topology: new URL('./assets/granite-seed1.vtopo', import.meta.url),
    bake: new URL('./assets/granite-seed1.vbake', import.meta.url),
  },
  2: {
    topology: new URL('./assets/granite-seed2.vtopo', import.meta.url),
    bake: new URL('./assets/granite-seed2.vbake', import.meta.url),
  },
  3: {
    topology: new URL('./assets/granite-seed3.vtopo', import.meta.url),
    bake: new URL('./assets/granite-seed3.vbake', import.meta.url),
  },
  4: {
    topology: new URL('./assets/granite-seed4.vtopo', import.meta.url),
    bake: new URL('./assets/granite-seed4.vbake', import.meta.url),
  },
  5: {
    topology: new URL('./assets/granite-seed5.vtopo', import.meta.url),
    bake: new URL('./assets/granite-seed5.vbake', import.meta.url),
  },
  6: {
    topology: new URL('./assets/granite-seed6.vtopo', import.meta.url),
    bake: new URL('./assets/granite-seed6.vbake', import.meta.url),
  },
  7: {
    topology: new URL('./assets/granite-seed7.vtopo', import.meta.url),
    bake: new URL('./assets/granite-seed7.vbake', import.meta.url),
  },
}

const DETAIL_URL = new URL('./assets/granite-detail.vbake', import.meta.url)
const resourcePromises = new Map<GraniteSourceSeed, Promise<GraniteRockResources>>()
let detailPromise: Promise<GraniteDetailTextures> | undefined

export function graniteLodForDetail(detail: 2 | 3 | 4): GraniteLodLevel {
  return detail === 4 ? 0 : detail === 3 ? 1 : 2
}

export function loadGraniteRockResources(seed: number): Promise<GraniteRockResources> {
  const sourceSeed = graniteSourceSeed(seed)
  let promise = resourcePromises.get(sourceSeed)
  if (!promise) {
    promise = loadSourceResources(sourceSeed)
    resourcePromises.set(sourceSeed, promise)
  }
  return promise
}

async function loadSourceResources(sourceSeed: GraniteSourceSeed): Promise<GraniteRockResources> {
  const urls = SOURCE_URLS[sourceSeed]
  const [topologyBytes, bakeBytes, detailTextures] = await Promise.all([
    readArtifact(urls.topology),
    readArtifact(urls.bake),
    loadDetailTextures(),
  ])
  const topology = decodeGraniteTopology(topologyBytes)
  const bake = decodeGraniteBake(bakeBytes)
  if (topology.topologyKey !== bake.topologyKey) {
    throw new Error(`Granite topology/bake mismatch for source seed ${sourceSeed}`)
  }
  const geometries = await createGraniteGeometries(topology)
  return {
    sourceSeed,
    topologyKey: topology.topologyKey,
    geometries,
    bakeTextures: createPackedBakeTextures(bake),
    detailTextures,
    lodErrors: [
      topology.lods.find((candidate) => candidate.level === 1)
        ?.maxGeometricError ?? 0,
      topology.lods.find((candidate) => candidate.level === 2)
        ?.maxGeometricError ?? 0,
    ],
    textureBaseBytes: bake.width * bake.height * 6,
  }
}

async function loadDetailTextures(): Promise<GraniteDetailTextures> {
  detailPromise ??= readArtifact(DETAIL_URL)
    .then(decodeGraniteBake)
    .then(createGraniteDetailTextures)
  return detailPromise
}

async function readArtifact(url: URL): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Unable to load ${url.pathname}: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

export function decodeGraniteTopology(content: Uint8Array): DecodedGraniteTopology {
  const value = JSON.parse(new TextDecoder().decode(content)) as Record<string, unknown>
  if (value.format !== 'vibe3d-topology@1') throw new Error('Unsupported granite topology')
  if (typeof value.topologyKey !== 'string') throw new Error('Granite topology key is missing')
  if (!Array.isArray(value.lods)) throw new Error('Granite topology LODs are missing')

  const indexWidth = value.indexWidth === 16 ? 16 : 32
  const domainCoordinates = decodeFloat32(value.domainCoordinates, 'domain coordinates')
  const indices = decodeIndices(value.indices, indexWidth, 'LOD0 indices')
  const bakeUvs = decodeQuantizedUvs(value.bakeUvs)
  if (domainCoordinates.length % 3 !== 0) throw new Error('Granite positions are malformed')
  if (bakeUvs.length !== (domainCoordinates.length / 3) * 2) {
    throw new Error('Granite atlas UV count does not match its topology')
  }
  return {
    topologyKey: value.topologyKey,
    domainCoordinates,
    indices,
    bakeUvs,
    lods: value.lods.map((lod, index) => {
      const record = lod as Record<string, unknown>
      const level = Number(record.level)
      const maxGeometricError = Number(record.maxGeometricError)
      if (level !== 1 && level !== 2) {
        throw new Error(`Granite topology LOD ${index + 1} has an invalid level`)
      }
      if (!Number.isFinite(maxGeometricError) || maxGeometricError < 0) {
        throw new Error(`Granite topology LOD${level} has an invalid error bound`)
      }
      return {
        level,
        indices: decodeIndices(record.indices, indexWidth, `LOD${index + 1} indices`),
        maxGeometricError,
      }
    }),
  }
}

export function decodeGraniteBake(content: Uint8Array): DecodedGraniteBake {
  const value = JSON.parse(new TextDecoder().decode(content)) as Record<string, unknown>
  if (value.format !== 'vibe3d-surface-bake@1') throw new Error('Unsupported granite bake')
  if (typeof value.topologyKey !== 'string') throw new Error('Granite bake key is missing')
  if (value.domain !== 'uv-atlas' && value.domain !== 'triplanar') {
    throw new Error('Granite bake has an unsupported projection')
  }
  const width = Number(value.width)
  const height = Number(value.height)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('Granite bake dimensions are invalid')
  }
  if (!Array.isArray(value.channels)) throw new Error('Granite bake channels are missing')
  const channels = value.channels.map((channel, index): GraniteBakeChannel => {
    const record = channel as Record<string, unknown>
    if (typeof record.semantic !== 'string' || typeof record.data !== 'string') {
      throw new Error(`Granite bake channel ${index} is malformed`)
    }
    const components = Number(record.components)
    const data = fromBase64(record.data, `granite bake channel ${record.semantic}`)
    if (data.length !== width * height * components) {
      throw new Error(`Granite bake channel ${record.semantic} has the wrong size`)
    }
    return {
      semantic: record.semantic as GraniteBakeSemantic,
      components,
      data,
    }
  })
  return {
    topologyKey: value.topologyKey,
    domain: value.domain,
    width,
    height,
    channels,
  }
}

async function createGraniteGeometries(
  topology: DecodedGraniteTopology,
): Promise<readonly [BufferGeometry, BufferGeometry, BufferGeometry]> {
  const positions = materializePositions(topology.domainCoordinates)
  const sourceLod1 = topology.lods.find((candidate) => candidate.level === 1)
  const sourceLod2 = topology.lods.find((candidate) => candidate.level === 2)
  await MeshoptSimplifier.ready
  // scifi-kit's independently extracted LOD1 inherits each UV from one nearest
  // LOD0 vertex. That makes coarse triangles bridge unrelated atlas islands.
  // Simplify the real unwrapped LOD0 instead, treating UVs as protected
  // attributes and locking chart borders. The result keeps the same triangle
  // budget while retaining per-pixel access to the original surface bake.
  let lod1Indices = topology.indices
  if (MeshoptSimplifier.supported && sourceLod1) {
    try {
      ;[lod1Indices] = MeshoptSimplifier.simplifyWithAttributes(
        topology.indices,
        positions,
        3,
        topology.bakeUvs,
        2,
        [1, 1],
        null,
        sourceLod1.indices.length,
        sourceLod1.maxGeometricError * Math.max(...SOURCE_WORLD_SCALE),
        ['LockBorder', 'ErrorAbsolute'],
      )
    } catch {
      // Full LOD0 is the seam-safe fallback. Never return to the independently
      // generated coarse UVs that caused the corruption.
      lod1Indices = topology.indices
    }
  }
  const indicesFor = (level: GraniteLodLevel) =>
    level === 0
      ? topology.indices
      : level === 1
        ? lod1Indices
        : sourceLod2?.indices ?? topology.indices
  return [0, 1, 2].map((level) => createGraniteGeometry(
    positions,
    topology.bakeUvs,
    indicesFor(level as GraniteLodLevel),
    level as GraniteLodLevel,
  )) as [BufferGeometry, BufferGeometry, BufferGeometry]
}

function materializePositions(domain: Float32Array): Float32Array {
  const positions = new Float32Array(domain.length)
  let minimumY = Infinity
  for (let offset = 0; offset < domain.length; offset += 3) {
    positions[offset] = domain[offset]! * SOURCE_WORLD_SCALE[0]
    positions[offset + 1] = domain[offset + 1]! * SOURCE_WORLD_SCALE[1]
    positions[offset + 2] = domain[offset + 2]! * SOURCE_WORLD_SCALE[2]
    minimumY = Math.min(minimumY, positions[offset + 1]!)
  }
  for (let offset = 1; offset < positions.length; offset += 3) positions[offset] -= minimumY
  return positions
}

export function createGraniteGeometry(
  allPositions: Float32Array,
  allUvs: Float32Array,
  sourceIndices: Uint32Array,
  level: GraniteLodLevel,
): BufferGeometry {
  // Calculate the LOD's smooth normals before seam-guard triangles are split.
  // Recomputing afterward makes every duplicated fallback triangle an isolated
  // smoothing island, which turns the triplanar material into visibly flat,
  // solid-colour patches.
  const allNormals = calculateIndexedNormals(allPositions, sourceIndices)
  const vertexCount = allPositions.length / 3
  const remap = new Int32Array(vertexCount).fill(-1)
  let compactVertexCount = 0
  for (const sourceIndex of sourceIndices) {
    if (remap[sourceIndex] !== -1) continue
    remap[sourceIndex] = compactVertexCount++
  }
  let discontinuousTriangles = 0
  if (level <= 1) {
    for (let offset = 0; offset < sourceIndices.length; offset += 3) {
      if (!atlasTriangleIsContinuous(
        allUvs,
        sourceIndices[offset]!,
        sourceIndices[offset + 1]!,
        sourceIndices[offset + 2]!,
      )) discontinuousTriangles += 1
    }
  }
  const outputVertexCount = compactVertexCount + discontinuousTriangles * 3
  const positions = new Float32Array(outputVertexCount * 3)
  const normals = new Float32Array(outputVertexCount * 3)
  const uvs = new Float32Array(outputVertexCount * 2)
  const bakeValidity = new Float32Array(outputVertexCount).fill(1)
  for (let sourceIndex = 0; sourceIndex < vertexCount; sourceIndex += 1) {
    const targetIndex = remap[sourceIndex]!
    if (targetIndex < 0) continue
    positions.set(allPositions.subarray(sourceIndex * 3, sourceIndex * 3 + 3), targetIndex * 3)
    normals.set(allNormals.subarray(sourceIndex * 3, sourceIndex * 3 + 3), targetIndex * 3)
    uvs.set(allUvs.subarray(sourceIndex * 2, sourceIndex * 2 + 2), targetIndex * 2)
  }
  const localIndices = outputVertexCount <= 0xffff
    ? new Uint16Array(sourceIndices.length)
    : new Uint32Array(sourceIndices.length)
  let nextSplitVertex = compactVertexCount
  for (let offset = 0; offset < sourceIndices.length; offset += 3) {
    const continuous = level === 2 || atlasTriangleIsContinuous(
      allUvs,
      sourceIndices[offset]!,
      sourceIndices[offset + 1]!,
      sourceIndices[offset + 2]!,
    )
    for (let corner = 0; corner < 3; corner += 1) {
      const index = offset + corner
      const sourceIndex = sourceIndices[index]!
      if (continuous) {
        localIndices[index] = remap[sourceIndex]!
        continue
      }
      const targetIndex = nextSplitVertex++
      positions.set(
        allPositions.subarray(sourceIndex * 3, sourceIndex * 3 + 3),
        targetIndex * 3,
      )
      normals.set(
        allNormals.subarray(sourceIndex * 3, sourceIndex * 3 + 3),
        targetIndex * 3,
      )
      uvs.set(allUvs.subarray(sourceIndex * 2, sourceIndex * 2 + 2), targetIndex * 2)
      bakeValidity[targetIndex] = 0
      localIndices[index] = targetIndex
    }
  }
  const geometry = new BufferGeometry()
  geometry.name = `scifi-kit granite / compact LOD${level}`
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  geometry.setAttribute(
    'graniteBakeValid',
    new Float32BufferAttribute(bakeValidity, 1),
  )
  geometry.setIndex(new BufferAttribute(localIndices, 1))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  geometry.userData.graniteAtlas = {
    discontinuousTriangles,
    fallback: 'world-space procedural',
  }
  return geometry
}

function calculateIndexedNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length)
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]! * 3
    const b = indices[offset + 1]! * 3
    const c = indices[offset + 2]! * 3
    const abX = positions[b]! - positions[a]!
    const abY = positions[b + 1]! - positions[a + 1]!
    const abZ = positions[b + 2]! - positions[a + 2]!
    const acX = positions[c]! - positions[a]!
    const acY = positions[c + 1]! - positions[a + 1]!
    const acZ = positions[c + 2]! - positions[a + 2]!
    const nx = abY * acZ - abZ * acY
    const ny = abZ * acX - abX * acZ
    const nz = abX * acY - abY * acX
    for (const vertex of [a, b, c]) {
      normals[vertex] += nx
      normals[vertex + 1] += ny
      normals[vertex + 2] += nz
    }
  }
  // The source atlas intentionally duplicates vertices at chart borders. Weld
  // only exact coincident positions for normal accumulation; otherwise the UV
  // seam becomes a lighting seam the moment a triangle switches away from its
  // corrupt baked object normal.
  const groups = new Map<
    string,
    { x: number; y: number; z: number; offsets: number[] }
  >()
  for (let offset = 0; offset < positions.length; offset += 3) {
    const key = `${positions[offset]}:${positions[offset + 1]}:${positions[offset + 2]}`
    let group = groups.get(key)
    if (!group) {
      group = { x: 0, y: 0, z: 0, offsets: [] }
      groups.set(key, group)
    }
    group.x += normals[offset]!
    group.y += normals[offset + 1]!
    group.z += normals[offset + 2]!
    group.offsets.push(offset)
  }
  for (const group of groups.values()) {
    const length = Math.hypot(
      group.x,
      group.y,
      group.z,
    ) || 1
    for (const offset of group.offsets) {
      normals[offset] = group.x / length
      normals[offset + 1] = group.y / length
      normals[offset + 2] = group.z / length
    }
  }
  return normals
}

export function atlasTriangleIsContinuous(
  uvs: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
): boolean {
  for (const [first, second] of [[a, b], [b, c], [c, a]] as const) {
    if (
      Math.abs(Number(uvs[first * 2]) - Number(uvs[second * 2])) >
        MAX_CONTINUOUS_ATLAS_TRIANGLE_SPAN ||
      Math.abs(Number(uvs[first * 2 + 1]) - Number(uvs[second * 2 + 1])) >
        MAX_CONTINUOUS_ATLAS_TRIANGLE_SPAN
    ) return false
  }
  return true
}

function createPackedBakeTextures(bake: DecodedGraniteBake): GraniteBakeTextures {
  if (bake.domain !== 'uv-atlas') throw new Error('Granite surface bake must use atlas UVs')
  const normal = requiredChannel(bake, 'normal-object', 3).data
  const height = requiredChannel(bake, 'height', 1).data
  const ao = requiredChannel(bake, 'ambient-occlusion', 1).data
  const curvature = requiredChannel(bake, 'curvature', 1).data
  const texels = bake.width * bake.height
  const normalAo = new Uint8Array(texels * 4)
  const heightCurvature = new Uint8Array(texels * 2)
  for (let texel = 0; texel < texels; texel += 1) {
    normalAo[texel * 4] = normal[texel * 3]!
    normalAo[texel * 4 + 1] = normal[texel * 3 + 1]!
    normalAo[texel * 4 + 2] = normal[texel * 3 + 2]!
    normalAo[texel * 4 + 3] = ao[texel]!
    heightCurvature[texel * 2] = height[texel]!
    heightCurvature[texel * 2 + 1] = curvature[texel]!
  }
  return {
    normalAo: surfaceTexture(normalAo, bake, RGBAFormat, 'object normal + AO'),
    heightCurvature: surfaceTexture(heightCurvature, bake, RGFormat, 'height + curvature'),
  }
}

function createGraniteDetailTextures(bake: DecodedGraniteBake): GraniteDetailTextures {
  if (bake.domain !== 'triplanar') throw new Error('Granite detail bake must be triplanar')
  if (bake.width !== bake.height) throw new Error('Granite detail tile must be square')
  const normal = requiredChannel(bake, 'normal-tangent', 3).data
  const height = requiredChannel(bake, 'height', 1).data
  const ao = requiredChannel(bake, 'ambient-occlusion', 1).data
  const pixels = new Uint8Array(bake.width * bake.height * 4)
  for (let texel = 0; texel < bake.width * bake.height; texel += 1) {
    pixels[texel * 4] = normal[texel * 3]!
    pixels[texel * 4 + 1] = normal[texel * 3 + 1]!
    pixels[texel * 4 + 2] = height[texel]!
    pixels[texel * 4 + 3] = ao[texel]!
  }
  const texture = new DataTexture(
    pixels,
    bake.width,
    bake.height,
    RGBAFormat,
    UnsignedByteType,
  )
  texture.name = 'scifi-kit granite / triplanar crystal detail'
  texture.colorSpace = NoColorSpace
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 8
  texture.flipY = false
  texture.needsUpdate = true
  return { normalHeightAo: texture, bytes: pixels.byteLength }
}

function surfaceTexture(
  data: Uint8Array,
  bake: DecodedGraniteBake,
  format: typeof RGFormat | typeof RGBAFormat,
  name: string,
): DataTexture {
  const texture = new DataTexture(data, bake.width, bake.height, format, UnsignedByteType)
  texture.name = `scifi-kit granite / ${name}`
  texture.colorSpace = NoColorSpace
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 8
  texture.flipY = false
  texture.needsUpdate = true
  return texture
}

function requiredChannel(
  bake: DecodedGraniteBake,
  semantic: GraniteBakeSemantic,
  components: number,
): GraniteBakeChannel {
  const channel = bake.channels.find((candidate) => candidate.semantic === semantic)
  if (!channel || channel.components !== components) {
    throw new Error(`Granite ${semantic} channel is missing`)
  }
  return channel
}

function decodeFloat32(value: unknown, label: string): Float32Array {
  if (typeof value !== 'string') throw new Error(`${label} are not base64 encoded`)
  const bytes = fromBase64(value, label)
  if (bytes.byteLength % 4 !== 0) throw new Error(`${label} byte count is invalid`)
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

function decodeIndices(value: unknown, width: 16 | 32, label: string): Uint32Array {
  if (typeof value !== 'string') throw new Error(`${label} are not base64 encoded`)
  const bytes = fromBase64(value, label)
  if (width === 16) {
    const packed = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
    return new Uint32Array(packed)
  }
  const packed = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  return new Uint32Array(packed)
}

function decodeQuantizedUvs(value: unknown): Float32Array {
  if (typeof value !== 'string') throw new Error('Granite atlas UVs are missing')
  const bytes = fromBase64(value, 'granite atlas UVs')
  const packed = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  const result = new Float32Array(packed.length)
  for (let index = 0; index < packed.length; index += 1) {
    result[index] = packed[index]! / QUANTIZED_SCALE
  }
  return result
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index
  }
  return table
})()

function fromBase64(text: string, label: string): Uint8Array {
  const clean = text.endsWith('==')
    ? text.slice(0, -2)
    : text.endsWith('=')
      ? text.slice(0, -1)
      : text
  const padding = text.length - clean.length
  if (text.length % 4 !== 0) throw new Error(`${label} is not valid base64`)
  const output = new Uint8Array((text.length / 4) * 3 - padding)
  let cursor = 0
  let accumulator = 0
  let bits = 0
  for (let index = 0; index < clean.length; index += 1) {
    const code = clean.charCodeAt(index)
    const value = code < 128 ? BASE64_LOOKUP[code]! : -1
    if (value < 0) throw new Error(`${label} is not valid base64`)
    accumulator = (accumulator << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      output[cursor++] = (accumulator >> bits) & 0xff
    }
  }
  return output
}
