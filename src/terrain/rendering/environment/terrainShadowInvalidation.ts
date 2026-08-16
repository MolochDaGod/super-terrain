/**
 * Monotonic revision for geometry changes that can alter the terrain's shadow.
 *
 * The full environment owns the shadow maps while the render backend owns the
 * meshes, so this tiny signal keeps the two independent without making either
 * one poll hundreds of BufferGeometry versions every frame.
 */
let revision = 0

export function invalidateTerrainShadows(): void {
  revision = (revision + 1) >>> 0
}

export function getTerrainShadowRevision(): number {
  return revision
}
