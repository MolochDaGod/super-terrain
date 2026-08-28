import {
  Box3,
  ClampToEdgeWrapping,
  Color,
  Data3DTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NearestFilter,
  RGBAFormat,
  RedFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Texture,
} from 'three/webgpu'

/**
 * Static scene representation the GI rays trace against.
 *
 * Sousa traces hardware rays against the BVH; WebGPU exposes no ray queries,
 * so the swap-in is a signed-distance volume. Sphere tracing it costs a handful
 * of taps per ray instead of one tap per voxel, and — the part that matters for
 * stability — the hit point is a continuous function of the ray, so it does not
 * jitter with the step phase the way a fixed-step occupancy march does.
 */
export interface VoxelScene {
  /** Voxel counts per axis. Cells are cubic; the volume is not. */
  dims: [number, number, number]
  /** Min corner of the volume in world space. */
  origin: Vector3
  /** World extent of the whole volume (dims * cell). */
  extent: Vector3
  cell: number
  /** RGBA8: linear albedo in rgb, coverage in a. */
  albedo: Data3DTexture
  /** RGBA8: area-weighted geometric normal, encoded *0.5+0.5. */
  normal: Data3DTexture
  /** R16F: unsigned distance to the nearest surface, in world units. */
  sdf: Data3DTexture
  occupiedCount: number
  dispose(): void
}

export interface VoxelizeOptions {
  /** Voxels along the longest axis. 128 ≈ 0.24 m cells on Sponza. */
  maxResolution?: number
  /** Skip meshes whose material is fully transparent glass etc. */
  filter?: (mesh: Mesh) => boolean
  onProgress?: (fraction: number, label: string) => void
}

const _box = new Box3()
const _meshBox = new Box3()
const _v0 = new Vector3()
const _v1 = new Vector3()
const _v2 = new Vector3()
const _e1 = new Vector3()
const _e2 = new Vector3()
const _n = new Vector3()
const _p = new Vector3()

function averageTextureColor(map: Texture | null): [number, number, number] {
  if (!map || !map.image) return [1, 1, 1]
  const image = map.image as CanvasImageSource & { width?: number; height?: number }
  const width = Number(image.width ?? 0)
  const height = Number(image.height ?? 0)
  if (!width || !height) return [1, 1, 1]
  const size = 8
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(size, size)
      : Object.assign(document.createElement('canvas'), { width: size, height: size })
  const ctx = (canvas as OffscreenCanvas).getContext('2d', {
    willReadFrequently: true,
  }) as OffscreenCanvasRenderingContext2D | null
  if (!ctx) return [1, 1, 1]
  try {
    ctx.drawImage(image, 0, 0, size, size)
  } catch {
    return [1, 1, 1]
  }
  const data = ctx.getImageData(0, 0, size, size).data
  let r = 0
  let g = 0
  let b = 0
  let weight = 0
  for (let i = 0; i < data.length; i += 4) {
    // Alpha-weighted: masked foliage atlases are mostly empty texels and their
    // average is otherwise dragged toward whatever the unused padding holds.
    const a = (data[i + 3] ?? 255) / 255
    r += ((data[i] ?? 0) / 255) * a
    g += ((data[i + 1] ?? 0) / 255) * a
    b += ((data[i + 2] ?? 0) / 255) * a
    weight += a
  }
  if (weight < 1e-4) return [1, 1, 1]
  const inv = 1 / weight
  const srgbToLinear = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  const isSrgb = map.colorSpace === SRGBColorSpace
  const out: [number, number, number] = [r * inv, g * inv, b * inv]
  return isSrgb ? [srgbToLinear(out[0]), srgbToLinear(out[1]), srgbToLinear(out[2])] : out
}

const _albedoCache = new WeakMap<Material, [number, number, number]>()

