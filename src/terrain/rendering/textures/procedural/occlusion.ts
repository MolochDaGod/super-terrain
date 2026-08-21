import { at, blurField, createField, type Field, resampleField } from './field'
import { clamp01 } from './noise'

export interface AoOptions {
  /** Directions swept around the hemisphere. */
  directions?: number
  /** Maximum march distance in pixels. */
  radius?: number
  /** Height units per pixel; sets how deep the relief actually is. */
  heightScale?: number
  /** Resolution the sweep runs at. Half res plus upsample is visually free. */
  workingSize?: number
  /** Extra darkening in the deepest cavities. */
  intensity?: number
}

/**
 * Horizon-based ambient occlusion over a tiling height field.
 *
 * A real scan's AO map carries the contact darkening between every clast and
 * the matrix around it, and that is most of what makes the material read as
 * three-dimensional under flat sky light. Approximating AO with an inverted
 * height (the usual shortcut) gets the deep cracks roughly right and every
 * contact shadow wrong, so this marches actual horizons instead.
 */
export function horizonOcclusion(height: Field, options: AoOptions = {}): Field {
  const directions = options.directions ?? 16
  const workingSize = Math.min(options.workingSize ?? Math.min(512, height.size), height.size)
  const source = resampleField(height, workingSize)
  const scaleRatio = workingSize / height.size
  const radius = Math.max(2, (options.radius ?? 24) * scaleRatio)
  const heightScale = (options.heightScale ?? 1) / scaleRatio
  const intensity = options.intensity ?? 1
  const steps = Math.max(4, Math.round(radius))
  const out = createField(workingSize)

  const rays: Array<{ dx: number; dy: number }> = []
  for (let i = 0; i < directions; i += 1) {
    const angle = ((i + 0.5) / directions) * Math.PI * 2
    rays.push({ dx: Math.cos(angle), dy: Math.sin(angle) })
  }

  for (let y = 0; y < workingSize; y += 1) {
    for (let x = 0; x < workingSize; x += 1) {
      const h0 = source.data[y * workingSize + x]! * heightScale
      let visibility = 0
      for (const ray of rays) {
        let maxTangent = 0
        for (let s = 1; s <= steps; s += 1) {
          const t = (s / steps) * radius
          const sx = Math.round(x + ray.dx * t)
          const sy = Math.round(y + ray.dy * t)
          const dh = at(source, sx, sy) * heightScale - h0
          if (dh <= 0) continue
          // A little distance attenuation keeps a far ridge from blackening a
          // whole flat. Too much and no cavity ever reaches real darkness,
          // which leaves every recess looking like a grey smudge instead of
          // a hole.
          const tangent = (dh / t) * (1 - 0.45 * (t / radius))
          if (tangent > maxTangent) maxTangent = tangent
        }
        // sin(atan(t)) is the fraction of the hemisphere the horizon hides.
        visibility += 1 - maxTangent / Math.sqrt(1 + maxTangent * maxTangent)
      }
      visibility /= directions
      out.data[y * workingSize + x] = clamp01(Math.pow(visibility, intensity))
    }
  }

  // A single-pixel blur removes the step aliasing from the integer march
  // without softening the contact darkening that matters.
  return resampleField(blurField(out, 1, 2), height.size)
}

/**
 * Small-scale cavity from the difference between the height and its local
 * mean. Multiplied onto the horizon term it restores the crack-level darkening
 * that a half-resolution sweep cannot resolve.
 */
export function cavityField(height: Field, radius = 3, strength = 1): Field {
  const low = blurField(height, radius)
  const out = createField(height.size)
  for (let i = 0; i < out.data.length; i += 1) {
    const d = height.data[i]! - low.data[i]!
    out.data[i] = clamp01(0.5 + d * strength * 8)
  }
  return out
}
