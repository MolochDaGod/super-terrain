import { describe, expect, it } from 'vitest'
import { createBrushStroke, createTunnelModifier } from '../modifiers/factories'
import { EditableMesh, EditableMeshSection } from '../mesh/EditableMesh'
import { decodeModifiers, encodeModifiers, sourceTransferables } from './protocol'

describe('worker modifier protocol', () => {
  it('packs brush points into a transferable typed array', () => {
    const brush = createBrushStroke({
      point: { x: 1, y: 2, z: 3 },
      mode: 'raise',
      radius: 12,
      strength: 0.4,
      falloff: 0.5,
    })
    brush.points.push({
      x: 4,
      y: 5,
      z: 6,
      normal: { x: 1, y: 0, z: 0 },
      weight: 0.5,
    })
    const tunnel = createTunnelModifier({ center: { x: 0, y: 20, z: 0 } })
    const packet = encodeModifiers([brush, tunnel])
    expect(packet.brushPoints).toBeInstanceOf(Float32Array)
    expect(packet.brushPoints).toHaveLength(14)
    expect(decodeModifiers(packet)).toEqual([brush, tunnel])
  })

  it('collects every editable source buffer for one-copy worker transfer', () => {
    const mesh = new EditableMesh(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
      new Uint32Array([0, 2, 1]),
      { sourceId: 'worker-source' },
    )
    mesh.setVertexAttribute('weight', new Float32Array([0.1, 0.2, 0.3]))
    const section = new EditableMeshSection(1)
    section.replaceMesh(mesh, 2)
    const source = section.createCompileSnapshot({ x: 0, z: 0 }, 128)
    const transferables = sourceTransferables(source)

    expect(source.kind).toBe('editable-mesh')
    expect(transferables.length).toBe(8)
    expect(new Set(transferables).size).toBe(transferables.length)
  })
})
