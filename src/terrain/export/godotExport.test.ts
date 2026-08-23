import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EditorLight } from '../editor/lights'
import type { TerrainStorage } from '../persistence/TerrainStorage'
import { bakeSurface } from '../rendering/textures/procedural/bake'
import { PROCEDURAL_SURFACES } from '../rendering/textures/procedural/materials'
import { WorldTerrain } from '../WorldTerrain'
import {
  createGodotArchive,
  createSceneGlb,
  bakeTerrainMaterialBlend,
  encodeTga,
  exportGodotProject,
  GODOT_TERRAIN_SHADER,
} from './godotExport'

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}

const memoryStorage: TerrainStorage = {
  async load() {
    return undefined
  },
  async save() {},
  async clear() {},
}

describe('Godot export', () => {
  const OriginalWorker = globalThis.Worker

  beforeEach(() => {
    globalThis.Worker = FakeWorker as unknown as typeof Worker
  })

  afterEach(() => {
    globalThis.Worker = OriginalWorker
  })

  it('writes a valid glTF 2 binary scene with mesh attributes and lights', () => {
    const light: EditorLight = {
      id: 'spot-1',
      name: 'Cave light',
      type: 'spot',
      color: '#80c0ff',
      intensity: 12,
      distance: 90,
      decay: 1.6,
      position: { x: 4, y: 8, z: 2 },
      target: { x: 4, y: 0, z: 2 },
      angle: Math.PI / 5,
      penumbra: 0.35,
      visible: true,
    }
    const glb = createSceneGlb([{
      name: 'TerrainPatch_p0_p0',
      kind: 'terrain',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
      colors: new Float32Array([0.2, 0.4, 0.1, 0.2, 0.4, 0.1, 0.2, 0.4, 0.1]),
      indices: new Uint32Array([0, 2, 1]),
      translation: [128, 0, -128],
      extras: { meshterrain_kind: 'terrain_patch', lod: 2 },
    }], [light])

    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
    expect(view.getUint32(0, true)).toBe(0x46546c67)
    expect(view.getUint32(4, true)).toBe(2)
    expect(view.getUint32(8, true)).toBe(glb.length)
    expect(view.getUint32(16, true)).toBe(0x4e4f534a)
    const jsonLength = view.getUint32(12, true)
    const json = JSON.parse(
      new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)).trim(),
    )
    expect(json.asset.version).toBe('2.0')
    expect(json.extensionsUsed).toContain('KHR_lights_punctual')
    expect(json.meshes).toHaveLength(1)
    expect(json.meshes[0].primitives[0].attributes).toEqual({
      POSITION: 0,
      NORMAL: 1,
      COLOR_0: 2,
    })
    expect(json.accessors.map((accessor: { count: number }) => accessor.count)).toEqual([
      3, 3, 3, 3,
    ])
    expect(json.nodes[0].translation).toEqual([128, 0, -128])
    expect(json.extensions.KHR_lights_punctual.lights).toHaveLength(2)
    expect(json.extensions.KHR_lights_punctual.lights[0]).toMatchObject({
      name: 'MeshTerrain Sun',
      type: 'directional',
      intensity: 1,
    })
    expect(json.extensions.KHR_lights_punctual.lights[1].type).toBe('spot')
    expect(json.nodes[2].rotation.every(Number.isFinite)).toBe(true)
    const binHeader = 20 + jsonLength
    expect(view.getUint32(binHeader + 4, true)).toBe(0x004e4942)
    expect(binHeader + 8 + view.getUint32(binHeader, true)).toBe(glb.length)
  })

  it('packages a directly openable Godot project with source and assets', () => {
    const glb = createSceneGlb([])
    const archive = createGodotArchive(
      glb,
      '{"format":"test"}',
      { patchCount: 1, triangleCount: 2, worldSize: 128 },
      [{ name: 'TerrainPatch_p0_p0', kind: 'terrain' }],
    )
    const files = readStoredZip(archive)
    expect([...files.keys()].sort()).toEqual([
      'README.md',
      'assets/',
      'assets/world.glb',
      'project.godot',
      'scripts/',
      'scripts/meshterrain_world.gd',
      'source/',
      'source/meshterrain-world.json',
      'world.tscn',
    ])
    expect(text(files.get('project.godot'))).toContain('run/main_scene="res://world.tscn"')
    expect(text(files.get('world.tscn'))).toContain('res://assets/world.glb')
    expect(text(files.get('world.tscn'))).toContain('res://scripts/meshterrain_world.gd')
    expect(text(files.get('world.tscn'))).toContain(
      'surface_material_override/0 = SubResource("Material_terrain")',
    )
    expect(text(files.get('world.tscn'))).toContain(
      'vertex_color_use_as_albedo = true',
    )
    expect(text(files.get('scripts/meshterrain_world.gd'))).toContain(
      'patch.create_trimesh_collision()',
    )
    expect(text(files.get('scripts/meshterrain_world.gd'))).toContain(
      'material.vertex_color_use_as_albedo = true',
    )
    expect(text(files.get('scripts/meshterrain_world.gd'))).toContain(
      'get_surface_override_material(surface) != null',
    )
    expect(files.get('assets/world.glb')).toEqual(glb)
    expect(text(files.get('README.md'))).toContain('Godot 4')
  })

  it('compiles every logical patch when exporting an unsettled world', async () => {
    const terrain = new WorldTerrain({
      worldSize: 32,
      sectionSize: 16,
      lodResolutions: [4, 2],
      workerCount: 1,
      worldProfile: 'flat',
      worldContent: { showcase: false, outcrops: false, rocks: 0, water: false },
    }, memoryStorage)
    const progress: string[] = []
    const result = await exportGodotProject({
      terrain,
      onProgress: ({ stage }) => progress.push(stage),
    })
    const files = readStoredZip(result.archive)
    const source = JSON.parse(text(files.get('source/meshterrain-world.json')))
    const gltf = readGlbJson(files.get('assets/world.glb')!)

    expect(result.patchCount).toBe(4)
    expect(result.triangleCount).toBeGreaterThan(0)
    expect(source.patches).toHaveLength(4)
    expect(source.patches.every((patch: { lod: number }) => patch.lod === 1)).toBe(true)
    expect(progress).toContain('terrain')
    expect(progress.at(-1)).toBe('package')
    expect(gltf.meshes[0].primitives[0].attributes).toHaveProperty('TEXCOORD_0')
    expect(gltf.meshes[0].primitives[0].attributes).toHaveProperty('TEXCOORD_1')
    expect(
      gltf.accessors[gltf.meshes[0].primitives[0].attributes.COLOR_0].type,
    ).toBe('VEC4')
    terrain.dispose()
  })

  it('bakes the full TSL layer and paint terms separately from scan detail', () => {
    const fields = Array.from(
      { length: 5 },
      () => new Uint16Array(4),
    )
    // One fully rock-classified vertex, neutral bedding/tint, full cavity.
    fields[0][2] = 0x00ff
    fields[1].set([32_768, 65_535, 32_768, 32_768])
    fields[2].set([32_768, 0x8080, 32_768, 0x8080])
    fields[3].set([32_768, 32_768, 32_768, 32_768])
    fields[4].set([0, 65_535, 0, 0])
    const unpainted = bakeTerrainMaterialBlend(
      new Float32Array([0, 0, 0]),
      new Float32Array([0, 1, 0]),
      fields,
      new Uint16Array(4),
      terrainMaterialSettings(),
    )
    expect([...unpainted.colors].every(Number.isFinite)).toBe(true)
    expect(unpainted.colors[3]).toBeGreaterThan(0.45)
    expect(unpainted.coefficients[0]).toBeCloseTo(unpainted.colors[3], 5)
    expect(unpainted.coefficients[1]).toBeCloseTo(unpainted.colors[3], 5)
    expect(unpainted.variations[0]).toBe(1)
    expect(unpainted.variations[1]).toBe(0)

    const painted = bakeTerrainMaterialBlend(
      new Float32Array([0, 0, 0]),
      new Float32Array([0, 1, 0]),
      fields,
      new Uint16Array([0, 0, 65_535, 0]),
      terrainMaterialSettings(),
    )
    expect(painted.colors[3]).toBe(0)
    expect([...painted.coefficients]).toEqual([0, 0])
    expect(painted.colors[0]).toBeCloseTo(0.11697, 4)
  })

  it('packages the procedural TSL bake maps and Godot terrain shader', () => {
    const surfaces = (['rock-ground', 'cliff-side'] as const).map((id) => ({
      id,
      maps: bakeSurface(PROCEDURAL_SURFACES[id], 32, 1),
    }))
    const materialFiles = surfaces.flatMap(({ id, maps }) =>
      (['albedo', 'normal', 'arm', 'displacement'] as const).map((channel) => ({
        path: `assets/materials/${id}-${channel}.tga`,
        data: encodeTga(maps[channel], maps.size, maps.size),
      })),
    )
    const groundAlbedo = surfaces[0].maps.albedo
    const texture = materialFiles[0].data
    const archive = createGodotArchive(
      createSceneGlb([]),
      '{}',
      { patchCount: 1, triangleCount: 1, worldSize: 4 },
      [{ name: 'TerrainPatch_p0_p0', kind: 'terrain' }],
      {
        files: [
          { path: 'materials/terrain.gdshader', data: GODOT_TERRAIN_SHADER },
          ...materialFiles,
          { path: 'assets/materials/geology-detail.tga', data: texture },
        ],
      },
    )
    const files = readStoredZip(archive)
    const scene = text(files.get('world.tscn'))
    expect(scene).toContain('[sub_resource type="ShaderMaterial" id="Material_terrain"]')
    expect(scene).toContain('res://materials/terrain.gdshader')
    expect(scene).toContain('res://assets/materials/cliff-side-normal.tga')
    expect(text(files.get('materials/terrain.gdshader'))).toContain(
      'uniform sampler2D cliff_height',
    )
    const shader = text(files.get('materials/terrain.gdshader'))
    expect(shader).toContain('scan_luminance')
    expect(shader).toContain('compiled_base_color')
    expect(shader).toContain('compiled_scan_coefficient * scan_rock_diffuse')
    expect(shader).not.toContain('baked_vertex_color')
    expect(files.get('assets/materials/rock-ground-albedo.tga')).toEqual(texture)
    expect([...texture.slice(12, 18)]).toEqual([32, 0, 32, 0, 32, 40])
    expect([...texture.slice(18, 22)]).toEqual([
      groundAlbedo[2], groundAlbedo[1], groundAlbedo[0], groundAlbedo[3],
    ])
    expect(new Set(groundAlbedo).size).toBeGreaterThan(8)
    const cliffAlbedo = surfaces[1].maps.albedo
    const channelMean = (channel: number) => {
      let total = 0
      for (let offset = channel; offset < cliffAlbedo.length; offset += 4) {
        total += cliffAlbedo[offset]
      }
      return total / (cliffAlbedo.length / 4)
    }
    expect(channelMean(0)).toBeGreaterThan(channelMean(2) + 15)
  })
})

