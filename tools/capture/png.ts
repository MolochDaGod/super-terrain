import { deflateSync } from 'node:zlib'

/**
 * Minimal PNG encoder. The capture harness is the only consumer, so it writes
 * a single non-interlaced RGBA8 image and skips every optional chunk.
 */
export function encodePng(
  pixels: Uint8Array,
  width: number,
  height: number,
): Buffer {
  const stride = width * 4
  const raw = Buffer.allocUnsafe((stride + 1) * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0
    Buffer.from(pixels.buffer, pixels.byteOffset + row * stride, stride).copy(
      raw,
      row * (stride + 1) + 1,
    )
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Vertically flips a row-major RGBA buffer; GPU readback is bottom-up. */
export function flipVertically(
  pixels: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const stride = width * 4
  const flipped = new Uint8Array(pixels.length)
  for (let row = 0; row < height; row += 1) {
    flipped.set(
      pixels.subarray(row * stride, row * stride + stride),
      (height - 1 - row) * stride,
    )
  }
  return flipped
}

function chunk(type: string, body: Buffer): Buffer {
  const result = Buffer.allocUnsafe(body.length + 12)
  result.writeUInt32BE(body.length, 0)
  result.write(type, 4, 'ascii')
  body.copy(result, 8)
  result.writeUInt32BE(crc32(result.subarray(4, 8 + body.length)), 8 + body.length)
  return result
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xff_ff_ff_ff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xff_ff_ff_ff) >>> 0
}
