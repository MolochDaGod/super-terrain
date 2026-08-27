import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import type { Texture } from 'three/webgpu'
import * as TSL from 'three/tsl'
import { FOLIAGE_SPECIES } from './foliageSpecies'
import type { FoliageMaskField } from './FoliageMaskField'
import { FOLIAGE_INSTANCED_RANGE } from './FoliagePopulation'
import { fbm2, valueNoise2 } from './foliageNoise'
import {
  foliageCameraPosition,
  foliageTime,
  foliageWind,
  foliageWindDirection,
} from './foliageRuntime'

/** See the note in `foliageBladeMaterial` — these are node builders, not maths. */
type ShaderValue = any

const {
  cameraViewMatrix,
  clamp,
  dot,
  float,
  fwidth,
  mix,
  normalize,
  normalMap: normalMapNode,
  positionWorld,
  pow,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} = TSL as unknown as Record<string, ShaderValue>

/**
 * What one species looks like when you cannot resolve its blades any more.
 *
 * Averaged from the same sheath and tip colours the blade material shades with,
 * so the canopy the far field falls back to is the same green the near field
 * is made of. Any drift between the two shows up as a visible ring on the
 * ground at the range where the last instanced ring gives out.
 */
const AGGREGATE_COLOURS = FOLIAGE_SPECIES.map((species) => [
  species.base[0] * 0.4 + species.tip[0] * 0.6,
  species.base[1] * 0.4 + species.tip[1] * 0.6,
  species.base[2] * 0.4 + species.tip[2] * 0.6,
] as const)

/**
 * Brightness the canopy needs to sit level with the blades standing on it.
 *
 * A blade picks up a wrapped diffuse term, a transmission term and a scattered
 * sky term from its lighting model, none of which a flat opaque surface has any
 * equivalent of. Handing the canopy the same albedo therefore renders it
 * visibly darker than the grass it is standing in for, and the seam shows as a
 * dark ring at the range where the last blades give out.
 */
const CANOPY_GAIN = 0.88

export interface FoliageGroundTextures {
  map: Texture
  normalMap: Texture
  /** Packed ambient occlusion, roughness and metalness. */
  armMap: Texture
  /** World metres one tile of the soil textures covers. */
  tileSize: number
  /**
   * Linear multiplier on the soil albedo.
   *
   * The shared soil map is a pale dry mineral ground, which is right under a
   * meadow and wrong everywhere a canopy has been dropping litter on it for a
   * century. A forest floor is dark wet humus — several stops below open
   * ground — and leaving it pale is what makes trees read as standing on a
   * lawn that has been turned down rather than on their own leaf litter.
   */
  soilTint?: readonly [number, number, number]
}

/**
 * The ground the foliage stands on, and — past the last instanced ring — the
 * foliage itself.
 *
 * This is the answer to the requirement that distant ground cover never be
 * empty, and it is a stronger claim than a distance fallback. The canopy is
 * the sward at *every* range: the blades stand in it rather than replacing it,
 * so there is no distance at which grass appears or soil is revealed between
 * clumps. Beyond the last instanced ring the blades simply stop and the sward
 * they were standing in carries on to the horizon, with the same species mix,
 * the same aggregate colour and the same wind field moving the same patches of
 * light across it.
 *
 * Building it as a coverage ramp instead — soil near, grass far — is exactly
 * what produces the classic mid-distance bald patch, because the ramp is
 * visible wherever the instanced rings are thinner than the near field.
 *
 * It costs one extra pair of texture fetches and a few noise taps on a surface
 * that was going to be shaded anyway. There is no additional geometry, no
 * additional draw call, and nothing to stream.
 */
