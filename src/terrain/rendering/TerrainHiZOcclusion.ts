import {
  Box3,
  DepthTexture,
  DoubleSide,
  FloatType,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  RedFormat,
  RenderTarget,
  Scene,
  UnsignedByteType,
  Vector4,
  type Camera,
  type Object3D,
  type Renderer,
  type Texture,
} from 'three/webgpu'

const HIZ_WIDTH = 256
const HIZ_HEIGHT = 144
const DEPTH_BIAS = 0.0025
const CAMERA_MATRIX_TOLERANCE = 0.035

export interface HiZLevel {
  width: number
  height: number
  depths: Float32Array
}

export interface HiZPyramid {
  levels: readonly HiZLevel[]
}

interface TerrainOccluder {
  id: string
  mesh: Mesh
  depthMesh: Mesh
  worldBounds: Box3
  streamVisible: boolean
  lastFrameVisible: boolean
  introducedFrame: number
}

interface CompletedDepthPass {
  pyramid: HiZPyramid
  viewProjection: Matrix4
}

interface DepthReadableBackend {
  copyTextureToBuffer(
    texture: Texture,
    x: number,
    y: number,
    width: number,
    height: number,
    faceIndex: number,
  ): Promise<Float32Array>
}

/**
 * Temporal two-pass occlusion for terrain bricks.
 *
 * Pass one renders the *last-frame visible* brick geometry into a fresh depth
 * target using this frame's camera. Once that small target is available, a
 * max-depth pyramid is built and pass two tests every resident brick AABB.
 * Nothing reprojects or warps an old depth buffer.
 */
export class TerrainHiZOcclusion {
  private readonly depthScene = new Scene()
  private readonly depthMaterial = new MeshBasicNodeMaterial({
    color: 0x000000,
    depthTest: true,
    depthWrite: true,
    side: DoubleSide,
  })
  private readonly depthTarget: RenderTarget
  private readonly occluders = new Map<string, TerrainOccluder>()
  private readonly externalBounds = new Box3()
  private readonly externalKnown = new WeakSet<Object3D>()
  private readonly externalCulled = new WeakSet<Object3D>()
  private readonly currentViewProjection = new Matrix4()
  private completed?: CompletedDepthPass
  private readbackPending = false
  private frame = 0
  private disposed = false

  constructor() {
    const depthTexture = new DepthTexture(HIZ_WIDTH, HIZ_HEIGHT, FloatType)
    depthTexture.name = 'terrain-hi-z-depth'
    this.depthTarget = new RenderTarget(HIZ_WIDTH, HIZ_HEIGHT, {
      depthBuffer: true,
      depthTexture,
      format: RedFormat,
      type: UnsignedByteType,
      samples: 0,
    })
    this.depthTarget.texture.name = 'terrain-hi-z-dummy-colour'
    this.depthScene.name = 'terrain-last-visible-depth-pass'
  }

  register(id: string, mesh: Mesh, worldBounds: Box3): void {
    this.unregister(id)
    const depthMesh = new Mesh(mesh.geometry, this.depthMaterial)
    depthMesh.matrixAutoUpdate = false
    depthMesh.frustumCulled = true
    depthMesh.name = `hi-z-depth-${id}`
    this.depthScene.add(depthMesh)
    this.occluders.set(id, {
      id,
      mesh,
      depthMesh,
      worldBounds: worldBounds.clone(),
      streamVisible: true,
      lastFrameVisible: true,
      introducedFrame: this.frame,
    })
  }

  unregister(id: string): void {
    const previous = this.occluders.get(id)
    if (!previous) return
    this.depthScene.remove(previous.depthMesh)
    this.occluders.delete(id)
  }

  setStreamVisible(id: string, visible: boolean): void {
    const occluder = this.occluders.get(id)
    if (!occluder) return
    occluder.streamVisible = visible
    if (!visible) {
      occluder.lastFrameVisible = false
      occluder.mesh.visible = false
    } else if (!occluder.lastFrameVisible) {
      // A stream re-entry gets one guaranteed draw so it can become an
      // occluder and cannot be rejected by unrelated stale depth.
      occluder.lastFrameVisible = true
      occluder.introducedFrame = this.frame
      occluder.mesh.visible = true
    }
  }

  expandBounds(id: string, amount: number): void {
    this.occluders.get(id)?.worldBounds.expandByScalar(amount)
  }

  /** Runs immediately before the main scene render. */
  update(renderer: Renderer, camera: Camera, scene: Scene): void {
    if (this.disposed) return
    this.frame += 1
    camera.updateWorldMatrix(true, false)
    this.currentViewProjection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    )

