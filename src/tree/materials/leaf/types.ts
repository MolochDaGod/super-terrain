/** Shared shapes for the leaf-spray atlas bake. */

export interface LeafSprayMaps {
  albedo: Uint8Array
  normal: Uint8Array
  /** R roughness, G translucency, B card-local ambient occlusion. */
  roughness: Uint8Array
  size: number
}

/**
 * How an organ is built, which decides both its outline and its arrangement.
 *
 * Outline and arrangement are not separable traits. A palm leaflet is a long
 * strap *because* a hundred of them are ranked along a three-metre rachis, and
 * a fern pinnule is small and toothed *because* it is one of a thousand on a
 * twice-divided frond. Reparameterising one family's blade to stand in for
 * another gives exactly what a squashed oak card gives a date palm: a spray of
 * thin green spikes.
 */
export type LeafFamily =
  /** Alternate lobed blades on a twiglet. Oak. */
  | 'broadleaf-lobed'
  /** Alternate entire elliptic blades on a twiglet. Fig, banyan, mangrove. */
  | 'broadleaf-simple'
  /** Dense needles in fascicles along a shoot. Pine, spruce. */
  | 'needle-fascicle'
  /** Leaflets radiating from one point on a long petiole. Ceiba, baobab. */
  | 'palmate'
  /** Strap leaflets ranked either side of a long rachis. Coconut, date. */
  | 'pinnate-frond'
  /** Twice-divided: pinnae off a rachis, pinnules off each pinna. Tree fern. */
  | 'fern-frond'
  /** Short overlapping scale leaves clasping a shoot. Araucaria. */
  | 'scale-spray'
  /** Thick lance leaves radiating from a terminal crown. Dragon blood, aloe. */
  | 'rosette'

/** The population of blade colours a species carries, as sRGB triples. */
export interface LeafPalette {
  /** Interior, low-light blades: darker, bluer, less saturated. */
  shade: readonly [number, number, number]
  /** Exposed blades: lighter and yellower. */
  sun: readonly [number, number, number]
  /** The tired minority. Kept rare. */
  weathered: readonly [number, number, number]
  /** Colour damaged and dried tissue blends toward. */
  necrosis: readonly [number, number, number]
}

/** Species traits the blade rasteriser and palette read from. */
export interface LeafProfile {
  family: LeafFamily
  /** Blade half-width as a fraction of blade length. */
  aspect: number
  /** Lobe pairs a mature blade carries. Ignored outside lobed families. */
  lobePairs: readonly [number, number]
  /** Leaflets one compound leaf carries, for palmate and frond families. */
  leaflets: readonly [number, number]
  /** Waxy cuticle response of the undamaged blade. */
  baseRoughness: number
  /** Blade transmittance between the veins. */
  translucency: number
  /** How much feeding damage and necrosis this foliage carries. */
  damage: number
  palette: LeafPalette
  /** Optional card-composition traits for species that diverge from a family default. */
  spray?: LeafSprayStyle
}

/**
 * Species-level variation within an organ family. A live oak and a beech both
 * carry simple blades, but their twig density, blade scale and presentation
 * angles are different enough that sharing one spray recipe looks repeated.
 */
export interface LeafSprayStyle {
  /** Multiplies blade length without changing the world-space card. */
  scale: number
  /** Multiplies the number of leaves borne by each authored shoot. */
  count: number
  /** Per-atlas-slot scale variation; layout variety must exceed a reseed. */
  variantScale: readonly [number, number, number, number]
  /** Lowest cosine of blade tilt; smaller values admit edge-on blades. */
  minimumSquash: number
  /** Exponent applied to random tilt. Larger values produce more edge-on blades. */
  tiltExponent: number
  /** Random angular deviation in radians. */
  angleJitter: number
  /** Peak-to-peak curl amplitude written into the normal field. */
  curl: number
  /** Stable within-species blade-size population. */
  sizeVariation: readonly [number, number]
  /** Chlorophyll-density population. */
  pigment: readonly [number, number]
  /** Petiole length as a fraction of blade length. */
  petiole: readonly [number, number]
  /** Multiplies the authored shoot length inside the card. */
  axisScale?: number
  /** Multiplies side-shoot spread without changing blade size. */
  spreadScale?: number
  /** Multiplies rasterised shoot widths; useful for fine evergreen twiglets. */
  shootWidthScale?: number
}

/** One blade placed on a shoot, in 0..1 card space. */
export interface LeafPlacement {
  /** Petiole attachment. */
  x: number
  y: number
  /** Direction the blade points, radians, 0 = +x. */
  angle: number
  length: number
  /** Half-width as a fraction of length. */
  width: number
  /** Foreshortening from the leaf's own tilt out of the card plane. */
  squash: number
  /** Per-leaf chlorophyll density: restrained biological, not light, variation. */
  pigment: number
  /** Stable variation shared by outline, maturity, and local pigment noise. */
  variation: number
  /** Higher is nearer the viewer and decides overdraw only. */
  depth: number
  curl: number
  /** Petiole length as a fraction of blade length. */
  petiole: number
}

export interface ShootSegment {
  fromX: number
  fromY: number
  toX: number
  toY: number
  width: number
}

export interface SprayComposition {
  /** Side shoots off the main axis. */
  primaryCount: number
  /** Chance a side shoot forks again. */
  secondaryChance: number
  /** Leaves carried by the main axis. */
  axisLeaves: number
  /** Leaves carried by each side shoot. */
  sideLeaves: number
  /** Blade length as a fraction of the card. */
  leafScale: number
  /** How far up the card the axis reaches. */
  axisTop: number
  /** How far the side shoots reach across it. */
  spread: number
}

/**
 * The per-texel fields every rasteriser writes into, kept as one bundle so a
 * draw call takes a surface rather than eight positional arrays.
 */
export interface SprayFields {
  size: number
  alpha: Float32Array
  height: Float32Array
  /** Straight-alpha linear RGB, three floats per texel. */
  tint: Float32Array
  surfaceRoughness: Float32Array
  translucency: Float32Array
  /** Painter's-algorithm depth, so a nearer blade wins on depth not relief. */
  depthBuffer: Float32Array
  /**
   * How many blades have covered this texel. A card is one flat plane, so the
   * mutual shadowing of the twenty blades it stands in for cannot happen at
   * render time; it has to be measured here.
   */
  layers: Float32Array
  /**
   * The orientation of the blade owning each texel, in card tangent space,
   * three floats per texel.
   *
   * A card stands in for a twiglet whose blades face every which way, and the
   * only record of which way any one of them faces is how foreshortened it was
   * drawn. Deriving the whole normal map from the height field throws that
   * away: every blade comes back with a normal pointing straight at the
   * viewer, so all twenty light identically and the spray reads as a sheet of
   * stickers laid flat under glass. Carrying the plane each blade actually sits
   * in is what lets one blade catch the sun while the one beside it does not.
   */
  basis: Float32Array
}

export function createSprayFields(size: number): SprayFields {
  const pixels = size * size
  return {
    size,
    alpha: new Float32Array(pixels),
    height: new Float32Array(pixels),
    tint: new Float32Array(pixels * 3),
    surfaceRoughness: new Float32Array(pixels),
    translucency: new Float32Array(pixels),
    depthBuffer: new Float32Array(pixels),
    layers: new Float32Array(pixels),
    basis: new Float32Array(pixels * 3),
  }
}
