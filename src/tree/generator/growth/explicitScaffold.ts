import { add, multiply, normalize, subtract, TreeRandom, vec3 } from '../math'
import type { TreeParameters, SemanticTreePart } from '../types'
import {
  axisDirectionAt,
  sampledAxis,
  sampleAxisPosition,
  samplePartPosition,
} from './axis'
import { explicitScaffoldProfile } from './profiles/explicitScaffoldProfiles'
import type { GrowthRegimeResult, OrganStationDraft } from './types'

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/** Heavy, deliberately placed scaffolds for bottle trees and tall buttressed trees. */
export function growExplicitScaffold(
  parameters: TreeParameters,
  trunk: SemanticTreePart,
  random: TreeRandom,
): GrowthRegimeResult {
  const profile = explicitScaffoldProfile(parameters.species)
  const axes: GrowthRegimeResult['axes'] = []
  const organs: OrganStationDraft[] = []
  const primaryCount = parameters.branchCount
  const primaryAxes: GrowthRegimeResult['axes'] = []
  const phase = random.range(0, Math.PI * 2)
  const authoredContinuation = profile.scaffolds?.some((scaffold) => scaffold.continuation)
  if (!profile.leader && !authoredContinuation && profile.terminalLeaderLength > 0) {
    // The main bole must dissolve into a living fork rather than stop in a
    // conspicuous flat cut. This short, tapering continuation is subordinate
    // to the crown; it closes the bole without recreating a central pole.
    const start = samplePartPosition(trunk, 1)
    const azimuth = phase + random.range(-0.8, 0.8)
    const direction = normalize(vec3(
      Math.cos(azimuth),
      profile.terminalLeaderRise,
      Math.sin(azimuth),
    ))
    const baseRadius = trunk.spine.at(-1)!.radius * 0.88
    const samples = sampledAxis(
      start,
      direction,
      parameters.crownRadius * profile.terminalLeaderLength,
      baseRadius,
      0.008,
      random,
      { samples: 7, rise: 0.12, sag: 0.02, crook: 0.1 },
    )
    const leaderId = 'regime-terminal-leader'
    axes.push({
      id: leaderId,
      parentId: trunk.id,
      attachment: 1,
      branchOrder: 1,
      continuation: true,
      samples,
    })
    const terminalOrganRandom = new TreeRandom(parameters.seed ^ 0x4f1bbcdc)
    const stationCount = Math.round(
      profile.foliageStations * parameters.foliageDensity * 0.42,
    )
    for (let station = 0; station < stationCount; station += 1) {
      const stationT = terminalOrganRandom.range(0.36, 1)
      const stationPosition = sampleAxisPosition(samples, stationT)
      organs.push({
        partId: leaderId,
        center: add(stationPosition, vec3(
          terminalOrganRandom.signed() * profile.organRadius * 0.34,
          terminalOrganRandom.signed() * profile.organRadius * 0.24,
          terminalOrganRandom.signed() * profile.organRadius * 0.34,
        )),
        axis: axisDirectionAt(samples, stationT),
        radius: profile.organRadius,
        depth: profile.organDepth,
        occlusion: terminalOrganRandom.range(0.08, 0.66),
        organModel: 'broadleaf-spray',
        seed: Math.floor(terminalOrganRandom.unit() * 0x7fffffff),
      })
    }
  }
  for (let primary = 0; primary < primaryCount; primary += 1) {
    const authored = profile.scaffolds?.[primary % profile.scaffolds.length]
    const parentAxis = authored?.parentScaffold === undefined
      ? undefined
      : primaryAxes[authored.parentScaffold]
    // The first axis is the continuing leader, which prevents an exposed flat
    // cap at the top of the bole. The other heavy scaffolds leave a compact
    // upper crown band instead of being spread down half the clear trunk.
    const isLeader = (profile.leader && primary === 0) || authored?.continuation === true
    const attachment = parentAxis
      ? authored?.parentAttachment ?? 0.56
      : isLeader
      ? 1
      : authored?.attachment ?? random.range(...profile.attachment)
    const start = parentAxis
      ? sampleAxisPosition(parentAxis.samples, attachment)
      : samplePartPosition(trunk, attachment)
    const azimuth = phase + (authored?.azimuth ?? primary * GOLDEN_ANGLE) +
      random.range(
        -(authored ? 0.12 : profile.azimuthJitter ?? 0.28),
        authored ? 0.12 : profile.azimuthJitter ?? 0.28,
      )
    const rise = isLeader
      ? authored?.rise ?? random.range(1.3, 2.1)
      : authored?.rise ?? random.range(...profile.primaryRise)
    const authoredDirection = normalize(vec3(Math.cos(azimuth), rise, Math.sin(azimuth)))
    const trunkTipDirection = normalize(
      subtract(
        trunk.spine.at(-1)!.position,
        trunk.spine.at(-2)!.position,
      ),
      vec3(0, 1, 0),
    )
    const direction = authored?.continuation
      ? normalize(add(trunkTipDirection, vec3(
          Math.cos(azimuth) * 0.18,
          0.05,
          Math.sin(azimuth) * 0.18,
        )))
      : authoredDirection
    const attachmentTangent = parentAxis
      ? axisDirectionAt(parentAxis.samples, attachment)
      : normalize(
          subtract(
            samplePartPosition(trunk, Math.min(1, attachment + 0.025)),
            samplePartPosition(trunk, Math.max(0, attachment - 0.025)),
          ),
          trunkTipDirection,
        )
    const baseBlend = !isLeader ? profile.primaryBaseBlend ?? 0 : 0
    const attachmentDirection = baseBlend > 0
      ? normalize(add(
          multiply(attachmentTangent, baseBlend),
          multiply(direction, 1 - baseBlend),
        ))
      : undefined
    const subordinate = !isLeader && primary >= (profile.dominantScaffolds ?? primaryCount)
    const length = parameters.crownRadius * random.range(...profile.primaryLength) *
      (authored?.lengthScale ?? 1) *
      (subordinate ? profile.subordinateLengthScale ?? 1 : 1)
    const parentSample = parentAxis?.samples[
      Math.min(
        parentAxis.samples.length - 1,
        Math.round(attachment * (parentAxis.samples.length - 1)),
      )
    ]
    const baseRadius = parentSample
      ? parentSample.radius * random.range(0.46, 0.62)
      : isLeader
      ? trunk.spine.at(-1)!.radius * 0.94
      : parameters.trunkRadius * random.range(...profile.primaryRadius) *
        (subordinate ? profile.subordinateRadiusScale ?? 1 : 1)
    const primaryOrder = parentAxis ? parentAxis.branchOrder + 1 : 1
    const primaryId = `regime-primary-${primary + 1}`
    const primarySamples = sampledAxis(
      start,
      direction,
      length,
      baseRadius,
      Math.max(0.012, baseRadius * 0.12),
      random,
      {
        samples: 11,
        rise: 0.2,
        sag: authored?.sag ?? profile.primarySag,
        midSag: profile.primaryMidSag,
        crook: authored?.crook ?? profile.primaryCrook,
        startTangent: attachmentDirection,
        // A collar needs a local tangent transition, not a several-metre
        // vertical detour.  Keeping this profile-driven lets spreading veteran
        // crowns turn out promptly while upright scaffold species can retain a
        // longer bole-aligned departure.
        startTangentStrength: profile.primaryStartTangentStrength ?? 0.62,
      },
    )
    const primaryAxis = {
      id: primaryId,
      parentId: parentAxis?.id ?? trunk.id,
      attachment,
      branchOrder: primaryOrder,
      continuation: isLeader,
      samples: primarySamples,
    }
    axes.push(primaryAxis)
    primaryAxes.push(primaryAxis)
    // Cover the outer scaffold itself as well as its lateral twigs. Otherwise
    // a primary that happens not to receive a secondary near its last sample
    // ends as a conspicuous sawn pole projecting through the canopy.
    const organRandom = new TreeRandom(
      (parameters.seed ^ 0x68bc21eb ^ Math.imul(primary + 1, 0x9e3779b1)) >>> 0,
    )
    const crownScale = subordinate
      ? organRandom.range(0.66, 0.84)
      : organRandom.range(0.94, 1.12)
    const primaryStationCount = Math.round(
      profile.primaryFoliageStations * parameters.foliageDensity * crownScale,
    )
    for (let station = 0; station < primaryStationCount; station += 1) {
      const stationT = station === 0 ? 0.96 : organRandom.range(0.58, 1)
      const stationPosition = sampleAxisPosition(primarySamples, stationT)
      const organScale = crownScale * organRandom.range(0.72, 1.2) *
        terminalScale(profile, station)
      organs.push({
        partId: primaryId,
        center: add(
          stationPosition,
          organOffset(profile, organRandom, station === 0 ? 0.22 : 0.8, organScale),
        ),
        axis: axisDirectionAt(primarySamples, stationT),
        radius: profile.organRadius * organScale,
        depth: profile.organDepth * organScale * organRandom.range(0.88, 1.12),
        occlusion: organRandom.range(0.05, 0.62),
        organModel: 'broadleaf-spray',
        seed: Math.floor(organRandom.unit() * 0x7fffffff),
      })
    }
    const continuationCrownScale = isLeader
      ? profile.continuationCrownScale ?? 1
      : 1
    const secondaryCount = Math.max(
      1,
      Math.round(profile.secondaryCount * continuationCrownScale),
    )
    for (let secondary = 0; secondary < secondaryCount; secondary += 1) {
      // Exactly one child continues the primary from its terminal ring. A
      // continuation anywhere but attachment=1 violates the mesher contract:
      // it shares the parent's end ring and would otherwise stretch that ring
      // backwards to a mid-axis source. The remaining children are laterals.
      const continuesPrimary = secondary === 0
      const along = continuesPrimary
        ? 1
        : random.range(...(profile.secondarySpan ?? [0.42, 0.88]))
      const sourceIndex = Math.min(
        primarySamples.length - 1,
        Math.round(along * (primarySamples.length - 1)),
      )
      const source = primarySamples[sourceIndex]!
      const secondaryAzimuth = azimuth + (secondary % 2 ? 1 : -1) *
        random.range(0.48, 1.18) + random.range(-0.22, 0.22)
      const parentTipDirection = axisDirectionAt(primarySamples, 1)
      const secondaryDirection = continuesPrimary
        ? normalize(add(parentTipDirection, vec3(
            Math.cos(secondaryAzimuth) * random.range(0.06, 0.14),
            random.range(-0.03, 0.08),
            Math.sin(secondaryAzimuth) * random.range(0.06, 0.14),
          )))
        : normalize(vec3(
            Math.cos(secondaryAzimuth),
            random.range(...profile.secondaryRise),
            Math.sin(secondaryAzimuth),
          ))
      const secondaryLength = parameters.crownRadius *
        random.range(...profile.secondaryLength) *
        (continuesPrimary ? random.range(0.74, 0.9) : 1) *
        continuationCrownScale
      // A continuation shares the parent's terminal ring, so it must inherit
      // nearly the same girth. Treating it like a lateral child pinched the
      // shared ring down by half in a single segment and produced the hard,
      // antler-like elbows visible in the hero view.
      const secondaryRadius = source.radius * (continuesPrimary
        ? random.range(0.84, 0.94)
        : random.range(0.42, 0.62))
      const secondaryId = `${primaryId}-secondary-${secondary + 1}`
      const secondarySamples = sampledAxis(
        source.position,
        secondaryDirection,
        secondaryLength,
        secondaryRadius,
        Math.max(0.008, secondaryRadius * 0.06),
        random,
        {
          samples: 8,
          rise: continuesPrimary ? 0.04 : 0.14,
          sag: profile.secondarySag * (continuesPrimary ? 0.62 : 1),
          midSag: (profile.secondaryMidSag ?? 0) * (continuesPrimary ? 0.58 : 1),
          crook: profile.secondaryCrook * (continuesPrimary ? 0.72 : 1),
        },
      )
      axes.push({
        id: secondaryId,
        parentId: primaryId,
        attachment: along,
        branchOrder: primaryOrder + 1,
        continuation: continuesPrimary,
        samples: secondarySamples,
      })
      const hasTertiaryCrown = (profile.tertiaryCount ?? 0) > 0
      const stationCount = Math.round(
        profile.foliageStations * parameters.foliageDensity * crownScale *
          (hasTertiaryCrown ? 0.22 : 1) * continuationCrownScale,
      )
      for (let station = 0; station < stationCount; station += 1) {
        // A crown is foliage borne along the outer twigs, not dozens of cards
        // collapsed onto every cut tip. Sampling the live outer span turns the
        // scaffold into a connected crown while preserving open windows.
        const stationT = station === 0
          ? 0.96
          : organRandom.range(...profile.foliageSpan)
        const stationPosition = sampleAxisPosition(secondarySamples, stationT)
        const organScale = crownScale * organRandom.range(0.68, 1.24) *
          terminalScale(profile, station)
        organs.push({
          partId: secondaryId,
          center: add(
            stationPosition,
            organOffset(profile, organRandom, station === 0 ? 0.24 : 1, organScale),
          ),
          axis: axisDirectionAt(secondarySamples, stationT),
          radius: profile.organRadius * organScale,
          depth: profile.organDepth * organScale * organRandom.range(0.86, 1.14),
          occlusion: organRandom.range(0.05, 0.72),
          organModel: 'broadleaf-spray',
          seed: Math.floor(organRandom.unit() * 0x7fffffff),
        })
      }
      const tertiaryCount = Math.round(
        (profile.tertiaryCount ?? 0) * continuationCrownScale,
      )
      for (let tertiary = 0; tertiary < tertiaryCount; tertiary += 1) {
        const continuesSecondary = tertiary === 0
        const tertiaryAlong = continuesSecondary
          ? 1
          : Math.min(
              0.9,
              0.34 + (tertiary - 1 + organRandom.range(0.08, 0.34)) /
                Math.max(1, tertiaryCount - 1) * 0.56,
            )
        const tertiarySource = sampleAxisPosition(secondarySamples, tertiaryAlong)
        const secondaryTangent = axisDirectionAt(secondarySamples, tertiaryAlong)
        const forkSign = (secondary + tertiary) % 2 === 0 ? 1 : -1
        const tertiaryAzimuth = Math.atan2(secondaryTangent.z, secondaryTangent.x) +
          forkSign * organRandom.range(0.5, 1.08) + organRandom.range(-0.2, 0.2)
        const tertiaryDirection = continuesSecondary
          ? normalize(add(secondaryTangent, vec3(
              Math.cos(tertiaryAzimuth) * organRandom.range(0.05, 0.12),
              organRandom.range(-0.02, 0.07),
              Math.sin(tertiaryAzimuth) * organRandom.range(0.05, 0.12),
            )))
          : normalize(vec3(
              Math.cos(tertiaryAzimuth),
              organRandom.range(...(profile.tertiaryRise ?? [0.12, 0.7])),
              Math.sin(tertiaryAzimuth),
            ))
        const tertiaryLength = parameters.crownRadius *
          organRandom.range(...(profile.tertiaryLength ?? [0.1, 0.22])) *
          (continuesSecondary ? organRandom.range(0.72, 0.9) : 1) *
          continuationCrownScale
        const sourceRadius = secondarySamples[
          Math.min(
            secondarySamples.length - 1,
            Math.round(tertiaryAlong * (secondarySamples.length - 1)),
          )
        ]!.radius
        const tertiaryRadius = sourceRadius * (continuesSecondary
          ? organRandom.range(0.82, 0.92)
          : organRandom.range(0.3, 0.48))
        const tertiaryId = `${secondaryId}-tertiary-${tertiary + 1}`
        const tertiarySamples = sampledAxis(
          tertiarySource,
          tertiaryDirection,
          tertiaryLength,
          tertiaryRadius,
          Math.max(0.004, tertiaryRadius * 0.035),
          random,
          {
            samples: 7,
            rise: continuesSecondary ? 0.035 : 0.1,
            sag: (profile.tertiarySag ?? 0.035) * (continuesSecondary ? 0.62 : 1),
            midSag: (profile.secondaryMidSag ?? 0) *
              (continuesSecondary ? 0.24 : 0.45),
            crook: (profile.tertiaryCrook ?? 0.1) *
              (continuesSecondary ? 0.7 : 1),
          },
        )
        axes.push({
          id: tertiaryId,
          parentId: secondaryId,
          attachment: tertiaryAlong,
          branchOrder: primaryOrder + 2,
          continuation: continuesSecondary,
          samples: tertiarySamples,
        })
        const tertiaryStationCount = Math.round(
          (profile.tertiaryFoliageStations ?? profile.foliageStations * 0.4) *
            parameters.foliageDensity * crownScale * continuationCrownScale,
        )
        for (let station = 0; station < tertiaryStationCount; station += 1) {
          const stationT = station === 0
            ? 0.96
            : organRandom.range(0.28, 1)
          const stationPosition = sampleAxisPosition(tertiarySamples, stationT)
          const organScale = crownScale * organRandom.range(0.62, 1.08) *
            terminalScale(profile, station)
          organs.push({
            partId: tertiaryId,
            center: add(
              stationPosition,
              organOffset(profile, organRandom, station === 0 ? 0.22 : 0.92, organScale),
            ),
            axis: axisDirectionAt(tertiarySamples, stationT),
            radius: profile.organRadius * organScale,
            depth: profile.organDepth * organScale * organRandom.range(0.82, 1.08),
            occlusion: organRandom.range(0.04, 0.62),
            organModel: 'broadleaf-spray',
            seed: Math.floor(organRandom.unit() * 0x7fffffff),
          })
        }
      }
    }
  }
  return { axes, organs }
}

function terminalScale(
  profile: ReturnType<typeof explicitScaffoldProfile>,
  station: number,
): number {
  return station === 0 ? profile.terminalOrganScale ?? 1 : 1
}

function organOffset(
  profile: ReturnType<typeof explicitScaffoldProfile>,
  random: TreeRandom,
  layerScale: number,
  organScale: number,
) {
  const spread = profile.organRadius *
    (profile.foliageJitterScale ?? 0.42) * layerScale * organScale
  return vec3(
    random.signed() * spread,
    random.signed() * spread * 0.62,
    random.signed() * spread,
  )
}