    const usable = this.completed && matrixNear(
      this.completed.viewProjection,
      this.currentViewProjection,
      CAMERA_MATRIX_TOLERANCE,
    )
      ? this.completed
      : undefined

    for (const occluder of this.occluders.values()) {
      if (!occluder.streamVisible) {
        occluder.mesh.visible = false
        continue
      }
      const guaranteed = this.frame - occluder.introducedFrame <= 1
      const visible =
        guaranteed ||
        !usable ||
        !isBoxOccluded(
          occluder.worldBounds,
          usable.viewProjection,
          usable.pyramid,
          DEPTH_BIAS,
        )
      occluder.lastFrameVisible = visible
      occluder.mesh.visible = visible
    }

    this.cullOptInSceneObjects(scene, usable)
    this.submitCurrentCameraDepth(renderer, camera)
  }

  dispose(): void {
    this.disposed = true
    this.occluders.clear()
    this.depthScene.clear()
    this.depthTarget.dispose()
    this.depthMaterial.dispose()
  }

  private cullOptInSceneObjects(
    scene: Scene,
    depth: CompletedDepthPass | undefined,
  ): void {
    scene.traverse((object) => {
      if (!(object instanceof Mesh) || object.userData.hizCullable !== true) return
      const desired = object.userData.hizDesiredVisible
      if (typeof desired === 'boolean') object.visible = desired
      else if (this.externalCulled.has(object)) object.visible = true
      this.externalCulled.delete(object)
      if (!object.visible || !depth) return
      if (!this.externalKnown.has(object)) {
        this.externalKnown.add(object)
        return
      }
      const localBounds = object.geometry.boundingBox
      if (!localBounds) {
        object.geometry.computeBoundingBox()
      }
      if (!object.geometry.boundingBox) return
      object.updateWorldMatrix(true, false)
      this.externalBounds
        .copy(object.geometry.boundingBox)
        .applyMatrix4(object.matrixWorld)
      if (isBoxOccluded(
        this.externalBounds,
        depth.viewProjection,
        depth.pyramid,
        DEPTH_BIAS,
      )) {
        object.visible = false
        this.externalCulled.add(object)
      }
    })
  }

  private submitCurrentCameraDepth(renderer: Renderer, camera: Camera): void {
    if (this.readbackPending || this.occluders.size === 0) return
    let visibleOccluders = 0
    for (const occluder of this.occluders.values()) {
      const visible = occluder.streamVisible && occluder.lastFrameVisible
      occluder.depthMesh.visible = visible
      if (!visible) continue
      visibleOccluders += 1
      occluder.mesh.updateWorldMatrix(true, false)
      occluder.depthMesh.matrix.copy(occluder.mesh.matrixWorld)
      occluder.depthMesh.matrixWorldNeedsUpdate = true
    }
    if (visibleOccluders === 0) return

    const passMatrix = this.currentViewProjection.clone()
    const previousTarget = renderer.getRenderTarget()
    const previousMrt = renderer.getMRT()
    const previousAutoClear = renderer.autoClear
    try {
      renderer.autoClear = true
      renderer.setMRT(null)
      renderer.setRenderTarget(this.depthTarget)
      renderer.render(this.depthScene, camera)
    } finally {
      renderer.setRenderTarget(previousTarget)
      renderer.setMRT(previousMrt)
      renderer.autoClear = previousAutoClear
    }

    this.readbackPending = true
    const backend = renderer.backend as unknown as DepthReadableBackend
    void backend
      .copyTextureToBuffer(
        this.depthTarget.depthTexture!,
        0,
        0,
        HIZ_WIDTH,
        HIZ_HEIGHT,
        0,
      )
      .then((pixels) => {
        if (this.disposed) return
        this.completed = {
          pyramid: buildHiZPyramid(pixels, HIZ_WIDTH, HIZ_HEIGHT),
          viewProjection: passMatrix,
        }
      })
      .catch((error: unknown) => {
        // Keep everything visible if depth readback is unsupported or the
        // device is being recreated. Culling is an optimization, never a
        // correctness dependency.
        console.warn('Terrain Hi-Z depth readback failed; culling disabled', error)
        this.completed = undefined
      })
      .finally(() => {
        this.readbackPending = false
      })
  }
}

