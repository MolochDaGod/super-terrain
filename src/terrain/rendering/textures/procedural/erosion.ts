import {
  at,
  cloneField,
  createField,
  createWrapTable,
  type Field,
  sampleBilinear,
  wrapIndex,
} from './field'
import { makeRng } from './noise'

export interface HydraulicOptions {
  /** Number of simulated droplets. Cost is linear; 60k on 512 is plenty. */
  droplets?: number
  /** Steps a droplet may take before it is retired. */
  maxSteps?: number
  /** Sediment a droplet may hold per unit of (speed x slope). */
  capacity?: number
  /** Fraction of the excess picked up per step. */
  erodeRate?: number
  /** Fraction of the surplus dropped per step. */
  depositRate?: number
  /** Water lost per step. */
  evaporation?: number
  inertia?: number
  gravity?: number
  /** Radius, in pixels, over which a droplet takes material. */
  erosionRadius?: number
  /**
   * Constant downhill bias added to the flow direction, in gradient units.
   * A cliff face drains vertically, and tilting the height field to express
   * that would break the tile wrap, so the bias is applied to the droplet
   * instead of to the terrain.
   */
  biasX?: number
  biasY?: number
  seed?: number
}

/**
 * Droplet hydraulic erosion on a toroidal height field.
 *
 * This is the pass that separates a believable rock surface from stacked
 * noise: it carves connected drainage, undercuts the downhill side of every
 * obstruction and silts up the hollows, producing the correlated
 * height/cavity/deposition structure that a photogrammetry scan has and a
 * plain fBm never does. It also returns where sediment ended up, which the
 * albedo stage uses to place dust and silt.
 */
export function hydraulicErosion(
  height: Field,
  options: HydraulicOptions = {},
): { height: Field; deposition: Field; flow: Field } {
  const size = height.size
  const out = cloneField(height)
  const deposition = createField(size)
  const flow = createField(size)
  const droplets = options.droplets ?? 60_000
  const maxSteps = options.maxSteps ?? 48
  const capacityFactor = options.capacity ?? 4
  const erodeRate = options.erodeRate ?? 0.3
  const depositRate = options.depositRate ?? 0.3
  const evaporation = options.evaporation ?? 0.02
  const inertia = options.inertia ?? 0.05
  const gravity = options.gravity ?? 4
  const biasX = options.biasX ?? 0
  const biasY = options.biasY ?? 0
  const radius = Math.max(1, Math.round(options.erosionRadius ?? 2))
  const rng = makeRng(options.seed ?? 1337)

  // Precomputed brush: spreading the removal over a disc stops the droplet
  // paths from becoming one-pixel-wide scratches.
  const brushOffsets: number[] = []
  const brushWeights: number[] = []
  let weightSum = 0
  for (let by = -radius; by <= radius; by += 1) {
    for (let bx = -radius; bx <= radius; bx += 1) {
      const d = Math.hypot(bx, by)
      if (d > radius) continue
      const w = 1 - d / (radius + 1)
      brushOffsets.push(bx, by)
      brushWeights.push(w)
      weightSum += w
    }
  }
  for (let i = 0; i < brushWeights.length; i += 1) brushWeights[i]! /= weightSum

  const gradientAt = (x: number, y: number) => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const h00 = at(out, x0, y0)
    const h10 = at(out, x0 + 1, y0)
    const h01 = at(out, x0, y0 + 1)
    const h11 = at(out, x0 + 1, y0 + 1)
    return {
      gx: (h10 - h00) * (1 - fy) + (h11 - h01) * fy,
      gy: (h01 - h00) * (1 - fx) + (h11 - h10) * fx,
      h: (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy,
    }
  }

  // Deposition uses the same disc as erosion. Dropping sediment into the four
  // cells under the droplet builds a one-pixel raised trail along every path,
  // and those trails are legible in the normal map as bright hairlines
  // wandering across the surface — the mirror image of the scratches that
  // unbrushed erosion leaves.
  const deposit = (x: number, y: number, amount: number) => {
    const cx = Math.floor(x)
    const cy = Math.floor(y)
    for (let i = 0, b = 0; i < brushWeights.length; i += 1, b += 2) {
      const idx =
        wrapIndex(cy + brushOffsets[b + 1]!, size) * size +
        wrapIndex(cx + brushOffsets[b]!, size)
      const share = amount * brushWeights[i]!
      out.data[idx]! += share
      deposition.data[idx]! += share
    }
  }

  for (let d = 0; d < droplets; d += 1) {
    let px = rng() * size
    let py = rng() * size
    let dx = 0
    let dy = 0
    let speed = 1
    let water = 1
    let sediment = 0

    for (let step = 0; step < maxSteps; step += 1) {
      const cell = gradientAt(px, py)
      dx = dx * inertia - (cell.gx - biasX) * (1 - inertia)
      dy = dy * inertia - (cell.gy - biasY) * (1 - inertia)
      const len = Math.hypot(dx, dy)
      if (len < 1e-6) {
        // Stalled in a flat or a pit: drop everything and stop.
        deposit(px, py, sediment)
        break
      }
      dx /= len
      dy /= len
      const nx = px + dx
      const ny = py + dy
      const newHeight = gradientAt(nx, ny).h
      const delta = newHeight - cell.h
      // The bias represents the slope of the face the tile is mapped onto.
      // Including its contribution here makes the droplet behave exactly as
      // it would on that tilted surface, while the stored field stays
      // periodic.
      const drop = delta - (biasX * dx + biasY * dy)

      flow.data[wrapIndex(Math.floor(py), size) * size + wrapIndex(Math.floor(px), size)]! += water

      if (drop > 0) {
        // Ran uphill: backfill the pit up to the lip, no further.
        const fill = Math.min(Math.max(delta, 0), sediment)
        deposit(px, py, fill)
        sediment -= fill
      } else {
        const capacity = Math.max(-drop * speed * water * capacityFactor, 0.0001)
        if (sediment > capacity) {
          const drop = (sediment - capacity) * depositRate
          deposit(px, py, drop)
          sediment -= drop
        } else {
          const take = Math.min((capacity - sediment) * erodeRate, -drop)
          for (let i = 0, b = 0; i < brushWeights.length; i += 1, b += 2) {
            const idx =
              wrapIndex(Math.floor(py) + brushOffsets[b + 1]!, size) * size +
              wrapIndex(Math.floor(px) + brushOffsets[b]!, size)
            out.data[idx]! -= take * brushWeights[i]!
          }
          sediment += take
        }
      }

      speed = Math.sqrt(Math.max(0, speed * speed + -drop * gravity))
      water *= 1 - evaporation
      px = nx
      py = ny
      if (water < 0.01) {
        deposit(px, py, sediment)
        break
      }
    }
  }

  return { height: out, deposition, flow }
}

