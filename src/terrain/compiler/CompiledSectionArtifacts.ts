import { unionBounds } from '../core/bounds'
import type {
  CompiledLOD,
  CompiledSection,
  CompiledTerrainMetadata,
} from '../core/types'

/** CPU ownership carried by one compiled level, including editor identity. */
export function compiledLodCpuBytes(lod: CompiledLOD): number {
  return (
    lod.gpuBytes +
    (lod.stableVertexIds?.byteLength ?? 0) +
    (lod.sourceVertexIndices?.byteLength ?? 0)
  )
}

/**
 * Keeps an existing subset without copying its immutable buffers.
 *
 * A compiled level is already a valid result for its source revision. Throwing
 * fine levels away to reclaim memory must therefore be a reference operation,
 * not another terrain build.
 */
export function retainCompiledLevels(
  compiled: CompiledSection,
  levels: ReadonlySet<number> | readonly number[],
): CompiledSection | undefined {
  const levelSet = toLevelSet(levels)
  const retained = compiled.lods.filter((lod) => levelSet.has(lod.level))
  if (retained.length === 0) return undefined
  if (
    retained.length === compiled.lods.length &&
    retained.every((lod, index) => lod === compiled.lods[index])
  ) {
    return compiled
  }
  return withLods(compiled, retained)
}

/**
 * Combines independently compiled levels of the same immutable section input.
 * New levels win if both artifacts contain one, while untouched levels retain
 * their exact buffers. The optional retained set applies the current memory
 * policy after the merge (for example, a job retargeted while the camera flew
 * away).
 */
export function mergeCompiledLevels(
  existing: CompiledSection | undefined,
  update: CompiledSection,
  retainedLevels?: ReadonlySet<number> | readonly number[],
): CompiledSection {
  const canMerge =
    existing !== undefined &&
    existing.sourceRevision === update.sourceRevision &&
    existing.key.x === update.key.x &&
    existing.key.z === update.key.z
  if (!canMerge) {
    return retainedLevels
      ? retainCompiledLevels(update, retainedLevels) ?? update
      : update
  }

  const byLevel = new Map<number, CompiledLOD>()
  for (const lod of existing.lods) byLevel.set(lod.level, lod)
  for (const lod of update.lods) byLevel.set(lod.level, lod)
  let lods = [...byLevel.values()].sort((a, b) => a.level - b.level)
  if (retainedLevels) {
    const retained = toLevelSet(retainedLevels)
    lods = lods.filter((lod) => retained.has(lod.level))
  }
  if (lods.length === 0) return update

  const metadataSource = metadataForFinestLevel(existing, update, lods[0].level)
  return withLods(
    {
      ...update,
      bounds: unionBounds(existing.bounds, update.bounds),
      metadata: metadataSource,
    },
    lods,
  )
}

export function missingCompiledLevels(
  compiled: CompiledSection | undefined,
  desiredLevels: readonly number[],
  revision: number,
): number[] {
  if (!compiled || compiled.sourceRevision !== revision) return [...desiredLevels]
  const present = new Set(compiled.lods.map((lod) => lod.level))
  return desiredLevels.filter((level) => !present.has(level))
}

function toLevelSet(
  levels: ReadonlySet<number> | readonly number[],
): ReadonlySet<number> {
  return 'has' in levels ? levels : new Set(levels)
}

function withLods(
  base: CompiledSection,
  lods: readonly CompiledLOD[],
): CompiledSection {
  const ordered = [...lods].sort((a, b) => a.level - b.level)
  const finest = ordered[0]
  const previousVertexCount = Math.max(1, base.metadata.vertexCount)
  const vertexCount = finest.positions.length / 3
  const density = base.metadata.density * vertexCount / previousVertexCount
  return {
    ...base,
    lods: ordered,
    cpuBytes: ordered.reduce(
      (bytes, lod) => bytes + compiledLodCpuBytes(lod),
      0,
    ),
    gpuBytes: ordered.reduce((bytes, lod) => bytes + lod.gpuBytes, 0),
    metadata: {
      ...base.metadata,
      vertexCount,
      triangleCount: finest.triangleCount,
      density,
    },
  }
}

function metadataForFinestLevel(
  existing: CompiledSection,
  update: CompiledSection,
  finestLevel: number,
): CompiledTerrainMetadata {
  const updateOwnsFinest = update.lods.some((lod) => lod.level === finestLevel)
  return updateOwnsFinest ? update.metadata : existing.metadata
}