function materialAlbedo(material: Material): [number, number, number] {
  const cached = _albedoCache.get(material)
  if (cached) return cached
  const std = material as Material & { color?: Color; map?: Texture | null }
  const base = std.color ? [std.color.r, std.color.g, std.color.b] : [0.7, 0.7, 0.7]
  const tex = averageTextureColor(std.map ?? null)
  // Bounce albedo above ~0.9 makes the multi-bounce feedback loop diverge.
  const value: [number, number, number] = [
    Math.min(0.9, base[0]! * tex[0]),
    Math.min(0.9, base[1]! * tex[1]),
    Math.min(0.9, base[2]! * tex[2]),
  ]
  _albedoCache.set(material, value)
  return value
}

function make3D(
  data: ArrayBufferView,
  dims: [number, number, number],
  format: typeof RGBAFormat | typeof RedFormat,
  type: typeof HalfFloatType | typeof UnsignedByteType,
  filter: typeof LinearFilter | typeof NearestFilter,
  name: string,
): Data3DTexture {
  const tex = new Data3DTexture(data as never, dims[0], dims[1], dims[2])
  tex.format = format
  tex.type = type
  tex.minFilter = filter
  tex.magFilter = filter
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.wrapR = ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.unpackAlignment = 1
  tex.name = name
  tex.needsUpdate = true
  return tex
}

/**
 * Coverage-weighted colour and normal sums, one entry per voxel.
 *
 * Kept separate from `VoxelScene` so a volume can be filled from triangles, from
 * analytic proxy shapes, or from both, and only then turned into GPU textures.
 */
export interface VoxelAccumulator {
  dims: [number, number, number]
  origin: Vector3
  cell: number
  colour: Float32Array
  normal: Float32Array
  weight: Float32Array
}

/** Allocates a volume of cubic cells covering `bounds`, plus a cell of padding. */
export function createVoxelVolume(
  bounds: Box3,
  maxResolution: number,
): VoxelAccumulator {
  const size = bounds.getSize(new Vector3())
  const longest = Math.max(size.x, size.y, size.z, 1e-3)
  const cell = longest / Math.max(8, maxResolution)
  const dims: [number, number, number] = [
    Math.max(4, Math.ceil(size.x / cell) + 2),
    Math.max(4, Math.ceil(size.y / cell) + 2),
    Math.max(4, Math.ceil(size.z / cell) + 2),
  ]
  const count = dims[0] * dims[1] * dims[2]
  return {
    dims,
    // One cell of padding so a ray leaving the geometry still has valid field.
    origin: bounds.min.clone().addScalar(-cell),
    cell,
    colour: new Float32Array(count * 3),
    normal: new Float32Array(count * 3),
    weight: new Float32Array(count),
  }
}

/** Accumulates one covered sample into the voxel containing `x, y, z`. */
export function splatSample(
  acc: VoxelAccumulator,
  x: number, y: number, z: number,
  albedo: readonly [number, number, number],
  nx: number, ny: number, nz: number,
  weight: number,
): void {
  const [dx, dy, dz] = acc.dims
  const ix = Math.floor((x - acc.origin.x) / acc.cell)
  const iy = Math.floor((y - acc.origin.y) / acc.cell)
  const iz = Math.floor((z - acc.origin.z) / acc.cell)
  if (ix < 0 || iy < 0 || iz < 0 || ix >= dx || iy >= dy || iz >= dz) return
  const index = (iz * dy + iy) * dx + ix
  const o3 = index * 3
  acc.colour[o3] += albedo[0] * weight
  acc.colour[o3 + 1] += albedo[1] * weight
  acc.colour[o3 + 2] += albedo[2] * weight
  acc.normal[o3] += nx * weight
  acc.normal[o3 + 1] += ny * weight
  acc.normal[o3 + 2] += nz * weight
  acc.weight[index] += weight
}

/**
 * Area-uniform point sampling of a triangle. Conservative SAT rasterisation is
 * the textbook answer, but at half-cell sample spacing this misses nothing a
 * 0.2 m voxel could resolve and runs several times faster on 260 k triangles.
 */
