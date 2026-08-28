// Writes the baked leaf sprays out as PNGs so the atlas can be judged as art
// rather than inferred from a rendered crown twenty metres away.
//
//   npx vite-node tools/browser/dumpLeafAtlas.ts -- --out=captures/tree/atlas
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { bakeLeafSpray, bakeSingleBlade, type LeafSprayMaps } from '../../src/tree/materials/leafSprayAtlas'
import { bakeBarkMaps } from '../../src/tree/materials/proceduralTreeTextures'
import { LEAF_CARD_VARIANTS } from '../../src/tree/generator/foliageCompiler'
import { TREE_SPECIES_DEFINITIONS } from '../../src/tree/generator/speciesCatalog'

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'captures/tree/atlas'
const barkOnly = process.argv.includes('--bark-only')
const barkSpecies = process.argv.find((a) => a.startsWith('--bark-species='))?.slice(15) ??
  'ancient-oak'
const size = Number(process.argv.find((a) => a.startsWith('--size='))?.slice(7) ?? 512)
// Which species' sprays get dumped. Judging a conifer atlas from the oak bake
// is how a needle card that covers a twentieth of its cell stays invisible.
const spraySpecies = (process.argv.find((a) => a.startsWith('--species='))?.slice(10)
  ?? 'ancient-oak') as (typeof TREE_SPECIES_DEFINITIONS)[number]['id']
mkdirSync(resolve(out), { recursive: true })

// A single blade at full frame, which is the only way to actually see the
// outline the lobe function produces rather than the union of thirty overlaps.
for (const variation of [0.2, 0.8]) {
  const blade = bakeSingleBlade('ancient-oak', variation, 512)
  writeFileSync(resolve(out, `blade-${variation}.png`), encodePng(blade, 512, 512))
  console.log(`wrote ${out}/blade-${variation}.png`)
}

// Bark too: judging a tiling material from a rendered trunk six metres away
// cannot tell a flat bake apart from a mip-blurred one.
const bark = bakeBarkMaps(84721, barkSpecies)
writeFileSync(resolve(out, 'bark-albedo.png'), encodePng(bark.albedo, bark.width, bark.height))
writeFileSync(resolve(out, 'bark-normal.png'), encodePng(bark.normal, bark.width, bark.height))
writeFileSync(
  resolve(out, 'bark-surface.png'),
  encodePng(bark.roughness, bark.width, bark.height),
)
writeFileSync(
  resolve(out, 'bark-ao.png'),
  encodePng(channelOnly(bark.roughness, 0), bark.width, bark.height),
)
console.log(`wrote ${out}/bark-albedo.png (${bark.width}x${bark.height})`)
// Two by two, so a seam at the tile boundary is impossible to miss. Judging
// tileability from a single tile is exactly how a seam ships.
writeFileSync(
  resolve(out, 'bark-tiled.png'),
  encodePng(tile(bark.albedo, bark.width, bark.height, 2, 2), bark.width * 2, bark.height * 2),
)
console.log(`wrote ${out}/bark-tiled.png`)

if (barkOnly) process.exit(0)

function tile(
  source: Uint8Array,
  width: number,
  height: number,
  across: number,
  down: number,
): Uint8Array {
  const target = new Uint8Array(width * across * height * down * 4)
  const rowBytes = width * across * 4
  for (let y = 0; y < height * down; y += 1) {
    for (let x = 0; x < width * across; x += 1) {
      const from = ((y % height) * width + (x % width)) * 4
      const to = y * rowBytes + x * 4
      for (let c = 0; c < 4; c += 1) target[to + c] = source[from + c]!
    }
  }
  return target
}

for (let variant = 0; variant < LEAF_CARD_VARIANTS; variant += 1) {
  const spray = bakeLeafSpray(84721, spraySpecies, variant, size)
  // Composited over mid grey: judging a cutout against transparency hides
  // exactly the alpha-edge problems worth looking for.
  writeFileSync(resolve(out, `spray-${variant}.png`), encodePng(overGrey(spray), size, size))
  writeFileSync(
    resolve(out, `spray-${variant}-alpha.png`),
    encodePng(channelOnly(spray.albedo, 3), size, size),
  )
  writeFileSync(
    resolve(out, `spray-${variant}-normal.png`),
    encodePng(opaque(spray.normal), size, size),
  )
  // The three packed surface channels, separately. Judging a packed map by its
  // false-colour composite is how a wrong channel survives a review.
  writeFileSync(
    resolve(out, `spray-${variant}-roughness.png`),
    encodePng(channelOnly(spray.roughness, 0), size, size),
  )
  writeFileSync(
    resolve(out, `spray-${variant}-translucency.png`),
    encodePng(channelOnly(spray.roughness, 1), size, size),
  )
  writeFileSync(
    resolve(out, `spray-${variant}-ao.png`),
    encodePng(channelOnly(spray.roughness, 2), size, size),
  )
  // The mip chain, laid out side by side at full size. A cutout atlas can look
  // immaculate at mip 0 and dissolve into a grey haze by mip 3 — which is the
  // level most of a crown is actually sampled at — and nothing but looking at
  // the chain reveals it.
  writeFileSync(
    resolve(out, `spray-${variant}-mips.png`),
    encodePng(...mipStrip(spray.albedo, size)),
  )
  console.log(`wrote ${out}/spray-${variant}.png (+alpha, normal, roughness, translucency, ao, mips)`)
}

