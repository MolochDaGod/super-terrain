import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const flags = new Map(process.argv.slice(2).map(a => { const [k,v='true']=a.replace(/^--/,'').split('='); return [k,v] }))
const out = flags.get('out') ?? 'captures/grass'
const name = flags.get('name') ?? 'grass'
const wait = Number(flags.get('wait') ?? 12000)
const port = flags.get('port') ?? '5175'
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  ignoreDefaultArgs: ['--disable-gpu','--use-gl=swiftshader','--disable-software-rasterizer','--disable-gpu-compositing'],
  args: ['--enable-unsafe-webgpu','--hide-scrollbars'],
})
const page = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 })
const problems = []
page.on('console', m => { if (m.type()==='error'||m.type()==='warning') problems.push(`[${m.type()}] ${m.text()}`) })
page.on('pageerror', e => problems.push('[pageerror] '+String(e)))

const q = new URLSearchParams({ editor: 'tree' })
if (flags.get('cam')) q.set('cam', flags.get('cam'))
if (flags.get('ui') === 'off') q.set('ui','off')
const url = `http://localhost:${port}/?${q.toString()}`
console.log('opening', url)
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 60000 })
await page.waitForTimeout(wait)

if (flags.get('cam')) {
  const [x,y,z] = flags.get('cam').split(',').map(Number)
  const t = (flags.get('target') ?? '0,1,0').split(',').map(Number)
  await page.evaluate(({x,y,z,t}) => {
    const h = globalThis.__meshtree
    if (!h) return
    h.camera.position.set(x,y,z)
    if (h.controls) { h.controls.target.set(t[0],t[1],t[2]); h.controls.update() }
    h.camera.lookAt(t[0],t[1],t[2]); h.camera.updateMatrixWorld(true)
  }, {x,y,z,t})
  await page.waitForTimeout(2500)
}

await page.screenshot({ path: `${out}/${name}.png` })
console.log('--- console ---')
console.log([...new Set(problems)].slice(0,40).join('\n') || '(none)')
await browser.close()
