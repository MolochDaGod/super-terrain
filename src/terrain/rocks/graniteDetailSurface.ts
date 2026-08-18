import {
  abs,
  cameraViewMatrix,
  float,
  max as tslMax,
  normalWorld,
  normalize as tslNormalize,
  positionWorld,
  pow,
  sign,
  sqrt,
  texture,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { GraniteDetailTextures } from './graniteRockResources'

const DETAIL_TILE_METRES = 0.256

export interface GraniteDetailNodes {
  viewNormalOffset: Node<'vec3'>
  height: Node<'float'>
  ambientOcclusion: Node<'float'>
  albedo: Node<'float'>
  roughness: Node<'float'>
}

function unpackNormal(sample: ReturnType<typeof texture>): Node<'vec3'> {
  const xy = sample.xy.mul(2).sub(1)
  const z = sqrt(tslMax(0, float(1).sub(xy.x.mul(xy.x)).sub(xy.y.mul(xy.y))))
  return vec3(xy.x, xy.y, z)
}

/** Exact physical-scale triplanar detail projection used by scifi-kit. */
export function graniteDetailSurface(
  textures: GraniteDetailTextures,
  options: { strength?: number; tileMetres?: number } = {},
): GraniteDetailNodes {
  const strength = options.strength ?? 1
  const tile = options.tileMetres ?? DETAIL_TILE_METRES
  const frequency = 1 / tile
  const worldNormal = normalWorld
  const axisWeight = pow(abs(worldNormal), 5)
  const weightSum = axisWeight.x.add(axisWeight.y).add(axisWeight.z)
  const blend = axisWeight.div(weightSum)
  const axisSign = sign(worldNormal)

  const p = positionWorld.mul(frequency)
  const uvX = vec2(p.z.mul(axisSign.x), p.y)
  const uvY = vec2(p.x, p.z.mul(axisSign.y))
  const uvZ = vec2(p.x.mul(axisSign.z.negate()), p.y)
  const sampleX = texture(textures.normalHeightAo, uvX)
  const sampleY = texture(textures.normalHeightAo, uvY)
  const sampleZ = texture(textures.normalHeightAo, uvZ)
  const normalX = unpackNormal(sampleX)
  const normalY = unpackNormal(sampleY)
  const normalZ = unpackNormal(sampleZ)
  const worldX = vec3(
    normalX.z.mul(axisSign.x),
    normalX.y.add(worldNormal.y),
    normalX.x.add(worldNormal.z),
  )
  const worldY = vec3(
    normalY.x.add(worldNormal.x),
    normalY.z.mul(axisSign.y),
    normalY.y.add(worldNormal.z),
  )
  const worldZ = vec3(
    normalZ.x.add(worldNormal.x),
    normalZ.y.add(worldNormal.y),
    normalZ.z.mul(axisSign.z),
  )
  const combinedNormal = worldX.mul(blend.x)
    .add(worldY.mul(blend.y))
    .add(worldZ.mul(blend.z))
  const combinedHeight = sampleX.b.mul(blend.x)
    .add(sampleY.b.mul(blend.y))
    .add(sampleZ.b.mul(blend.z))
  const combinedAo = sampleX.a.mul(blend.x)
    .add(sampleY.a.mul(blend.y))
    .add(sampleZ.a.mul(blend.z))
  const detailNormal = tslNormalize(combinedNormal)
  const worldOffset = detailNormal.sub(worldNormal).mul(strength)
  const viewNormalOffset = cameraViewMatrix.mul(vec4(worldOffset, 0)).xyz
  const height = combinedHeight.mul(2).sub(1)
  const albedo = combinedHeight.mul(0.62).add(combinedAo.mul(0.38))
  const roughness = combinedAo.mul(-0.28).add(combinedHeight.mul(-0.12)).add(0.7)

  return {
    viewNormalOffset,
    height,
    ambientOcclusion: combinedAo,
    albedo,
    roughness,
  }
}
