// Tree workspace review harness.
//
// Drives the real editor in real Chrome with real WebGPU, sets tree parameters
// through the live store, waits for the worker build to land, and screenshots
// settled frames from several angles. Frames from anywhere else are not
// evidence: the tree renders under the terrain editor's sky, sun and cascaded
// shadows, and no offline harness reproduces that stack.
//
//   node tools/browser/treeshot.mjs --name=oak --params=seed:12,species:ancient-oak
//
// Requires the dev server on --url.
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const flags = new Map(
  process.argv.slice(2).map((argument) => {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=')
    return [key, value]
  }),
)

const options = {
  name: flags.get('name') ?? 'tree',
  url: flags.get('url') ?? 'http://localhost:5173',
  width: Number(flags.get('width') ?? 1200),
  height: Number(flags.get('height') ?? 1200),
  out: flags.get('out') ?? 'captures/tree',
  timeoutMs: Number(flags.get('timeout') ?? 180_000),
  // Named viewpoints. Each is [azimuth deg, elevation deg, distance multiple of
  // tree height, target height as a fraction of tree height].
  shots: (flags.get('shots') ?? 'hero,trunk,bark,canopy,silhouette').split(','),
}

// A stand of trees from one recipe. Variety is a property of the generator
// that a single frame cannot show at all: the only way to see whether re-seeding
// produces different *trees* rather than the same tree jittered is to put
// several of them side by side.
const seedList = flags.get('seeds')?.split(',').map(Number).filter(Number.isFinite)

const paramText = flags.get('params')
const parameters = {}
if (paramText) {
  for (const pair of paramText.split(',')) {
    const [key, value] = pair.split(':')
    if (!key || value === undefined) continue
    parameters[key] = Number.isFinite(Number(value)) ? Number(value) : value
  }
}

// Distances are either a multiple of the tree's own reach (`distance`) or an
// absolute stand-off in metres (`metres`). A close-up has to be absolute: as a
// fraction of a thirty-metre crown, "0.5" put the camera seventeen metres from
// the trunk and every bark judgement was being made from across a field.
const VIEWS = {
  // Full tree, eye-level-ish three-quarter view: the shot that decides whether
  // the silhouette and the crown read as an oak.
  // Azimuths are chosen against the scene's fixed sun (142 degrees, 14 up) so
  // each frame tests a different lighting case rather than four random ones.
  hero: { azimuth: 100, elevation: 11, distance: 1.8, target: 0.46, fov: 38 },
  // Root flare and lower trunk, from a standing player's height.
  trunk: { azimuth: 124, elevation: 6, metres: 7.5, target: 0.16, fov: 50 },
  // Down onto the base. Root form is invisible from anywhere else.
  roots: { azimuth: 118, elevation: 16, metres: 11, target: 0.02, fov: 46, eye: 2.6 },
  // What a player sees standing next to it. Bark lives or dies here.
  bark: { azimuth: 138, elevation: -2, metres: 2.4, target: 0.075, fov: 55 },
  // Looking up into the canopy — where fake foliage falls apart.
  canopy: { azimuth: 186, elevation: 26, metres: 11, target: 0.66, fov: 52 },
  // Backlit profile against the sky: pure silhouette read.
  silhouette: { azimuth: -38, elevation: 7, distance: 2.05, target: 0.5, fov: 34 },
}

mkdirSync(resolve(options.out), { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  ignoreDefaultArgs: [
    '--disable-gpu',
    '--use-gl=swiftshader',
    '--disable-software-rasterizer',
    '--disable-gpu-compositing',
  ],
  args: ['--enable-unsafe-webgpu', '--hide-scrollbars'],
})
const page = await browser.newPage({
  viewport: { width: options.width, height: options.height },
  deviceScaleFactor: 1,
})
const problems = []
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(message.text())
})
page.on('pageerror', (error) => problems.push(String(error)))

const url = `${options.url}/?editor=tree&ui=off`
console.log(`opening ${url}`)
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60_000 })
await page.waitForFunction(() => Boolean(globalThis.__meshtree), null, {
  timeout: 60_000,
})

// Apply the recipe and wait for the worker to hand back a compiled asset for
// exactly that revision. Screenshotting on a timer photographs the previous
// tree on any recipe that takes longer than the guess.
const built = await page.evaluate(
  async ({ parameters, timeoutMs }) => {
    const { store } = globalThis.__meshtree
    if (Object.keys(parameters).length > 0) store.patchParameters(parameters)
    store.regenerate()
    const wanted = store.getSnapshot().buildRevision
    const started = performance.now()
    while (performance.now() - started < timeoutMs) {
      const snapshot = store.getSnapshot()
      if (snapshot.compiledRevision === wanted && snapshot.asset) {
        const lod = snapshot.asset.lods[0]
        return {
          waitedMs: Math.round(performance.now() - started),
          status: snapshot.status,
          parameters: snapshot.parameters,
          stats: snapshot.asset.stats,
          woodTriangles: lod.wood.indices.length / 3,
          foliageInstances: lod.foliage.count,
          bounds: snapshot.asset.graph.bounds,
        }
      }
      await new Promise((done) => setTimeout(done, 200))
    }
    return { timedOut: true, status: store.getSnapshot().status }
  },
  { parameters, timeoutMs: options.timeoutMs },
)

