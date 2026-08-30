import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import type { Texture } from 'three/webgpu'
import * as TSL from 'three/tsl'
import { AGGREGATE_COLOURS } from './foliageSpecies'
import { FOLIAGE_SURFACES } from './foliageSurfaces'
import type { FoliageMaskField } from './FoliageMaskField'
import { FOLIAGE_INSTANCED_RANGE } from './FoliagePopulation'
import { fbm2, hash21, valueNoise2 } from './foliageNoise'
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
  max,
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

/** Roughness each ground layer reads at when it is dry, in channel order. */
export const SURFACE_ROUGHNESS = FOLIAGE_SURFACES.map((surface) => surface.roughness)

/**
 * Brightness the canopy needs to sit level with the blades standing on it.
 *
 * A blade picks up a wrapped diffuse term, a transmission term and a scattered
 * sky term from its lighting model, none of which a flat opaque surface has any
 * equivalent of. Handing the canopy the same albedo therefore renders it
 * visibly darker than the grass it is standing in for, and the seam shows as a
 * dark ring at the range where the last blades give out.
 */
export const CANOPY_GAIN = 0.88

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
   *
   * The `bare-earth` ground layer paints its way back out of this: a scuff, a
   * root plate or a boar wallow exposes the mineral soil underneath the humus,
   * and that is a genuinely paler, drier, warmer surface.
   */
  soilTint?: readonly [number, number, number]
}

/**
 * How wet the ground is here, 0..1.
 *
 * One field, shared by the colour, the roughness and the specular response,
 * because those three are the same fact about the same square metre and
 * computing them from three different noises is exactly how a surface ends up
 * looking glossy where it is pale. Damp ground is darker, smoother and far
 * more specular than dry ground, and on a forest floor the boundary between
 * the two is one of the few places light actually changes — which is what
 * makes a shaft of sun landing on it read as a shaft of sun.
 *
 * Two scales: where the ground drains at all, and the small dark hollows where
 * water sits under the litter.
 */
export const wetness = /*@__PURE__*/ TSL.Fn(([ground]: [ShaderValue]) => {
  return clamp(
    smoothstep(0.34, 0.82, fbm2(ground.mul(0.052))).mul(0.68)
      .add(smoothstep(0.42, 0.88, fbm2(ground.mul(0.44))).mul(0.32)),
    0,
    1,
  )
})

/**
 * The moss sheet, laid over whatever the floor is otherwise made of.
 *
 * Moss is a film, not a plant with a silhouette. Modelling it as ground-cover
 * blades — which is what a mat of clover was standing in for — gets the colour
 * right and everything else wrong: it stands proud of the litter instead of
 * following it, it has individuals where moss has none, and it needs a flower
 * model that moss does not have. As a term in the surface it can do what the
 * real thing does, which is run continuously over the ground, over the roots
 * and over anything that has been lying still long enough, thinning out
 * wherever the floor is dry or recently disturbed.
 *
 * Two frequencies: where the beds are, and how ragged their edges are. The
 * beds also follow the damp, because that is where moss actually is.
 */
export const mossed = /*@__PURE__*/ TSL.Fn((
  [base, ground, amount, damp]: [ShaderValue, ShaderValue, ShaderValue, ShaderValue],
) => {
  const beds = fbm2(ground.mul(0.16))
  const edge = fbm2(ground.mul(0.9))
  const cover = clamp(
    smoothstep(0.42, 0.78, beds)
      .mul(smoothstep(0.3, 0.62, edge))
      .mul(float(0.55).add(damp.mul(0.75)))
      .mul(amount),
    0,
    1,
  )
  // Two greens, because a moss bed is never one: the sheet itself is a dark
  // blue-green, and the growing tips on top of it are a full stop lighter and
  // markedly more yellow.
  const sheet = vec3(0.042, 0.086, 0.036)
  const tips = vec3(0.117, 0.171, 0.061)
  const colour = mix(sheet, tips, smoothstep(0.4, 0.85, valueNoise2(ground.mul(7.5))))
  return vec4(mix(base, colour, cover.mul(0.88)), cover)
})

