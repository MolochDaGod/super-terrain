export { WorldRadianceCache, quantizePosition, hashCellKey } from './spatialHash.ts'
export {
  encodeRadiance,
  decodeRadiance,
  evaluateIrradiance,
  convolveIrradiance,
} from './sphericalHarmonics.ts'
export { interleavedUpdateSet, cellCenter, cascadeOrigin } from './cascades.ts'
export { resolveGather, makeScreenCache } from './gatherFallback.ts'
export { IrradianceVolumeField } from './irradianceVolume.ts'
export { VoxelGrid, voxelizeBoxWalls } from './voxelGrid.ts'
export { SousaPipeline, denoiseGatherSH } from './pipeline.ts'
export { renderCpuFrame, regionMean, pixelAt } from './cpuRender.ts'
export {
  createSimpleRoom,
  createSponzaAtrium,
  createForestStand,
  warmPipeline,
  SCENE_BUILDERS,
  type GiScene,
  type SceneName,
} from './scenes.ts'
export { IdTechGI } from './IdTechGI.ts'
export { createGiComputePasses } from './tsl/kernels.ts'
export { createIndirectNode } from './tsl/irradianceNode.ts'
