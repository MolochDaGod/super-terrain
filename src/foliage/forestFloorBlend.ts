import { DataTexture, RGBAFormat, UnsignedByteType, Vector2 } from 'three/webgpu'
import * as TSL from 'three/tsl'
import type { FoliageMaskField } from './FoliageMaskField'
import { SWARD_COLOUR_SCALE } from './foliageSpecies'
import { FOLIAGE_SURFACE_ROWS } from './foliageSurfaces'
import { FOLIAGE_INSTANCED_RANGE } from './FoliagePopulation'
import { foliageCameraPosition } from './foliageRuntime'
import { fbm2 } from './foliageNoise'
import {
  CANOPY_GAIN,
  SURFACE_ROUGHNESS,
  duffColour,
  duffCover,
  litterColour,
  litterCover,
  litterHeight,
  mossed,
  wetness,
} from './foliageGroundCanopy'
import { valueNoise2 } from './foliageNoise'

/** See the note in the foliage materials — these are node builders, not maths. */
type ShaderValue = any

const {
  clamp, float, fwidth, mix, normalize, smoothstep, texture, uniform, vec2, vec3,
} = TSL as unknown as Record<string, ShaderValue>

/**
 * The forest floor, applied to the terrain's own surface.
 *
 * This is the answer to the edge problem, and the reason it is solved here
 * rather than by drawing a second ground.
 *
 * A forest laid on terrain has to change what the ground *is*: leaf litter,
 * needle duff, moss and bare scuffed earth instead of the rock, scree and turf
 * the terrain shades by default. The obvious implementation is a second
 * surface — the flat ground plane the tree lab already draws — laid over the
 * terrain inside the field. It cannot work at any quality: two surfaces a few
 * centimetres apart z-fight along every square metre they share, and wherever
 * the upper one ends there is a hard silhouette edge, which is precisely the
 * "ground texture suddenly changes" the fringe is supposed to prevent.
 *
 * So the terrain shades the floor itself, weighted by the same painted mask
 * the plants grow from. The mask's weights are already feathered across the
 * field's boundary — that is what `ForestField.feather` does — so the litter
 * fades into the hillside over tens of metres with no seam anywhere, and it
 * does so over the real, sculpted, streamed ground rather than over a plane
 * pretending to be it.
 *
 * Bound at runtime rather than at material construction because the terrain
 * material is built by the section compiler, which runs long before anything
 * has decided whether this world has forests in it. The nodes below hold a 1×1
 * transparent placeholder until a ground-cover layer mounts and hands over its
 * mask; `strength` is zero until then, so an unbound blend costs one multiply
 * by a constant and changes nothing.
 */

function placeholderTexture(): DataTexture {
  const texture = new DataTexture(
    new Uint8Array([0, 0, 0, 0]),
    1,
    1,
    RGBAFormat,
    UnsignedByteType,
  )
  texture.name = 'forest-floor-mask-placeholder'
  texture.needsUpdate = true
  return texture
}

const placeholders = Array.from({ length: FOLIAGE_SURFACE_ROWS }, placeholderTexture)
const swardPlaceholder = placeholderTexture()

/** Window centre in world XZ, matching `FoliageMaskField.origin`. */
export const forestFloorOrigin = uniform(new Vector2())
/** Window edge in metres. */
export const forestFloorFieldSize = uniform(1)
/** 0 while no mask is bound, which is every world with no forests in it. */
export const forestFloorStrength = uniform(0)

const surfaceNodes = placeholders.map((placeholder) => texture(placeholder))
/** rgb is the plants' aggregate colour, a their total. See `FoliageMaskField.sward`. */
const swardNode = texture(swardPlaceholder)

export function bindForestFloorMask(mask: FoliageMaskField): void {
  mask.surfaces.forEach((surface, row) => {
    const node = surfaceNodes[row]
    if (node) node.value = surface
  })
  swardNode.value = mask.sward
  forestFloorFieldSize.value = mask.fieldSize
  forestFloorStrength.value = 1
}

export function unbindForestFloorMask(): void {
  surfaceNodes.forEach((node, row) => {
    node.value = placeholders[row]
  })
  swardNode.value = swardPlaceholder
  forestFloorStrength.value = 0
}

