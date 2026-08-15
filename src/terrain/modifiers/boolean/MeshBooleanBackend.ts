import type { BooleanSubtractModifier } from '../types'

export interface BooleanMeshBuffers {
  positions: number[]
  indices: number[]
  surfaceVertexCount: number
}

export interface MeshBooleanBackend {
  readonly id: string
  appendSubtractionInterior(
    target: BooleanMeshBuffers,
    modifier: BooleanSubtractModifier,
    sectionOriginX: number,
    sectionOriginZ: number,
    sectionSize: number,
    detail: number,
  ): void
}

/**
 * A deterministic capsule-tunnel backend used by the worker compiler. It emits
 * real interior wall, ceiling, floor and underside topology. The public
 * interface lets a robust WASM CSG implementation replace it without touching
 * WorldTerrain, streaming, or rendering code.
 */
export class AnalyticTunnelBooleanBackend implements MeshBooleanBackend {
  readonly id = 'analytic-tunnel-v1'

  appendSubtractionInterior(
    target: BooleanMeshBuffers,
    modifier: BooleanSubtractModifier,
    sectionOriginX: number,
    sectionOriginZ: number,
    sectionSize: number,
    detail: number,
  ): void {
    const longitudinalSegments = Math.max(8, Math.round(18 * detail))
    const radialSegments = Math.max(8, Math.round(14 * detail))
    const direction = modifier.direction
    const perpendicular = { x: -direction.z, z: direction.x }

    for (let segment = 0; segment < longitudinalSegments; segment += 1) {
      const t0 = segment / longitudinalSegments - 0.5
      const t1 = (segment + 1) / longitudinalSegments - 0.5
      const mid = (t0 + t1) * 0.5
      const midX = modifier.center.x + direction.x * modifier.length * mid
      const midZ = modifier.center.z + direction.z * modifier.length * mid
      if (
        midX < sectionOriginX ||
        midX >= sectionOriginX + sectionSize ||
        midZ < sectionOriginZ ||
        midZ >= sectionOriginZ + sectionSize
      ) {
        continue
      }

      for (let radial = 0; radial < radialSegments; radial += 1) {
        const angle0 = (radial / radialSegments) * Math.PI * 2
        const angle1 = ((radial + 1) / radialSegments) * Math.PI * 2
        const base = target.positions.length / 3
        appendTunnelVertex(target.positions, modifier, perpendicular, t0, angle0, sectionOriginX, sectionOriginZ)
        appendTunnelVertex(target.positions, modifier, perpendicular, t1, angle0, sectionOriginX, sectionOriginZ)
        appendTunnelVertex(target.positions, modifier, perpendicular, t1, angle1, sectionOriginX, sectionOriginZ)
        appendTunnelVertex(target.positions, modifier, perpendicular, t0, angle1, sectionOriginX, sectionOriginZ)
        target.indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
      }
    }
  }
}

function appendTunnelVertex(
  positions: number[],
  modifier: BooleanSubtractModifier,
  perpendicular: { x: number; z: number },
  along: number,
  angle: number,
  sectionOriginX: number,
  sectionOriginZ: number,
): void {
  const horizontal = Math.cos(angle) * modifier.radius
  const vertical = Math.sin(angle) * modifier.radius
  const worldX =
    modifier.center.x +
    modifier.direction.x * modifier.length * along +
    perpendicular.x * horizontal
  const worldZ =
    modifier.center.z +
    modifier.direction.z * modifier.length * along +
    perpendicular.z * horizontal
  positions.push(
    worldX - sectionOriginX,
    modifier.center.y + vertical,
    worldZ - sectionOriginZ,
  )
}
