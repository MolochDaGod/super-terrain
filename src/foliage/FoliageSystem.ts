import { Group, Mesh, PlaneGeometry } from 'three/webgpu'
import type {
  Camera,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  Renderer,
} from 'three/webgpu'
import {
  FoliageMaskField,
  type FoliagePaintLayer,
  type FoliagePaintMode,
  type FoliagePaintStroke,
} from './FoliageMaskField'
import { floorStrokes, type FoliageFloorRecipe } from './foliageFloor'
import {
  createFoliageDebris,
  runFoliageDebris,
  type FoliageDebrisField,
} from './foliageDebris'
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
 * Seeding strokes run per frame.
 *
 * Each one is a dispatch over the whole 512² mask, and a forest recipe is a
 * couple of hundred of them. Running them all in the frame the layer first
 * appears is a quarter-second of compute inside one frame — which is exactly
 * the kind of stall the rest of this system is built to avoid, and it lands on
 * the worst possible frame, the first one. Spreading them costs nothing: the
 * floor fills in over about a fifth of a second while the trees are still
 * compiling, and nobody is looking at bare ground during a build anyway.
 */
const SEED_STROKES_PER_FRAME = 12

/**
 * Everything the ground-cover layer owns, and the one place a frame touches it.
 *
 * The contract with the rest of the editor is deliberately small: hand it a
 * renderer and a camera once a frame, and hand it a stroke when the user drags.
 * Nothing is read back from the GPU at any point — not for placement, not for
 * culling, not for painting — so none of this can stall the frame waiting on
 * the device.
 */
export class FoliageSystem {
  readonly group = new Group()
  readonly mask = new FoliageMaskField()
  readonly rings: FoliageRing[]
  readonly bladeMaterial: MeshStandardNodeMaterial
  readonly groundMaterial: MeshPhysicalNodeMaterial
  readonly ground: Mesh
  readonly debris: FoliageDebrisField

  private readonly groundGeometry: PlaneGeometry
  private pendingSeed: FoliagePaintStroke[] = []
  private seededRecipe: string | null = null
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

    this.debris = createFoliageDebris(this.mask)

    this.group.name = 'ground-foliage'
    this.group.add(this.ground)
    for (const ring of this.rings) this.group.add(ring.mesh)
    for (const mesh of this.debris.meshes) this.group.add(mesh)
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
   * over it. It also means the result is *ordinary painted data*: the eraser
   * takes it off, a different brush replaces it, and nothing about the seeded
   * floor is privileged over anything the user does afterwards. That was the
   * whole problem with the previous arrangement, where the litter and the moss
   * lived as constants inside the ground material and no tool could reach them.
   *
   * Queued rather than run. See `SEED_STROKES_PER_FRAME`.
   */
  seed(recipe: FoliageFloorRecipe): void {
    if (this.disposed || this.seededRecipe === recipe.id) return
    this.seededRecipe = recipe.id
    this.pendingSeed = floorStrokes(recipe)
  }

  /** Re-runs the recipe from scratch, clearing whatever is on the field now. */
  reseed(renderer: Renderer, recipe: FoliageFloorRecipe): void {
    if (this.disposed) return
    this.clear(renderer)
    this.seededRecipe = null
    this.seed(recipe)
  }

  /** Wipes both fields: every plant and every ground layer. */
  clear(renderer: Renderer): void {
    if (this.disposed) return
    this.pendingSeed = []
    // Erasing thins both fields at once, so one dispatch does it.
    this.mask.fill(renderer, 0, 'erase')
  }

  /** True while the opening floor is still being laid down. */
  get seeding(): boolean {
    return this.pendingSeed.length > 0
  }

  /**
   * Drains the seeding queue. Safe to call every frame whether or not the
   * layer is visible — the floor has to exist before it is shown.
   */
  pump(renderer: Renderer): void {
    if (this.disposed || this.pendingSeed.length === 0) return
    const batch = Math.min(SEED_STROKES_PER_FRAME, this.pendingSeed.length)
    for (let index = 0; index < batch; index += 1) {
      this.mask.paint(renderer, this.pendingSeed[index]!)
    }
    this.pendingSeed = this.pendingSeed.slice(batch)
  }

  paint(renderer: Renderer, stroke: FoliagePaintStroke): void {
    this.mask.paint(renderer, stroke)
  }

  fill(
    renderer: Renderer,
    species: number,
    mode: FoliagePaintMode,
    layer: FoliagePaintLayer = 'plants',
  ): void {
    this.mask.fill(renderer, species, mode, layer)
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
    runFoliageDebris(renderer, this.debris)
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    disposeFoliageRings(this.rings)
    this.debris.dispose()
    this.groundGeometry.dispose()
    this.bladeMaterial.dispose()
    this.groundMaterial.dispose()
    this.mask.dispose()
  }
}
