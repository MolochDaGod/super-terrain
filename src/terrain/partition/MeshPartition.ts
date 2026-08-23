import { expandBounds, sectionBounds, sectionId, unionBounds, worldToSection } from '../core/bounds'
import { terrainAssert } from '../core/assert'
import type {
  AABB,
  BuildState,
  CompiledSection,
  ResidencyState,
  SectionId,
  SectionKey,
} from '../core/types'
import { EditableMesh, EditableMeshSection } from '../mesh/EditableMesh'
import { validateMeshData } from '../mesh/MeshValidation'

export interface TerrainSection {
  key: SectionKey
  id: SectionId
  source: EditableMeshSection
  revision: number
  bounds: AABB
  dirtyRegion?: AABB
  dirtySince: number
  buildState: BuildState
  residency: ResidencyState
  compiled?: CompiledSection
  pendingCompiled?: CompiledSection
  lastTouched: number
  activeLod: number
  requestedLod: number
  buildJobId?: number
  buildingRevision?: number
  /** When the current worker job was handed to the pool. See `sweepStuckBuilds`. */
  buildStartedAt?: number
  /** Finest global LOD level requested by the current worker job. */
  buildingLod?: number
  error?: string
}

export interface MeshPartitionOptions {
  sectionSize: number
  worldSize: number
  seed: number
}

export class MeshPartition {
  readonly sections = new Map<SectionId, TerrainSection>()
  readonly minSection: number
  readonly maxSection: number
  readonly options: MeshPartitionOptions

  constructor(options: MeshPartitionOptions) {
    this.options = options
    const half = options.worldSize / 2
    this.minSection = Math.floor(-half / options.sectionSize)
    this.maxSection = Math.ceil(half / options.sectionSize) - 1
  }

  isInsideWorld(key: SectionKey): boolean {
    return (
      key.x >= this.minSection &&
      key.x <= this.maxSection &&
      key.z >= this.minSection &&
      key.z <= this.maxSection
    )
  }

  get(key: SectionKey): TerrainSection | undefined {
    return this.sections.get(sectionId(key))
  }

  getOrCreate(key: SectionKey, now = performance.now()): TerrainSection {
    terrainAssert(this.isInsideWorld(key), `Section ${sectionId(key)} is outside the world`)
    const id = sectionId(key)
    const existing = this.sections.get(id)
    if (existing) {
      existing.lastTouched = now
      return existing
    }

    const section: TerrainSection = {
      key: { ...key },
      id,
      source: new EditableMeshSection(this.options.seed),
      revision: 0,
      bounds: sectionBounds(key, this.options.sectionSize),
      dirtySince: now,
      buildState: 'queued',
      residency: 'SOURCE_RESIDENT',
      lastTouched: now,
      activeLod: 4,
      requestedLod: 4,
    }
    this.sections.set(id, section)
    return section
  }

  /** Takes ownership of a section-local authoritative mesh and invalidates output. */
  replaceSourceMesh(
    key: SectionKey,
    mesh: EditableMesh,
    now = performance.now(),
  ): TerrainSection {
    assertMeshInsideSection(mesh, this.options.sectionSize)
    const section = this.getOrCreate(key, now)
    this.markDirty(section, section.bounds, now)
    section.source.replaceMesh(mesh, section.revision)
    return section
  }

  restoreProceduralSource(
    key: SectionKey,
    now = performance.now(),
  ): TerrainSection {
    const section = this.getOrCreate(key, now)
    this.markDirty(section, section.bounds, now)
    section.source.restoreProcedural(section.revision)
    return section
  }

  get editableMeshBytes(): number {
    let bytes = 0
    for (const section of this.sections.values()) bytes += section.source.byteLength
    return bytes
  }

  invalidateBounds(bounds: AABB, halo: number, now = performance.now()): TerrainSection[] {
    const dirtyBounds = expandBounds(bounds, halo)
    const min = worldToSection(dirtyBounds.min.x, dirtyBounds.min.z, this.options.sectionSize)
    const max = worldToSection(dirtyBounds.max.x, dirtyBounds.max.z, this.options.sectionSize)
    const invalidated: TerrainSection[] = []

    for (let z = Math.max(min.z, this.minSection); z <= Math.min(max.z, this.maxSection); z += 1) {
      for (let x = Math.max(min.x, this.minSection); x <= Math.min(max.x, this.maxSection); x += 1) {
        const section = this.getOrCreate({ x, z }, now)
        this.markDirty(section, dirtyBounds, now)
        invalidated.push(section)
      }
    }
    return invalidated
  }

  markDirty(section: TerrainSection, dirtyBounds: AABB, now = performance.now()): void {
    const previousRevision = section.revision
    section.revision += 1
    terrainAssert(section.revision > previousRevision, 'Section revision must be monotonic')
    section.dirtyRegion = unionBounds(section.dirtyRegion, dirtyBounds)
    section.dirtySince = now
    section.buildState = section.buildState === 'building' ? 'building' : 'queued'
    section.error = undefined
  }

  markBuilding(
    section: TerrainSection,
    jobId: number,
    minimumLod = 0,
    now = performance.now(),
  ): void {
    terrainAssert(
      section.buildJobId !== jobId,
      `Duplicate build ${jobId} for section ${section.id}`,
    )
    section.buildStartedAt = now
    section.buildJobId = jobId
    section.buildingRevision = section.revision
    section.buildingLod = minimumLod
    section.buildState = 'building'
  }

  acceptCompiled(section: TerrainSection, compiled: CompiledSection): boolean {
    if (compiled.sourceRevision !== section.revision) return false
    section.pendingCompiled = compiled
    section.buildState = 'ready'
    section.buildJobId = undefined
    section.buildingRevision = undefined
    section.buildingLod = undefined
    return true
  }

  commitPending(section: TerrainSection): CompiledSection | undefined {
    const next = section.pendingCompiled
    if (!next || next.sourceRevision !== section.revision) return undefined
    section.compiled = next
    section.pendingCompiled = undefined
    section.dirtyRegion = undefined
    section.buildState = 'clean'
    section.residency = 'COMPILED_CPU'
    return next
  }

  remove(key: SectionKey): TerrainSection | undefined {
    const id = sectionId(key)
    const section = this.sections.get(id)
    this.sections.delete(id)
    return section
  }

  values(): IterableIterator<TerrainSection> {
    return this.sections.values()
  }
}

function assertMeshInsideSection(mesh: EditableMesh, sectionSize: number): void {
  const epsilon = Math.max(1e-4, sectionSize * 1e-5)
  for (let offset = 0; offset < mesh.positions.length; offset += 3) {
    const x = mesh.positions[offset]
    const z = mesh.positions[offset + 2]
    if (
      x < -epsilon ||
      x > sectionSize + epsilon ||
      z < -epsilon ||
      z > sectionSize + epsilon
    ) {
      throw new Error(
        `Editable source vertex ${offset / 3} lies outside its section-local X/Z bounds`,
      )
    }
  }
  const validation = validateMeshData(mesh.positions, mesh.triangles, {
    boundaryMode: mesh.boundaryMode,
    sectionSize,
    rejectDegenerateTriangles: true,
  })
  if (!validation.valid) {
    throw new Error(`Invalid editable section source: ${validation.errors.join('; ')}`)
  }
}