function readStoredZip(data: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let cursor = 0
  while (view.getUint32(cursor, true) === 0x04034b50) {
    expect(view.getUint16(cursor + 8, true)).toBe(0)
    const size = view.getUint32(cursor + 18, true)
    const nameLength = view.getUint16(cursor + 26, true)
    const extraLength = view.getUint16(cursor + 28, true)
    const nameStart = cursor + 30
    const contentStart = nameStart + nameLength + extraLength
    const name = new TextDecoder().decode(data.subarray(nameStart, contentStart))
    files.set(name, data.slice(contentStart, contentStart + size))
    cursor = contentStart + size
  }
  expect(view.getUint32(cursor, true)).toBe(0x02014b50)
  return files
}

function text(value: Uint8Array | undefined): string {
  expect(value).toBeDefined()
  return new TextDecoder().decode(value)
}

function readGlbJson(glb: Uint8Array): any {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  const jsonLength = view.getUint32(12, true)
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)).trim())
}

function terrainMaterialSettings() {
  return {
    channels: [
      { id: 'channel0' as const, name: 'Grass', color: 0x4f7d32, roughness: 0.94 },
      { id: 'channel1' as const, name: 'Rock', color: 0x77736c, roughness: 0.82 },
      { id: 'channel2' as const, name: 'Soil', color: 0x604733, roughness: 0.91 },
      { id: 'channel3' as const, name: 'Snow', color: 0xdce4ee, roughness: 0.68 },
    ] as const,
  }
}
