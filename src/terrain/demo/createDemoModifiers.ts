import { evaluateHeight } from '../compiler/TerrainField'
import type { SweepRing } from '../modifiers/boolean/CutterVolume'
import {
  createBooleanVolumeModifier,
  createRemeshModifier,
  createTunnelModifier,
} from '../modifiers/factories'
import type {
  TerrainModifier,
  TunnelPortal,
} from '../modifiers/types'
import { normalizeTunnelModifier, tunnelPortalDistance } from '../modifiers/tunnel'
import { createHeroShardModifiers } from './createHeroShard'
import {
  SUPERSEDED_OUTCROP_PREFIXES,
  createOutcropFieldModifiers,
  outcropFieldModifierIds,
} from './createOutcropField'

/**
 * A deliberately small authored demo stack.
 *
 * These are ordinary non-destructive modifiers, not hidden compiler features.
 * The height-derived base therefore remains unchanged everywhere else, while
 * the affected mesh sections acquire local density and genuine 3D topology.
 */
export function createDemoTerrainModifiers(seed: number): TerrainModifier[] {
  // A low conduit that opens into a much wider chamber inside the massif.
  const lowerCave = createTunnelModifier({
    start: surfacePortal(448, 32, seed),
    end: surfacePortal(640, 32, seed),
    radius: 14,
    depth: 32,
  })
  lowerCave.id = 'demo-v2-cave-lower-massif'
  const caveChamber = createBooleanVolumeModifier({
    volumes: [
      {
        kind: 'ellipsoid',
        center: { x: 548, y: 158, z: 38 },
        radii: { x: 44, y: 30, z: 38 },
        forward: { x: 1, y: 0, z: 0.15 },
        surface: 'cave',
      },
    ],
  })
  caveChamber.id = 'demo-v2-cave-lower-chamber'

  // A separate through-window one bench higher up the west face.
  const highCaveStart = surfacePortal(480, 128, seed)
  const highCave = createTunnelModifier({
    start: highCaveStart,
    end: surfacePortal(640, 128, seed),
    radius: 18,
    depth: 36,
  })
  highCave.id = 'demo-v2-window-middle-bench'

  // One curved, continuously varying void removes rock below a resistant cap.
  // What remains is a genuine natural bridge, not a tube stamped through a wall.
  const bridge = createBooleanVolumeModifier({
    volumes: [
      {
        kind: 'sweep',
        rings: naturalBridgeRings(),
        surface: 'arch',
      },
    ],
  })
  bridge.id = 'demo-v2-natural-bridge-high-massif'

  // A buried noisy bite follows the lower west face. Keeping its crown well
  // below the height-derived shell leaves a continuous cap and exposes the
  // volume only where the slope naturally crosses it: an undercut escarpment,
  // not a cell-sized opening punched down through the summit.
  const escarpment = createBooleanVolumeModifier({
    volumes: [
      {
        kind: 'ellipsoid',
        center: {
          x: 462,
          y: evaluateHeight(462, -88, seed, []) - 50,
          z: -88,
        },
        radii: { x: 68, y: 15, z: 21 },
        forward: { x: 0, y: 0, z: 1 },
        surface: 'overhang',
      },
    ],
  })
  escarpment.id = 'demo-v2-escarpment-west-face'

  const caveDensity = createRemeshModifier({
    center: highCaveStart,
    radius: 34,
    targetEdgeLength: 0.72,
  })
  caveDensity.id = 'demo-v2-density-middle-window'

  const bridgeDensity = createRemeshModifier({
    center: { x: 590, y: 232, z: 224 },
    radius: 46,
    targetEdgeLength: 0.9,
  })
  bridgeDensity.id = 'demo-v2-density-natural-bridge'

  const escarpmentDensity = createRemeshModifier({
    center: { x: 462, y: evaluateHeight(462, -88, seed, []) - 14, z: -88 },
    radius: 44,
    targetEdgeLength: 0.95,
  })
  escarpmentDensity.id = 'demo-v2-density-escarpment'

  return [
    caveDensity,
    bridgeDensity,
    escarpmentDensity,
    lowerCave,
    caveChamber,
    highCave,
    bridge,
    escarpment,
    ...createHeroShardModifiers(seed),
    ...createOutcropFieldModifiers(seed),
  ]
}

