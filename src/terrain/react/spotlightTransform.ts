import { Quaternion, Vector3 } from 'three'

const LOCAL_SPOTLIGHT_FORWARD = new Vector3(0, 0, -1)
const FALLBACK_SPOTLIGHT_DIRECTION = new Vector3(0, -1, 0)

export function setQuaternionFromSpotlightDirection(
  quaternion: Quaternion,
  direction: Vector3,
): Quaternion {
  const normalizedDirection = direction.clone()
  if (normalizedDirection.lengthSq() < 1e-12) {
    normalizedDirection.copy(FALLBACK_SPOTLIGHT_DIRECTION)
  } else {
    normalizedDirection.normalize()
  }
  return quaternion.setFromUnitVectors(
    LOCAL_SPOTLIGHT_FORWARD,
    normalizedDirection,
  )
}

export function spotlightDirectionFromQuaternion(
  quaternion: Quaternion,
  output: Vector3,
): Vector3 {
  return output
    .copy(LOCAL_SPOTLIGHT_FORWARD)
    .applyQuaternion(quaternion)
    .normalize()
}
