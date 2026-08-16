import {
  Fn,
  abs,
  float,
  floor,
  fract,
  max,
  min,
  mix,
  mx_noise_float,
  smoothstep,
  vec2,
  vec3,
} from 'three/tsl'

/**
 * Shared procedural fields.
 *
 * Every material layer is derived from the same handful of noise evaluations
 * rather than owning private ones. That keeps the fragment cost roughly
 * constant as layers are added, and it makes layers agree with each other:
 * a pebble that pushes through the grass is the same pebble the gravel layer
 * sees, so height blending produces real interlocking instead of a cross-fade.
 *
 * The `*Lod` variants are the important ones. They fade each octave out
 * individually as its wavelength approaches the size of a pixel, which is the
 * only way to keep detail present at 1 km without it turning into shimmer at
 * 5 m. A single whole-band fade — the naive approach — either aliases up close
 * or dissolves everything into flat grey at range.
 *
 * Octave counts are plain JavaScript numbers, not nodes, so each call unrolls
 * to exactly the taps it asked for. Passing them as uniforms and masking the
 * unused ones — the obvious first cut — makes every call pay for the maximum.
 */

/** Descending smoothstep, usable before `falloff` is defined below. */
function falloffRaw(high: any, low: any, value: any): any {
  return smoothstep(low, high, value).oneMinus()
}

/**
 * Pixel footprints, in multiples of a feature's size, between which a detail
 * band fades out. A band is dead once a pixel is `*_FADE_END` times its size.
 *
 * These are exported because the branches that skip a band must be placed at
 * exactly the footprint where the band has already reached zero. Cutting a
 * branch while its contents still contribute leaves a step in the output, and
 * the quantity being compared — the screen-space derivative of world position —
 * is itself noisy from pixel to pixel on a bumpy surface at a grazing angle. So
 * pixels either side of the threshold interleave, and a step becomes a field of
 * salt-and-pepper glitter rather than a visible seam. Deriving one from the
 * other is the only way to keep them from drifting apart.
 */
export const LOD_FADE_END = 6.5
const LOD_FADE_START = 2.2
export const DETAIL_FADE_END = 5.5
const DETAIL_FADE_START = 2.0

/** Footprint at which a band-limited fBm or ridge stack has fully faded. */
export function lodDeadFootprint(wavelength: number): number {
  return wavelength * LOD_FADE_END
}

/** Footprint at which a discrete `detailFade` band has fully faded. */
export function detailDeadFootprint(featureSize: number): number {
  return featureSize * DETAIL_FADE_END
}

/**
 * Mean of the shaped ridge term, used so a fading octave dissolves into its own
 * average rather than into zero.
 */
const RIDGE_MEAN = 0.29

/**
 * Band-limited fBm in [0, 1]. `wavelength` is the world size of the first
 * octave; `footprint` is the world size of one pixel.
 */
export function fbmLod(
  position: any,
  wavelength: any,
  octaves: number,
  footprint: any,
): any {
  const sum = float(0).toVar()
  let total = 0.0001
  let amplitude = 1
  let frequency = 1
  for (let octave = 0; octave < octaves; octave += 1) {
    const scale = float(frequency).div(wavelength)
    // Nyquist-style fade: an octave is worth sampling only while its
    // wavelength is comfortably larger than a pixel. The margin has to be
    // generous because this field is differentiated to build the normal, and a
    // derivative needs several times the sample density that a value does — at
    // three samples per wavelength the value is merely soft, but its gradient
    // is already noise, which arrives on screen as salt-and-pepper glitter.
    const visible = falloffRaw(float(LOD_FADE_END).div(scale), float(LOD_FADE_START).div(scale), footprint)
    sum.addAssign(mx_noise_float(position.mul(scale)).mul(amplitude).mul(visible))
    total += amplitude
    amplitude *= 0.52
    frequency *= 2.07
  }
  return sum.div(total).mul(0.5).add(0.5).clamp(0, 1)
}

/**
 * Evaluates one fBm stack and exposes both the complete signal and its fine
 * octaves. Callers that need macro variation plus a finer material band can
 * reuse the same taps instead of evaluating an overlapping second stack.
 */
export function fbmLodBands(
  position: any,
  wavelength: any,
  octaves: number,
  fineFromOctave: number,
  footprint: any,
): { value: any; fine: any } {
  const sum = float(0).toVar()
  const fineSum = float(0).toVar()
  let total = 0.0001
  let fineTotal = 0.0001
  let amplitude = 1
  let frequency = 1
  for (let octave = 0; octave < octaves; octave += 1) {
    const scale = float(frequency).div(wavelength)
    const visible = falloffRaw(float(LOD_FADE_END).div(scale), float(LOD_FADE_START).div(scale), footprint)
    const weighted = mx_noise_float(position.mul(scale)).mul(amplitude).mul(visible)
    sum.addAssign(weighted)
    if (octave >= fineFromOctave) {
      fineSum.addAssign(weighted)
      fineTotal += amplitude
    }
    total += amplitude
    amplitude *= 0.52
    frequency *= 2.07
  }
  return {
    value: sum.div(total).mul(0.5).add(0.5).clamp(0, 1),
    fine: fineSum.div(fineTotal).mul(0.5).add(0.5).clamp(0, 1),
  }
}

