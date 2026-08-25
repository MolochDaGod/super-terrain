import { clamp01, mix, smooth01, valueNoise } from '../proceduralNoise'
import type { Venation } from './blade'
import type { LeafProfile } from './types'

/** Linear-authored sRGB triple written straight into the albedo texture. */
export type Rgb = [number, number, number]

/**
 * Dry, front-face foliage reflectance for one whole blade.
 *
 * The palette stays in daylight olive territory and deliberately desaturated.
 * Saturated lime is a lighting event produced by sun transmission, not the
 * intrinsic colour of a mature leaf, and it is most of why procedural canopies
 * read as plastic. `variation` supplies a small population of brighter young
 * and warm weathered blades; `pigment` gives restrained chlorophyll spread.
 */
export function leafBaseColour(
  profile: LeafProfile,
  variation: number,
  pigment: number,
): Rgb {
  const { shade: dim, sun: lit, weathered: tired } = profile.palette
  // Three overlapping populations rather than one hue plus noise: a canopy
  // holds deep shade leaves, bright sun leaves and a scatter of tired ones, and
  // the spread between those is far wider than any amount of jitter around a
  // single mean. Holding every texel inside a six-percent luminance band is
  // precisely what makes a crown read as one flat paint.
  const sun = smooth01((variation - 0.4) / 0.45)
  // The tired minority is kept genuinely rare: browning a fifth of the blades
  // moves a whole summer canopy into September.
  const weathered = smooth01((variation - 0.93) / 0.07)
  const channel = (index: 0 | 1 | 2) =>
    mix(mix(dim[index], lit[index], sun), tired[index], weathered) * pigment
  return [channel(0), channel(1), channel(2)]
}

/**
 * Everything that happens to that colour *inside* the blade.
 *
 * A leaf whose only colour cue is one flat fill plus a normal map is the single
 * loudest plastic tell in a canopy, because no real blade is one colour: the
 * veins are paler and yellower than the lamina, the intercostal fields mottle
 * at two or three scales, the margin dries and browns before the middle does,
 * and a mature summer leaf carries visible feeding damage and rust. None of
 * that is lighting, so all of it belongs in albedo.
 */
export function shadeBlade(
  base: Rgb,
  profile: LeafProfile,
  u: number,
  across: number,
  variation: number,
  veins: Venation,
  blemish: number,
): Rgb {
  // Families whose blade is a narrow strap carry one visible rib and no
  // reticulate lamina to speak of, so their vein response has to stay quiet.
  const strap = profile.family === 'needle-fascicle' ||
    profile.family === 'scale-spray' || profile.family === 'rosette'
  const veinMask = strap
    ? veins.midrib * 0.42
    : clamp01(veins.midrib * 0.82 + veins.lateral * 0.66)

  // Chlorophyll density wanders across the lamina at two scales. The coarse
  // field is what stops neighbouring leaves reading as swatches of one paint.
  const coarse = valueNoise(u * 2.4 + variation * 31, across * 1.7, 977) - 0.5
  const fine = valueNoise(u * 11 + variation * 7, across * 8, 1481) - 0.5
  const mottle = coarse * 0.09 + fine * 0.035 + veins.reticulate * 0.02

  // Margins dry, brown and curl before the middle of the blade does. Kept
  // restrained: a rim of strong brown on every blade reads as autumn, or worse
  // as a drop shadow, rather than as an ordinary summer leaf.
  const margin = smooth01((across - 0.84) * 5)
  const drying = strap ? margin * 0.06 : margin * (0.06 + variation * 0.2)
  // The base of the lamina stays greener than the apex all season.
  const apexWear = smooth01((u - 0.62) / 0.38) * smooth01((variation - 0.72) / 0.28) * 0.2

  let red = base[0] * (1 + mottle * 0.55)
  let green = base[1] * (1 + mottle)
  let blue = base[2] * (1 + mottle * 0.3)

  // Veins are chlorophyll-poor: paler, and yellower than the lamina around
  // them. Lifting all three channels equally makes them look like scratches,
  // and lifting red hardest makes them look like cracks — a midrib on the
  // upper surface is a pale *green*-yellow, never a white line.
  if (!strap) {
    red += veinMask * 0.042
    green += veinMask * 0.058
    blue += veinMask * 0.012
  } else {
    red += veinMask * 0.008
    green += veinMask * 0.012
    blue += veinMask * 0.006
  }

  // Necrosis and rust, blended toward a dull tan rather than added, so damaged
  // patches lose chlorophyll instead of gaining brightness. The target has to
  // stay darker and far less saturated than it wants to be — a warm, bright
  // target turns every spot into a berry.
  const wear = clamp01(drying + apexWear + blemish)
  const [necroticRed, necroticGreen, necroticBlue] = profile.palette.necrosis
  red = mix(red, necroticRed, wear * 0.5)
  green = mix(green, necroticGreen, wear * 0.5)
  blue = mix(blue, necroticBlue, wear * 0.5)

  return [red, green, blue]
}

/**
 * Localised feeding damage and fungal spotting, as a 0..1 field.
 *
 * Kept separate from the smooth pigment noise because it has to be *sparse and
 * hard-edged*: a summer oak leaf carries a handful of distinct brown spots, not
 * a general wash of brownness. Smearing the same amount of damage evenly is
 * what makes procedural weathering read as dirt on the lens.
 */
export function blemishAt(
  u: number,
  across: number,
  variation: number,
  incidence: number,
): number {
  if (incidence <= 0) return 0
  // High frequency and a tight threshold. The first calibration ran the noise
  // at a seventh of this rate and cut it loosely, so a "spot" came out as a
  // khaki blotch covering a third of the blade — from a distance the canopy
  // read as diseased rather than as a summer oak. A real fungal spot is a few
  // millimetres across on a hand-length leaf.
  const field = valueNoise(u * 17 + variation * 53, across * 11 + variation * 17, 613)
  return smooth01((field - (1 - incidence * 0.26)) / 0.045)
}
