// Drives gi.html in real Chrome with real WebGPU and screenshots the settled
// frame. The headless @kmamal/gpu path cannot load a 52 MB glTF, and a GI rig
// that only converges after a few hundred frames has to be judged on a frame
// the browser actually produced.
//
//   node tools/gi/shot.mjs --name=hero --settle=6000
//
// Requires the dev server (`npm run gi`) to be up on --url.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const flags = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=')
    return [k, v]
  }),
)

const options = {
  name: flags.get('name') ?? 'gi',
  url: flags.get('url') ?? 'http://localhost:5173/gi.html',
  width: Number(flags.get('width') ?? 1280),
  height: Number(flags.get('height') ?? 760),
  settleMs: Number(flags.get('settle') ?? 8000),
  timeoutMs: Number(flags.get('timeout') ?? 180_000),
  out: flags.get('out') ?? 'captures/gi',
}

const query = new URLSearchParams()
for (const [k, v] of flags) {
  if (['name', 'url', 'width', 'height', 'settle', 'timeout', 'out'].includes(k)) continue
  query.set(k, v)
}
const target = query.size ? `${options.url}?${query}` : options.url

mkdirSync(resolve(options.out), { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-angle=metal',
    '--hide-scrollbars',
  ],
})
const page = await browser.newPage({ viewport: { width: options.width, height: options.height } })

const logs = []
page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`))
page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}\n${error.stack ?? ''}`))

await page.goto(target, { waitUntil: 'load', timeout: options.timeoutMs })

// The HUD only reports frames once the render loop is running.
try {
  await page.waitForFunction(
    () => /fps/.test(document.querySelector('#hud')?.textContent ?? ''),
    { timeout: options.timeoutMs },
  )
} catch {
  logs.push('[shot] HUD never reported an fps figure')
}

await page.waitForTimeout(options.settleMs)

const hud = await page.evaluate(() => document.querySelector('#hud')?.textContent ?? '')
const file = resolve(options.out, `${options.name}.png`)
await page.screenshot({ path: file })
writeFileSync(resolve(options.out, `${options.name}.log`), `${target}\n\n${hud}\n\n${logs.join('\n')}\n`)

console.log(`wrote ${file}`)
console.log(`--- hud ---\n${hud}`)
if (logs.length) console.log(`--- console ---\n${logs.slice(0, 60).join('\n')}`)

await browser.close()
