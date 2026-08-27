import { MeshStandardNodeMaterial, Vector2 } from 'three/webgpu'
import {
  abs,
  cameraViewMatrix,
  clamp,
  float,
  mix,
  normalize,
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
  vec4,
  vertexColor,
} from 'three/tsl'
import type { ProceduralTreeTextures } from '../proceduralTreeTextures'

/**
 * World size of one bark tile.
 *
 * Was 1.6 x 3.2m. At the 1024x2048 the forest tier bakes, that is 1.6mm per
 * texel, and a texel that big cannot hold a cork granule or a lenticel — seen
 * from arm's length the surface reads as a soft blur with no scale reference
 * in it at all. Tightening the tile spends the same texels over less world and
 * puts the fine structure back at roughly 1mm.
 *
 * The cost is repetition: a smaller tile repeats more often across a wide
 * bole. The projection is triplanar and the content is mottled rather than
 * patterned, which is what makes that affordable — a fissured bark with strong
 * directional features would show the seam sooner.
 */
const BARK_TILE_WIDTH_METRES = 1.0
const BARK_TILE_HEIGHT_METRES = 2.0

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
// How far up a bole the colony can reach, in metres.
//
// 1.9 was sized from a stem standing in ordinary woodland. The reference is a
// wet old-growth interior, where the moss is not a skirt round the base but
// the dominant surface: it runs up the buttresses, over the root collars and
// several metres up the trunks, and it is most of what separates that forest
// from a dry one.
const MOSS_REACH = 3.4


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
  // A wider band than before: at 0.34..0.78 the colonies were small islands
  // with a lot of bare bark between them, which is a dry stand.
  const colony = smoothstep(0.22, 0.66, patch)
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
 * One triplanar plane's contribution to the world-space bark normal.
 *
 * `swizzle` maps a tangent-space normal into world space for that plane's UV
 * convention; the sign flips follow the same ones the UVs use, so the relief
 * does not invert on the far side of a trunk.
 */
function triplanarAxisNormal(
  sample: any,
  scale: number,
  swizzle: (tangent: any, axisSign: any) => any,
  axisSign: any,
): any {
  const tangent = sample.xyz.mul(2).sub(1)
  // Scaling only the lateral components is the standard way to control normal
  // strength: it tilts the normal without ever letting it point backwards.
  const shaped = vec3(tangent.x.mul(scale), tangent.y.mul(scale), tangent.z)
  return swizzle(shaped, axisSign)
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

  // Relief on the same projection as the colour.
  //
  // `normalMap` as a material property is sampled with the *mesh* UVs, while
  // everything else here is sampled in world space. That mismatch is why the
  // bark had no depth in it: the bake goes to real trouble to make albedo,
  // occlusion and relief describe one surface, and then the runtime sampled
  // the relief through a different parameterisation, at a different scale,
  // aligned to the branch axis instead of to the world. What survived was not
  // weak relief, it was relief that did not correspond to any feature you
  // could see, which reads as vague lumpiness at best and as nothing at all in
  // most lighting. Raising `normalScale` cannot fix that and did not.
  //
  // Each plane's tangent-space normal is rotated into world space by the same
  // swizzle its UVs imply, then the three are blended on the same weights as
  // the colour. A flat normal comes back as the geometric normal, so the term
  // is well-behaved where the map has nothing to say.
  const normalX = triplanarAxisNormal(
    texture(textures.barkNormalMap, uvX), textures.barkNormalScale,
    (t, sx) => vec3(t.z.mul(sx), t.y, t.x.mul(sx)), axisSign.x,
  )
  const normalY = triplanarAxisNormal(
    texture(textures.barkNormalMap, uvY), textures.barkNormalScale,
    (t, sy) => vec3(t.x, t.z.mul(sy), t.y.mul(sy)), axisSign.y,
  )
  const normalZ = triplanarAxisNormal(
    texture(textures.barkNormalMap, uvZ), textures.barkNormalScale,
    (t, sz) => vec3(t.x.mul(sz.negate()), t.y, t.z.mul(sz)), axisSign.z,
  )
  // Perturb the real normal; do not rebuild it.
  //
  // Blending the three planes' normals directly gives the geometric normal
  // back only where the surface faces an axis. The blend weights are
  // `pow(abs(n), 5)`, which is deliberately sharp so the colour does not
  // smear across the seams — and that sharpness makes the reconstructed
  // normal snap to the nearest axis everywhere else. On a trunk that erases
  // the cylindrical shading gradient and renders the bole as a flat slab.
  //
  // So take what the *flat* map would have blended to, subtract it, and add
  // only the difference to the true normal. Detail with no shape of its own.
  const flatBlend = normalize(vec3(
    axisSign.x.mul(blend.x), axisSign.y.mul(blend.y), axisSign.z.mul(blend.z),
  ) as any)
  const detail = normalize(
    normalX.mul(blend.x).add(normalY.mul(blend.y)).add(normalZ.mul(blend.z)) as any,
  )
  const reliefWorld = normalize(
    normalWorld.add((detail as any).sub(flatBlend)) as any,
  )

  const material = new MeshStandardNodeMaterial({
    name: 'world-space procedural bark pbr',
    roughness: 1,
    metalness: 0,
  })
  const reliefView = (cameraViewMatrix as any).mul(vec4(reliefWorld as any, 0)).xyz
  material.normalNode = normalize(reliefView as any) as any
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
