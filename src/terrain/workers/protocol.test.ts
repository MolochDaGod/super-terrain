import { describe, expect, it } from 'vitest'
import { createBrushStroke, createTunnelModifier } from '../modifiers/factories'
import { decodeModifiers, encodeModifiers } from './protocol'

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
})
