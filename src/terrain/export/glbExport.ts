/**
 * GLB export for terrain/island suitable for ObjectStore grudge-convert ingestion.
 * 
 * Exports current island/terrain mesh as glTF 2.0 binary.
 * Does NOT upload to R2, does NOT hit assets.grudge-studio.com/_purge,
 * does NOT register map-registry. New islands stay unpublished until
 * Kiln writes and Rook shows 200 glTF.
 */

import type { WorldTerrain } from '../WorldTerrain'
import type { EditorLight } from '../editor/lights'
import { expandBounds, intersects, sectionBounds } from '../core/bounds'
import type { SectionKey } from '../core/types'
import { compileTerrainSection } from '../compiler/compileSection'
import { encodeModifiers } from '../workers/protocol'
import { addSectionSkirts } from '../rendering/addSectionSkirts'
import { createWaterSurface } from '../rendering/water/createWaterSurface'
import type { TerrainModifier } from '../modifiers/types'
import { generateGraniteRock } from '../rocks/generateGraniteRock'
import type { GraniteRockTransform } from '../rocks/types'

const encoder = new TextEncoder()
const GL_ARRAY_BUFFER = 34_962
const GL_ELEMENT_ARRAY_BUFFER = 34_963
const FLOAT = 5_126
const UNSIGNED_INT = 5_125

export interface GlbExportProgress {
  stage: 'terrain' | 'assets' | 'package'
  completed: number
  total: number
  message: string
}

export interface GlbExportResult {
  data: Uint8Array
  fileName: string
  triangleCount: number
}

interface ExportMesh {
  name: string
  kind: 'terrain' | 'rock' | 'water'
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  indices: Uint32Array
  translation?: readonly [number, number, number]
  matrix?: readonly number[]
  extras?: Record<string, unknown>
}

/**
 * Export terrain and assets as GLB for fleet ingestion.
 * Similar to Godot export but outputs only the GLB mesh data.
 */
export async function exportTerrainGlb(options: {
  terrain: WorldTerrain
  lights?: readonly EditorLight[]
  onProgress?: (progress: GlbExportProgress) => void
}): Promise<GlbExportResult> {
  const { terrain, onProgress } = options
  const modifierRevision = terrain.modifiers.sourceRevision
  const rockRevision = terrain.rocks.sourceRevision
  const waterRevision = terrain.water.getSnapshot().revision
  const modifiers = terrain.modifiers.snapshot()
  const rocks = terrain.rocks.snapshot()
  const lights = (options.lights ?? []).map((light) => structuredClone(light))
  const meshes: ExportMesh[] = []
  const width = terrain.partition.maxSection - terrain.partition.minSection + 1
  const patchTotal = width * width
  let patchIndex = 0

  // Export all terrain sections at their best LOD
  for (let z = terrain.partition.minSection; z <= terrain.partition.maxSection; z += 1) {
    for (let x = terrain.partition.minSection; x <= terrain.partition.maxSection; x += 1) {
      const key = { x, z }
      const section = terrain.partition.getOrCreate(key)
      const lastLod = terrain.config.lodResolutions.length - 1
      const desiredLod = section.dirtyRegion
        ? 0
        : clampLod(section.activeLod ?? section.requestedLod, lastLod)
      const current = newestCompiledLod(section, desiredLod)
      const lod = current ?? compileTerrainSection({
        kind: 'compile-section',
        jobId: -1,
        key,
        revision: section.revision,
        priority: 0,
        config: terrain.config,
        levels: [desiredLod],
        source: section.source.createCompileSnapshot(
          key,
          terrain.config.sectionSize,
          {
            minSection: terrain.partition.minSection,
            maxSection: terrain.partition.maxSection,
          },
        ),
        modifiers: encodeModifiers(modifiersForSection(
          modifiers,
          key,
          terrain.config.sectionSize,
          terrain.config.operationHalo,
        )),
      }).lods[0]
      
      const geometry = addSectionSkirts(lod, terrain.config.sectionSize)
      
      meshes.push({
        name: `TerrainPatch_${signedName(x)}_${signedName(z)}`,
        kind: 'terrain',
        positions: geometry.positions,
        normals: geometry.normals,
        colors: new Float32Array(geometry.positions.length), // Placeholder colors
        indices: geometry.indices,
        translation: [
          x * terrain.config.sectionSize,
          0,
          z * terrain.config.sectionSize,
        ],
        extras: {
          meshterrain_kind: 'terrain_patch',
          section_x: x,
          section_z: z,
          lod: lod.level,
          source_revision: section.revision,
        },
      })
      
      patchIndex += 1
      if (patchIndex === patchTotal || patchIndex % 8 === 0) {
        onProgress?.({
          stage: 'terrain',
          completed: patchIndex,
          total: patchTotal,
          message: `Preparing terrain patches ${patchIndex}/${patchTotal}`,
        })
        await yieldToMainThread()
      }
    }
  }

  if (
    terrain.modifiers.sourceRevision !== modifierRevision ||
    terrain.rocks.sourceRevision !== rockRevision ||
    terrain.water.getSnapshot().revision !== waterRevision
  ) {
    throw new Error('The world changed during export. Retry once editing has stopped.')
  }

  onProgress?.({
    stage: 'assets',
    completed: 0,
    total: rocks.length + (terrain.water.hasWater ? 1 : 0),
    message: 'Preparing rocks and water',
  })
  
  // Export granite rocks
  for (const rock of rocks) {
    if (!rock.visible) continue
    const mesh = generateGraniteRock(rock.parameters)
    meshes.push({
      name: `Rock_${safeName(rock.name)}_${safeName(rock.id)}`,
      kind: 'rock',
      positions: mesh.positions,
      normals: mesh.normals,
      colors: mesh.colors,
      indices: mesh.indices,
      matrix: transformMatrix(rock.transform),
      extras: {
        meshterrain_kind: 'granite_rock',
        meshterrain_id: rock.id,
        parameters: rock.parameters,
      },
    })
  }
  
  // Export water surface
  const waterMesh = createExportWaterMesh(terrain)
  if (waterMesh) meshes.push(waterMesh)

  onProgress?.({
    stage: 'package',
    completed: 0,
    total: 1,
    message: 'Building GLB file',
  })
  
  const glb = createSceneGlb(meshes, lights)
  const triangleCount = meshes.reduce(
    (total, mesh) => total + mesh.indices.length / 3,
    0,
  )
  
  onProgress?.({
    stage: 'package',
    completed: 1,
    total: 1,
    message: 'GLB export complete',
  })
  
  return {
    data: glb,
    fileName: `terrain-${dateStamp(new Date())}.glb`,
    triangleCount,
  }
}

