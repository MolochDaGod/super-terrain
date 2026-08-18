import {
  MeshStandardNodeMaterial,
  type Node,
  type UniformNode,
} from 'three/webgpu'
import {
  attribute,
  cameraViewMatrix,
  clamp,
  color,
  float,
  hash,
  mix,
  mx_noise_float,
  mx_noise_vec3,
  normalLocal,
  normalWorldGeometry,
  normalize as tslNormalize,
  oneMinus,
  positionWorld,
  smoothstep,
  texture,
  transformNormalToView,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
  viewportCoordinate,
} from 'three/tsl'
import { graniteDetailSurface } from './graniteDetailSurface'
import type { GraniteLodWeights } from './graniteRockLod'
import type {
  GraniteLodLevel,
  GraniteRockResources,
} from './graniteRockResources'
import type { GraniteRockParameters } from './types'

interface GraniteBiomeUniforms {
  snow: { value: number }
  wetness: { value: number }
  lichen: { value: number }
  moss: { value: number }
  detailStrength: { value: number }
  surfaceSeed: { value: number }
}

type GraniteBiomeParameters = Pick<
  GraniteRockParameters,
  'snow' | 'wetness' | 'lichen' | 'moss' | 'detailStrength' | 'surfaceSeed'
>

const LOD0_TRIANGLE_METRES = 0.054
const LOD_TRIANGLE_FACTOR = [1, 1.49, 2.23] as const

export interface GraniteLodDitherBoundaries {
  first: UniformNode<'float', number>
  second: UniformNode<'float', number>
}

export function createGraniteLodDitherBoundaries(
  weights: GraniteLodWeights,
): GraniteLodDitherBoundaries {
  return {
    first: uniform(weights[0]),
    second: uniform(weights[0] + weights[1]),
  }
}

function graniteWorldFields(
  surfaceSeed: UniformNode<'float', number>,
  placementScale: number,
  lodLevel: GraniteLodLevel,
) {
  const p = positionWorld
  const worldNoise = (
    frequency: number,
    phase: number,
    offset?: Node<'vec3'>,
  ) => mx_noise_float(
    (offset ? p.add(offset) : p)
      .mul(frequency)
      .add(surfaceSeed.mul(0.29).add(phase)),
  )
  const worldField = (frequency: number, phase: number) =>
    worldNoise(frequency, phase).mul(0.5).add(0.5)
  const worldGradient = (frequency: number, step: number, phase: number) => vec3(
    worldNoise(frequency, phase, vec3(step, 0, 0))
      .sub(worldNoise(frequency, phase, vec3(-step, 0, 0))),
    worldNoise(frequency, phase, vec3(0, step, 0))
      .sub(worldNoise(frequency, phase, vec3(0, -step, 0))),
    worldNoise(frequency, phase, vec3(0, 0, step))
      .sub(worldNoise(frequency, phase, vec3(0, 0, -step))),
  )
  const worldBump = (frequency: number, phase: number) =>
    mx_noise_vec3(p.mul(frequency).add(surfaceSeed.mul(0.29).add(phase)))
  const triangleMetres =
    LOD0_TRIANGLE_METRES * LOD_TRIANGLE_FACTOR[lodLevel] * placementScale
  const varyingLimitCyclesPerMetre = 0.5 / triangleMetres
  const coarseVarying = <T extends Node>(maxCyclesPerMetre: number, node: T): T =>
    (maxCyclesPerMetre <= varyingLimitCyclesPerMetre ? varying(node) : node) as T
  const viewOffset = (worldVector: Node<'vec3'>) => cameraViewMatrix.mul(vec4(
    worldVector.sub(normalWorldGeometry.mul(worldVector.dot(normalWorldGeometry))),
    0,
  )).xyz
  return {
    worldNoise,
    worldField,
    worldGradient,
    worldBump,
    coarseVarying,
    viewOffset,
  }
}

