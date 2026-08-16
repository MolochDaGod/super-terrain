import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AgXToneMapping, PCFSoftShadowMap } from 'three/webgpu'
import { alignCaptureWidth, createHeadlessRenderer } from './headlessGpu'
import { encodePng } from './png'
import { CAMERA_PRESETS } from './presets'
import { buildCaptureScene } from './scene'
import { createTerrainRenderPipeline } from '../../src/terrain/rendering/post/createTerrainRenderPipeline'
import { HAZE_DENSITY } from '../../src/terrain/rendering/full/atmosphere'
import { setSunAngles } from '../../src/terrain/rendering/environment/sunPosition'
import type { TerrainRenderMode } from '../../src/terrain/rendering/renderModes'
import type { FullMaterialDebug } from '../../src/terrain/rendering/full/createFullTerrainMaterial'

interface CaptureOptions {
  mode: TerrainRenderMode
  width: number
  height: number
  outputDirectory: string
  only?: string[]
  exposure: number
  haze?: number
  sunElevation?: number
  sunAzimuth?: number
  cascadedShadows: boolean
  shadows: boolean
  debug: FullMaterialDebug
  frames: number
  switchModes: boolean
  dumpShader: boolean
  effects: boolean
  suffix: string
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  mkdirSync(options.outputDirectory, { recursive: true })

  const started = Date.now()
  const headless = await createHeadlessRenderer(options.width, options.height)
  headless.renderer.toneMapping = AgXToneMapping
  headless.renderer.toneMappingExposure = options.exposure
  if (options.haze !== undefined) HAZE_DENSITY.value = options.haze
  if (options.sunElevation !== undefined || options.sunAzimuth !== undefined) {
    setSunAngles(options.sunElevation ?? 34, options.sunAzimuth ?? 302)
  }
  headless.renderer.shadowMap.enabled = true
  headless.renderer.shadowMap.type = PCFSoftShadowMap

  if (options.dumpShader) {
    await dumpShader(headless, options)
    return
  }

  if (options.switchModes) {
    await runModeSwitch(headless, options)
    return
  }

  const presets = options.only
    ? CAMERA_PRESETS.filter((preset) => options.only?.includes(preset.label))
    : CAMERA_PRESETS

  for (const preset of presets) {
    const buildStarted = Date.now()
    const capture = buildCaptureScene(
      preset,
      options.mode,
      options.width / options.height,
      {
        cascadedShadows: options.cascadedShadows,
        shadows: options.shadows,
        debug: options.debug,
      },
    )
    capture.scene.matrixWorldAutoUpdate = true
    const rendering = createTerrainRenderPipeline(
      headless.renderer,
      capture.scene,
      capture.camera,
      options.mode,
      options.effects,
    )
    const built = Date.now()
    // First frame includes pipeline setup and shader compilation; the steady
    // state is what has to fit in a browser's frame budget, so measure both.
    const pixels = await headless.capture(() => rendering.pipeline.renderAsync())
    const rendered = Date.now()
    let steadyMs = 0
    if (options.frames > 0) {
      // One warm-up frame so pipeline creation is not counted.
      await headless.timeFrame(() => rendering.pipeline.renderAsync())
      const steadyStart = Date.now()
      for (let frame = 0; frame < options.frames; frame += 1) {
        await headless.timeFrame(() => rendering.pipeline.renderAsync())
      }
      steadyMs = (Date.now() - steadyStart) / options.frames
    }
    const file = resolve(
      options.outputDirectory,
      `${preset.label}-${options.mode}${options.suffix}.png`,
    )
    writeFileSync(file, encodePng(pixels, options.width, options.height))
    rendering.dispose()
    capture.dispose()
    const stats = describeExposure(pixels)
    const steady = options.frames > 0 ? `  steady ${steadyMs.toFixed(0).padStart(5)}ms` : ''
    console.log(
      `${preset.label.padEnd(10)} build ${String(built - buildStarted).padStart(5)}ms  ` +
        `first ${String(rendered - built).padStart(5)}ms${steady}  ${stats}  -> ${file}`,
    )
  }

  // Shader diagnostics from failed pipelines resolve asynchronously; give them
  // a moment to land before the process exits or they are lost.
  await new Promise((done) => setTimeout(done, 800))
  headless.dispose()
  console.log(`captured ${presets.length} views in ${Date.now() - started}ms`)
  process.exit(0)
}

/**
 * Exposure telemetry for the review loop: a pass that clips highlights or
 * crushes shadows is usually the real reason a frame reads as "flat", and that
 * is far easier to see as numbers than by eye.
 */