// One card per species, so a whole vertical slice of the catalog can be judged
// as art at once rather than one render at a time. A family that has fallen
// back to the wrong outline is unmistakable here and nearly invisible in a
// thirty-metre hero shot.
for (const definition of TREE_SPECIES_DEFINITIONS) {
  const spray = bakeLeafSpray(84721, definition.id, 1, size)
  writeFileSync(
    resolve(out, `species-${definition.id}.png`),
    encodePng(overGrey(spray), size, size),
  )
  console.log(`wrote ${out}/species-${definition.id}.png`)
}

/**
 * Box-filters an RGBA cutout the way the GPU does — each channel averaged
 * against alpha — and lays the chain out left to right, each level composited
 * over the same mid grey and nearest-upscaled back to full size.
 */
function mipStrip(rgba: Uint8Array, size: number): [Uint8Array, number, number] {
  const levels: { data: Uint8Array; size: number }[] = [{ data: rgba, size }]
  while (levels[levels.length - 1]!.size > 8) {
    const previous = levels[levels.length - 1]!
    const half = previous.size >> 1
    const next = new Uint8Array(half * half * 4)
    for (let y = 0; y < half; y += 1) {
      for (let x = 0; x < half; x += 1) {
        for (let channel = 0; channel < 4; channel += 1) {
          let total = 0
          for (let dy = 0; dy < 2; dy += 1) {
            for (let dx = 0; dx < 2; dx += 1) {
              total += previous.data[((y * 2 + dy) * previous.size + x * 2 + dx) * 4 + channel]!
            }
          }
          next[(y * half + x) * 4 + channel] = Math.round(total / 4)
        }
      }
    }
    levels.push({ data: next, size: half })
  }
  const shown = levels.slice(0, 5)
  const width = size * shown.length
  const strip = new Uint8Array(width * size * 4)
  for (const [level, entry] of shown.entries()) {
    const zoom = size / entry.size
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const from = (Math.floor(y / zoom) * entry.size + Math.floor(x / zoom)) * 4
        const to = (y * width + level * size + x) * 4
        const alpha = entry.data[from + 3]! / 255
        for (let channel = 0; channel < 3; channel += 1) {
          strip[to + channel] = Math.round(entry.data[from + channel]! * alpha + 96 * (1 - alpha))
        }
        strip[to + 3] = 255
      }
    }
  }
  return [strip, width, size]
}

function opaque(source: Uint8Array): Uint8Array {
  const rgba = Uint8Array.from(source)
  for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255
  return rgba
}

/**
 * Composites over mid grey and flips vertically.
 *
 * Row zero of the data is texture v = 0, which the card geometry puts at the
 * *bottom* of the quad — the end attached to the twig. Writing the rows out in
 * order therefore shows every card upside down relative to how it renders, and
 * a spray whose leaves are hanging when they should be rising looks perfectly
 * fine that way round.
 */
function overGrey(spray: LeafSprayMaps): Uint8Array {
  const rgba = new Uint8Array(spray.albedo.length)
  const size = spray.size
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = ((size - 1 - y) * size + x) * 4
      const to = (y * size + x) * 4
      const alpha = spray.albedo[from + 3]! / 255
      for (let channel = 0; channel < 3; channel += 1) {
        rgba[to + channel] = Math.round(
          spray.albedo[from + channel]! * alpha + 96 * (1 - alpha),
        )
      }
      rgba[to + 3] = 255
    }
  }
  return rgba
}

function channelOnly(source: Uint8Array, channel: number): Uint8Array {
  const rgba = new Uint8Array(source.length)
  for (let index = 0; index < rgba.length; index += 4) {
    const value = source[index + channel]!
    rgba[index] = value
    rgba[index + 1] = value
    rgba[index + 2] = value
    rgba[index + 3] = 255
  }
  return rgba
}

/** Minimal PNG writer: one IDAT of filter-0 scanlines. */
function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0, 0)
  return Buffer.concat([length, body, crc])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return crc ^ 0xffffffff
}
