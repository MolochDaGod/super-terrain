import { clamp, smoothstep } from '../core/bounds'
import type { CompiledLOD, CompiledSection } from '../core/types'
import type { TerrainModifier, WeightPaintModifier } from '../modifiers/types'
import { paintChannelIndex } from '../rendering/materialSettings'
import { nearbyBrushSampleIndices } from './BrushSampleIndex'

const PACKED_UNIT_MAX = 65_535

export function calculatePaintWeights(
  positions: Float32Array,
  originX: number,
  originZ: number,
  modifiers: readonly TerrainModifier[],
): Uint16Array {
  const strokes = modifiers.filter(
    (modifier): modifier is WeightPaintModifier =>
      modifier.enabled && modifier.type === 'weight-paint',
  )
  const weights = new Float32Array((positions.length / 3) * 4)

  for (const stroke of strokes) {
    const channel = paintChannelIndex(stroke.channel)
    const direction = stroke.mode === 'subtract' ? -1 : 1
    const exponent = 1 + clamp(stroke.falloff, 0, 1) * 4
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      const positionOffset = vertex * 3
      const worldX = originX + positions[positionOffset]
      const worldY = positions[positionOffset + 1]
      const worldZ = originZ + positions[positionOffset + 2]
      let influence = 0
      for (const sampleIndex of nearbyBrushSampleIndices(
        stroke,
        { x: worldX, y: worldY, z: worldZ },
      )) {
        const sample = stroke.points[sampleIndex]
        const distance = Math.hypot(
          worldX - sample.x,
          worldY - sample.y,
          worldZ - sample.z,
        )
        if (distance >= stroke.radius) continue
        const radial = 1 - distance / Math.max(0.001, stroke.radius)
        influence +=
          Math.pow(smoothstep(0, 1, radial), exponent) * sample.weight
      }
      if (influence <= 0) continue
      const target = vertex * 4 + channel
      weights[target] = clamp(
        weights[target] + direction * influence * stroke.strength,
        0,
        1,
      )
    }
  }

  const packed = new Uint16Array(weights.length)
  for (let index = 0; index < weights.length; index += 1) {
    packed[index] = Math.round(clamp(weights[index], 0, 1) * PACKED_UNIT_MAX)
  }
  return packed
}

/**
 * Re-evaluates paint while sharing geometry and every analysis buffer.
 * Coherent artifacts evaluate only authoritative LOD0 and propagate through
 * exact provenance. Legacy or independently streamed levels evaluate their
 * retained positions directly, which is still exact because paint is a pure
 * vertex attribute and never changes terrain topology.
 */
export function repaintCompiledSection(
  compiled: CompiledSection,
  revision: number,
  sectionSize: number,
  modifiers: readonly TerrainModifier[],
): CompiledSection | undefined {
  if (compiled.lods.length === 0) return undefined
  const source = compiled.lods.find(
    (lod) => lod.level === 0 && lod.sourceLevel === 0,
  )
  const originX = compiled.key.x * sectionSize
  const originZ = compiled.key.z * sectionSize
  const sourceVertexCount = source ? source.positions.length / 3 : 0
  const hasCoherentProvenance =
    source !== undefined &&
    compiled.lods.every(
      (lod) =>
        lod.sourceLevel === 0 &&
        lod.sourceVertexIndices?.length === lod.positions.length / 3 &&
        lod.sourceVertexIndices.every(
          (sourceVertex) => sourceVertex < sourceVertexCount,
        ),
    )
  let lods: CompiledLOD[]
  if (source && hasCoherentProvenance) {
    const sourceWeights = calculatePaintWeights(
      source.positions,
      originX,
      originZ,
      modifiers,
    )
    lods = compiled.lods.map((lod) =>
      repaintLod(lod, source, sourceWeights),
    )
  } else {
    lods = compiled.lods.map((lod) => ({
      ...lod,
      paintWeights: calculatePaintWeights(
        lod.positions,
        originX,
        originZ,
        modifiers,
      ),
    }))
  }
  return {
    ...compiled,
    sourceRevision: revision,
    lods,
    metadata: { ...compiled.metadata, compileMs: 0 },
  }
}

function repaintLod(
  lod: CompiledLOD,
  source: CompiledLOD,
  sourceWeights: Uint16Array,
): CompiledLOD {
  if (lod === source) return { ...lod, paintWeights: sourceWeights }
  const provenance = lod.sourceVertexIndices!
  const paintWeights = new Uint16Array(provenance.length * 4)
  for (let vertex = 0; vertex < provenance.length; vertex += 1) {
    const sourceOffset = provenance[vertex] * 4
    const targetOffset = vertex * 4
    paintWeights[targetOffset] = sourceWeights[sourceOffset]
    paintWeights[targetOffset + 1] = sourceWeights[sourceOffset + 1]
    paintWeights[targetOffset + 2] = sourceWeights[sourceOffset + 2]
    paintWeights[targetOffset + 3] = sourceWeights[sourceOffset + 3]
  }
  return { ...lod, paintWeights }
}
