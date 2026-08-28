import {
  ACESFilmicToneMapping,
  Color,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
} from 'three/webgpu'
import { IdTechGI } from '../IdTechGI.ts'
import { SCENE_BUILDERS, type SceneName } from '../scenes.ts'

const params = new URLSearchParams(location.search)
const sceneName = (params.get('scene') ?? 'simple') as SceneName
const startDisabled = params.get('gi') === '0' || params.get('gi') === 'off'

const canvas = document.querySelector('#c') as HTMLCanvasElement
const hud = document.querySelector('#hud') as HTMLElement

function resizeRenderer(renderer: WebGPURenderer): void {
  const width = canvas.clientWidth || window.innerWidth
  const height = canvas.clientHeight || window.innerHeight
  renderer.setSize(width, height, false)
}

async function main(): Promise<void> {
  if (!navigator.gpu) {
    hud.textContent = 'WebGPU is not available in this browser.'
    throw new Error('WebGPU is not available')
  }
  const builder = SCENE_BUILDERS[sceneName] ?? SCENE_BUILDERS.simple
  const giScene = builder()
  const gi = new IdTechGI(giScene, {
    gpuCompute: true,
    gatherWidth: Math.max(32, Math.floor((canvas.clientWidth || 640) * 0.5)),
    gatherHeight: Math.max(32, Math.floor((canvas.clientHeight || 400) * 0.5)),
  })
  gi.setEnabled(!startDisabled)
  gi.warm(9)

  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  })
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  resizeRenderer(renderer)
  await renderer.init()

  const scene = new Scene()
  scene.background = new Color(0x05070a)
  gi.populateThreeScene(scene)

  const camera = new PerspectiveCamera(
    giScene.camera.fovY,
    (canvas.clientWidth || 1) / (canvas.clientHeight || 1),
    0.05,
    200,
  )
  camera.position.set(
    giScene.camera.position[0],
    giScene.camera.position[1],
    giScene.camera.position[2],
  )
  camera.lookAt(
    giScene.camera.target[0],
    giScene.camera.target[1],
    giScene.camera.target[2],
  )

  window.addEventListener('resize', () => {
    resizeRenderer(renderer)
    camera.aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1)
    camera.updateProjectionMatrix()
  })

  const names = Object.keys(SCENE_BUILDERS) as SceneName[]
  window.addEventListener('keydown', (event) => {
    if (event.key === 'g' || event.key === 'G') {
      gi.setEnabled(!gi.enabled)
    }
    if (event.key === '1' || event.key === '2' || event.key === '3') {
      const next = names[Number(event.key) - 1]
      if (!next) return
      const url = new URL(location.href)
      url.searchParams.set('scene', next)
      location.href = url.toString()
    }
  })

  let frames = 0
  let fpsWindow = performance.now()
  let fps = 0
  const loop = () => {
    gi.tick(renderer, camera, canvas.clientWidth || 1, canvas.clientHeight || 1)
    renderer.render(scene, camera)
    frames += 1
    const now = performance.now()
    if (now - fpsWindow >= 500) {
      fps = (frames * 1000) / (now - fpsWindow)
      frames = 0
      fpsWindow = now
      hud.textContent = `${giScene.name}  GI ${gi.enabled ? 'ON' : 'OFF'}  ${fps.toFixed(0)} fps  (G toggle, 1/2/3 scenes)`
    }
    requestAnimationFrame(loop)
  }
  hud.textContent = `${giScene.name}  GI ${gi.enabled ? 'ON' : 'OFF'}  (G toggle, 1/2/3 scenes)`
  requestAnimationFrame(loop)

  ;(globalThis as unknown as { __idtechGi: IdTechGI }).__idtechGi = gi
}

main().catch((error) => {
  hud.textContent = String(error)
  console.error(error)
})
