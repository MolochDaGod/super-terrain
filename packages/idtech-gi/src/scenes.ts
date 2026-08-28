import { SousaPipeline, type SousaPipelineOptions } from './pipeline.ts'
import type { CascadeConfig, PointLight, Rgb, Vec3 } from './types.ts'
import { VoxelGrid, voxelizeBoxWalls } from './voxelGrid.ts'

export interface GiScene {
  name: string
  voxel: VoxelGrid
  pipeline: SousaPipeline
  camera: { position: Vec3; target: Vec3; fovY: number }
  /** World AABBs used to build the matching Three mesh demo. */
  boxes: { min: Vec3; max: Vec3; color: Rgb }[]
  lights: PointLight[]
  /** Pixel region (x0,y0,x1,y1) on a 128×80 frame expected to be unlit without GI. */
  unlitRegion: [number, number, number, number]
}

const SIMPLE_CASCADE: CascadeConfig = {
  resolution: 8,
  cascadeCount: 3,
  firstSize: 8,
  raysPerProbe: 32,
  cascadesPerFrame: 1,
}

const HARD_CASCADE: CascadeConfig = {
  resolution: 8,
  cascadeCount: 3,
  firstSize: 16,
  raysPerProbe: 24,
  cascadesPerFrame: 1,
}

function build(
  name: string,
  voxel: VoxelGrid,
  boxes: GiScene['boxes'],
  lights: PointLight[],
  camera: GiScene['camera'],
  unlitRegion: GiScene['unlitRegion'],
  extra?: SousaPipelineOptions,
): GiScene {
  const pipeline = new SousaPipeline(voxel, {
    cascade: extra?.cascade ?? SIMPLE_CASCADE,
    lights,
    sky: extra?.sky ?? [0, 0, 0],
    volumeBlend: 0.25,
    maxRayDistance: voxel.size * 1.4,
    ...extra,
  })
  return { name, voxel, pipeline, camera, boxes, lights, unlitRegion }
}

/** Closed colored room. Spotlight on the red wall; the green wall is unlit. */
export function createSimpleRoom(): GiScene {
  const voxel = new VoxelGrid(64, [-3.5, -3.5, -3.5], 7)
  const boxes: GiScene['boxes'] = []
  const push = (min: Vec3, max: Vec3, color: Rgb) => {
    boxes.push({ min, max, color })
    voxel.fillBox(min, max, color)
  }
  voxelizeBoxWalls(voxel, [-2, -2, -2], [2, 2, 2], 0.18, {
    nx: [0.82, 0.04, 0.04],
    px: [0.04, 0.72, 0.06],
    ny: [0.82, 0.8, 0.76],
    py: [0.78, 0.78, 0.8],
    nz: [0.8, 0.8, 0.78],
    pz: [0.8, 0.8, 0.78],
  })
  boxes.push({ min: [-2.18, -2.18, -2.18], max: [-2, 2.18, 2.18], color: [0.82, 0.04, 0.04] })
  boxes.push({ min: [2, -2.18, -2.18], max: [2.18, 2.18, 2.18], color: [0.04, 0.72, 0.06] })
  boxes.push({ min: [-2.18, -2.18, -2.18], max: [2.18, -2, 2.18], color: [0.82, 0.8, 0.76] })
  boxes.push({ min: [-2.18, 2, -2.18], max: [2.18, 2.18, 2.18], color: [0.78, 0.78, 0.8] })
  boxes.push({ min: [-2.18, -2.18, -2.18], max: [2.18, 2.18, -2], color: [0.8, 0.8, 0.78] })
  boxes.push({ min: [-2.18, -2.18, 2], max: [2.18, 2.18, 2.18], color: [0.8, 0.8, 0.78] })
  push([-0.5, -2, -0.5], [0.5, -0.6, 0.5], [0.9, 0.88, 0.8])
  const lights: PointLight[] = [
    {
      position: [-1.45, 0.55, 0.1],
      color: [1, 0.95, 0.85],
      intensity: 28,
      direction: [-1, -0.15, 0],
      coneCos: 0.45,
    },
  ]
  return build(
    'simple-room',
    voxel,
    boxes,
    lights,
    { position: [0.15, 0.05, 1.45], target: [0, -0.35, -0.4], fovY: 62 },
    [88, 16, 122, 64],
    { cascade: SIMPLE_CASCADE, sky: [0.004, 0.005, 0.008] },
  )
}

/**
 * Sponza-like atrium: columns, upper galleries, colored banners, sun through
 * a roof opening. The floor under the west gallery is in direct shadow.
 */
