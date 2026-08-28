import { mix } from '../proceduralNoise'
import { fernFrondLayout, pinnateFrondLayout } from './layouts/frond'
import { palmateLayout } from './layouts/palmate'
import { rosetteLayout, scaleSprayLayout } from './layouts/rosette'
import { MARGIN, type LayoutBuilder, type SprayLayout } from './layouts/types'
import type { LeafPlacement, LeafProfile, ShootSegment, SprayComposition } from './types'

export { MARGIN }

/**
 * One layout per organ family.
 *
 * Arrangement is not a detail on top of a leaf shape — it is most of what the
 * eye reads. A palmate leaf, a palm frond, a fern frond and an aloe rosette
 * share almost nothing but chlorophyll, and running all four through a single
 * alternate-spray builder is why they all came back looking like the same
 * handful of green spikes.
 */
const BY_FAMILY: Partial<Record<LeafProfile['family'], LayoutBuilder>> = {
  palmate: palmateLayout,
  'pinnate-frond': pinnateFrondLayout,
  'fern-frond': fernFrondLayout,
  rosette: rosetteLayout,
  'scale-spray': scaleSprayLayout,
}

/** Golden-angle divergence: the spiral a real alternate phyllotaxy follows. */
const DIVERGENCE = 2.399963229728653

/**
 * Four genuinely different spray compositions, one per atlas slot.
 *
 * Re-seeding one composition is not variety: the eye reads the *layout* — where
 * the mass sits, how far the shoots reach, how crowded the tip is — long before
 * it reads which individual blade went where. Four reseeds of one layout tile
 * across a crown as a single repeating grain, which is exactly what a canopy
 * built from them looks like.
 */
export function compositionFor(variant: number, profile: LeafProfile): SprayComposition {
  if (profile.family === 'needle-fascicle') {
    // A conifer branchlet is a dense brush, and this composition used to make
    // a bare rachis with a few needles on it. Dumped against the beech card it
    // covered about a eighth of its cell where beech covers two thirds, and a
    // card that is seven eighths empty is the whole reason a spruce crown read
    // as black specks on bare orange sticks: the crown was carrying its full
    // complement of stations and each one was drawing almost nothing.
    //
    // Needles are borne all round the shoot at a few millimetres' spacing, so
    // the count is high, the side shoots are many, and the spray is wide
    // enough to reach the edges of its cell.
    return styleComposition({
      primaryCount: 8 + (variant % 3),
      secondaryChance: 0.85,
      axisLeaves: 74,
      sideLeaves: 46,
      leafScale: 0.125,
      axisTop: 0.95,
      spread: 0.34,
    }, variant, profile)
  }
  let composition: SprayComposition
  switch (variant % 4) {
    // A single long shoot: sparse, open, mostly axis. Reads as the leading
    // edge of a branchlet and is what lets sky through the crown boundary.
    case 0:
      composition = {
        primaryCount: 2,
        secondaryChance: 0.2,
        axisLeaves: 13,
        sideLeaves: 6,
        leafScale: 0.2,
        axisTop: 0.92,
        spread: 0.19,
      }
      break
    // A wide fan: two heavy side shoots low, mass carried out to the sides.
    case 1:
      composition = {
        primaryCount: 4,
        secondaryChance: 0.7,
        axisLeaves: 8,
        sideLeaves: 10,
        leafScale: 0.185,
        axisTop: 0.78,
        spread: 0.32,
      }
      break
    // A terminal rosette: short axis, everything crowded into the last third,
    // which is how an oak's current-season growth actually presents.
    case 2:
      composition = {
        primaryCount: 3,
        secondaryChance: 0.5,
        axisLeaves: 15,
        sideLeaves: 9,
        leafScale: 0.18,
        axisTop: 0.68,
        spread: 0.24,
      }
      break
    // A dense twiggy cluster: many short shoots, the interior filler.
    default:
      composition = {
        primaryCount: 5,
        secondaryChance: 0.8,
        axisLeaves: 9,
        sideLeaves: 8,
        leafScale: 0.17,
        axisTop: 0.84,
        spread: 0.26,
      }
      break
  }
  return styleComposition(composition, variant, profile)
}

function styleComposition(
  composition: SprayComposition,
  variant: number,
  profile: LeafProfile,
): SprayComposition {
  const style = profile.spray
  if (!style) return composition
  return {
    ...composition,
    axisLeaves: Math.max(1, Math.round(composition.axisLeaves * style.count)),
    sideLeaves: Math.max(1, Math.round(composition.sideLeaves * style.count)),
    leafScale: composition.leafScale * style.scale * style.variantScale[variant % 4]!,
    axisTop: MARGIN + (composition.axisTop - MARGIN) * (style.axisScale ?? 1),
    spread: composition.spread * (style.spreadScale ?? 1),
  }
}

/**
 * Lays out one spray from its composition.
 *
 * Leaf size relative to the card is the whole game. Too large and the blades
 * overlap into a solid green paddle with no holes through it: the card stops
 * being foliage and becomes a decal, and a crown built from those reads as
 * cabbage. Too small and the deep lobes that identify an oak fall below the
 * texture's resolution and turn into edge noise. A real oak twig shows sky
 * through it nearly everywhere, and the negative space between blades carries
 * as much of the read as the blades do.
 */
