import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { encodePng } from '../capture/png'
import { bakeSurface, type ProceduralMaterialMaps } from '../../src/terrain/rendering/textures/procedural/bake'
import { PROCEDURAL_SURFACES } from '../../src/terrain/rendering/textures/procedural/materials'

/**
 * Offline preview harness for the procedural rock materials.
 *
 * It bakes each recipe, renders it through a small reference PBR shader and
 * writes comparison sheets against the scanned source material. The same
 * shader runs over both sets of maps so a difference in the output is a
 * difference in the maps, not in the lighting.
 */

const outDir = process.env.TEXTURE_OUT ?? resolve(process.cwd(), '.textures/out')
const refDir = process.env.TEXTURE_REFS ?? resolve(process.cwd(), '.textures/refs')
const size = Number(process.env.TEXTURE_SIZE ?? 1024)
mkdirSync(outDir, { recursive: true })

interface RawImage {
  width: number
  height: number
  data: Uint8Array
}

function loadRaw(name: string): RawImage {
  const meta = JSON.parse(readFileSync(resolve(refDir, `${name}.json`), 'utf8')) as {
    width: number
    height: number
  }
  return { ...meta, data: new Uint8Array(readFileSync(resolve(refDir, `${name}.raw`))) }
}

function sample(image: RawImage, u: number, v: number, out: number[]): void {
  const x = ((u % 1) + 1) % 1 * image.width - 0.5
  const y = ((v % 1) + 1) % 1 * image.height - 0.5
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  for (let c = 0; c < 3; c += 1) {
    let acc = 0
    for (let j = 0; j < 2; j += 1) {
      for (let i = 0; i < 2; i += 1) {
        const px = (((x0 + i) % image.width) + image.width) % image.width
        const py = (((y0 + j) % image.height) + image.height) % image.height
        const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy)
        acc += image.data[(py * image.width + px) * 4 + c]! * w
      }
    }
    out[c] = acc / 255
  }
}

function toLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function toSrgb(v: number): number {
  const c = Math.min(1, Math.max(0, v))
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

interface MaterialSampler {
  albedo: (u: number, v: number, out: number[]) => void
  normal: (u: number, v: number, out: number[]) => void
  /** ao, roughness, metalness */
  arm: (u: number, v: number, out: number[]) => void
  /** Height in [0,1]; used for cast shadows. */
  height?: (u: number, v: number) => number
  /** Peak-to-trough relief as a fraction of the tile width. */
  relief?: number
}

function samplerFromRaw(
  albedo: RawImage,
  normal: RawImage,
  arm: RawImage,
  displacement?: RawImage,
  relief?: number,
): MaterialSampler {
  const scratch = [0, 0, 0]
  return {
    albedo: (u, v, out) => sample(albedo, u, v, out),
    normal: (u, v, out) => sample(normal, u, v, out),
    arm: (u, v, out) => sample(arm, u, v, out),
    height: displacement
      ? (u, v) => {
          sample(displacement, u, v, scratch)
          return scratch[0]!
        }
      : undefined,
    relief,
  }
}

function samplerFromMaps(maps: ProceduralMaterialMaps): MaterialSampler {
  const wrap = (data: Uint8Array): RawImage => ({
    width: maps.size,
    height: maps.size,
    data,
  })
  return samplerFromRaw(
    wrap(maps.albedo),
    wrap(maps.normal),
    wrap(maps.arm),
    wrap(maps.displacement),
    maps.reliefDepth / maps.physicalWidth,
  )
}

/**
 * Flat-lit patch render: a single sun plus a hemispherical sky, shaded with
 * GGX. The camera looks straight down the surface normal, so every difference
 * on screen comes from the maps.
 */
const flatAlbedo = process.env.TEXTURE_FLAT === '1'

/** Diagnostic: renders geometry only, so map-versus-shading is separable. */
function renderLit(sampler: MaterialSampler, outSize: number, tiles: number): Uint8Array {
  const pixels = new Uint8Array(outSize * outSize * 4)
  // Raking light from the upper left; grazing enough to show micro-relief.
  const lx = -0.52
  const ly = 0.58
  const lz = 0.63
  const llen = Math.hypot(lx, ly, lz)
  const L = [lx / llen, ly / llen, lz / llen]
  const V = [0, 0, 1]
  const H = [L[0]! + V[0]!, L[1]! + V[1]!, L[2]! + V[2]!]
  const hlen = Math.hypot(H[0]!, H[1]!, H[2]!)
  H[0]! /= hlen
  H[1]! /= hlen
  H[2]! /= hlen
  const sun = [3.1, 2.95, 2.7]
  const skyUp = [0.28, 0.34, 0.46]
  const skyDown = [0.16, 0.15, 0.13]

  const albedo = [0, 0, 0]
  const normal = [0, 0, 0]
  const arm = [0, 0, 0]

  for (let y = 0; y < outSize; y += 1) {
    for (let x = 0; x < outSize; x += 1) {
      const u = (x / outSize) * tiles
      const v = (y / outSize) * tiles
      sampler.albedo(u, v, albedo)
      if (flatAlbedo) {
        albedo[0] = 0.55
        albedo[1] = 0.55
        albedo[2] = 0.55
      }
      sampler.normal(u, v, normal)
      sampler.arm(u, v, arm)

      let nx = normal[0]! * 2 - 1
      // Texture v runs down the image while the OpenGL green channel points
      // up, so the y component is flipped for display.
      let ny = -(normal[1]! * 2 - 1)
      let nz = normal[2]! * 2 - 1
      const nlen = Math.hypot(nx, ny, nz) || 1
      nx /= nlen
      ny /= nlen
      nz /= nlen

      const ao = arm[0]!
      const roughness = Math.max(0.04, arm[1]!)
      const metalness = arm[2]!

      // Cast shadow: march the height field toward the light. Without it the
      // only depth cue is shading, and a surface whose overhangs cast nothing
      // reads as embossed rather than as relief.
      let shadow = 1
      if (sampler.height && sampler.relief) {
        const relief = sampler.relief * tiles
        const steps = 28
        const reach = 0.09 * tiles
        const h0 = sampler.height(u, v) * relief
        // Light travels toward -y in texture space because v runs down.
        const stepU = (L[0]! / L[2]!) * (reach / steps)
        const stepV = (-L[1]! / L[2]!) * (reach / steps)
        const stepH = (reach / steps)
        let occlusion = 0
        for (let step = 1; step <= steps; step += 1) {
          const sh = sampler.height(u + stepU * step, v + stepV * step) * relief
          const rayH = h0 + stepH * step
          const above = sh - rayH
          if (above > 0) {
            const amount = Math.min(1, (above / relief) * 6) * (1 - step / steps)
            if (amount > occlusion) occlusion = amount
          }
        }
        shadow = 1 - occlusion * 0.95
      }

      const ndl = Math.max(0, nx * L[0]! + ny * L[1]! + nz * L[2]!) * shadow
      const ndv = Math.max(1e-4, nx * V[0]! + ny * V[1]! + nz * V[2]!)
      const ndh = Math.max(0, nx * H[0]! + ny * H[1]! + nz * H[2]!)
      const vdh = Math.max(1e-4, V[0]! * H[0]! + V[1]! * H[1]! + V[2]! * H[2]!)

      const a = roughness * roughness
      const a2 = a * a
      const denom = ndh * ndh * (a2 - 1) + 1
      const D = a2 / (Math.PI * denom * denom)
      const k = (roughness + 1) * (roughness + 1) / 8
      const G = (ndl / (ndl * (1 - k) + k)) * (ndv / (ndv * (1 - k) + k))
      const fresnel = Math.pow(1 - vdh, 5)

      // Sky visibility follows the surface tilt, so the AO map shades the
      // ambient term rather than being multiplied over everything.
      const skyMix = 0.5 + 0.5 * ny

      const offset = (y * outSize + x) * 4
      for (let c = 0; c < 3; c += 1) {
        const base = toLinear(albedo[c]!)
        const f0 = 0.04 * (1 - metalness) + base * metalness
        const F = f0 + (1 - f0) * fresnel
        const spec = (D * G * F) / (4 * ndv * Math.max(ndl, 1e-4)) * ndl
        const diffuse = (base * (1 - metalness) / Math.PI) * ndl
        const ambient =
          base * (skyDown[c]! + (skyUp[c]! - skyDown[c]!) * skyMix) * ao * (1 - metalness * 0.7)
        let colour = (diffuse + spec) * sun[c]! + ambient
        // Filmic shoulder; keeps the highlights on the specular lobe readable.
        colour = (colour * (2.51 * colour + 0.03)) / (colour * (2.43 * colour + 0.59) + 0.14)
        pixels[offset + c] = Math.round(toSrgb(colour) * 255)
      }
      pixels[offset + 3] = 255
    }
  }
  return pixels
}

/** Unlit albedo view, tiled, for judging colour and pattern directly. */
function renderAlbedo(sampler: MaterialSampler, outSize: number, tiles: number): Uint8Array {
  const pixels = new Uint8Array(outSize * outSize * 4)
  const albedo = [0, 0, 0]
  for (let y = 0; y < outSize; y += 1) {
    for (let x = 0; x < outSize; x += 1) {
      sampler.albedo((x / outSize) * tiles, (y / outSize) * tiles, albedo)
      const offset = (y * outSize + x) * 4
      for (let c = 0; c < 3; c += 1) pixels[offset + c] = Math.round(albedo[c]! * 255)
      pixels[offset + 3] = 255
    }
  }
  return pixels
}

function sideBySide(left: Uint8Array, right: Uint8Array, tile: number, gap = 16): Uint8Array {
  const width = tile * 2 + gap
  const out = new Uint8Array(width * tile * 4)
  out.fill(24)
  for (let y = 0; y < tile; y += 1) {
    for (let x = 0; x < tile; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        out[(y * width + x) * 4 + c] = left[(y * tile + x) * 4 + c]!
        out[(y * width + x + tile + gap) * 4 + c] = right[(y * tile + x) * 4 + c]!
      }
    }
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255
  return out
}

function grid(cells: Uint8Array[], tile: number, columns: number, gap = 12): Uint8Array {
  const rows = Math.ceil(cells.length / columns)
  const width = columns * tile + (columns - 1) * gap
  const height = rows * tile + (rows - 1) * gap
  const out = new Uint8Array(width * height * 4)
  out.fill(24)
  cells.forEach((cell, index) => {
    const cx = (index % columns) * (tile + gap)
    const cy = Math.floor(index / columns) * (tile + gap)
    for (let y = 0; y < tile; y += 1) {
      for (let x = 0; x < tile; x += 1) {
        for (let c = 0; c < 4; c += 1) {
          out[((cy + y) * width + cx + x) * 4 + c] = cell[(y * tile + x) * 4 + c]!
        }
      }
    }
  })
  for (let i = 3; i < out.length; i += 4) out[i] = 255
  return out
}

function downscale(pixels: Uint8Array, from: number, to: number): Uint8Array {
  const out = new Uint8Array(to * to * 4)
  const ratio = from / to
  for (let y = 0; y < to; y += 1) {
    for (let x = 0; x < to; x += 1) {
      const x0 = Math.floor(x * ratio)
      const y0 = Math.floor(y * ratio)
      const x1 = Math.min(from, Math.floor((x + 1) * ratio))
      const y1 = Math.min(from, Math.floor((y + 1) * ratio))
      const acc = [0, 0, 0]
      let n = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          for (let c = 0; c < 3; c += 1) acc[c]! += pixels[(sy * from + sx) * 4 + c]!
          n += 1
        }
      }
      for (let c = 0; c < 3; c += 1) out[(y * to + x) * 4 + c] = Math.round(acc[c]! / Math.max(1, n))
      out[(y * to + x) * 4 + 3] = 255
    }
  }
  return out
}