function naturalBridgeRings(): SweepRing[] {
  const rings: SweepRing[] = []
  const count = 20
  for (let index = 0; index <= count; index += 1) {
    const t = index / count
    const interior = Math.sin(Math.PI * t)
    rings.push({
      // The mouths break through the two flanks at ~215 m, while the centre
      // stays more than 100 m below the crest. That leaves a massive, legible
      // cap instead of deleting the upper ownership cell.
      x: 528 + t * 124,
      y:
        218 +
        interior * 2 +
        Math.sin(t * Math.PI * 2 + 0.4) * interior * 1.2,
      z:
        224 +
        Math.sin(t * Math.PI) * 3 +
        Math.sin(t * Math.PI * 2) * 4,
      horizontalRadius:
        15 + interior * 6 + Math.sin(t * Math.PI * 3) * interior * 1.2,
      verticalRadius:
        14 + interior * 6 + Math.sin(t * Math.PI * 4.5 + 0.7) * interior * 1.2,
    })
  }
  return rings
}

/** Recognizes the original one-tunnel demo so it can be upgraded safely. */
export function isLegacyDemoTerrainModifiers(
  modifiers: readonly TerrainModifier[],
): boolean {
  if (modifiers.length < 1 || modifiers.length > 2) return false
  const tunnels = modifiers.filter(isLegacyDemoTunnel)
  const density = modifiers.filter(isLegacyDemoDensity)
  if (
    tunnels.length !== 1 ||
    density.length > 1 ||
    tunnels.length + density.length !== modifiers.length
  ) {
    return false
  }

  return true
}

/**
 * Replaces obsolete shipped-demo entries inside an otherwise user-authored
 * saved stack. Real edits are retained byte-for-byte; stable current demo IDs
 * prevent the migration from adding the landmark more than once.
 */
export function upgradeLegacyDemoTerrainModifiers(
  modifiers: readonly TerrainModifier[],
  seed: number,
): TerrainModifier[] | undefined {
  const containsLegacyDemo = modifiers.some(isLegacyDemoTunnel)
  // All unversioned `demo-*` IDs were shipped before the topology repair. A
  // few intermediate builds saved different destructive bridge/escarpment
  // parameters under those same IDs, so shape-specific matching can never be
  // exhaustive. Version the authored stack and replace every old built-in ID
  // once; modifiers without a shipped ID are retained byte-for-byte.
  const containsOutdatedDemo = modifiers.some(
    (modifier) => OUTDATED_DEMO_IDS.has(modifier.id) || isSupersededOutcrop(modifier),
  )
  const demoIds = currentDemoIds(seed)
  const containsCurrentDemo = modifiers.some((modifier) => demoIds.has(modifier.id))
  const containsBenchmarkResidue = modifiers.some(isBenchmarkResidue)
  // A world saved before a new piece of authored terrain shipped keeps every
  // modifier it had and is missing only the new ones. Adding them is what lets
  // the demo stack grow without asking anyone to throw away their edits — the
  // ids are the version, so anything already present is left untouched.
  const savedIds = new Set(modifiers.map((modifier) => modifier.id))
  const missingCurrentDemo =
    containsCurrentDemo && [...demoIds].some((id) => !savedIds.has(id))
  if (
    !containsLegacyDemo &&
    !containsOutdatedDemo &&
    !missingCurrentDemo &&
    !(containsCurrentDemo && containsBenchmarkResidue)
  ) {
    return undefined
  }
  const retained = modifiers.filter(
    (modifier) =>
      !isLegacyDemoTunnel(modifier) &&
      !isLegacyDemoDensity(modifier) &&
      !OUTDATED_DEMO_IDS.has(modifier.id) &&
      !isSupersededOutcrop(modifier) &&
      !isBenchmarkResidue(modifier),
  )
  const retainedIds = new Set(retained.map((modifier) => modifier.id))
  const currentDemo = createDemoTerrainModifiers(seed).filter(
    (modifier) => !retainedIds.has(modifier.id),
  )
  return [...retained, ...currentDemo]
}

