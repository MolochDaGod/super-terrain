import { DataTexture, RGBAFormat, UnsignedByteType, Vector2 } from 'three/webgpu'
import * as TSL from 'three/tsl'
import type { FoliageMaskField } from './FoliageMaskField'
import { FOLIAGE_SURFACE_ROWS } from './foliageSurfaces'
import {
  SURFACE_ROUGHNESS,
  duffColour,
  duffCover,
  litterColour,
  litterCover,
  mossed,
  wetness,
} from './foliageGroundCanopy'

/** See the note in the foliage materials — these are node builders, not maths. */
type ShaderValue = any

const { clamp, float, mix, texture, uniform, vec3 } =
  TSL as unknown as Record<string, ShaderValue>

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

/** Window centre in world XZ, matching `FoliageMaskField.origin`. */
export const forestFloorOrigin = uniform(new Vector2())
/** Window edge in metres. */
export const forestFloorFieldSize = uniform(1)
/** 0 while no mask is bound, which is every world with no forests in it. */
export const forestFloorStrength = uniform(0)

const surfaceNodes = placeholders.map((placeholder) => texture(placeholder))

export function bindForestFloorMask(mask: FoliageMaskField): void {
  mask.surfaces.forEach((surface, row) => {
    const node = surfaceNodes[row]
    if (node) node.value = surface
  })
  forestFloorFieldSize.value = mask.fieldSize
  forestFloorStrength.value = 1
}

export function unbindForestFloorMask(): void {
  surfaceNodes.forEach((node, row) => {
    node.value = placeholders[row]
  })
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
  /** 0..1, how completely the floor has taken over. Useful for normals. */
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
  worldXZ: ShaderValue,
): ForestFloorBlend {
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

  const cover = clamp(
    litterMix.add(duffMix).add(mossCover).add(bareWeight.mul(0.9)),
    0,
    1,
  )

  return {
    colour: mix(colour, floorColour, cover),
    roughness: mix(roughness, layeredRoughness, cover),
    cover,
  }
}
