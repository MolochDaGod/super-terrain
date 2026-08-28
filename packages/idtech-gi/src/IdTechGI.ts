import {
  BoxGeometry,
  Color,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PointLight as ThreePointLight,
  SpotLight,
  Vector3,
  type Renderer,
  type Scene,
} from 'three/webgpu'
import { cascadeCellSize, cascadeOrigin, interleavedUpdateSet } from './cascades.ts'
import { createIndirectNode, createGiUniforms, type GiUniforms } from './tsl/irradianceNode.ts'
import { createGiComputePasses, type GiComputePasses } from './tsl/kernels.ts'
import {
  createVolumeGpuTextures,
  uploadRadianceCache,
  uploadVolumeTextures,
  uploadVoxelTexture,
  type VolumeGpuTextures,
} from './tsl/volumeTextures.ts'
import type { SousaPipeline } from './pipeline.ts'
import type { GiScene } from './scenes.ts'
import type { Rgb, Vec3 } from './types.ts'

export interface IdTechGIOptions {
  gatherWidth?: number
  gatherHeight?: number
  gpuCompute?: boolean
}

const _viewProj = new Matrix4()

/**
 * Isolated idTech-8-style GI for a Three.js WebGPURenderer.
 *
 * CPU Sousa pipeline updates the hashed radiance cache and cascaded SH
 * volumes. TSL visibility writes per-probe hits into that cache; a half-res
 * cache-only gather (screen → world cache → volumes) stores 2-band SH,
 * denoises, upscales, and is sampled by the material as indirect light.
 */
export class IdTechGI {
  readonly scene: GiScene
  readonly textures: VolumeGpuTextures
  readonly uniforms: GiUniforms
  readonly pipeline: SousaPipeline
  readonly passes: GiComputePasses
  enabled = true
  gpuCompute: boolean
  private lastCamera = new Vector3()

  constructor(scene: GiScene, options: IdTechGIOptions = {}) {
    this.scene = scene
    this.pipeline = scene.pipeline
    this.textures = createVolumeGpuTextures(scene.pipeline.cascade, scene.voxel)
    uploadVoxelTexture(this.textures.voxel, scene.voxel)
    this.uniforms = createGiUniforms(
      this.textures,
      new Vector3(scene.voxel.origin[0], scene.voxel.origin[1], scene.voxel.origin[2]),
      scene.voxel.size,
    )
    this.gpuCompute = options.gpuCompute ?? true
    const gw = Math.max(32, options.gatherWidth ?? 320)
    const gh = Math.max(32, options.gatherHeight ?? 200)
    this.passes = createGiComputePasses(
      this.textures,
      this.uniforms,
      gw,
      gh,
      scene.pipeline.cascade.resolution ** 3,
      scene.pipeline.cascade.raysPerProbe,
    )
    this.bindLight(scene.lights[0])
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.uniforms.enabled.value = enabled ? 1 : 0
  }

