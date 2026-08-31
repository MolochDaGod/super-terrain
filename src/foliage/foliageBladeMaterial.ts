import { DoubleSide, MeshStandardNodeMaterial, PhysicalLightingModel } from 'three/webgpu'
import * as TSL from 'three/tsl'
import { fbm2, hash22, hash24, valueNoise2 } from './foliageNoise'
import {
  foliageCameraPosition,
  foliageProjection,
  foliageTime,
  foliageWind,
  foliageWindDirection,
} from './foliageRuntime'
import { foliageSpeciesRow } from './foliageSpeciesUniforms'
import type { FoliageInstanceReader } from './FoliagePopulation'

/**
 * Every value in this module is a TSL node, not a number.
 *
 * TSL's published types describe a builder by the value it would produce,
 * which cannot follow a graph assembled out of storage-buffer reads,
 * uniform-array lookups and swizzles of both. Rather than scatter casts through
 * shader code that is already hard enough to read, the node builders are taken
 * once at their runtime signature and the graph is checked by the shader
 * compiler, where it actually can be.
 */
type ShaderValue = any

const {
  attribute,
  cameraViewMatrix,
  clamp,
  cos,
  cross,
  faceDirection,
  float,
  floor,
  fract,
  instanceIndex,
  int,
  max,
  mix,
  normalView,
  normalize,
  positionGeometry,
  positionViewDirection,
  pow,
  sin,
  smoothstep,
  sqrt,
  step,
  uint,
  varying,
  vec2,
  vec3,
  vec4,
} = TSL as unknown as Record<string, ShaderValue>

/**
 * The narrowest a blade is allowed to become on screen, in pixels.
 *
 * Below roughly one pixel a thin triangle stops being reliably sampled and a
 * field of grass dissolves into sparse glitter and then into nothing — which
 * is the real reason distant foliage "disappears" in most renderers, long
 * before any LOD system decides to drop it. Widening the blade instead of
 * letting it thin out keeps the coverage the meadow is supposed to have. It is
 * a lie about the width of one blade told to preserve the truth about the
 * density of ten thousand, and it is the standard one.
 */
const MINIMUM_BLADE_PIXELS = 1.2

/** Ceiling on that widening, so a blade at the horizon is not a billboard. */
const MAXIMUM_BLADE_WIDENING = 26

const UP = /*@__PURE__*/ vec3(0, 1, 0)

/**
 * Scattering and sheen for a grass blade.
 *
 * Two things separate real grass from green cardboard, and neither is albedo.
 * The first is that a blade is thin enough to light from behind, so a meadow
 * with the sun low behind it glows rather than falling into silhouette. The
 * second is that a blade is a smooth cylinder-ish ribbon, so its highlight is
 * a *streak* running along its length, not a round dot — the same reason hair
 * needs an anisotropic model. Both are handled here rather than by texture.
 */
class GrassLightingModel extends PhysicalLightingModel {
  private readonly translucency: ShaderValue
  private readonly transmitted: ShaderValue
  private readonly bladeAxis: ShaderValue
  /** x is highlight strength, y its exponent along the blade. */
  private readonly streak: ShaderValue

  constructor(
    translucency: ShaderValue,
    transmitted: ShaderValue,
    bladeAxis: ShaderValue,
    streak: ShaderValue,
  ) {
    super()
    this.translucency = translucency
    this.transmitted = transmitted
    this.bladeAxis = bladeAxis
    this.streak = streak
  }

  indirectDiffuse(builder: Parameters<PhysicalLightingModel['indirect']>[0]): void {
    super.indirectDiffuse(builder)
    const context = (builder as ShaderValue).context
    // Sky fill picked up through the blade from the far side. This scales the
    // irradiance the renderer actually computed, so it vanishes at night
    // instead of turning the lawn into an emissive sheet.
    context.reflectedLight.indirectDiffuse.addAssign(
      context.irradiance
        .mul(this.translucency.mul(0.5).add(0.28))
        .mul(1.05)
        .mul(this.transmitted),
    )
  }