/**
 * A height field for the litter, in metres of leaf standing above the soil.
 *
 * Sampled three times per axis to make a normal, so it has to be cheap and it
 * has to be continuous — the cell hashes that give the litter its *colour*
 * are neither, and differencing them produces a field of white sparkle rather
 * than a surface. This is the smooth companion to them: the same frequencies,
 * interpolated, so the relief agrees with the colour break-up about where one
 * leaf ends and the next begins without being derived from it.
 *
 * It doubles as the cavity map the ground's ambient occlusion comes from. A
 * leaf lying on top of the pile receives the whole sky; the gap it is lying
 * across receives almost none, and that difference is what stops a floor of
 * dead leaves from reading as a printed texture on a flat plane.
 */
export const litterHeight = /*@__PURE__*/ TSL.Fn(([ground]: [ShaderValue]) => {
  return valueNoise2(ground.mul(20)).mul(0.4)
    .add(valueNoise2(ground.mul(11).add(vec2(37.1, 11.7))).mul(0.36))
    .add(valueNoise2(ground.mul(6.2).add(vec2(5.3, 91.2))).mul(0.24))
})

/**
 * How completely the litter covers the soil at a point.
 *
 * Not uniform: litter drifts. It piles against anything standing up, thins on
 * a rise, and leaves the bare mineral ground showing in the scuffs — and a
 * cover of exactly 1 everywhere is the flat brown carpet this pass exists to
 * avoid.
 */
export const litterCover = /*@__PURE__*/ TSL.Fn(([ground]: [ShaderValue]) => {
  const drift = fbm2(ground.mul(0.21))
  const scuff = valueNoise2(ground.mul(1.4))
  // Close to complete. The bare mineral soil underneath is a pale dry tile,
  // and every square metre of it that shows through reads as a scuff of sand
  // on a floor that should be continuous leaf.
  return clamp(
    smoothstep(0.18, 0.6, drift).mul(0.36).add(0.64).sub(scuff.mul(0.1)),
    0,
    1,
  )
})

/**
 * The colour of the litter itself.
 *
 * Dead leaves do not share a colour, they share a *range*: the newest are
 * ochre and rust, the ones under them have gone dark chocolate, and the layer
 * below that is nearly black rot. Each cell picks a point on that ramp
 * independently of its neighbours, which is why the result reads as many
 * leaves rather than as one mottled surface — and why the hash driving the
 * ramp must not be the same one driving anything spatial.
 */
export const litterColour = /*@__PURE__*/ TSL.Fn((
  [ground, damp]: [ShaderValue, ShaderValue],
) => {
  // 5cm, 9cm and 16cm cells. Real leaves overlap at every scale at once.
  const fine = hash21(ground.mul(20).floor())
  const mid = hash21(ground.mul(11).floor().add(vec2(37.1, 11.7)))
  const broad = hash21(ground.mul(6.2).floor().add(vec2(5.3, 91.2)))
  const age = clamp(fine.mul(0.44).add(mid.mul(0.36)).add(broad.mul(0.2)), 0, 1)

  // Judged against the reference rather than against a leaf held in the hand.
  // A single dead beech leaf really is ochre; a hundred of them lying wet and
  // packed on a shaded floor are not, and the first pass at these values gave
  // the stand a bright tan carpet that read as sawdust. Damp litter under a
  // closed canopy is close to the darkest surface in the frame.
  const rot = vec3(0.026, 0.02, 0.014)
  const dark = vec3(0.062, 0.042, 0.025)
  const ochre = vec3(0.124, 0.083, 0.042)
  const bleached = vec3(0.183, 0.139, 0.083)
  const lower = mix(rot, dark, smoothstep(0.0, 0.46, age))
  const upper = mix(ochre, bleached, smoothstep(0.72, 1.0, age))
  const base = mix(lower, upper, smoothstep(0.4, 0.78, age))

  // Damp shows as a darker, slightly greener leaf; it runs in patches that
  // have nothing to do with which leaf is which.
  return base.mul(mix(float(1), float(0.62), damp))
    .mul(mix(vec3(1, 1, 1), vec3(0.9, 1.02, 0.86), damp))
})

