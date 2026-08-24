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

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'captures/tree/atlas'
const size = 512
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
const bark = bakeBarkMaps(84721, 'ancient-oak')
writeFileSync(resolve(out, 'bark-albedo.png'), encodePng(bark.albedo, bark.width, bark.height))
writeFileSync(resolve(out, 'bark-normal.png'), encodePng(bark.normal, bark.width, bark.height))
console.log(`wrote ${out}/bark-albedo.png (${bark.width}x${bark.height})`)
// Two by two, so a seam at the tile boundary is impossible to miss. Judging
// tileability from a single tile is exactly how a seam ships.
writeFileSync(
  resolve(out, 'bark-tiled.png'),
  encodePng(tile(bark.albedo, bark.width, bark.height, 2, 2), bark.width * 2, bark.height * 2),
)
console.log(`wrote ${out}/bark-tiled.png`)

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
  const spray = bakeLeafSpray(84721, 'ancient-oak', variant, size)
  // Composited over mid grey: judging a cutout against transparency hides
  // exactly the alpha-edge problems worth looking for.
  writeFileSync(
    resolve(out, `spray-${variant}.png`),
    encodePng(overGrey(spray), size, size),
  )
  writeFileSync(
    resolve(out, `spray-${variant}-alpha.png`),
    encodePng(alphaOnly(spray), size, size),
  )
  console.log(`wrote ${out}/spray-${variant}.png`)
}

function overGrey(spray: LeafSprayMaps): Uint8Array {
  const rgba = new Uint8Array(spray.albedo.length)
  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = spray.albedo[index + 3]! / 255
    for (let channel = 0; channel < 3; channel += 1) {
      rgba[index + channel] = Math.round(
        spray.albedo[index + channel]! * alpha + 96 * (1 - alpha),
      )
    }
    rgba[index + 3] = 255
  }
  return rgba
}

function alphaOnly(spray: LeafSprayMaps): Uint8Array {
  const rgba = new Uint8Array(spray.albedo.length)
  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = spray.albedo[index + 3]!
    rgba[index] = alpha
    rgba[index + 1] = alpha
    rgba[index + 2] = alpha
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
