import { BufferGeometry, Mesh } from 'three/webgpu'
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh'

/**
 * Bounded-hierarchy raycasting for terrain surfaces.
 *
 * Three's stock `Mesh.raycast` tests every triangle of every mesh whose bounds
 * the ray crosses. The editor casts a ray on every `pointermove` to place the
 * cursor, and a camera-grazing ray over a 1.2M-triangle working set crosses
 * several sections at once: measured at 10.3 ms per cast, which alone consumes
 * the main thread at any normal pointer event rate and is why orbiting felt
 * heavy long before the GPU was the limit. The same cast against a BVH is
 * 0.12 ms.
 *
 * The tree is built lazily rather than at upload. Building costs ~5.5 ms for a
 * LOD0 section, which is real work that does not belong in the frame that
 * installs a freshly compiled mesh; deferring it to the first ray that actually
 * needs the section spreads that cost over the sections the user points at and
 * skips it entirely for the ones they never do.
 *
 * three-mesh-bvh augments `BufferGeometry` with these members itself, but two
 * copies of the library are installed — @react-three/drei pins an older one — and
 * their augmentations describe the tree with different, incompatible types.
 * Reaching the members through a local structural view keeps this file bound to
 * the copy it actually imports instead of to whichever declaration merges first.
 */
interface AcceleratedGeometry {
  boundsTree?: { refit(): void }
  computeBoundsTree(): void
  disposeBoundsTree(): void
}

function accelerated(geometry: BufferGeometry): AcceleratedGeometry {
  return geometry as unknown as AcceleratedGeometry
}

let installed = false

function install(): void {
  if (installed) return
  installed = true
  const prototype = BufferGeometry.prototype as unknown as AcceleratedGeometry
  prototype.computeBoundsTree = computeBoundsTree as unknown as () => void
  prototype.disposeBoundsTree = disposeBoundsTree as unknown as () => void
  Mesh.prototype.raycast = acceleratedRaycast
}

/** Builds this geometry's BVH if it has none. Safe to call on every cast. */
export function ensureTerrainBoundsTree(geometry: BufferGeometry): void {
  install()
  if (accelerated(geometry).boundsTree) return
  // Bricks share their parent LOD's attributes but carry their own index, so
  // each one is its own tree. With `brickSize` at infinity there is exactly one
  // brick per LOD and this is a single tree per section.
  if (!geometry.getIndex() || !geometry.getAttribute('position')) return
  accelerated(geometry).computeBoundsTree()
}

/**
 * Re-fits an existing BVH after a speculative brush displacement.
 *
 * Preview strokes move vertices without touching the index, which is exactly
 * the case refitting covers, and it is far cheaper than a rebuild. A geometry
 * with no tree yet is left alone: it will be built from the moved positions the
 * first time a ray needs it.
 */
export function refitTerrainBoundsTree(geometry: BufferGeometry): void {
  accelerated(geometry).boundsTree?.refit()
}

/** Releases a BVH ahead of the geometry itself. */
export function disposeTerrainBoundsTree(geometry: BufferGeometry): void {
  if (!accelerated(geometry).boundsTree) return
  accelerated(geometry).disposeBoundsTree()
}