export function createSponzaAtrium(): GiScene {
  const voxel = new VoxelGrid(96, [-10, -1.5, -16], 32)
  const boxes: GiScene['boxes'] = []
  const push = (min: Vec3, max: Vec3, color: Rgb) => {
    boxes.push({ min, max, color })
    voxel.fillBox(min, max, color)
  }
  // Floor
  push([-8, -0.2, -12], [8, 0, 12], [0.55, 0.5, 0.42])
  // Side walls
  push([-8.2, 0, -12], [-8, 8, 12], [0.72, 0.62, 0.5])
  push([8, 0, -12], [8.2, 8, 12], [0.72, 0.62, 0.5])
  // Ends
  push([-8, 0, -12.2], [8, 8, -12], [0.68, 0.58, 0.46])
  push([-8, 0, 12], [8, 8, 12.2], [0.68, 0.58, 0.46])
  // Roof with a skylight hole (two slabs)
  push([-8.2, 7.8, -12.2], [-1.4, 8.2, 12.2], [0.5, 0.48, 0.45])
  push([1.4, 7.8, -12.2], [8.2, 8.2, 12.2], [0.5, 0.48, 0.45])
  // Upper galleries
  push([-8, 4.2, -12], [-5.4, 4.5, 12], [0.6, 0.55, 0.45])
  push([5.4, 4.2, -12], [8, 4.5, 12], [0.6, 0.55, 0.45])
  // Columns
  for (const z of [-8, -4, 0, 4, 8]) {
    push([-6.2, 0, z - 0.35], [-5.5, 7.8, z + 0.35], [0.78, 0.72, 0.62])
    push([5.5, 0, z - 0.35], [6.2, 7.8, z + 0.35], [0.78, 0.72, 0.62])
  }
  // Colored banners (the bounce sources)
  push([-5.35, 2.2, -6], [-5.15, 5.6, -3.4], [0.85, 0.05, 0.05])
  push([-5.35, 2.2, 3.2], [-5.15, 5.6, 5.8], [0.05, 0.55, 0.15])
  push([5.15, 2.2, -2], [5.35, 5.6, 0.8], [0.1, 0.2, 0.75])
  // West-gallery floor shadow receiver (already the floor under the gallery)
  const lights: PointLight[] = [
    {
      position: [0, 10.5, 0],
      color: [1, 0.96, 0.88],
      intensity: 220,
      direction: [0.15, -1, 0.05],
      coneCos: 0.55,
    },
  ]
  return build(
    'sponza-atrium',
    voxel,
    boxes,
    lights,
    { position: [0.2, 2.4, 10.8], target: [0, 2.2, 0], fovY: 58 },
    [8, 48, 28, 72],
    { cascade: HARD_CASCADE, sky: [0.08, 0.12, 0.2] },
  )
}

/** Bounded forest stand: trunks + canopy, sun at an angle, floor in shadow. */
export function createForestStand(): GiScene {
  const voxel = new VoxelGrid(80, [-12, -1, -12], 24)
  const boxes: GiScene['boxes'] = []
  const push = (min: Vec3, max: Vec3, color: Rgb) => {
    boxes.push({ min, max, color })
    voxel.fillBox(min, max, color)
  }
  push([-10, -0.2, -10], [10, 0, 10], [0.22, 0.28, 0.12])
  const trunk: Rgb = [0.32, 0.2, 0.1]
  const canopy: Rgb = [0.12, 0.42, 0.1]
  const spots: [number, number][] = [
    [-3, -2],
    [2.5, -3],
    [-1, 3],
    [4, 2],
    [-5, 4],
    [1, -5],
    [5.5, -1],
    [-4, -5],
  ]
  for (const [x, z] of spots) {
    push([x - 0.28, 0, z - 0.28], [x + 0.28, 4.2, z + 0.28], trunk)
    push([x - 1.6, 3.6, z - 1.6], [x + 1.6, 5.4, z + 1.6], canopy)
  }
  const lights: PointLight[] = [
    {
      position: [8, 12, -6],
      color: [1, 0.92, 0.7],
      intensity: 260,
      direction: [-0.45, -1, 0.35],
      coneCos: 0.4,
    },
  ]
  return build(
    'forest-stand',
    voxel,
    boxes,
    lights,
    { position: [0.4, 1.4, 9.5], target: [0, 1.6, 0], fovY: 55 },
    [48, 50, 80, 74],
    { cascade: HARD_CASCADE, sky: [0.35, 0.5, 0.75] },
  )
}

export function warmPipeline(scene: GiScene, frames = 8): void {
  const cam = scene.camera.position
  for (let i = 0; i < frames; i += 1) scene.pipeline.step(cam)
}

export const SCENE_BUILDERS = {
  simple: createSimpleRoom,
  sponza: createSponzaAtrium,
  forest: createForestStand,
} as const

export type SceneName = keyof typeof SCENE_BUILDERS
