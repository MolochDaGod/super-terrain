const CDP_PORT = Number(process.env.CDP_PORT ?? 9223)
const TARGET_URL = `http://127.0.0.1:${CDP_PORT}/json/list`
const cpuOnly = process.env.MESHTERRAIN_CPU_ONLY === '1'

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) {
        this.events.push(message)
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    }
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve
      this.socket.onerror = reject
    })
  }

  call(method, params = {}) {
    const id = this.nextId++
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.socket.send(JSON.stringify({ id, method, params }))
    return promise
  }

  close() {
    this.socket.close()
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function evaluate(client, expression) {
  const result = await client.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'CDP evaluation failed')
  }
  return result.result.value
}

function metricMap(result) {
  return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]))
}

function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  return {
    samples: sorted.length,
    min: sorted[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  }
}

const targets = await (await fetch(TARGET_URL)).json()
const target = targets.find((entry) => entry.type === 'page' && entry.url.includes('127.0.0.1:5173'))
if (!target) throw new Error('Mesh Terrain page was not found on the CDP endpoint')

const client = new CdpClient(target.webSocketDebuggerUrl)
await client.open()
await Promise.all([
  client.call('Page.enable'),
  client.call('Runtime.enable'),
  client.call('Performance.enable'),
  client.call('Log.enable'),
])

await client.call('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 720,
  deviceScaleFactor: 1,
  mobile: false,
})
const sceneAlreadyReady = await evaluate(client, `Boolean(globalThis.__meshtree)`)
if (!sceneAlreadyReady) {
  await client.call('Page.reload', { ignoreCache: true })
  // Page.reload acknowledges before the old execution context is torn down.
  // Let navigation begin so the readiness poll cannot accept the outgoing page.
  await sleep(2_000)
}

for (let attempt = 0; attempt < 240; attempt += 1) {
  const ready = await evaluate(client, `Boolean(globalThis.__meshtree && document.readyState === 'complete')`)
  if (ready) break
  if (attempt === 239) {
    const diagnostics = await evaluate(client, `({
      href: location.href,
      readyState: document.readyState,
      title: document.title,
      bodyText: document.body?.innerText?.slice(0, 2000),
      canvasCount: document.querySelectorAll('canvas').length,
      hasWebGpu: Boolean(navigator.gpu),
      hasHandle: Boolean(globalThis.__meshtree),
    })`)
    const errors = client.events.filter((event) =>
      event.method === 'Runtime.exceptionThrown' ||
      event.method === 'Runtime.consoleAPICalled' ||
      event.method === 'Log.entryAdded'
    )
    throw new Error(`Timed out waiting for the scene runtime: ${JSON.stringify({ diagnostics, errors })}`)
  }
  await sleep(250)
}

const skipGenerate = process.env.MESHTERRAIN_SKIP_GENERATE === '1'
const generated = await evaluate(client, `(() => {
  const { store } = globalThis.__meshtree
  if (!${skipGenerate}) {
    store.generateForest({
      forestPreset: 'mossy-old-growth',
      forestSeed: 42017,
      forestDensity: 1,
      forestRadius: 140,
    })
  }
  const snapshot = store.getSnapshot()
  return {
    placements: snapshot.placements.length,
    rocks: snapshot.rocks.length,
    prototypes: Object.keys(snapshot.prototypes).length,
    status: snapshot.status,
  }
})()`)
console.log(JSON.stringify({ phase: 'generated', ...generated }))

let buildState
for (let attempt = 0; attempt < 2400; attempt += 1) {
  buildState = await evaluate(client, `(() => {
    const snapshot = globalThis.__meshtree.store.getSnapshot()
    const prototypes = Object.values(snapshot.prototypes)
    return {
      placements: snapshot.placements.length,
      prototypes: prototypes.length,
      assetsReady: prototypes.filter((prototype) => prototype.asset).length,
      building: prototypes.filter((prototype) => prototype.building).length,
      warming: prototypes.filter((prototype) => prototype.warmingMaterials).length,
      progress: prototypes.reduce((sum, prototype) => sum + prototype.buildProgress, 0) / prototypes.length,
      status: snapshot.status,
    }
  })()`)
  if (buildState.assetsReady === buildState.prototypes && buildState.building === 0 && buildState.warming === 0) break
  if (attempt % 20 === 0) console.log(JSON.stringify({ phase: 'building', ...buildState }))
  if (attempt === 2399) throw new Error(`Timed out building forest: ${JSON.stringify(buildState)}`)
  await sleep(250)
}
console.log(JSON.stringify({ phase: 'ready', ...buildState }))

