import type { LeafPalette, LeafProfile } from './types'

const SAVANNA: LeafPalette = {
  shade: [0.16, 0.245, 0.13], sun: [0.3, 0.39, 0.17],
  weathered: [0.36, 0.32, 0.14], necrosis: [0.34, 0.27, 0.11],
}
const EUCALYPTUS: LeafPalette = {
  shade: [0.15, 0.23, 0.205], sun: [0.27, 0.35, 0.29],
  weathered: [0.34, 0.32, 0.23], necrosis: [0.35, 0.27, 0.16],
}
const BROADLEAF: LeafPalette = {
  shade: [0.17, 0.265, 0.145], sun: [0.3, 0.42, 0.195],
  weathered: [0.34, 0.31, 0.14], necrosis: [0.32, 0.25, 0.12],
}
const CONIFER: LeafPalette = {
  shade: [0.125, 0.2, 0.16], sun: [0.205, 0.3, 0.22],
  weathered: [0.26, 0.26, 0.17], necrosis: [0.28, 0.22, 0.13],
}
const LIVE_OAK: LeafPalette = {
  // Evergreen live-oak foliage is deep, leathery olive. The former generic
  // broadleaf palette put its median near fresh spring lime and the scatter
  // shader lifted it again, producing the fluorescent crown seen in v19.
  shade: [0.15, 0.245, 0.125], sun: [0.245, 0.365, 0.16],
  weathered: [0.27, 0.26, 0.11], necrosis: [0.265, 0.215, 0.095],
}

/** Additional species profiles kept as a focused extension to the core set. */
export const EXTENDED_LEAF_PROFILES: Readonly<Record<string, LeafProfile>> = {
  // The fern layout is twice divided, which is also the correct card-scale
  // abstraction for acacia's bipinnate compound leaf.
  'acacia-compound': {
    family: 'fern-frond', aspect: 0.16, lobePairs: [0, 0], leaflets: [18, 26],
    baseRoughness: 0.54, translucency: 0.9, damage: 0.7, palette: SAVANNA,
  },
  'eucalyptus-pendulous': {
    family: 'broadleaf-simple', aspect: 0.14, lobePairs: [0, 0], leaflets: [1, 1],
    baseRoughness: 0.42, translucency: 0.78, damage: 0.65, palette: EUCALYPTUS,
  },
  'sequoia-spray': {
    family: 'scale-spray', aspect: 0.18, lobePairs: [0, 0], leaflets: [22, 32],
    baseRoughness: 0.46, translucency: 0.52, damage: 0.25, palette: CONIFER,
  },
  'live-oak-leaf': {
    family: 'broadleaf-simple', aspect: 0.21, lobePairs: [0, 0], leaflets: [1, 1],
    baseRoughness: 0.52, translucency: 0.62, damage: 0.62, palette: LIVE_OAK,
    spray: {
      // Smaller, narrower blades with wider population variance remove the
      // repeated paddle silhouette without changing card geometry or draw cost.
      scale: 0.7,
      count: 1.08,
      variantScale: [0.82, 1.04, 0.91, 1.12],
      minimumSquash: 0.24,
      tiltExponent: 0.42,
      angleJitter: 0.42,
      curl: 2.2,
      sizeVariation: [0.68, 1.28],
      pigment: [0.88, 1.03],
      petiole: [0.08, 0.16],
    },
  },
  'beech-leaf': {
    family: 'broadleaf-simple', aspect: 0.31, lobePairs: [0, 0], leaflets: [1, 1],
    baseRoughness: 0.44, translucency: 0.82, damage: 0.5, palette: BROADLEAF,
  },
  'birch-leaf': {
    family: 'broadleaf-simple', aspect: 0.27, lobePairs: [0, 0], leaflets: [1, 1],
    baseRoughness: 0.5, translucency: 0.9, damage: 0.7,
    palette: { ...BROADLEAF, sun: [0.34, 0.46, 0.2] },
  },
  'cedar-needle': {
    family: 'needle-fascicle', aspect: 0.075, lobePairs: [0, 0], leaflets: [1, 1],
    baseRoughness: 0.48, translucency: 0.56, damage: 0.25, palette: CONIFER,
  },
  'black-pine-needle': {
    family: 'needle-fascicle', aspect: 0.052, lobePairs: [0, 0], leaflets: [1, 1],
    baseRoughness: 0.43, translucency: 0.64, damage: 0.4,
    palette: { ...CONIFER, shade: [0.09, 0.155, 0.12] },
  },
}
