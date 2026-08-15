import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardNodeMaterial,
  Raycaster,
  Vector3,
} from 'three/webgpu'
import { clamp, smoothstep } from '../core/bounds'
import type { CompiledSection, SectionId } from '../core/types'
import type { TerrainOverlay } from '../editor/EditorStore'
import type { TerrainSection } from '../partition/MeshPartition'
import type {
  PreviewBrush,
  TerrainRaycastHit,
  TerrainRenderBackend,
  TerrainRenderStats,
} from './TerrainRenderBackend'

interface RuntimeSection {
  section: TerrainSection
  mesh: Mesh
  geometries: BufferGeometry[]
  boundary: LineSegments
  gpuBytes: number
  lod: number
  visible: boolean
}

const LOD_COLORS = [0x59dca9, 0x89c95a, 0xe5c65f, 0xe58d52, 0xd95f69]

export class ThreeTerrainRenderBackend implements TerrainRenderBackend {
  private readonly root: Group
  private readonly sectionSize: number
  private runtime = new Map<SectionId, RuntimeSection>()
  private deferredDisposals: BufferGeometry[] = []
  private overlay: TerrainOverlay = 'sections'
  private readonly terrainMaterial: MeshStandardNodeMaterial
  private readonly lodMaterials: MeshStandardNodeMaterial[]
  private readonly densityMaterial: MeshStandardNodeMaterial
  private readonly boundaryMaterials = {
    clean: new LineBasicMaterial({ color: 0x7c9688, transparent: true, opacity: 0.32 }),
    dirty: new LineBasicMaterial({ color: 0xffae57, transparent: true, opacity: 0.9 }),
    building: new LineBasicMaterial({ color: 0x64d8ff, transparent: true, opacity: 0.95 }),
    failed: new LineBasicMaterial({ color: 0xff5d68, transparent: true, opacity: 1 }),
  }
  private readonly scratchPoint = new Vector3()