function describeExposure(pixels: Uint8Array): string {
  let sum = 0
  let clipped = 0
  let crushed = 0
  const total = pixels.length / 4
  for (let index = 0; index < pixels.length; index += 4) {
    const luminance =
      pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722
    sum += luminance
    if (luminance > 250) clipped += 1
    if (luminance < 6) crushed += 1
  }
  return (
    `mean ${(sum / total).toFixed(1).padStart(5)}  ` +
    `clip ${((clipped / total) * 100).toFixed(1).padStart(4)}%  ` +
    `black ${((crushed / total) * 100).toFixed(1).padStart(4)}%`
  )
}

/**
 * Writes the generated WGSL for the terrain material. Pipeline creation time —
 * which is what stalls a browser on the first frame — tracks the size of this
 * far more than the per-frame cost does.
 */
async function dumpShader(
  headless: Awaited<ReturnType<typeof createHeadlessRenderer>>,
  options: CaptureOptions,
): Promise<void> {
  const preset = CAMERA_PRESETS.find((entry) => entry.label === (options.only?.[0] ?? 'cliff'))
  if (!preset) throw new Error('capture: unknown preset for shader dump')
  const capture = buildCaptureScene(preset, options.mode, options.width / options.height, {
    radiusSections: 1,
  })
  const mesh = capture.scene.children[0].children[0]
  const shader = await headless.renderer.debug.getShaderAsync(
    capture.scene,
    capture.camera,
    mesh as never,
  )
  const file = resolve(options.outputDirectory, `terrain-${options.mode}.wgsl`)
  writeFileSync(file, `${shader.vertexShader}\n\n${shader.fragmentShader}`)
  console.log(
    `${options.mode} fragment shader: ${shader.fragmentShader.split('\n').length} lines, ` +
      `${(shader.fragmentShader.length / 1024).toFixed(1)} kB -> ${file}`,
  )
  capture.dispose()
}

/**
 * Reproduces what the editor does when the quality toggle is flipped: build the
 * scene in one mode, render it, then rebuild materials, environment and output
 * chain in the other mode against the same live device. Capturing one mode per
 * process — which is what the normal path does — cannot catch anything that
 * only breaks on the transition.
 */
async function runModeSwitch(
  headless: Awaited<ReturnType<typeof createHeadlessRenderer>>,
  options: CaptureOptions,
): Promise<void> {
  const preset = CAMERA_PRESETS.find((entry) => entry.label === (options.only?.[0] ?? 'cliff'))
  if (!preset) throw new Error('capture: unknown preset for switch test')
  const order: TerrainRenderMode[] = ['preview', 'full', 'preview', 'full']

  for (const [index, mode] of order.entries()) {
    const started = Date.now()
    const capture = buildCaptureScene(preset, mode, options.width / options.height, {
      cascadedShadows: options.cascadedShadows,
      shadows: options.shadows,
      debug: options.debug,
    })
    const rendering = createTerrainRenderPipeline(
      headless.renderer,
      capture.scene,
      capture.camera,
      mode,
    )
    headless.renderer.shadowMap.enabled = mode === 'full'
    const pixels = await headless.capture(() => rendering.pipeline.renderAsync())
    writeFileSync(
      resolve(options.outputDirectory, `switch-${index}-${mode}.png`),
      encodePng(pixels, options.width, options.height),
    )
    console.log(
      `switch ${index} -> ${mode.padEnd(8)} ${String(Date.now() - started).padStart(6)}ms  ` +
        describeExposure(pixels),
    )
    rendering.dispose()
    capture.dispose()
  }
  console.log('mode switching survived four transitions')
}

function parseArguments(argv: string[]): CaptureOptions {
  const flags = new Map<string, string>()
  for (const argument of argv) {
    const [key, value = 'true'] = argument.replace(/^--/, '').split('=')
    flags.set(key, value)
  }
  return {
    mode: (flags.get('mode') as TerrainRenderMode) ?? 'full',
    exposure: Number(flags.get('exposure') ?? 0.95),
    haze: flags.has('haze') ? Number(flags.get('haze')) : undefined,
    sunElevation: flags.has('sun') ? Number(flags.get('sun')) : undefined,
    sunAzimuth: flags.has('azimuth') ? Number(flags.get('azimuth')) : undefined,
    cascadedShadows: flags.get('csm') !== '0',
    shadows: flags.get('shadows') !== '0',
    debug: (flags.get('debug') as FullMaterialDebug) ?? 'none',
    frames: Number(flags.get('frames') ?? 0),
    switchModes: flags.get('switch') === 'true' || flags.has('switch'),
    dumpShader: flags.has('dump-shader'),
    effects: flags.get('effects') !== '0',
    suffix: flags.get('suffix') ? `-${flags.get('suffix')}` : '',
    width: alignCaptureWidth(Number(flags.get('width') ?? 1280)),
    height: Number(flags.get('height') ?? 720),
    outputDirectory: resolve(flags.get('out') ?? 'captures'),
    only: flags.get('only')?.split(','),
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
