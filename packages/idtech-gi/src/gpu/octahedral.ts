import type { Node } from './nodes.ts'
import {
  abs,
  float,
  select,
  sign,
  vec2,
  vec3,
} from './nodes.ts'


/** Unit direction → octahedral parameterisation in [-1, 1]^2. */
export function octEncode(n: Node): Node {
  const denom = abs(n.x).add(abs(n.y)).add(abs(n.z)).max(float(1e-6))
  const p = n.xy.div(denom)
  const folded = vec2(float(1).sub(abs(p.y)), float(1).sub(abs(p.x))).mul(
    vec2(
      select(p.x.greaterThanEqual(0), float(1), float(-1)),
      select(p.y.greaterThanEqual(0), float(1), float(-1)),
    ),
  )
  return select(n.z.greaterThanEqual(0), p, folded)
}

/** Octahedral coordinate in [-1, 1]^2 → unit direction. */
export function octDecode(f: Node): Node {
  const z = float(1).sub(abs(f.x)).sub(abs(f.y))
  const folded = vec2(
    float(1).sub(abs(f.y)).mul(sign(f.x)),
    float(1).sub(abs(f.x)).mul(sign(f.y)),
  )
  const xy = select(z.greaterThanEqual(0), f, folded)
  return vec3(xy.x, xy.y, z).normalize()
}
