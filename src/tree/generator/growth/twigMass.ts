import { add, cross, multiply, normalize, TreeRandom, vec3 } from '../math'
import type { TreeOrganModel } from '../speciesCatalog'
import type { TreeVec3 } from '../types'
import { axisDirection, sampledAxis, sampleAxisPosition } from './axis'
import type { GrowthAxisDraft, OrganStationDraft } from './types'

/**
 * Terminal shoot fans, and the leaf mass they actually carry.
 *
 * Foliage stations strung along the last woody axis produce the failure a
 * reviewer described as leaf confetti: cards every twenty centimetres down an
 * otherwise bare pole, none of them close enough to another to read as a leafy
 * volume. Real crowns do not work that way. The last visible order is a dense
 * fan of very short shoots leaving one tip together, and the leaves sit in a
 * compact rounded mass at the end of each of those shoots.
 *
 * That fan is also the whole reason a leafless baobab reads as a root system in
 * the air, so it earns its place as geometry rather than as more cards.
 */
export interface TwigMassProfile {
  /** Short shoots radiating from one bearer tip. */
  twigCount: readonly [number, number]
  twigLength: readonly [number, number]
  /** Twig base radius as a fraction of the bearer's tip radius. */
  twigRadius: readonly [number, number]
  /** Half-angle of the cone the fan opens into, in radians. */
  spread: readonly [number, number]
  /** Foliage stations packed around each twig tip. */
  stations: readonly [number, number]
  /** Radius of the packed leaf mass, in metres. */
  massRadius: readonly [number, number]
  organRadius: readonly [number, number]
  organDepth: readonly [number, number]
  organModel: TreeOrganModel
}

/** An orthogonal direction at `angle` around `direction`. */
export function orthogonalAround(direction: TreeVec3, angle: number): TreeVec3 {
  const reference = Math.abs(direction.y) < 0.88 ? vec3(0, 1, 0) : vec3(1, 0, 0)
  const first = normalize(cross(direction, reference), vec3(1, 0, 0))
  const second = normalize(cross(direction, first), vec3(0, 0, 1))
  return normalize(add(
    multiply(first, Math.cos(angle)),
    multiply(second, Math.sin(angle)),
  ))
}

/**
 * Grows the terminal fan on one bearer and packs its leaf masses.
 *
 * `outward` biases the fan away from the crown centre so the masses land on the
 * lit shell rather than inside the crown, which is where a purely random cone
 * puts about half of them.
 */
export function growTwigMass(
  bearer: GrowthAxisDraft,
  outward: TreeVec3,
  profile: TwigMassProfile,
  random: TreeRandom,
): { axes: GrowthAxisDraft[]; organs: OrganStationDraft[] } {
  const axes: GrowthAxisDraft[] = []
  const organs: OrganStationDraft[] = []
  const bearerDirection = axisDirection(bearer.samples)
  const tipRadius = bearer.samples.at(-1)!.radius
  const count = random.integer(...profile.twigCount)
  const phase = random.range(0, Math.PI * 2)

  for (let index = 0; index < count; index += 1) {
    // Fans are not whorls: the shoots leave over the last stretch of the bearer
    // rather than all from the exact tip, which is what stops the group reading
    // as a spoked wheel welded onto the end.
    const attachment = index === 0 ? 1 : random.range(0.74, 1)
    const origin = sampleAxisPosition(bearer.samples, attachment)
    const opening = random.range(...profile.spread)
    const azimuth = phase + (index / count) * Math.PI * 2 + random.range(-0.7, 0.7)
    const side = orthogonalAround(bearerDirection, azimuth)
    const direction = normalize(add(
      multiply(bearerDirection, Math.cos(opening)),
      add(
        multiply(side, Math.sin(opening)),
        multiply(outward, random.range(0.05, 0.28)),
      ),
    ))
    const length = random.range(...profile.twigLength)
    const baseRadius = tipRadius * random.range(...profile.twigRadius)
    const samples = sampledAxis(
      origin,
      direction,
      length,
      baseRadius,
      Math.max(0.008, baseRadius * random.range(0.4, 0.58)),
      random,
      {
        samples: 5,
        startTangent: bearerDirection,
        startTangentStrength: 0.34,
        // Terminal shoots are the most crooked wood on a tree; they change
        // direction every season and never grew under load.
        crook: random.range(0.1, 0.24),
        sag: random.range(0, 0.05),
      },
    )
    const id = `${bearer.id}-twig-${index + 1}`
    axes.push({
      id,
      parentId: bearer.id,
      attachment,
      branchOrder: bearer.branchOrder + 1,
      continuation: false,
      samples,
    })

    const stations = random.integer(...profile.stations)
    const massRadius = random.range(...profile.massRadius)
    for (let station = 0; station < stations; station += 1) {
      // Packed into a ball at the shoot's end. The stations overlap on purpose:
      // a mass is only a mass if its cards interpenetrate.
      const offset = vec3(
        random.signed() * massRadius,
        random.signed() * massRadius * 0.72,
        random.signed() * massRadius,
      )
      const along = random.range(0.72, 1.02)
      const center = add(
        add(
          sampleAxisPosition(samples, along),
          multiply(direction, massRadius * 0.35),
        ),
        offset,
      )
      organs.push({
        partId: id,
        center,
        axis: normalize(add(direction, vec3(0, random.range(0.05, 0.3), 0))),
        radius: random.range(...profile.organRadius),
        depth: random.range(...profile.organDepth),
        // Stations nearer the shoot's own axis are shaded by the ones outside
        // them, which is what gives a mass any interior at all.
        occlusion: station === 0 ? random.range(0.4, 0.72) : random.range(0.02, 0.4),
        organModel: profile.organModel,
        seed: Math.floor(random.unit() * 0x7fffffff),
      })
    }
  }
  return { axes, organs }
}
