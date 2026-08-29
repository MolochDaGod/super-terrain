/**
 * The ground itself, as paintable layers rather than as constants in a shader.
 *
 * A forest floor is not one material. Underneath everything there is soil;
 * over most of it lies a loose bed of dead leaves or, under conifers, a mat of
 * needles; moss runs across whatever has been lying still long enough; and
 * where a root has been scuffed or a boar has been rooting, the bare mineral
 * earth shows through. Those are four different surfaces with four different
 * albedos, four different reliefs and four different roughness responses, and
 * which of them is where is a property of the *place*, not of the renderer.
 *
 * They used to be neither. `litter` was a number handed to the ground material
 * at construction and `moss` was switched on inside it, so the floor a preset
 * opened with could not be repainted, could not be erased, and could not vary
 * across the ground — the eraser thinned the plants standing on the floor and
 * left the floor exactly as it was, which is the "I cannot erase the defaults"
 * that started this. Putting them in the paint mask alongside the plants makes
 * them ordinary data: seeded by a preset, painted by a brush, erased by the
 * eraser, and sampled by the material rather than compiled into it.
 *
 * Four is not an arbitrary number. It is one `vec4` per mask cell, which is
 * one extra storage row and one extra texture fetch for the whole system.
 */
export type FoliageSurfaceId =
  | 'leaf-litter'
  | 'needle-duff'
  | 'ground-moss'
  | 'bare-earth'

export interface FoliageSurface {
  id: FoliageSurfaceId
  label: string
  hint: string
  /** UI swatch, in the family of the shaded result. */
  swatch: string
  /**
   * How rough the layer reads when it is dry, and how much drier-than-average
   * ground moves it. Damp humus is markedly glossier than dry duff, and that
   * difference is most of what makes a floor react to a shaft of light.
   */
  roughness: number
  /** Metres of relief the layer stands in, for the ground normal. */
  relief: number
}

/**
 * Channel order is the shader's contract: `x` is leaf litter, `y` needle duff,
 * `z` moss and `w` bare earth. The ground material indexes the sampled vec4 by
 * those names, so reordering this list changes the floor.
 */
export const FOLIAGE_SURFACES: readonly FoliageSurface[] = [
  {
    id: 'leaf-litter',
    label: 'Leaf litter',
    hint: 'Fallen broadleaf · the floor of a beech or oak stand',
    swatch: '#7a5a33',
    roughness: 0.86,
    relief: 0.035,
  },
  {
    id: 'needle-duff',
    label: 'Needle duff',
    hint: 'Packed conifer needles · fine, dark and even',
    swatch: '#4a3b28',
    roughness: 0.94,
    relief: 0.018,
  },
  {
    id: 'ground-moss',
    label: 'Ground moss',
    hint: 'Moss film over litter, roots and stone',
    swatch: '#3f6b34',
    roughness: 0.7,
    relief: 0.028,
  },
  {
    id: 'bare-earth',
    label: 'Bare earth',
    hint: 'Scuffed mineral soil · roots, tracks and slips',
    swatch: '#8b7355',
    roughness: 0.97,
    relief: 0.012,
  },
]

export const FOLIAGE_SURFACE_COUNT = FOLIAGE_SURFACES.length

/** One `vec4` row per cell. The whole point of choosing four. */
export const FOLIAGE_SURFACE_ROWS = Math.ceil(FOLIAGE_SURFACE_COUNT / 4)

export function foliageSurfaceIndex(id: FoliageSurfaceId): number {
  const index = FOLIAGE_SURFACES.findIndex((surface) => surface.id === id)
  return index < 0 ? 0 : index
}
