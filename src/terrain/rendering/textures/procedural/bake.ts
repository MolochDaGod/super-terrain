import {
  blurField,
  createField,
  type Field,
  slopeField,
  curvatureField,
  stretchField,
} from './field'
import { cavityField, horizonOcclusion, type AoOptions } from './occlusion'
import {
  encodeLinear,
  encodeSrgb,
  heightToNormal,
  packArm,
  type Rgb,
} from './encode'
import { clamp01 } from './noise'

/** A complete PBR set for one tiling surface, ready to upload. */
export interface ProceduralMaterialMaps {
  id: string
  size: number
  /** sRGB-encoded RGBA. */
  albedo: Uint8Array
  /** OpenGL-convention tangent-space normal, RGBA. */
  normal: Uint8Array
  /** Occlusion, roughness, metalness, and the surface height in alpha. */
  arm: Uint8Array
  /** Metres spanned by one tile; lets callers pick a real-world UV scale. */
  physicalWidth: number
  /** Peak-to-trough relief in metres, for parallax and displacement scaling. */
  reliefDepth: number
}

/** Fields the shading stage can read, indexed the same way as the output. */
export interface SurfaceFields {
  /** Final surface height in [0,1]. Drives normal, AO and displacement. */
  height: Field
  /** Named auxiliary fields (masks, mineral mixes, sediment) for shading. */
  data?: Record<string, Field>
  /** Overrides for the occlusion sweep. */
  ao?: AoOptions
  /** Multiplies the physically derived normal strength. */
  normalBoost?: number
}

export interface SurfaceContext {
  index: number
  x: number
  y: number
  u: number
  v: number
  height: number
  /** Height with the broad forms removed; the grain-scale component. */
  detail: number
  /** Horizon-based visibility in [0,1]. */
  ao: number
  /** Local concavity in [0,1]; 0.5 is flat, below is a crack. */
  cavity: number
  /** Positive on ridges and edges, negative in hollows. */
  curvature: number
  /** Slope magnitude, normalised to [0,1] over the tile. */
  slope: number
  data: Record<string, Field>
}

export interface SurfaceShading {
  albedo: Rgb
  roughness: number
  metalness?: number
  /** Optional extra AO multiplier for material-specific contact darkening. */
  occlusion?: number
}

/** Fields available to the post-geometry weathering stage. */
export interface DerivedFields {
  height: Field
  ao: Field
  cavity: Field
  slope: Field
  data: Record<string, Field>
}

export interface SurfaceRecipe {
  id: string
  /** Metres across one tile. */
  physicalWidth: number
  /** Metres from the lowest to the highest point of the tile. */
  reliefDepth: number
  build: (size: number, seed: number) => SurfaceFields
  /**
   * Optional weathering stage. It runs once the height and its occlusion are
   * final, so stains, dust and drainage can be derived from the surface that
   * actually exists rather than from the intermediate fields that produced
   * it. Whatever it returns is merged into the shading context's data.
   */
  derive?: (fields: DerivedFields, seed: number) => Record<string, Field>
  shade: (context: SurfaceContext) => SurfaceShading
}

/**
 * Runs a recipe and encodes the four maps.
 *
 * The split matters: `build` produces the geometry of the surface, and every
 * shading decision then reads back from that geometry. Deriving colour,
 * roughness and occlusion from the same height that drives the normal is what
 * keeps the lobes physically in agreement, which is the property a stack of
 * independently authored noise layers never has.
 */
export function bakeSurface(
  recipe: SurfaceRecipe,
  size: number,
  seed = 1,
): ProceduralMaterialMaps {
  const fields = recipe.build(size, seed)
  const height = fields.height
  const data = fields.data ?? {}

  const metresPerPixel = recipe.physicalWidth / size
  const ao = horizonOcclusion(height, {
    directions: 16,
    radius: Math.max(8, size / 32),
    // The sweep works in pixel space, so relief has to be expressed the same
    // way for the horizon angles to be geometrically correct.
    heightScale: recipe.reliefDepth / metresPerPixel,
    intensity: 1.1,
    ...fields.ao,
  })
  const cavity = cavityField(height, Math.max(2, size / 256), 1.4)
  const curvature = curvatureField(height, Math.max(1, size / 512))
  const slope = stretchField(slopeField(height), 0.01, 0.99)
  const low = blurField(height, Math.max(3, size / 96))

  if (recipe.derive) {
    const derived = recipe.derive({ height, ao, cavity, slope, data }, seed)
    for (const [name, field] of Object.entries(derived)) {
      assertFinite(field, `${recipe.id} weathering field "${name}"`)
    }
    Object.assign(data, derived)
  }

  const albedo = new Uint8Array(size * size * 4)
  const roughness = createField(size)
  const metalness = createField(size)
  const occlusion = createField(size)

  // Curvature magnitudes depend on resolution, so they are rescaled to a
  // stable [-1,1] before the recipes see them.
  let curvatureScale = 0
  for (let i = 0; i < curvature.data.length; i += 1) {
    const a = Math.abs(curvature.data[i]!)
    if (a > curvatureScale) curvatureScale = a
  }
  curvatureScale = curvatureScale > 0 ? 1 / curvatureScale : 1

  const context: SurfaceContext = {
    index: 0,
    x: 0,
    y: 0,
    u: 0,
    v: 0,
    height: 0,
    detail: 0,
    ao: 1,
    cavity: 0.5,
    curvature: 0,
    slope: 0,
    data,
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x
      context.index = i
      context.x = x
      context.y = y
      context.u = x / size
      context.v = y / size
      context.height = height.data[i]!
      context.detail = height.data[i]! - low.data[i]!
      context.ao = ao.data[i]!
      context.cavity = cavity.data[i]!
      context.curvature = curvature.data[i]! * curvatureScale
      context.slope = slope.data[i]!

      const shading = recipe.shade(context)
      albedo[i * 4] = encodeSrgb(shading.albedo.r)
      albedo[i * 4 + 1] = encodeSrgb(shading.albedo.g)
      albedo[i * 4 + 2] = encodeSrgb(shading.albedo.b)
      albedo[i * 4 + 3] = 255
      roughness.data[i] = clamp01(shading.roughness)
      metalness.data[i] = clamp01(shading.metalness ?? 0)
      occlusion.data[i] = clamp01(ao.data[i]! * (shading.occlusion ?? 1))
    }
  }

  const normalStrength =
    (recipe.reliefDepth / metresPerPixel / 8) * (fields.normalBoost ?? 1)

  return {
    id: recipe.id,
    size,
    albedo,
    normal: heightToNormal(height, normalStrength),
    arm: packArm(occlusion, roughness, metalness, height),
    physicalWidth: recipe.physicalWidth,
    reliefDepth: recipe.reliefDepth,
  }
}

export { encodeLinear }

/**
 * Guards against a field silently going non-finite.
 *
 * Every stage here is a numeric pipeline, and a single NaN spreads through
 * blurs and percentile stretches until an entire map encodes as zero — which
 * looks like a plausible-but-wrong material rather than an error. Checking is
 * cheap next to the bake itself.
 */
export function assertFinite(field: Field, label: string): Field {
  for (let i = 0; i < field.data.length; i += 1) {
    if (!Number.isFinite(field.data[i]!)) {
      throw new Error(`${label} produced a non-finite value at index ${i}`)
    }
  }
  return field
}
