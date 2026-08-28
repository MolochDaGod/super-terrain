/** RGB radiance or irradiance. */
export type Rgb = [number, number, number]

/** World-space point. */
export type Vec3 = [number, number, number]

/** Two-band (L0 + L1) RGB spherical harmonics, Ramamoorthi 2001. */
export interface SH2 {
  /** L00 */
  l0: Rgb
  /** L11 ~ x */
  lx: Rgb
  /** L1-1 ~ y */
  ly: Rgb
  /** L10 ~ z */
  lz: Rgb
}

export interface RadianceCacheEntry {
  checksum: number
  lod: number
  ix: number
  iy: number
  iz: number
  radiance: Rgb
  normal: Vec3
  albedo: Rgb
  frame: number
}

export interface VisibilityHit {
  position: Vec3
  normal: Vec3
  albedo: Rgb
  distance: number
  probeIndex: number
  rayIndex: number
}

export interface PointLight {
  position: Vec3
  color: Rgb
  intensity: number
  /** If set with `coneCos`, the light is a cone aimed along this direction. */
  direction?: Vec3
  coneCos?: number
}

export interface CascadeConfig {
  /** Cells along each axis of one cascade volume. */
  resolution: number
  cascadeCount: number
  /** World extent of cascade 0 (finest). Each next cascade doubles. */
  firstSize: number
  raysPerProbe: number
  /** How many cascades to refresh this frame (Sousa: 1). */
  cascadesPerFrame: number
}

export interface RadianceCacheConfig {
  /** Base cell size in world units (Sousa: 0.25 m). */
  cellSize: number
  maxCells: number
  probeSteps: number
  /** Reuse a filled cell for this many frames before forcing a rewrite. */
  reuseFrames: number
  lodDistance: number
}

export interface GatherQuery {
  /** World-space hit of the gather ray. */
  position: Vec3
  normal: Vec3
  rayDir: Vec3
  frame: number
}

export type GatherSource =
  | 'screen-space'
  | 'radiance-cache'
  | 'irradiance-volume'
  | 'miss'

export interface GatherResult {
  radiance: Rgb
  source: GatherSource
}

export interface ScreenSpaceCache {
  /**
   * If the gather hit is inside the camera frustum and unoccluded in the
   * current (or previous) depth buffer, return its shaded radiance.
   */
  sample(position: Vec3): Rgb | null
}

export const DEFAULT_CASCADE: CascadeConfig = {
  resolution: 8,
  cascadeCount: 3,
  firstSize: 8,
  raysPerProbe: 16,
  cascadesPerFrame: 1,
}

export const DEFAULT_CACHE: RadianceCacheConfig = {
  cellSize: 0.25,
  maxCells: 65_536,
  probeSteps: 8,
  reuseFrames: 8,
  lodDistance: 8,
}

export function zeroRgb(): Rgb {
  return [0, 0, 0]
}

export function zeroSH(): SH2 {
  return { l0: [0, 0, 0], lx: [0, 0, 0], ly: [0, 0, 0], lz: [0, 0, 0] }
}

export function addRgb(a: Rgb, b: Rgb): Rgb {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

export function scaleRgb(a: Rgb, s: number): Rgb {
  return [a[0] * s, a[1] * s, a[2] * s]
}

export function mulRgb(a: Rgb, b: Rgb): Rgb {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}

export function clampRgb(a: Rgb): Rgb {
  return [
    Math.max(0, a[0]),
    Math.max(0, a[1]),
    Math.max(0, a[2]),
  ]
}

export function copyRgb(a: Rgb): Rgb {
  return [a[0], a[1], a[2]]
}

export function rgbLengthSq(a: Rgb): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2]
}
