import { expandBounds, intersects, sectionBounds } from '../core/bounds'
import type { CompiledLOD, SectionKey, Vec3Like } from '../core/types'
import type { EditorLight } from '../editor/lights'
import { compileTerrainSection } from '../compiler/compileSection'
import { encodeModifiers } from '../workers/protocol'
import { addSectionSkirts } from '../rendering/addSectionSkirts'
import { createWaterSurface } from '../rendering/water/createWaterSurface'
import type { TerrainMaterialSettings } from '../rendering/materialSettings'
import { createGeologyDetailTexture } from '../rendering/textures/createSurfaceDetailTextures'
import { getProceduralSurfaceTextures } from '../rendering/textures/proceduralSurfaceTextures'
import {
  BED_THICKNESS_MAX,
  BED_THICKNESS_MIN,
} from '../compiler/TerrainMaterialFields'
import { generateGraniteRock } from '../rocks/generateGraniteRock'
import type { GraniteRockTransform } from '../rocks/types'
import type { TerrainModifier } from '../modifiers/types'
import type { WorldTerrain } from '../WorldTerrain'
import { createZip, type ZipFile } from './zip'

const encoder = new TextEncoder()
const GL_ARRAY_BUFFER = 34_962
const GL_ELEMENT_ARRAY_BUFFER = 34_963
const FLOAT = 5_126
const UNSIGNED_INT = 5_125

export interface GodotExportProgress {
  stage: 'terrain' | 'assets' | 'package'
  completed: number
  total: number
  message: string
}

export interface GodotExportResult {
  archive: Uint8Array
  fileName: string
  patchCount: number
  triangleCount: number
}

interface ExportMesh {
  name: string
  kind: 'terrain' | 'rock' | 'water'
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  /** G/B scan coefficients; R is stored in COLOR_0 alpha. */
  materialCoefficients?: Float32Array
  /** Rocky and vegetation coverage used by broad material variation. */
  materialVariation?: Float32Array
  indices: Uint32Array
  translation?: readonly [number, number, number]
  matrix?: readonly number[]
  extras?: Record<string, unknown>
}

interface ExportPatchInfo {
  x: number
  z: number
  lod: number
  revision: number
  vertices: number
  triangles: number
}

export interface GodotProceduralMaterialPackage {
  files: readonly ZipFile[]
}