export function createFoliageGroundMaterial(
  mask: FoliageMaskField,
  textures: FoliageGroundTextures,
): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial()
  material.name = 'foliage ground and far canopy'
  material.metalness = 0
  material.roughness = 1

  const soilUv = uv().mul(mask.fieldSize / textures.tileSize)
  const soil = texture(textures.map, soilUv)
  const arm = texture(textures.armMap, soilUv)

  const ground: ShaderValue = positionWorld.xz
  const fieldUv = ground.div(mask.fieldSize).add(0.5)

  const low = texture(mask.weightsA, fieldUv)
  const high = texture(mask.weightsB, fieldUv)
  const total = dot(low, vec4(1, 1, 1, 1)).add(dot(high, vec4(1, 1, 1, 1)))
  const cover = clamp(total, 0, 1)

  let blended: ShaderValue = vec3(0, 0, 0)
  AGGREGATE_COLOURS.forEach((colour, index) => {
    const channel = ['x', 'y', 'z', 'w'][index % 4]
    const weights = index < 4 ? low : high
    blended = blended.add(vec3(colour[0], colour[1], colour[2]).mul(weights[channel]))
  })
  // Nudged toward the green primary. AgX rolls the sunlit half of a wide field
  // well up its curve, and a curve that desaturates as it compresses turns an
  // accurate green into cream long before it clips.
  const canopyBase: ShaderValue = blended
    .div(total.max(0.001))
    .mul(vec3(0.88, 1.02, 0.8))

  // Four bands of clumping, the finest two faded out as soon as a pixel covers
  // more than the feature it describes. Broad patches are where the sward is
  // thick or thin, then eddies within a patch, then tuft structure, then
  // individual clumps. An aerial view resolves the first three and sees a
  // meadow; a grazing view at a hundred metres resolves the first and sees a
  // hillside. A single band gives a flat green field from above no matter how
  // good the colour is.
  const heading = normalize(foliageWindDirection)
  const footprint = fwidth(ground).length().max(0.0005)
  const tuftFade = smoothstep(0.9, 0.18, footprint)
  const clumpFade = smoothstep(0.3, 0.06, footprint)
  const broad = fbm2(ground.mul(0.085))
  const patch = fbm2(ground.mul(0.34))
  const tuft = valueNoise2(ground.mul(1.35))
  const clump = valueNoise2(ground.mul(4.4))
  // Weighted toward the fine end. Grass seen from any height is a fine-grained
  // surface with gentle large-scale variation, not a smooth surface with
  // strong large-scale variation — get that balance backwards and an aerial
  // view returns sand dunes however good the colour is.
  const detail = tuft
    .sub(0.5)
    .mul(0.42)
    .mul(tuftFade)
    .add(clump.sub(0.5).mul(0.38).mul(clumpFade))

  // Wind streaks, and the reason the far field is not simply a smooth wash.
  //
  // Tuft-scale detail cannot survive to the horizon: at a hundred and fifty
  // metres and a grazing angle a pixel covers several metres, so anything
  // finer has to be faded out or it shimmers. Fading it leaves nothing, which
  // is what makes distant ground cover read as water however good the colour
  // is. But a real sward is not isotropic — it lies down in the direction the
  // wind has been running, in bands metres wide and tens of metres long. That
  // structure is coarse enough to resolve at any distance the field is
  // visible at, and it is unmistakably vegetation rather than a surface.
  const along = ground.dot(heading)
  const across = ground.dot(vec2(heading.y.negate(), heading.x))
  const streak = fbm2(vec2(along.mul(0.055), across.mul(0.46)))
  const streakFine = valueNoise2(vec2(along.mul(0.17), across.mul(1.1)))
  const lay = streak
    .sub(0.5)
    .mul(0.42)
    .add(streakFine.sub(0.5).mul(0.3).mul(smoothstep(2.4, 0.4, footprint)))

  const mottle = clamp(
    float(0.5)
      .add(broad.sub(0.5).mul(0.24))
      .add(patch.sub(0.5).mul(0.34))
      .add(lay)
      .add(detail),
    0,
    1,
  )

  // The same travelling gust the blades bend to. Without it the far field is
  // static while the near field moves, which reads as a hard boundary far more
  // strongly than any colour mismatch would.
  const gust = fbm2(
    ground.div(foliageWind.y).sub(heading.mul(foliageTime.mul(foliageWind.z))),
  )
  const gustLight = mix(
    float(1),
    mix(float(0.92), float(1.09), gust),
    clamp(foliageWind.x.mul(1.4), 0, 1),
  )

  const range = positionWorld.sub(foliageCameraPosition).length()
  // Not a fade between "no grass" and "grass" — the canopy is the sward at
  // every distance, and the blades stand *in* it rather than replacing it.
  // What changes with range is only how much of the sky the blades above are
  // keeping off it, which is the difference between shaded ground under a
  // near tuft and a lit meadow at the horizon. Making this a coverage ramp
  // instead is what leaves bare soil showing between mid-distance clumps.
  const shading = smoothstep(
    FOLIAGE_INSTANCED_RANGE * 0.06,
    FOLIAGE_INSTANCED_RANGE * 0.8,
    range,
  )
  const canopyStrength = cover

  const canopy = canopyBase
    .mul(CANOPY_GAIN)
    .mul(mix(float(0.66), float(1.3), mottle))
    .mul(mix(float(0.72), float(1), shading))
    .mul(gustLight)

  // Soil under thick cover is in permanent shade and is damper. Leaving it at
  // its dry sunlit albedo is what makes painted grass look like it is lying on
  // top of a photograph of gravel.
  const tint = textures.soilTint ?? [1, 1, 1]
  const shadedSoil = soil.rgb
    .mul(vec3(tint[0], tint[1], tint[2]))
    .mul(mix(vec3(1, 1, 1), vec3(0.42, 0.46, 0.34), cover))

  material.colorNode = vec4(mix(shadedSoil, canopy, canopyStrength), 1)

  // Grass is glossier than rock and its gloss varies with the tuft structure,
  // which is what gives a distant hillside its shifting sheen as the wind
  // turns the blades over.
  const soilRoughness = arm.g.mul(0.9).add(0.1)
  // Well short of a wet sheen. Grass is glossy for a plant, not for a surface;
  // taking it below about half turns a low sun into specular glare across the
  // whole field.
  const canopyRoughness = mix(float(0.72), float(0.94), mottle)
  material.roughnessNode = clamp(
    mix(soilRoughness, canopyRoughness, canopyStrength),
    0.15,
    1,
  )
  material.aoNode = mix(arm.r, arm.r.mul(0.82), canopyStrength)

  // Why this material is physical rather than standard.
  //
  // A dielectric surface reflects everything at grazing incidence — that is
  // Fresnel, and it is correct for water, for a wet road, and for a leaf. It is
  // wrong for a *canopy*, which is not a surface at all but a volume of blades
  // that light enters and is scattered inside. Left at the default specular
  // intensity, a field of grass seen at two hundred metres turns into a sheet
  // of reflected sky, which is precisely why smooth distant ground cover reads
  // as standing water. Suppressing the specular where the canopy takes over is
  // what buys back the matte, fibrous look of a real far field.
  material.specularIntensityNode = mix(float(1), float(0.14), canopyStrength)

  // The soil relief has to recede as the canopy takes over, or the ground ends
  // up as grass-coloured gravel.
  const soilNormal = normalMapNode(texture(textures.normalMap, soilUv), vec2(0.85, 0.85))
  // Two extra noise taps buy a real surface gradient for the canopy. Without
  // it an aerial view gets a perfectly flat green plane: correct in colour,
  // obviously wrong as a surface, and completely unlit by the shifting sheen
  // that tells the eye a hillside is covered in grass rather than painted.
  const east = valueNoise2(ground.mul(0.34).add(vec2(0.14, 0)))
  const north = valueNoise2(ground.mul(0.34).add(vec2(0, 0.14)))
  // A few degrees of tilt, no more. This is the undulation of a sward, not
  // terrain: pushed further it carves the same three-metre blobs the colour
  // bands were just pulled back from.
  const slope = vec2(east.sub(patch), north.sub(patch)).mul(0.32)
  const canopyNormalWorld = normalize(vec3(slope.x.negate(), 1, slope.y.negate()))
  const canopyNormal = normalize(
    cameraViewMatrix.mul(vec4(canopyNormalWorld, 0)).xyz,
  )
  material.normalNode = normalize(
    mix(soilNormal, canopyNormal, pow(canopyStrength, 0.7)),
  )

  return material
}
