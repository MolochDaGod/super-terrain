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
// Late afternoon, west-north-west and a little above the far ridge line. The
// hero frame is three-quarter backlit, so crests carry a warm rim and faces
// turned to the camera fall into sky-lit shade.
//
// The elevation is a compromise that was previously set too low. At seven
// degrees the rake is so extreme that every slope is either blown out or in
// shadow, cast shadows run the whole length of the valley, and the terrain
// reads as a relief map lit by a torch held at the horizon. Fifteen degrees
// keeps the warm backlight and the long modelling shadows while leaving enough
// of the ground in the middle of the falloff for the surface material to show
// at all. Twelve degrees restores the long reference shadows while the reduced
// ambient fill keeps their interiors modelled rather than uniformly grey.
export const DEFAULT_SUN = createSun(14, 142)

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
