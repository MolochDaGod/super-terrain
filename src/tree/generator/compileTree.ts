import { compileFoliage } from './foliageCompiler'
import { compileFruit } from './fruitCompiler'
import { generateSemanticTree } from './semanticGraph'
import {
  DEFAULT_TREE_ENVIRONMENT,
  normalizeTreeParameters,
  type ProceduralTreeAsset,
  type TreeEnvironment,
  type TreeLodAsset,
  type TreeLodLevel,
  type TreeParameters,
} from './types'
import { compileWoodyMesh } from './woodMesher'

export type TreeCompileProgress = (message: string, amount: number) => void

export function compileProceduralTree(
  input: Partial<TreeParameters> | undefined,
  environment: TreeEnvironment = DEFAULT_TREE_ENVIRONMENT,
  onProgress?: TreeCompileProgress,
): ProceduralTreeAsset {
  const started = performance.now()
  const parameters = normalizeTreeParameters(input)
  onProgress?.('Solving semantic growth graph…', 0.05)
  const graph = generateSemanticTree(parameters, environment)
  const lods: TreeLodAsset[] = []

  for (const level of [0, 1, 2] as const) {
    onProgress?.(
      `Compiling ${lodName(level)} adaptive woody topology…`,
      0.12 + level * 0.27,
    )
    const { mesh, includedPartCount } = compileWoodyMesh(graph, level)
    onProgress?.(`Compiling ${lodName(level)} foliage clusters…`, 0.3 + level * 0.27)
    lods.push({
      level,
      wood: mesh,
      foliage: compileFoliage(graph, parameters, level),
      fruits: compileFruit(graph, level),
      includedPartCount,
    })
  }

  onProgress?.('Tree asset ready', 1)
  return {
    parameters,
    environment,
    graph,
    lods: lods as unknown as readonly [TreeLodAsset, TreeLodAsset, TreeLodAsset],
    stats: {
      generationMs: performance.now() - started,
      partCount: graph.parts.length,
      contactCount: graph.contacts.length,
      foliageClusterCount: graph.foliageClusters.length,
    },
  }
}

export function treeAssetTransferables(asset: ProceduralTreeAsset): Transferable[] {
  const transferables: Transferable[] = []
  for (const lod of asset.lods) {
    transferables.push(
      lod.wood.positions.buffer,
      lod.wood.normals.buffer,
      lod.wood.colors.buffer,
      lod.wood.uvs.buffer,
      lod.wood.indices.buffer,
      lod.foliage.matrices.buffer,
      lod.foliage.colors.buffer,
      lod.foliage.variants.buffer,
      lod.fruits.matrices.buffer,
      lod.fruits.colors.buffer,
    )
  }
  return transferables
}

function lodName(level: TreeLodLevel): string {
  return level === 0 ? 'hero' : level === 1 ? 'medium' : 'far'
}
