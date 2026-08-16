import { Vector3 } from 'three/webgpu'

export interface SunSetup {
  /** Unit vector pointing from the world towards the sun. */
  direction: Vector3
  elevationRadians: number
  azimuthRadians: number
}

/**
 * A single low-ish sun drives every lighting decision in `full` mode: the sky
 * model, the cascade shadows, the rim light on ridges and the aerial haze all
 * read from here so they can never drift apart.
 */
// Mid-morning. Low enough that ridges throw long shadows across the slopes
// below them, and placed to the side of the standard viewpoints rather than
// behind them, because a sun over the viewer's shoulder flattens every form.
export const DEFAULT_SUN = createSun(19, 214)

/**
 * Repoints the shared sun. Everything downstream reads `DEFAULT_SUN.direction`
 * or the atmosphere's `SUN_DIRECTION` uniform, so this is the single place a
 * time of day is chosen. Must be called before the environment is built.
 */
export function setSunAngles(
  elevationDegrees: number,
  azimuthDegrees: number,
): void {
  const next = createSun(elevationDegrees, azimuthDegrees)
  DEFAULT_SUN.direction.copy(next.direction)
  DEFAULT_SUN.elevationRadians = next.elevationRadians
  DEFAULT_SUN.azimuthRadians = next.azimuthRadians
}

export function createSun(
  elevationDegrees: number,
  azimuthDegrees: number,
): SunSetup {
  const elevationRadians = (elevationDegrees * Math.PI) / 180
  const azimuthRadians = (azimuthDegrees * Math.PI) / 180
  const direction = new Vector3(
    Math.cos(elevationRadians) * Math.sin(azimuthRadians),
    Math.sin(elevationRadians),
    Math.cos(elevationRadians) * Math.cos(azimuthRadians),
  ).normalize()
  return { direction, elevationRadians, azimuthRadians }
}