/**
 * Download GLB file to browser.
 */
export function downloadGlb(result: GlbExportResult): void {
  const blob = new Blob([result.data as BlobPart], { type: 'model/gltf-binary' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.fileName
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function newestCompiledLod(
  section: ReturnType<WorldTerrain['partition']['getOrCreate']>,
  level: number,
): ReturnType<typeof compileTerrainSection>['lods'][number] | undefined {
  for (const compiled of [section.pendingCompiled, section.compiled]) {
    if (compiled?.sourceRevision !== section.revision) continue
    const lod = compiled.lods.find((entry) => entry.level === level)
    if (lod) return lod
  }
  return undefined
}

function modifiersForSection(
  modifiers: readonly TerrainModifier[],
  key: SectionKey,
  sectionSize: number,
  halo: number,
): TerrainModifier[] {
  const bounds = expandBounds(sectionBounds(key, sectionSize), halo)
  return modifiers.filter((modifier) =>
    modifier.type === 'sculpt-layer' ||
    (
      modifier.enabled &&
      modifier.type !== 'material-settings' &&
      intersects(modifier.bounds, bounds)
    ),
  )
}

function createExportWaterMesh(terrain: WorldTerrain): ExportMesh | undefined {
  const region = terrain.water.bounds()
  const state = terrain.water.getSnapshot()
  if (!region || !state.enabled) return undefined
  
  const area = Math.max(1, region.max.x - region.min.x) *
    Math.max(1, region.max.z - region.min.z)
  const geometry = createWaterSurface({
    region,
    level: state.level,
    seed: terrain.config.seed,
    step: Math.max(3, Math.sqrt(area / 260_000)),
    coverage: (x, z) => terrain.water.sample(x, z),
  })
  
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  if (!index) {
    geometry.dispose()
    return undefined
  }
  
  const positions = Float32Array.from(position.array as ArrayLike<number>)
  const normals = new Float32Array(positions.length)
  const colors = new Float32Array(positions.length)
  
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    normals[vertex * 3 + 1] = 1
    colors[vertex * 3] = 0.125
    colors[vertex * 3 + 1] = 0.478
    colors[vertex * 3 + 2] = 0.578
  }
  
  const indices = Uint32Array.from(index.array as ArrayLike<number>)
  geometry.dispose()
  
  return {
    name: 'Water',
    kind: 'water',
    positions,
    normals,
    colors,
    indices,
    extras: {
      meshterrain_kind: 'water',
      level: state.level,
      turbidity: state.turbidity,
    },
  }
}

function createSceneGlb(
  meshes: readonly ExportMesh[],
  lights: readonly EditorLight[] = [],
): Uint8Array {
  const builder = new GlbBuilder()
  for (const mesh of meshes) builder.addMesh(mesh)
  builder.addDefaultSun()
  for (const light of lights) builder.addEditorLight(light)
  return builder.finish()
}

class GlbBuilder {
  private chunks: Uint8Array[] = []
  private binaryLength = 0
  private bufferViews: Record<string, unknown>[] = []
  private accessors: Record<string, unknown>[] = []
  private meshes: Record<string, unknown>[] = []
  private nodes: Record<string, unknown>[] = []
  private lights: Record<string, unknown>[] = []
  private readonly materials: Record<string, unknown>[] = [
    pbrMaterial('Terrain', 0.9),
    pbrMaterial('Granite', 0.86),
    pbrMaterial('Water', 0.2),
  ]

  addMesh(mesh: ExportMesh): void {
    const position = this.addAccessor(mesh.positions, GL_ARRAY_BUFFER, 'VEC3', true)
    const normal = this.addAccessor(mesh.normals, GL_ARRAY_BUFFER, 'VEC3')
    const color = this.addAccessor(mesh.colors, GL_ARRAY_BUFFER, 'VEC3')
    const indices = this.addAccessor(mesh.indices, GL_ELEMENT_ARRAY_BUFFER, 'SCALAR')
    
    const meshIndex = this.meshes.length
    this.meshes.push({
      name: mesh.name,
      primitives: [{
        attributes: {
          POSITION: position,
          NORMAL: normal,
          COLOR_0: color,
        },
        indices,
        material: mesh.kind === 'terrain' ? 0 : mesh.kind === 'rock' ? 1 : 2,
        mode: 4,
      }],
      extras: mesh.extras,
    })
    
    this.nodes.push({
      name: mesh.name,
      mesh: meshIndex,
      ...(mesh.translation ? { translation: mesh.translation } : {}),
      ...(mesh.matrix ? { matrix: mesh.matrix } : {}),
      extras: mesh.extras,
    })
  }

  addDefaultSun(): void {
    const elevation = (14 * Math.PI) / 180
    const azimuth = (142 * Math.PI) / 180
    const direction = {
      x: Math.cos(elevation) * Math.sin(azimuth),
      y: Math.sin(elevation),
      z: Math.cos(elevation) * Math.cos(azimuth),
    }
    
    const light = this.lights.length
    this.lights.push({
      name: 'MeshTerrain Sun',
      type: 'directional',
      color: [1, 0.816, 0.651],
      intensity: 1,
    })
    
    this.nodes.push({
      name: 'MeshTerrain Sun',
      rotation: quaternionFromMinusZ(direction),
      extensions: { KHR_lights_punctual: { light } },
    })
  }

  addEditorLight(source: EditorLight): void {
    if (!source.visible) return
    
    const light = this.lights.length
    const record: Record<string, unknown> = {
      name: source.name,
      type: source.type,
      color: hexColor(source.color),
      intensity: source.intensity,
      range: source.distance,
    }
    
    if (source.type === 'spot') {
      record.spot = {
        innerConeAngle: source.angle * (1 - source.penumbra),
        outerConeAngle: source.angle,
      }
    }
    
    this.lights.push(record)
    
    const node: Record<string, unknown> = {
      name: source.name,
      translation: [source.position.x, source.position.y, source.position.z],
      extensions: { KHR_lights_punctual: { light } },
      extras: { meshterrain_id: source.id, decay: source.decay },
    }
    
    if (source.type === 'spot') {
      node.rotation = quaternionFromMinusZ({
        x: source.target.x - source.position.x,
        y: source.target.y - source.position.y,
        z: source.target.z - source.position.z,
      })
    }
    
    this.nodes.push(node)
  }

  finish(): Uint8Array {
    const binary = new Uint8Array(align4(this.binaryLength))
    let cursor = 0
    for (const chunk of this.chunks) {
      binary.set(chunk, cursor)
      cursor = align4(cursor + chunk.length)
    }
    
    const document: Record<string, unknown> = {
      asset: { version: '2.0', generator: 'Mesh Terrain GLB Exporter' },
      extensionsUsed: ['KHR_lights_punctual'],
      extensions: { KHR_lights_punctual: { lights: this.lights } },
      scene: 0,
      scenes: [{ name: 'Mesh Terrain World', nodes: this.nodes.map((_, index) => index) }],
      nodes: this.nodes,
      meshes: this.meshes,
      materials: this.materials,
      accessors: this.accessors,
      bufferViews: this.bufferViews,
      buffers: [{ byteLength: binary.length }],
    }
    
    const jsonSource = encoder.encode(JSON.stringify(document))
    const jsonLength = align4(jsonSource.length)
    const total = 12 + 8 + jsonLength + 8 + binary.length
    const output = new Uint8Array(total)
    const view = new DataView(output.buffer)
    
    view.setUint32(0, 0x46546c67, true)
    view.setUint32(4, 2, true)
    view.setUint32(8, total, true)
    view.setUint32(12, jsonLength, true)
    view.setUint32(16, 0x4e4f534a, true)
    output.fill(0x20, 20, 20 + jsonLength)
    output.set(jsonSource, 20)
    
    const binaryHeader = 20 + jsonLength
    view.setUint32(binaryHeader, binary.length, true)
    view.setUint32(binaryHeader + 4, 0x004e4942, true)
    output.set(binary, binaryHeader + 8)
    
    return output
  }

  private addAccessor(
    values: Float32Array | Uint32Array,
    target: number,
    type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4',
    bounds = false,
  ): number {
    const source = new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
    const copy = source.slice()
    const byteOffset = this.binaryLength
    this.chunks.push(copy)
    this.binaryLength = align4(this.binaryLength + copy.length)
    
    const bufferView = this.bufferViews.length
    this.bufferViews.push({ buffer: 0, byteOffset, byteLength: copy.length, target })
    
    const accessor: Record<string, unknown> = {
      bufferView,
      componentType: values instanceof Float32Array ? FLOAT : UNSIGNED_INT,
      count: values.length / (
        type === 'VEC4' ? 4 : type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1
      ),
      type,
    }
    
    if (bounds && type === 'VEC3') {
      const { min, max } = vectorBounds(values as Float32Array)
      accessor.min = min
      accessor.max = max
    }
    
    const index = this.accessors.length
    this.accessors.push(accessor)
    return index
  }
}

function pbrMaterial(name: string, roughness: number): Record<string, unknown> {
  return {
    name,
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: 0,
      roughnessFactor: roughness,
    },
    doubleSided: true,
  }
}

function transformMatrix(transform: GraniteRockTransform): number[] {
  const { position, rotation, scale } = transform
  const sx = Math.sin(rotation.x)
  const cx = Math.cos(rotation.x)
  const sy = Math.sin(rotation.y)
  const cy = Math.cos(rotation.y)
  const sz = Math.sin(rotation.z)
  const cz = Math.cos(rotation.z)
  
  return [
    cy * cz * scale.x,
    cy * sz * scale.x,
    -sy * scale.x,
    0,
    (cz * sy * sx - sz * cx) * scale.y,
    (sz * sy * sx + cz * cx) * scale.y,
    cy * sx * scale.y,
    0,
    (cz * sy * cx + sz * sx) * scale.z,
    (sz * sy * cx - cz * sx) * scale.z,
    cy * cx * scale.z,
    0,
    position.x,
    position.y,
    position.z,
    1,
  ]
}

function quaternionFromMinusZ(direction: { x: number; y: number; z: number }): number[] {
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1
  const x = direction.x / length
  const y = direction.y / length
  const z = direction.z / length
  const w = 1 - z
  if (w < 1e-7) return [0, 1, 0, 0]
  const qx = y
  const qy = -x
  const quaternionLength = Math.hypot(qx, qy, w) || 1
  return [qx / quaternionLength, qy / quaternionLength, 0, w / quaternionLength]
}

function vectorBounds(values: Float32Array): {
  min: [number, number, number]
  max: [number, number, number]
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let offset = 0; offset < values.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], values[offset + axis])
      max[axis] = Math.max(max[axis], values[offset + axis])
    }
  }
  return { min, max }
}

function hexColor(value: string): [number, number, number] {
  const match = /^#?([\da-f]{6})$/i.exec(value)
  const color = match ? Number.parseInt(match[1], 16) : 0xffffff
  return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255]
}

function clampLod(value: number, last: number): number {
  return Math.max(0, Math.min(last, Number.isFinite(value) ? Math.round(value) : last))
}

function signedName(value: number): string {
  return value < 0 ? `n${Math.abs(value)}` : `p${value}`
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60)
}

function align4(value: number): number {
  return (value + 3) & ~3
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replaceAll(/[-:T]/g, '')
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
