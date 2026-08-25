// Locates hard bands in bark by probing the wood mesh's own UVs.
//
// A horizontal band across a trunk has two possible causes and they need
// completely different fixes: the baked maps may fail to tile vertically, or
// the mesh may hand adjacent triangles UVs from two different mappings. Arguing
// about it from a screenshot is hopeless — both look identical. This measures
// the second directly, by walking the wood mesh and reporting where the texture
// scale or offset changes discontinuously with height.
//
//   node tools/browser/barkSeamProbe.mjs --url=http://localhost:5173
import { chromium } from 'playwright'

const flags = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=')
    return [key, value]
  }),
)
const url = flags.get('url') ?? 'http://localhost:5173'
const params = {}
for (const pair of (flags.get('params') ?? '').split(',')) {
  const [key, value] = pair.split(':')
  if (!key || value === undefined) continue
  params[key] = Number.isFinite(Number(value)) ? Number(value) : value
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  ignoreDefaultArgs: ['--disable-gpu', '--use-gl=swiftshader'],
  args: ['--enable-unsafe-webgpu', '--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
await page.goto(`${url}/?editor=tree&ui=off`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(globalThis.__meshtree), null, { timeout: 60_000 })

const report = await page.evaluate(async ({ params }) => {
  const { store } = globalThis.__meshtree
  if (Object.keys(params).length > 0) store.patchParameters(params)
  store.regenerate()
  const wanted = store.getSnapshot().buildRevision
  const started = performance.now()
  while (performance.now() - started < 180_000) {
    const snapshot = store.getSnapshot()
    if (snapshot.compiledRevision === wanted && snapshot.asset) break
    await new Promise((done) => setTimeout(done, 200))
  }
  const wood = store.getSnapshot().asset?.lods[0]?.wood
  if (!wood) return { error: 'no wood mesh' }

  const { positions, uvs, indices } = wood
  // Every edge of every triangle, as a change in world position against a
  // change in UV. A continuous mapping keeps texels-per-metre roughly constant
  // along the bole; a per-part mapping does not, and the ratio jumps.
  const edges = []
  for (let i = 0; i < indices.length; i += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const p = indices[i + a]
      const q = indices[i + b]
      const dy = positions[q * 3 + 1] - positions[p * 3 + 1]
      const dv = uvs[q * 2 + 1] - uvs[p * 2 + 1]
      // Only near-vertical edges say anything about the v scale.
      const span = Math.hypot(
        positions[q * 3] - positions[p * 3],
        dy,
        positions[q * 3 + 2] - positions[p * 3 + 2],
      )
      if (span < 1e-4 || Math.abs(dy) < span * 0.7) continue
      edges.push({
        y: (positions[p * 3 + 1] + positions[q * 3 + 1]) / 2,
        // Texture repeats per metre of height.
        rate: Math.abs(dv / dy),
        jump: Math.abs(dv),
      })
    }
  }
  edges.sort((a, b) => a.y - b.y)

  // Bucket by height and report the v-rate in each, so a scale change shows up
  // as a step between neighbouring buckets.
  const buckets = []
  const low = edges[0]?.y ?? 0
  const high = edges[edges.length - 1]?.y ?? 1
  const count = 28
  for (let i = 0; i < count; i += 1) {
    const from = low + ((high - low) * i) / count
    const to = low + ((high - low) * (i + 1)) / count
    const inside = edges.filter((e) => e.y >= from && e.y < to && e.rate < 20)
    if (inside.length < 8) continue
    const rates = inside.map((e) => e.rate).sort((a, b) => a - b)
    buckets.push({
      y: Number(((from + to) / 2).toFixed(2)),
      samples: inside.length,
      rate: Number(rates[Math.floor(rates.length / 2)].toFixed(3)),
    })
  }
  // Edges whose v jumps far more than their neighbours: a UV origin step.
  const jumps = edges.filter((e) => e.jump > 0.3).length
  return { buckets, jumps, edges: edges.length }
}, { params })

if (report.error) {
  console.error(report.error)
} else {
  console.log(`near-vertical edges: ${report.edges}  |  edges with a v jump > 0.3: ${report.jumps}`)
  console.log('height(m)  v-repeats/m  samples   step vs previous')
  let previous = null
  for (const bucket of report.buckets) {
    const step = previous === null ? '' : `x${(bucket.rate / previous).toFixed(2)}`
    console.log(
      `${String(bucket.y).padStart(8)}  ${String(bucket.rate).padStart(11)}  ` +
      `${String(bucket.samples).padStart(7)}   ${step}`,
    )
    previous = bucket.rate
  }
}
await browser.close()