/**
 * The ids the current demo stack ships. This set *is* the version number: a
 * saved world missing any of them is a world from before that piece was
 * authored, and gets it added without losing its own edits. The outcrop field's
 * ids depend on where the height field put the crags, so they are derived
 * rather than listed.
 */
function currentDemoIds(seed: number): Set<string> {
  return new Set([...FIXED_DEMO_IDS, ...outcropFieldModifierIds(seed)])
}

const FIXED_DEMO_IDS = new Set([
  'demo-v3-hero-shard-mass',
  'demo-v3-hero-shard-bedding',
  'demo-v3-hero-shard-windows',
  'demo-v3-hero-shard-density-0',
  'demo-v3-hero-shard-density-1',
  'demo-v2-cave-lower-massif',
  'demo-v2-cave-lower-chamber',
  'demo-v2-window-middle-bench',
  'demo-v2-natural-bridge-high-massif',
  'demo-v2-escarpment-west-face',
  'demo-v2-density-middle-window',
  'demo-v2-density-natural-bridge',
  'demo-v2-density-escarpment',
])

const OUTDATED_DEMO_IDS = new Set([
  'demo-cave-lower-massif',
  'demo-cave-lower-chamber',
  'demo-window-middle-bench',
  'demo-natural-bridge-high-massif',
  'demo-escarpment-west-face',
  'demo-density-middle-window',
  'demo-density-natural-bridge',
  'demo-density-escarpment',
])

/**
 * Stress scenarios are diagnostics, not authored terrain. Older builds saved
 * every synthetic dab and then reopened those torture-test deformations as if
 * they were user work. Match the generator's exact signature so ordinary
 * one-point brush edits remain untouched.
 */
/**
 * An outcrop field from an earlier version. These are matched by prefix rather
 * than listed: which clusters a field produces depends on where the height
 * field put the crags, so the old ids are not knowable from here.
 */
function isSupersededOutcrop(modifier: TerrainModifier): boolean {
  return SUPERSEDED_OUTCROP_PREFIXES.some((prefix) => modifier.id.startsWith(prefix))
}

function isBenchmarkResidue(modifier: TerrainModifier): boolean {
  return (
    modifier.type === 'brush-stroke' &&
    modifier.points.length === 1 &&
    modifier.domain === 'mesh' &&
    (modifier.mode === 'raise' || modifier.mode === 'lower') &&
    (modifier.radius === 17 || modifier.radius === 26) &&
    modifier.strength === 0.22 &&
    modifier.falloff === 0.58
  )
}

function isLegacyDemoTunnel(modifier: TerrainModifier): boolean {
  if (modifier.type !== 'boolean-subtract') return false
  const tunnel = normalizeTunnelModifier(modifier)
  const centerX = (tunnel.portals[0].x + tunnel.portals[1].x) * 0.5
  const centerZ = (tunnel.portals[0].z + tunnel.portals[1].z) * 0.5
  return (
    Math.abs(centerX - 14) < 0.5 &&
    Math.abs(centerZ - 34) < 0.5 &&
    Math.abs(tunnel.radius - 9) < 0.1 &&
    Math.abs(tunnelPortalDistance(tunnel) - 76) < 0.75
  )
}

function isLegacyDemoDensity(modifier: TerrainModifier): boolean {
  return (
    modifier.type === 'remesh' &&
    Math.abs(modifier.center.x + 52) < 0.5 &&
    Math.abs(modifier.center.z + 12) < 0.5 &&
    Math.abs(modifier.radius - 34) < 0.1
  )
}

function surfacePortal(x: number, z: number, seed: number): TunnelPortal {
  const step = 4
  const y = evaluateHeight(x, z, seed, [])
  const gradientX =
    (evaluateHeight(x + step, z, seed, []) -
      evaluateHeight(x - step, z, seed, [])) /
    (step * 2)
  const gradientZ =
    (evaluateHeight(x, z + step, seed, []) -
      evaluateHeight(x, z - step, seed, [])) /
    (step * 2)
  const length = Math.hypot(gradientX, 1, gradientZ) || 1
  return {
    x,
    y,
    z,
    // Outward normal of y = height(x, z). The tunnel builder travels along its
    // negative direction, so both knees move into the mountain before joining.
    normal: {
      x: -gradientX / length,
      y: 1 / length,
      z: -gradientZ / length,
    },
  }
}