export function layoutSpray(
  seed: number,
  variant: number,
  profile: LeafProfile,
): SprayLayout {
  const random = seededSequence(seed)
  const family = BY_FAMILY[profile.family]
  if (family) return family(random, variant, profile)
  const plan = compositionFor(variant, profile)
  const style = profile.spray
  const dense = profile.family === 'needle-fascicle'
  const shoots: ShootSegment[] = []
  const bearers: { shoot: ShootSegment; leaves: number }[] = []

  const axisBow = (random() - 0.5) * 0.12
  const axis: ShootSegment = {
    fromX: 0.5 - axisBow,
    fromY: MARGIN,
    toX: 0.5 + axisBow,
    toY: plan.axisTop,
    width: 0.0072 * (style?.shootWidthScale ?? 1),
  }
  shoots.push(axis)
  bearers.push({ shoot: axis, leaves: plan.axisLeaves })

  for (let index = 0; index < plan.primaryCount; index += 1) {
    const along = 0.12 + ((index + random() * 0.7) / plan.primaryCount) * 0.76
    const side = index % 2 === 0 ? 1 : -1
    const reach = plan.spread * (0.7 + random() * 0.6) * (1 - along * 0.3)
    const primary: ShootSegment = {
      fromX: mix(axis.fromX, axis.toX, along),
      fromY: mix(axis.fromY, axis.toY, along),
      toX: mix(axis.fromX, axis.toX, along) + side * reach,
      toY: mix(axis.fromY, axis.toY, along) + reach * (0.3 + random() * 0.55),
      width: 0.0048 * (style?.shootWidthScale ?? 1),
    }
    shoots.push(primary)
    bearers.push({ shoot: primary, leaves: plan.sideLeaves })
    if (random() > plan.secondaryChance) continue
    const forkAt = 0.35 + random() * 0.4
    const secondaryReach = reach * (0.4 + random() * 0.32)
    const secondary: ShootSegment = {
      fromX: mix(primary.fromX, primary.toX, forkAt),
      fromY: mix(primary.fromY, primary.toY, forkAt),
      toX: mix(primary.fromX, primary.toX, forkAt) + side * secondaryReach * 0.45,
      toY: mix(primary.fromY, primary.toY, forkAt) + secondaryReach,
      width: 0.0032 * (style?.shootWidthScale ?? 1),
    }
    shoots.push(secondary)
    bearers.push({ shoot: secondary, leaves: Math.round(plan.sideLeaves * 0.7) })
  }

  const leaves: LeafPlacement[] = []
  for (const [shootIndex, bearer] of bearers.entries()) {
    const { shoot, leaves: count } = bearer
    const isAxis = shootIndex === 0
    const runX = shoot.toX - shoot.fromX
    const runY = shoot.toY - shoot.fromY
    const heading = Math.atan2(runY, runX)
    for (let index = 0; index < count; index += 1) {
      // Alternate, not opposite. Oak sets one leaf per node on a spiral, so
      // consecutive blades must be offset *along* the shoot as well as across
      // it — placing left and right at the same station gives the paired,
      // pinnate look of an ash or a rowan.
      const step = (index + 0.75) / count
      const along = Math.pow(step, 0.72)
      const side = index % 2 === 0 ? 1 : -1
      const divergence = Math.cos(index * DIVERGENCE)
      const spread = (0.45 + Math.abs(divergence) * 0.55) * side
      // Blades rake forward toward the tip, the way weight and light pull them.
      const rake = mix(0.45, 1.4, along)
      const [minimumSize, maximumSize] = style?.sizeVariation ?? [0.82, 1.18]
      const scale = plan.leafScale *
        mix(0.74, 1.14, Math.sin(along * Math.PI * 0.92)) *
        (isAxis ? 1 : 0.86) *
        mix(minimumSize, maximumSize, random())
      // How far the blade is tilted out of the card plane. The old range never
      // went below 0.62, so every blade presented near face-on and the spray
      // read as a pressed herbarium sheet. Real foliage shows blades at every
      // angle, and the occasional near-edge-on sliver is what tells the eye the
      // twig has depth. The distribution has to stay heavily weighted toward
      // face-on though: sampling tilt uniformly and squaring it put the mean
      // near a half, which turned a leafy twiglet into a handful of splinters.
      const tilt = Math.pow(random(), style?.tiltExponent ?? 0.45)
      const [minimumPigment, maximumPigment] = style?.pigment ?? [0.9, 1.1]
      const [minimumPetiole, maximumPetiole] = style?.petiole ?? [0.07, 0.13]
      leaves.push({
        x: shoot.fromX + runX * along + (random() - 0.5) * 0.016,
        y: shoot.fromY + runY * along + (random() - 0.5) * 0.016,
        angle: heading + Math.atan2(spread, rake) +
          (random() - 0.5) * (style?.angleJitter ?? 0),
        length: scale,
        width: profile.aspect * (dense ? 1 : 0.9 + random() * 0.24),
        squash: dense ? 1 : mix(style?.minimumSquash ?? 0.22, 1, tilt),
        pigment: mix(minimumPigment, maximumPigment, random()),
        variation: random(),
        depth: random(),
        curl: (random() - 0.5) * (style?.curl ?? 1.5),
        // Near-sessile: an English oak petiole is a few millimetres on a
        // hand-length blade. It still has to exist — a blade that touches the
        // twig at a mathematical point looks glued on.
        petiole: dense ? 0 : mix(minimumPetiole, maximumPetiole, random()),
      })
    }
  }
  // Back to front, so nearer blades overwrite the ones behind them.
  leaves.sort((a, b) => a.depth - b.depth)
  return { leaves, shoots }
}

/** Small deterministic generator, so a variant is reproducible from its seed. */
export function seededSequence(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