export async function exportGodotProject(options: {
  terrain: WorldTerrain
  lights?: readonly EditorLight[]
  onProgress?: (progress: GodotExportProgress) => void
}): Promise<GodotExportResult> {
  const { terrain, onProgress } = options
  const modifierRevision = terrain.modifiers.sourceRevision
  const rockRevision = terrain.rocks.sourceRevision
  const waterRevision = terrain.water.getSnapshot().revision
  const modifiers = terrain.modifiers.snapshot()
  const rocks = terrain.rocks.snapshot()
  const water = terrain.water.serialize()
  const materialSettings = terrain.getMaterialSettings()
  const lights = (options.lights ?? []).map((light) => structuredClone(light))
  const meshes: ExportMesh[] = []
  const patches: ExportPatchInfo[] = []
  const width = terrain.partition.maxSection - terrain.partition.minSection + 1
  const patchTotal = width * width
  let patchIndex = 0

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
      const materialBlend = bakeTerrainMaterialBlend(
        geometry.positions,
        geometry.normals,
        geometry.surfaceFields,
        geometry.paintWeights,
        materialSettings,
        x * terrain.config.sectionSize,
        z * terrain.config.sectionSize,
      )
      meshes.push({
        name: `TerrainPatch_${signedName(x)}_${signedName(z)}`,
        kind: 'terrain',
        positions: geometry.positions,
        normals: geometry.normals,
        colors: materialBlend.colors,
        materialCoefficients: materialBlend.coefficients,
        materialVariation: materialBlend.variations,
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
      patches.push({
        x,
        z,
        lod: lod.level,
        revision: section.revision,
        vertices: geometry.positions.length / 3,
        triangles: geometry.indices.length / 3,
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
    message: 'Preparing rocks, water, and lights',
  })
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
  const waterMesh = createExportWaterMesh(terrain)
  if (waterMesh) meshes.push(waterMesh)

  const proceduralMaterials = await createProceduralMaterialPackage(onProgress)

  onProgress?.({
    stage: 'package',
    completed: 0,
    total: 1,
    message: 'Writing Godot project',
  })
  const glb = createSceneGlb(meshes, lights)
  const triangleCount = meshes.reduce(
    (total, mesh) => total + mesh.indices.length / 3,
    0,
  )
  const sourceDocument = JSON.stringify({
    format: 'meshterrain-godot-source@1',
    exportedAt: new Date().toISOString(),
    coordinateSystem: 'right-handed, Y-up, metres',
    config: terrain.config,
    modifiers,
    rocks,
    water,
    lights,
    patches,
    authoritativeRuntimeAsset: 'res://assets/world.glb',
    note:
      'The GLB contains final mesh topology, including overhangs and caves that cannot be represented by a heightmap.',
  })
  const archive = createGodotArchive(glb, sourceDocument, {
    patchCount: patches.length,
    triangleCount,
    worldSize: terrain.config.worldSize,
  }, meshes.map(({ name, kind }) => ({ name, kind })), proceduralMaterials)
  onProgress?.({
    stage: 'package',
    completed: 1,
    total: 1,
    message: 'Godot project ready',
  })
  return {
    archive,
    fileName: `meshterrain-godot-${dateStamp(new Date())}.zip`,
    patchCount: patches.length,
    triangleCount,
  }
}

export function downloadGodotProject(result: GodotExportResult): void {
  const blob = new Blob([result.archive as BlobPart], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.fileName
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function createGodotArchive(
  glb: Uint8Array,
  sourceDocument: string,
  summary: { patchCount: number; triangleCount: number; worldSize: number },
  materialBindings: readonly Pick<ExportMesh, 'name' | 'kind'>[] = [],
  proceduralMaterials?: GodotProceduralMaterialPackage,
): Uint8Array {
  return createZip([
    { path: 'project.godot', data: PROJECT_GODOT },
    {
      path: 'world.tscn',
      data: worldScene(materialBindings, Boolean(proceduralMaterials)),
    },
    { path: 'assets/world.glb', data: glb },
    { path: 'source/meshterrain-world.json', data: sourceDocument },
    { path: 'scripts/meshterrain_world.gd', data: WORLD_SCRIPT },
    {
      path: 'README.md',
      data: readme(summary),
    },
    ...(proceduralMaterials?.files ?? []),
  ])
}

export function createSceneGlb(
  meshes: readonly ExportMesh[],
  lights: readonly EditorLight[] = [],
): Uint8Array {
  const builder = new GlbBuilder()
  for (const mesh of meshes) builder.addMesh(mesh)
  builder.addDefaultSun()
  for (const light of lights) builder.addEditorLight(light)
  return builder.finish()
}

function newestCompiledLod(
  section: ReturnType<WorldTerrain['partition']['getOrCreate']>,
  level: number,
): CompiledLOD | undefined {
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
  const depth = geometry.getAttribute('waterDepth')
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
    const amount = smoothstep(0.2, 9, Number(depth.array[vertex]))
    const shallow = [0.125, 0.478, 0.578]
    const deep = [0.006, 0.045, 0.084]
    const silt = [0.275, 0.468, 0.428]
    for (let channel = 0; channel < 3; channel += 1) {
      const body = mix(shallow[channel], deep[channel], amount)
      colors[vertex * 3 + channel] = mix(
        body,
        silt[channel],
        Math.min(1, state.turbidity * 0.6),
      )
    }
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

async function createProceduralMaterialPackage(
  onProgress?: (progress: GodotExportProgress) => void,
): Promise<GodotProceduralMaterialPackage | undefined> {
  // The production exporter runs in the editor page, where the same worker
  // used by the TSL material can finish the authoritative 1K bakes. Node-based
  // geometry tests deliberately keep this optional rather than fabricating
  // texture data that the application would never ship.
  if (typeof Worker === 'undefined' || typeof document === 'undefined') return undefined
  onProgress?.({
    stage: 'assets',
    completed: 0,
    total: 3,
    message: 'Baking procedural TSL material textures',
  })
  const ground = getProceduralSurfaceTextures('rock-ground')
  const cliff = getProceduralSurfaceTextures('cliff-side')
  await Promise.all([ground.ready, cliff.ready])
  onProgress?.({
    stage: 'assets',
    completed: 2,
    total: 3,
    message: 'Encoding procedural PBR maps for Godot',
  })
  const detail = createGeologyDetailTexture()
  const files: ZipFile[] = [
    { path: 'materials/terrain.gdshader', data: GODOT_TERRAIN_SHADER },
    ...surfaceTextureFiles('rock-ground', ground),
    ...surfaceTextureFiles('cliff-side', cliff),
    {
      path: 'assets/materials/geology-detail.tga',
      data: textureToTga(detail),
    },
  ]
  detail.dispose()
  onProgress?.({
    stage: 'assets',
    completed: 3,
    total: 3,
    message: 'Procedural TSL textures ready',
  })
  return { files }
}

function surfaceTextureFiles(
  id: 'rock-ground' | 'cliff-side',
  textures: ReturnType<typeof getProceduralSurfaceTextures>,
): ZipFile[] {
  // Height rides in the ARM alpha rather than in a map of its own; see
  // `packArm`. The Godot shader reads it from there too.
  return (['albedo', 'normal', 'arm'] as const).map((channel) => ({
    path: `assets/materials/${id}-${channel}.tga`,
    data: textureToTga(textures[channel]),
  }))
}

function textureToTga(texture: {
  image: unknown
}): Uint8Array {
  const image = texture.image as {
    data: ArrayLike<number>
    width: number
    height: number
  }
  return encodeTga(image.data, image.width, image.height)
}

/** Encodes an RGBA8 bake as an uncompressed, top-origin 32-bit TGA. */
export function encodeTga(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
): Uint8Array {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    rgba.length !== width * height * 4
  ) {
    throw new Error('Invalid RGBA dimensions for TGA export')
  }
  const output = new Uint8Array(18 + rgba.length)
  const view = new DataView(output.buffer)
  output[2] = 2
  view.setUint16(12, width, true)
  view.setUint16(14, height, true)
  output[16] = 32
  // Eight alpha bits and a top-left origin.
  output[17] = 0x28
  for (let source = 0, target = 18; source < rgba.length; source += 4, target += 4) {
    output[target] = Number(rgba[source + 2])
    output[target + 1] = Number(rgba[source + 1])
    output[target + 2] = Number(rgba[source])
    output[target + 3] = Number(rgba[source + 3])
  }
  return output
}

/**
 * Bakes the slowly varying half of createFullTerrainMaterial into vertices.
 *
 * That material is affine in its procedural scan colour: base + scan * gain.
 * Keeping those two terms separate lets Godot sample the same high-frequency
 * albedo per fragment while preserving the compiler-authored layer weights,
 * climate, strata, paint, cavity, and ember classification exactly.
 */
export function bakeTerrainMaterialBlend(
  positions: Float32Array,
  normals: Float32Array,
  surfaceFields: readonly Uint16Array[],
  packedWeights: Uint16Array,
  settings: TerrainMaterialSettings,
  originX = 0,
  originZ = 0,
): {
  colors: Float32Array
  coefficients: Float32Array
  variations: Float32Array
} {
  const vertexCount = positions.length / 3
  if (surfaceFields.length !== 5 || normals.length !== positions.length) {
    throw new Error('Terrain material export received incomplete surface fields')
  }
  const colors = new Float32Array(vertexCount * 4)
  const coefficients = new Float32Array(vertexCount * 2)
  const variations = new Float32Array(vertexCount * 2)
  const paintColors = settings.channels.map((channel) => linearColor(channel.color))

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const field = vertex * 4
    const position = vertex * 3
    const grassMeadow = unpackUnitPair(surfaceFields[0][field])
    const soilScree = unpackUnitPair(surfaceFields[0][field + 1])
    const rockSnow = unpackUnitPair(surfaceFields[0][field + 2])
    const moistureLichen = unpackUnitPair(surfaceFields[2][field + 1])
    const mottleAridity = unpackUnitPair(surfaceFields[2][field + 3])
    const buttressEmber = unpackUnitPair(surfaceFields[4][field])
    const weights = {
      grass: grassMeadow[0],
      meadow: grassMeadow[1],
      soil: soilScree[0],
      scree: soilScree[1],
      rock: rockSnow[0],
      snow: rockSnow[1],
    }
    const moisture = moistureLichen[0]
    const lichen = moistureLichen[1]
    const aridity = mottleAridity[1]
    const regionalTint = unit(surfaceFields[3][field + 3])
    const occlusion = unit(surfaceFields[4][field + 1])

    const grassBase = mixColor(
      [0.022, 0.028, 0.024],
      [0.052, 0.064, 0.049],
      moisture,
    )
    const meadowBase = mixColor(
      [0.04, 0.048, 0.042],
      [0.088, 0.09, 0.068],
      moisture,
    )
    const soilBase = mixColor(
      [0.042, 0.048, 0.052],
      [0.092, 0.078, 0.062],
      aridity,
    )
    const screeBase = mixColor(
      [0.072, 0.082, 0.092],
      [0.138, 0.128, 0.112],
      aridity,
    )
    let rockBase = mixColor(
      [0.065, 0.078, 0.095],
      [0.215, 0.225, 0.225],
      regionalTint,
    )
    rockBase = mixColor(rockBase, [0.2, 0.145, 0.09], aridity * 0.2)
    rockBase = mixColor(rockBase, [0.07, 0.09, 0.055], lichen * 0.18)

    const bedding = normalizeVector([
      unit(surfaceFields[1][field]) * 2 - 1,
      unit(surfaceFields[1][field + 1]) * 2 - 1,
      unit(surfaceFields[1][field + 2]) * 2 - 1,
    ])
    const bedThickness = mix(
      BED_THICKNESS_MIN,
      BED_THICKNESS_MAX,
      unit(surfaceFields[1][field + 3]),
    )
    const bedded = [
      originX + positions[position] + (unit(surfaceFields[3][field]) * 2 - 1) * 16,
      positions[position + 1] + (unit(surfaceFields[3][field + 1]) * 2 - 1) * 16,
      originZ + positions[position + 2] + (unit(surfaceFields[3][field + 2]) * 2 - 1) * 16,
    ] as const
    const bandCoordinate = dot3(bedded, bedding) / bedThickness
    const bandPhase = bandCoordinate - Math.floor(bandCoordinate)
    const bandBody = smoothstep(0.08, 0.3, bandPhase) *
      (1 - smoothstep(0.58, 0.98, bandPhase))
    const normal = normalizeVector([
      normals[position], normals[position + 1], normals[position + 2],
    ])
    const bedCut = smoothstep(0.16, 0.64, 1 - Math.abs(dot3(normal, bedding)))
    const rocky = Math.min(1,
      weights.rock + weights.scree + weights.soil * 0.95 +
      weights.meadow * 0.88 + weights.grass * 0.8,
    )
    const vegetation = Math.min(1, weights.grass + weights.meadow)
    const bedExposure = Math.min(
      1,
      unit(surfaceFields[4][field + 3]) + rocky * 0.44,
    ) * bedCut *
      mix(0.56, 1, unit(surfaceFields[2][field])) *
      smoothstep(0.22, 0.68, weights.rock)
    const rockFactor = mix(0.9, 1.1, regionalTint) *
      mix(1, mix(0.9, 1.08, bandBody), bedExposure)

    const base: [number, number, number] = [0, 0, 0]
    const scan: [number, number, number] = [0, 0, 0]
    addScaled(base, grassBase, weights.grass * 0.44)
    addUniform(scan, weights.grass * 0.56 * 0.82)
    addScaled(base, meadowBase, weights.meadow * 0.38)
    addUniform(scan, weights.meadow * 0.62 * 0.86)
    addScaled(base, soilBase, weights.soil * 0.32)
    addUniform(scan, weights.soil * 0.68 * 0.9)
    addScaled(base, screeBase, weights.scree * 0.24)
    addUniform(scan, weights.scree * 0.76 * 0.96)
    addScaled(base, rockBase, weights.rock * 0.48 * rockFactor)
    addUniform(scan, weights.rock * 0.52 * rockFactor)
    addScaled(base, [0.68, 0.73, 0.8], weights.snow)

    const cavityTone = mix(0.9, 1.035, occlusion)
    scaleVector(base, cavityTone)
    scaleVector(scan, cavityTone)

    const weightOffset = vertex * 4
    const paintWeights = [0, 1, 2, 3].map(
      (channel) => (packedWeights[weightOffset + channel] ?? 0) / 65_535,
    )
    const paintTotal = paintWeights.reduce((sum, weight) => sum + weight, 0)
    if (paintTotal > 0.0001) {
      const influence = Math.min(1, paintTotal)
      for (let channel = 0; channel < 3; channel += 1) {
        let painted = 0
        for (let paint = 0; paint < 4; paint += 1) {
          painted += paintColors[paint][channel] * paintWeights[paint]
        }
        base[channel] = mix(base[channel], painted / paintTotal, influence)
        scan[channel] *= 1 - influence
      }
    }

    const emberMask = smoothstep(0.04, 0.72, buttressEmber[1])
    const emberScale = [0.24, 0.18, 0.13] as const
    const emberAdd = [0.008, 0.002, 0.001] as const
    for (let channel = 0; channel < 3; channel += 1) {
      base[channel] = mix(
        base[channel],
        base[channel] * emberScale[channel] + emberAdd[channel],
        emberMask,
      )
      scan[channel] = mix(
        scan[channel],
        scan[channel] * emberScale[channel],
        emberMask,
      )
    }

    const color = vertex * 4
    colors[color] = base[0]
    colors[color + 1] = base[1]
    colors[color + 2] = base[2]
    colors[color + 3] = scan[0]
    const coefficient = vertex * 2
    coefficients[coefficient] = scan[1]
    coefficients[coefficient + 1] = scan[2]
    variations[coefficient] = rocky
    variations[coefficient + 1] = vegetation
  }
  return { colors, coefficients, variations }
}

function unit(value: number | undefined): number {
  return (value ?? 0) / 65_535
}

function unpackUnitPair(value: number | undefined): [number, number] {
  const packed = value ?? 0
  return [(packed & 0xff) / 255, (packed >>> 8) / 255]
}

function mixColor(
  a: readonly number[],
  b: readonly number[],
  amount: number,
): [number, number, number] {
  return [mix(a[0], b[0], amount), mix(a[1], b[1], amount), mix(a[2], b[2], amount)]
}

function addScaled(
  target: [number, number, number],
  value: readonly number[],
  scale: number,
): void {
  for (let channel = 0; channel < 3; channel += 1) {
    target[channel] += value[channel] * scale
  }
}

function addUniform(target: [number, number, number], value: number): void {
  for (let channel = 0; channel < 3; channel += 1) target[channel] += value
}

function scaleVector(target: [number, number, number], scale: number): void {
  for (let channel = 0; channel < 3; channel += 1) target[channel] *= scale
}

function normalizeVector(value: readonly number[]): [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2]) || 1
  return [value[0] / length, value[1] / length, value[2] / length]
}

function dot3(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
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
    {
      name: 'Water',
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 0.72],
        metallicFactor: 0,
        roughnessFactor: 0.2,
      },
      alphaMode: 'BLEND',
      doubleSided: true,
    },
  ]

  addMesh(mesh: ExportMesh): void {
    const position = this.addAccessor(mesh.positions, GL_ARRAY_BUFFER, 'VEC3', true)
    const normal = this.addAccessor(mesh.normals, GL_ARRAY_BUFFER, 'VEC3')
    const vertexCount = mesh.positions.length / 3
    const colorSize = mesh.colors.length / vertexCount
    if (colorSize !== 3 && colorSize !== 4) {
      throw new Error(`${mesh.name} has an invalid color stream`)
    }
    const color = this.addAccessor(
      mesh.colors,
      GL_ARRAY_BUFFER,
      colorSize === 4 ? 'VEC4' : 'VEC3',
    )
    const materialCoefficients = mesh.materialCoefficients
      ? this.addAccessor(mesh.materialCoefficients, GL_ARRAY_BUFFER, 'VEC2')
      : undefined
    const materialVariation = mesh.materialVariation
      ? this.addAccessor(mesh.materialVariation, GL_ARRAY_BUFFER, 'VEC2')
      : undefined
    const indices = this.addAccessor(mesh.indices, GL_ELEMENT_ARRAY_BUFFER, 'SCALAR')
    const meshIndex = this.meshes.length
    this.meshes.push({
      name: mesh.name,
      primitives: [{
        attributes: {
          POSITION: position,
          NORMAL: normal,
          COLOR_0: color,
          ...(materialCoefficients === undefined
            ? {}
            : { TEXCOORD_0: materialCoefficients }),
          ...(materialVariation === undefined
            ? {}
            : { TEXCOORD_1: materialVariation }),
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
    const direction: Vec3Like = {
      x: Math.cos(elevation) * Math.sin(azimuth),
      y: Math.sin(elevation),
      z: Math.cos(elevation) * Math.cos(azimuth),
    }
    const light = this.lights.length
    this.lights.push({
      name: 'MeshTerrain Sun',
      type: 'directional',
      color: hexColor('#ffd0a6'),
      // Three.js uses an artistic light scale here; Godot's non-physical
      // DirectionalLight3D scale reaches normal daylight at about 1. Passing
      // the editor's 4.35 through clipped the procedural albedo nearly white.
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
      asset: { version: '2.0', generator: 'Mesh Terrain Godot Exporter' },
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

function quaternionFromMinusZ(direction: Vec3Like): number[] {
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

function linearColor(color: number): [number, number, number] {
  return [16, 8, 0].map((shift) => {
    const channel = ((color >> shift) & 0xff) / 255
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
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

function mix(a: number, b: number, amount: number): number {
  return a + (b - a) * amount
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)))
  return amount * amount * (3 - 2 * amount)
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replaceAll(/[-:T]/g, '')
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function readme(summary: {
  patchCount: number
  triangleCount: number
  worldSize: number
}): string {
  return `# Mesh Terrain — Godot 4 export

Open this folder with Godot 4. The main scene is \`world.tscn\`.

- ${summary.patchCount.toLocaleString()} adaptive terrain mesh patches
- ${summary.triangleCount.toLocaleString()} triangles across terrain, rocks, and water
- ${summary.worldSize.toLocaleString()} × ${summary.worldSize.toLocaleString()} metre world
- Exact 1K procedural TSL albedo, normal and ARM bakes for ground and cliffs (height rides in the ARM alpha)
- Godot world-space terrain shader using those correlated PBR maps
- Vertex streams preserve the compiled TSL layer, climate, strata, cavity, and paint terms
- Authored granite rocks, standing water, default sun, and editor lights
- Runtime triangle collision generated by \`scripts/meshterrain_world.gd\`

\`assets/world.glb\` is the portable runtime asset. It uses metres, Y-up coordinates,
standard glTF 2.0 meshes/materials, and KHR_lights_punctual. Godot imports it without
an addon. \`source/meshterrain-world.json\` preserves the complete non-destructive
Mesh Terrain document and patch metadata.

The procedural maps live under \`assets/materials/\`. They are the finished output
of the same TSL recipes used by the editor, not screenshots of a preview overlay.
\`materials/terrain.gdshader\` recreates the ground planar and cliff triplanar
world-space projections, then combines them with the compiled terrain-material
base and scan contribution carried by each mesh patch.

The final meshes are authoritative. A heightmap cannot preserve caves, tunnels,
overhangs, imported CSG, or arbitrary editable patch topology, so none of those are
flattened into a lossy heightmap during export.
`
}

const PROJECT_GODOT = `; Engine configuration file.
; Generated by Mesh Terrain.

config_version=5

[application]

config/name="Mesh Terrain Export"
run/main_scene="res://world.tscn"

[display]

window/size/viewport_width=1280
window/size/viewport_height=720

[rendering]

renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
textures/default_filters/use_nearest_mipmap_filter=false
`

function worldScene(
  materialBindings: readonly Pick<ExportMesh, 'name' | 'kind'>[],
  proceduralMaterials: boolean,
): string {
  const overrides = materialBindings.map(({ name, kind }, index) => `
[node name=${JSON.stringify(name)} parent="World" index="${index}"]
surface_material_override/0 = SubResource("Material_${kind}")
`).join('')
  const proceduralResources = proceduralMaterials ? `
[ext_resource type="Shader" path="res://materials/terrain.gdshader" id="3_terrain_shader"]
[ext_resource type="Texture2D" path="res://assets/materials/rock-ground-albedo.tga" id="4_ground_albedo"]
[ext_resource type="Texture2D" path="res://assets/materials/rock-ground-normal.tga" id="5_ground_normal"]
[ext_resource type="Texture2D" path="res://assets/materials/rock-ground-arm.tga" id="6_ground_arm"]
[ext_resource type="Texture2D" path="res://assets/materials/cliff-side-albedo.tga" id="8_cliff_albedo"]
[ext_resource type="Texture2D" path="res://assets/materials/cliff-side-normal.tga" id="9_cliff_normal"]
[ext_resource type="Texture2D" path="res://assets/materials/cliff-side-arm.tga" id="10_cliff_arm"]
[ext_resource type="Texture2D" path="res://assets/materials/geology-detail.tga" id="12_geology_detail"]
` : ''
  const terrainMaterial = proceduralMaterials ? `
[sub_resource type="ShaderMaterial" id="Material_terrain"]
render_priority = 0
shader = ExtResource("3_terrain_shader")
shader_parameter/ground_albedo = ExtResource("4_ground_albedo")
shader_parameter/ground_normal = ExtResource("5_ground_normal")
shader_parameter/ground_arm = ExtResource("6_ground_arm")
shader_parameter/cliff_albedo = ExtResource("8_cliff_albedo")
shader_parameter/cliff_normal = ExtResource("9_cliff_normal")
shader_parameter/cliff_arm = ExtResource("10_cliff_arm")
shader_parameter/geology_detail = ExtResource("12_geology_detail")
` : `
[sub_resource type="StandardMaterial3D" id="Material_terrain"]
vertex_color_use_as_albedo = true
roughness = 0.9
cull_mode = 2
`
  return `[gd_scene load_steps=${proceduralMaterials ? 17 : 7} format=3]

[ext_resource type="PackedScene" path="res://assets/world.glb" id="1_world"]
[ext_resource type="Script" path="res://scripts/meshterrain_world.gd" id="2_script"]
${proceduralResources}

[sub_resource type="Environment" id="Environment_world"]
background_mode = 1
background_color = Color(0.16, 0.22, 0.28, 1)
ambient_light_source = 2
ambient_light_color = Color(0.46, 0.55, 0.66, 1)
ambient_light_energy = 0.72
reflected_light_source = 2
tonemap_mode = 2
${terrainMaterial}

[sub_resource type="StandardMaterial3D" id="Material_rock"]
vertex_color_use_as_albedo = true
roughness = 0.86
cull_mode = 2

[sub_resource type="StandardMaterial3D" id="Material_water"]
transparency = 1
albedo_color = Color(1, 1, 1, 0.72)
vertex_color_use_as_albedo = true
roughness = 0.2
cull_mode = 2

[node name="MeshTerrainWorld" type="Node3D"]
script = ExtResource("2_script")

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Environment_world")

[node name="World" parent="." instance=ExtResource("1_world")]
${overrides}
[editable path="World"]
`
}

/**
 * Godot translation of the production material's invariant texture path.
 *
 * The expensive TSL recipes are exported as their exact baked maps above. The
 * shader preserves their world-space projection: a rotated planar ground scan,
 * a sharp triplanar cliff scan, and the same slope/altitude/focal-massif domain
 * used by createFullTerrainMaterial. Its slow compiler-authored material term
 * and procedural-scan gain are carried in COLOR_0/TEXCOORD_0, while the same
 * high-frequency procedural albedo is evaluated per fragment here.
 */
export const GODOT_TERRAIN_SHADER = `shader_type spatial;
render_mode cull_disabled, depth_draw_opaque;

uniform sampler2D ground_albedo : source_color, repeat_enable, filter_linear_mipmap_anisotropic;
uniform sampler2D ground_normal : hint_normal, repeat_enable, filter_linear_mipmap_anisotropic;
uniform sampler2D ground_arm : repeat_enable, filter_linear_mipmap_anisotropic;
uniform sampler2D cliff_albedo : source_color, repeat_enable, filter_linear_mipmap_anisotropic;
uniform sampler2D cliff_normal : hint_normal, repeat_enable, filter_linear_mipmap_anisotropic;
uniform sampler2D cliff_arm : repeat_enable, filter_linear_mipmap_anisotropic;
uniform sampler2D geology_detail : repeat_enable, filter_linear_mipmap_anisotropic;

varying vec3 world_position;
varying vec3 world_geometric_normal;
varying vec3 compiled_base_color;
varying vec3 compiled_scan_coefficient;
varying vec2 compiled_material_coverage;

void vertex() {
    world_position = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
    world_geometric_normal = normalize(MODEL_NORMAL_MATRIX * NORMAL);
    compiled_base_color = COLOR.rgb;
    compiled_scan_coefficient = vec3(COLOR.a, UV.x, UV.y);
    compiled_material_coverage = UV2;
}

vec3 axis_sign(vec3 value) {
    return vec3(
        value.x < 0.0 ? -1.0 : 1.0,
        value.y < 0.0 ? -1.0 : 1.0,
        value.z < 0.0 ? -1.0 : 1.0
    );
}

vec3 triplanar_weights(vec3 normal_value) {
    vec3 weights = pow(abs(normal_value), vec3(8.0));
    return weights / max(dot(weights, vec3(1.0)), 0.0001);
}

vec4 sample_cliff(sampler2D source, vec3 position_value, vec3 normal_value) {
    vec3 signs = axis_sign(normal_value);
    vec3 weights = triplanar_weights(normal_value);
    vec2 uv_x = position_value.yz / 64.0 * vec2(signs.x, 1.0);
    vec2 uv_y = position_value.zx / 64.0 * vec2(signs.y, 1.0);
    vec2 uv_z = position_value.xy / 64.0 * vec2(signs.z, 1.0);
    return texture(source, uv_x) * weights.x
        + texture(source, uv_y) * weights.y
        + texture(source, uv_z) * weights.z;
}

vec3 sample_cliff_normal(vec3 position_value, vec3 normal_value) {
    vec3 signs = axis_sign(normal_value);
    vec3 weights = triplanar_weights(normal_value);
    vec2 uv_x = position_value.yz / 64.0 * vec2(signs.x, 1.0);
    vec2 uv_y = position_value.zx / 64.0 * vec2(signs.y, 1.0);
    vec2 uv_z = position_value.xy / 64.0 * vec2(signs.z, 1.0);
    vec3 nx = texture(cliff_normal, uv_x).rgb * 2.0 - 1.0;
    vec3 ny = texture(cliff_normal, uv_y).rgb * 2.0 - 1.0;
    vec3 nz = texture(cliff_normal, uv_z).rgb * 2.0 - 1.0;
    vec3 mapped_x = normalize(vec3(nx.z * signs.x, nx.x * signs.x, nx.y));
    vec3 mapped_y = normalize(vec3(ny.y, ny.z * signs.y, ny.x * signs.y));
    vec3 mapped_z = normalize(vec3(nz.x * signs.z, nz.y, nz.z * signs.z));
    return normalize(mapped_x * weights.x + mapped_y * weights.y + mapped_z * weights.z);
}

void fragment() {
    vec3 geometric = normalize(world_geometric_normal);
    vec3 scan_position = vec3(
        world_position.x * 0.84 + world_position.y * 0.54,
        world_position.y * 0.84 - world_position.x * 0.54,
        world_position.z
    );
    vec3 scan_normal = normalize(vec3(
        geometric.x * 0.84 + geometric.y * 0.54,
        geometric.y * 0.84 - geometric.x * 0.54,
        geometric.z
    ));
    vec2 ground_uv = vec2(
        world_position.x * 0.829 + world_position.z * 0.559,
        world_position.z * 0.829 - world_position.x * 0.559
    ) / 14.5;

    float slope = 1.0 - abs(geometric.y);
    vec2 focal_offset = vec2(
        (world_position.x - 420.0) / 270.0,
        (world_position.z - 395.0) / 235.0
    );
    float focal_rock = (1.0 - smoothstep(0.32, 1.05, dot(focal_offset, focal_offset)))
        * smoothstep(68.0, 155.0, world_position.y);
    float cliff_likelihood = slope
        + smoothstep(58.0, 205.0, world_position.y) * 0.38
        + focal_rock * 0.28;
    float cliff_domain = smoothstep(0.30, 0.66, cliff_likelihood);

    vec4 ground_color = texture(ground_albedo, ground_uv);
    vec4 cliff_color = sample_cliff(cliff_albedo, scan_position, scan_normal);
    vec4 ground_pbr = texture(ground_arm, ground_uv);
    vec4 cliff_pbr = sample_cliff(cliff_arm, scan_position, scan_normal);
    // Height is the ARM alpha, not a map of its own, and the ARM tuple has
    // already been fetched just above. See packArm in the exporter source.
    float ground_relief = ground_pbr.a;
    float cliff_relief = cliff_pbr.a;
    vec4 selected_color = mix(ground_color, cliff_color, cliff_domain);
    vec4 selected_pbr = mix(ground_pbr, cliff_pbr, cliff_domain);
    float selected_relief = mix(ground_relief, cliff_relief, cliff_domain);

    float scan_luminance = dot(selected_color.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 cliff_rock_diffuse = mix(selected_color.rgb, vec3(scan_luminance), 0.82);
    cliff_rock_diffuse = cliff_rock_diffuse * vec3(1.38, 1.42, 1.48)
        + vec3(0.014, 0.017, 0.022);
    cliff_rock_diffuse = (cliff_rock_diffuse - vec3(0.14)) * 1.18 + vec3(0.14);
    cliff_rock_diffuse = clamp(cliff_rock_diffuse, vec3(0.0), vec3(0.52));

    float green_excess = max(
        selected_color.g - max(selected_color.r, selected_color.b),
        0.0
    );
    vec3 ground_neutral_scan = vec3(
        selected_color.r + green_excess * 0.14,
        selected_color.g - green_excess * 0.82,
        selected_color.b + green_excess * 0.08
    );
    float ground_luminance = dot(
        ground_neutral_scan,
        vec3(0.2126, 0.7152, 0.0722)
    );
    vec3 ground_rock_diffuse = mix(
        ground_neutral_scan,
        vec3(ground_luminance),
        0.42
    );
    ground_rock_diffuse = ground_rock_diffuse * vec3(0.90, 0.92, 0.96)
        + vec3(0.010, 0.012, 0.016);
    ground_rock_diffuse = (ground_rock_diffuse - vec3(0.16)) * 0.90 + vec3(0.16);
    ground_rock_diffuse = clamp(ground_rock_diffuse, vec3(0.0), vec3(0.52));
    vec3 scan_rock_diffuse = mix(
        ground_rock_diffuse,
        cliff_rock_diffuse,
        cliff_domain
    );

    // createFullTerrainMaterial is affine in scan_rock_diffuse. The exporter
    // evaluates its layer, climate, strata, paint, cavity, and ember terms per
    // vertex and stores the resulting base and RGB gain in COLOR_0/TEXCOORD_0.
    vec4 broad = sample_cliff(geology_detail, world_position * 2.304, geometric);
    float rock_variation = mix(0.94, 1.06, broad.r);
    float turf_variation = mix(0.92, 1.08, broad.b);
    vec3 compiled_albedo = compiled_base_color
        + compiled_scan_coefficient * scan_rock_diffuse;
    compiled_albedo *= mix(1.0, rock_variation, compiled_material_coverage.x);
    compiled_albedo *= mix(
        1.0,
        turf_variation,
        compiled_material_coverage.y * 0.62
    );
    ALBEDO = clamp(
        compiled_albedo,
        vec3(0.0),
        vec3(1.0)
    );

    vec3 ground_tangent_normal = texture(ground_normal, ground_uv).rgb * 2.0 - 1.0;
    float ground_sign = geometric.y < 0.0 ? -1.0 : 1.0;
    vec3 mapped_ground = normalize(vec3(
        ground_tangent_normal.x * 0.829 - ground_tangent_normal.y * 0.559,
        ground_tangent_normal.z * ground_sign,
        ground_tangent_normal.x * 0.559 + ground_tangent_normal.y * 0.829
    ));
    vec3 ground_perturbation = mapped_ground - vec3(0.0, ground_sign, 0.0);
    vec3 mapped_cliff_scan = sample_cliff_normal(scan_position, scan_normal);
    vec3 flat_cliff_scan = normalize(axis_sign(scan_normal) * triplanar_weights(scan_normal));
    vec3 cliff_scan_perturbation = mapped_cliff_scan - flat_cliff_scan;
    vec3 cliff_world_perturbation = vec3(
        cliff_scan_perturbation.x * 0.84 - cliff_scan_perturbation.y * 0.54,
        cliff_scan_perturbation.x * 0.54 + cliff_scan_perturbation.y * 0.84,
        cliff_scan_perturbation.z
    );
    vec3 mapped_world_normal = normalize(
        geometric + mix(ground_perturbation, cliff_world_perturbation, cliff_domain) * 0.68
    );
    NORMAL = normalize((VIEW_MATRIX * vec4(mapped_world_normal, 0.0)).xyz);
    AO = clamp(selected_pbr.r, 0.54, 1.0);
    AO_LIGHT_AFFECT = 0.72;
    ROUGHNESS = clamp(selected_pbr.g, 0.52, 0.98);
    METALLIC = clamp(selected_pbr.b, 0.0, 0.12);
}
`

const WORLD_SCRIPT = `@tool
extends Node3D

## Godot 4.7 imports glTF COLOR_0 arrays but leaves this material switch off.
## Enabling it makes the baked terrain, paint, granite, and water colours visible.
@export var use_exported_vertex_materials := true

## Builds concave static collision from every exported terrain patch.
## Disable this before running if your project supplies its own collision system.
@export var generate_terrain_collision := true

func _ready() -> void:
    if use_exported_vertex_materials:
        _apply_exported_materials()
    if Engine.is_editor_hint() or not generate_terrain_collision:
        return
    for node in find_children("TerrainPatch_*", "MeshInstance3D", true, false):
        var patch := node as MeshInstance3D
        if patch != null and patch.mesh != null:
            patch.create_trimesh_collision()

func _apply_exported_materials() -> void:
    # One imported terrain material is shared by every patch. Duplicate it once
    # per source material, then share the configured copy across all instances.
    var configured: Dictionary = {}
    for node in find_children("*", "MeshInstance3D", true, false):
        var instance := node as MeshInstance3D
        if instance == null or instance.mesh == null:
            continue
        for surface in instance.mesh.get_surface_count():
            # world.tscn owns authoritative overrides (including the exported
            # procedural ShaderMaterial). Never replace one with the GLB's
            # vertex-colour compatibility material.
            if instance.get_surface_override_material(surface) != null:
                continue
            var source := instance.mesh.surface_get_material(surface)
            if not source is BaseMaterial3D:
                continue
            var key := source.get_instance_id()
            var material: BaseMaterial3D
            if configured.has(key):
                material = configured[key]
            else:
                material = source.duplicate() as BaseMaterial3D
                material.vertex_color_use_as_albedo = true
                configured[key] = material
            instance.set_surface_override_material(surface, material)
`
