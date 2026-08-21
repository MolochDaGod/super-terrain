import { at, blurField, createField, type Field, gradient, wrapIndex } from './field'
import { clamp01, fbm } from './noise'

/**
 * Surface weathering fields derived from the finished height.
 *
 * These replace the erosion simulation's own bookkeeping for shading. A
 * droplet path is the right thing to carve rock with and the wrong thing to
 * paint with: the raw deposition record is a set of individual tracks, and
 * smearing them across the albedo leaves visible comet trails. What the eye
 * actually reads on a weathered face is geometric — which facets point up and
 * catch dust, and which parts of the face lie in the runoff shadow of a ledge
 * above them.
 */

/**
 * How strongly each point faces "up" the tile.
 *
 * For a texture mapped onto a vertical face, decreasing v is up, so an
 * upward-facing shelf is one whose height rises as v increases.
 */
export function upFacing(height: Field, scale = 40): Field {
  const out = createField(height.size)
  for (let y = 0; y < height.size; y += 1) {
    for (let x = 0; x < height.size; x += 1) {
      const g = gradient(height, x, y)
      out.data[y * height.size + x] = clamp01(g.gy * scale)
    }
  }
  return out
}

/**
 * Smears a source downward with exponential decay, wrapping cleanly.
 *
 * The carried value accumulates rather than taking a running maximum. A
 * maximum saturates: once the strongest source in a column has been picked
 * up, every pixel below it reports the same value, and with a dense source
 * the whole field collapses to one constant that carries no signal at all.
 * Accumulating instead makes a streak strengthen where several sources feed
 * it and fade where none do, which is also what a wet face does.
 *
 * Two passes over the tile let the trailing edge meet its own head at the
 * wrap, so the streaks stay periodic. Lateral jitter follows a noise field,
 * which keeps the runs from becoming vertical rulings.
 */
export function runoffStain(
  source: Field,
  options: { decay?: number; wander?: number; seed?: number } = {},
): Field {
  const size = source.size
  const decay = options.decay ?? 0.982
  const wander = options.wander ?? size / 90
  const seed = options.seed ?? 0
  const out = createField(size)
  const offsets = new Float32Array(size * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      offsets[y * size + x] =
        fbm((x / size) * 9, (y / size) * 3, 9, seed + 61, { octaves: 3, stretchY: 3 }) * wander
    }
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x
        const carried = at(out, x + offsets[i]!, y - 1) * decay
        out.data[i] = Math.min(4, source.data[i]! + carried)
      }
    }
  }
  return out
}

/**
 * D8 flow accumulation: the drainage area feeding each pixel.
 *
 * Sorting by height and pushing each cell's accumulated water into its
 * steepest downhill neighbour gives connected, correctly branching channels
 * in one pass, without the stochastic streaks a droplet count leaves behind.
 */
export function flowAccumulation(height: Field): Field {
  const size = height.size
  const count = size * size
  const out = createField(size, 1)
  const order = new Uint32Array(count)
  for (let i = 0; i < count; i += 1) order[i] = i
  const data = height.data
  // Sort descending so every cell is processed before anything below it.
  const sorted = Array.from(order).sort((a, b) => data[b]! - data[a]!)
  for (const index of sorted) {
    const x = index % size
    const y = (index / size) | 0
    const h = data[index]!
    let best = h
    let target = -1
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        if (ox === 0 && oy === 0) continue
        const nx = wrapIndex(x + ox, size)
        const ny = wrapIndex(y + oy, size)
        const nh = data[ny * size + nx]!
        if (nh < best) {
          best = nh
          target = ny * size + nx
        }
      }
    }
    if (target >= 0) out.data[target]! += out.data[index]!
  }
  // Drainage area spans several decades; the log makes the whole network
  // visible instead of only the trunk channels.
  for (let i = 0; i < count; i += 1) out.data[i] = Math.log(1 + out.data[i]!)
  return out
}

/**
 * Where fine material comes to rest: up-facing, sheltered and locally flat.
 * The three conditions are multiplied rather than added because silt needs
 * all of them at once.
 */
export function siltDeposit(
  height: Field,
  occlusion: Field,
  options: { scale?: number; smooth?: number } = {},
): Field {
  const size = height.size
  const up = upFacing(height, options.scale ?? 40)
  const out = createField(size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x
      const g = gradient(height, x, y)
      const flat = clamp01(1 - Math.hypot(g.gx, g.gy) * (options.scale ?? 40) * 0.6)
      // Sheltered but not buried: a deep crack collects nothing that a wall
      // does not first shed onto it.
      const shelter = clamp01(1 - Math.abs(occlusion.data[i]! - 0.72) * 2.6)
      out.data[i] = up.data[i]! * flat * (0.35 + shelter * 0.65)
    }
  }
  return blurField(out, options.smooth ?? Math.max(1, size / 512))
}