export function splatTriangle(
  acc: VoxelAccumulator,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  albedo: [number, number, number],
): void {
  _v0.set(ax, ay, az)
  _v1.set(bx, by, bz)
  _v2.set(cx, cy, cz)
  _e1.subVectors(_v1, _v0)
  _e2.subVectors(_v2, _v0)
  _n.crossVectors(_e1, _e2)
  const doubleArea = _n.length()
  if (doubleArea < 1e-12) return
  _n.multiplyScalar(1 / doubleArea)

  const step = acc.cell * 0.45
  const nu = Math.max(1, Math.min(512, Math.ceil(_e1.length() / step)))
  const nv = Math.max(1, Math.min(512, Math.ceil(_e2.length() / step)))
  const n = Math.max(nu, nv)
  const inv = 1 / n
  const [dx, dy, dz] = acc.dims
  const ox = acc.origin.x
  const oy = acc.origin.y
  const oz = acc.origin.z
  const invCell = 1 / acc.cell
  const weight = doubleArea / ((n + 1) * (n + 2) * 0.5)

  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; i + j <= n; j += 1) {
      const u = i * inv
      const v = j * inv
      _p.copy(_v0).addScaledVector(_e1, u).addScaledVector(_e2, v)
      const ix = Math.floor((_p.x - ox) * invCell)
      const iy = Math.floor((_p.y - oy) * invCell)
      const iz = Math.floor((_p.z - oz) * invCell)
      if (ix < 0 || iy < 0 || iz < 0 || ix >= dx || iy >= dy || iz >= dz) continue
      const index = (iz * dy + iy) * dx + ix
      const o3 = index * 3
      acc.colour[o3] += albedo[0] * weight
      acc.colour[o3 + 1] += albedo[1] * weight
      acc.colour[o3 + 2] += albedo[2] * weight
      acc.normal[o3] += _n.x * weight
      acc.normal[o3 + 1] += _n.y * weight
      acc.normal[o3 + 2] += _n.z * weight
      acc.weight[index] += weight
    }
  }
}

/**
 * Vector distance transform (3D 8SSEDT, Danielsson): each voxel stores the
 * offset to the nearest surface voxel, propagated by one forward and one
 * backward sweep. Near-exact Euclidean distance for the cost of a chamfer.
 */
