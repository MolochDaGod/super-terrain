import { add, clamp, multiply, normalize, TreeRandom, vec3 } from '../math'
import { TREE_SPECIES_PRESETS, type SemanticTreePart, type TreeParameters } from '../types'
import { axisDirection, sampledAxis, samplePartPosition } from './axis'
import { whorledProfile } from './profiles/whorledProfiles'
import type { GrowthRegimeResult } from './types'

/** Persistent leader plus explicit radial tiers and drooping secondaries. */
export function growWhorledCrown(
  parameters: TreeParameters,
  trunk: SemanticTreePart,
  random: TreeRandom,
): GrowthRegimeResult {
  const profile = whorledProfile(parameters.species)
  // The profile's lengths are metres, and they describe a mature tree of the
  // species. Read literally they gave a five-metre sapling the same
  // seventy-centimetre needle sprays and two-metre whorl branches as a
  // thirty-four-metre veteran, which is the shrunken-adult failure in its
  // purest form: a Christmas tree wearing a forest's foliage.
  const sizeScale = clamp(
    parameters.crownRadius / TREE_SPECIES_PRESETS[parameters.species].crownRadius,
    0.18,
    1.15,
  )
  // Branch lengths scale with the individual; needle sprays do not scale with
  // it nearly as fast, because a young spruce's needles are the same
  // centimetres long as an old one's — only the branchlet carrying them is
  // shorter. The square root is that difference, and without it a sapling's
  // foliage shrank to wire.
  const organScale = Math.sqrt(sizeScale)
  const axes: GrowthRegimeResult['axes'] = []
  const organs: GrowthRegimeResult['organs'] = []
  const tierCount = Math.max(
    profile.tierRange[0],
    Math.min(profile.tierRange[1], parameters.branchCount + profile.tierOffset),
  )
  const phase = random.range(0, Math.PI * 2)
  for (let tier = 0; tier < tierCount; tier += 1) {
    const u = tier / Math.max(1, tierCount - 1)
    const attachment = Math.max(
      profile.crownBase,
      Math.min(
        profile.crownTop,
        profile.crownBase + u * (profile.crownTop - profile.crownBase) +
          random.range(-profile.tierJitter, profile.tierJitter),
      ),
    )
    const tierRadius = (
      profile.tierRadiusFloor * sizeScale +
        parameters.crownRadius * Math.pow(1 - u, profile.tierRadiusExponent)
    ) *
      random.range(0.86, 1.06)
    const branchCount = tier < 2 ? profile.branches[0] : profile.branches[1]
    for (let branch = 0; branch < branchCount; branch += 1) {
      const azimuth = phase + tier * 0.47 + branch / branchCount * Math.PI * 2 +
        random.range(-0.08, 0.08)
      const start = samplePartPosition(trunk, attachment)
      const direction = normalize(vec3(
        Math.cos(azimuth),
        profile.branchLift[0] + u * (profile.branchLift[1] - profile.branchLift[0]),
        Math.sin(azimuth),
      ))
      const baseRadius = parameters.trunkRadius * (0.13 + (1 - u) * 0.08)
      const id = `whorl-${tier + 1}-${branch + 1}`
      const samples = sampledAxis(
        start,
        direction,
        tierRadius,
        baseRadius,
        Math.max(0.014, baseRadius * 0.13),
        random,
        {
          samples: 8,
          sag: profile.sag[1] + (1 - u) * (profile.sag[0] - profile.sag[1]),
          crook: 0.012,
        },
      )
      axes.push({
        id,
        parentId: trunk.id,
        attachment,
        branchOrder: 1,
        continuation: false,
        samples,
      })
      const axis = axisDirection(samples)
      const stationCount = Math.max(
        4,
        Math.round(profile.stationCount * parameters.foliageDensity),
      )
      for (let station = 0; station < stationCount; station += 1) {
        // Foliage begins close to the bole, not a third of the way out.
        //
        // Starting at 0.32 left every tier with a bare inner third, and since
        // a spruce carries ten to sixteen tiers that added up to a clear orange
        // pole running the whole height of the crown with rings of foliage
        // hanging off it. A conifer's branchlets are borne along essentially
        // the whole branch; what keeps the trunk visible in a real stand is
        // the dead lower crown, which the crown-base fraction already handles.
        const along = 0.13 + station / Math.max(1, stationCount - 1) * 0.87
        const sample = samples[Math.round(along * (samples.length - 1))]!
        organs.push({
          partId: id,
          center: add(sample.position, vec3(
            random.signed() * 0.22 * sizeScale,
            -random.unit() * 0.22 * sizeScale,
            random.signed() * 0.22 * sizeScale,
          )),
          axis,
          radius: (profile.organRadius[0] +
            (1 - u) * (profile.organRadius[1] - profile.organRadius[0])) * organScale,
          depth: profile.organDepth * organScale,
          occlusion: random.range(0.05, 0.58),
          organModel: profile.organModel,
          seed: Math.floor(random.unit() * 0x7fffffff),
        })
      }
      // Hanging branchlets are the signature of Norway spruce. They are real
      // axes so their silhouette and shadow survive beyond the atlas.
      const hangingCount = profile.hangingCount
      for (let hanging = 0; hanging < hangingCount; hanging += 1) {
        const along = 0.48 + hanging * 0.27
        const source = samples[Math.round(along * (samples.length - 1))]!
        const hangingId = `${id}-drop-${hanging + 1}`
        const hangingSamples = sampledAxis(
          source.position,
          normalize(add(multiply(direction, 0.34), vec3(0, -1, 0))),
          tierRadius * random.range(...profile.hangingLength),
          source.radius * 0.42,
          0.012,
          random,
          { samples: 5, sag: 0.12, crook: 0.02 },
        )
        axes.push({
          id: hangingId,
          parentId: id,
          attachment: along,
          branchOrder: 2,
          continuation: false,
          samples: hangingSamples,
        })
        const hangingTip = hangingSamples.at(-1)!
        const hangingAxis = axisDirection(hangingSamples)
        for (let station = 0; station < profile.hangingStations; station += 1) {
          organs.push({
            partId: hangingId,
            center: add(hangingTip.position, vec3(
              random.signed() * 0.18 * sizeScale,
              station * -0.12 * sizeScale,
              random.signed() * 0.18 * sizeScale,
            )),
            axis: hangingAxis,
            radius: profile.organRadius[0] * 0.9 * organScale,
            depth: profile.organDepth * 0.9 * organScale,
            occlusion: random.range(0.08, 0.62),
            organModel: profile.organModel,
            seed: Math.floor(random.unit() * 0x7fffffff),
          })
        }
      }
    }
  }
  return { axes, organs }
}