interface ReferenceSet {
  albedo: string
  normal?: string
  arm?: string
  displacement?: string
  /** Peak-to-trough relief as a fraction of the tile width, from the scan. */
  relief?: number
}

const REFERENCES: Record<string, ReferenceSet> = {
  'rock-ground': {
    albedo: 'rock-ground-diffuse-1k',
    normal: 'rock-ground-normal-gl-1k',
    arm: 'rock-ground-arm-1k',
    displacement: 'rock-ground-displacement-1k',
    relief: 0.055 / 2,
  },
  'cliff-side': {
    albedo: 'cliff-side-diffuse-2k',
    normal: 'cliff-side-normal-gl-2k',
    arm: 'cliff-side-arm-1k',
    displacement: 'cliff-side-displacement-1k',
    relief: 0.16 / 1.8,
  },
  'alpine-cliff-rock': { albedo: 'alpine-cliff-rock-v2' },
  'ember-fault-rock': { albedo: 'ember-fault-rock' },
}

const only = process.env.TEXTURE_ONLY
const view = Number(process.env.TEXTURE_VIEW ?? 900)
const tiles = Number(process.env.TEXTURE_TILES ?? 1)

for (const [id, recipe] of Object.entries(PROCEDURAL_SURFACES)) {
  if (only && only !== id) continue
  const started = Date.now()
  const maps = bakeSurface(recipe, size, 1)
  const elapsed = Date.now() - started
  console.log(`baked ${id} at ${size}px in ${elapsed}ms`)

  const mine = samplerFromMaps(maps)
  const reference = REFERENCES[id]!
  const refAlbedo = loadRaw(reference.albedo)

  writeFileSync(
    resolve(outDir, `${id}-maps.png`),
    encodePng(
      grid(
        [
          downscale(maps.albedo, size, 512),
          downscale(maps.normal, size, 512),
          downscale(maps.arm, size, 512),
          downscale(maps.displacement, size, 512),
        ],
        512,
        4,
      ),
      512 * 4 + 12 * 3,
      512,
    ),

  )

  const refAlbedoSampler: MaterialSampler = {
    albedo: (u, v, out) => sample(refAlbedo, u, v, out),
    normal: () => {},
    arm: () => {},
  }
  writeFileSync(
    resolve(outDir, `${id}-albedo-ref.png`),
    encodePng(renderAlbedo(refAlbedoSampler, view, tiles), view, view),
  )
  writeFileSync(
    resolve(outDir, `${id}-albedo-mine.png`),
    encodePng(renderAlbedo(mine, view, tiles), view, view),
  )

  if (reference.normal && reference.arm) {
    const refSampler = samplerFromRaw(
      refAlbedo,
      loadRaw(reference.normal),
      loadRaw(reference.arm),
      reference.displacement ? loadRaw(reference.displacement) : undefined,
      reference.relief,
    )
    writeFileSync(
      resolve(outDir, `${id}-lit-ref.png`),
      encodePng(renderLit(refSampler, view, tiles), view, view),
    )
  }
  writeFileSync(
    resolve(outDir, `${id}-lit-mine.png`),
    encodePng(renderLit(mine, view, tiles), view, view),
  )
}

export { sideBySide }