function distanceTransform(
  weightGrid: Float32Array,
  dims: [number, number, number],
): Float32Array {
  const [dx, dy, dz] = dims
  const count = dx * dy * dz
  const FAR = 32767
  const vx = new Int16Array(count)
  const vy = new Int16Array(count)
  const vz = new Int16Array(count)
  for (let i = 0; i < count; i += 1) {
    if (weightGrid[i]! > 0) continue
    vx[i] = FAR
    vy[i] = FAR
    vz[i] = FAR
  }

  const relax = (index: number, other: number, ox: number, oy: number, oz: number) => {
    const nx = vx[other]! + ox
    const ny = vy[other]! + oy
    const nz = vz[other]! + oz
    const candidate = nx * nx + ny * ny + nz * nz
    const current = vx[index]! * vx[index]! + vy[index]! * vy[index]! + vz[index]! * vz[index]!
    if (candidate < current) {
      vx[index] = nx
      vy[index] = ny
      vz[index] = nz
    }
  }

  const at = (x: number, y: number, z: number) => (z * dy + y) * dx + x

  // Forward: neighbours already visited in scan order.
  for (let z = 0; z < dz; z += 1) {
    for (let y = 0; y < dy; y += 1) {
      for (let x = 0; x < dx; x += 1) {
        const i = at(x, y, z)
        if (vx[i] === 0 && vy[i] === 0 && vz[i] === 0) continue
        if (x > 0) relax(i, at(x - 1, y, z), 1, 0, 0)
        if (y > 0) relax(i, at(x, y - 1, z), 0, 1, 0)
        if (z > 0) relax(i, at(x, y, z - 1), 0, 0, 1)
        if (x > 0 && y > 0) relax(i, at(x - 1, y - 1, z), 1, 1, 0)
        if (x > 0 && z > 0) relax(i, at(x - 1, y, z - 1), 1, 0, 1)
        if (y > 0 && z > 0) relax(i, at(x, y - 1, z - 1), 0, 1, 1)
        if (x > 0 && y > 0 && z > 0) relax(i, at(x - 1, y - 1, z - 1), 1, 1, 1)
      }
      for (let x = dx - 2; x >= 0; x -= 1) {
        const i = at(x, y, z)
        if (vx[i] === 0 && vy[i] === 0 && vz[i] === 0) continue
        relax(i, at(x + 1, y, z), 1, 0, 0)
      }
    }
  }
  // Backward.
  for (let z = dz - 1; z >= 0; z -= 1) {
    for (let y = dy - 1; y >= 0; y -= 1) {
      for (let x = dx - 1; x >= 0; x -= 1) {
        const i = at(x, y, z)
        if (vx[i] === 0 && vy[i] === 0 && vz[i] === 0) continue
        if (x < dx - 1) relax(i, at(x + 1, y, z), 1, 0, 0)
        if (y < dy - 1) relax(i, at(x, y + 1, z), 0, 1, 0)
        if (z < dz - 1) relax(i, at(x, y, z + 1), 0, 0, 1)
        if (x < dx - 1 && y < dy - 1) relax(i, at(x + 1, y + 1, z), 1, 1, 0)
        if (x < dx - 1 && z < dz - 1) relax(i, at(x + 1, y, z + 1), 1, 0, 1)
        if (y < dy - 1 && z < dz - 1) relax(i, at(x, y + 1, z + 1), 0, 1, 1)
        if (x < dx - 1 && y < dy - 1 && z < dz - 1) relax(i, at(x + 1, y + 1, z + 1), 1, 1, 1)
      }
      for (let x = 1; x < dx; x += 1) {
        const i = at(x, y, z)
        if (vx[i] === 0 && vy[i] === 0 && vz[i] === 0) continue
        relax(i, at(x - 1, y, z), 1, 0, 0)
      }
    }
  }

  const distance = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    distance[i] = Math.sqrt(vx[i]! * vx[i]! + vy[i]! * vy[i]! + vz[i]! * vz[i]!)
  }
  return distance
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export async function voxelizeScene(
  root: Object3D,
  options: VoxelizeOptions = {},
): Promise<VoxelScene> {
  const maxResolution = options.maxResolution ?? 128
  const report = options.onProgress ?? (() => {})

  root.updateWorldMatrix(true, true)
  const meshes: Mesh[] = []
  root.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh || !mesh.visible) return
    if (options.filter && !options.filter(mesh)) return
    meshes.push(mesh)
  })
  if (meshes.length === 0) throw new Error('voxelizeScene: no meshes to voxelize')

  _box.makeEmpty()
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox()
    const bounds = mesh.geometry.boundingBox
    if (!bounds) continue
    _box.union(_meshBox.copy(bounds).applyMatrix4(mesh.matrixWorld))
  }
  const acc = createVoxelVolume(_box, maxResolution)

  let done = 0
  for (const mesh of meshes) {
    const geometry = mesh.geometry as BufferGeometry
    const position = geometry.getAttribute('position')
    if (!position) {
      done += 1
      continue
    }
    const index = geometry.getIndex()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const groups = geometry.groups.length > 0
      ? geometry.groups
      : [{ start: 0, count: index ? index.count : position.count, materialIndex: 0 }]
    const matrix = mesh.matrixWorld
    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0] ?? materials[0]!
      const albedo = materialAlbedo(material)
      const end = group.start + group.count
      for (let t = group.start; t + 2 < end; t += 3) {
        const ia = index ? index.getX(t) : t
        const ib = index ? index.getX(t + 1) : t + 1
        const ic = index ? index.getX(t + 2) : t + 2
        _v0.fromBufferAttribute(position, ia).applyMatrix4(matrix)
        const ax = _v0.x, ay = _v0.y, az = _v0.z
        _v0.fromBufferAttribute(position, ib).applyMatrix4(matrix)
        const bx = _v0.x, by = _v0.y, bz = _v0.z
        _v0.fromBufferAttribute(position, ic).applyMatrix4(matrix)
        splatTriangle(acc, ax, ay, az, bx, by, bz, _v0.x, _v0.y, _v0.z, albedo)
      }
    }
    done += 1
    report((done / meshes.length) * 0.7, `voxelizing ${done}/${meshes.length}`)
    if (done % 4 === 0) await nextFrame()
  }

  report(0.72, 'distance field')
  await nextFrame()
  const scene = finaliseVoxels(acc)
  report(1, 'ready')
  return scene
}


