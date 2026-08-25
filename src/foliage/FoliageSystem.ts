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
   * A starting meadow, so the workspace opens on ground rather than on gravel.
   *
   * Laid down as real brush strokes through the same kernel the toolbar uses,
   * which means the competition between species applies and the result is a
   * genuine mix — not a uniform field of one type with three others stamped
   * over it.
   */
  seed(renderer: Renderer): void {
    if (this.seeded || this.disposed) return
    this.seeded = true
    this.mask.fill(renderer, foliageSpeciesIndex('meadow-fescue'), 'paint')
    const scatter: [string, number, number, number, number][] = [
      ['tussock', -46, 28, 52, 0.55],
      ['tussock', 63, -71, 44, 0.5],
      ['dry-steppe', 78, 62, 66, 0.62],
      ['dry-steppe', -95, -40, 58, 0.5],
      ['wildflower', -18, -64, 40, 0.55],
      ['clover-mat', 24, 46, 34, 0.5],
      ['woodland-fern', -84, 88, 38, 0.6],
      ['sedge-reed', 108, -18, 30, 0.58],
      ['broadleaf-weed', 6, 96, 32, 0.45],
    ]
    for (const [species, x, z, radius, flow] of scatter) {
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
