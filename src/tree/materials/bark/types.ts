export interface BarkMaps {
  albedo: Uint8Array
  normal: Uint8Array
  /** ORM-compatible channels: R ambient occlusion, G/B roughness. */
  roughness: Uint8Array
  width: number
  height: number
  /** Runtime tangent-normal amplitude after the baked slope field. */
  normalScale: number
  /**
   * How readily this bark is colonised at ground level, 0..1. A structural
   * property of the species rather than of the frame: a wet-forest hardwood
   * is green to head height and a desert succulent never is.
   */
  mossiness: number
  /**
   * Coordinate domain used by every runtime channel. Palm leaf-base scars are
   * directional anatomy and must follow the swept bole UVs; isotropic plated
   * bark can use the seamless world projection needed across fork unions.
   */
  projection: 'world-triplanar' | 'axial-uv'
}

/** Authored sRGB triples the bark albedo is mixed between. */
export interface BarkPalette {
  /** Raw, damp, never-weathered tissue at the bottom of a fissure. */
  fissure: readonly [number, number, number]
  /** Sun-bleached, dried plate face. */
  crown: readonly [number, number, number]
  /** Cork newly exposed where a scale has shed. */
  fresh: readonly [number, number, number]
  /** Crustose lichen on the open crowns. */
  lichen: readonly [number, number, number]
  /** Moss in the damp shelter of the fissures. */
  moss: readonly [number, number, number]
}

/** Material family traits consumed by the bark baker. */
export interface BarkProfile {
  family: 'fissured-hardwood' | 'resinous-conifer'
  /**
   * Large-scale surface anatomy; colour and PBR packing remain shared.
   *
   * These are genuinely different constructions, not one field with different
   * constants. Running every bark through a single crack-network primitive and
   * varying its numbers is what collapsed the whole catalogue into two looks —
   * reptile skin and vertical dashes — with nothing recognisable as a species.
   *
   * - `scaled-plates`   overlapping cork scales grouped by shallow creases:
   *                     pine, spruce, acacia, mangrove, most mature hardwoods.
   * - `ridged-furrows`  deep vertical fibrous furrows: redwood, sequoia, cedar.
   * - `papery-strips`   horizontal peeling bands and lenticel dashes: birch.
   * - `mottled-smooth`  no fissuring at all, broad shedding patches: beech,
   *                     fig, gum eucalyptus, baobab.
   */
  structure?: 'cellular-plates' | 'columnar-fissures' | 'shallow-blocks' | 'palm-boots' |
    'palm-rings' | 'scaled-plates' | 'ridged-furrows' | 'papery-strips' | 'mottled-smooth'
  /** Plates around the bole's circumference in one tile. */
  columns: number
  /** How many times taller than wide a plate is. */
  plateAspect: number
  linkFrequency: readonly [number, number]
  minorFrequency: readonly [number, number]
  plateCyclesY: number
  /** Minimum depth retained on transverse edges of an anisotropic plate. */
  transverseFissureStrength?: number
  /**
   * Half-width of a major fissure, in column-cell units, before per-column
   * variation. A mature oak's fissures are one to three centimetres across on
   * a plate pitch near eighteen, so this is a substantial fraction of a cell —
   * not the hairline a crack-network primitive produces by default.
   */
  furrowHalfWidth: number
  /** Half-width of the cross-breaks that cut the columns into blocks. */
  linkHalfWidth: number
  /** How far a fissure cuts into the relief field. */
  furrowDepth: number
  furrowStrength: number
  normalStrength: number
  /** Species-specific material amplitude; bark anatomies need different relief. */
  runtimeNormalScale?: number
  projection?: 'world-triplanar' | 'axial-uv'
  /**
   * Overrides the structure's default ground-level moss colonisation, 0..1.
   * See `mossinessForStructure`.
   */
  mossiness?: number
  /** Profile-level weathering controls; omitted values preserve the shared defaults. */
  /**
   * How heavily the bole carries healed branch scars. A veteran hardwood is
   * covered in them; a young smooth-barked stem has almost none.
   */
  scarAmount?: number
  lichenAmount?: number
  mossAmount?: number
  grainAmount?: number
  /** How strongly fissure anatomy shifts albedo away from broad weathering. */
  fissureColorStrength?: number
  /**
   * Scales per plate cell. Above one the scales are finer than the fissure
   * network that groups them, which is the normal relationship; at one they
   * coincide and the surface reads as tiled.
   */
  scaleDensity?: number
  /** How many times taller than wide one scale is; defaults to `plateAspect`. */
  scaleAspect?: number
  /**
   * Spread of the per-scale height offsets. This is the control that decides
   * whether a bark reads as stacked flakes or as a cracked sheet, so it is the
   * first thing to reach for on a profile that looks flat.
   */
  scaleLift?: number
  /**
   * Weight of the third, chip-sized scale tier. Drop it toward zero on a bark
   * whose scales are already fine: at that point the two tiers are the same
   * size and averaging them turns the surface into gravel.
   */
  chipAmount?: number
  /** Crease width in cell units; narrower gives sharper, tighter fissures. */
  furrowWidth?: number
  /**
   * Fraction of the tile that is furrow, by area. Solved against the crease
   * field's own distribution at bake time, so it means the same thing whatever
   * the octave count and width happen to be.
   */
  furrowCoverage?: number
  /**
   * How strongly neighbouring scales differ in colour, 0..1+. Only smooth
   * barks with genuinely uniform cork — beech, birch — want this below one.
   */
  mosaicAmount?: number
  palette: BarkPalette
}
