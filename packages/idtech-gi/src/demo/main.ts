import {
  ACESFilmicToneMapping,
  Box3,
  Color,
  DirectionalLight,
  Group,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPURenderer,
  type Material,
  type Mesh,
} from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { SousaGI } from '../gpu/SousaGI.ts'
import { createDebugMaterial, type DebugView } from '../gpu/debugViews.ts'
import { createMovingLights } from './movingLights.ts'

const params = new URLSearchParams(location.search)
const modelUrl = params.get('model') ?? '/gi/sponza.glb'
const voxelResolution = Number(params.get('vox') ?? 144)
const probeResolution = Number(params.get('probes') ?? 16)
const probeSpacing = Number(params.get('spacing') ?? 0.9)
const raysPerProbe = Number(params.get('rays') ?? 64)
const octResolution = Number(params.get('oct') ?? 8)
const hysteresis = Number(params.get('hyst') ?? 0.985)
const startDisabled = params.get('gi') === '0' || params.get('gi') === 'off'
const movingLightCount = Number(params.get('lamps') ?? 3)
const sunOff = params.get('sun') === '0' || params.get('sun') === 'off'
// Parks the lamps without switching them off, so a stability measurement sees
// only estimator noise and not the lights legitimately moving.
const freezeLamps = params.get('freeze') === '1'
const exposure = Number(params.get('exposure') ?? 1.55)
// `?view=gi` paints the raw indirect irradiance with no albedo, no direct light
// and no tone curve in the way — the only reliable way to tell a dark render
// from an empty probe field.
const view = (params.get('view') ?? 'beauty') as DebugView

const canvas = document.querySelector('#c') as HTMLCanvasElement
const hud = document.querySelector('#hud') as HTMLElement

// Steep enough to reach the courtyard floor between the two galleries; a low
// sun leaves the whole ground floor on bounce light alone.
const SUN_DIRECTION = new Vector3(0.2, 0.95, 0.26).normalize()
const SUN_COLOUR = new Color(1, 0.94, 0.82)
const SUN_INTENSITY = 4.2

function status(text: string): void {
  hud.textContent = text
}

function resize(renderer: WebGPURenderer, camera: PerspectiveCamera): void {
  const width = canvas.clientWidth || window.innerWidth
  const height = canvas.clientHeight || window.innerHeight
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width, height, false)
  camera.aspect = width / Math.max(height, 1)
  camera.updateProjectionMatrix()
}

