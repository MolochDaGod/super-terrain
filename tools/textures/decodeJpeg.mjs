import { chromium } from 'playwright'
import { inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Decodes the reference JPEGs to raw RGBA for the offline comparison harness.
 *
 * The repo ships no image codec for Node, so the browser's decoder is
 * borrowed through Playwright. The pixels come back as a PNG data URL rather
 * than a JSON array: serialising sixteen million numbers across the bridge
 * takes minutes, while a re-encoded PNG is a few megabytes and inflates here
 * in milliseconds.
 */

function decodePng(buffer) {
  let offset = 8
  let width = 0
  let height = 0
  let colourType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      colourType = body[9]
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') break
    offset += 12 + length
  }
  if (colourType !== 6) throw new Error(`unexpected PNG colour type ${colourType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    const target = out.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? target[x - 4] : 0
      const b = prior ? prior[x] : 0
      const c = prior && x >= 4 ? prior[x - 4] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      target[x] = value & 0xff
    }
  }
  return { width, height, data: out }
}

const [outDir, ...files] = process.argv.slice(2)
if (!outDir || files.length === 0) {
  console.error('usage: decodeJpeg.mjs <outDir> <file...>')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('about:blank')

for (const file of files) {
  const path = resolve(file)
  const name = path.split('/').pop().replace(/\.[^.]+$/, '')
  const target = resolve(outDir, `${name}.raw`)
  const meta = resolve(outDir, `${name}.json`)
  if (existsSync(target) && existsSync(meta)) {
    console.log(`cached ${name}`)
    continue
  }
  const base64 = readFileSync(path).toString('base64')
  const dataUrl = await page.evaluate(async (data) => {
    const image = new Image()
    image.src = `data:image/jpeg;base64,${data}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    canvas.getContext('2d').drawImage(image, 0, 0)
    return canvas.toDataURL('image/png')
  }, base64)
  const png = decodePng(Buffer.from(dataUrl.split(',')[1], 'base64'))
  writeFileSync(target, png.data)
  writeFileSync(meta, JSON.stringify({ width: png.width, height: png.height }))
  console.log(`decoded ${name} ${png.width}x${png.height}`)
}

await browser.close()
