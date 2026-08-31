// Counts isolated bright pixels — the spatial signature of a firefly.
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const file = process.argv[2]
const buffer = readFileSync(file)
let offset = 8
let width = 0, height = 0
const idat = []
while (offset < buffer.length) {
  const length = buffer.readUInt32BE(offset)
  const type = buffer.toString('ascii', offset + 4, offset + 8)
  const body = buffer.subarray(offset + 8, offset + 8 + length)
  if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4) }
  if (type === 'IDAT') idat.push(body)
  offset += 12 + length
}
const raw = inflateSync(Buffer.concat(idat))
const channels = 3
const stride = width * channels
const rows = new Uint8Array(width * height * channels)
let previous = new Uint8Array(stride)
for (let y = 0; y < height; y += 1) {
  const filter = raw[y * (stride + 1)]
  const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
  const out = rows.subarray(y * stride, (y + 1) * stride)
  for (let i = 0; i < stride; i += 1) {
    const a = i >= channels ? out[i - channels] : 0
    const b = previous[i]
    const c = i >= channels ? previous[i - channels] : 0
    let value = line[i]
    if (filter === 1) value += a
    else if (filter === 2) value += b
    else if (filter === 3) value += (a + b) >> 1
    else if (filter === 4) {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    out[i] = value & 0xff
  }
  previous = out
}
const luma = new Float32Array(width * height)
for (let i = 0; i < width * height; i += 1) {
  luma[i] = 0.2126 * rows[i * 3] + 0.7152 * rows[i * 3 + 1] + 0.0722 * rows[i * 3 + 2]
}
const at = (x, y) => luma[y * width + x]
let fireflies = 0
let bright = 0
for (let y = 1; y < height - 1; y += 1) {
  for (let x = 1; x < width - 1; x += 1) {
    const l = at(x, y)
    if (l < 150) continue
    bright += 1
    const neighbours = Math.max(at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1))
    // Far brighter than everything touching it: an outlier, not a feature.
    if (l > neighbours * 1.7 + 25) fireflies += 1
  }
}
console.log(`${file.split('/').pop()}: isolated-bright ${fireflies}  (of ${bright} bright px, ${(fireflies / Math.max(1, bright) * 100).toFixed(2)}%)`)
