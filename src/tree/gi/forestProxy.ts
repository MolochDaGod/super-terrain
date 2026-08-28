import { Box3, Vector3 } from 'three/webgpu'
import {
  createVoxelVolume,
  finaliseVoxels,
  splatCanopyShell,
  splatSlab,
  splatTaperedCylinder,
  type VoxelScene,
} from '@workspace/idtech-gi'

/** One stem, described by the numbers the generator already knows about it. */
export interface ForestProxyTree {
  position: readonly [number, number, number]
  rotation: number
  scale: number
  /** Non-zero means deadfall: a fallen, leafless stem. */
  tilt?: number
  height: number
  crownRadius: number
  trunkRadius: number
}

export interface ForestProxyOptions {
  /** Voxels along the stand's longest axis. */
  maxResolution?: number
  /** World height of the ground plane the stand stands on. */
  groundY?: number
  /** Linear albedo of the forest floor, bark and foliage. */
  groundAlbedo?: readonly [number, number, number]
  barkAlbedo?: readonly [number, number, number]
  leafAlbedo?: readonly [number, number, number]
  onProgress?: (fraction: number, label: string) => void
}

/**
 * Litter over moss. Dark, and slightly green from what grows on it — the floor
 * is the largest single bounce surface in a stand, so getting its colour
 * roughly right matters more than getting any one trunk right.
 */
const FLOOR_ALBEDO = [0.085, 0.095, 0.062] as const
/** Wet beech bark carrying moss. */
const BARK_ALBEDO = [0.095, 0.105, 0.075] as const
/**
 * Beech foliage, biased brighter than a leaf's reflectance alone.
 *
 * A leaf transmits nearly as much light as it reflects, and the transmitted
 * part is greener still. The proxy has no transmission, so the canopy's albedo
 * carries it instead; a strictly reflective value makes a stand read as though
 * it were roofed in slate.
 */
const LEAF_ALBEDO = [0.115, 0.235, 0.065] as const

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Voxelises a stand from proxy volumes rather than from its triangles.
 *
 * The forest is a few hundred instanced trees of a hundred thousand triangles
 * each, streamed and LOD-swapped every frame; walking that geometry would cost
 * seconds and be stale by the time it finished. What the rays actually need is
 * the shape of the occlusion — a floor, stems, and crowns that light can filter
 * through — and the generator already knows the height, crown radius and trunk
 * radius of every tree it placed.
 */
export async function buildForestProxy(
  trees: readonly ForestProxyTree[],
  options: ForestProxyOptions = {},
): Promise<VoxelScene> {
  const report = options.onProgress ?? (() => {})
  const groundY = options.groundY ?? 0
  const floor = options.groundAlbedo ?? FLOOR_ALBEDO
  const bark = options.barkAlbedo ?? BARK_ALBEDO
  const leaf = options.leafAlbedo ?? LEAF_ALBEDO

  const bounds = new Box3()
  bounds.makeEmpty()
  const point = new Vector3()
  for (const tree of trees) {
    const reach = Math.max(tree.crownRadius, tree.height * 0.35) * tree.scale
    const top = groundY + tree.height * tree.scale * 1.15
    point.set(tree.position[0] - reach, groundY - 2, tree.position[2] - reach)
    bounds.expandByPoint(point)
    point.set(tree.position[0] + reach, top, tree.position[2] + reach)
    bounds.expandByPoint(point)
  }
  if (bounds.isEmpty()) {
    bounds.set(new Vector3(-20, groundY - 2, -20), new Vector3(20, groundY + 20, 20))
  }
  // Headroom above the canopy so probes above the stand still see open sky
  // rather than the edge of the volume.
  bounds.max.y += 6

  // Resolution follows the stand's extent so the voxel stays about the same
  // size in metres however wide the layout spreads — a fixed resolution over a
  // hundred-metre stand puts crowns inside single cells. The ceiling is there
  // because both the canopy splat and the distance transform scale with the
  // voxel count, and this runs on the main thread.
  const span = Math.max(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  )
  const resolution = options.maxResolution
    ?? Math.max(96, Math.min(176, Math.round(span / 0.7)))
  const acc = createVoxelVolume(bounds, resolution)
  report(0.05, 'forest floor')
  await yieldToBrowser()
  splatSlab(acc, groundY, acc.cell * 2.5, floor)

  const base = new Vector3()
  const tip = new Vector3()
  const centre = new Vector3()
  const radii = new Vector3()
  for (let i = 0; i < trees.length; i += 1) {
    const tree = trees[i]!
    const scale = tree.scale
    const height = tree.height * scale
    const crown = tree.crownRadius * scale
    const trunk = Math.max(0.06, tree.trunkRadius * scale)
    const tilt = tree.tilt ?? 0
    // A fallen stem lies along its own heading; the same capsule serves, laid
    // over rather than stood up.
    const lean = Math.sin(tilt)
    const rise = Math.cos(tilt)
    const dirX = Math.cos(tree.rotation) * lean
    const dirZ = Math.sin(tree.rotation) * lean

    base.set(tree.position[0], groundY, tree.position[2])
    tip.set(
      tree.position[0] + dirX * height,
      groundY + rise * height * 0.94,
      tree.position[2] + dirZ * height,
    )
    splatTaperedCylinder(acc, base, tip, trunk * 1.35, trunk * 0.3, bark)

    if (tilt === 0) {
      // Crown mass sits in the upper half of the stem, wider than it is tall in
      // a closed stand where neighbours have crowded the sides.
      centre.set(
        tree.position[0],
        groundY + height * 0.72,
        tree.position[2],
      )
      radii.set(crown, Math.max(crown * 0.62, height * 0.2), crown)
      splatCanopyShell(acc, centre, radii, leaf, {
        shell: 0.5,
        porosity: 0.45,
        seed: Math.round(tree.position[0] * 977 + tree.position[2] * 131 + i),
      })
    }

    if (i % 12 === 11) {
      report(0.05 + (i / trees.length) * 0.7, `stems ${i + 1}/${trees.length}`)
      await yieldToBrowser()
    }
  }

  report(0.8, 'distance field')
  await yieldToBrowser()
  const scene = finaliseVoxels(acc)
  report(1, 'ready')
  return scene
}
