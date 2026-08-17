import type { CameraPreset } from './scene'

/**
 * Fixed viewpoints used for every visual review pass. They are deliberately
 * chosen to mirror the three reference frames: a hero vista with receding
 * ridges, a close cliff face, and a low camera sitting in the vegetation.
 * Keeping them fixed is what makes successive passes comparable.
 */
export const CAMERA_PRESETS: CameraPreset[] = [
  {
    // Valley floor looking across at the massif: overlapping ridge planes,
    // strong aerial perspective, the reference "hero vista".
    label: 'vista',
    position: [-150, 96, 250],
    target: [620, 210, 330],
    fov: 40,
  },
  {
    // Close on the steep west face, where strata terracing produces real
    // vertical rock. This is the frame that judges the rock material.
    label: 'cliff',
    position: [230, 96, 150],
    target: [540, 190, 215],
    fov: 42,
  },
  {
    // Eye height in the meadow with the range behind: judges foreground
    // ground detail, vegetation and near-field parallax.
    label: 'meadow',
    position: [60, 1.7, 120],
    target: [600, 190, 300],
    fov: 52,
    groundRelative: true,
  },
  {
    // Standing in the turf, looking along the ground at a rock outcrop a few
    // metres away. Nothing else in the set gets close enough to judge the
    // near-field detail band, which is where reference C is won or lost.
    label: 'closeup',
    position: [92, 1.6, 236],
    target: [140, 6, 205],
    fov: 55,
    groundRelative: true,
  },
  {
    // From the summit looking back down the ranges: judges LOD continuity,
    // silhouette quality and long-range haze.
    label: 'ridgeline',
    position: [1_150, 470, 900],
    target: [-160, 90, -120],
    fov: 34,
  },

  // --- authored mesh-terrain topology ----------------------------------
  // These fixed views face the real modifier portals. They deliberately keep
  // the compile radius tight so visual checks exercise the CSG itself instead
  // of rebuilding an unrelated continent around it.
  {
    label: 'cave',
    position: [300, 150, -10],
    target: [448, 112, 32],
    fov: 48,
    radiusSections: 4,
  },
  {
    label: 'cave-high',
    position: [300, 210, 80],
    target: [480, 149, 128],
    fov: 48,
    radiusSections: 4,
  },
  {
    label: 'arch',
    position: [330, 300, 120],
    target: [592, 252, 224],
    fov: 48,
    radiusSections: 4,
  },
  {
    label: 'escarpment',
    position: [280, 225, -180],
    target: [455, 155, -88],
    fov: 50,
    radiusSections: 2,
  },
  {
    label: 'topology',
    position: [230, 280, -90],
    target: [540, 190, 140],
    fov: 48,
    radiusSections: 3,
  },
]
