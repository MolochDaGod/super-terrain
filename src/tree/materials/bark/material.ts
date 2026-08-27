import { MeshStandardNodeMaterial, Vector2 } from 'three/webgpu'
import {
  abs,
  clamp,
  float,
  mix,
  mx_fractal_noise_float,
  normalWorld,
  positionWorld,
  pow,
  sign,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vertexColor,
} from 'three/tsl'
import type { ProceduralTreeTextures } from '../proceduralTreeTextures'

const BARK_TILE_WIDTH_METRES = 1.6
const BARK_TILE_HEIGHT_METRES = 3.2

/**
 * Ambient irradiance floor, as a fraction of the bark's own albedo.
 *
 * The editor has direct and hemispheric light but no bounced diffuse GI, so a
 * horizontal limb's underside falls to literal black without a stand-in. The
 * previous floor was a third of albedo everywhere, which is not a bounce term
 * at all — it is a self-lit surface, and it is most of why trunks came out as
 * pale ceramic tubes that no amount of grading could put back into shadow. A
 * tenth reads as bounce; a third reads as plastic.
 */
const BARK_BOUNCE_FLOOR = 0.13
const BARK_UNDERSIDE_BOUNCE = 0.2

/**
 * Ground-level moss and lichen.
 *
 * The single most recognisable thing about a wet temperate forest floor is
 * that the bottom two metres of every trunk, and every root flare and fallen
 * limb, is green. It is not a texture detail: it is a wide tonal band that
 * anchors the trunks to the ground, and without it the boles read as poles
 * dropped onto a surface rather than as trees growing out of it. Height and
 * upward-facing bias drive it, with a fractal breakup so no two trunks carry
 * the same pattern and no colonised edge is a clean line.
 */
const MOSS_COLOUR = vec3(0.042, 0.082, 0.028)
const MOSS_HIGHLIGHT = vec3(0.115, 0.175, 0.045)
/**
 * Metres above the root collar the colony survives to.
 *
 * Short on purpose. A colony that reaches head height leaves no bare bark in
 * an eye-level frame, and a trunk green from root to crown reads as painted,
 * not as colonised — the contrast between a green base and grey bark above it
 * is the whole effect.
 */
const MOSS_REACH = 1.9


/** 0 where bark is bare, 1 where the colony is closed. See `MOSS_COLOUR`. */
function mossMask(amount: any): any {
  const height = positionWorld.y
  // Damp ground is the supply. The band is tall enough to reach the first
  // branch collars on a young stem and to cover a veteran's whole buttress.
  const wetness = smoothstep(MOSS_REACH, 0.1, height)
  // Moss wants the top of a limb and the shaded north side, not the face the
  // sun dries out. Upward bias alone is enough to read as growth rather than
  // as paint.
  const upward = normalWorld.y.mul(0.5).add(0.5)
  // Strongly top-weighted. Moss on the underside of a fallen bole is the tell
  // that the colony was painted on rather than grown, and the difference
  // between a lit mossy top and a bare shaded flank is most of the form.
  const aspect = mix(float(0.22), float(1.25), upward.mul(upward))
  // Two octaves at trunk scale: colonies, then their ragged edges.
  const patch = mx_fractal_noise_float(positionWorld.mul(0.42), 3)
    .mul(0.5)
    .add(0.5)
  const colony = smoothstep(0.34, 0.78, patch)
  return clamp(wetness.mul(aspect).mul(colony).mul(amount), 0, 1)
}

/** Applies the colony to an albedo, keeping its own light and dark variation. */
function mossedAlbedo(albedo: any, mask: any): any {
  // The colony is not one flat green: the fractal that placed it also shades
  // it, so the mat keeps the depth a single colour would lose.
  const shade = mx_fractal_noise_float(positionWorld.mul(2.4), 2).mul(0.5).add(0.5)
  const moss = mix(MOSS_COLOUR, MOSS_HIGHLIGHT, shade)
  return mix(albedo, moss, mask)
}

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
    // Palms and the arid sculptural barks keep the axial projection, and none
    // of them is a mossy species; the colony is a temperate-forest feature.
    material.colorNode = albedo.rgb.mul(vertexColor())
    const undersideBounce = normalWorld.y.negate().clamp().mul(0.12).add(0.06)
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
  // A uniform rather than a constant: the amount is per-species, and folding
  // it into the shader as a literal would compile one more pipeline variant
  // per value and miss the pre-warm that exists to keep them off the frame.
  const moss = uniform(textures.barkMossiness ?? 0)
  const mask = mossMask(moss)
  const mossed = mossedAlbedo(albedo.rgb.mul(vertexColor()), mask)

  material.colorNode = mossed
  // The editor has directional and hemispheric light but no bounced diffuse
  // GI. Deep horizontal oak limbs therefore fell to literal black on their
  // undersides, making every collar look like an open pipe. A small albedo-
  // coloured irradiance floor stands in for sky/ground bounce without washing
  // out direct-light relief or turning the bark into an emissive surface.
  const undersideBounce = normalWorld.y.negate().clamp()
    .mul(BARK_UNDERSIDE_BOUNCE)
    .add(BARK_BOUNCE_FLOOR)
  material.emissiveNode = mossed.mul(undersideBounce)
  // Moss is a matte mat over whatever the bark was doing, and it holds water.
  material.roughnessNode = mix(surface.g, float(0.97), mask)
  material.aoNode = mix(float(1), surface.r, float(0.45))
  return material
}
