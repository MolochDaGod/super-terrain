import {
  DepthTexture,
  FloatType,
  LessEqualCompare,
  LinearFilter,
  Matrix4,
  OrthographicCamera,
  RenderTarget,
  Vector3,
  type Camera,
  type Object3D,
  type Renderer,
  type Scene,
} from 'three/webgpu'

/**
 * `userData` flag for meshes the sun depth pass must not draw.
 *
 * Rendering with the scene's own materials buys the alpha cutouts this map
 * exists for, and costs one thing nobody asked for: a material carrying a node
 * that renders a pass of its own gets to run that pass from *this* camera. The
 * water's planar reflector is exactly such a node. It updates once per frame,
 * keys its virtual camera and render target on whichever camera reached it
 * first, and repoints the water's reflection texture at that target — so on
 * every frame this map refreshed, the lake was showing a reflection rendered
 * from the sun through an oblique clip plane, which is to say nothing at all.
 * Measured over a ninety-step move it was a third of the frames, which is what
 * the flicker was.
 *
 * A water surface does not shape a light shaft, so leaving it out costs the
 * shafts nothing and is what the flag is for.
 */
export const EXCLUDE_FROM_SUN_DEPTH = 'excludeFromSunDepth'

/**
 * A depth map from the sun, kept for volumetrics rather than for shading.
 *
 * The renderer already builds cascaded shadow maps, and they are the wrong
 * thing to march against twice over: their layout is chosen to put texels where
 * surfaces are, not where air is, and three's shadow nodes fix the world
 * position they sample at setup — so a march would need one node per step, each
 * carrying its own PCF filter and its own update hook. A single orthographic
 * map covering the near field costs one depth-only pass and gives the march one
 * cheap tap per sample.
 *
 * It is deliberately rendered with the scene's own materials rather than an
 * override. Light shafts in a wood are shaped by the gaps between leaves, and
 * an override material drops the alpha cutout that makes those gaps — which
 * would turn a dappled canopy into a solid lid and the shafts into a single
 * hard-edged wedge.
 */
export class SunDepthMap {
  readonly target: RenderTarget
  readonly camera = new OrthographicCamera()
  /** World space to shadow clip space, for the march to project samples with. */
  readonly matrix = new Matrix4()
  /** Metres the map covers along the view direction. */
  readonly range: number
  /** Map edge in texels, for the march's filter width. */
  readonly resolution: number

  private readonly centre = new Vector3()
  private readonly eye = new Vector3()
  private readonly direction = new Vector3(0, 1, 0)
  private dirty = true
  private lastKey = ''
  private disposed = false

  constructor(resolution = 1024, range = 130) {
    this.range = range
    this.resolution = resolution
    this.target = new RenderTarget(resolution, resolution, {
      depthBuffer: true,
      // Read back as depth in the march. The colour attachment exists only
      // because a render target needs one; nothing samples it.
      count: 1,
    })
    this.target.depthTexture = new DepthTexture(resolution, resolution)
    this.target.depthTexture.type = FloatType
    // Comparison sampling turns each godray lookup into hardware bilinear PCF:
    // four depth comparisons are filtered by one texture instruction.
    this.target.depthTexture.compareFunction = LessEqualCompare
    this.target.depthTexture.minFilter = LinearFilter
    this.target.depthTexture.magFilter = LinearFilter
    this.target.texture.name = 'godray-sun-depth-colour'
    this.target.depthTexture.name = 'godray-sun-depth'

    const half = range * 0.5
    this.camera.left = -half
    this.camera.right = half
    this.camera.top = half
    this.camera.bottom = -half
    this.camera.near = 1
    this.camera.far = range * 2.2
  }

  /** Marks the map stale. Call when the scene's occluders change. */
  invalidate(): void {
    this.dirty = true
  }

  /**
   * Re-renders when the view has moved far enough to matter, or when something
   * invalidated it. The map follows the camera, so a walk through the stand
   * would otherwise redraw it every frame for a result that barely changed.
   */
  update(
    renderer: Renderer,
    scene: Scene,
    viewCamera: Camera,
    sunDirection: Vector3,
  ): void {
    if (this.disposed) return
    viewCamera.getWorldPosition(this.eye)
    this.direction.copy(sunDirection).normalize()

    // Snapped to a coarse grid so the map's texel alignment only changes in
    // steps. Following the camera continuously makes every shaft edge crawl.
    const snap = this.range / 32
    this.centre.set(
      Math.round(this.eye.x / snap) * snap,
      Math.round(this.eye.y / snap) * snap,
      Math.round(this.eye.z / snap) * snap,
    )
    const key = `${this.centre.x},${this.centre.y},${this.centre.z},` +
      `${this.direction.x.toFixed(3)},${this.direction.y.toFixed(3)},${this.direction.z.toFixed(3)}`
    if (!this.dirty && key === this.lastKey) return
    this.dirty = false
    this.lastKey = key

    this.camera.position.copy(this.centre).addScaledVector(this.direction, this.range)
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(this.centre)
    this.camera.updateMatrixWorld(true)
    this.camera.updateProjectionMatrix()
    this.matrix.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    )

    const previousTarget = renderer.getRenderTarget()
    const hidden: Object3D[] = []
    scene.traverse((object) => {
      if (!object.visible || object.userData[EXCLUDE_FROM_SUN_DEPTH] !== true) return
      object.visible = false
      hidden.push(object)
    })
    try {
      renderer.setRenderTarget(this.target)
      renderer.clear()
      renderer.render(scene, this.camera)
    } finally {
      renderer.setRenderTarget(previousTarget)
      for (const object of hidden) object.visible = true
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.target.depthTexture?.dispose()
    this.target.dispose()
  }
}
