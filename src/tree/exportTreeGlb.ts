import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector2,
} from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import type { ProceduralTreeAsset, TreeLodLevel } from './generator/types'
import {
  bakeProceduralTreeTextures,
  type ProceduralTreeTextures,
} from './materials/proceduralTreeTextures'
import { createLeafCardGeometry, splitFoliageByVariant } from './materials/leafCardGeometry'
import { createFrondCardGeometry } from './materials/frondCardGeometry'
import { createPalmFanGeometry } from './materials/palmFanGeometry'
import { createSucculentRosetteGeometry } from './materials/succulentRosetteGeometry'

export async function downloadTreeGlb(
  asset: ProceduralTreeAsset,
  level: TreeLodLevel,
): Promise<void> {
  const { group, textures } = buildExportGroup(asset, level)
  try {
    const exporter = new GLTFExporter()
    const result = await exporter.parseAsync(group, {
      binary: true,
      onlyVisible: true,
      trs: false,
    })
    if (!(result instanceof ArrayBuffer)) {
      throw new Error('GLB exporter returned JSON instead of binary data')
    }
    const blob = new Blob([result], { type: 'model/gltf-binary' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${asset.parameters.species}-${asset.parameters.seed}-lod${level}.glb`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } finally {
    group.traverse((object) => {
      if (!(object instanceof Mesh)) return
      object.geometry.dispose()
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) material.dispose()
    })
    textures.dispose()
  }
}

function buildExportGroup(
  asset: ProceduralTreeAsset,
  level: TreeLodLevel,
): { group: Group; textures: ProceduralTreeTextures } {
  const lod = asset.lods[level]
  const group = new Group()
  const textures = bakeProceduralTreeTextures(
    asset.parameters.species,
    asset.parameters.seed,
  )
  group.name = `${asset.parameters.species}-${asset.parameters.seed}-lod${level}`
  group.userData.treeRecipe = { ...asset.parameters }

  const woodGeometry = new BufferGeometry()
  woodGeometry.setAttribute('position', new BufferAttribute(lod.wood.positions, 3))
  woodGeometry.setAttribute('normal', new BufferAttribute(lod.wood.normals, 3))
  woodGeometry.setAttribute('color', new BufferAttribute(lod.wood.colors, 3))
  woodGeometry.setAttribute('uv', new BufferAttribute(lod.wood.uvs, 2))
  woodGeometry.setIndex(new BufferAttribute(lod.wood.indices, 1))
  const woodMaterial = new MeshStandardMaterial({
    vertexColors: true,
    map: textures.barkMap,
    normalMap: textures.barkNormalMap,
    normalScale: new Vector2(textures.barkNormalScale, textures.barkNormalScale),
    aoMap: textures.barkRoughnessMap,
    aoMapIntensity: 0.45,
    roughnessMap: textures.barkRoughnessMap,
    roughness: 0.92,
    metalness: 0,
  })
  const wood = new Mesh(woodGeometry, woodMaterial)
  wood.name = 'adaptive-woody-topology'
  wood.castShadow = true
  wood.receiveShadow = true
  group.add(wood)

  if (lod.fruits.count > 0) {
    const geometry = new IcosahedronGeometry(1, 2)
    const material = new MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.58,
      metalness: 0,
    })
    const fruits = new InstancedMesh(geometry, material, lod.fruits.count)
    fruits.name = 'fruit-clusters'
    const matrix = new Matrix4()
    const color = new Color()
    for (let index = 0; index < lod.fruits.count; index += 1) {
      fruits.setMatrixAt(index, matrix.fromArray(lod.fruits.matrices, index * 16))
      fruits.setColorAt(index, color.fromArray(lod.fruits.colors, index * 3))
    }
    fruits.instanceMatrix.needsUpdate = true
    if (fruits.instanceColor) fruits.instanceColor.needsUpdate = true
    fruits.castShadow = level === 0
    group.add(fruits)
  }

  // One instanced mesh per atlas spray, matching what the viewport draws — an
  // export that collapses the variants would ship a crown of identical cards.
  for (const [variant, batch] of splitFoliageByVariant(lod.foliage).entries()) {
    if (batch.count === 0) continue
    const clusters = lod.foliage.representation === 'clusters'
    const card = textures.leafCards[variant] ?? textures.leafCards[0]
    const geometry = clusters
      ? new IcosahedronGeometry(1, 1)
      : lod.foliage.cardGeometry === 'frond'
        ? createFrondCardGeometry(variant)
        : lod.foliage.cardGeometry === 'fan-frond'
          ? createPalmFanGeometry(variant)
          : lod.foliage.cardGeometry === 'rosette'
            ? createSucculentRosetteGeometry(variant)
          : createLeafCardGeometry()
    const segmentedFrond = lod.foliage.cardGeometry !== 'spray' && !clusters
    const material = new MeshStandardMaterial({
      color: segmentedFrond ? 0xaaaaaa : 0xffffff,
      vertexColors: true,
      map: clusters || segmentedFrond ? null : card?.map ?? null,
      normalMap: clusters || segmentedFrond ? null : card?.normalMap ?? null,
      normalScale: new Vector2(0.42, 0.42),
      roughness: clusters ? 0.88 : segmentedFrond ? 0.86 : 0.58,
      metalness: 0,
      side: DoubleSide,
      alphaTest: clusters || segmentedFrond ? 0 : 0.36,
      alphaToCoverage: !clusters && !segmentedFrond,
    })
    const foliage = new InstancedMesh(geometry, material, batch.count)
    foliage.name = clusters
      ? 'merged-foliage-clusters'
      : `leaf-spray-cards-${variant}`
    const matrix = new Matrix4()
    const color = new Color()
    for (let index = 0; index < batch.count; index += 1) {
      foliage.setMatrixAt(index, matrix.fromArray(batch.matrices, index * 16))
      foliage.setColorAt(index, color.fromArray(batch.colors, index * 3))
    }
    foliage.instanceMatrix.needsUpdate = true
    if (foliage.instanceColor) foliage.instanceColor.needsUpdate = true
    foliage.castShadow = level < 2
    group.add(foliage)
  }
  return { group, textures }
}
