import {
  FloatType,
  LinearFilter,
  NearestFilter,
  RGBAFormat,
  Storage3DTexture,
  StorageTexture,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import type ComputeNode from 'three/src/nodes/gpgpu/ComputeNode.js'
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  clamp,
  cross,
  float,
  fract,
  instanceIndex,
  int,
  ivec2,
  ivec3,
  max,
  mix,
  normalize,
  pow,
  select,
  instancedArray,
  texture,
  texture3D,
  textureStore,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { GOLDEN_ANGLE, INV_PI } from '../math.ts'
import { SH_A0, SH_A1, SH_Y00, SH_Y1 } from '../sphericalHarmonics.ts'
import type { VolumeGpuTextures } from './volumeTextures.ts'
import type { GiUniforms } from './irradianceNode.ts'

type ShaderValue = any

function storageTarget(
  width: number,
  height: number,
  name: string,
  filter: typeof LinearFilter | typeof NearestFilter = NearestFilter,
): StorageTexture {
  const texture = new StorageTexture(width, height)
  texture.name = name
  texture.format = RGBAFormat
  texture.type = FloatType
  texture.minFilter = filter
  texture.magFilter = filter
  texture.generateMipmaps = false
  ;(texture as StorageTexture & { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false
  return texture
}

export interface GiComputePasses {
  visibility: ComputeNode
  gather: ComputeNode
  denoise: ComputeNode
  cacheScreen: ComputeNode
  hitCount: number
  gatherWidth: number
  gatherHeight: number
  gatherSize: Vector2
  /** Sousa 2-band SH buffers, one vec4 per pixel: (L0, Lx, Ly, Lz). */
  denoiseR: ShaderValue
  denoiseG: ShaderValue
  denoiseB: ShaderValue
  hitsPos: ShaderValue
  probeOrigin: ReturnType<typeof uniform>
  cascadeCell: ReturnType<typeof uniform>
  cascadeRes: ReturnType<typeof uniform>
  frame: ReturnType<typeof uniform>
  view: {
    pos: ReturnType<typeof uniform>
    right: ReturnType<typeof uniform>
    up: ReturnType<typeof uniform>
    forward: ReturnType<typeof uniform>
    tanHalf: ReturnType<typeof uniform>
    aspect: ReturnType<typeof uniform>
    viewProjX: ReturnType<typeof uniform>
    viewProjY: ReturnType<typeof uniform>
    viewProjZ: ReturnType<typeof uniform>
    viewProjW: ReturnType<typeof uniform>
  }
  light: {
    pos: ReturnType<typeof uniform>
    color: ReturnType<typeof uniform>
    dir: ReturnType<typeof uniform>
    params: ReturnType<typeof uniform>
  }
}

/**
 * TSL Sousa stages:
 * 1. Visibility: every (probe, ray) DDA writes a hit slot, shades, splats cache.
 * 2. Gather: half-res, cache-only, fallback screen-space → radiance cache → volumes,
 *    stored as 2-band SH.
 * 3. Denoise + copy into a screen cache for the next frame.
 */
export function createGiComputePasses(
  textures: VolumeGpuTextures,
  uniforms: GiUniforms,
  gatherWidth: number,
  gatherHeight: number,
  probeCount: number,
  raysPerProbe: number,
): GiComputePasses {
  const pixelCount = gatherWidth * gatherHeight
  const gatherR = instancedArray(pixelCount, 'vec4')
  const gatherG = instancedArray(pixelCount, 'vec4')
  const gatherB = instancedArray(pixelCount, 'vec4')
  const denoiseR = instancedArray(pixelCount, 'vec4')
  const denoiseG = instancedArray(pixelCount, 'vec4')
  const denoiseB = instancedArray(pixelCount, 'vec4')
  const historyR = instancedArray(pixelCount, 'vec4')
  const historyG = instancedArray(pixelCount, 'vec4')
  const historyB = instancedArray(pixelCount, 'vec4')
  const hitDepth = instancedArray(pixelCount, 'vec4')
  const hitNormal = instancedArray(pixelCount, 'vec4')
  const screenCache = storageTarget(gatherWidth, gatherHeight, 'gi-screen-cache', LinearFilter)

  const vr = textures.voxel.image.width as number
  const cacheGpu = new Storage3DTexture(vr, vr, vr)
  cacheGpu.name = 'gi-cache-gpu'
  cacheGpu.format = RGBAFormat
  cacheGpu.type = FloatType
  cacheGpu.minFilter = NearestFilter
  cacheGpu.magFilter = NearestFilter
  cacheGpu.generateMipmaps = false

  const hitCount = probeCount * raysPerProbe
  const hitsPos = instancedArray(hitCount, 'vec4')
  const hitsNrm = instancedArray(hitCount, 'vec4')
  const hitsAlb = instancedArray(hitCount, 'vec4')

  const probeOrigin = uniform(new Vector3())
  const cascadeCell = uniform(1)
  const cascadeRes = uniform(textures.resolution)
  const frame = uniform(0)
  const gatherSize = uniform(new Vector2(gatherWidth, gatherHeight))
  const voxelRes = float(vr)
  const maxDist = uniforms.voxelSize.mul(1.5)

  const view = {
    pos: uniform(new Vector3()),
    right: uniform(new Vector3(1, 0, 0)),
    up: uniform(new Vector3(0, 1, 0)),
    forward: uniform(new Vector3(0, 0, -1)),
    tanHalf: uniform(0.5),
    aspect: uniform(1),
    viewProjX: uniform(new Vector4(1, 0, 0, 0)),
    viewProjY: uniform(new Vector4(0, 1, 0, 0)),
    viewProjZ: uniform(new Vector4(0, 0, 1, 0)),
    viewProjW: uniform(new Vector4(0, 0, 0, 1)),
  }
  const light = {
    pos: uniform(new Vector3()),
    color: uniform(new Vector3(1, 1, 1)),
    dir: uniform(new Vector3(0, -1, 0)),
    params: uniform(new Vector4(20, 0.4, 1, 0)), // intensity, coneCos, hasCone, unused
  }

  const y00 = float(SH_Y00)
  const y1 = float(SH_Y1)
  const c0 = float(SH_A0 * SH_Y00)
  const c1 = float(SH_A1 * SH_Y1)

  const visibility = Fn(() => {
    const id = instanceIndex
    const rays = uint(raysPerProbe)
    const rayI = id.mod(rays)
    const probeI = id.div(rays)
    const res = uint(cascadeRes)
    const ix = probeI.mod(res)
    const iy = probeI.div(res).mod(res)
    const iz = probeI.div(res.mul(res))
    const origin = probeOrigin.add(
      vec3(float(ix), float(iy), float(iz)).add(0.5).mul(cascadeCell),
    )
    const i = float(rayI)
    const nRays = float(raysPerProbe)
    const fy = float(1).sub(i.div(max(nRays.sub(1), float(1))).mul(2))
    const rad = max(float(0), float(1).sub(fy.mul(fy))).sqrt()
    const phi = i.mul(GOLDEN_ANGLE).add(frame.mul(0.37))
    const dir = vec3(phi.cos().mul(rad), fy, phi.sin().mul(rad))
    const cell = uniforms.voxelSize.div(voxelRes)
    const pos = origin.toVar()
    const hit = float(0).toVar()
    const hitPos = origin.toVar()
    const hitN = vec3(0, 1, 0).toVar()
    const hitAlb = vec3(0).toVar()
    const hitDist = float(-1).toVar()
    Loop({ start: 0, end: 96, type: 'int' }, () => {
      const local = pos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize)
      If(local.x.lessThan(0).or(local.y.lessThan(0)).or(local.z.lessThan(0)), () => {
        Break()
      })
      If(local.x.greaterThanEqual(1).or(local.y.greaterThanEqual(1)).or(local.z.greaterThanEqual(1)), () => {
        Break()
      })
      const sample = texture3D(textures.voxel, clamp(local, 0.001, 0.999))
      If(sample.a.greaterThan(0.5), () => {
        hit.assign(1)
        hitPos.assign(pos)
        hitDist.assign(pos.sub(origin).length())
        hitAlb.assign(sample.rgb)
        const nrm = normalize(pos.sub(uniforms.voxelOrigin.add(local.floor().add(0.5).mul(cell))))
        hitN.assign(select(nrm.length().greaterThan(0.1), nrm, dir.negate()))
        Break()
      })
      pos.addAssign(dir.mul(cell.mul(0.45)))
    })
    hitsPos.element(id).assign(vec4(hitPos, hitDist))
    hitsNrm.element(id).assign(vec4(hitN, hit))
    hitsAlb.element(id).assign(vec4(hitAlb, hit))

    If(hit.greaterThan(0.5), () => {
      const rel = hitPos.sub(uniforms.camera)
      const extent = max(max(rel.x.abs(), rel.y.abs()), rel.z.abs()).mul(2)
      const size0 = uniforms.firstSize
      const cascade = select(
        extent.greaterThan(size0.mul(2)),
        float(2),
        select(extent.greaterThan(size0), float(1), float(0)),
      )
      const size = size0.mul(pow(float(2), cascade))
      const uvw = vec3(
        clamp(hitPos.sub(uniforms.camera.sub(vec3(size.mul(0.5)))).div(size).x, 0.001, 0.999),
        clamp(hitPos.sub(uniforms.camera.sub(vec3(size.mul(0.5)))).div(size).y, 0.001, 0.999),
        clamp(cascade.add(clamp(hitPos.sub(uniforms.camera.sub(vec3(size.mul(0.5)))).div(size).z, 0.001, 0.999)).div(uniforms.cascadeCount), 0.001, 0.999),
      )
      const l0 = texture3D(textures.l0, uvw)
      const lx = texture3D(textures.lx, uvw)
      const ly = texture3D(textures.ly, uvw)
      const lz = texture3D(textures.lz, uvw)
      const irr = l0.xyz
        .mul(c0)
        .add(lx.xyz.mul(hitN.x).add(ly.xyz.mul(hitN.y)).add(lz.xyz.mul(hitN.z)).mul(c1))
        .max(0)
      const toL = light.pos.sub(hitPos)
      const distL = max(toL.length(), float(0.05))
      const ldir = toL.div(distL)
      const ndotl = max(hitN.dot(ldir), float(0))
      const toward = ldir.negate().dot(light.dir)
      const inCone = select(
        light.params.z.greaterThan(0.5),
        select(toward.greaterThanEqual(light.params.y), float(1), float(0)),
        float(1),
      )
      const atten = light.params.x.div(float(1).add(distL.mul(distL))).mul(ndotl).mul(inCone)
      const direct = hitAlb.mul(light.color).mul(atten).mul(float(INV_PI))
      const rgb = direct.add(hitAlb.mul(irr).mul(float(INV_PI)))
      const vx = int(clamp(hitPos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize).x.mul(voxelRes), 0, voxelRes.sub(1)))
      const vy = int(clamp(hitPos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize).y.mul(voxelRes), 0, voxelRes.sub(1)))
      const vz = int(clamp(hitPos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize).z.mul(voxelRes), 0, voxelRes.sub(1)))
      textureStore(cacheGpu, ivec3(vx, vy, vz), vec4(rgb, 1))
    })
  })().compute(hitCount)

  const gather = Fn(() => {
    const x = int(instanceIndex.mod(uint(gatherWidth)))
    const y = int(instanceIndex.div(uint(gatherWidth)))
    const ndcX = float(x).add(0.5).div(gatherSize.x).mul(2).sub(1)
    const ndcY = float(1).sub(float(y).add(0.5).div(gatherSize.y).mul(2))
    const dir = normalize(
      view.forward.add(view.right.mul(ndcX.mul(view.tanHalf).mul(view.aspect))).add(
        view.up.mul(ndcY.mul(view.tanHalf)),
      ),
    )
    const cell = uniforms.voxelSize.div(voxelRes)
    const pos = view.pos.toVar()
    const primaryHit = float(0).toVar()
    const pPos = view.pos.toVar()
    const pN = vec3(0, 1, 0).toVar()
    const pDist = float(0).toVar()
    Loop({ start: 0, end: 128, type: 'int' }, () => {
      const local = pos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize)
      If(local.x.lessThan(0).or(local.y.lessThan(0)).or(local.z.lessThan(0)), () => {
        Break()
      })
      If(local.x.greaterThanEqual(1).or(local.y.greaterThanEqual(1)).or(local.z.greaterThanEqual(1)), () => {
        Break()
      })
      const sample = texture3D(textures.voxel, clamp(local, 0.001, 0.999))
      If(sample.a.greaterThan(0.5), () => {
        primaryHit.assign(1)
        pPos.assign(pos)
        pDist.assign(pos.sub(view.pos).length())
        const nrm = normalize(view.pos.sub(pos)).negate()
        pN.assign(select(nrm.dot(dir.negate()).greaterThan(0), nrm, dir.negate()))
        Break()
      })
      pos.addAssign(dir.mul(cell.mul(0.45)))
    })

    const u = fract(float(x).mul(0.06711056).add(float(y).mul(0.00583715)))
    const v = fract(float(x).mul(0.00583715).add(float(y).mul(0.06711056)))
    const r = u.sqrt()
    const phi = v.mul(6.2831853)
    const up = select(abs(pN.y).lessThan(0.999), vec3(0, 1, 0), vec3(1, 0, 0))
    const tangent = normalize(cross(up, pN))
    const bitangent = cross(pN, tangent)
    const gdir = normalize(
      tangent.mul(r.mul(phi.cos())).add(bitangent.mul(r.mul(phi.sin()))).add(pN.mul(max(float(0), float(1).sub(u)).sqrt())),
    )
    const gpos = pPos.add(pN.mul(cell.mul(0.6))).toVar()
    const gHit = float(0).toVar()
    const gHitPos = gpos.toVar()
    const gHitN = gdir.negate().toVar()
    Loop({ start: 0, end: 64, type: 'int' }, () => {
      If(primaryHit.lessThan(0.5), () => {
        Break()
      })
      const local = gpos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize)
      If(local.x.lessThan(0).or(local.y.lessThan(0)).or(local.z.lessThan(0)), () => {
        Break()
      })
      If(local.x.greaterThanEqual(1).or(local.y.greaterThanEqual(1)).or(local.z.greaterThanEqual(1)), () => {
        Break()
      })
      const sample = texture3D(textures.voxel, clamp(local, 0.001, 0.999))
      If(sample.a.greaterThan(0.5), () => {
        gHit.assign(1)
        gHitPos.assign(gpos)
        gHitN.assign(gdir.negate())
        Break()
      })
      gpos.addAssign(gdir.mul(cell.mul(0.45)))
    })

    const radiance = vec3(0).toVar()
    const used = float(0).toVar()
    // Fallback 1: screen-space cache (previous frame, unoccluded).
    If(gHit.greaterThan(0.5).and(primaryHit.greaterThan(0.5)), () => {
      const hp = vec4(gHitPos, 1)
      const clip = vec4(
        view.viewProjX.dot(hp),
        view.viewProjY.dot(hp),
        view.viewProjZ.dot(hp),
        view.viewProjW.dot(hp),
      )
      const w = max(clip.w, float(1e-4))
      const ndc = clip.xyz.div(w)
      const suv = vec2(ndc.x.mul(0.5).add(0.5), float(1).sub(ndc.y.mul(0.5).add(0.5)))
      If(
        suv.x.greaterThan(0).and(suv.x.lessThan(1)).and(suv.y.greaterThan(0)).and(suv.y.lessThan(1)).and(
          ndc.z.greaterThan(0),
        ).and(ndc.z.lessThan(1)),
        () => {
          const screen = texture(screenCache, suv)
          If(abs(screen.a.sub(ndc.z)).lessThan(0.04).and(screen.a.greaterThan(0)), () => {
            radiance.assign(screen.rgb)
            used.assign(1)
          })
        },
      )
    })
    // Fallback 2: world radiance cache (hashed cache splatted to 3D).
    If(used.lessThan(0.5).and(gHit.greaterThan(0.5)), () => {
      const uvw = clamp(gHitPos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize), 0.001, 0.999)
      const cached = texture3D(textures.radianceCache, uvw)
      If(cached.a.greaterThan(0.5), () => {
        radiance.assign(cached.rgb)
        used.assign(1)
      })
    })
    // Fallback 3: irradiance volumes.
    If(used.lessThan(0.5).and(primaryHit.greaterThan(0.5)), () => {
      const samplePos = select(gHit.greaterThan(0.5), gHitPos, pPos.add(gdir.mul(maxDist)))
      const rel = samplePos.sub(uniforms.camera)
      const extent = max(max(rel.x.abs(), rel.y.abs()), rel.z.abs()).mul(2)
      const size0 = uniforms.firstSize
      const cascade = select(
        extent.greaterThan(size0.mul(2)),
        float(2),
        select(extent.greaterThan(size0), float(1), float(0)),
      )
      const size = size0.mul(pow(float(2), cascade))
      const local = samplePos.sub(uniforms.camera.sub(vec3(size.mul(0.5)))).div(size)
      const uvw = vec3(
        clamp(local.x, 0.001, 0.999),
        clamp(local.y, 0.001, 0.999),
        clamp(cascade.add(clamp(local.z, 0.001, 0.999)).div(uniforms.cascadeCount), 0.001, 0.999),
      )
      const l0 = texture3D(textures.l0, uvw)
      const lx = texture3D(textures.lx, uvw)
      const ly = texture3D(textures.ly, uvw)
      const lz = texture3D(textures.lz, uvw)
      const nEval = select(gHit.greaterThan(0.5), gHitN, gdir.negate())
      radiance.assign(
        l0.xyz
          .mul(c0)
          .add(lx.xyz.mul(nEval.x).add(ly.xyz.mul(nEval.y)).add(lz.xyz.mul(nEval.z)).mul(c1))
          .max(0),
      )
      used.assign(1)
    })

    const weight = primaryHit.mul(used)
    const l0r = radiance.mul(y00)
    const lxr = radiance.mul(y1.mul(pN.x))
    const lyr = radiance.mul(y1.mul(pN.y))
    const lzr = radiance.mul(y1.mul(pN.z))
    const pix = uint(y.mul(int(gatherWidth)).add(x))
    gatherR.element(pix).assign(vec4(l0r.x, lxr.x, lyr.x, lzr.x).mul(weight))
    gatherG.element(pix).assign(vec4(l0r.y, lxr.y, lyr.y, lzr.y).mul(weight))
    gatherB.element(pix).assign(vec4(l0r.z, lxr.z, lyr.z, lzr.z).mul(weight))
    hitDepth.element(pix).assign(vec4(pDist, primaryHit, 0, 0))
    hitNormal.element(pix).assign(vec4(pN, primaryHit))
  })().compute(gatherWidth * gatherHeight)

  const denoise = Fn(() => {
    const x = int(instanceIndex.mod(uint(gatherWidth)))
    const y = int(instanceIndex.div(uint(gatherWidth)))
    const pix0 = uint(y.mul(int(gatherWidth)).add(x))
    const depth0 = hitDepth.element(pix0)
    const n0 = hitNormal.element(pix0)
    const accR = vec4(0).toVar()
    const accG = vec4(0).toVar()
    const accB = vec4(0).toVar()
    const wsum = float(0).toVar()
    Loop({ start: -2, end: 2, type: 'int', condition: '<=' }, ({ i }: { i: ShaderValue }) => {
      Loop({ start: -2, end: 2, type: 'int', condition: '<=' }, ({ i: j }: { i: ShaderValue }) => {
        const sx = clamp(x.add(i), int(0), int(gatherWidth - 1))
        const sy = clamp(y.add(j), int(0), int(gatherHeight - 1))
        const spix = uint(sy.mul(int(gatherWidth)).add(sx))
        const depth = hitDepth.element(spix)
        const nrm = hitNormal.element(spix)
        const dz = depth.x.sub(depth0.x)
        const nd = max(n0.xyz.dot(nrm.xyz), float(0))
        const w = float(1)
          .div(float(1).add(float(i).mul(i).add(float(j).mul(j))))
          .mul(depth.y)
          .mul(nd)
          .mul(float(1).div(float(1).add(dz.mul(dz).mul(40))))
        accR.addAssign(gatherR.element(spix).mul(w))
        accG.addAssign(gatherG.element(spix).mul(w))
        accB.addAssign(gatherB.element(spix).mul(w))
        wsum.addAssign(w)
      })
    })
    const inv = float(1).div(max(wsum, float(1e-4)))
    const curR = accR.mul(inv)
    const curG = accG.mul(inv)
    const curB = accB.mul(inv)
    const histR = historyR.element(pix0)
    const histG = historyG.element(pix0)
    const histB = historyB.element(pix0)
    const alpha = select(histR.w.greaterThan(0.5), float(0.18), float(1))
    const outR = mix(histR, vec4(curR.xyz, 1), alpha)
    const outG = mix(histG, vec4(curG.xyz, 1), alpha)
    const outB = mix(histB, vec4(curB.xyz, 1), alpha)
    historyR.element(pix0).assign(outR)
    historyG.element(pix0).assign(outG)
    historyB.element(pix0).assign(outB)
    denoiseR.element(pix0).assign(outR)
    denoiseG.element(pix0).assign(outG)
    denoiseB.element(pix0).assign(outB)
  })().compute(gatherWidth * gatherHeight)

  const cacheScreen = Fn(() => {
    const x = int(instanceIndex.mod(uint(gatherWidth)))
    const y = int(instanceIndex.div(uint(gatherWidth)))
    const pix = uint(y.mul(int(gatherWidth)).add(x))
    const shR = denoiseR.element(pix)
    const shG = denoiseG.element(pix)
    const shB = denoiseB.element(pix)
    const depth = hitDepth.element(pix)
    const nrm = hitNormal.element(pix)
    const irr = vec3(shR.x, shG.x, shB.x)
      .mul(c0)
      .add(
        vec3(shR.y, shG.y, shB.y)
          .mul(nrm.x)
          .add(vec3(shR.z, shG.z, shB.z).mul(nrm.y))
          .add(vec3(shR.w, shG.w, shB.w).mul(nrm.z))
          .mul(c1),
      )
      .max(0)
    const hp = vec4(view.pos.add(view.forward.mul(depth.x)), 1)
    const clip = vec4(
      view.viewProjX.dot(hp),
      view.viewProjY.dot(hp),
      view.viewProjZ.dot(hp),
      view.viewProjW.dot(hp),
    )
    const ndcZ = clip.z.div(max(clip.w, float(1e-4)))
    textureStore(screenCache, ivec2(x, y), vec4(irr, select(depth.y.greaterThan(0.5), ndcZ, float(0))))
  })().compute(gatherWidth * gatherHeight)

  return {
    visibility,
    gather,
    denoise,
    cacheScreen,
    hitCount,
    gatherWidth,
    gatherHeight,
    gatherSize: new Vector2(gatherWidth, gatherHeight),
    denoiseR,
    denoiseG,
    denoiseB,
    hitsPos,
    probeOrigin,
    cascadeCell,
    cascadeRes,
    frame,
    view,
    light,
  }
}