async function main(): Promise<void> {
  if (!navigator.gpu) {
    status('WebGPU is not available in this browser.')
    throw new Error('WebGPU is not available')
  }

  status('loading model…')
  const gltf = await new GLTFLoader().loadAsync(modelUrl, (event) => {
    if (event.total) status(`loading model… ${Math.round((event.loaded / event.total) * 100)}%`)
  })

  const model = new Group()
  model.add(gltf.scene)
  model.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(model)
  const size = bounds.getSize(new Vector3())
  const centre = bounds.getCenter(new Vector3())

  const scene = new Scene()
  scene.background = new Color(0x0b1016)
  scene.add(model)
  model.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    mesh.castShadow = true
    mesh.receiveShadow = true
  })

  // The rasterised key light; the GI rig traces the same sun so bounce and key
  // agree instead of looking like two separate lighting rigs.
  const sun = new DirectionalLight(SUN_COLOUR, SUN_INTENSITY)
  sun.position.copy(centre).addScaledVector(SUN_DIRECTION, size.length())
  sun.target.position.copy(centre)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.bias = -0.0006
  sun.shadow.normalBias = 0.02
  const span = Math.max(size.x, size.z) * 0.62
  sun.shadow.camera.left = -span
  sun.shadow.camera.right = span
  sun.shadow.camera.top = span
  sun.shadow.camera.bottom = -span
  sun.shadow.camera.near = 0.5
  sun.shadow.camera.far = size.length() * 2.2
  scene.add(sun)
  scene.add(sun.target)

  // Coloured lamps that fly through the arcade. Bounce you can only see in a
  // still is indistinguishable from a baked ambient term; bounce that travels
  // with a light is not.
  const lamps = createMovingLights(bounds, movingLightCount)
  scene.add(lamps.group)

  status('voxelising scene…')
  const gi = await SousaGI.create(model, {
    voxelResolution,
    probes: {
      resolution: probeResolution,
      spacing: probeSpacing,
      raysPerProbe,
      octResolution,
      hysteresis,
    },
    onProgress: (fraction, label) => status(`${label} ${(fraction * 100).toFixed(0)}%`),
  })
  gi.setSun(SUN_DIRECTION, SUN_COLOUR, sunOff ? 0 : SUN_INTENSITY)
  sun.visible = !sunOff
  gi.enabled = !startDisabled
  const materialCount = gi.attach(model)
  const debugMaterial = createDebugMaterial(gi, view)
  if (debugMaterial) {
    scene.overrideMaterial = debugMaterial as Material
    sun.visible = false
    lamps.group.visible = false
  }

  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    trackTimestamp: true,
  })
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = exposure
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFSoftShadowMap
  await renderer.init()

  const camera = new PerspectiveCamera(58, 1, Math.max(0.02, size.length() * 0.001), size.length() * 4)
  const camParam = params.get('cam')
  const targetParam = params.get('target')
  // Eye height in the middle of the open courtyard, looking down its long
  // axis — inside the atrium, not behind the outer wall.
  const eye = bounds.min.y + Math.max(1.7, size.y * 0.14)
  camera.position.set(centre.x + size.x * 0.26, eye, centre.z)
  if (camParam) camera.position.fromArray(camParam.split(',').map(Number))
  resize(renderer, camera)

  const controls = new OrbitControls(camera, canvas)
  controls.target.set(centre.x - size.x * 0.3, eye + size.y * 0.04, centre.z)
  if (targetParam) controls.target.fromArray(targetParam.split(',').map(Number))
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.maxDistance = size.length()
  controls.minDistance = size.length() * 0.02
  controls.update()

  window.addEventListener('resize', () => resize(renderer, camera))
  window.addEventListener('keydown', (event) => {
    if (event.key === 'g' || event.key === 'G') gi.enabled = !gi.enabled
    if (event.key === 'l' || event.key === 'L') lamps.setVisible(!lamps.visible)
    if (event.key === 's' || event.key === 'S') {
      sun.visible = !sun.visible
      gi.setSun(SUN_DIRECTION, SUN_COLOUR, sun.visible ? SUN_INTENSITY : 0)
    }
    if (event.key === '[') gi.intensity = Math.max(0, gi.intensity - 0.25)
    if (event.key === ']') gi.intensity = Math.min(4, gi.intensity + 0.25)
  })

  let frames = 0
  let window0 = performance.now()
  let fps = 0
  let computeMs = 0
  let renderMs = 0
  let timingBusy = false
  const start = performance.now()
  // Harness hook: pinning the lamp clock lets the latency probe teleport the
  // lights and count how many frames the bounce takes to follow.
  let pinnedTime: number | null = freezeLamps ? 4.2 : null
  const loop = () => {
    controls.update()
    lamps.update(pinnedTime ?? (freezeLamps ? 4.2 : (performance.now() - start) / 1000))
    gi.setPointLights(lamps.lights)
    gi.update(renderer, camera)
    renderer.render(scene, camera)
    frames += 1
    const now = performance.now()
    if (!timingBusy) {
      // GPU timestamps, not wall clock: at 60 Hz the frame time is the vsync
      // interval and says nothing about what the GI actually costs.
      timingBusy = true
      Promise.all([
        renderer.resolveTimestampsAsync('compute'),
        renderer.resolveTimestampsAsync('render'),
      ])
        .then(([c, r]) => {
          if (typeof c === 'number') computeMs = c
          if (typeof r === 'number') renderMs = r
        })
        .finally(() => {
          timingBusy = false
        })
    }
    if (now - window0 >= 500) {
      fps = (frames * 1000) / (now - window0)
      frames = 0
      window0 = now
      const s = gi.stats()
      status(
        `sponza  GI ${gi.enabled ? 'ON' : 'OFF'}  ${fps.toFixed(0)} fps\n` +
          `voxels ${s.voxelDims.join('×')} @ ${s.voxelCell.toFixed(3)}m  (${s.occupancy.toLocaleString()} filled)\n` +
          `probes ${s.probeCount.toLocaleString()}  cascade ${s.cascade}  ${s.raysPerFrame.toLocaleString()} rays/frame\n` +
          `gi compute ${computeMs.toFixed(2)}ms  raster ${renderMs.toFixed(2)}ms\n` +
          `lamps ${s.pointLights}  materials ${materialCount}\n` +
          `G gi · L lamps · S sun · [ ] intensity ${gi.intensity.toFixed(2)}`,
      )
    }
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  Object.assign(globalThis, {
    __gi: gi,
    __demo: {
      gi,
      lamps,
      pinLampTime(time: number | null) {
        pinnedTime = time
      },
    },
  })
}

main().catch((error) => {
  status(String(error))
  console.error(error)
})
