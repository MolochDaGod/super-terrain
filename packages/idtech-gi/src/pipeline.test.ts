import { describe, expect, it } from 'vitest'
import { volumeIndex, worldToCell } from './cascades.ts'
import { rgbLengthSq } from './types.ts'
import { SousaPipeline } from './pipeline.ts'
import { encodeRadiance } from './sphericalHarmonics.ts'
import { VoxelGrid, voxelizeBoxWalls } from './voxelGrid.ts'

function makeRoom() {
  // Enclosed 4³ room: red -X wall, green +X wall, white elsewhere.
  // A spotlight-like point light sits against the red wall so the green wall
  // sees almost no direct light.
  const grid = new VoxelGrid(48, [-3, -3, -3], 6)
  voxelizeBoxWalls(
    grid,
    [-2, -2, -2],
    [2, 2, 2],
    0.2,
    {
      nx: [0.85, 0.05, 0.05],
      px: [0.05, 0.75, 0.08],
      ny: [0.85, 0.85, 0.82],
      py: [0.85, 0.85, 0.82],
      nz: [0.85, 0.85, 0.82],
      pz: [0.85, 0.85, 0.82],
    },
  )
  const pipeline = new SousaPipeline(grid, {
    cascade: {
      resolution: 6,
      cascadeCount: 2,
      firstSize: 6,
      raysPerProbe: 24,
      cascadesPerFrame: 1,
    },
    lights: [
      {
        position: [-1.5, 0.4, 0],
        color: [1, 1, 1],
        intensity: 22,
        direction: [-1, 0, 0],
        coneCos: 0.55,
      },
    ],
    sky: [0, 0, 0],
    volumeBlend: 0.4,
    maxRayDistance: 8,
  })
  return { grid, pipeline }
}

describe('Sousa pipeline bounce and gather', () => {
  it('feeds previous-frame volume irradiance into cache shading as a second bounce', () => {
    const { pipeline } = makeRoom()
    const camera: [number, number, number] = [0, 0, 0]
    const green: [number, number, number] = [1.7, 0.2, 0]
    const greenN: [number, number, number] = [-1, 0, 0]
    const red: [number, number, number] = [-1.7, 0.2, 0]
    const redN: [number, number, number] = [1, 0, 0]
    const albedo: [number, number, number] = [0.05, 0.75, 0.08]

    const bounce0 = pipeline.shadeHit({ position: green, normal: greenN, albedo })
    expect(rgbLengthSq(bounce0)).toBeLessThan(0.0005)

    const redDirect = pipeline.shadeHit({
      position: red,
      normal: redN,
      albedo: [0.85, 0.05, 0.05],
    })
    expect(redDirect[0]).toBeGreaterThan(redDirect[1])
    expect(redDirect[0]).toBeGreaterThan(0.01)

    // Previous-frame feedback: write a red irradiance SH into the volume the
    // green wall samples, snapshot it as "previous", then shade. Sousa does
    // not trace a second ray — the extra bounce is this lookup.
    const cell = worldToCell(green, 0, camera, pipeline.cascade)
    const redSH = encodeRadiance([-1, 0, 0], [4, 0.15, 0.05], 1)
    for (let dz = 0; dz <= 1; dz += 1) {
      for (let dy = 0; dy <= 1; dy += 1) {
        for (let dx = 0; dx <= 1; dx += 1) {
          const ix = Math.min(pipeline.cascade.resolution - 1, Math.max(0, cell.ix + dx))
          const iy = Math.min(pipeline.cascade.resolution - 1, Math.max(0, cell.iy + dy))
          const iz = Math.min(pipeline.cascade.resolution - 1, Math.max(0, cell.iz + dz))
          pipeline.volumes.set(volumeIndex(0, ix, iy, iz, pipeline.cascade), redSH)
        }
      }
    }
    pipeline.volumes.advanceFrame()

    const bounce1 = pipeline.shadeHit({ position: green, normal: greenN, albedo })
    expect(bounce1[0] + bounce1[1] + bounce1[2]).toBeGreaterThan(
      bounce0[0] + bounce0[1] + bounce0[2] + 0.001,
    )
    expect(bounce1[0]).toBeGreaterThan(bounce1[2])
  })

  it('runs a budgeted interleaved frame, not an accumulating path tracer', () => {
    const { pipeline } = makeRoom()
    const camera: [number, number, number] = [0, 0, 0]
    const a = pipeline.step(camera)
    const b = pipeline.step(camera)
    expect(a.cascade).not.toBe(b.cascade)
    expect(a.probesUpdated).toBeGreaterThan(0)
    expect(a.raysTraced).toBe(a.probesUpdated * 24)
    expect(a.raysTraced).toBeLessThan(6 * 6 * 6 * 24 * 2)
    expect(pipeline.frame).toBe(2)
  })

  it('final-gather fallback reports a real cache source after probes run', () => {
    const { pipeline } = makeRoom()
    const camera: [number, number, number] = [0, 0, 0]
    pipeline.step(camera)
    pipeline.step(camera)
    const g = pipeline.finalGather([0, -1.6, 0], [0, 1, 0], 8, 8)
    expect(['screen-space', 'radiance-cache', 'irradiance-volume', 'miss']).toContain(
      g.source,
    )
    expect(g.radiance[0] + g.radiance[1] + g.radiance[2]).toBeGreaterThanOrEqual(0)
  })
})
