import { inflateSync } from 'node:zlib'

/**
 * Minimal PNG reader for review telemetry.
 *
 * "Too dark" and "too flat" are the two failure modes a screenshot review keeps
 * arguing about by eye. Numbers settle it, so the harness reports the same
 * exposure statistics the offline capture tool does — plus a band breakdown,
 * because a frame with a blown sky and a black foreground averages to a
 * perfectly reasonable mean.
 */
export function decodePng(buffer) {
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colourType = 6
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colourType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += length + 12
  }
  if (bitDepth !== 8) throw new Error(`pngStats: unsupported bit depth ${bitDepth}`)
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 0
  if (channels === 0) throw new Error(`pngStats: unsupported colour type ${colourType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  let source = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source]
    source += 1
    const row = y * stride
    const previous = row - stride
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x]
      const left = x >= channels ? pixels[row + x - channels] : 0
      const up = y > 0 ? pixels[previous + x] : 0
      const upLeft = y > 0 && x >= channels ? pixels[previous + x - channels] : 0
      let restored = value
      if (filter === 1) restored = value + left
      else if (filter === 2) restored = value + up
      else if (filter === 3) restored = value + ((left + up) >> 1)
      else if (filter === 4) restored = value + paeth(left, up, upLeft)
      pixels[row + x] = restored & 0xff
    }
    source += stride
  }
  return { width, height, channels, pixels }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

function bandStats(image, fromRow, toRow) {
  const { width, channels, pixels } = image
  let sum = 0
  let clipped = 0
  let crushed = 0
  let count = 0
  for (let y = fromRow; y < toRow; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * channels
      const luminance =
        pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722
      sum += luminance
      if (luminance > 250) clipped += 1
      if (luminance < 6) crushed += 1
      count += 1
    }
  }
  return {
    mean: sum / Math.max(1, count),
    clipped: (clipped / Math.max(1, count)) * 100,
    crushed: (crushed / Math.max(1, count)) * 100,
  }
}

/** `mean/clip/black` for the whole frame and for its top, middle and bottom third. */
export function describeExposure(buffer) {
  const image = decodePng(buffer)
  const third = Math.floor(image.height / 3)
  const format = (label, stats) =>
    `${label} ${stats.mean.toFixed(1).padStart(5)}` +
    ` (clip ${stats.clipped.toFixed(1)}% black ${stats.crushed.toFixed(1)}%)`
  return [
    format('all', bandStats(image, 0, image.height)),
    format('sky', bandStats(image, 0, third)),
    format('mid', bandStats(image, third, third * 2)),
    format('near', bandStats(image, third * 2, image.height)),
  ].join('  ')
}