/**
 * Conifer needle duff, which is not leaf litter with the colours changed.
 *
 * A needle bed is an order of magnitude finer than a bed of broadleaves, far
 * more even in tone, and it packs down into a continuous felt rather than
 * lying in overlapping plates. Rendering a spruce floor with the beech litter
 * above is the same mistake as painting a lawn under a canopy: right value,
 * wrong structure, and the structure is what the eye reads.
 */
export const duffColour = /*@__PURE__*/ TSL.Fn((
  [ground, damp]: [ShaderValue, ShaderValue],
) => {
  // 2cm and 4cm cells: individual needles, not leaves.
  const fine = hash21(ground.mul(52).floor())
  const mid = hash21(ground.mul(26).floor().add(vec2(19.3, 71.1)))
  const age = clamp(fine.mul(0.6).add(mid.mul(0.4)), 0, 1)
  const rot = vec3(0.019, 0.015, 0.011)
  const brown = vec3(0.055, 0.039, 0.024)
  const rust = vec3(0.088, 0.06, 0.031)
  const base = mix(mix(rot, brown, smoothstep(0.1, 0.6, age)), rust, smoothstep(0.66, 1, age))
  return base.mul(mix(float(1), float(0.66), damp))
})

export const duffCover = /*@__PURE__*/ TSL.Fn(([ground]: [ShaderValue]) => {
  // Far more even than leaf litter — that evenness is the point.
  return clamp(smoothstep(0.1, 0.5, fbm2(ground.mul(0.3))).mul(0.22).add(0.78), 0, 1)
})

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
 * Underneath the sward, the floor is four painted layers rather than a set of
 * constants: leaf litter, needle duff, moss and bare earth, sampled from the
 * same mask the plants are. That is what makes the seeded floor of a preset
 * something the brush can take back off again.
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
  const fieldUv = ground.sub(mask.origin).div(mask.fieldSize).add(0.5)

  const weightRows = mask.weights.map((row) => texture(row, fieldUv))
  const total = weightRows
    .map((row) => dot(row, vec4(1, 1, 1, 1)))
    .reduce((sum: ShaderValue, row: ShaderValue) => sum.add(row))
  const cover = clamp(total, 0, 1)

  // --- the painted ground layers ------------------------------------------
  const surfaceRow: ShaderValue = texture(mask.surfaces[0]!, fieldUv)
  const litterWeight = clamp(surfaceRow.x, 0, 1)
  const duffWeight = clamp(surfaceRow.y, 0, 1)
  const mossWeight = clamp(surfaceRow.z, 0, 1)
  const bareWeight = clamp(surfaceRow.w, 0, 1)

  let blended: ShaderValue = vec3(0, 0, 0)
  AGGREGATE_COLOURS.forEach((colour, index) => {
    const channel = ['x', 'y', 'z', 'w'][index % 4]!
    const weights = weightRows[Math.floor(index / 4)]
    if (!weights) return
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
  // The canopy term stands in for blades the instanced rings are not drawing,
  // so how much of it there should be depends on how many of them there are.
  //
  // Near the camera the rings draw the real thing at full density, and painting
  // the ground under them the aggregate colour of grass as well turns the floor
  // into a sheet of flat green with a few blades standing on it — the litter,
  // the twigs and the relief all disappear under paint. Past the rings it is
  // the only sward there is and has to carry the whole read. `shading` is
  // already the distance ramp for exactly this range, so the two agree by
  // construction instead of by two constants that have to be kept in step.
  const canopyStrength = cover.mul(mix(float(0.42), float(1), shading))

  const canopy = canopyBase
    .mul(CANOPY_GAIN)
    .mul(mix(float(0.66), float(1.3), mottle))
    .mul(mix(float(0.72), float(1), shading))
    .mul(gustLight)

  const damp = wetness(ground).toVar('groundWetness')

  // Soil under thick cover is in permanent shade and is damper. Leaving it at
  // its dry sunlit albedo is what makes painted grass look like it is lying on
  // top of a photograph of gravel.
  const tint = textures.soilTint ?? [1, 1, 1]
  const humus = soil.rgb
    .mul(vec3(tint[0], tint[1], tint[2]))
    .mul(mix(vec3(1, 1, 1), vec3(0.42, 0.46, 0.34), cover))
  // Bare earth is not the humus with the litter taken off it — it is the
  // mineral soil *underneath* the humus, which is paler, warmer and drier.
  // That contrast is the whole reason a scuff or a root plate reads as an
  // interruption rather than as a hole in a texture.
  const mineral = soil.rgb.mul(
    mix(vec3(tint[0], tint[1], tint[2]), vec3(0.92, 0.84, 0.72), 0.82),
  )
  const soilBase = mix(humus, mineral, bareWeight.mul(0.92))

  // --- fallen leaf litter and needle duff ---------------------------------
  //
  // Three cell tiers standing in for three sizes of dead leaf, each hashed to
  // its own colour, laid over the soil rather than replacing it so the ground
  // still shows through the gaps. The tiers are deliberately close in
  // frequency: litter has no dominant scale, and a single one reads as a
  // printed pattern the moment two of its cells line up. Needle duff is the
  // same idea an order of magnitude finer and far more even.
  //
  // Every weight here comes from the paint mask, which is what makes the floor
  // a preset lays down something the eraser can take back.
  const litterMix = litterWeight.mul(litterCover(ground)).toVar('litterMix')
  const duffMix = duffWeight.mul(duffCover(ground)).toVar('duffMix')
  const withLitter = mix(soilBase, litterColour(ground, damp), litterMix)
  const withDuff = mix(withLitter, duffColour(ground, damp), duffMix)
  const mossResult = mossed(withDuff, ground, mossWeight, damp)
  const floorColour = mossResult.xyz
  const mossCover = mossResult.w.toVar('mossCover')

  material.colorNode = vec4(mix(floorColour, canopy, canopyStrength), 1)

  // --- roughness, specular and the wet/dry response ------------------------
  //
  // Grass is glossier than rock and its gloss varies with the tuft structure,
  // which is what gives a distant hillside its shifting sheen as the wind
  // turns the blades over.
  const soilRoughness = arm.g.mul(0.9).add(0.1)
  // Each painted layer brings its own dry roughness, in channel order. Damp
  // ground then takes a fifth off whatever that came to: wet litter is the
  // one surface on a forest floor that catches a shaft of light, and a floor
  // whose roughness does not vary cannot show one at all.
  const layeredRoughness = mix(
    mix(
      mix(
        mix(soilRoughness, float(SURFACE_ROUGHNESS[0]!), litterMix),
        float(SURFACE_ROUGHNESS[1]!),
        duffMix,
      ),
      float(SURFACE_ROUGHNESS[2]!),
      mossCover,
    ),
    float(SURFACE_ROUGHNESS[3]!),
    bareWeight.mul(0.85),
  )
  const floorRoughness = clamp(
    layeredRoughness
      .sub(damp.mul(0.26).mul(bareWeight.oneMinus()))
      // Micro-scale grain. Two centimetres, faded out the moment a pixel is
      // wider than that, so it sharpens a close-up floor without adding
      // shimmer to a distant one.
      .add(valueNoise2(ground.mul(46)).sub(0.5).mul(0.1).mul(smoothstep(0.06, 0.012, footprint))),
    0.2,
    1,
  )
  // Well short of a wet sheen. Grass is glossy for a plant, not for a surface;
  // taking it below about half turns a low sun into specular glare across the
  // whole field.
  const canopyRoughness = mix(float(0.72), float(0.94), mottle)
  material.roughnessNode = clamp(
    mix(floorRoughness, canopyRoughness, canopyStrength),
    0.15,
    1,
  )

  // Ambient occlusion, from the relief the floor actually has.
  //
  // The baked map is a five-metre tile: at eye level its features are metres
  // across and it occludes nothing the viewer can associate with anything. The
  // litter height field is the cavity map at the scale that matters — a leaf
  // lying on the pile sees the sky, the gap it bridges does not — and it costs
  // one tap because the normal already needs the field anyway.
  const cavity = litterHeight(ground).toVar('litterCavity')
  const reliefStrength = clamp(litterMix.add(duffMix.mul(0.5)).add(mossCover.mul(0.4)), 0, 1)
  const cavityAo = mix(float(1), clamp(cavity.mul(0.9).add(0.34), 0, 1), reliefStrength)
  material.aoNode = mix(arm.r, arm.r.mul(0.82), canopyStrength).mul(cavityAo)

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
  //
  // On the floor itself the specular is the wet/dry story: dry duff has almost
  // none, wet litter has a real sheen, and the difference between them is what
  // a godray landing on the ground actually looks like.
  const floorSpecular = mix(float(0.45), float(1.15), damp.mul(bareWeight.oneMinus()))
  material.specularIntensityNode = mix(floorSpecular, float(0.14), canopyStrength)

  // --- normals -------------------------------------------------------------
  //
  // The soil relief has to recede as the canopy takes over, or the ground ends
  // up as grass-coloured gravel.
  const bakedSoilNormal = normalMapNode(texture(textures.normalMap, soilUv), vec2(0.85, 0.85))
  // Litter has relief, and at eye level it is the only relief there is. The
  // baked soil normal is a 5-metre tile: from 1.7 metres up its features are
  // metres across and the ground reads as a smooth painted plane whatever its
  // colour is doing. These are the individual leaves catching the light.
  //
  // Two tiers now rather than one. The 7cm difference carries the leaf plates;
  // a 2cm one on top of it carries the grain between them, faded out as soon
  // as a pixel is wider than the feature so it cannot alias. Without the fine
  // tier the floor is correct in shape and still reads as smooth, because at
  // 1.7 metres a seven-centimetre feature is already the coarse end of what
  // the eye is looking for.
  const slopeAt = (offset: number, gain: number): ShaderValue => {
    const dx = litterHeight(ground.add(vec2(offset, 0)))
      .sub(litterHeight(ground.sub(vec2(offset, 0))))
    const dz = litterHeight(ground.add(vec2(0, offset)))
      .sub(litterHeight(ground.sub(vec2(0, offset))))
    return vec2(dx.mul(gain), dz.mul(gain))
  }
  const grainFade = smoothstep(0.09, 0.02, footprint)
  // Stronger than it was. The previous 3.2 was chosen when this was the only
  // relief and had to survive being pushed to the grazing angles an eye-level
  // camera lives at; with the cavity term now doing the occlusion the slope
  // can carry the shape instead of having to carry both.
  const litterSlope = slopeAt(0.035, 4.6).add(
    slopeAt(0.011, 2.4).mul(grainFade),
  )
  const litterNormalWorld = normalize(vec3(
    litterSlope.x.negate(), 1, litterSlope.y.negate(),
  ))
  // Moss cushions are rounder and coarser than the litter under them, and they
  // are the layer that rounds off a fallen branch or a root into the floor.
  const mossBump = valueNoise2(ground.mul(3.4).add(vec2(11.1, 4.7)))
  const mossSlopeX = valueNoise2(ground.mul(3.4).add(vec2(11.35, 4.7))).sub(mossBump)
  const mossSlopeZ = valueNoise2(ground.mul(3.4).add(vec2(11.1, 4.95))).sub(mossBump)
  const mossNormalWorld = normalize(vec3(
    mossSlopeX.negate().mul(6), 1, mossSlopeZ.negate().mul(6),
  ))
  const floorNormalWorld = normalize(
    mix(litterNormalWorld, mossNormalWorld, mossCover.mul(0.6)),
  )
  const floorNormal = normalize(
    cameraViewMatrix.mul(vec4(floorNormalWorld, 0)).xyz,
  )
  const soilNormal = normalize(mix(
    bakedSoilNormal,
    floorNormal,
    // Bare earth keeps the baked mineral relief; it is the one layer that is
    // genuinely soil rather than something lying on it.
    max(reliefStrength.mul(0.88), mossCover.mul(0.7)).mul(bareWeight.oneMinus().mul(0.75).add(0.25)),
  ))
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