  direct(
    input: Parameters<PhysicalLightingModel['direct']>[0],
    builder: Parameters<PhysicalLightingModel['direct']>[1],
  ): void {
    super.direct(input, builder)
    const lightDirection = input.lightDirection as ShaderValue
    const lightColor = input.lightColor as ShaderValue
    const reflected = input.reflectedLight as ShaderValue
    const cosine = normalView.dot(lightDirection)

    // Wrapped diffuse. A blade is not an opaque half-space: light entering the
    // lit side reaches the shaded side a fraction of a millimetre away, which
    // softens the terminator far more than a Lambert curve allows.
    const wrapped = cosine.add(0.55).div(1.55).clamp()
    reflected.directDiffuse.addAssign(
      lightColor
        .mul(wrapped.sub(cosine.clamp()))
        .mul(this.translucency.mul(0.4).add(0.45))
        .mul(0.52)
        .mul(this.transmitted),
    )

    // Straight-through transmission, tight around the anti-sun direction.
    const bent = normalize(lightDirection.add(normalView.mul(0.3)))
    const behind = positionViewDirection.dot(bent.negate()).clamp().pow(4)
    reflected.directDiffuse.addAssign(
      lightColor.mul(behind).mul(this.translucency).mul(0.95).mul(this.transmitted),
    )

    // Kajiya-Kay: the highlight is the locus of directions perpendicular to the
    // blade axis, so it draws a line down the blade rather than a point on it.
    const halfVector = normalize(lightDirection.add(positionViewDirection))
    const axisDotHalf = this.bladeAxis.dot(halfVector)
    const perpendicular = sqrt(max(float(1).sub(axisDotHalf.mul(axisDotHalf)), 0))
    reflected.directSpecular.addAssign(
      lightColor
        .mul(pow(perpendicular, this.streak.y))
        .mul(this.streak.x)
        .mul(cosine.clamp().mul(0.72).add(0.28)),
    )
  }
}

class GrassNodeMaterial extends MeshStandardNodeMaterial {
  private readonly translucency: ShaderValue
  private readonly transmitted: ShaderValue
  private readonly bladeAxis: ShaderValue
  private readonly streak: ShaderValue

  constructor(
    translucency: ShaderValue,
    transmitted: ShaderValue,
    bladeAxis: ShaderValue,
    streak: ShaderValue,
  ) {
    super()
    this.translucency = translucency
    this.transmitted = transmitted
    this.bladeAxis = bladeAxis
    this.streak = streak
  }

  override setupLightingModel(): PhysicalLightingModel {
    return new GrassLightingModel(
      this.translucency,
      this.transmitted,
      this.bladeAxis,
      this.streak,
    )
  }
}

/**
 * The single material every painted species and every level of detail draws with.
 *
 * There are no textures. A blade is ten to eighty triangles of geometry that
 * already carries its own silhouette, so an albedo map would only add sampling
 * cost and a repeating pattern to hide. Everything a texture would have
 * supplied — hue drift, drying, vigour patches, seed heads, the dark base of a
 * tuft — is computed per vertex from the same hashes that placed the plant,
 * which means it is free of tiling and consistent between levels of detail.
 */