/**
 * Turns accumulated coverage into the GPU volumes the tracer reads: quantised
 * albedo and geometric normal, plus the distance field derived from occupancy.
 */
export function finaliseVoxels(acc: VoxelAccumulator): VoxelScene {
  const { dims, origin, cell } = acc
  const count = dims[0] * dims[1] * dims[2]
  const distance = distanceTransform(acc.weight, dims)

  const albedoData = new Uint8Array(count * 4)
  const normalData = new Uint8Array(count * 4)
  const sdfData = new Uint16Array(count)
  let occupied = 0
  for (let i = 0; i < count; i += 1) {
    const w = acc.weight[i]!
    if (w > 0) {
      occupied += 1
      const inv = 1 / w
      albedoData[i * 4] = Math.min(255, Math.round(acc.colour[i * 3]! * inv * 255))
      albedoData[i * 4 + 1] = Math.min(255, Math.round(acc.colour[i * 3 + 1]! * inv * 255))
      albedoData[i * 4 + 2] = Math.min(255, Math.round(acc.colour[i * 3 + 2]! * inv * 255))
      albedoData[i * 4 + 3] = 255
      const nx = acc.normal[i * 3]!
      const ny = acc.normal[i * 3 + 1]!
      const nz = acc.normal[i * 3 + 2]!
      const len = Math.hypot(nx, ny, nz) || 1
      normalData[i * 4] = Math.round((nx / len) * 127.5 + 127.5)
      normalData[i * 4 + 1] = Math.round((ny / len) * 127.5 + 127.5)
      normalData[i * 4 + 2] = Math.round((nz / len) * 127.5 + 127.5)
      // Confidence: a voxel straddling two opposing faces averages to ~0, and
      // its normal must not then be trusted over the distance-field gradient.
      normalData[i * 4 + 3] = Math.round(Math.min(1, Math.hypot(nx, ny, nz) / w) * 255)
    }
    // Distance is measured between voxel centres; back it off half a cell so
    // the isosurface sits on the geometry rather than half a voxel inside it.
    sdfData[i] = DataUtils.toHalfFloat(Math.max(0, (distance[i]! - 0.5) * cell))
  }

  const scene: VoxelScene = {
    dims,
    origin,
    extent: new Vector3(dims[0] * cell, dims[1] * cell, dims[2] * cell),
    cell,
    albedo: make3D(albedoData, dims, RGBAFormat, UnsignedByteType, LinearFilter, 'gi-vox-albedo'),
    normal: make3D(normalData, dims, RGBAFormat, UnsignedByteType, LinearFilter, 'gi-vox-normal'),
    sdf: make3D(sdfData, dims, RedFormat, HalfFloatType, LinearFilter, 'gi-vox-sdf'),
    occupiedCount: occupied,
    dispose() {
      scene.albedo.dispose()
      scene.normal.dispose()
      scene.sdf.dispose()
    },
  }
  return scene
}

/** Fills a horizontal slab — the ground plane a proxy scene stands on. */
export function splatSlab(
  acc: VoxelAccumulator,
  y: number,
  thickness: number,
  albedo: readonly [number, number, number],
): void {
  const [dx, , dz] = acc.dims
  const layers = Math.max(1, Math.round(thickness / acc.cell))
  for (let iz = 0; iz < dz; iz += 1) {
    const z = acc.origin.z + (iz + 0.5) * acc.cell
    for (let ix = 0; ix < dx; ix += 1) {
      const x = acc.origin.x + (ix + 0.5) * acc.cell
      for (let layer = 0; layer < layers; layer += 1) {
        splatSample(acc, x, y - layer * acc.cell, z, albedo, 0, 1, 0, 1)
      }
    }
  }
}

