import { Frustum, Matrix4, Vector2, Vector3, Vector4 } from 'three/webgpu'
import type { Camera } from 'three/webgpu'
import { uniform, uniformArray } from 'three/tsl'

const frustum = /*@__PURE__*/ new Frustum()
const viewProjection = /*@__PURE__*/ new Matrix4()

/**
 * The handful of values every foliage shader reads, updated once per frame.
 *
 * Frustum planes are computed on the CPU because six planes is six planes:
 * deriving them per invocation across fifty thousand compute threads to save
 * a twenty-four float upload would be the wrong trade. Everything downstream
 * of this — placement, culling, bending, shading — stays on the GPU.
 */
export const foliageCameraPosition = /*@__PURE__*/ uniform(new Vector3())
const frustumPlaneValues = /*@__PURE__*/ [
  new Vector4(),
  new Vector4(),
  new Vector4(),
  new Vector4(),
  new Vector4(),
  new Vector4(),
]
export const foliageFrustumPlanes = /*@__PURE__*/ uniformArray(
  frustumPlaneValues,
  'vec4',
)

/** Global clump abundance, 0..1, from the toolbar. */
export const foliageDensity = /*@__PURE__*/ uniform(1)

/** Seconds. Separate from `time` so a paused editor can still be scrubbed. */
export const foliageTime = /*@__PURE__*/ uniform(0)

/** xy is the unit wind heading on the ground plane. */
export const foliageWindDirection = /*@__PURE__*/ uniform(new Vector2(0.82, 0.57))

/** x strength, y gust scale in metres, z gust speed, w flutter amount. */
export const foliageWind = /*@__PURE__*/ uniform(new Vector4(0.5, 14, 1.1, 1))

/**
 * Vertical pixels and the tangent of the half vertical field of view.
 *
 * Together these convert a world-space width at a view distance into a width
 * in pixels, which is what the minimum-width clamp needs to keep a blade from
 * thinning below the sampling rate and vanishing.
 */
export const foliageProjection = /*@__PURE__*/ uniform(new Vector2(1080, 0.414))

export function updateFoliageRuntime(
  camera: Camera,
  elapsedSeconds: number,
  viewportHeight: number,
): void {
  camera.getWorldPosition(foliageCameraPosition.value)
  camera.updateMatrixWorld()
  viewProjection.multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  )
  frustum.setFromProjectionMatrix(viewProjection)
  for (let index = 0; index < 6; index += 1) {
    const plane = frustum.planes[index]
    frustumPlaneValues[index].set(
      plane.normal.x,
      plane.normal.y,
      plane.normal.z,
      plane.constant,
    )
  }
  foliageTime.value = elapsedSeconds
  const perspective = camera as Camera & { isPerspectiveCamera?: boolean; fov?: number }
  const halfFovTangent = perspective.isPerspectiveCamera && perspective.fov
    ? Math.tan((perspective.fov * Math.PI) / 360)
    : 0.414
  foliageProjection.value.set(Math.max(1, viewportHeight), halfFovTangent)
}
