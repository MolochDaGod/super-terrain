import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  cameraPosition,
  clamp,
  dot,
  float,
  mix,
  normalGeometry,
  normalLocal,
  normalWorld,
  normalize,
  positionWorld,
  smoothstep,
  texture,
  vec3,
} from 'three/tsl'
import { getProceduralSurfaceTextures } from '../rendering/textures/proceduralSurfaceTextures'

/**
 * The material the scattered rocks are shaded with.
 *
 * It samples the same `cliff-side` bake the terrain does, at the same physical
 * width, through the same triplanar projection — and that is the whole point of
 * it rather than an implementation detail. A boulder lying on a slope is a
 * piece of that slope which came off it; if the two are shaded by different
 * textures at different scales, the boulder reads as an object placed on the
 * terrain no matter how good either surface is on its own. Sharing the bake
 * means the grain runs at one size across the join, the two weather to the same
 * colour, and the only thing separating the rock from the ground it sits on is
 * its silhouette — which is exactly what should separate them.
 *
 * Sharing it also costs nothing. `getProceduralSurfaceTextures` hands back the
 * same three `Texture` objects the terrain material already holds, so this adds
 * three sampler bindings to a *different* shader stage rather than three more
 * to the terrain's, which has none to spare.
 */

/**
 * Metres spanned by one tile.
 *
 * The bake's own authored width — the terrain's *fine* octave, not its coarse
 * one. Matching the coarse octave is the obvious choice and it is wrong for a
 * reason that only shows up on small objects: that tile spans eleven metres,
 * and a thirty-centimetre clast covers under three per cent of it. Every rock
 * in the field then samples an almost constant patch of the texture and comes
 * out as a flat-shaded lump, which is exactly what the geometry was added to
 * stop being.
 *
 * At the authored width a half-metre cobble spans a quarter of a tile and a
 * two-metre block spans more than one, so both carry real joint and grain
 * structure. Coherence with the ground is kept either way, because the terrain
 * samples this same bake at this same width in its own fine octave.
 */
const ROCK_TILE_FACTOR = 1

export interface ScatterRockMaterialHandle {
  material: MeshStandardNodeMaterial
  /** Resolves once the shared bake has replaced its flat placeholder. */
  ready: Promise<void>
  dispose(): void
}

