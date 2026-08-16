import { Group, Mesh, PerspectiveCamera, Scene, Vector3 } from 'three/webgpu'
import type { Material } from 'three/webgpu'
import { DEFAULT_TERRAIN_CONFIG } from '../../src/terrain/config'
import { compileTerrainSection } from '../../src/terrain/compiler/compileSection'
import { evaluateHeight } from '../../src/terrain/compiler/TerrainField'
import { createSectionGeometry } from '../../src/terrain/rendering/createSectionGeometry'
import { createTerrainEnvironment } from '../../src/terrain/rendering/environment/createTerrainEnvironment'
import { createTerrainMaterialForMode } from '../../src/terrain/rendering/createTerrainMaterialForMode'
import type { TerrainRenderMode } from '../../src/terrain/rendering/renderModes'
import type { FullMaterialDebug } from '../../src/terrain/rendering/full/createFullTerrainMaterial'

export interface CameraPreset {
  label: string
  /** Camera position in world units. `y` is added to the terrain height below it. */
  position: [number, number, number]
  target: [number, number, number]
  fov: number
  /** When set, `position[1]` is treated as an offset above the terrain surface. */
  groundRelative?: boolean
}

export interface CaptureScene {
  scene: Scene
  camera: PerspectiveCamera
  dispose(): void
}

/**
 * Compiles a ring of sections around the camera synchronously. The worker pool
 * is a browser concern; the compiler itself is pure and runs fine in Node, so
 * captures exercise exactly the geometry the editor would stream in.
 */
export function buildCaptureScene(
  preset: CameraPreset,
  mode: TerrainRenderMode,
  aspect: number,
  options: {
    radiusSections?: number
    lod?: number
    cascadedShadows?: boolean
    shadows?: boolean
    debug?: FullMaterialDebug
  } = {},
): CaptureScene {
  const config = DEFAULT_TERRAIN_CONFIG
  const radius = options.radiusSections ?? 24
  const scene = new Scene()
  const group = new Group()
  const disposables: { dispose(): void }[] = []

  const material = createTerrainMaterialForMode(mode, options.debug)
  disposables.push(material)

  const centerSectionX = Math.floor(preset.target[0] / config.sectionSize)
  const centerSectionZ = Math.floor(preset.target[2] / config.sectionSize)
  const cameraPosition = resolveCameraPosition(preset, config.seed)

  for (let z = -radius; z <= radius; z += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      const key = { x: centerSectionX + x, z: centerSectionZ + z }
      // LOD by distance from the *camera*, matching what the streaming
      // selector does at runtime. Choosing it by ring index instead puts a
      // resolution jump across the middle of the frame, which shows up as a
      // crack the section skirts are not deep enough to hide.
      const centreX = (key.x + 0.5) * config.sectionSize
      const centreZ = (key.z + 0.5) * config.sectionSize
      const distance = Math.hypot(
        centreX - cameraPosition[0],
        centreZ - cameraPosition[2],
      )
      const lod = options.lod ?? distanceToLod(distance)
      const compiled = compileTerrainSection({
        kind: 'compile-section',
        jobId: 0,
        priority: 0,
        key,
        revision: 0,
        config,
        // Only the displayed level is needed; the LOD pyramid exists for
        // streaming, which the harness does not exercise.
        levels: [lod],
        modifiers: { descriptors: [], brushPoints: new Float32Array(0) },
      })
      const geometry = createSectionGeometry(compiled.lods[0], config.sectionSize)
      const mesh = new Mesh(geometry, material.material as Material)
      mesh.position.set(key.x * config.sectionSize, 0, key.z * config.sectionSize)
      mesh.receiveShadow = true
      mesh.castShadow = true
      group.add(mesh)
      disposables.push(geometry)
    }
  }
  scene.add(group)

  const environment = createTerrainEnvironment(mode, config, {
    cascadedShadows: options.cascadedShadows,
    shadows: options.shadows,
  })
  environment.applyToScene(scene)
  scene.add(environment.group)
  disposables.push(environment)

  const camera = new PerspectiveCamera(preset.fov, aspect, 0.5, 60_000)
  camera.position.set(...cameraPosition)
  camera.lookAt(new Vector3(...preset.target))
  camera.updateMatrixWorld(true)
  environment.update(camera)

  return {
    scene,
    camera,
    dispose() {
      for (const item of disposables) item.dispose()
    },
  }
}

function resolveCameraPosition(
  preset: CameraPreset,
  seed: number,
): [number, number, number] {
  if (!preset.groundRelative) return preset.position
  const ground = evaluateHeight(preset.position[0], preset.position[2], seed, [])
  return [preset.position[0], ground + preset.position[1], preset.position[2]]
}

/** Metres of camera distance at which each successive LOD takes over. */
function distanceToLod(distance: number): number {
  if (distance <= 260) return 0
  if (distance <= 600) return 1
  if (distance <= 1_100) return 2
  if (distance <= 1_900) return 3
  return 4
}
