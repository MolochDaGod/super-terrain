const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json()
const target = targets.find((entry) => entry.type === 'page' && entry.url.includes('127.0.0.1:5173'))
if (!target) throw new Error('Mesh Terrain CDP target not found')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let nextId = 1
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (!message.id) return
  const handler = pending.get(message.id)
  if (!handler) return
  pending.delete(message.id)
  if (message.error) handler.reject(new Error(JSON.stringify(message.error)))
  else handler.resolve(message.result)
}
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})

function call(method, params = {}) {
  const id = nextId++
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  socket.send(JSON.stringify({ id, method, params }))
  return result
}

await call('Runtime.enable')
await call('Profiler.enable')
await call('Profiler.setSamplingInterval', { interval: 500 })

const readiness = await call('Runtime.evaluate', {
  expression: `({
    handle: Boolean(globalThis.__meshtree),
    placements: globalThis.__meshtree?.store.getSnapshot().placements.length,
    canvas: [document.querySelector('canvas')?.width, document.querySelector('canvas')?.height],
  })`,
  returnByValue: true,
})
console.log(JSON.stringify({ phase: 'ready', ...readiness.result.value }))
if (!readiness.result.value.handle || readiness.result.value.placements !== 480) {
  throw new Error('Expected the ready 480-tree scene before CPU profiling')
}

await call('Profiler.start')
const frameWait = call('Runtime.evaluate', {
  expression: `(async () => {
    const frames = []
    let previous = performance.now()
    for (let i = 0; i < 240; i += 1) {
      await new Promise(requestAnimationFrame)
      const now = performance.now()
      frames.push(now - previous)
      previous = now
    }
    return frames
  })()`,
  awaitPromise: true,
  returnByValue: true,
})
const frames = (await frameWait).result.value
const { profile } = await call('Profiler.stop')

const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
const exclusiveUs = new Map()
const inclusiveUs = new Map()
for (let index = 0; index < profile.samples.length; index += 1) {
  const nodeId = profile.samples[index]
  const delta = profile.timeDeltas[index] ?? 0
  exclusiveUs.set(nodeId, (exclusiveUs.get(nodeId) ?? 0) + delta)
  let cursor = nodes.get(nodeId)
  while (cursor) {
    inclusiveUs.set(cursor.id, (inclusiveUs.get(cursor.id) ?? 0) + delta)
    cursor = cursor.parent ? nodes.get(cursor.parent) : undefined
  }
}

const row = (node, timeUs) => ({
  function: node.callFrame.functionName || '(anonymous)',
  url: node.callFrame.url.replace('http://127.0.0.1:5173/', ''),
  line: node.callFrame.lineNumber + 1,
  selfMs: (exclusiveUs.get(node.id) ?? 0) / 1000,
  totalMs: timeUs / 1000,
})
const useful = (node) => !['(idle)', '(program)', '(root)'].includes(node.callFrame.functionName)
const topExclusive = [...exclusiveUs]
  .map(([id, time]) => [nodes.get(id), time])
  .filter(([node]) => useful(node))
  .sort((a, b) => b[1] - a[1])
  .slice(0, 30)
  .map(([node, time]) => row(node, time))
const topInclusive = [...inclusiveUs]
  .map(([id, time]) => [nodes.get(id), time])
  .filter(([node]) => useful(node))
  .sort((a, b) => b[1] - a[1])
  .slice(0, 30)
  .map(([node, time]) => row(node, time))

const sortedFrames = [...frames].sort((a, b) => a - b)
const frameStats = {
  samples: frames.length,
  median: sortedFrames[Math.floor(sortedFrames.length * 0.5)],
  p95: sortedFrames[Math.floor(sortedFrames.length * 0.95)],
  mean: frames.reduce((sum, value) => sum + value, 0) / frames.length,
}
console.log(JSON.stringify({ phase: 'profile', durationMs: (profile.endTime - profile.startTime) / 1000, frameStats, topExclusive, topInclusive }))
socket.close()
