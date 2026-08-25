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
  /** Large-scale surface anatomy; colour and PBR packing remain shared. */
  structure?: 'cellular-plates' | 'columnar-fissures' | 'shallow-blocks' | 'palm-boots' |
    'palm-rings'
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
  palette: BarkPalette
}