/**
 * Fills a tapered capsule: a trunk, a branch, or a fallen log.
 *
 * The radius is floored at half a cell. A stem thinner than the voxel grid
 * would otherwise vanish entirely, and a forest whose trunks cast no shadow
 * loses the one occlusion cue that reads as "under trees".
 */
export function splatTaperedCylinder(
  acc: VoxelAccumulator,
  from: Vector3,
  to: Vector3,
  radiusFrom: number,
  radiusTo: number,
  albedo: readonly [number, number, number],
): void {
  const axis = _v1.subVectors(to, from)
  const length = axis.length()
  if (length < 1e-4) return
  const steps = Math.max(1, Math.ceil(length / (acc.cell * 0.5)))
  const floor = acc.cell * 0.5
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const radius = Math.max(floor, radiusFrom + (radiusTo - radiusFrom) * t)
    _p.copy(from).addScaledVector(axis, t)
    const ring = Math.max(1, Math.ceil((radius * 2 * Math.PI) / (acc.cell * 0.6)))
    const rings = Math.max(1, Math.ceil(radius / (acc.cell * 0.6)))
    for (let r = 0; r <= rings; r += 1) {
      const rr = (radius * r) / rings
      const spokes = r === 0 ? 1 : Math.max(4, Math.round((ring * r) / rings))
      for (let a = 0; a < spokes; a += 1) {
        const angle = (a / spokes) * Math.PI * 2
        const ox = Math.cos(angle) * rr
        const oz = Math.sin(angle) * rr
        splatSample(acc, _p.x + ox, _p.y, _p.z + oz, albedo, ox, 0, oz, 1)
      }
    }
  }
}

/**
 * Fills a porous ellipsoidal shell — a tree crown.
 *
 * A solid crown would be an opaque dome and the floor beneath it would go
 * black. Leaves live in the outer part of the crown and light finds its way
 * through the gaps between them, so the proxy fills a shell and drops a
 * deterministic fraction of its cells. The holes are what let dappled light
 * and green bounce reach the ground at all.
 */
export function splatCanopyShell(
  acc: VoxelAccumulator,
  centre: Vector3,
  radius: Vector3,
  albedo: readonly [number, number, number],
  options: { shell?: number; porosity?: number; seed?: number } = {},
): void {
  const shell = options.shell ?? 0.42
  const porosity = options.porosity ?? 0.4
  const seed = (options.seed ?? 1) | 0
  const step = acc.cell * 0.75
  const nx = Math.max(1, Math.ceil((radius.x * 2) / step))
  const ny = Math.max(1, Math.ceil((radius.y * 2) / step))
  const nz = Math.max(1, Math.ceil((radius.z * 2) / step))
  for (let k = 0; k <= nz; k += 1) {
    const wz = (k / nz) * 2 - 1
    for (let j = 0; j <= ny; j += 1) {
      const wy = (j / ny) * 2 - 1
      for (let i = 0; i <= nx; i += 1) {
        const wx = (i / nx) * 2 - 1
        const rSq = wx * wx + wy * wy + wz * wz
        if (rSq > 1) continue
        const r = Math.sqrt(rSq)
        if (r < 1 - shell) continue
        // Hash the cell so the holes are stable across rebuilds: a canopy whose
        // gaps moved every frame would be a scene full of moving shadows.
        let h = (Math.imul(i + 1, 0x27d4eb2d) ^ Math.imul(j + 7, 0x165667b1) ^
          Math.imul(k + 13, 0x9e3779b1) ^ seed) >>> 0
        h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0
        // Denser toward the crown surface, thinner inside, as a real crown is.
        const density = (1 - porosity) * (0.45 + 0.55 * ((r - (1 - shell)) / shell))
        if ((h & 0xffff) / 0x10000 > density) continue
        splatSample(
          acc,
          centre.x + wx * radius.x,
          centre.y + wy * radius.y,
          centre.z + wz * radius.z,
          albedo,
          wx / Math.max(r, 1e-4),
          wy / Math.max(r, 1e-4),
          wz / Math.max(r, 1e-4),
          1,
        )
      }
    }
  }
}
