import {
  Color,
  Vector3,
  type Object3D,
  type PerspectiveCamera,
  type Renderer,
} from 'three/webgpu'
import { applyGiMaterials } from './giMaterial.ts'
import { createSunSky, setSun, type SunSky } from './lighting.ts'
import { Fn, cameraPosition, normalWorld, positionWorld, type Node } from './nodes.ts'
import { createPointLightField, type GiPointLight, type PointLightField } from './pointLights.ts'
import { createProbeField, type ProbeConfig, type ProbeField } from './probeField.ts'
import { createSdfBinding, type SdfBinding } from './sdfTrace.ts'
import { voxelizeScene, type VoxelScene } from './voxelScene.ts'

export interface SousaGIOptions {
  /** Voxels along the scene's longest axis. Higher resolves finer occluders. */
  voxelResolution?: number
  probes?: Partial<ProbeConfig>
  /** Dynamic punctual lights the GI rays can see. */
  maxPointLights?: number
  onProgress?: (fraction: number, label: string) => void
}

export interface GiStats {
  frame: number
  cascade: number
  probeCount: number
  pointLights: number
  raysPerFrame: number
  voxelDims: [number, number, number]
  voxelCell: number
  occupancy: number
}

/**
 * id-Tech-style global illumination for a Three.js WebGPU renderer.
 *
 * The structure follows Sousa's talk: a static scene representation that rays
 * are traced against, a set of camera-centred irradiance cascades refreshed on
 * a per-frame budget, and multi-bounce by feeding the cascades back into their
 * own ray shading. What differs is the visibility backend — WebGPU has no ray
 * queries, so a sphere-traced distance field stands in for the BVH.
 *
 * Everything that persists between frames lives in world space and on the GPU.
 * That is the difference that matters: the previous build accumulated in screen
 * space without reprojection and rebuilt its volumes on the CPU relative to an
 * unsnapped camera, so the result crawled whenever the camera moved.
 */
export class SousaGI {
  readonly voxels: VoxelScene
  readonly sdf: SdfBinding
  readonly sky: SunSky
  readonly probes: ProbeField
  readonly lights: PointLightField
  /** vec3 node: indirect irradiance at the shading point. */
  readonly irradianceNode: Node
  private frame = 0
  private restoreMaterials: (() => void) | null = null
  private readonly cameraPosition = new Vector3()

  private constructor(voxels: VoxelScene, options: SousaGIOptions) {
    this.voxels = voxels
    this.sdf = createSdfBinding(voxels)
    this.sky = createSunSky()
    this.lights = createPointLightField(options.maxPointLights ?? 8)
    this.probes = createProbeField(this.sdf, this.sky, this.lights, options.probes)
    // Deferred: the gather declares shader variables, which is only legal
    // while a node builder is on the stack — i.e. when the material is built.
    this.irradianceNode = Fn(() =>
      this.probes.irradiance(
        positionWorld,
        normalWorld.normalize(),
        cameraPosition.sub(positionWorld).normalize(),
      ),
    )()
  }

  static async create(root: Object3D, options: SousaGIOptions = {}): Promise<SousaGI> {
    const voxels = await voxelizeScene(root, {
      maxResolution: options.voxelResolution ?? 128,
      onProgress: options.onProgress,
    })
    return new SousaGI(voxels, options)
  }

  /**
   * Replaces the dynamic light list the GI rays shade with. Call every frame
   * for moving lights — it is a buffer write, not a rebuild.
   */
  setPointLights(lights: readonly GiPointLight[]): void {
    this.lights.set(lights)
  }

  /** Keep this in step with the rasterised key light or bounce will disagree with it. */
  setSun(direction: Vector3, colour: Color, intensity: number): this {
    setSun(this.sky, direction, colour, intensity)
    this.probes.reset()
    return this
  }

  setSky(zenith: Color, horizon: Color, ground: Color): this {
    this.sky.zenith.value.set(zenith.r, zenith.g, zenith.b)
    this.sky.horizon.value.set(horizon.r, horizon.g, horizon.b)
    this.sky.ground.value.set(ground.r, ground.g, ground.b)
    this.probes.reset()
    return this
  }

  get enabled(): boolean {
    return this.probes.enabled.value > 0.5
  }

  set enabled(value: boolean) {
    this.probes.enabled.value = value ? 1 : 0
  }

  get intensity(): number {
    return this.probes.intensity.value as number
  }

  set intensity(value: number) {
    this.probes.intensity.value = value
  }

  /** Swaps the scene's materials for GI-aware ones. */
  attach(root: Object3D): number {
    this.detach()
    const applied = applyGiMaterials(root, this.irradianceNode)
    this.restoreMaterials = applied.restore
    return applied.count
  }

  detach(): void {
    this.restoreMaterials?.()
    this.restoreMaterials = null
  }

  /** One frame of GI. Call before rendering the beauty pass. */
  update(renderer: Renderer, camera: PerspectiveCamera): void {
    if (!this.enabled) return
    this.frame += 1
    camera.getWorldPosition(this.cameraPosition)
    this.probes.update(this.cameraPosition, this.frame)
    this.probes.scheduleCascade(this.frame, this.cameraPosition)
    renderer.compute(this.probes.passes.relocate)
    renderer.compute(this.probes.passes.trace)
    // Visibility reads the pre-update probe state, so it must precede `shade`.
    renderer.compute(this.probes.passes.visibility)
    renderer.compute(this.probes.passes.shade)
  }

  stats(): GiStats {
    const cfg = this.probes.config
    const active = this.probes.debug.activeCascade
    const probesTraced = active < 0 ? this.probes.probeCount : this.probes.probesPerCascade
    return {
      frame: this.frame,
      cascade: active,
      probeCount: this.probes.probeCount,
      pointLights: this.lights.count,
      raysPerFrame: probesTraced * cfg.raysPerProbe,
      voxelDims: this.voxels.dims,
      voxelCell: this.voxels.cell,
      occupancy: this.voxels.occupiedCount,
    }
  }

  dispose(): void {
    this.detach()
    this.voxels.dispose()
  }
}