export function createScatterRockMaterial(): ScatterRockMaterialHandle {
  const surface = getProceduralSurfaceTextures('cliff-side')
  const tile = surface.physicalWidth * ROCK_TILE_FACTOR
  const material = new MeshStandardNodeMaterial({ metalness: 0 })

  const worldNormal = normalize(normalWorld).toVar('rockWorldNormal')
  const position = positionWorld

  // Triplanar in world space, like the terrain's. Projecting in the rock's own
  // local space would be cheaper and is wrong: every instance of one baked mesh
  // would then carry an identical texture, and a hillside of the same four
  // meshes would advertise itself immediately. Projected in world space, two
  // instances of the same mesh a metre apart are shaded by different stone.
  let weights = worldNormal.abs()
  weights = weights.mul(weights)
  weights = weights.mul(weights)
  weights = weights.div(weights.dot(vec3(1)))
  const scale = float(1 / tile)
  // Unsigned projections, deliberately.
  //
  // The textbook triplanar mirrors each plane by the sign of the normal's
  // component on that axis, so the texture keeps its handedness on both sides
  // of the object. That is right for a normal map and catastrophic here. The
  // sign is a step function of the surface normal, and on a faceted rock the
  // normal flips between adjacent facets and inside the two-by-two quad the
  // GPU differentiates over. The UV then jumps by half a world across a pixel,
  // the implicit derivative comes out enormous, and the sampler answers with
  // the coarsest mip in the chain — a one-by-one average of the whole bake.
  //
  // The symptom is not a seam or a stretch. Every rock in the field comes out
  // a flat, uniform tan, which reads as "the texture never arrived" rather
  // than as a filtering fault, and no amount of adjusting the tile size or the
  // grading moves it. Dropping the mirror costs a handedness flip on the far
  // side of each axis, which is invisible on a diffuse stone texture and is
  // the reason the mirror was only ever there for the normal map.
  const uvX = position.yz.mul(scale)
  const uvY = position.zx.mul(scale)
  const uvZ = position.xy.mul(scale)

  const sample = (source: typeof surface.albedo, bias: number) =>
    texture(source, uvX).bias(float(bias)).mul(weights.x)
      .add(texture(source, uvY).bias(float(bias)).mul(weights.y))
      .add(texture(source, uvZ).bias(float(bias)).mul(weights.z))

  const diffuse = sample(surface.albedo, -0.08).toVar('rockScanDiffuse')
  const arm = sample(surface.arm, -0.04).toVar('rockScanArm')

  // The same grading the terrain applies to this bake, so the two agree in
  // hue and value as well as in grain. Kept deliberately short of the
  // terrain's full chain: the terrain's version also folds in baked coverage
  // and climate fields that a loose rock has no equivalent of.
  const luminance = dot(diffuse.rgb, vec3(0.2126, 0.7152, 0.0722))
  const graded = mix(diffuse.rgb, vec3(luminance), float(0.82))
    .mul(vec3(1.38, 1.42, 1.48))
    .add(vec3(0.014, 0.017, 0.022))
    .sub(vec3(0.14))
    .mul(1.18)
    .add(vec3(0.14))
    .clamp(0, 0.52)

  // The graded scan is not the terrain's rock colour — it is one term in it.
  // The terrain mixes it into a dark mineral base at 52 per cent and the base
  // is what sets the value; taking the scan neat, which is what this did
  // first, puts a boulder roughly forty per cent brighter than the slope it
  // broke off and turns a scree field into a scatter of pale pebbles sitting
  // on dark ground.
  //
  // `regionalTint` and `aridity` are baked terrain vertex attributes and a
  // loose rock has neither, so the base is that mix evaluated at the middle of
  // its range. A rock does not need to track the region it is in — over the
  // seventy metres this field covers there is only one — it needs to be the
  // same colour as the ground beside it, which this is.
  const mineralBase = vec3(0.14, 0.152, 0.16)
  const stone = mix(mineralBase, graded, float(0.52)).toVar('rockStone')

  // A rock that broke off recently exposes clean mineral; one that has lain
  // there through a few winters carries lichen on the side that stays damp and
  // is bleached on the side the sun reaches. `normalLocal.y` is the rock's own
  // up, which is stable per instance, so this varies between rocks rather than
  // smearing a single gradient across the whole field.
  const upward = clamp(dot(worldNormal, vec3(0, 1, 0)), 0, 1)
  const weathered = stone
    .mul(mix(float(0.86), float(1.08), upward))
    .mul(
      // Dust and fines collect on the upward faces of a rock lying in scree.
      mix(vec3(1, 1, 1), vec3(1.06, 1.02, 0.94), smoothstep(0.55, 0.95, upward)),
    )
  const lichen = smoothstep(0.25, 0.75, normalLocal.y.mul(0.5).add(0.5))
    .mul(smoothstep(0.3, 0.8, upward))
    .mul(0.22)
  const albedo = mix(weathered, vec3(0.058, 0.072, 0.042), lichen)

  // The base of a rock is buried, and the ground it is bedded into occludes
  // it. Without this the rock reads as resting on the surface however far it
  // is actually sunk, because nothing darkens where the two meet.
  const contact = smoothstep(0, 0.35, normalGeometry.y.mul(0.5).add(0.5))
    .mul(0.35)
    .add(0.65)

  // Beyond the near ring the rocks fade rather than pop. The scatter is
  // rebuilt on a window move, so an instance can appear at the edge of the
  // field; fading the last few metres means it appears out of nothing visible.
  const viewDistance = cameraPosition.sub(position).length()

  material.colorNode = albedo
  material.roughnessNode = arm.g.mul(mix(float(1.02), float(0.94), upward))
    .clamp(0.55, 0.98)
  material.aoNode = arm.r.mul(contact).clamp(0.35, 1)
  // Distance is available to callers that want to fade; kept as a node on the
  // material so the ring boundary is one expression rather than per-band JS.
  material.userData.viewDistance = viewDistance

  return {
    material,
    ready: surface.ready,
    dispose() {
      material.dispose()
    },
  }
}
