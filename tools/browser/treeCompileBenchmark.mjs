// Headless end-to-end benchmark for tree geometry, texture acquisition and
// WebGPU material warm-up. Requires the Vite dev server on --url.
import { performance } from 'node:perf_hooks'
import { chromium } from 'playwright'

const flags = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=')
    return [key, value]
  }),
)
const url = flags.get('url') ?? 'http://127.0.0.1:5173'
const timeout = Number(flags.get('timeout') ?? 180_000)
const runs = Number(flags.get('runs') ?? 3)
const species = flags.get('species')

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  ignoreDefaultArgs: [
    '--disable-gpu',
    '--use-gl=swiftshader',
    '--disable-software-rasterizer',
    '--disable-gpu-compositing',
  ],
  args: ['--enable-unsafe-webgpu', '--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
const problems = []
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(message.text())
})
page.on('pageerror', (error) => problems.push(String(error)))

const navigationStarted = performance.now()
await page.goto(`${url}/?editor=tree&ui=off`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(globalThis.__meshtree), null, { timeout })
if (species) {
  await page.evaluate((nextSpecies) => {
    const store = globalThis.__meshtree.store
    store.applySpecies(nextSpecies)
    store.regenerate()
  }, species)
}
await page.waitForFunction(
  () => globalThis.__meshtree.store.getSnapshot().status.startsWith('Tree ready'),
  null,
  { timeout },
)
const coldReadyMs = performance.now() - navigationStarted

const hot = await page.evaluate(async ({ runs, timeout }) => {
  const { store, gl } = globalThis.__meshtree
  const compileCalls = []
  const compileAsync = gl.compileAsync.bind(gl)
  gl.compileAsync = async (object, ...rest) => {
    const started = performance.now()
    try {
      return await compileAsync(object, ...rest)
    } finally {
      compileCalls.push({
        name: object.name || object.type,
        children: object.children?.length ?? 0,
        ms: performance.now() - started,
      })
    }
  }
  const samples = []
  for (let run = 0; run < runs; run += 1) {
    compileCalls.length = 0
    const current = store.getSnapshot()
    store.patchParameters({ seed: current.parameters.seed + 1 })
    const started = performance.now()
    store.regenerate()
    const wanted = store.getSnapshot().buildRevision
    let geometryMs
    while (performance.now() - started < timeout) {
      const snapshot = store.getSnapshot()
      if (geometryMs === undefined && snapshot.compiledRevision === wanted && snapshot.asset) {
        geometryMs = performance.now() - started
      }
      if (
        snapshot.compiledRevision === wanted &&
        snapshot.status.startsWith('Tree ready')
      ) {
        const readyMs = performance.now() - started
        samples.push({
          seed: snapshot.parameters.seed,
          geometryMs,
          readyMs,
          materialMs: readyMs - geometryMs,
          compileCalls: [...compileCalls],
        })
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  return samples
}, { runs, timeout })

console.log(JSON.stringify({
  species: species ?? 'ancient-oak',
  coldReadyMs,
  hot,
  maxHotMaterialMs: Math.max(...hot.map((sample) => sample.materialMs)),
  maxHotReadyMs: Math.max(...hot.map((sample) => sample.readyMs)),
  problems: problems.slice(0, 10),
}, null, 2))
await browser.close()
