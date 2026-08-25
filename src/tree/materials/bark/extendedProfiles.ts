import type { BarkProfile } from './types'

/**
 * Bark families added with the breadth catalog. Kept out of the core profile
 * library so species coverage can grow without turning one routing file into a
 * wall of unrelated material recipes.
 */
export const EXTENDED_BARK_PROFILES: Readonly<Record<string, BarkProfile>> = {
  'savanna-fissured': {
    family: 'fissured-hardwood', columns: 18, plateAspect: 2.8,
    linkFrequency: [7, 28], minorFrequency: [38, 64], plateCyclesY: 8,
    furrowHalfWidth: 0.12, linkHalfWidth: 0.18, furrowDepth: 0.44,
    furrowStrength: 0.82, normalStrength: 8.5,
    palette: {
      fissure: [0.16, 0.125, 0.09], crown: [0.46, 0.39, 0.29],
      fresh: [0.52, 0.43, 0.31], lichen: [0.57, 0.55, 0.45],
      moss: [0.22, 0.26, 0.12],
    },
  },
  'rainbow-peeling': {
    family: 'fissured-hardwood', columns: 6, plateAspect: 1.1,
    linkFrequency: [5, 9], minorFrequency: [18, 22], plateCyclesY: 6,
    furrowHalfWidth: 0.055, linkHalfWidth: 0.06, furrowDepth: 0.15,
    furrowStrength: 0.34, normalStrength: 4.2,
    palette: {
      fissure: [0.22, 0.33, 0.28], crown: [0.66, 0.56, 0.39],
      fresh: [0.72, 0.37, 0.26], lichen: [0.62, 0.68, 0.56],
      moss: [0.2, 0.34, 0.2],
    },
  },
  'gum-mottled': {
    family: 'fissured-hardwood', columns: 5, plateAspect: 1.35,
    linkFrequency: [4, 8], minorFrequency: [16, 18], plateCyclesY: 5,
    furrowHalfWidth: 0.05, linkHalfWidth: 0.055, furrowDepth: 0.13,
    furrowStrength: 0.3, normalStrength: 4,
    palette: {
      fissure: [0.34, 0.35, 0.31], crown: [0.63, 0.61, 0.53],
      fresh: [0.56, 0.48, 0.38], lichen: [0.68, 0.69, 0.61],
      moss: [0.25, 0.34, 0.21],
    },
  },
  'fibrous-sequoia': {
    family: 'resinous-conifer', columns: 5, plateAspect: 8,
    linkFrequency: [5, 8], minorFrequency: [34, 9], plateCyclesY: 3,
    furrowHalfWidth: 0.24, linkHalfWidth: 0.13, furrowDepth: 0.74,
    furrowStrength: 0.97, normalStrength: 7,
    palette: {
      fissure: [0.12, 0.07, 0.045], crown: [0.5, 0.265, 0.15],
      fresh: [0.58, 0.31, 0.18], lichen: [0.48, 0.43, 0.36],
      moss: [0.18, 0.25, 0.12],
    },
  },
  'beech-smooth': {
    family: 'fissured-hardwood', columns: 3, plateAspect: 1.5,
    linkFrequency: [3, 5], minorFrequency: [12, 10], plateCyclesY: 3,
    furrowHalfWidth: 0.035, linkHalfWidth: 0.035, furrowDepth: 0.07,
    furrowStrength: 0.2, normalStrength: 2.8,
    palette: {
      fissure: [0.39, 0.4, 0.385], crown: [0.58, 0.59, 0.555],
      fresh: [0.54, 0.535, 0.49], lichen: [0.65, 0.66, 0.6],
      moss: [0.25, 0.33, 0.21],
    },
  },
  'birch-white': {
    family: 'fissured-hardwood', columns: 8, plateAspect: 0.75,
    linkFrequency: [7, 16], minorFrequency: [28, 34], plateCyclesY: 14,
    furrowHalfWidth: 0.07, linkHalfWidth: 0.12, furrowDepth: 0.2,
    furrowStrength: 0.48, normalStrength: 4.8,
    palette: {
      fissure: [0.16, 0.15, 0.135], crown: [0.76, 0.76, 0.71],
      fresh: [0.62, 0.58, 0.49], lichen: [0.74, 0.76, 0.7],
      moss: [0.24, 0.32, 0.18],
    },
  },
  'conifer-fissured': {
    family: 'resinous-conifer', columns: 17, plateAspect: 3.4,
    linkFrequency: [8, 30], minorFrequency: [38, 72], plateCyclesY: 9,
    furrowHalfWidth: 0.15, linkHalfWidth: 0.15, furrowDepth: 0.58,
    furrowStrength: 0.9, normalStrength: 8,
    palette: {
      fissure: [0.12, 0.092, 0.068], crown: [0.39, 0.31, 0.22],
      fresh: [0.45, 0.34, 0.23], lichen: [0.5, 0.5, 0.43],
      moss: [0.18, 0.25, 0.13],
    },
  },
  'pine-plated-dark': {
    family: 'resinous-conifer', columns: 15, plateAspect: 2.1,
    linkFrequency: [8, 27], minorFrequency: [34, 60], plateCyclesY: 10,
    furrowHalfWidth: 0.16, linkHalfWidth: 0.16, furrowDepth: 0.62,
    furrowStrength: 0.94, normalStrength: 8.5,
    palette: {
      fissure: [0.085, 0.065, 0.05], crown: [0.3, 0.24, 0.18],
      fresh: [0.39, 0.29, 0.2], lichen: [0.44, 0.44, 0.39],
      moss: [0.16, 0.23, 0.12],
    },
  },
}