export function createFoliageBladeMaterial(
  instances: FoliageInstanceReader,
): MeshStandardNodeMaterial {
  const packed = positionGeometry
  const t = packed.x.toVar('bladeParameter')
  const side = packed.y
  const seed = packed.z

  // x is where this ring's slice of the instance buffer starts, y the metres
  // its clumps scatter over.
  const ringData = attribute('ringData', 'vec2')
  const slot = uint(ringData.x).add(instanceIndex).mul(uint(2))
  const placement = instances.element(slot).toVar('foliagePlacement')
  const traits = instances.element(slot.add(uint(1))).toVar('foliageTraits')

  const clump = placement.xyz
  const clumpYaw = placement.w
  const heightScale = traits.x
  const widthScale = traits.y
  const species = int(floor(traits.z))
  const coverage = fract(traits.z).div(0.985)
  const variation = traits.w

  const row0 = foliageSpeciesRow(species, 0)
  const row1 = foliageSpeciesRow(species, 1)
  const row2 = foliageSpeciesRow(species, 2)
  const row3 = foliageSpeciesRow(species, 3)
  const row4 = foliageSpeciesRow(species, 4)
  const row5 = foliageSpeciesRow(species, 5)

  // Four independent randoms that identify this blade within its clump.
  const dice = hash24(
    vec2(
      variation.mul(91.7).add(seed.mul(37.3)),
      variation.mul(53.1).sub(seed.mul(19.7)),
    ),
  ).toVar('bladeDice')

  // — Where the blade stands and which way it leans ————————————————
  //
  // Uniform sampling of the clump disc, not a fan. A coarse ring packs twenty
  // blades into a clump two thirds of a metre across; laid out along an arc
  // they would read as a comb, and the gaps between combs are exactly what
  // makes a distant field look bald.
  const place = hash22(
    vec2(
      variation.mul(23.1).add(seed.mul(61.7)),
      variation.mul(77.3).sub(seed.mul(13.1)),
    ),
  )
  const clumpRadius = max(row1.y, ringData.y)
  const azimuth = clumpYaw.add(place.x.mul(6.28318))
  const radial = clumpRadius.mul(sqrt(place.y))
  const footing = clump.add(
    vec3(cos(azimuth).mul(radial), 0, sin(azimuth).mul(radial)),
  )
  // Blades lean away from the middle of the tuft, by as much as the species
  // is open — a rosette throws its leaves flat, a reed stands them up.
  const lean = azimuth.add(dice.z.sub(0.5).mul(row5.y))
  const restDirection = vec3(cos(lean), 0, sin(lean))

  const length = row0.x
    .mul(heightScale)
    .mul(float(0.7).add(dice.z.mul(0.6)))

  // — Wind ————————————————————————————————————————————————
  //
  // Three bands, because one is never enough. The slow field is what makes a
  // gust legible as a front crossing the meadow rather than as everything
  // twitching at once; the mid field breaks that front into eddies; the
  // per-blade term is the flutter that keeps a close-up blade alive even in
  // still air. All three are functions of clump position and time only, so
  // neighbouring blades agree and the tuft moves as one plant.
  const ground = vec2(clump.x, clump.z)
  const heading = normalize(foliageWindDirection)
  const drift = heading.mul(foliageTime.mul(foliageWind.z))
  const gust = fbm2(ground.div(foliageWind.y).sub(drift))
  const eddy = valueNoise2(
    ground.div(foliageWind.y.mul(0.26)).sub(drift.mul(2.3)),
  )
  const compliance = row0.w.oneMinus().mul(0.9).add(0.12)
  const power = foliageWind.x.mul(
    float(0.22).add(gust.mul(1.2)).add(eddy.mul(0.42)),
  )
  const flutter = sin(
    foliageTime
      .mul(float(4.4).add(dice.x.mul(6.2)))
      .add(variation.mul(41.3))
      .add(clump.x.mul(0.63)),
  )
    .mul(foliageWind.w)
    .mul(power.mul(0.55).add(0.09))

  // A blade at rest arches in whatever direction it grew. Under load it arches
  // downwind. Blending the axis rather than adding a second rotation keeps the
  // arc length-preserving, which is what stops bent grass from stretching.
  const downwind = vec3(heading.x, 0, heading.y)
  const surrender = clamp(power.mul(compliance).mul(1.25), 0, 0.88)
  const direction = normalize(
    mix(restDirection, downwind, surrender),
  )

  const arch = row1.x.mul(float(0.68).add(dice.y.mul(0.64)))
  const flop = row5.z.mul(dice.w)
  const bend = max(
    arch.add(flop).add(power.mul(compliance).mul(1.3)).add(flutter.mul(compliance)),
    0.0025,
  )

  // Circular-arc bending. Rotating the tip, or shearing the blade sideways,
  // both change its length as it bends — a whole meadow visibly growing and
  // shrinking with the wind. An arc of fixed length does not.
  const sweep = bend.mul(t)
  const rise = sin(sweep).div(bend).mul(length)
  const reach = cos(sweep).oneMinus().div(bend).mul(length)
  const tangent = normalize(
    direction.mul(sin(sweep)).add(UP.mul(cos(sweep))),
  )
  const spine = footing
    .add(direction.mul(reach))
    .add(UP.mul(rise))
    .toVar('bladeSpine')

  // — Width ————————————————————————————————————————————————
  const taper = row1.z
  const bulge = row1.w
  // One profile covers a needle-tipped grass blade and a rounded clover leaf.
  // `bulge` decides how late the width starts falling away, `taper` how sharply
  // it does so once it starts, and the sheath term gives broadleaves the bare
  // petiole they need to not look like they are growing out of the soil sideways.
  const edge = max(float(1).sub(pow(t, float(1).add(bulge.mul(2.4)))), 0)
  const shoulder = float(1).add(bulge.mul(1.5).mul(t.mul(t.oneMinus()).mul(4)))
  const sheath = smoothstep(0, float(0.05).add(bulge.mul(0.42)), t)
  const bladeWidth = row0.z
    .mul(0.5)
    .mul(widthScale)
    .mul(pow(edge, taper))
    .mul(shoulder)
    .mul(sheath)
    .mul(float(0.74).add(dice.y.mul(0.52)))

  const bearsFlower = step(dice.w, row4.w)
  const stem = row0.z.mul(0.5).mul(widthScale).mul(0.4).mul(pow(t.oneMinus(), 0.3))
  const headSpan = smoothstep(0.6, 0.9, t).mul(smoothstep(1.02, 0.92, t).max(0.45))
  const flowerWidth = stem.add(
    row0.z.mul(0.5).mul(widthScale).mul(3.2).mul(headSpan),
  )
  const naturalWidth = mix(bladeWidth, flowerWidth, bearsFlower)

  const toCamera = foliageCameraPosition.sub(spine)
  const viewDistance = max(toCamera.length(), 0.05).toVar('bladeRange')
  const viewDirection = toCamera.div(viewDistance)

  // Distance-uniform coverage ramp.
  //
  // Seventy-odd blades per square metre is three orders of magnitude short of
  // a real sward, so honest blade widths leave the ground showing between them
  // at any distance where a blade is smaller than the eye's own acuity. Fatten
  // them with range and the meadow closes up.
  //
  // The point is that this is a function of distance and *nothing else*. Every
  // ring applies the identical ramp at the identical range, so it cannot
  // reintroduce the boundary that per-ring width constants produce. Close to
  // the camera, where a blade's width is something the viewer can actually
  // judge, it is exactly 1.
  const coverageRamp = mix(float(1), float(3.2), smoothstep(5, 50, viewDistance))
  const spreadWidth = naturalWidth.mul(coverageRamp)

  const pixelsPerMetre = foliageProjection.x.div(
    viewDistance.mul(foliageProjection.y).mul(2),
  )
  const widen = clamp(
    float(MINIMUM_BLADE_PIXELS).div(
      max(spreadWidth.mul(2).mul(pixelsPerMetre), 0.0004),
    ),
    1,
    MAXIMUM_BLADE_WIDENING,
  ).toVar('bladeWidening')

  // Widening has to be paid for, or the rings stop agreeing with each other.
  //
  // Each ring is calibrated so that `blades per square metre × blade width` is
  // the same as every other ring's — that product is the coverage, and holding
  // it constant is what makes the levels of detail indistinguishable. The
  // moment a blade is widened to the pixel floor, its ring's half of that
  // product is overwritten by the floor, and the calibration is gone. A ring
  // whose blades are already above the floor keeps its density; the ring
  // inside it, whose thinner blades were all pushed up to the floor, gains
  // coverage it was not supposed to have. The result is a hard arc on the
  // ground at exactly the radius where the two meet — which is precisely how
  // this failed before.
  //
  // Thinning the blades in the same proportion they were widened puts the
  // product back. Each blade carries its own fixed threshold, so the one that
  // disappears at forty metres disappears at forty metres every frame and from
  // every angle: the field thins smoothly with distance instead of flickering.
  const thinning = fract(dice.x.mul(7.13).add(dice.z.mul(3.71)).add(seed.mul(1.7)))
  const survives = step(thinning, widen.reciprocal())
  const halfWidth = spreadWidth.mul(widen).mul(survives)

  // — Orientation across the blade ——————————————————————————————
  //
  // Near the camera the blade keeps the orientation it grew in, because that
  // is what a blade does and the eye can tell. Far away an edge-on blade is a
  // blade that is not there, so the width axis is rotated toward the screen.
  // The turn is ramped in with distance, which is exactly the range where its
  // dishonesty stops being visible.
  const flat = vec3(direction.z.negate(), 0, direction.x)
  const screenAligned = normalize(cross(tangent, viewDirection))
  const orientation = step(0, screenAligned.dot(flat)).mul(2).sub(1)
  const turn = smoothstep(5, 42, viewDistance).mul(0.82)
  const widthAxis = normalize(
    mix(flat, screenAligned.mul(orientation), turn),
  )

  // Blades are troughed across their width, not flat. The displacement is what
  // makes the silhouette read as a curved ribbon; the matching normal rotation
  // is what makes the shading agree with it.
  const curl = float(0.12).add(clamp(taper.mul(0.4), 0, 0.58))
  const face = normalize(cross(widthAxis, tangent))
  const trough = side.mul(side).mul(curl).mul(halfWidth)
  const worldPosition = spine
    .add(widthAxis.mul(halfWidth.mul(side)))
    .sub(face.mul(trough))

  const curlAngle = curl.mul(1.4).mul(side)
  const bladeNormal = normalize(
    face.mul(cos(curlAngle)).add(widthAxis.mul(sin(curlAngle))),
  )
  // Bending the shading normal toward the ground normal is the difference
  // between a field and a heap of individually lit green splinters. It stops
  // well short of the ground normal on purpose, at every distance: taken all
  // the way, distant blades shade identically to the sward they stand in and
  // an aerial view gets a smooth green sheet. The light-and-dark speckle of
  // blades catching the sun at slightly different angles *is* what reads as
  // grass from height — removing it in the name of stability is what makes a
  // far field look like water.
  const settle = smoothstep(2, 30, viewDistance).mul(0.3).add(0.18)
  const shadingNormal = normalize(mix(bladeNormal, UP, settle))

  // — Colour ————————————————————————————————————————————————
  //
  // How wet the ground under this clump is, at the same broad frequency the
  // ground material uses for the same purpose. It has to be the same field or
  // the blades come out glossy in one place and the litter they stand in comes
  // out glossy in another, which reads as two surfaces rather than one. One
  // tap rather than the ground's two: at blade scale the fine term is smaller
  // than a clump and would only add per-clump noise.
  const damp = smoothstep(0.34, 0.78, valueNoise2(ground.mul(0.052)))
    .toVar('bladeWetness')
  const vigour = fbm2(
    ground.mul(0.023).add(vec2(float(species).mul(11.3), float(species).mul(7.1))),
  )
  const parch = clamp(
    row5.x.mul(float(0.62).add(vigour.oneMinus().mul(0.95))).sub(dice.w).mul(2.4).add(0.16),
    0,
    1,
  )

  const living = mix(row2.xyz, row3.xyz, pow(t, 0.72))
  const straw = mix(vec3(0.108, 0.082, 0.032), vec3(0.44, 0.345, 0.142), pow(t, 0.6))
  const dried = mix(living, straw, parch.mul(float(0.34).add(t.mul(0.66))))
  // Even a healthy blade dies back from the tip first.
  const scorch = smoothstep(0.74, 1, t).mul(0.32).mul(float(0.4).add(parch.mul(0.6)))
  const weathered = mix(dried, vec3(0.26, 0.19, 0.075), scorch)
  const patched = mix(weathered.mul(vec3(0.84, 0.79, 0.54)), weathered, clamp(vigour.mul(1.4).add(0.08), 0, 1))
  const individual = patched
    .mul(vec3(
      float(0.93).add(dice.x.mul(0.15)),
      float(0.91).add(dice.y.mul(0.18)),
      float(0.87).add(dice.z.mul(0.26)),
    ))
    .mul(float(0.72).add(variation.mul(0.56)))
  const headMix = bearsFlower.mul(smoothstep(0.64, 0.86, t))
  const flowering = mix(
    individual,
    row4.xyz.mul(float(0.78).add(dice.z.mul(0.5))),
    headMix,
  )

  // A blade widened twenty times to stay a pixel across would read as a fat
  // ribbon of one blade's exact hue. Fading it toward the average of the
  // species as it widens turns it back into what it is standing in for: the
  // aggregate colour of the many blades it replaced.
  const aggregate = mix(row2.xyz, row3.xyz, 0.6).mul(0.92)
  const albedo = mix(
    flowering,
    aggregate,
    smoothstep(1.6, 12, widen).mul(0.32),
  ).mul(mix(vec3(1, 1, 1), vec3(0.83, 0.9, 0.79), damp))

  // The floor of a tuft genuinely receives almost no sky, and thicker cover
  // means less. This single gradient does more for grounding than any
  // screen-space occlusion pass would.
  const occlusion = mix(
    float(0.3).sub(coverage.mul(0.15)),
    float(1),
    pow(t, 0.6),
  )
  // Wet grass is glossier than dry grass by a wide margin, and it is the one
  // thing that makes a shaft of light landing on a patch of floor read as a
  // shaft of light rather than as a brighter patch of paint. Dry blades go the
  // other way: a strawed blade is matte.
  const roughness = clamp(
    row2.w
      .add(parch.mul(0.24))
      .sub(smoothstep(0.35, 1, t).mul(0.09))
      .add(dice.x.mul(0.07))
      .sub(damp.mul(0.2)),
    0.18,
    0.95,
  )
  const translucency = row3.w
    .mul(float(0.7).add(t.mul(0.5)))
    .mul(mix(float(1), float(1.18), parch))

  const colorVarying = varying(albedo, 'foliageAlbedo')
  const surfaceVarying = varying(
    vec4(roughness, translucency, occlusion, widen),
    'foliageSurface',
  )
  const normalVarying = varying(shadingNormal, 'foliageNormal')
  const tangentVarying = varying(tangent, 'foliageTangent')
  // t, the across-blade coordinate, the local damp, and one of the blade's own
  // dice — everything the fragment stage needs to give a close-up blade some
  // surface of its own.
  const shapeVarying = varying(vec4(t, side, damp, dice.x), 'foliageShape')

  // — Fragment ————————————————————————————————————————————————
  const sideOfBlade = faceDirection
  const normalWorldUnit = normalize(normalVarying).mul(sideOfBlade)
  const normalViewSpace = normalize(
    cameraViewMatrix.mul(vec4(normalWorldUnit, 0)).xyz,
  )
  const tangentViewSpace = normalize(
    cameraViewMatrix.mul(vec4(normalize(tangentVarying), 0)).xyz,
  )

  const underside = sideOfBlade.mul(-0.5).add(0.5)

  // — Micro-detail ————————————————————————————————————————————
  //
  // Two structures, both essentially free because both are trigonometry on
  // varyings that already exist, and both faded out the moment the blade is
  // being widened for distance — at which point they are finer than a pixel
  // and would only alias.
  //
  // The ribs run *along* the blade: a grass leaf is a bundle of parallel veins
  // with shallow valleys between them, which is why a close blade catches the
  // light in stripes rather than as one smooth ribbon. The grain runs across
  // it, standing in for the transverse cell structure that makes a real blade
  // matte in bands.
  const microFade = smoothstep(3.2, 1.15, surfaceVarying.w)
  const ribs = cos(shapeVarying.y.mul(9.42)).mul(0.5).add(0.5)
  const grain = sin(
    shapeVarying.x.mul(58).add(shapeVarying.w.mul(37.1)),
  ).mul(0.5).add(0.5)
  const micro = ribs.mul(0.62).add(grain.mul(0.38)).sub(0.5).mul(microFade)

  const fragmentRoughness = clamp(
    surfaceVarying.x
      .add(underside.mul(0.14))
      .add(micro.mul(0.16)),
    0.16,
    0.98,
  )
  // The abaxial face of a blade is waxier, paler and much less glossy. Drawing
  // both sides identically is why double-sided foliage reads as paper.
  // A blade is troughed, so its midline sees less sky than its margins do. Four
  // segments of geometry cannot carry that, and it is the cue that stops a
  // close-up blade from reading as a flat painted strip.
  const midrib = mix(float(0.9), float(1.05), smoothstep(0, 0.5, shapeVarying.y.abs()))
  const litColor = colorVarying
    .mul(mix(vec3(1, 1, 1), vec3(1.1, 1.06, 0.94), underside))
    .mul(midrib)
    .mul(micro.mul(0.14).add(1))
  // Restrained on purpose. The Kajiya-Kay lobe covers a whole hemisphere of
  // half-vectors, so every blade facing anywhere near the sun contributes at
  // once; at the strength a single surface would want, a field of them turns
  // into a sheet of glare.
  // The wet/dry difference again, and this is the half of it the eye actually
  // reads: a damp sward under a shaft of sun throws a sheen back along the
  // blades, a dry one does not. Restrained even at the wet end — the
  // Kajiya-Kay lobe covers a whole hemisphere of half-vectors, so every blade
  // facing anywhere near the sun contributes at once.
  //
  // Faded and widened with range, which is specular anti-aliasing and not a
  // style choice. An exponent of 46 is a very tight lobe: it is the width of
  // the highlight on one blade, and it is correct while a blade covers several
  // pixels. Once a blade is smaller than a pixel the lobe is being point-
  // sampled — the pixel takes whichever half-vector its one sample happened to
  // land on — and the wind then rewrites that sample every frame. The result is
  // isolated pixels flashing to many times the surrounding brightness, which
  // the bloom pass faithfully turns into blinking specks scattered across every
  // distant slope.
  //
  // The fix is the one the micro-detail above already uses: as the blade is
  // widened for distance, converge the highlight on its own mean. Widening the
  // lobe and taking the strength down leaves a broad, stable sheen that no
  // longer resolves individual blades — which is what a field of grass a
  // kilometre away actually looks like.
  const sheenFade = microFade
  const sheenStrength = mix(float(0.042), float(0.014), underside)
    .mul(smoothstep(0.95, 0.35, fragmentRoughness).add(0.25))
    .mul(shapeVarying.z.mul(1.35).add(0.72))
    .mul(mix(float(0.14), float(1), sheenFade))
  const sheenExponent = mix(
    mix(float(6), float(46), sheenFade),
    float(12),
    fragmentRoughness,
  )

  const material = new GrassNodeMaterial(
    surfaceVarying.y,
    litColor.mul(vec3(0.95, 1.06, 0.72)),
    tangentViewSpace,
    vec2(sheenStrength, sheenExponent),
  )
  material.name = 'ground foliage blade'
  material.side = DoubleSide
  // Opaque. Every blade here is real geometry with a real silhouette, so there
  // is no cutout to test and no sorting to do — the multisampled scene pass
  // resolves the edges. That is the single largest performance decision in the
  // whole system: alpha-tested foliage forfeits early depth rejection over the
  // entire screen area the grass covers.
  material.transparent = false
  material.depthWrite = true
  material.metalness = 0
  material.roughness = 1

  material.positionNode = worldPosition
  material.normalNode = normalViewSpace
  material.colorNode = vec4(litColor, 1)
  material.roughnessNode = fragmentRoughness
  material.aoNode = surfaceVarying.z
  material.metalnessNode = float(0)

  return material
}
