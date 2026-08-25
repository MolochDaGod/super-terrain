import { mix } from '../../proceduralNoise'
import type { LeafPlacement, ShootSegment } from '../types'
import { MARGIN, placeBlade, type LayoutBuilder } from './types'

/**
 * Leaflets radiating from a single point at the tip of a long petiole: a
 * ceiba or a baobab leaf.
 *
 * The whole identity is that one attachment point. Ranking the same leaflets
 * along a stem instead — which is what any spray layout does with them — turns
 * a palmate leaf into an ash, and no amount of work on the leaflet outline
 * recovers it. The petiole is long and bare, and the hand of leaflets sits at
 * the end of it like a splayed umbrella.
 */
export const palmateLayout: LayoutBuilder = (random, variant, profile) => {
  const shoots: ShootSegment[] = []
  const leaves: LeafPlacement[] = []
  const style = profile.spray
  // Two or three whole leaves per card, so a crown built from them does not
  // repeat one silhouette; each gets its own petiole from the card's base.
  const hands = Math.max(1, Math.round((2 + (variant % 2)) * (style?.count ?? 1)))
  const [minLeaflets, maxLeaflets] = profile.leaflets

  for (let hand = 0; hand < hands; hand += 1) {
    const spreadX = (hand + 0.5) / hands
    const baseX = mix(0.22, 0.78, spreadX) + (random() - 0.5) * 0.08
    const hubX = baseX + (random() - 0.5) * 0.2
    const authoredHubY = mix(0.42, 0.86, random())
    const hubY = MARGIN + (authoredHubY - MARGIN) * (style?.axisScale ?? 1)
    const petiole: ShootSegment = {
      fromX: mix(0.5, baseX, 0.4),
      fromY: MARGIN,
      toX: hubX,
      toY: hubY,
      width: 0.0075 * (style?.shootWidthScale ?? 1),
    }
    shoots.push(petiole)

    const count = minLeaflets + Math.floor(random() * (maxLeaflets - minLeaflets + 1))
    // Leaflets fan through rather less than a full circle: they are held
    // forward of the petiole, not wrapped around it.
    const heading = Math.atan2(hubY - petiole.fromY, hubX - petiole.fromX)
    const fan = mix(1.9, 2.5, random())
    for (let index = 0; index < count; index += 1) {
      const along = count === 1 ? 0.5 : index / (count - 1)
      const angle = heading + (along - 0.5) * fan + (random() - 0.5) * 0.12
      // The middle leaflets of a palmate leaf are the longest; the outermost
      // pair is often half their length.
      const scale = mix(0.5, 1, Math.sin(along * Math.PI)) *
        mix(0.2, 0.28, random()) *
        (style?.scale ?? 1) *
        (style?.variantScale[variant % 4] ?? 1)
      leaves.push(placeBlade(profile, random, {
        x: hubX,
        y: hubY,
        angle,
        length: scale,
        // Leaflets are sessile on the hub, so barely any stalk.
        petiole: 0.03 + random() * 0.03,
      }))
    }
  }
  leaves.sort((a, b) => a.depth - b.depth)
  return { leaves, shoots }
}
