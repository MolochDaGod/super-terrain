import { Fn, dot, floor, fract, mix, vec2, vec3, vec4 } from 'three/tsl'

/**
 * Deterministic hashing for everything the foliage system places.
 *
 * Position-derived randomness rather than stored randomness is the whole
 * reason the population pass can be re-run from scratch every frame: a blade's
 * lean, hue and phase are functions of where it stands, so nothing swims when
 * the candidate grid slides under a moving camera and no per-instance random
 * state has to be kept alive between frames.
 *
 * These are the multiply-and-fract construction rather than the usual
 * `fract(sin(dot(p, k)) * 43758.5)`, and the difference is not cosmetic.
 *
 * The sine hash feeds `sin` an argument proportional to the input. At the far
 * edge of a four-hundred metre field, sampled at a quarter-metre feature size,
 * that argument reaches several hundred thousand — and a 32-bit float has
 * about seven significant digits. The hash does not become slightly worse out
 * there; it stops being a hash at all, and every field built on it flattens
 * into smooth garbage. That is what turns a distant meadow into a sheet of
 * rippled water, and no amount of colour or lighting work fixes it, because
 * the detail those fields were supposed to supply was never computed.
 *
 * Folding the input into the unit interval before any arithmetic keeps the
 * precision where the entropy is, at the same cost.
 */
export const hash21 = /*@__PURE__*/ Fn(([p]: [any]) => {
  const q = vec2(p)
  const seed = fract(vec3(q.x, q.y, q.x).mul(0.1031)).toVar()
  seed.addAssign(dot(seed, seed.yzx.add(33.33)))
  return fract(seed.x.add(seed.y).mul(seed.z))
})

export const hash22 = /*@__PURE__*/ Fn(([p]: [any]) => {
  const q = vec2(p)
  const seed = fract(
    vec3(q.x, q.y, q.x).mul(vec3(0.1031, 0.103, 0.0973)),
  ).toVar()
  seed.addAssign(dot(seed, seed.yzx.add(33.33)))
  return fract(vec2(seed.x, seed.x).add(vec2(seed.y, seed.z)).mul(vec2(seed.z, seed.y)))
})

export const hash24 = /*@__PURE__*/ Fn(([p]: [any]) => {
  const q = vec2(p)
  const seed = fract(
    vec4(q.x, q.y, q.x, q.y).mul(vec4(0.1031, 0.103, 0.0973, 0.1099)),
  ).toVar()
  seed.addAssign(dot(seed, seed.wzxy.add(33.33)))
  return fract(seed.xxyz.add(seed.yzzw).mul(seed.zywx))
})

/** Smooth value noise on the xz plane. One tap, used for the large fields. */
export const valueNoise2 = /*@__PURE__*/ Fn(([p]: [any]) => {
  const q = vec2(p)
  const cell = floor(q)
  const f = fract(q)
  const w = f.mul(f).mul(f.mul(-2).add(3))
  const a = hash21(cell)
  const b = hash21(cell.add(vec2(1, 0)))
  const c = hash21(cell.add(vec2(0, 1)))
  const d = hash21(cell.add(vec2(1, 1)))
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y)
})

/** Two octaves. Enough for gust fronts and health patches; no more taps than needed. */
export const fbm2 = /*@__PURE__*/ Fn(([p]: [any]) => {
  const q = vec2(p)
  return valueNoise2(q)
    .mul(0.62)
    .add(valueNoise2(q.mul(2.17).add(vec2(31.4, 17.9))).mul(0.38))
})
