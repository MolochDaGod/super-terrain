const expression = process.argv.slice(2).join(' ')
if (!expression) throw new Error('Pass a JavaScript expression to evaluate')

const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json()
const target = targets.find((entry) => entry.type === 'page' && entry.url.includes('127.0.0.1:5173'))
if (!target) throw new Error('Mesh Terrain CDP target not found')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})
const result = await new Promise((resolve, reject) => {
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
  socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true },
  }))
})
console.log(JSON.stringify(result, null, 2))
socket.close()
