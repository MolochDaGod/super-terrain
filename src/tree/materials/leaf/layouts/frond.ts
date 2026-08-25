import { mix } from '../../proceduralNoise'
import type { LeafPlacement, ShootSegment } from '../types'
import { MARGIN, placeBlade, type LayoutBuilder } from './types'

/**
 * One pinnate frond filling the card: a long arching rachis with strap
 * leaflets ranked closely down both sides.
 *
 * A palm frond is a single organ metres long, so one card is one frond rather
 * than a twiglet carrying several. The leaflets have to be *dense* — a real
 * date frond carries well over a hundred, close enough to touch at the base of
 * the blade — and they have to shorten toward both ends. Spacing a dozen of
 * them evenly gives the fishbone that reads as a cartoon palm.
 */
export const pinnateFrondLayout: LayoutBuilder = (random, variant, profile) => {
  const shoots: ShootSegment[] = []
  const leaves: LeafPlacement[] = []
  const [minLeaflets, maxLeaflets] = profile.leaflets
  const count = minLeaflets + Math.floor(random() * (maxLeaflets - minLeaflets + 1))

  // The rachis arches: straight up out of the crown, then bending over. Two
  // segments approximate that well enough at card scale.
  const sweep = (variant % 2 === 0 ? 1 : -1) * mix(0.1, 0.26, random())
  const tipX = 0.5 + sweep
  const kneeX = 0.5 + sweep * 0.28
  const kneeY = mix(0.44, 0.56, random())
  const lower: ShootSegment = {
    fromX: 0.5, fromY: MARGIN, toX: kneeX, toY: kneeY, width: 0.0105,
  }
  const upper: ShootSegment = {
    fromX: kneeX, fromY: kneeY, toX: tipX, toY: 1 - MARGIN, width: 0.0062,
  }
  shoots.push(lower, upper)

  // The bare basal fifth is real: a frond's leaflets do not start at the crown.
  const bareBase = 0.16
  const pairCount = Math.ceil(count / 2)
  for (let station = 0; station < pairCount; station += 1) {
    // Date and coconut pinnae are ranked in close, imperfect pairs. A single
    // perfectly alternating loop made every leaflet land on a visible zipper
    // pitch. Correlated station jitter preserves the rank while breaking that
    // machine spacing.
    const stationT = (station + mix(-0.18, 0.18, random())) /
      Math.max(1, pairCount - 1)
    const along = Math.min(0.995, Math.max(
      bareBase,
      bareBase + stationT * (1 - bareBase),
    ))
    const segment = along < (kneeY - MARGIN) / (1 - MARGIN * 2) ? lower : upper
    const local = segment === lower
      ? along / Math.max(1e-3, (kneeY - MARGIN) / (1 - MARGIN * 2))
      : (along - (kneeY - MARGIN) / (1 - MARGIN * 2)) /
        Math.max(1e-3, 1 - (kneeY - MARGIN) / (1 - MARGIN * 2))
    const x = mix(segment.fromX, segment.toX, Math.min(1, local))
    const y = mix(segment.fromY, segment.toY, Math.min(1, local))
    const taper = Math.pow(Math.sin(Math.pow(along, 0.72) * Math.PI), 0.5)
    for (const side of [-1, 1] as const) {
      // Sparse missing and shortened pinnae are enough to stop cloned fronds
      // without making a healthy crown look storm-damaged.
      if (station > 2 && random() < 0.035) continue
      const reach = side * taper * mix(0.405, 0.49, random()) *
        (random() < 0.06 ? mix(0.48, 0.78, random()) : 1)
      const rake = mix(0.115, 0.025, along) * taper
      const droop = mix(0.005, 0.065, along) * mix(0.72, 1.28, random())
      const rise = rake - droop + (side < 0 ? -0.004 : 0.004)
      leaves.push(placeBlade(profile, random, {
        x: x + (random() - 0.5) * 0.012,
        y: y + (random() - 0.5) * 0.011,
        angle: Math.atan2(rise, reach),
        length: Math.hypot(reach, rise),
        petiole: 0,
        // The mesh supplies the macroscopic V; this variation supplies the
        // finer pinna-to-pinna roll visible in highlights and silhouette.
        squash: mix(0.46, 1, Math.pow(random(), 0.72)),
      }))
    }
  }
  leaves.sort((a, b) => a.depth - b.depth)
  return { leaves, shoots }
}

/**
 * A bipinnate fern frond: pinnae ranked off the rachis, pinnules off each
 * pinna.
 *
 * The second division is the whole point. A fern drawn with one level of
 * division is a palm frond, and the lacy, self-similar mass that makes a tree
 * fern recognisable only appears once each pinna carries its own row of small
 * toothed blades.
 */
export const fernFrondLayout: LayoutBuilder = (random, variant, profile) => {
  const shoots: ShootSegment[] = []
  const leaves: LeafPlacement[] = []
  const sweep = (variant % 2 === 0 ? 1 : -1) * mix(0.06, 0.2, random())
  const rachis: ShootSegment = {
    fromX: 0.5 - sweep * 0.3,
    fromY: MARGIN,
    toX: 0.5 + sweep,
    toY: 1 - MARGIN,
    width: 0.0085,
  }
  shoots.push(rachis)

  const pinnaCount = 11 + (variant % 4)
  const [minPinnules, maxPinnules] = profile.leaflets
  for (let index = 0; index < pinnaCount; index += 1) {
    const along = 0.12 + (index / pinnaCount) * 0.86
    const side = index % 2 === 0 ? 1 : -1
    const rootX = mix(rachis.fromX, rachis.toX, along)
    const rootY = mix(rachis.fromY, rachis.toY, along)
    // Pinnae shorten toward the tip of the frond, which is what gives a fern
    // its long triangular outline.
    const reach = mix(0.46, 0.1, Math.pow(along, 0.85)) * mix(0.9, 1.1, random())
    const rise = reach * mix(0.35, 0.7, random())
    const pinna: ShootSegment = {
      fromX: rootX,
      fromY: rootY,
      toX: rootX + side * reach,
      toY: rootY + rise,
      width: 0.0034,
    }
    shoots.push(pinna)

    const pinnules = minPinnules + Math.floor(random() * (maxPinnules - minPinnules + 1))
    const heading = Math.atan2(rise, side * reach)
    for (let step = 0; step < pinnules; step += 1) {
      const local = 0.1 + (step / pinnules) * 0.9
      const pinnuleSide = step % 2 === 0 ? 1 : -1
      leaves.push(placeBlade(profile, random, {
        x: mix(pinna.fromX, pinna.toX, local) + (random() - 0.5) * 0.005,
        y: mix(pinna.fromY, pinna.toY, local) + (random() - 0.5) * 0.005,
        angle: heading + pinnuleSide * mix(1.3, 0.85, local),
        length: Math.pow(Math.sin(local * Math.PI), 0.4) * reach *
          mix(0.24, 0.36, random()),
        petiole: 0.05,
      }))
    }
  }
  leaves.sort((a, b) => a.depth - b.depth)
  return { leaves, shoots }
}