/** Keeps the sampled window in step with the mask's own. */
export function setForestFloorOrigin(x: number, z: number): void {
  forestFloorOrigin.value.set(x, z)
}

export interface ForestFloorBlend {
  /** Terrain colour with the floor layered over it. */
  colour: ShaderValue
  /** Terrain roughness moved toward the floor's. */
  roughness: ShaderValue
  /**
   * The shading normal, with the terrain's own rock relief given up to the
   * floor's.
   *
   * The single most important output, and the one the first pass of this
   * omitted. Blending only colour and roughness leaves every strata band,
   * block edge and scree facet the terrain shader draws standing in full
   * relief under the litter — so a forest floor comes out as a rocky field
   * that happens to be brown, which is exactly what it looked like.
   */
  normal: ShaderValue
  /** Multiplier for ambient occlusion: the shadow between the leaves. */
  ao: ShaderValue
  /** 0..1, how completely the floor has taken over. */
  cover: ShaderValue
}

/**
 * Layers the painted floor over whatever the terrain shaded.
 *
 * The layer order is the one the ground canopy uses and for the same reasons,
 * so a patch of moss on a terrain hillside and the same patch on the lab's
 * floor are the same moss: mineral soil showing through where it is scuffed,
 * litter and duff over the top of that, moss last because it grows on
 * everything else.
 */
