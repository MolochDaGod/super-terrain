import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three/webgpu'
import {
  createScatterRockMaterial,
  type ScatterRockMaterialHandle,
} from './createScatterRockMaterial'
import { createScatterRockMesh, scatterRockSeed } from './scatterRockMesh'
import {
  SCATTER_ROCK_BANDS,
  placeScatterRockBand,
  scatterRockVariants,
  type ScatterRockBand,
  type ScatterRockSurface,
} from './scatterRockField'

/**
 * The loose rock lying on the terrain, as drawn geometry.
 *
 * One `InstancedMesh` per band per variant — sixteen draws in all, each with
 * its own baked mesh — and a single shared material. That layout is chosen
 * over one mesh per band with a per-instance variant index because instancing
 * cannot switch geometry per instance: the alternative is either a merged
 * super-mesh with a wasted vertex budget on every small rock, or sixteen small
 * draws. Sixteen draws is nothing next to what the terrain sections already
 * submit.
 *
 * Placement is rebuilt only when the camera leaves the window it was built
 * for. Everything about how the field is composed lives in `scatterRockField`;
 * this owns the GPU objects and the rebuild policy and nothing else.
 */

/**
 * How far the camera may travel before the field is rebuilt.
 *
 * A rebuild costs a few milliseconds of height sampling, so it must not run
 * every frame; but the field is anchored to a world lattice rather than to the
 * camera, so a rebuild only ever *adds and removes* rocks at the boundary and
 * never moves one that stays. That makes the threshold a pure cost knob rather
 * than a quality one. A sixth of the widest band's range keeps the boundary
 * well outside the range at which a rock appearing there would be noticed.
 */
const REBUILD_DISTANCE = 11

/** Baked once per band; every instance of a band shares these four meshes. */
interface BandMeshes {
  band: ScatterRockBand
  geometries: BufferGeometry[]
}

export interface TerrainRockFieldOptions {
  seed: number
  /** Instance ceiling per band-variant. Placement is clamped to it. */
  capacity?: number
}

export class TerrainRockField {
  readonly group = new Group()

  private readonly bands: BandMeshes[] = []
  private readonly meshes: InstancedMesh[][] = []
  private readonly materialHandle: ScatterRockMaterialHandle
  private readonly seed: number
  private readonly capacity: number

  private centreX = Number.NaN
  private centreZ = Number.NaN

  private readonly matrix = new Matrix4()
  private readonly quaternion = new Quaternion()
  private readonly bedding = new Quaternion()
  private readonly yawAxis = new Vector3(0, 1, 0)
  private readonly up = new Vector3(0, 1, 0)
  private readonly normal = new Vector3()
  private readonly scale = new Vector3()
  private readonly translation = new Vector3()

  constructor(options: TerrainRockFieldOptions) {
    this.seed = options.seed
    this.capacity = options.capacity ?? 1_400
    this.materialHandle = createScatterRockMaterial()
    this.group.name = 'terrain-rock-scatter'
    // Placed by the terrain's own height function, so they are already exactly
    // on the ground; nothing here needs the frustum culling that would
    // otherwise fight the instanced bounding sphere.
    this.group.matrixAutoUpdate = false

    for (const band of SCATTER_ROCK_BANDS) {
      const geometries: BufferGeometry[] = []
      const bandMeshes: InstancedMesh[] = []
      const variantCount = scatterRockVariants(band)
      for (let variant = 0; variant < variantCount; variant += 1) {
        const rock = createScatterRockMesh({
          // Every band gets its own family of shapes rather than the same four
          // rescaled. A five-metre boulder and a fifteen-centimetre clast that
          // are the same object at different sizes is a tell the eye picks up
          // immediately, and the fix costs only a different seed.
          seed: scatterRockSeed(
            this.seed * 7919 + band.cell * 131 + variant * 17,
          ),
          subdivisions: band.subdivisions,
        })
        const geometry = new BufferGeometry()
        geometry.setAttribute(
          'position',
          new BufferAttribute(rock.positions, 3),
        )
        geometry.setAttribute('normal', new BufferAttribute(rock.normals, 3))
        geometry.computeBoundingSphere()
        geometries.push(geometry)

        // A band's ceiling scales with how many slots it can possibly fill.
        // One flat capacity means the outcrop band, which places tens, holds
        // the same instance buffer as the clast band, which places hundreds.
        const capacity = Math.max(
          24,
          Math.ceil(this.capacity / Math.max(1, variantCount)),
        )
        const mesh = new InstancedMesh(
          geometry,
          this.materialHandle.material,
          capacity,
        )
        mesh.name = `terrain-rock-${band.name}-${variant}`
        mesh.count = 0
        mesh.castShadow = true
        mesh.receiveShadow = true
        // The instance matrices carry world positions, so the mesh's own
        // bounds are meaningless and three's automatic sphere would cull the
        // whole band as soon as the camera left the origin.
        mesh.frustumCulled = false
        bandMeshes.push(mesh)
        this.group.add(mesh)
      }
      this.bands.push({ band, geometries })
      this.meshes.push(bandMeshes)
    }
  }