/**
 * Band-limited ridge noise in [0, 1]: sharp crests, smooth flanks. This is the
 * basis for cracks, erosion runnels and the broken edges of rock benches.
 */
export function ridgedLod(
  position: any,
  wavelength: any,
  octaves: number,
  footprint: any,
): any {
  const sum = float(0).toVar()
  let total = 0.0001
  let amplitude = 1
  let frequency = 1
  const weightCarry = float(1).toVar()
  for (let octave = 0; octave < octaves; octave += 1) {
    const scale = float(frequency).div(wavelength)
    const visible = falloffRaw(float(LOD_FADE_END).div(scale), float(LOD_FADE_START).div(scale), footprint)
    const ridge = abs(mx_noise_float(position.mul(scale))).oneMinus()
    const shaped = ridge.mul(ridge).mul(weightCarry)
    // Carrying the previous octave's value forward concentrates the fine
    // detail onto the crests, which is what makes ridge noise read as rock
    // rather than as crumpled foil.
    weightCarry.assign(shaped.mul(2.1).clamp(0, 1))
    // Unlike signed fBm, whose mean is zero, a ridge term averages well above
    // it. Multiplying by the visibility would therefore fade the field towards
    // black instead of towards grey, and distant rock would darken as its
    // cracks dissolved; blending to the mean keeps the average constant across
    // the whole fade.
    sum.addAssign(mix(float(RIDGE_MEAN), shaped, visible).mul(amplitude))
    total += amplitude
    amplitude *= 0.55
    frequency *= 2.07
  }
  return sum.div(total).clamp(0, 1)
}

/**
 * Cellular field used for pebbles, scree and the blocky break-up of cliff faces.
 * Returns `x` = smooth distance to the nearest cell centre (0 at the centre),
 * `y` = a stable per-cell random value, `z` = distance to the second centre,
 * which gives clean cell borders for cracks.
 */
export const cells = /*@__PURE__*/ Fn(([position]: [any]) => {
  const base = vec3(floor(position)).toVar()
  const local = vec3(fract(position)).toVar()
  const nearest = float(8).toVar()
  const second = float(8).toVar()
  const identifier = float(0).toVar()

  // 2x2x2 rather than the textbook 3x3x3. The nearest-centre distance is
  // occasionally wrong near a cell corner, which for pebbles and joint blocks
  // is invisible — and it is a third of the hashing work.
  // Pick the 2x2x2 block on the side of the cell the sample actually sits in.
  const corner = vec3(
    local.x.greaterThan(0.5).select(float(0), float(-1)),
    local.y.greaterThan(0.5).select(float(0), float(-1)),
    local.z.greaterThan(0.5).select(float(0), float(-1)),
  ).toVar()
  for (let z = 0; z <= 1; z += 1) {
    for (let y = 0; y <= 1; y += 1) {
      for (let x = 0; x <= 1; x += 1) {
        const offset = corner.add(vec3(float(x), float(y), float(z)))
        const cell = base.add(offset)
        const random = hash33(cell)
        const centre = offset.add(random)
        const distance = centre.sub(local).length()
        identifier.assign(distance.lessThan(nearest).select(random.x, identifier))
        second.assign(min(second, max(distance, nearest)))
        nearest.assign(min(nearest, distance))
      }
    }
  }
  return vec3(nearest, identifier, second)
})

/**
 * Horizontal cellular field for materials that only occur on holdable ground.
 * It retains the same world-space cell construction as `cells`, but a 2x2
 * search replaces the 2x2x2 volume search when the surface is known to be
 * ground-facing.
 */
export const cells2 = /*@__PURE__*/ Fn(([position]: [any]) => {
  const base = vec2(floor(position)).toVar()
  const local = vec2(fract(position)).toVar()
  const nearest = float(8).toVar()
  const second = float(8).toVar()
  const identifier = float(0).toVar()
  const corner = vec2(
    local.x.greaterThan(0.5).select(float(0), float(-1)),
    local.y.greaterThan(0.5).select(float(0), float(-1)),
  ).toVar()

  for (let y = 0; y <= 1; y += 1) {
    for (let x = 0; x <= 1; x += 1) {
      const offset = corner.add(vec2(float(x), float(y)))
      const cell = base.add(offset)
      const random = hash22(cell)
      const centre = offset.add(random)
      const distance = centre.sub(local).length()
      identifier.assign(distance.lessThan(nearest).select(random.x, identifier))
      second.assign(min(second, max(distance, nearest)))
      nearest.assign(min(nearest, distance))
    }
  }
  return vec3(nearest, identifier, second)
})