  constructor(root: Group, sectionSize: number) {
    this.root = root
    this.sectionSize = sectionSize
    this.terrainMaterial = new MeshStandardNodeMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
      side: DoubleSide,
    })
    this.lodMaterials = LOD_COLORS.map(
      (color) =>
        new MeshStandardNodeMaterial({
          color,
          roughness: 0.92,
          metalness: 0,
          side: DoubleSide,
        }),
    )
    this.densityMaterial = new MeshStandardNodeMaterial({
      color: 0x70d2b0,
      roughness: 0.9,
      wireframe: true,
      side: DoubleSide,
    })
  }

  upload(section: TerrainSection, compiled: CompiledSection): number {
    const geometries = compiled.lods.map(createGeometry)
    let runtime = this.runtime.get(section.id)
    if (runtime) {
      this.deferredDisposals.push(...runtime.geometries)
      runtime.geometries = geometries
      runtime.gpuBytes = compiled.cpuBytes
      runtime.section = section
      runtime.lod = Math.min(runtime.lod, geometries.length - 1)
      runtime.mesh.geometry = geometries[runtime.lod]
      this.updateBoundary(runtime, compiled)
    } else {
      const mesh = new Mesh(geometries[section.activeLod] ?? geometries.at(-1), this.terrainMaterial)
      mesh.position.set(
        section.key.x * this.sectionSize,
        0,
        section.key.z * this.sectionSize,
      )
      mesh.castShadow = false
      mesh.receiveShadow = true
      mesh.frustumCulled = true
      mesh.userData.terrainSectionId = section.id
      mesh.name = `terrain-section-${section.id}`
      const boundary = createBoundary(
        section,
        compiled,
        this.boundaryMaterials.clean,
      )
      this.root.add(mesh, boundary)
      runtime = {
        section,
        mesh,
        geometries,
        boundary,
        gpuBytes: compiled.cpuBytes,
        lod: Math.min(section.activeLod, geometries.length - 1),
        visible: true,
      }
      this.runtime.set(section.id, runtime)
    }
    this.applyMaterial(runtime)
    this.setSectionState(section)
    return compiled.cpuBytes
  }

  has(sectionId: SectionId): boolean {
    return this.runtime.has(sectionId)
  }

  setLod(sectionId: SectionId, lod: number): void {
    const runtime = this.runtime.get(sectionId)
    if (!runtime) return
    const next = clamp(Math.round(lod), 0, runtime.geometries.length - 1)
    if (next === runtime.lod) return
    runtime.lod = next
    runtime.section.activeLod = next
    runtime.mesh.geometry = runtime.geometries[next]
    this.applyMaterial(runtime)
  }

  setVisible(sectionId: SectionId, visible: boolean): void {
    const runtime = this.runtime.get(sectionId)
    if (!runtime || runtime.visible === visible) return
    runtime.visible = visible
    runtime.mesh.visible = visible
    runtime.boundary.visible = visible && this.overlay !== 'none'
  }

  setSectionState(section: TerrainSection): void {
    const runtime = this.runtime.get(section.id)
    if (!runtime) return
    if (section.buildState === 'failed') {
      runtime.boundary.material = this.boundaryMaterials.failed
    } else if (section.buildState === 'building') {
      runtime.boundary.material = this.boundaryMaterials.building
    } else if (section.dirtyRegion) {
      runtime.boundary.material = this.boundaryMaterials.dirty
    } else {
      runtime.boundary.material = this.boundaryMaterials.clean
    }
    runtime.boundary.visible = runtime.visible && this.overlay !== 'none'
  }

  setOverlay(overlay: TerrainOverlay): void {
    if (this.overlay === overlay) return
    this.overlay = overlay
    for (const runtime of this.runtime.values()) {
      this.applyMaterial(runtime)
      runtime.boundary.visible = runtime.visible && overlay !== 'none'
    }
  }

  previewBrush(preview: PreviewBrush): void {
    const radiusSquared = preview.radius * preview.radius
    for (const runtime of this.runtime.values()) {
      if (!runtime.visible) continue
      const minX = runtime.section.key.x * this.sectionSize
      const minZ = runtime.section.key.z * this.sectionSize
      if (
        preview.point.x + preview.radius < minX ||
        preview.point.x - preview.radius > minX + this.sectionSize ||
        preview.point.z + preview.radius < minZ ||
        preview.point.z - preview.radius > minZ + this.sectionSize
      ) {
        continue
      }
      const geometry = runtime.mesh.geometry
      const attribute = geometry.getAttribute('position') as BufferAttribute
      const array = attribute.array as Float32Array
      for (let offset = 0; offset < array.length; offset += 3) {
        const worldX = minX + array[offset]
        const worldZ = minZ + array[offset + 2]
        const dx = worldX - preview.point.x
        const dz = worldZ - preview.point.z
        const distanceSquared = dx * dx + dz * dz
        if (distanceSquared >= radiusSquared) continue
        const radial = 1 - Math.sqrt(distanceSquared) / preview.radius
        const weight =
          smoothstep(0, 1, radial) ** (0.55 + preview.falloff * 2.4) *
          preview.strength
        switch (preview.mode) {
          case 'raise':
            array[offset + 1] += weight * 2.8
            break
          case 'lower':
            array[offset + 1] -= weight * 2.8
            break
          case 'flatten':
            array[offset + 1] +=
              ((preview.targetY ?? preview.point.y) - array[offset + 1]) * weight * 0.48
            break
          case 'smooth':
            array[offset + 1] += (preview.point.y - array[offset + 1]) * weight * 0.12
            break
        }
      }
      attribute.needsUpdate = true
    }
  }

  raycast(raycaster: Raycaster): TerrainRaycastHit | undefined {
    const hits = raycaster.intersectObject(this.root, true)
    for (const hit of hits) {
      const id = hit.object.userData.terrainSectionId as SectionId | undefined
      if (!id) continue
      this.scratchPoint.copy(hit.point)
      return { point: this.scratchPoint.clone(), sectionId: id }
    }
    return undefined
  }

  flushDeferredDisposals(maxCount: number): void {
    for (let index = 0; index < maxCount; index += 1) {
      const geometry = this.deferredDisposals.shift()
      if (!geometry) break
      geometry.dispose()
    }
  }

  evict(sectionId: SectionId): void {
    const runtime = this.runtime.get(sectionId)
    if (!runtime) return
    this.root.remove(runtime.mesh, runtime.boundary)
    this.deferredDisposals.push(...runtime.geometries, runtime.boundary.geometry)
    this.runtime.delete(sectionId)
  }

  stats(): TerrainRenderStats {
    const trianglesByLod = [0, 0, 0, 0, 0]
    let gpuBytes = 0
    let visibleSections = 0
    let triangles = 0
    for (const runtime of this.runtime.values()) {
      gpuBytes += runtime.gpuBytes
      if (!runtime.visible) continue
      visibleSections += 1
      const count = runtime.mesh.geometry.getIndex()?.count ?? 0
      const sectionTriangles = count / 3
      triangles += sectionTriangles
      trianglesByLod[runtime.lod] =
        (trianglesByLod[runtime.lod] ?? 0) + sectionTriangles
    }
    return {
      gpuBytes,
      residentSections: this.runtime.size,
      visibleSections,
      triangles,
      trianglesByLod,
    }
  }

  dispose(): void {
    for (const id of [...this.runtime.keys()]) this.evict(id)
    this.flushDeferredDisposals(Infinity)
    this.terrainMaterial.dispose()
    this.densityMaterial.dispose()
    for (const material of this.lodMaterials) material.dispose()
    for (const material of Object.values(this.boundaryMaterials)) material.dispose()
  }

  private applyMaterial(runtime: RuntimeSection): void {
    if (this.overlay === 'lod') runtime.mesh.material = this.lodMaterials[runtime.lod]
    else if (this.overlay === 'density') runtime.mesh.material = this.densityMaterial
    else runtime.mesh.material = this.terrainMaterial
  }

  private updateBoundary(runtime: RuntimeSection, compiled: CompiledSection): void {
    this.deferredDisposals.push(runtime.boundary.geometry)
    runtime.boundary.geometry = createBoundaryGeometry(runtime.section, compiled)
  }
}

function createGeometry(lod: CompiledSection['lods'][number]): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(lod.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(lod.normals, 3))
  geometry.setAttribute('color', new BufferAttribute(lod.colors, 3))
  geometry.setIndex(new BufferAttribute(lod.indices, 1))
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

function createBoundary(
  section: TerrainSection,
  compiled: CompiledSection,
  material: LineBasicMaterial,
): LineSegments {
  const line = new LineSegments(
    createBoundaryGeometry(section, compiled),
    material,
  )
  line.position.set(
    section.key.x * (compiled.bounds.max.x - compiled.bounds.min.x),
    0,
    section.key.z * (compiled.bounds.max.z - compiled.bounds.min.z),
  )
  line.frustumCulled = true
  line.name = `section-boundary-${section.id}`
  return line
}

function createBoundaryGeometry(
  section: TerrainSection,
  compiled: CompiledSection,
): BufferGeometry {
  const size = compiled.bounds.max.x - compiled.bounds.min.x
  const y = compiled.bounds.max.y + 1.4
  const positions = new Float32Array([
    0, y, 0, size, y, 0,
    size, y, 0, size, y, size,
    size, y, size, 0, y, size,
    0, y, size, 0, y, 0,
  ])
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.computeBoundingSphere()
  geometry.userData.sectionId = section.id
  return geometry
}
