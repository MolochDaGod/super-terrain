import { describe, expect, it } from 'vitest'
import {
  appendBrushPoint,
  createBrushStroke,
  createTunnelModifier,
} from '../modifiers/factories'
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

  it('carries every field of a stroke across the worker boundary', () => {
    // The encoder used to restate the descriptor field by field, which made it
    // an allowlist: a property added to BrushStrokeModifier type-checked, drove
    // the viewport preview correctly, and then silently did nothing in the
    // worker. Round-tripping the whole modifier is what keeps preview and
    // compile describing the same edit.
    const stroke = createBrushStroke({
      point: { x: 3, y: 4, z: 5 },
      normal: { x: 0, y: 1, z: 0 },
      domain: 'mesh',
      mode: 'noise',
      radius: 12,
      strength: 0.7,
      falloff: 0.3,
      targetY: 9,
      terraceStep: 2.5,
      noiseScale: 6,
      accumulate: true,
      sculptLayerId: 'layer-1',
      sampleWeight: 0.4,
    })
    appendBrushPoint(stroke, { x: 6, y: 4, z: 5 }, { x: 0, y: 1, z: 0 }, 0.4)
    stroke.sequence = 7

    const [decoded] = decodeModifiers(encodeModifiers([stroke]))
    expect(decoded.type).toBe('brush-stroke')
    if (decoded.type !== 'brush-stroke') return

    // Every key the modifier carries has to survive, not just the ones someone
    // remembered to list.
    for (const key of Object.keys(stroke) as (keyof typeof stroke)[]) {
      if (key === 'points') continue
      expect({ [key]: decoded[key] }).toEqual({ [key]: stroke[key] })
    }
    expect(decoded.points).toHaveLength(stroke.points.length)
    decoded.points.forEach((point, index) => {
      expect(point.x).toBeCloseTo(stroke.points[index].x, 4)
      expect(point.weight).toBeCloseTo(stroke.points[index].weight, 4)
    })
  })
})