  createMaterial(color: Rgb): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial()
    const albedo = new Color(color[0], color[1], color[2])
    material.color = albedo
    material.roughness = 0.92
    material.metalness = 0
    material.envMapIntensity = 0
    material.emissiveNode = createIndirectNode(this.textures, this.uniforms, albedo, {
      r: this.passes.denoiseR,
      g: this.passes.denoiseG,
      b: this.passes.denoiseB,
      width: this.passes.gatherWidth,
      height: this.passes.gatherHeight,
    })
    return material
  }

  populateThreeScene(threeScene: Scene): Mesh[] {
    const meshes: Mesh[] = []
    for (const box of this.scene.boxes) {
      const sx = box.max[0] - box.min[0]
      const sy = box.max[1] - box.min[1]
      const sz = box.max[2] - box.min[2]
      const mesh = new Mesh(
        new BoxGeometry(Math.max(sx, 1e-3), Math.max(sy, 1e-3), Math.max(sz, 1e-3)),
        this.createMaterial(box.color),
      )
      mesh.position.set(
        (box.min[0] + box.max[0]) * 0.5,
        (box.min[1] + box.max[1]) * 0.5,
        (box.min[2] + box.max[2]) * 0.5,
      )
      mesh.castShadow = true
      mesh.receiveShadow = true
      threeScene.add(mesh)
      meshes.push(mesh)
    }
    for (const light of this.scene.lights) {
      if (light.direction && light.coneCos !== undefined) {
        const angle = Math.acos(Math.min(0.999, Math.max(-1, light.coneCos)))
        const spot = new SpotLight(
          new Color(light.color[0], light.color[1], light.color[2]),
          Math.max(8, light.intensity * 1.4),
          40,
          angle,
          0.4,
          2,
        )
        spot.position.set(light.position[0], light.position[1], light.position[2])
        spot.target.position.set(
          light.position[0] + light.direction[0],
          light.position[1] + light.direction[1],
          light.position[2] + light.direction[2],
        )
        threeScene.add(spot)
        threeScene.add(spot.target)
      } else {
        const point = new ThreePointLight(
          new Color(light.color[0], light.color[1], light.color[2]),
          Math.max(6, light.intensity * 0.8),
          40,
          2,
        )
        point.position.set(light.position[0], light.position[1], light.position[2])
        threeScene.add(point)
      }
    }
    return meshes
  }

  warm(frames = 8, camera?: Vec3): void {
    const cam = camera ?? this.scene.camera.position
    for (let i = 0; i < frames; i += 1) this.pipeline.step(cam)
    this.upload(cam)
  }

  upload(camera: Vec3): void {
    this.lastCamera.set(camera[0], camera[1], camera[2])
    this.uniforms.camera.value.copy(this.lastCamera)
    uploadVolumeTextures(this.textures, this.pipeline.volumes)
    uploadRadianceCache(this.textures.radianceCache, this.pipeline.cache, this.scene.voxel)
  }

  setView(camera: PerspectiveCamera, width: number, height: number): void {
    camera.updateMatrixWorld()
    camera.updateProjectionMatrix()
    const e = camera.matrixWorld.elements
    this.passes.view.pos.value.copy(camera.position)
    this.passes.view.right.value.set(e[0], e[1], e[2])
    this.passes.view.up.value.set(e[4], e[5], e[6])
    this.passes.view.forward.value.set(-e[8], -e[9], -e[10]).normalize()
    const fov = camera.fov * (Math.PI / 180)
    this.passes.view.tanHalf.value = Math.tan(fov * 0.5)
    this.passes.view.aspect.value = width / Math.max(height, 1)
    _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    const m = _viewProj.elements
    this.passes.view.viewProjX.value.set(m[0], m[4], m[8], m[12])
    this.passes.view.viewProjY.value.set(m[1], m[5], m[9], m[13])
    this.passes.view.viewProjZ.value.set(m[2], m[6], m[10], m[14])
    this.passes.view.viewProjW.value.set(m[3], m[7], m[11], m[15])
  }

  /**
   * One budgeted GI frame. Compute errors propagate — they are not swallowed.
   */
  tick(renderer: Renderer, camera: PerspectiveCamera, width: number, height: number): void {
    const pos: Vec3 = [camera.position.x, camera.position.y, camera.position.z]
    if (!this.enabled) {
      this.uniforms.enabled.value = 0
      return
    }
    this.uniforms.enabled.value = 1
    this.pipeline.step(pos)
    this.upload(pos)
    if (!this.gpuCompute) return
    this.setView(camera, width, height)
    const updated = interleavedUpdateSet(
      Math.max(0, this.pipeline.frame - 1),
      pos,
      this.pipeline.cascade,
    )
    const origin = cascadeOrigin(updated.cascade, pos, this.pipeline.cascade)
    this.passes.probeOrigin.value.set(origin[0], origin[1], origin[2])
    this.passes.cascadeCell.value = cascadeCellSize(updated.cascade, this.pipeline.cascade)
    this.passes.cascadeRes.value = this.pipeline.cascade.resolution
    this.passes.frame.value = this.pipeline.frame
    renderer.compute(this.passes.visibility)
    renderer.compute(this.passes.gather)
    renderer.compute(this.passes.denoise)
    renderer.compute(this.passes.cacheScreen)
  }

  dispose(): void {
    this.textures.l0.dispose()
    this.textures.lx.dispose()
    this.textures.ly.dispose()
    this.textures.lz.dispose()
    this.textures.voxel.dispose()
    this.textures.radianceCache.dispose()
  }

  private bindLight(light: GiScene['lights'][number] | undefined): void {
    if (!light) return
    this.passes.light.pos.value.set(light.position[0], light.position[1], light.position[2])
    this.passes.light.color.value.set(light.color[0], light.color[1], light.color[2])
    const dir = light.direction ?? [0, -1, 0]
    this.passes.light.dir.value.set(dir[0], dir[1], dir[2]).normalize()
    this.passes.light.params.value.set(
      light.intensity,
      light.coneCos ?? 0,
      light.direction ? 1 : 0,
      0,
    )
  }
}