const inventory = await evaluate(client, `(async () => {
  const { gl, scene, camera, controls } = globalThis.__meshtree
  camera.position.set(18, 5.5, 24)
  if (controls) {
    controls.target.set(0, 7, 0)
    controls.enableDamping = false
    controls.update()
    controls.enabled = false
  } else {
    camera.lookAt(0, 7, 0)
  }
  camera.updateMatrixWorld(true)
  for (let i = 0; i < 90; i += 1) await new Promise(requestAnimationFrame)
  const names = {}
  let meshes = 0
  let instancedMeshes = 0
  scene.traverse((object) => {
    if (object.name) names[object.name] = (names[object.name] ?? 0) + 1
    if (object.isMesh) meshes += 1
    if (object.isInstancedMesh) instancedMeshes += 1
  })
  return {
    canvas: { cssWidth: gl.domElement.clientWidth, cssHeight: gl.domElement.clientHeight, width: gl.domElement.width, height: gl.domElement.height },
    renderer: gl.info.render,
    meshes,
    instancedMeshes,
    names,
  }
})()`)
console.log(JSON.stringify({ phase: 'inventory', ...inventory }))

const scenarioExpression = (scenario, frames) => `(async () => {
  const { gl, scene } = globalThis.__meshtree
  const profile = globalThis.__cdpForestProfile ??= {
    visibility: new Map(),
    materialLights: new Map(),
    shadowEnabled: gl.shadowMap.enabled,
  }
  profile.materialLights ??= new Map()
  if (profile.visibility.size === 0) scene.traverse((object) => profile.visibility.set(object, object.visible))
  if (profile.materialLights.size === 0) scene.traverse((object) => {
    if (object.material && 'lights' in object.material) {
      profile.materialLights.set(object.material, object.material.lights)
    }
  })
  for (const [object, visible] of profile.visibility) object.visible = visible
  for (const [material, lights] of profile.materialLights) {
    if (material.lights === lights) continue
    material.lights = lights
    material.needsUpdate = true
  }
  gl.shadowMap.enabled = profile.shadowEnabled

  const scenario = ${JSON.stringify(scenario)}
  if (scenario === 'no-trees') {
    scene.traverse((object) => { if (object.name.startsWith('forest-prototype-')) object.visible = false })
  } else if (scenario === 'no-leaves') {
    scene.traverse((object) => { if (object.name.startsWith('leaf-cards')) object.visible = false })
  } else if (scenario === 'no-wood') {
    scene.traverse((object) => { if (object.name === 'forest-instanced-wood') object.visible = false })
  } else if (scenario === 'no-ground-foliage') {
    scene.traverse((object) => { if (object.name === 'ground-foliage') object.visible = false })
  } else if (scenario === 'post-only') {
    scene.traverse((object) => { if (object.isMesh || object.isPoints || object.isLine) object.visible = false })
  } else if (scenario === 'no-shadows') {
    gl.shadowMap.enabled = false
  } else if (scenario === 'leaf-only-lit' || scenario === 'leaf-only-unlit') {
    gl.shadowMap.enabled = false
    scene.traverse((object) => {
      if (object.isMesh && !object.name.startsWith('leaf-cards')) object.visible = false
      if (scenario === 'leaf-only-unlit' && object.name.startsWith('leaf-cards') && object.material) {
        object.material.lights = false
        object.material.needsUpdate = true
      }
    })
  } else if (scenario === 'wood-only-lit' || scenario === 'wood-only-unlit') {
    gl.shadowMap.enabled = false
    scene.traverse((object) => {
      if (object.isMesh && object.name !== 'forest-instanced-wood') object.visible = false
      if (scenario === 'wood-only-unlit' && object.name === 'forest-instanced-wood' && object.material) {
        object.material.lights = false
        object.material.needsUpdate = true
      }
    })
  }

  for (let i = 0; i < 30; i += 1) await new Promise(requestAnimationFrame)
  await gl.resolveTimestampsAsync('render')
  await gl.resolveTimestampsAsync('compute')
  const raf = []
  let previous = performance.now()
  for (let i = 0; i < ${frames}; i += 1) {
    await new Promise(requestAnimationFrame)
    const now = performance.now()
    raf.push(now - previous)
    previous = now
  }
  const gpuLast = await gl.resolveTimestampsAsync('render')
  const computeLast = await gl.resolveTimestampsAsync('compute')
  const pool = gl.backend.timestampQueryPool.render
  const frameSet = new Set(pool.frames)
  const gpuByFrame = {}
  for (const [uid, duration] of pool.timestamps) {
    const match = uid.match(/:f(\\d+)$/)
    if (!match) continue
    const frame = Number(match[1])
    if (!frameSet.has(frame)) continue
    gpuByFrame[frame] = (gpuByFrame[frame] ?? 0) + duration
  }
  const computePool = gl.backend.timestampQueryPool.compute
  const computeFrameSet = new Set(computePool?.frames ?? [])
  const computeByFrame = {}
  for (const [uid, duration] of computePool?.timestamps ?? []) {
    const match = uid.match(/:f(\\d+)$/)
    if (!match) continue
    const frame = Number(match[1])
    if (!computeFrameSet.has(frame)) continue
    computeByFrame[frame] = (computeByFrame[frame] ?? 0) + duration
  }
  return {
    scenario,
    gpuLast,
    computeLast,
    gpu: Object.values(gpuByFrame),
    compute: Object.values(computeByFrame),
    raf,
    renderInfo: { ...gl.info.render },
  }
})()`

