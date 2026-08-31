import { afterEach, describe, expect, it } from 'vitest'
import { createFullTerrainMaterial } from '../full/createFullTerrainMaterial'
import {
  getProceduralSurfaceTextures,
  resetProceduralSurfaceTextures,
} from './proceduralSurfaceTextures'

afterEach(() => resetProceduralSurfaceTextures())

describe('procedural surface texture resources', () => {
  it('allocates the final dimensions before WebGPU binds a placeholder', () => {
    const surface = getProceduralSurfaceTextures('cliff-side')

    for (const texture of [
      surface.albedo,
      surface.normal,
      surface.arm,
    ]) {
      expect(texture.image.width).toBe(1024)
      expect(texture.image.height).toBe(1024)
      expect((texture.image.data as Uint8Array).byteLength).toBe(
        1024 * 1024 * 4,
      )
    }
  })

  it('keeps cached maps alive when a full material is replaced', () => {
    const cliff = getProceduralSurfaceTextures('cliff-side')
    const ground = getProceduralSurfaceTextures('rock-ground')
    const textures = [
      cliff.albedo,
      cliff.normal,
      cliff.arm,
      ground.albedo,
      ground.normal,
      ground.arm,
    ]
    let disposeEvents = 0
    for (const texture of textures) {
      texture.addEventListener('dispose', () => {
        disposeEvents += 1
      })
    }

    const handle = createFullTerrainMaterial()
    handle.dispose()
    expect(disposeEvents).toBe(0)

    resetProceduralSurfaceTextures()
    expect(disposeEvents).toBe(textures.length)
  })
})