/** Two decorrelated hashes of a 2D lattice point in one pass. */
export const hash22 = /*@__PURE__*/ Fn(([cell]: [any]) => {
  const value = fract(vec3(cell.x, cell.y, cell.x).mul(vec3(0.1031, 0.103, 0.0973))).toVar()
  value.addAssign(value.dot(value.yzx.add(33.33)))
  return fract(value.xx.add(value.yz).mul(value.zy))
})

/** Three decorrelated hashes of a lattice point in one pass. */
export const hash33 = /*@__PURE__*/ Fn(([cell]: [any]) => {
  const value = fract(vec3(cell).mul(vec3(0.1031, 0.103, 0.0973))).toVar()
  value.addAssign(value.dot(value.yxz.add(33.33)))
  return fract(value.xxy.add(value.yxx).mul(value.zyx))
})

/** Cheap stable hash of an integer lattice point, in [0, 1). */
export const hash13 = /*@__PURE__*/ Fn(([cell]: [any]) => {
  const value = fract(vec3(cell).mul(vec3(0.1031, 0.1030, 0.0973))).toVar()
  const dotted = value.add(value.dot(value.yzx.add(33.33)))
  return fract(dotted.x.add(dotted.y).mul(dotted.z))
})

/** Smooth signed value noise for fields whose domain has only one dimension. */
export const noise1 = /*@__PURE__*/ Fn(([position]: [any]) => {
  const base = floor(position).toVar()
  const local = fract(position).toVar()
  const eased = local
    .mul(local)
    .mul(local)
    .mul(local.mul(local.mul(6).sub(15)).add(10))
  const lower = hash13(vec3(base, 0, 0))
  const upper = hash13(vec3(base.add(1), 0, 0))
  return mix(lower, upper, eased).mul(2).sub(1)
})

/** Band-limited fBm for scalar coordinates; used by stratigraphic sequences. */
export function fbm1(position: any, octaves: number): any {
  const sum = float(0).toVar()
  let total = 0.0001
  let amplitude = 1
  let frequency = 1
  for (let octave = 0; octave < octaves; octave += 1) {
    sum.addAssign(noise1(position.mul(frequency)).mul(amplitude))
    total += amplitude
    amplitude *= 0.52
    frequency *= 2.07
  }
  return sum.div(total).mul(0.5).add(0.5).clamp(0, 1)
}

/**
 * Domain warp. Warping before sampling is what turns obviously-synthetic noise
 * into geology: it produces the flowing, folded banding visible on real cliffs.
 */
export const warp = /*@__PURE__*/ Fn(([position, amount, frequency]: [any, any, any]) => {
  // One noise tap, decorrelated across the three axes by rotating the sample
  // point rather than taking three independent taps. Visually the difference is
  // negligible and it removes two thirds of the cost of every warp — and warps
  // were a third of this material's total noise budget.
  const scaled = position.mul(frequency)
  const a = mx_noise_float(scaled).toVar()
  const b = mx_noise_float(scaled.yzx.mul(-1.13).add(19.7)).toVar()
  return position.add(vec3(a, b, a.mul(0.7).sub(b.mul(0.7))).mul(amount))
})

/** Surface-domain counterpart of `warp` for holdable-ground materials. */
export const warp2 = /*@__PURE__*/ Fn(([position, amount, frequency]: [any, any, any]) => {
  const scaled = position.mul(frequency)
  const a = mx_noise_float(scaled).toVar()
  const b = mx_noise_float(scaled.yx.mul(-1.13).add(19.7)).toVar()
  return position.add(vec2(a, b).mul(amount))
})

/**
 * Descending smoothstep. WGSL leaves `smoothstep(low, high, x)` undefined when
 * `low >= high`, so every falling edge in this material goes through here
 * rather than relying on a reversed pair happening to work.
 */
export const falloff = /*@__PURE__*/ Fn(
  ([high, low, value]: [any, any, any]) => smoothstep(low, high, value).oneMinus(),
)

/**
 * Fades a detail band out before it starts aliasing. `footprint` is the world
 * size of one pixel; once a feature is smaller than a pixel it becomes noise,
 * so it is dissolved into its mean instead of shimmering.
 */
export const detailFade = /*@__PURE__*/ Fn(
  ([footprint, featureSize]: [any, any]) =>
    falloff(featureSize.mul(DETAIL_FADE_END), featureSize.mul(DETAIL_FADE_START), footprint),
)

/** Blends a detail value towards its mean as the fade drops to zero. */
export const fadeToMean = /*@__PURE__*/ Fn(
  ([value, mean, fade]: [any, any, any]) => mix(mean, value, fade),
)
