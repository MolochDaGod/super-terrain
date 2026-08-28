import { Color, Vector3 } from 'three/webgpu'
import {
  If,
  clamp,
  float,
  Fn,
  fract,
  int,
  max,
  mix,
  normalWorld,
  positionWorld,
  pow,
  screenUV,
  select,
  storage,
  texture3D,
  uint,
  uniform,
  vec3,
} from 'three/tsl'
import { SH_A0, SH_A1, SH_Y00, SH_Y1 } from '../sphericalHarmonics.ts'
import { INV_PI } from '../math.ts'
import type { VolumeGpuTextures } from './volumeTextures.ts'

type ShaderValue = any

export interface GiUniforms {
  camera: ReturnType<typeof uniform>
  enabled: ReturnType<typeof uniform>
  firstSize: ReturnType<typeof uniform>
  resolution: ReturnType<typeof uniform>
  cascadeCount: ReturnType<typeof uniform>
  voxelOrigin: ReturnType<typeof uniform>
  voxelSize: ReturnType<typeof uniform>
}

export interface DenoiseShTargets {
  r: ShaderValue
  g: ShaderValue
  b: ShaderValue
  width: number
  height: number
}

export function createGiUniforms(textures: VolumeGpuTextures, voxelOrigin: Vector3, voxelSize: number): GiUniforms {
  return {
    camera: uniform(new Vector3()),
    enabled: uniform(1),
    firstSize: uniform(textures.firstSize),
    resolution: uniform(textures.resolution),
    cascadeCount: uniform(textures.cascadeCount),
    voxelOrigin: uniform(voxelOrigin),
    voxelSize: uniform(voxelSize),
  }
}

function volumeIrradiance(
  textures: VolumeGpuTextures,
  uniforms: GiUniforms,
  p: ShaderValue,
  n: ShaderValue,
) {
  const c0 = float(SH_A0 * SH_Y00)
  const c1 = float(SH_A1 * SH_Y1)
  const rel = p.sub(uniforms.camera)
  const extent = max(max(rel.x.abs(), rel.y.abs()), rel.z.abs()).mul(2)
  const size0 = uniforms.firstSize
  const cascade = select(
    extent.greaterThan(size0.mul(2)),
    float(2),
    select(extent.greaterThan(size0), float(1), float(0)),
  )
  const size = size0.mul(pow(float(2), cascade))
  const cell = size.div(uniforms.resolution)
  const origin = uniforms.camera.sub(vec3(size.mul(0.5))).div(cell).floor().mul(cell)
  const local = p.sub(origin).div(size)
  const uvw = vec3(
    clamp(local.x, 0.001, 0.999),
    clamp(local.y, 0.001, 0.999),
    clamp(cascade.add(clamp(local.z, 0.001, 0.999)).div(uniforms.cascadeCount), 0.001, 0.999),
  )
  const l0 = texture3D(textures.l0, uvw)
  const lx = texture3D(textures.lx, uvw)
  const ly = texture3D(textures.ly, uvw)
  const lz = texture3D(textures.lz, uvw)
  return l0.xyz
    .mul(c0)
    .add(lx.xyz.mul(n.x).add(ly.xyz.mul(n.y)).add(lz.xyz.mul(n.z)).mul(c1))
    .max(0)
}

function readOnly(buffer: ShaderValue, count: number) {
  return storage(buffer.value, 'vec4', count).toReadOnly()
}

function sampleSh(
  bufR: ShaderValue,
  bufG: ShaderValue,
  bufB: ShaderValue,
  width: number,
  height: number,
  uv: ShaderValue,
) {
  const fx = clamp(uv.x.mul(width).sub(0.5), 0, width - 1.001)
  const fy = clamp(uv.y.mul(height).sub(0.5), 0, height - 1.001)
  const x0 = int(fx)
  const y0 = int(fy)
  const x1 = int(minInt(x0.add(int(1)), int(width - 1)))
  const y1 = int(minInt(y0.add(int(1)), int(height - 1)))
  const tx = fract(fx)
  const ty = fract(fy)
  const w = uint(width)
  const i00 = uint(y0).mul(w).add(uint(x0))
  const i10 = uint(y0).mul(w).add(uint(x1))
  const i01 = uint(y1).mul(w).add(uint(x0))
  const i11 = uint(y1).mul(w).add(uint(x1))
  const r = mix(mix(bufR.element(i00), bufR.element(i10), tx), mix(bufR.element(i01), bufR.element(i11), tx), ty)
  const g = mix(mix(bufG.element(i00), bufG.element(i10), tx), mix(bufG.element(i01), bufG.element(i11), tx), ty)
  const b = mix(mix(bufB.element(i00), bufB.element(i10), tx), mix(bufB.element(i01), bufB.element(i11), tx), ty)
  return { r, g, b }
}

function minInt(a: ShaderValue, b: ShaderValue) {
  return select(a.lessThan(b), a, b)
}

/**
 * Fragment indirect: bilinear-upscale denoised half-res gather SH (2-band),
 * evaluate with the surface normal, fall back to cascaded volumes on a miss.
 */
export function createIndirectNode(
  textures: VolumeGpuTextures,
  uniforms: GiUniforms,
  albedo: Color,
  denoise: DenoiseShTargets,
) {
  const albedoNode = uniform(albedo)
  const c0 = float(SH_A0 * SH_Y00)
  const c1 = float(SH_A1 * SH_Y1)
  const invPi = float(INV_PI)
  const count = denoise.width * denoise.height
  const bufR = readOnly(denoise.r, count)
  const bufG = readOnly(denoise.g, count)
  const bufB = readOnly(denoise.b, count)

  return Fn(() => {
    const n = normalWorld.normalize()
    const sh = sampleSh(bufR, bufG, bufB, denoise.width, denoise.height, screenUV)
    const l0 = vec3(sh.r.x, sh.g.x, sh.b.x)
    const lx = vec3(sh.r.y, sh.g.y, sh.b.y)
    const ly = vec3(sh.r.z, sh.g.z, sh.b.z)
    const lz = vec3(sh.r.w, sh.g.w, sh.b.w)
    const gatherIrr = l0
      .mul(c0)
      .add(lx.mul(n.x).add(ly.mul(n.y)).add(lz.mul(n.z)).mul(c1))
      .max(0) as ShaderValue
    const volIrr = volumeIrradiance(textures, uniforms, positionWorld, n)
    // Cascaded volumes are the stable image. Gather is a low-weight detail
    // layer — using it as the only indirect stamps the voxel/cache lattice
    // onto every surface.
    const irr = mix(volIrr, gatherIrr, 0.12).toVar()
    If(uniforms.enabled.lessThan(0.5), () => {
      irr.assign(vec3(0))
    })
    return irr.mul(albedoNode).mul(invPi)
  })()
}