export function buildHiZPyramid(
  source: Float32Array,
  width: number,
  height: number,
): HiZPyramid {
  const expected = width * height
  const base = source.length === expected
    ? source.slice()
    : source.slice(0, expected)
  const levels: HiZLevel[] = [{ width, height, depths: base }]
  let previous = levels[0]
  while (previous.width > 1 || previous.height > 1) {
    const nextWidth = Math.max(1, Math.ceil(previous.width / 2))
    const nextHeight = Math.max(1, Math.ceil(previous.height / 2))
    const depths = new Float32Array(nextWidth * nextHeight)
    for (let y = 0; y < nextHeight; y += 1) {
      for (let x = 0; x < nextWidth; x += 1) {
        let farthest = 0
        for (let dy = 0; dy < 2; dy += 1) {
          const sourceY = y * 2 + dy
          if (sourceY >= previous.height) continue
          for (let dx = 0; dx < 2; dx += 1) {
            const sourceX = x * 2 + dx
            if (sourceX >= previous.width) continue
            farthest = Math.max(
              farthest,
              previous.depths[sourceY * previous.width + sourceX],
            )
          }
        }
        depths[y * nextWidth + x] = farthest
      }
    }
    previous = { width: nextWidth, height: nextHeight, depths }
    levels.push(previous)
  }
  return { levels }
}

export function isBoxOccluded(
  box: Box3,
  viewProjection: Matrix4,
  pyramid: HiZPyramid,
  bias = DEPTH_BIAS,
): boolean {
  const base = pyramid.levels[0]
  if (!base || box.isEmpty()) return false
  let minimumX = Infinity
  let minimumY = Infinity
  let maximumX = -Infinity
  let maximumY = -Infinity
  let nearestDepth = Infinity
  const corner = new Vector4()

  for (let index = 0; index < 8; index += 1) {
    corner.set(
      index & 1 ? box.max.x : box.min.x,
      index & 2 ? box.max.y : box.min.y,
      index & 4 ? box.max.z : box.min.z,
      1,
    ).applyMatrix4(viewProjection)
    // Near-plane intersections are deliberately kept. Clipping the box would
    // be more exact but can only save objects surrounding the viewer.
    if (corner.w <= 1e-5) return false
    const inverseW = 1 / corner.w
    const ndcX = corner.x * inverseW
    const ndcY = corner.y * inverseW
    const ndcZ = corner.z * inverseW
    if (ndcZ <= 0) return false
    minimumX = Math.min(minimumX, (ndcX * 0.5 + 0.5) * base.width)
    maximumX = Math.max(maximumX, (ndcX * 0.5 + 0.5) * base.width)
    minimumY = Math.min(minimumY, (-ndcY * 0.5 + 0.5) * base.height)
    maximumY = Math.max(maximumY, (-ndcY * 0.5 + 0.5) * base.height)
    nearestDepth = Math.min(nearestDepth, ndcZ)
  }

  if (
    maximumX < 0 || maximumY < 0 ||
    minimumX >= base.width || minimumY >= base.height
  ) return false

  // Pad by one base texel so raster quantisation and tiny camera movement can
  // only produce false visibility, never a false occlusion.
  minimumX = Math.max(0, Math.floor(minimumX) - 1)
  minimumY = Math.max(0, Math.floor(minimumY) - 1)
  maximumX = Math.min(base.width - 1, Math.ceil(maximumX) + 1)
  maximumY = Math.min(base.height - 1, Math.ceil(maximumY) + 1)
  const extent = Math.max(maximumX - minimumX + 1, maximumY - minimumY + 1)
  const levelIndex = Math.min(
    pyramid.levels.length - 1,
    Math.max(0, Math.floor(Math.log2(extent))),
  )
  const level = pyramid.levels[levelIndex]
  const scale = 2 ** levelIndex
  const startX = Math.max(0, Math.floor(minimumX / scale))
  const startY = Math.max(0, Math.floor(minimumY / scale))
  const endX = Math.min(level.width - 1, Math.floor(maximumX / scale))
  const endY = Math.min(level.height - 1, Math.floor(maximumY / scale))
  let farthestOccluder = 0
  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      farthestOccluder = Math.max(
        farthestOccluder,
        level.depths[y * level.width + x],
      )
    }
  }
  return nearestDepth > farthestOccluder + bias
}

function matrixNear(left: Matrix4, right: Matrix4, tolerance: number): boolean {
  let maximumDelta = 0
  for (let index = 0; index < 16; index += 1) {
    maximumDelta = Math.max(
      maximumDelta,
      Math.abs(left.elements[index] - right.elements[index]),
    )
  }
  return maximumDelta <= tolerance
}