if (seedList && seedList.length > 0) {
  for (const seed of seedList) {
    const info = await page.evaluate(
      async ({ seed, timeoutMs }) => {
        const { store } = globalThis.__meshtree
        store.patchParameters({ seed })
        store.regenerate()
        const wanted = store.getSnapshot().buildRevision
        const started = performance.now()
        while (performance.now() - started < timeoutMs) {
          const snapshot = store.getSnapshot()
          if (snapshot.compiledRevision === wanted && snapshot.asset) {
            return {
              bounds: snapshot.asset.graph.bounds,
              parts: snapshot.asset.stats.partCount,
            }
          }
          await new Promise((done) => setTimeout(done, 200))
        }
        return null
      },
      { seed, timeoutMs: options.timeoutMs },
    )
    if (!info) {
      console.warn(`seed ${seed} timed out`)
      continue
    }
    const seedHeight = info.bounds.max.y - Math.min(0, info.bounds.min.y)
    const seedWidth = Math.max(
      info.bounds.max.x - info.bounds.min.x,
      info.bounds.max.z - info.bounds.min.z,
    )
    for (const shotName of options.shots) {
      const view = VIEWS[shotName]
      if (!view) continue
      await frameView(view, seedHeight, seedWidth)
      await page.waitForTimeout(1_000)
      const file = resolve(options.out, `${options.name}-${seed}-${shotName}.png`)
      await page.screenshot({ path: file })
      console.log(`wrote ${file} (${info.parts} parts, ${seedHeight.toFixed(1)}m)`)
    }
  }
  await browser.close()
  process.exit(0)
}

if (built.timedOut) {
  console.error(`tree build timed out: ${built.status}`)
  await browser.close()
  process.exit(1)
}

const height = built.bounds.max.y - Math.min(0, built.bounds.min.y)
const width = Math.max(
  built.bounds.max.x - built.bounds.min.x,
  built.bounds.max.z - built.bounds.min.z,
)
console.log(
  `built in ${built.waitedMs}ms · ${built.woodTriangles} wood tris · ` +
    `${built.foliageInstances} foliage instances · ${built.stats.partCount} parts · ` +
    `height ${height.toFixed(1)}m · spread ${width.toFixed(1)}m`,
)

// What the frame was actually lit and graded with. Inferring it from the source
// is how an offline harness and the editor drift apart without anyone noticing.
const lighting = await page.evaluate(() => {
  const { gl, scene } = globalThis.__meshtree
  const lights = []
  scene.traverse((object) => {
    if (!object.isLight || !object.visible) return
    lights.push({
      type: object.type,
      intensity: Number(object.intensity.toFixed(2)),
      colour: object.color?.getHexString?.() ?? null,
      castShadow: Boolean(object.castShadow),
    })
  })
  const casters = {}
  scene.traverse((object) => {
    if (!object.isMesh) return
    const group = object.name || object.parent?.name || 'unnamed'
    casters[group] ??= { meshes: 0, casting: 0, receiving: 0 }
    casters[group].meshes += 1
    if (object.castShadow) casters[group].casting += 1
    if (object.receiveShadow) casters[group].receiving += 1
  })
  return {
    toneMapping: gl.toneMapping,
    exposure: gl.toneMappingExposure,
    shadows: gl.shadowMap?.enabled ?? null,
    lights,
    casters,
  }
})
console.log(`lighting ${JSON.stringify(lighting)}`)

const written = []
for (const shotName of options.shots) {
  const view = VIEWS[shotName]
  if (!view) {
    console.warn(`unknown view "${shotName}"`)
    continue
  }
  await frameView(view, height, width)
  // Shadow maps and the sky dome re-anchor to the camera on the next frames.
  await page.waitForTimeout(1_200)
  const file = resolve(options.out, `${options.name}-${shotName}.png`)
  await page.screenshot({ path: file })
  written.push(file)
  console.log(`wrote ${file}`)
}

async function frameView(view, height, width) {
  await page.evaluate(
    ({ view, height, width }) => {
      const { camera, controls } = globalThis.__meshtree
      // Frame from the asset's real extent. A fixed distance clips a big oak
      // and strands a small one in the middle of the sky.
      const reach = Math.max(height, width)
      const radians = (degrees) => (degrees * Math.PI) / 180
      const distance = view.metres ?? reach * view.distance
      const azimuth = radians(view.azimuth)
      const elevation = radians(view.elevation)
      camera.fov = view.fov
      camera.near = 0.1
      camera.far = 60_000
      // `eye` pins the camera height in metres. Deriving it from the elevation
      // angle alone put the root close-up three metres up and inside the crown
      // of a low-branching veteran.
      camera.position.set(
        Math.sin(azimuth) * Math.cos(elevation) * distance,
        view.eye ?? Math.max(
          1.6,
          Math.sin(elevation) * distance + height * view.target * 0.4,
        ),
        Math.cos(azimuth) * Math.cos(elevation) * distance,
      )
      const target = view.targetY ?? height * view.target
      camera.lookAt(0, target, 0)
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld(true)
      // Move the controller's target with the camera, or its next update snaps
      // the aim straight back to the middle of the crown.
      if (controls) {
        controls.target.set(0, target, 0)
        controls.update()
      }
    },
    { view, height, width },
  )
}

if (problems.length > 0) {
  console.warn(`console errors:\n  ${problems.slice(0, 10).join('\n  ')}`)
}
await browser.close()
console.log(JSON.stringify({ built, written }, null, 2))
