import { MeshStandardNodeMaterial, Vector2 } from 'three/webgpu'
import {
  abs,
  float,
  mix,
  normalWorld,
  positionWorld,
  pow,
  sign,
  texture,
  vec2,
  vertexColor,
} from 'three/tsl'
import type { ProceduralTreeTextures } from '../proceduralTreeTextures'

const BARK_TILE_WIDTH_METRES = 1.6
const BARK_TILE_HEIGHT_METRES = 3.2

/**
 * Runtime bark material with world-space colour and surface projection.
 *
 * The mesh UVs still align the subtle tangent normal with each branch axis,
 * but albedo, roughness and AO are projected continuously in world space. That
 * removes colour stretching at swollen forks and prevents adjacent intersecting
 * members from advertising different texture phases. The atlas has a 1:2
 * physical aspect, so this uses explicit planar UVs rather than Three's
 * equal-axis triplanar helper.
 */
export function createBarkMaterial(
  textures: ProceduralTreeTextures,
): MeshStandardNodeMaterial {
  if (textures.barkProjection === 'axial-uv') {
    const albedo = texture(textures.barkMap)
    const surface = texture(textures.barkRoughnessMap)
    const material = new MeshStandardNodeMaterial({
      name: 'axial procedural bark pbr',
      normalMap: textures.barkNormalMap,
      normalScale: new Vector2(textures.barkNormalScale, textures.barkNormalScale),
      roughness: 1,
      metalness: 0,
    })
    material.colorNode = albedo.rgb.mul(vertexColor())
    const undersideBounce = normalWorld.y.negate().clamp().mul(0.12).add(0.08)
    material.emissiveNode = albedo.rgb.mul(vertexColor()).mul(undersideBounce)
    material.roughnessNode = surface.g
    material.aoNode = mix(float(1), surface.r, float(0.45))
    return material
  }
  const worldNormal = normalWorld
  const axisWeight = pow(abs(worldNormal), 5)
  const blend = axisWeight.div(axisWeight.x.add(axisWeight.y).add(axisWeight.z))
  const axisSign = sign(worldNormal)
  const p = positionWorld

  const uvX = vec2(
    p.z.mul(axisSign.x).div(BARK_TILE_WIDTH_METRES),
    p.y.div(BARK_TILE_HEIGHT_METRES),
  )
  const uvY = vec2(
    p.x.div(BARK_TILE_WIDTH_METRES),
    p.z.mul(axisSign.y).div(BARK_TILE_WIDTH_METRES),
  )
  const uvZ = vec2(
    p.x.mul(axisSign.z.negate()).div(BARK_TILE_WIDTH_METRES),
    p.y.div(BARK_TILE_HEIGHT_METRES),
  )

  const albedoX = texture(textures.barkMap, uvX)
  const albedoY = texture(textures.barkMap, uvY)
  const albedoZ = texture(textures.barkMap, uvZ)
  const albedo = albedoX.mul(blend.x)
    .add(albedoY.mul(blend.y))
    .add(albedoZ.mul(blend.z))

  const surfaceX = texture(textures.barkRoughnessMap, uvX)
  const surfaceY = texture(textures.barkRoughnessMap, uvY)
  const surfaceZ = texture(textures.barkRoughnessMap, uvZ)
  const surface = surfaceX.mul(blend.x)
    .add(surfaceY.mul(blend.y))
    .add(surfaceZ.mul(blend.z))

  const material = new MeshStandardNodeMaterial({
    name: 'world-space procedural bark pbr',
    normalMap: textures.barkNormalMap,
    normalScale: new Vector2(textures.barkNormalScale, textures.barkNormalScale),
    roughness: 1,
    metalness: 0,
  })
  material.colorNode = albedo.rgb.mul(vertexColor())
  // The editor has directional and hemispheric light but no bounced diffuse
  // GI. Deep horizontal oak limbs therefore fell to literal black on their
  // undersides, making every collar look like an open pipe. A small albedo-
  // coloured irradiance floor stands in for sky/ground bounce without washing
  // out direct-light relief or turning the bark into an emissive surface.
  const undersideBounce = normalWorld.y.negate().clamp().mul(0.28).add(0.34)
  material.emissiveNode = albedo.rgb.mul(vertexColor()).mul(undersideBounce)
  material.roughnessNode = surface.g
  material.aoNode = mix(float(1), surface.r, float(0.45))
  return material
}