export function forestFloorBlend(
  colour: ShaderValue,
  roughness: ShaderValue,
  /** The terrain's own shading normal, in world space. */
  shadedNormal: ShaderValue,
  /** The terrain's geometric normal, in world space. */
  geometricNormal: ShaderValue,
  /** The shaded point in world space. */
  worldPosition: ShaderValue,
): ForestFloorBlend {
  const worldXZ = worldPosition.xz
  const fieldUv = worldXZ
    .sub(forestFloorOrigin)
    .div(forestFloorFieldSize)
    .add(0.5)
  // One row is enough: the four channels the terrain floor cares about —
  // litter, duff, moss and bare earth — are all in it. See `foliageSurfaces`.
  const row: ShaderValue = surfaceNodes[0]!.sample(fieldUv)

  const weights = row.mul(forestFloorStrength)
  const litterWeight = clamp(weights.x, 0, 1)
  const duffWeight = clamp(weights.y, 0, 1)
  const mossWeight = clamp(weights.z, 0, 1)
  const bareWeight = clamp(weights.w, 0, 1)

  const damp = wetness(worldXZ)

  // Mineral soil under a scuff: paler, warmer and drier than the humus around
  // it. Derived from the terrain's own colour rather than from a constant, so a
  // scuff on granite scree and one on a grass slope are each the right ground
  // with its own litter taken off.
  const mineral = colour.mul(vec3(1.28, 1.16, 0.98))
  const humus = colour.mul(
    mix(vec3(1, 1, 1), vec3(0.52, 0.55, 0.44), clamp(litterWeight.add(mossWeight), 0, 1)),
  )
  const base = mix(humus, mineral, bareWeight.mul(0.9))

  const litterMix = litterWeight.mul(litterCover(worldXZ))
  const duffMix = duffWeight.mul(duffCover(worldXZ))
  const withLitter = mix(base, litterColour(worldXZ, damp), litterMix)
  const withDuff = mix(withLitter, duffColour(worldXZ, damp), duffMix)
  const mossResult = mossed(withDuff, worldXZ, mossWeight, damp)
  const floorColour = mossResult.xyz
  const mossCover = mossResult.w

  const layeredRoughness = mix(
    mix(
      mix(
        mix(roughness, float(SURFACE_ROUGHNESS[0]!), litterMix),
        float(SURFACE_ROUGHNESS[1]!),
        duffMix,
      ),
      float(SURFACE_ROUGHNESS[2]!),
      mossCover,
    ),
    float(SURFACE_ROUGHNESS[3]!),
    bareWeight.mul(0.85),
  )

  // Saturating rather than summing to exactly one.
  //
  // The layers overlap — litter drifts across moss, moss grows over litter —
  // so their coverages are not shares of a whole and adding them up
  // underestimates how much floor there is. A stand's interior should be
  // entirely floor; the gain is what gets it there while leaving the fringe,
  // where every weight is small, still mostly hillside.
  // Faded out with range, and it has to be.
  //
  // The mask is a compute-written `StorageTexture` with no mipmaps — building
  // them would cost a blit per brush stroke, which is why it does not — so a
  // pixel covering many of its two-metre cells point-samples one of them. Past
  // a few hundred metres that is exactly the salt-and-pepper speckle you see
  // scattered over a distant forest floor, and it is not a subtle artefact:
  // neighbouring pixels land on unrelated cells.
  //
  // Fading is also the correct answer independent of the aliasing. Leaf litter,
  // needle duff and moss are centimetre-to-decimetre structures; at half a
  // kilometre none of them is resolvable and what the eye reads is the sward
  // and the canopy above it, both of which carry their own distance ramps and
  // are unaffected by this.
  const range = worldPosition
    .sub(foliageCameraPosition)
    .length()
    .toVar('forestFloorRange')
  const detailFade = smoothstep(190, 520, range).oneMinus()
  const cover = clamp(
    litterMix.add(duffMix).add(mossCover).add(bareWeight.mul(0.9)).mul(1.45),
    0,
    1,
  ).mul(detailFade).toVar('forestFloorCover')

  // Read before the relief block, which now consults it: grass sheds the
  // terrain's rock relief the same way litter does.
  const swardSample: ShaderValue = swardNode.sample(fieldUv)
  const swardCover = clamp(swardSample.a.mul(forestFloorStrength), 0, 1)

  // --- relief ---------------------------------------------------------------
  //
  // The floor's own shape, and the terrain's given up to make room for it.
  // Two tiers, as in the ground canopy: seven centimetres carrying the leaf
  // plates, two carrying the grain between them, the fine tier faded out the
  // moment a pixel is wider than the feature so it cannot alias.
  const footprint = fwidth(worldXZ).length().max(0.0005)
  const grainFade = smoothstep(0.09, 0.02, footprint)
  const slopeAt = (offset: number, gain: number): ShaderValue => {
    const dx = litterHeight(worldXZ.add(vec2(offset, 0)))
      .sub(litterHeight(worldXZ.sub(vec2(offset, 0))))
    const dz = litterHeight(worldXZ.add(vec2(0, offset)))
      .sub(litterHeight(worldXZ.sub(vec2(0, offset))))
    return vec2(dx.mul(gain), dz.mul(gain))
  }
  const litterSlope = slopeAt(0.035, 4.6).add(slopeAt(0.011, 2.4).mul(grainFade))
  // Moss cushions are rounder and coarser than the litter under them.
  const mossBump = valueNoise2(worldXZ.mul(3.4).add(vec2(11.1, 4.7)))
  const mossSlope = vec2(
    valueNoise2(worldXZ.mul(3.4).add(vec2(11.35, 4.7))).sub(mossBump).mul(6),
    valueNoise2(worldXZ.mul(3.4).add(vec2(11.1, 4.95))).sub(mossBump).mul(6),
  )
  // Bare earth keeps the mineral relief it actually has, so a scuff still
  // reads as ground rather than as a hole in the leaves.
  const floorSlope = mix(litterSlope, mossSlope, mossCover.mul(0.6))
    .mul(bareWeight.mul(0.65).oneMinus())

  // The rock relief has to *go*, not be drawn over. Bedding planes and block
  // edges are metre-scale features an inch of leaf litter cannot hide, so
  // under full cover the shading normal falls back to the geometry — the
  // hillside keeps its shape and loses its strata — and the floor's own
  // millimetre relief is added to that.
  // Grass hides bedding planes and block edges just as litter does, so the
  // rock relief has to recede under either of them, not only under litter.
  const shed = clamp(cover.max(swardCover.mul(0.82)), 0, 1).toVar('forestFloorShed')
  const bedrock = mix(shadedNormal, geometricNormal, shed.mul(0.88))
  const normal = normalize(
    bedrock.add(vec3(floorSlope.x.negate(), 0, floorSlope.y.negate()).mul(cover)),
  )

  // A leaf lying on the pile sees the whole sky; the gap it lies across sees
  // almost none. That difference is most of what stops dead leaves reading as
  // a printed texture.
  const ao = mix(float(1), litterHeight(worldXZ).mul(0.62).add(0.38), cover)

  // --- the sward the blades stand in -----------------------------------------
  //
  // The half of the floor that was missing, and the reason a forest grown on
  // terrain came out brown where the same recipe in the tree lab comes out
  // green.
  //
  // The lab draws a flat ground plane whose material carries two things: the
  // painted surface layers — litter, duff, moss, earth — and, over the top of
  // them, the *aggregate colour of the plants*. That second term is not a
  // distance fallback for the instanced blades; the blades stand in it at every
  // range, which is what stops a sward from thinning into bare soil between
  // clumps as the near ring gives out. On terrain the ground plane is turned
  // off — the terrain is the ground — and the first version of this blend
  // ported only the surface layers, so the floor had leaf litter and no sward
  // at all under it.
  // Nudged toward the green primary, as the canopy is: AgX rolls the sunlit
  // half of a wide field well up its curve, and a curve that desaturates as it
  // compresses turns an accurate green into cream long before it clips.
  const swardBase = swardSample.rgb
    .div(float(SWARD_COLOUR_SCALE))
    .mul(vec3(0.88, 1.02, 0.8))

  // How much of the read the sheet carries, against range. Close up the
  // instanced blades are drawing the real thing and painting the ground under
  // them full green as well buries the litter, the twigs and the relief in
  // paint; past the last ring it is the only sward there is. This is the same
  // ramp and the same constants the ground canopy uses, so the two agree by
  // construction rather than by two numbers kept in step by hand.
  const shading = smoothstep(
    FOLIAGE_INSTANCED_RANGE * 0.06,
    FOLIAGE_INSTANCED_RANGE * 0.8,
    range,
  )
  // Broad variation, so a hillside of it is not one flat green.
  const mottle = clamp(float(0.5).add(fbm2(worldXZ.mul(0.085)).sub(0.5).mul(0.7)), 0, 1)
  const sward = swardBase
    .mul(CANOPY_GAIN)
    .mul(mix(float(0.66), float(1.3), mottle))
    .mul(mix(float(0.72), float(1), shading))
  // Not multiplied by `cover`, and that is the whole of the far-distance fix.
  //
  // The sward and the floor layers are independent things: `cover` is how much
  // leaf litter, duff and moss lie on the ground, and `swardCover` is how many
  // plants stand in it. Gating one on the other meant the aggregate colour of
  // the plants could only appear where a *forest floor* had been painted — so
  // on open hillside, where there is grass and no litter, the sward term was
  // multiplied by zero. Inside the last instanced ring that is invisible,
  // because the blades themselves are drawing the grass. Past it there are no
  // blades and nothing replaced them, so a green slope walked away from the
  // camera and turned into bare terrain material at a fixed distance — which
  // is exactly the "underlying texture dominates when you zoom out" symptom.
  //
  // Capped well below one at both ends, which is the other half of the fix.
  // `sward.a` is the *sum* of every species weight clamped to one, so any
  // ground carrying three or four plants at once saturates it — and with open
  // grassland painting seven species that is nearly everywhere there is grass
  // at all. Left uncapped, the far-distance term then replaces the terrain
  // colour outright and a whole world of pasture, gravel, scars and thin
  // ground resolves to one flat plant green with no soil anywhere in it.
  //
  // A real grassland seen from a kilometre is not an opaque canopy. It is
  // plants with ground between them, and the ground is most of what gives a
  // hillside its variation at that range — which is exactly the variation the
  // terrain material underneath has just spent its whole budget computing.
  // Three quarters is enough for the sward to carry the colour and not enough
  // for it to erase what it is standing on.
  const swardStrength = swardCover.mul(mix(float(0.26), float(0.74), shading))

  return {
    colour: mix(mix(colour, floorColour, cover), sward, swardStrength),
    // Grass is glossier than litter and than rock, and its gloss varies with
    // the tuft structure — which is what gives a distant slope of it the
    // shifting sheen that says grass rather than paint.
    roughness: mix(mix(roughness, layeredRoughness, cover), float(0.62), swardStrength),
    normal,
    ao,
    cover,
  }
}
