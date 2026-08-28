import { Group, Mesh, PlaneGeometry } from 'three/webgpu'
import type {
  Camera,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  Renderer,
} from 'three/webgpu'
import {
  FoliageMaskField,
  type FoliagePaintMode,
  type FoliagePaintStroke,
} from './FoliageMaskField'
import {
  createFoliageBladeMaterial,
} from './foliageBladeMaterial'
import {
  createFoliageGroundMaterial,
  type FoliageGroundTextures,
} from './foliageGroundCanopy'
import {
  createFoliageInstanceBuffer,
  createFoliageInstanceReader,
  createFoliageRings,
  disposeFoliageRings,
  runFoliagePopulation,
  type FoliageRing,
} from './FoliagePopulation'
import {
  foliageDensity,
  foliageWind,
  foliageWindDirection,
  updateFoliageRuntime,
} from './foliageRuntime'
import { foliageSpeciesIndex } from './foliageSpecies'

export interface FoliageWindSettings {
  /** 0 is still air, 1 a strong steady breeze. */
  strength: number
  /** Metres between gust fronts. */
  gustScale: number
  /** How fast those fronts travel. */
  gustSpeed: number
  /** Per-blade flutter, independent of the gust field. */
  flutter: number
  /** Compass heading in radians on the ground plane. */
  heading: number
}

export const DEFAULT_FOLIAGE_WIND: FoliageWindSettings = {
  strength: 0.42,
  gustScale: 16,
  gustSpeed: 1.15,
  flutter: 1,
  heading: 0.62,
}

/**
 * Everything the ground-cover layer owns, and the one place a frame touches it.
 *
 * The contract with the rest of the editor is deliberately small: hand it a
 * renderer and a camera once a frame, and hand it a stroke when the user drags.
 * Nothing is read back from the GPU at any point — not for placement, not for
 * culling, not for painting — so none of this can stall the frame waiting on
 * the device.
 */
/** Which ground cover the layer opens on. */
export type FoliageFloor = 'meadow' | 'forest'

type FloorSeed = [string, number, number, number, number]

/**
 * Deterministic colonies of one species scattered over a disc.
 *
 * Seeded rather than hand-placed so the layout covers whatever the stand
 * actually spans, and so adding a layer is one line instead of twenty
 * coordinates that have to be kept clear of each other by eye.
 */
function scatterColonies(
  species: string,
  count: number,
  spread: number,
  radius: readonly [number, number],
  flow: readonly [number, number],
  seed: number,
): FloorSeed[] {
  let state = seed >>> 0
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const seeds: FloorSeed[] = []
  for (let i = 0; i < count; i += 1) {
    const angle = random() * Math.PI * 2
    // Square-rooted so colonies are spread evenly over the disc rather than
    // piled around the origin.
    const distance = Math.sqrt(random()) * spread
    seeds.push([
      species,
      Math.round(Math.cos(angle) * distance),
      Math.round(Math.sin(angle) * distance),
      radius[0] + random() * (radius[1] - radius[0]),
      flow[0] + random() * (flow[1] - flow[0]),
    ])
  }
  return seeds
}

const FLOOR_SEEDS: Record<FoliageFloor, readonly FloorSeed[]> = {
  meadow: [
    ['tussock', -46, 28, 52, 0.55],
    ['tussock', 63, -71, 44, 0.5],
    ['dry-steppe', 78, 62, 66, 0.62],
    ['dry-steppe', -95, -40, 58, 0.5],
    ['wildflower', -18, -64, 40, 0.55],
    ['clover-mat', 24, 46, 34, 0.5],
    ['woodland-fern', -84, 88, 38, 0.6],
    ['sedge-reed', 108, -18, 30, 0.58],
    ['broadleaf-weed', 6, 96, 32, 0.45],
  ],
  // Colonies, not a sward.
  //
  // The floor is built in layers the way a real one is, because a single
  // species painted anywhere always reads as a texture: bracken over the open
  // ground, fern colonies in the shade under it, bramble sprawling where a
  // gap lets light in, and a fine rush threading between all of them. Flows
  // stay well under one so the patches keep soft, incomplete edges and
  // overlap into mixtures rather than stacking as decals.
  //
  // Scattered rather than listed. The stand now spreads across most of a
  // four-hundred-metre ground, and a hand-placed list of nine colonies inside
  // forty metres of the origin left everything beyond that bare — which is
  // most of what made the floor read as a demo.
  //
  // Moss is deliberately absent. A mat of blades is the wrong model for it
  // twice over: moss is a film on a surface rather than a stand of
  // individuals, and it lives in the ground material where a film belongs.
  // The species exists in the palette for painting cushions by hand.
  forest: [
    ...scatterColonies('bracken', 20, 122, [11, 23], [0.3, 0.54], 0x1f35),
    ...scatterColonies('woodland-fern', 24, 118, [10, 19], [0.34, 0.56], 0x2c71),
    ...scatterColonies('bramble', 15, 116, [6, 13], [0.26, 0.46], 0x3a19),
    ...scatterColonies('wood-rush', 28, 130, [12, 25], [0.18, 0.32], 0x4d63),
    // Scattered, not a sward. Painted at full flow these read as a layer of
    // pale plastic leaves over the litter — the herbs are the exception on a
    // forest floor rather than the rule.
    ...scatterColonies('broadleaf-weed', 18, 120, [11, 19], [0.14, 0.25], 0x5b87),
  ],
}

