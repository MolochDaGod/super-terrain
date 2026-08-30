import { Group, Matrix4, Mesh, PlaneGeometry } from 'three/webgpu'
import type {
  Camera,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  Renderer,
} from 'three/webgpu'
import {
  FOLIAGE_FIELD_SIZE,
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
import { FoliageGroundHeightField } from './foliageGroundHeight'
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

/**
 * Still air with a breeze in it, rather than the gale this used to open on.
 *
 * Three of the four numbers were too high and only one of them was strength.
 * What reads as "fast" in moving foliage is almost never how far a blade bends
 * — that is amplitude, and the eye accepts a wide range of it — but how often
 * it changes direction. Two terms drive that here and both were at or near
 * their maximum: `gustSpeed`, how quickly a gust front crosses the ground, and
 * `flutter`, the per-blade jitter riding on top of the gust field.
 *
 * A gust front travelling 1.15 in a 16-metre gust field cycles a given blade
 * about every fourteen seconds, which would be fine on its own; full flutter on
 * top of it is what turned that into a shimmer. Slowing the front, widening the
 * field so each gust takes longer to pass, and halving the flutter gives air
 * that is clearly moving and is not distracting to work in front of — which
 * matters, because this is an editor and the foliage is on screen the whole
 * time somebody is doing something else.
 */
export const DEFAULT_FOLIAGE_WIND: FoliageWindSettings = {
  strength: 0.3,
  gustScale: 24,
  gustSpeed: 0.34,
  flutter: 0.45,
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
export interface FoliageSystemOptions extends FoliageGroundTextures {
  /**
   * Metres the painted window covers. The lab's ground is four hundred across;
   * a terrain world wants a wider one so a forest and its surroundings fit
   * inside a single window and the camera can move without it recentring
   * constantly.
   */
  fieldSize?: number
  /**
   * Whether to draw the flat ground plane the cover stands on.
   *
   * The lab has no other floor, so it must. A terrain world already has one —
   * a real, sculpted, streamed one — and laying a 400-metre plane over it would
   * z-fight along every square metre of the overlap. There the terrain material
   * blends the same painted layers itself; see `forestFloorBlend`.
   */
  drawGround?: boolean
}

export class FoliageSystem {
  readonly group = new Group()
  readonly mask: FoliageMaskField
  /** Ground the cover stands on. Flat until a terrain fills it in. */
  readonly ground3d = new FoliageGroundHeightField()
  readonly rings: FoliageRing[]
  readonly bladeMaterial: MeshStandardNodeMaterial
  readonly groundMaterial: MeshPhysicalNodeMaterial
  readonly ground: Mesh
  readonly debris: FoliageDebrisField

  private readonly groundGeometry: PlaneGeometry
  private pendingSeed: FoliagePaintStroke[] = []
  private seededRecipe: string | null = null
  private populationDirty = true
  private density = Number.NaN
  private readonly populationCameraWorld = new Matrix4()
  private readonly populationProjection = new Matrix4()
  private hasPopulationView = false
  private disposed = false

  constructor(options: FoliageSystemOptions) {
    const groundTextures: FoliageGroundTextures = options
    this.mask = new FoliageMaskField(options.fieldSize ?? FOLIAGE_FIELD_SIZE)
    const instances = createFoliageInstanceBuffer()
    this.bladeMaterial = createFoliageBladeMaterial(
      createFoliageInstanceReader(instances),
    )
    this.rings = createFoliageRings(
      this.mask,
      instances,
      this.bladeMaterial,
      this.ground3d,
    )

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

    this.debris = createFoliageDebris(this.mask, this.ground3d)

    this.ground.visible = options.drawGround !== false
    this.group.name = 'ground-foliage'
    this.group.add(this.ground)
    for (const ring of this.rings) this.group.add(ring.mesh)
    for (const mesh of this.debris.meshes) this.group.add(mesh)
  }

  setDensity(value: number): void {
    const next = Math.min(Math.max(value, 0), 1)
    if (next !== this.density) {
      this.density = next
      this.populationDirty = true
    }
    foliageDensity.value = next
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
    this.populationDirty = true
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
    this.populationDirty = true
    this.pendingSeed = this.pendingSeed.slice(batch)
  }

  /**
   * Forces the next update to re-derive every clump.
   *
   * Painting and filling do this themselves. The terrain window needs it
   * separately because it writes the mask through `mask.paintRegion`, which is
   * the mask's own business and not the system's.
   */
  markPopulationDirty(): void {
    this.populationDirty = true
  }

  paint(renderer: Renderer, stroke: FoliagePaintStroke): void {
    this.mask.paint(renderer, stroke)
    this.populationDirty = true
  }

  fill(
    renderer: Renderer,
    species: number,
    mode: FoliagePaintMode,
    layer: FoliagePaintLayer = 'plants',
  ): void {
    this.mask.fill(renderer, species, mode, layer)
    this.populationDirty = true
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
    const viewChanged = !this.hasPopulationView ||
      !this.populationCameraWorld.equals(camera.matrixWorld) ||
      !this.populationProjection.equals(camera.projectionMatrix)
    if (!this.populationDirty && !viewChanged) return

    runFoliagePopulation(renderer, this.rings)
    runFoliageDebris(renderer, this.debris)
    this.populationCameraWorld.copy(camera.matrixWorld)
    this.populationProjection.copy(camera.projectionMatrix)
    this.hasPopulationView = true
    this.populationDirty = false
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