const results = []
const scenarios = cpuOnly
  ? []
  : (process.env.MESHTERRAIN_SCENARIOS ?? 'baseline,no-trees,no-ground-foliage,no-shadows,post-only').split(',')
if (scenarios.length > 0) {
  // HMR can replace every scene object while the page-global profile state
  // still points at the retired graph. Capture the authoritative live graph
  // afresh for each harness run.
  await evaluate(client, `delete globalThis.__cdpForestProfile`)
}
for (const scenario of scenarios) {
  const sample = await evaluate(client, scenarioExpression(scenario, 60))
  results.push({
    scenario,
    gpuMs: stats(sample.gpu),
    computeMs: stats(sample.compute),
    rafMs: stats(sample.raf),
    renderInfo: sample.renderInfo,
  })
  console.log(JSON.stringify({ phase: 'gpu-sample', ...results.at(-1) }))
}

if (!cpuOnly) {
  await evaluate(client, `(() => {
    const { gl } = globalThis.__meshtree
    const profile = globalThis.__cdpForestProfile
    if (!profile) return
    for (const [object, visible] of profile.visibility) object.visible = visible
    for (const [material, lights] of profile.materialLights) {
      material.lights = lights
      material.needsUpdate = true
    }
    gl.shadowMap.enabled = profile.shadowEnabled
  })()`)
}

let cpu = null
if (process.env.MESHTERRAIN_SKIP_CPU !== '1') {
  await evaluate(client, `(async () => {
    for (let i = 0; i < 300; i += 1) await new Promise(requestAnimationFrame)
  })()`)
  const cpuBefore = metricMap(await client.call('Performance.getMetrics'))
  const cpuFrames = await evaluate(client, `(async () => {
  const deltas = []
  let previous = performance.now()
  for (let i = 0; i < 360; i += 1) {
    await new Promise(requestAnimationFrame)
    const now = performance.now()
    deltas.push(now - previous)
    previous = now
  }
  return deltas
})()`)
  const cpuAfter = metricMap(await client.call('Performance.getMetrics'))
  cpu = {
    frames: cpuFrames.length,
    elapsedMs: cpuFrames.reduce((sum, value) => sum + value, 0),
    taskMsPerFrame: (cpuAfter.TaskDuration - cpuBefore.TaskDuration) * 1000 / cpuFrames.length,
    scriptMsPerFrame: (cpuAfter.ScriptDuration - cpuBefore.ScriptDuration) * 1000 / cpuFrames.length,
    layoutMsPerFrame: (cpuAfter.LayoutDuration - cpuBefore.LayoutDuration) * 1000 / cpuFrames.length,
    rafMs: stats(cpuFrames),
  }
  console.log(JSON.stringify({ phase: 'cpu-sample', ...cpu }))
}
console.log(JSON.stringify({ phase: 'complete', generated, buildState, inventory, results, cpu }))

client.close()