export class FoliageSystem {
  readonly group = new Group()
  readonly mask = new FoliageMaskField()
  readonly rings: FoliageRing[]
  readonly bladeMaterial: MeshStandardNodeMaterial
  readonly groundMaterial: MeshPhysicalNodeMaterial
  readonly ground: Mesh

  private readonly groundGeometry: PlaneGeometry
  private seeded = false
  private disposed = false

  constructor(groundTextures: FoliageGroundTextures) {
    const instances = createFoliageInstanceBuffer()
    this.bladeMaterial = createFoliageBladeMaterial(
      createFoliageInstanceReader(instances),
    )
    this.rings = createFoliageRings(this.mask, instances, this.bladeMaterial)

    this.groundMaterial = createFoliageGroundMaterial(this.mask, groundTextures)
    this.groundGeometry = new PlaneGeometry(
      this.mask.fieldSize,
      this.mask.fieldSize,
      1,
      1,
    )
    this.ground = new Mesh(this.groundGeometry, this.groundMaterial)
    this.ground.name = 'foliage-ground'
    this.ground.rotation.x = -Math.PI / 2
    this.ground.receiveShadow = true
    this.ground.matrixAutoUpdate = false
    this.ground.updateMatrix()

    this.group.name = 'ground-foliage'
    this.group.add(this.ground)
    for (const ring of this.rings) this.group.add(ring.mesh)
  }

  setDensity(value: number): void {
    foliageDensity.value = Math.min(Math.max(value, 0), 1)
  }

  setWind(settings: FoliageWindSettings): void {
    foliageWind.value.set(
      Math.max(settings.strength, 0),
      Math.max(settings.gustScale, 1),
      settings.gustSpeed,
      settings.flutter,
    )
    foliageWindDirection.value.set(
      Math.cos(settings.heading),
      Math.sin(settings.heading),
    )
  }

  /**
   * A starting ground cover, so the workspace opens on ground rather than on
   * gravel.
   *
   * Laid down as real brush strokes through the same kernel the toolbar uses,
   * which means the competition between species applies and the result is a
   * genuine mix — not a uniform field of one type with three others stamped
   * over it.
   *
   * `meadow` fills first and scatters over the fill, because open pasture is
   * continuous. `forest` never fills: the floor of a closed stand is mostly
   * bare litter, and the cover on it is colonies — a fern stand here, a moss
   * mat over a rotting log there — with dark humus between them. Filling it
   * and then darkening the result gives a lawn in the shade, which is exactly
   * the tell this avoids.
   */
  seed(renderer: Renderer, floor: FoliageFloor = 'meadow'): void {
    if (this.seeded || this.disposed) return
    this.seeded = true
    if (floor === 'meadow') {
      this.mask.fill(renderer, foliageSpeciesIndex('meadow-fescue'), 'paint')
    }
    for (const [species, x, z, radius, flow] of FLOOR_SEEDS[floor]) {
      this.mask.paint(renderer, {
        fromX: x,
        fromZ: z,
        toX: x,
        toZ: z,
        radius,
        flow,
        hardness: 0.05,
        species: foliageSpeciesIndex(species as never),
        mode: 'paint',
      })
    }
  }

  paint(renderer: Renderer, stroke: FoliagePaintStroke): void {
    this.mask.paint(renderer, stroke)
  }

  fill(renderer: Renderer, species: number, mode: FoliagePaintMode): void {
    this.mask.fill(renderer, species, mode)
  }

  /** Call once per frame, before the scene is submitted. */
  update(
    renderer: Renderer,
    camera: Camera,
    elapsedSeconds: number,
    viewportHeight: number,
  ): void {
    if (this.disposed) return
    updateFoliageRuntime(camera, elapsedSeconds, viewportHeight)
    runFoliagePopulation(renderer, this.rings)
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    disposeFoliageRings(this.rings)
    this.groundGeometry.dispose()
    this.bladeMaterial.dispose()
    this.groundMaterial.dispose()
    this.mask.dispose()
  }
}
