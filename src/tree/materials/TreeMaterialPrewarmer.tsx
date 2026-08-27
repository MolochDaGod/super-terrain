import { useEffect, useMemo } from 'react'
import {
  BoxGeometry,
  BufferAttribute,
  DataTexture,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Texture,
} from 'three/webgpu'
import { createLeafCardGeometry } from './leafCardGeometry'
import { createFrondCardGeometry } from './frondCardGeometry'
import { createBarkMaterial } from './bark/material'
import { createFoliageMaterial, createFrondMaterial } from './leafMaterial'
import { createFruitMaterial } from './fruitMaterial'
import type { ProceduralTreeTextures } from './proceduralTreeTextures'
import { retireGpuResource } from '../../terrain/rendering/gpuResourceRetirement'

export function TreeMaterialPrewarmer({
  warmup,
}: {
  warmup?: (object: Object3D) => Promise<void>
}) {
  const resources = useMemo(createWarmupResources, [])
  useEffect(
    () => () => retireGpuResource(() => resources.dispose()),
    [resources],
  )
  useEffect(() => {
    if (!warmup) return
    let cancelled = false
    void warmup(resources.group).catch((error: unknown) => {
      if (!cancelled) console.error('Tree shader prewarm failed', error)
    })
    return () => {
      cancelled = true
    }
  }, [resources, warmup])
  return null
}

function createWarmupResources(): {
  group: Group
  dispose(): void
} {
  const textures = createPlaceholderTextures()
  const axialTextures: ProceduralTreeTextures = {
    ...textures,
    barkProjection: 'axial-uv',
  }
  const materials: Material[] = [
    createBarkMaterial(textures),
    createBarkMaterial(axialTextures),
    createFoliageMaterial(textures.leafAtlas),
    createFrondMaterial(true),
    createFoliageMaterial(undefined, true),
    createFruitMaterial(true),
  ]
  const geometries: BufferGeometry[] = [
    createWoodGeometry(),
    createWoodGeometry(),
    createWarmupLeafGeometry(),
    createWarmupInstancedGeometry(createFrondCardGeometry(0)),
    createWarmupInstancedGeometry(new IcosahedronGeometry(1, 1)),
    createWarmupInstancedGeometry(new IcosahedronGeometry(1, 2)),
  ]
  const group = new Group()
  group.name = 'tree-material-pipeline-prewarm'

  for (let index = 0; index < 2; index += 1) {
    const mesh = new Mesh(geometries[index], materials[index])
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.frustumCulled = false
    group.add(mesh)
  }
  const leaf = new Mesh(geometries[2], materials[2])
  leaf.castShadow = true
  leaf.receiveShadow = true
  leaf.frustumCulled = false
  group.add(leaf)
  for (let index = 3; index < 5; index += 1) {
    const mesh = new Mesh(geometries[index], materials[index])
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.frustumCulled = false
    group.add(mesh)
  }
  for (let index = 5; index < materials.length; index += 1) {
    const mesh = new Mesh(geometries[index], materials[index])
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.frustumCulled = false
    group.add(mesh)
  }

  return {
    group,
    dispose() {
      for (const material of materials) material.dispose()
      for (const geometry of geometries) geometry.dispose()
      textures.dispose()
    },
  }
}

function createWarmupLeafGeometry(): InstancedBufferGeometry {
  return createWarmupInstancedGeometry(createLeafCardGeometry(), true)
}

function createWarmupInstancedGeometry(
  base: BufferGeometry,
  leafVariant = false,
): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry()
  geometry.setIndex(base.getIndex())
  for (const name of Object.keys(base.attributes)) {
    geometry.setAttribute(name, base.getAttribute(name))
  }
  const matrix = new InstancedInterleavedBuffer(
    Float32Array.from(new Matrix4().toArray()), 16, 1,
  )
  for (let column = 0; column < 4; column += 1) {
    geometry.setAttribute(
      `treeInstanceMatrix${column}`,
      new InterleavedBufferAttribute(matrix, 4, column * 4),
    )
  }
  geometry.setAttribute(
    'treeInstanceColor',
    new InstancedBufferAttribute(new Float32Array([1, 1, 1]), 3),
  )
  if (leafVariant) {
    geometry.setAttribute(
      'leafVariant',
      new InstancedBufferAttribute(new Float32Array([0]), 1),
    )
  }
  geometry.instanceCount = 1
  return geometry
}

function createWoodGeometry(): BoxGeometry {
  const geometry = new BoxGeometry(1, 1, 1)
  const vertices = geometry.getAttribute('position').count
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(vertices * 3).fill(1), 3))
  return geometry
}

function createPlaceholderTextures(): ProceduralTreeTextures {
  const barkMap = placeholderTexture(true, true, 'tree prewarm bark albedo')
  const barkNormalMap = placeholderTexture(false, true, 'tree prewarm bark normal')
  const barkRoughnessMap = placeholderTexture(false, true, 'tree prewarm bark surface')
  const leafMap = placeholderTexture(true, false, 'tree prewarm leaf albedo')
  const leafNormalMap = placeholderTexture(false, false, 'tree prewarm leaf normal')
  const leafSurfaceMap = placeholderTexture(false, false, 'tree prewarm leaf surface')
  const owned: Texture[] = [
    barkMap,
    barkNormalMap,
    barkRoughnessMap,
    leafMap,
    leafNormalMap,
    leafSurfaceMap,
  ]
  return {
    barkMap,
    barkNormalMap,
    barkNormalScale: 0.12,
    barkProjection: 'world-triplanar',
    barkMossiness: 0.85,
    barkRoughnessMap,
    leafCards: [{ map: leafMap, normalMap: leafNormalMap, surfaceMap: leafSurfaceMap }],
    leafAtlas: {
      map: leafMap,
      normalMap: leafNormalMap,
      surfaceMap: leafSurfaceMap,
      variants: 8,
    },
    dispose() {
      for (const texture of owned) texture.dispose()
    },
  }
}

function placeholderTexture(
  srgb: boolean,
  repeat: boolean,
  name: string,
): DataTexture {
  const texture = new DataTexture(
    new Uint8Array([128, 128, 255, 255]),
    1,
    1,
    RGBAFormat,
    UnsignedByteType,
  )
  texture.name = name
  texture.colorSpace = srgb ? SRGBColorSpace : texture.colorSpace
  texture.minFilter = LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 8
  if (repeat) {
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
  }
  texture.needsUpdate = true
  return texture
}
