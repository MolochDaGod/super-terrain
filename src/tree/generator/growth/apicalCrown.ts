import {
  add,
  clamp,
  hashUnit,
  lerpNumber,
  multiply,
  normalize,
  smoothstep,
  TreeRandom,
  vec3,
} from '../math'
import type { SemanticTreePart, TreeParameters } from '../types'
import { apicalCrownProfile } from './profiles/apicalCrownProfiles'
import type { GrowthRegimeResult } from './types'

/** Palm crown: one woody axis and a radial stack of long, arching frond cards. */
export function growApicalCrown(
  parameters: TreeParameters,
  trunk: SemanticTreePart,
  random: TreeRandom,
): GrowthRegimeResult {
  const profile = apicalCrownProfile(parameters.species)
  const axes: GrowthRegimeResult['axes'] = []
  const organs: GrowthRegimeResult['organs'] = []
  const fruits: NonNullable<GrowthRegimeResult['fruits']> = []
  const trunkTip = trunk.spine.at(-1)!
  const top = trunkTip.position
  const budId = 'regime-apical-bud'
  const budHeight = parameters.trunkRadius * profile.budHeight
  const budSamples = Array.from({ length: 7 }, (_, index) => {
    const t = index / 6
    // The live crown bud is a continuous taper out of the stipe. A swell that
    // peaked one station above the trunk made a hard horizontal flange beneath
    // the fronds—the exact silhouette of a separate saucer glued on top.
    const swell = lerpNumber(
      Math.min(1.06, profile.budSwell),
      0.07,
      smoothstep(0.06, 1, t),
    )
    return {
      position: add(top, vec3(0, budHeight * t, 0)),
      radius: Math.max(0.022, trunkTip.radius * swell),
    }
  })
  axes.push({
    id: budId,
    parentId: trunk.id,
    attachment: 1,
    branchOrder: 1,
    continuation: true,
    samples: budSamples,
  })
  const count = Math.max(
    profile.minimumOrgans,
    Math.round(parameters.branchCount * (
      profile.authoredCountScale + parameters.foliageDensity * profile.densityCountScale
    )),
  )
  const phase = random.range(0, Math.PI * 2)

  for (let index = 0; index < count; index += 1) {
    const ageBand = index / Math.max(1, count - 1)
    const spear = ageBand < 0.1
    const senescence = smoothstep(0.7, 1, ageBand)
    // Sparse attrition in the older ranks prevents a perfect radial cog while
    // preserving the dense protected spear leaves in the centre.
    if (!spear && random.unit() < 0.025 + senescence * 0.15) continue
    const azimuth = phase + index * Math.PI * (3 - Math.sqrt(5)) +
      random.range(-0.075, 0.075)
    const oldSkirt = ageBand > 0.64
    const lift = profile.liftTop - ageBand * profile.liftDrop +
      (spear ? (1 - ageBand / 0.11) * 0.3 : 0) -
      (oldSkirt ? (ageBand - 0.68) / 0.32 * profile.oldSkirtDrop : 0) +
      random.range(-profile.liftJitter, profile.liftJitter)
    const axis = normalize(vec3(Math.cos(azimuth), lift, Math.sin(azimuth)))
    const bowlT = clamp(
      0.86 - ageBand * profile.attachmentDrop + random.range(-0.035, 0.035),
      0.14,
      0.9,
    )
    const bowlIndex = Math.min(5, Math.max(1, Math.round(bowlT * 6)))
    const bowlSample = budSamples[bowlIndex]!
    const fullLength = parameters.crownRadius * random.range(...profile.depth) *
      (spear ? random.range(0.34, 0.55) : oldSkirt ? random.range(0.74, 0.94) : 1)
    const petioleLength = fullLength * random.range(...profile.petioleLength)
    const petioleBaseRadius = Math.min(
      bowlSample.radius * 0.32,
      parameters.trunkRadius * random.range(...profile.petioleRadius),
    )
    const petioleId = `regime-apical-petiole-${index + 1}`
    const petioleSamples = Array.from({ length: 5 }, (_, sampleIndex) => {
      const t = sampleIndex / 4
      const launch = multiply(axis, petioleLength * t)
      const crownOrbit = multiply(
        vec3(Math.cos(azimuth), 0, Math.sin(azimuth)),
        parameters.trunkRadius * profile.attachmentRadius * Math.sin(t * Math.PI * 0.5),
      )
      const bend = vec3(
        0,
        Math.sin(t * Math.PI * 0.5) * petioleLength * 0.045,
        0,
      )
      return {
        position: add(add(add(bowlSample.position, launch), crownOrbit), bend),
        radius: lerpNumber(petioleBaseRadius, Math.max(0.012, petioleBaseRadius * 0.38), t),
      }
    })
    axes.push({
      id: petioleId,
      // Authored to begin inside the stipe's leaf-base zone; a projected collar
      // would merge hundreds of these into a polygonal bell.
      embedded: true,
      parentId: budId,
      attachment: bowlT,
      branchOrder: 2,
      continuation: false,
      samples: petioleSamples,
    })
    const petioleTip = petioleSamples.at(-1)!
    const frondAxis = normalize(
      {
        x: petioleTip.position.x - petioleSamples.at(-2)!.position.x,
        y: petioleTip.position.y - petioleSamples.at(-2)!.position.y,
        z: petioleTip.position.z - petioleSamples.at(-2)!.position.z,
      },
      axis,
    )
    organs.push({
      partId: petioleId,
      // The atlas begins at the swept petiole tip with a small overlap, so its
      // transparent margin cannot open a floating gap at the crown.
      center: add(petioleTip.position, multiply(frondAxis, -0.035)),
      axis: frondAxis,
      radius: parameters.crownRadius * random.range(...profile.radius) *
        (spear ? random.range(0.74, 0.9) : lerpNumber(1, 0.62, senescence)),
      depth: Math.max(parameters.trunkRadius, fullLength - petioleLength * 0.72),
      occlusion: ageBand * profile.ageOcclusion,
      senescence,
      development: spear ? clamp(ageBand / 0.1, 0.05, 0.52) : 1,
      organModel: 'frond',
      seed: Math.floor(random.unit() * 0x7fffffff),
    })
  }

  // Date bunches are separate fleshy organs, not orange blobs painted into the
  // leaf atlas or bark-coloured beads swept into a woody tube. The peduncle is
  // structural wood; the compiler instances individual fruit below its tip.
  for (let clusterIndex = 0; clusterIndex < profile.fruitClusters; clusterIndex += 1) {
    const azimuth = phase + (clusterIndex + 0.35) * Math.PI * (3 - Math.sqrt(5))
    const radial = vec3(Math.cos(azimuth), 0, Math.sin(azimuth))
    const sourceIndex = 2 + (clusterIndex % 2)
    const source = budSamples[sourceIndex]!
    const stalkLength = parameters.crownRadius * random.range(0.11, 0.16)
    const stalkId = `regime-apical-fruit-stalk-${clusterIndex + 1}`
    const stalkSamples = Array.from({ length: 6 }, (_, sampleIndex) => {
      const t = sampleIndex / 5
      return {
        position: add(
          source.position,
          add(
            multiply(radial, stalkLength * (0.24 * t + 0.76 * Math.sin(t * Math.PI * 0.5))),
            vec3(0, -stalkLength * t * t * 0.48, 0),
          ),
        ),
        radius: lerpNumber(
          parameters.trunkRadius * 0.075,
          parameters.trunkRadius * 0.024,
          t,
        ),
      }
    })
    axes.push({
      id: stalkId,
      parentId: budId,
      attachment: sourceIndex / 6,
      branchOrder: 2,
      continuation: false,
      samples: stalkSamples,
    })
    if (profile.fruitModel === 'coconut-cluster') {
      const clusterTip = stalkSamples.at(-1)!.position
      fruits.push({
        model: 'coconut-cluster',
        partId: stalkId,
        center: clusterTip,
        axis: vec3(0, -1, 0),
        radial,
        strandCount: 1,
        spread: parameters.crownRadius * random.range(0.035, 0.055),
        length: parameters.crownRadius * random.range(...profile.fruitLength),
        fruitRadius: parameters.trunkRadius * random.range(...profile.fruitRadius),
        count: Math.round(random.range(...profile.fruitsPerCluster)),
        seed: Math.floor(random.unit() * 0x7fffffff),
      })
      continue
    }
    const bunchSpread = parameters.crownRadius * random.range(0.075, 0.105)
    const bunchLength = parameters.crownRadius * random.range(...profile.fruitLength)
    const bunchCenter = stalkSamples.at(-1)!.position
    const tangent = vec3(-Math.sin(azimuth), 0, Math.cos(azimuth))
    const strandCount = Math.round(random.range(...profile.fruitStrands))
    const fruitSeed = Math.floor(random.unit() * 0x7fffffff)
    for (let strandIndex = 0; strandIndex < strandCount; strandIndex += 1) {
      // A date bunch is a broad, lopsided fan of rachillae. Rotating equal
      // strands through 360 degrees creates the unmistakable procedural cone
      // and exposes every fruit as a bead on a string.
      const fanT = strandIndex / Math.max(1, strandCount - 1)
      const strandAngle = (fanT - 0.5) * 1.7 +
        (hashUnit(strandIndex, fruitSeed, strandCount, 17) - 0.5) * 0.14
      const strandOffset = add(
        multiply(radial, Math.cos(strandAngle)),
        multiply(tangent, Math.sin(strandAngle)),
      )
      const strandId = `${stalkId}-rachilla-${strandIndex + 1}`
      axes.push({
        id: strandId,
        parentId: stalkId,
        attachment: 1,
        branchOrder: 3,
        continuation: false,
        samples: Array.from({ length: 7 }, (_, sampleIndex) => {
          const t = sampleIndex / 6
          return {
            position: add(
              bunchCenter,
              add(
                multiply(strandOffset, bunchSpread * Math.sin(t * Math.PI * 0.72)),
                vec3(0, -bunchLength * t, 0),
              ),
            ),
            radius: lerpNumber(
              parameters.trunkRadius * 0.016,
              parameters.trunkRadius * 0.004,
              t,
            ),
          }
        }),
      })
    }
    fruits.push({
      model: 'date-bunch',
      partId: stalkId,
      center: bunchCenter,
      axis: vec3(0, -1, 0),
      radial,
      strandCount,
      spread: bunchSpread,
      length: bunchLength,
      fruitRadius: parameters.trunkRadius * random.range(...profile.fruitRadius),
      count: Math.round(random.range(...profile.fruitsPerCluster)),
      seed: fruitSeed,
    })
  }
  return { axes, organs, fruits }
}