export interface ThermalOptions {
  iterations?: number
  /** Slope, in height units per pixel, above which material slides. */
  talusAngle?: number
  /** Fraction of the excess moved per iteration. */
  rate?: number
}

/**
 * Thermal weathering: material above the talus angle creeps downhill.
 *
 * On a rock face this is what rounds fracture edges into the bevelled,
 * chipped profile of real weathered stone and builds the small scree wedges
 * that collect on every ledge.
 */
export function thermalErosion(height: Field, options: ThermalOptions = {}): Field {
  const iterations = options.iterations ?? 24
  const talus = options.talusAngle ?? 0.008
  const rate = options.rate ?? 0.5
  const size = height.size
  const current = cloneField(height)
  const delta = createField(size)
  const wrap = createWrapTable(size)
  const data = current.data
  const change = delta.data

  const offsetX = [-1, 1, 0, 0, -1, 1, -1, 1]
  const offsetY = [0, 0, -1, 1, -1, -1, 1, 1]
  const limits = [talus, talus, talus, talus].concat(
    new Array(4).fill(talus * Math.SQRT2),
  )
  const excess = new Float64Array(8)

  for (let iter = 0; iter < iterations; iter += 1) {
    change.fill(0)
    for (let y = 0; y < size; y += 1) {
      const rows = [
        wrap[y - 1 + size]! * size,
        y * size,
        wrap[y + 1 + size]! * size,
      ]
      for (let x = 0; x < size; x += 1) {
        const index = rows[1]! + x
        const h = data[index]!
        const left = wrap[x - 1 + size]!
        const right = wrap[x + 1 + size]!
        const columns = [left, x, right]
        let total = 0
        let maxExcess = 0
        for (let n = 0; n < 8; n += 1) {
          const e = h - data[rows[offsetY[n]! + 1]! + columns[offsetX[n]! + 1]!]! - limits[n]!
          excess[n] = e > 0 ? e : 0
          if (e > 0) {
            total += e
            if (e > maxExcess) maxExcess = e
          }
        }
        if (total <= 0) continue
        const moved = maxExcess * rate * 0.5
        change[index]! -= moved
        const share = moved / total
        for (let n = 0; n < 8; n += 1) {
          if (excess[n]! <= 0) continue
          change[rows[offsetY[n]! + 1]! + columns[offsetX[n]! + 1]!]! += excess[n]! * share
        }
      }
    }
    for (let i = 0; i < data.length; i += 1) data[i]! += change[i]!
  }
  return current
}

/**
 * Anisotropic smoothing that preserves discontinuities.
 *
 * Rock has smooth facets separated by hard fracture edges. A plain blur
 * destroys the edges; this keeps them while removing the noise mush between,
 * which is exactly the "carved from a solid" look scans have.
 */
export function bilateralSmooth(field: Field, spatial: number, range: number, iterations = 1): Field {
  const size = field.size
  let src = cloneField(field)
  const r = Math.max(1, Math.round(spatial))
  const spatialWeights: number[] = []
  for (let oy = -r; oy <= r; oy += 1) {
    for (let ox = -r; ox <= r; ox += 1) {
      spatialWeights.push(Math.exp(-(ox * ox + oy * oy) / (2 * spatial * spatial)))
    }
  }
  const inv = 1 / (2 * range * range)
  for (let iter = 0; iter < iterations; iter += 1) {
    const dst = createField(size)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const centre = src.data[y * size + x]!
        let sum = 0
        let weight = 0
        let w = 0
        for (let oy = -r; oy <= r; oy += 1) {
          for (let ox = -r; ox <= r; ox += 1, w += 1) {
            const v = at(src, x + ox, y + oy)
            const diff = v - centre
            const wt = spatialWeights[w]! * Math.exp(-diff * diff * inv)
            sum += v * wt
            weight += wt
          }
        }
        dst.data[y * size + x] = sum / weight
      }
    }
    src = dst
  }
  return src
}

/** Convenience wrapper used by the recipes; keeps sampling explicit. */
export function sampleField(field: Field, x: number, y: number): number {
  return sampleBilinear(field, x, y)
}