  /** Resolves once the shared rock bake has landed. */
  get ready(): Promise<void> {
    return this.materialHandle.ready
  }

  /**
   * Rebuilds the field if the camera has left the window it was built for.
   * Returns whether it did, so a caller can report the cost.
   */
  update(
    cameraX: number,
    cameraZ: number,
    surface: ScatterRockSurface,
  ): boolean {
    const moved =
      Number.isNaN(this.centreX) ||
      Math.hypot(cameraX - this.centreX, cameraZ - this.centreZ) >
        REBUILD_DISTANCE
    if (!moved) return false
    this.rebuild(cameraX, cameraZ, surface)
    return true
  }

  /** Rebuilds unconditionally; used when the terrain itself has changed. */
  rebuild(cameraX: number, cameraZ: number, surface: ScatterRockSurface): void {
    this.centreX = cameraX
    this.centreZ = cameraZ

    for (let index = 0; index < this.bands.length; index += 1) {
      const { band } = this.bands[index]!
      const bandMeshes = this.meshes[index]!
      const instances = placeScatterRockBand(
        band,
        cameraX,
        cameraZ,
        surface,
        this.seed,
      )
      const variantCount = scatterRockVariants(band)
      const counts = new Array<number>(variantCount).fill(0)

      for (const instance of instances) {
        const mesh = bandMeshes[instance.variant]!
        const slot = counts[instance.variant]!
        if (slot >= mesh.instanceMatrix.count) continue

        // Bedded against the surface, then spun about its own new up. Doing
        // the yaw *after* the bedding rotation rather than before is what
        // keeps a rock's long axis lying along the slope instead of pointing
        // out of it on steep ground.
        this.normal.set(instance.normalX, instance.normalY, instance.normalZ)
        // Only part-way to the surface normal. A boulder resting on a
        // thirty-degree slope does not tilt thirty degrees — it settles into
        // the ground until it finds a stable seat, which is most of the way
        // back to upright. Fully aligning them is what makes a scattered field
        // look combed.
        this.normal.lerp(this.up, 0.45).normalize()
        this.bedding.setFromUnitVectors(this.up, this.normal)
        this.quaternion.setFromAxisAngle(this.yawAxis, instance.yaw)
        this.quaternion.premultiply(this.bedding)

        this.translation.set(instance.x, instance.y, instance.z)
        this.scale.setScalar(instance.scale)
        this.matrix.compose(this.translation, this.quaternion, this.scale)
        mesh.setMatrixAt(slot, this.matrix)
        counts[instance.variant] = slot + 1
      }

      for (let variant = 0; variant < variantCount; variant += 1) {
        const mesh = bandMeshes[variant]!
        mesh.count = counts[variant]!
        mesh.instanceMatrix.needsUpdate = true
      }
    }
  }

  /** Total instances currently drawn, for the metrics overlay. */
  get instanceCount(): number {
    let total = 0
    for (const bandMeshes of this.meshes) {
      for (const mesh of bandMeshes) total += mesh.count
    }
    return total
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  dispose(): void {
    for (const bandMeshes of this.meshes) {
      for (const mesh of bandMeshes) {
        mesh.dispose()
        this.group.remove(mesh)
      }
    }
    for (const { geometries } of this.bands) {
      for (const geometry of geometries) geometry.dispose()
    }
    this.materialHandle.dispose()
  }
}