/** The exact realtime high-to-low granite material graph from scifi-kit. */
export function createGraniteRockMaterial(
  parameters: GraniteRockParameters,
  resources: GraniteRockResources,
  lodLevel: GraniteLodLevel,
  lodDither?: GraniteLodDitherBoundaries,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    name: 'fractured granite / realtime high-to-low surface',
    roughness: 0.82,
    metalness: 0.02,
  })
  const biomeUniforms = {
    snow: uniform(parameters.snow),
    wetness: uniform(parameters.wetness),
    lichen: uniform(parameters.lichen),
    moss: uniform(parameters.moss),
    detailStrength: uniform(parameters.detailStrength),
    surfaceSeed: uniform(parameters.surfaceSeed),
  }
  material.userData.graniteBiomeUniforms = biomeUniforms

  const atlas = uv()
  const usesBakedSurface = lodLevel <= 1
  const surfaceBakeMipBias = 0
  // Both close LODs now share the real unwrapped atlas topology. LOD1 is
  // simplified from that mesh with UV seams locked, so the structural bake can
  // remain a crisp per-pixel texture sample instead of a muddy vertex gradient.
  const normalAo = usesBakedSurface
    ? texture(resources.bakeTextures.normalAo, atlas).bias(float(surfaceBakeMipBias))
    : vec4(0.5, 0.5, 1, 1)
  const heightCurvature = usesBakedSurface
    ? texture(resources.bakeTextures.heightCurvature, atlas)
      .bias(float(surfaceBakeMipBias))
    : vec4(0.5, 0.5, 0, 0).xy
  const bakeValidity = usesBakedSurface
    ? attribute<'float'>('graniteBakeValid', 'float')
    : float(0)
  const proceduralFallback = usesBakedSurface
    ? oneMinus(bakeValidity)
    : float(0)
  const bakedHeight = heightCurvature.r.mul(2).sub(1).mul(bakeValidity)
  const bakedCurvature = heightCurvature.g.mul(2).sub(1).mul(bakeValidity)
  const bakedAo = mix(1, normalAo.a, bakeValidity)
  material.userData.graniteSurfaceBake = {
    enabled: usesBakedSurface,
    mipBias: surfaceBakeMipBias,
    effectiveMaximumSize: Math.max(
      1,
      resources.bakeTextures.normalAo.image.width / (2 ** surfaceBakeMipBias),
    ),
  }

  const p = positionWorld
  const surfaceSeed = biomeUniforms.surfaceSeed
  const {
    worldNoise,
    worldField,
    worldGradient,
    worldBump,
    coarseVarying,
    viewOffset,
  } = graniteWorldFields(surfaceSeed, parameters.placementScale, lodLevel)
  const macro = coarseVarying(6.4, vec4(
    mx_noise_float(vec3(p.x.mul(0.72), p.y.mul(1.05), p.z.mul(0.72))
      .add(surfaceSeed.mul(0.13))).mul(0.5).add(0.5),
    mx_noise_float(p.mul(2.8).add(surfaceSeed.mul(0.31))).mul(0.5).add(0.5),
    mx_noise_float(p.mul(0.82).add(surfaceSeed.mul(0.73))).mul(0.5).add(0.5),
    mx_noise_float(p.mul(6.4).add(surfaceSeed.mul(1.17))).mul(0.5).add(0.5),
  ))
  const detail = graniteDetailSurface(resources.detailTextures, {
    strength: lodLevel === 0 ? 1.05 : lodLevel === 1 ? 0.82 : 0.42,
  })

  const cavity = color(0x302f29)
  const darkGranite = color(0x42423d)
  const granite = color(0x5b5851)
  const paleGranite = color(0x8d887f)
  const feldspar = color(0x9c8b78)
  const biotite = color(0x24251f)
  const wetGranite = color(0x29302e)
  const mossDeep = color(0x222c14)
  const mossBody = color(0x41501f)
  const mossTip = color(0x64743a)
  const lichenBody = color(0x7f8768)
  const lichenCentre = color(0x99a07e)
  const lichenMargin = color(0xb4b6a1)
  const lichenFissure = color(0x4b4e3a)
  const lichenRustBody = color(0x8a6a34)
  const lichenRustCentre = color(0xa88f49)
  const snowShade = color(0x9fafc0)
  const snowLit = color(0xe1e6ea)

  let stone = mix(darkGranite, granite, smoothstep(0.18, 0.86, macro.x))
  stone = mix(stone, paleGranite, smoothstep(0.62, 0.94, macro.y).mul(0.16))
  stone = mix(
    stone,
    biotite,
    oneMinus(smoothstep(0.08, 0.32, detail.albedo)).mul(0.22),
  )
  stone = mix(stone, feldspar, smoothstep(0.62, 0.9, detail.albedo).mul(0.17))
  // Atlas-corrupt triangles cannot recover the measured bake, but they must
  // still read as granite rather than flat vertex colour. Build a lower-band
  // procedural substitute that survives minification, then use it only where
  // the seam guard disabled atlas sampling.
  const fallbackVariation = clamp(
    macro.y.mul(0.5).add(macro.w.mul(0.38)).add(detail.albedo.mul(0.12)),
    0,
    1,
  )
  let fallbackStone = stone.mul(mix(0.67, 1.2, fallbackVariation))
  fallbackStone = mix(
    fallbackStone,
    paleGranite,
    smoothstep(0.68, 0.93, macro.w).mul(0.14),
  )
  if (usesBakedSurface) {
    stone = mix(stone, paleGranite, smoothstep(0.2, 0.82, bakedCurvature).mul(0.18))
    stone = mix(stone, cavity, oneMinus(bakedAo).mul(0.28))
    stone = mix(
      stone,
      cavity,
      oneMinus(smoothstep(-0.72, -0.08, bakedHeight)).mul(0.11),
    )
    stone = mix(fallbackStone, stone, bakeValidity)
  }

  const upward = smoothstep(0.28, 0.86, normalWorldGeometry.y)
  const upwardBroad = smoothstep(-0.14, 0.62, normalWorldGeometry.y)
  const proceduralShelter = oneMinus(macro.y)
  const shelter = usesBakedSurface
    ? mix(proceduralShelter, clamp(
      oneMinus(bakedAo).mul(0.72)
        .add(oneMinus(smoothstep(-0.62, 0.02, bakedCurvature)).mul(0.28)),
      0,
      1,
    ), bakeValidity)
    : proceduralShelter
  const wetDistribution = clamp(
    shelter.mul(0.72).add(oneMinus(upward).mul(macro.w).mul(0.58)),
    0,
    1,
  )
  const wetMask = clamp(
    biomeUniforms.wetness.mul(1.55).sub(oneMinus(wetDistribution).mul(0.88)),
    0,
    1,
  )
  const proceduralDrainsOff = detail.height.mul(0.5).add(0.5)
  const drainsOff = usesBakedSurface
    ? mix(proceduralDrainsOff, smoothstep(-0.25, 0.7, bakedHeight)
      .mul(0.55)
      .add(detail.height.mul(0.22).add(0.5).mul(0.45)), bakeValidity)
    : proceduralDrainsOff
  const filmDepth = clamp(
    wetMask.mul(oneMinus(drainsOff).mul(0.4).add(0.8)),
    0,
    1,
  )

  const microBump = (
    lodLevel === 0 ? worldBump(56, 31.7) : vec3(0, 0, 0)
  ).toVar()
  const microRelief = lodLevel === 0
    ? clamp(microBump.y.mul(0.55).add(detail.height.mul(0.14)).add(0.5), 0, 1)
    : clamp(detail.height.mul(0.5).add(0.5), 0, 1)

  const mossClump = coarseVarying(8.5, worldField(8.5, 5.1))
  const mossClumpGradient = coarseVarying(
    8.5,
    worldGradient(8.5, 0.03, 5.1).mul(0.6),
  )
  const mossHabitat = clamp(
    shelter.mul(0.7).add(upward.mul(0.3)).add(wetMask.mul(0.22)),
    0,
    1,
  )
  const mossPotential = macro.z.mul(0.45)
    .add(0.55)
    .mul(mossHabitat)
    .mul(biomeUniforms.moss.mul(3.4))
  const mossColony = smoothstep(
    0,
    0.6,
    mossPotential.mul(1.25).sub(oneMinus(mossClump).mul(0.7)),
  )
  const mossMask = smoothstep(
    0.28,
    0.72,
    mossColony.mul(1.5).sub(0.25).sub(oneMinus(microRelief).mul(0.45)),
  )
  let mossColor = mix(
    mossBody,
    mossDeep,
    oneMinus(smoothstep(0.15, 0.6, microRelief)).mul(0.45),
  )
  mossColor = mix(
    mossColor,
    mossTip,
    smoothstep(0.7, 0.98, microRelief)
      .mul(smoothstep(0.55, 0.92, mossClump))
      .mul(0.35),
  )
  mossColor = mix(mossColor, mossDeep, wetMask.mul(0.3))

  const lichenHabitat = upwardBroad
    .mul(oneMinus(shelter.mul(0.65)))
    .mul(oneMinus(mossMask))
  const lichenField = clamp(
    worldNoise(7, 11.6).mul(0.5).add(0.5).add(microBump.z.mul(0.07)),
    0,
    1,
  )
  const lichenPotential = clamp(
    macro.w.mul(lichenHabitat).mul(biomeUniforms.lichen.mul(1.9)),
    0,
    1,
  )
  const thallusThreshold = oneMinus(lichenPotential)
    .mul(0.5)
    .add(coarseVarying(1.6, worldField(1.6, 2.7)).mul(0.12))
    .add(0.24)
  const inside = lichenField.sub(thallusThreshold)
  const thallus = smoothstep(-0.04, 0.045, inside.add(microBump.x.mul(0.012)))
  const growthMargin = smoothstep(0.13, 0.02, inside).mul(thallus)
  const areolaFissure = lodLevel === 0
    ? oneMinus(smoothstep(0.015, 0.085, microBump.z.abs()))
    : uniform(0)
  const areolaTone = clamp(microBump.z.mul(0.5).add(0.5), 0, 1)
  const lichenGrip = clamp(
    oneMinus(detail.height.mul(0.5).add(0.5))
      .mul(0.5)
      .add(0.62)
      .sub(
        usesBakedSurface
          ? smoothstep(0.35, 0.9, bakedCurvature).mul(0.3)
          : uniform(0),
      ),
    0,
    1,
  )
  const lichenDieback = smoothstep(
    0.46,
    0.74,
    coarseVarying(4.2, worldField(4.2, 27.8)),
  )
  const lichenMask = thallus
    .mul(lichenGrip)
    .mul(oneMinus(lichenDieback.mul(oneMinus(growthMargin)).mul(0.5)))
  const lichenSpecies = smoothstep(
    0.52,
    0.68,
    coarseVarying(2.1, worldField(2.1, 19.4)),
  )
  let lichenColor = mix(lichenBody, lichenCentre, areolaTone)
  lichenColor = mix(
    lichenColor,
    mix(lichenRustBody, lichenRustCentre, areolaTone),
    lichenSpecies.mul(0.72),
  )
  lichenColor = mix(lichenColor, lichenFissure, areolaFissure.mul(0.55))
  lichenColor = mix(lichenColor, lichenMargin, growthMargin.mul(0.5))

  const relief = (usesBakedSurface ? bakedHeight.mul(0.44) : uniform(0))
    .add(detail.height.mul(0.08))
    .add(microBump.x.mul(0.22))
  const snowDepth = upward.mul(0.92)
    .add(shelter.mul(upwardBroad).mul(0.38))
    .mul(macro.z.mul(0.32).add(0.78))
    .mul(biomeUniforms.snow.mul(1.8))
  const snowMask = smoothstep(
    0.12,
    0.38,
    snowDepth.sub(relief.mul(0.35).add(0.3)),
  )
  const driftGradient = coarseVarying(
    5.5,
    worldGradient(5.5, 0.05, 4.2).mul(0.17),
  )
  const snowColor = mix(
    snowShade,
    snowLit,
    smoothstep(0.1, 0.72, snowDepth),
  ).mul(microBump.x.mul(0.05).add(0.98))

  stone = stone.mul(mix(vec3(1, 1, 1), vec3(0.38, 0.41, 0.44), filmDepth))
  stone = mix(stone, wetGranite, wetMask.mul(0.18))
  stone = mix(stone, lichenColor, lichenMask.mul(macro.z.mul(0.3).add(0.62)))
  stone = mix(stone, mossColor, mossMask)
  stone = mix(
    stone,
    wetGranite,
    smoothstep(0.02, 0.32, snowDepth).mul(oneMinus(snowMask)).mul(0.5),
  )
  stone = mix(stone, snowColor, snowMask)
  material.colorNode = stone

  const decoded = usesBakedSurface
    ? tslNormalize(mix(
      normalLocal,
      normalAo.xyz.mul(2).sub(1),
      biomeUniforms.detailStrength.mul(bakeValidity),
    ))
    : normalLocal
  const covered = clamp(
    snowMask.mul(0.92)
      .add(mossMask.mul(0.82))
      .add(lichenMask.mul(0.3))
      .add(filmDepth.mul(0.3)),
    0,
    1,
  )
  const mesoView = viewOffset(
    coarseVarying(8, worldGradient(8, 0.032, 3.7).mul(0.2)),
  )
  const mesoBuried = oneMinus(
    clamp(snowMask.mul(0.8).add(mossMask.mul(0.75)), 0, 1),
  )
  // The fallback starts from the actual smooth mesh normal rather than the
  // bake's high-resolution object normal. Keep perturbations conservative so
  // they add grain without folding the repaired faces into black facets.
  const fallbackRelief = mix(1, 0.72, proceduralFallback)
  material.normalNode = tslNormalize(
    transformNormalToView(decoded)
      .add(mesoView.mul(mesoBuried).mul(fallbackRelief))
      .add(
        detail.viewNormalOffset
          .mul(oneMinus(covered))
          .mul(biomeUniforms.detailStrength.mul(0.65).add(0.35))
          .mul(mix(1, 0.78, proceduralFallback)),
      )
      .add(viewOffset(mossClumpGradient.add(microBump.mul(0.22))).mul(mossMask))
      .add(viewOffset(driftGradient.add(microBump.mul(0.07))).mul(snowMask)),
  )

  const macroAo = usesBakedSurface ? mix(0.7, 1, bakedAo) : uniform(1)
  const detailAo = mix(
    mix(0.78, 1, detail.ambientOcclusion),
    mix(0.56, 1, detail.ambientOcclusion),
    proceduralFallback,
  )
  let ao = macroAo
    .mul(detailAo)
    .mul(oneMinus(mossMask.mul(oneMinus(microRelief)).mul(0.5)))
    .mul(oneMinus(mossMask.mul(oneMinus(mossClump)).mul(0.28)))
    .mul(oneMinus(lichenMask.mul(areolaFissure).mul(0.38)))
  ao = mix(ao, uniform(1), snowMask.mul(0.7))
  material.aoNode = ao

  let roughness = mix(0.91, 0.55, wetMask)
  roughness = roughness.add(detail.roughness.sub(0.5).mul(0.18))
  roughness = mix(
    roughness,
    0.11,
    filmDepth.mul(filmDepth).mul(biomeUniforms.wetness),
  )
  roughness = mix(roughness, 0.94, lichenMask)
  roughness = mix(roughness, 0.92, mossMask)
  roughness = mix(roughness, 0.86, snowMask)
  roughness = roughness.sub(
    smoothstep(0.8, 0.97, detail.albedo).mul(snowMask).mul(0.4),
  )
  material.roughnessNode = clamp(roughness, 0.06, 1)
  if (lodDither) {
    const screenHash = hash(
      viewportCoordinate.x.add(viewportCoordinate.y.mul(8192)),
    )
    const coverage = lodLevel === 0
      ? screenHash.lessThan(lodDither.first)
      : lodLevel === 1
        ? screenHash.greaterThanEqual(lodDither.first)
          .and(screenHash.lessThan(lodDither.second))
        : screenHash.greaterThanEqual(lodDither.second)
    material.opacityNode = coverage.select(1, 0)
    material.alphaTestNode = uniform(0.5)
    material.alphaHash = false
  }
  material.userData.graniteSurface = {
    source: 'scifi-kit/glacial-granite-boulder',
    topologyKey: resources.topologyKey,
    sourceBake: usesBakedSurface,
    seamSafeAtlasFallback: true,
    sharedTriplanarDetail: true,
  }
  return material
}

/** Update biome controls without rebuilding or recompiling the node graph. */
export function updateGraniteRockMaterial(
  material: MeshStandardNodeMaterial,
  parameters: GraniteBiomeParameters,
): void {
  const values = material.userData.graniteBiomeUniforms as
    | GraniteBiomeUniforms
    | undefined
  if (!values) return
  values.snow.value = parameters.snow
  values.wetness.value = parameters.wetness
  values.lichen.value = parameters.lichen
  values.moss.value = parameters.moss
  values.detailStrength.value = parameters.detailStrength
  values.surfaceSeed.value = parameters.surfaceSeed
}
