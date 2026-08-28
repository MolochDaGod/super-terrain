import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ACESFilmicToneMapping,
  Color,
  PerspectiveCamera,
  Scene,
} from 'three/webgpu'
import { createHeadlessRenderer, alignCaptureWidth } from '../capture/headlessGpu.ts'
import { encodePng, flipVertically } from '../capture/png.ts'
import { IdTechGI } from '../../packages/idtech-gi/src/IdTechGI.ts'
import { renderCpuFrame } from '../../packages/idtech-gi/src/cpuRender.ts'
import {
  createForestStand,
  createSimpleRoom,
  createSponzaAtrium,
  type GiScene,
} from '../../packages/idtech-gi/src/scenes.ts'

const SCRATCH =
  process.env.GI_CAPTURE_DIR ??
  '/var/folders/rl/wx0372_n59d9k3spw65qmskw0000gp/T/grok-goal-e82dbea9898e/implementer'

function meanLuma(pixels: Uint8Array): number {
  let sum = 0
  const count = pixels.length / 4
  for (let i = 0; i < pixels.length; i += 4) {
    sum += (pixels[i] ?? 0) + (pixels[i + 1] ?? 0) + (pixels[i + 2] ?? 0)
  }
  return count === 0 ? 0 : sum / count / 3
}

function regionLuma(
  pixels: Uint8Array,
  width: number,
  height: number,
  region: [number, number, number, number],
): { luma: number; r: number; g: number; b: number } {
  const scaleX = width / 128
  const scaleY = height / 80
  const x0 = Math.floor(region[0] * scaleX)
  const y0 = Math.floor(region[1] * scaleY)
  const x1 = Math.min(width - 1, Math.floor(region[2] * scaleX))
  const y1 = Math.min(height - 1, Math.floor(region[3] * scaleY))
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = ((height - 1 - y) * width + x) * 4
      r += pixels[i] ?? 0
      g += pixels[i + 1] ?? 0
      b += pixels[i + 2] ?? 0
      n += 1
    }
  }
  const inv = n === 0 ? 0 : 1 / n
  return { luma: (r + g + b) * inv / 3, r: r * inv, g: g * inv, b: b * inv }
}

function writePng(path: string, pixels: Uint8Array, width: number, height: number): void {
  writeFileSync(path, encodePng(flipVertically(pixels, width, height), width, height))
}

async function captureScene(
  label: string,
  giScene: GiScene,
  width: number,
  height: number,
  outDir: string,
): Promise<{ on: Uint8Array; off: Uint8Array; timings: number[]; stats: string }> {
  const headless = await createHeadlessRenderer(width, height)
  headless.renderer.toneMapping = ACESFilmicToneMapping
  headless.renderer.toneMappingExposure = 1.05
  const gi = new IdTechGI(giScene, {
    gpuCompute: true,
    gatherWidth: Math.max(32, Math.floor(width * 0.5)),
    gatherHeight: Math.max(32, Math.floor(height * 0.5)),
  })
  gi.warm(9)
  const scene = new Scene()
  scene.background = new Color(0x05070a)
  gi.populateThreeScene(scene)
  const camera = new PerspectiveCamera(giScene.camera.fovY, width / height, 0.05, 200)
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

  const renderOnce = async () => {
    headless.renderer.render(scene, camera)
  }

  gi.setEnabled(true)
  gi.upload(giScene.camera.position)
  for (let i = 0; i < 4; i += 1) {
    gi.tick(headless.renderer, camera, width, height)
    headless.renderer.render(scene, camera)
  }
  gi.setEnabled(false)
  const off = await headless.capture(renderOnce)
  gi.setEnabled(true)
  const on = await headless.capture(renderOnce)

  const timings: number[] = []
  const started = performance.now()
  const frames = 12
  const elapsed = await headless.timeFrames(async () => {
    gi.tick(headless.renderer, camera, width, height)
    headless.renderer.render(scene, camera)
  }, frames)
  const per = elapsed / frames
  timings.push(per)
  const stats = [
    `scene ${label}`,
    `webgpu frames ${frames} totalMs ${elapsed.toFixed(2)} perFrameMs ${per.toFixed(2)}`,
    `pipeline frame ${gi.pipeline.frame} lastCascade ${gi.pipeline.lastStats.cascade} probes ${gi.pipeline.lastStats.probesUpdated} rays ${gi.pipeline.lastStats.raysTraced} cacheInserts ${gi.pipeline.lastStats.cacheInserts} cacheReuses ${gi.pipeline.lastStats.cacheReuses}`,
    `meanLuma off ${meanLuma(off).toFixed(2)} on ${meanLuma(on).toFixed(2)}`,
    `unlitRegion off ${JSON.stringify(regionLuma(off, width, height, giScene.unlitRegion))} on ${JSON.stringify(regionLuma(on, width, height, giScene.unlitRegion))}`,
    `budgeted interleaved cascade updates, not path-tracer accumulation`,
    `startedAt ${started}`,
  ].join('\n')

  writePng(resolve(outDir, `gi-${label}-off.png`), off, width, height)
  writePng(resolve(outDir, `gi-${label}-on.png`), on, width, height)

  const cpuOff = renderCpuFrame(gi.pipeline, giScene.voxel, giScene.camera, 160, 100, false)
  const cpuOn = renderCpuFrame(gi.pipeline, giScene.voxel, giScene.camera, 160, 100, true)
  writeFileSync(resolve(outDir, `gi-${label}-cpu-off.png`), encodePng(cpuOff.rgba, 160, 100))
  writeFileSync(resolve(outDir, `gi-${label}-cpu-on.png`), encodePng(cpuOn.rgba, 160, 100))

  headless.dispose()
  gi.dispose()
  return { on, off, timings, stats }
}

async function main(): Promise<void> {
  mkdirSync(SCRATCH, { recursive: true })
  const width = alignCaptureWidth(640)
  const height = 400
  try {
    const simple = await captureScene('simple', createSimpleRoom(), width, height, SCRATCH)
    writeFileSync(resolve(SCRATCH, 'gi-simple.log'), simple.stats + '\n')
    const simple2 = await captureScene('simple', createSimpleRoom(), width, height, SCRATCH)
    writeFileSync(
      resolve(SCRATCH, 'gi-simple.log'),
      simple.stats + '\n--- second launch ---\n' + simple2.stats + '\n',
    )

    const hard = await captureScene('hard', createSponzaAtrium(), width, height, SCRATCH)
    const hard2 = await captureScene('hard', createSponzaAtrium(), width, height, SCRATCH)
    writeFileSync(
      resolve(SCRATCH, 'gi-hard.log'),
      hard.stats + '\n--- second launch ---\n' + hard2.stats + '\n',
    )
    writeFileSync(resolve(SCRATCH, 'gi-hard-on.png'), encodePng(
      flipVertically(hard.on, width, height),
      width,
      height,
    ))

    const forest = await captureScene('forest', createForestStand(), width, height, SCRATCH)
    writeFileSync(resolve(SCRATCH, 'gi-forest.log'), forest.stats + '\n')

    writeFileSync(
      resolve(SCRATCH, 'gi-timing.log'),
      [
        simple.stats,
        hard.stats,
        forest.stats,
        'path is per-frame interleaved (1 cascade / frame) with cache reuse and half-res gather, not accumulating samples toward a still.',
      ].join('\n\n') + '\n',
    )
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
    writeFileSync(resolve(SCRATCH, 'gi-launch-unavailable.log'), message + '\n')
    console.error(message)
    process.exitCode = 1
  }
}

await main()
