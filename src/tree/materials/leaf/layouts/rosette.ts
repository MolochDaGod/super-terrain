import { mix } from '../../proceduralNoise'
import type { LeafPlacement, ShootSegment } from '../types'
import { MARGIN, placeBlade, type LayoutBuilder } from './types'

/**
 * A terminal rosette: thick lance leaves radiating from one crown at the tip of
 * a stubby branch. Dragon blood, quiver tree, aloe.
 *
 * These plants carry all their foliage in a few dense heads rather than spread
 * along their branches, so a card that scatters blades over its whole area is
 * describing the wrong plant entirely. Everything belongs to one hub, and the
 * blades point outward and *upward* from it — a rosette seen from the side is a
 * shuttlecock, not a starburst.
 */
export const rosetteLayout: LayoutBuilder = (random, variant, profile) => {
  const shoots: ShootSegment[] = []
  const leaves: LeafPlacement[] = []
  const hubX = 0.5 + (random() - 0.5) * 0.1
  const hubY = mix(0.24, 0.34, random())
  shoots.push({
    fromX: hubX, fromY: MARGIN, toX: hubX, toY: hubY, width: 0.014,
  })

  const [minLeaves, maxLeaves] = profile.leaflets
  const count = minLeaves + Math.floor(random() * (maxLeaves - minLeaves + 1)) +
    (variant % 3) * 2
  for (let index = 0; index < count; index += 1) {
    // Spread through most of a half-turn, biased upward. The lowest leaves of
    // a rosette droop below horizontal as they age.
    const along = (index + 0.5) / count
    const angle = mix(-0.35, Math.PI + 0.35, along) + (random() - 0.5) * 0.22
    // The outer, older leaves are longer and hang lower; the young ones at the
    // centre stand almost upright and short.
    const youth = Math.abs(along - 0.5) * 2
    // Rosette cards are stretched narrow by the compiler too, so the blades
    // have to run right out to the card border or they arrive as splinters.
    leaves.push(placeBlade(profile, random, {
      x: hubX + (random() - 0.5) * 0.02,
      y: hubY + (random() - 0.5) * 0.02,
      angle,
      length: mix(0.46, 0.66, youth) * mix(0.85, 1.15, random()),
      petiole: 0,
      // Succulent leaves are thick and hold their shape, so far fewer of them
      // present edge-on than a flexible blade would.
      squash: mix(0.45, 1, Math.pow(random(), 0.35)),
      curl: (random() - 0.5) * 0.7,
    }))
  }
  leaves.sort((a, b) => a.depth - b.depth)
  return { leaves, shoots }
}

/**
 * Overlapping scale leaves clasping a stiff shoot: a monkey puzzle branchlet.
 *
 * The scales tile the shoot like roof slates, each one pointing forward and
 * mostly hiding the one behind it, so the shoot is never visible between them.
 * Spacing them out along a twig the way an alternate broadleaf is spaced gives
 * a row of separate green triangles rather than the armoured rope a monkey
 * puzzle branch actually is.
 */
export const scaleSprayLayout: LayoutBuilder = (random, variant, profile) => {
  const shoots: ShootSegment[] = []
  const leaves: LeafPlacement[] = []
  const branches = 2 + (variant % 3)
  const [minScales, maxScales] = profile.leaflets

  for (let branch = 0; branch < branches; branch += 1) {
    const baseX = mix(0.28, 0.72, (branch + 0.5) / branches)
    const lean = (random() - 0.5) * 0.42
    const shoot: ShootSegment = {
      fromX: baseX - lean * 0.3,
      fromY: MARGIN,
      toX: baseX + lean,
      toY: mix(0.72, 0.95, random()),
      width: 0.006,
    }
    shoots.push(shoot)
    const heading = Math.atan2(shoot.toY - shoot.fromY, shoot.toX - shoot.fromX)
    const count = minScales + Math.floor(random() * (maxScales - minScales + 1))
    for (let index = 0; index < count; index += 1) {
      // Dense enough that consecutive scales overlap, and set on a spiral so
      // the ranks do not line up into visible rows.
      const along = (index + 0.5) / count
      const spiral = index * 2.399963229728653
      const side = Math.sin(spiral)
      leaves.push(placeBlade(profile, random, {
        x: mix(shoot.fromX, shoot.toX, along),
        y: mix(shoot.fromY, shoot.toY, along),
        // Raked hard forward: a scale lies along the shoot, not out from it.
        angle: heading + side * mix(0.95, 0.55, along),
        length: mix(0.13, 0.19, Math.sin(along * Math.PI * 0.9)) *
          mix(0.85, 1.15, random()),
        petiole: 0,
        squash: mix(0.5, 1, Math.abs(Math.cos(spiral))),
        curl: (random() - 0.5) * 0.5,
      }))
    }
  }
  leaves.sort((a, b) => a.depth - b.depth)
  return { leaves, shoots }
}
