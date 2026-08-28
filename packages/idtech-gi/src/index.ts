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

// GPU-resident id-Tech-style GI. The exports above are the CPU reference model
// the pipeline was derived from; these are what runs in a frame.
export { SousaGI, type SousaGIOptions, type GiStats } from './gpu/SousaGI.ts'
export {
  voxelizeScene,
  createVoxelVolume,
  finaliseVoxels,
  splatSample,
  splatSlab,
  splatTaperedCylinder,
  splatCanopyShell,
  splatTriangle,
  type VoxelScene,
  type VoxelAccumulator,
  type VoxelizeOptions,
} from './gpu/voxelScene.ts'
export {
  applyGiMaterials,
  injectIrradiance,
  createIrradianceInjector,
  GiPhysicalNodeMaterial,
} from './gpu/giMaterial.ts'
export { createProbeField, DEFAULT_PROBES, type ProbeConfig } from './gpu/probeField.ts'
export { createPointLightField, type GiPointLight } from './gpu/pointLights.ts'
export { createDebugMaterial, DEBUG_VIEWS, type DebugView } from './gpu/debugViews.ts'
export type { Node as GiNode } from './gpu/nodes.ts'
