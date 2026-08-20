import {
  AmbientLight,
  Camera,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  Matrix4,
  Scene,
  Vector3,
} from 'three/webgpu'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js'
import { cameraPosition, fog, normalize, positionWorld, uniform } from 'three/tsl'
import { aerialPerspective, syncSunDirection } from '../full/atmosphere'
import type { TerrainConfig } from '../../config'
import type { TerrainRenderMode } from '../renderModes'
import { DEFAULT_SUN } from './sunPosition'
import { getTerrainShadowRevision } from './terrainShadowInvalidation'

export interface TerrainEnvironment {
  group: Group
  sun: DirectionalLight
  sky?: SkyMesh
  /** Keeps the sky box and the shadow frustum anchored to the viewer. */
  update(camera: Camera): void
  /** Applies scene-wide state (fog, background) that does not live on a node. */
  applyToScene(scene: Scene): void
  dispose(): void
}

const SKY_SCALE = 45_000
/** Divides the Preetham dome down into the scene's linear lighting range. */
const SKY_INTENSITY = 0.078

export interface TerrainEnvironmentOptions {
  /** Cascaded shadows. Disable to fall back to one wide shadow frustum. */
  cascadedShadows?: boolean
  /** Turns the sun's shadow casting off entirely, for A/B comparison. */
  shadows?: boolean
}

export function createTerrainEnvironment(
  mode: TerrainRenderMode,
  config: TerrainConfig,
  options: TerrainEnvironmentOptions = {},
): TerrainEnvironment {
  return mode === 'full'
    ? createFullEnvironment(config, options)
    : createPreviewEnvironment()
}

/**
 * Physically-motivated daylight: a Preetham sky supplies both the background
 * and the ambient tint, a single warm sun casts the shadows, and a dim sky-blue
 * bounce fills the shadowed sides the way a real overcast-free day does.
 */
function createFullEnvironment(
  config: TerrainConfig,
  options: TerrainEnvironmentOptions,
): TerrainEnvironment {
  syncSunDirection()
  const group = new Group()

  const sky = new SkyMesh()
  sky.scale.setScalar(SKY_SCALE)
  sky.turbidity.value = 3.4
  sky.rayleigh.value = 1.35
  sky.mieCoefficient.value = 0.004
  sky.mieDirectionalG.value = 0.82
  sky.sunPosition.value.copy(DEFAULT_SUN.direction)
  // Cumulus. An empty gradient sky is one of the strongest tells that a frame
  // is synthetic, and clouds also give the eye a scale reference at the horizon.
  sky.cloudCoverage.value = 0.46
  sky.cloudDensity.value = 0.62
  sky.cloudScale.value = 0.00085
  sky.cloudElevation.value = 0.42
  sky.cloudSpeed.value = 0.00004
  sky.renderOrder = -1000
  // Preetham radiance is authored in its own arbitrary scale; this brings it
  // into the same linear range as the sun-lit ground so neither clips.
  const skyIntensity = uniform(SKY_INTENSITY)
  sky.material.colorNode = (sky.material.colorNode as any).mul(skyIntensity)
  group.add(sky)

  // A 7-degree sun has lost most of its blue to the long atmospheric path, and
  // what is left is strong: the reference frame's lit rock is a warm gold at
  // several times the brightness of its own sky-lit shade.
  const sun = new DirectionalLight(0xffb578, 2.6)
  sun.position.copy(DEFAULT_SUN.direction).multiplyScalar(2_400)
  sun.castShadow = options.shadows ?? true
  sun.shadow.mapSize.set(1536, 1536)
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.35
  // The terrain, sun and camera are persistent. Redrawing four 2048² maps
  // when none of them changed only repeats the exact same depth pass. Start
  // dirty, then let update() invalidate the maps from their real dependencies.
  sun.shadow.autoUpdate = false
  sun.shadow.needsUpdate = true
  group.add(sun, sun.target)

  // Sky bounce. Ground colour is the average of the dry-grass and rock albedo
  // so shadowed slopes pick up the same family of hues as the lit ones, and
  // the sky colour is what keeps shadows blue instead of merely dark.
  // At sunset the sky is the *only* light on everything the sun cannot see,
  // which is most of the frame. Underfilling it is what turns a backlit valley
  // into a black cut-out: the reference keeps readable blue-grey texture in
  // every shadow, and this is where that comes from.
  const skyFill = new HemisphereLight(0x7ea6dc, 0x5a4a35, 2.0)
  group.add(skyFill)
  const ambient = new AmbientLight(0x50628a, 0.4)
  group.add(ambient)

  // Cascades. One shadow map stretched over kilometres gives metre-wide texels
  // and loses every contact shadow; four cascades keep the near field sharp
  // while still reaching the far ridges.
  // The node binds itself to the active camera on first setup and refits its
  // frustums every frame, so it must not be driven manually from here.
  let cascades: CSMShadowNode | undefined
  if (sun.castShadow && (options.cascadedShadows ?? true)) {
    cascades = new CSMShadowNode(sun, {
      cascades: 3,
      maxFar: 2_200,
      mode: 'practical',
      lightMargin: 800,
    })
    sun.shadow.shadowNode = cascades
  } else {
    const shadowCamera = sun.shadow.camera
    shadowCamera.near = 1
    shadowCamera.far = 5_000
    shadowCamera.left = -1_200
    shadowCamera.right = 1_200
    shadowCamera.top = 1_200
    shadowCamera.bottom = -1_200
  }

  const anchor = new Vector3()
  const previousCameraWorld = new Matrix4()
  const previousCameraProjection = new Matrix4()
  let hasCameraSnapshot = false
  let shadowRevision = -1
  let configuredCascadeCount = 0
  const shadowDebug = {
    frames: 0,
    cameraChanges: 0,
    terrainChanges: 0,
    cascadeChanges: 0,
  }
  ;(globalThis as Record<string, unknown>).__terrainShadowDebug = () => ({
    ...shadowDebug,
    revision: shadowRevision,
    shadows: cascades?.lights.map((light) => ({
      autoUpdate: light.shadow?.autoUpdate,
      needsUpdate: light.shadow?.needsUpdate,
    })),
  })

  const invalidateShadowMaps = (): void => {
    const lights = cascades?.lights ?? []
    if (lights.length === 0) {
      // CSM creates its private lights lazily during async material setup. The
      // source shadow is cloned, so this also dirties their first render.
      sun.shadow.needsUpdate = true
      return
    }
    for (const light of lights) {
      const shadow = light.shadow
      if (!shadow) continue
      shadow.autoUpdate = false
      shadow.needsUpdate = true
    }
  }

  return {
    group,
    sun,
    sky,
    update(camera) {
      shadowDebug.frames += 1
      const projectionChanged =
        !hasCameraSnapshot ||
        !previousCameraProjection.equals(camera.projectionMatrix)
      const cameraChanged =
        projectionChanged ||
        !hasCameraSnapshot ||
        !previousCameraWorld.equals(camera.matrixWorld)
      const nextShadowRevision = getTerrainShadowRevision()
      const terrainChanged = nextShadowRevision !== shadowRevision
      const cascadeCount = cascades?.lights.length ?? 0
      const cascadesCreated = cascadeCount !== configuredCascadeCount

      if (cameraChanged) shadowDebug.cameraChanges += 1
      if (terrainChanged) shadowDebug.terrainChanges += 1
      if (cascadesCreated) shadowDebug.cascadeChanges += 1

      if (projectionChanged && cascades?.camera) cascades.updateFrustums()
      if (cameraChanged || terrainChanged || cascadesCreated) {
        invalidateShadowMaps()
      }

      previousCameraWorld.copy(camera.matrixWorld)
      previousCameraProjection.copy(camera.projectionMatrix)
      hasCameraSnapshot = true
      shadowRevision = nextShadowRevision
      configuredCascadeCount = cascadeCount

      camera.getWorldPosition(anchor)
      sky.position.set(anchor.x, 0, anchor.z)
      sun.target.position.set(anchor.x, 0, anchor.z)
      sun.position
        .copy(DEFAULT_SUN.direction)
        .multiplyScalar(2_400)
        .add(sun.target.position)
      sun.target.updateMatrixWorld()
      sun.updateMatrixWorld()
    },
    applyToScene(scene) {
      scene.fog = null
      scene.background = null
      // Aerial perspective runs as a fog node so it is applied after lighting,
      // to every material in the scene, with the same maths the sky uses.
      const view = cameraPosition.sub(positionWorld)
      const haze = aerialPerspective(
        view.length(),
        normalize(view),
        positionWorld.y,
        cameraPosition.y,
      )
      scene.fogNode = fog(haze.colour, haze.amount)
    },
    dispose() {
      sky.geometry.dispose()
      sky.material.dispose()
      cascades?.dispose()
      sun.dispose()
      skyFill.dispose()
      ambient.dispose()
      void config
    },
  }
}

/** The original editing lighting, preserved verbatim so preview never shifts. */
function createPreviewEnvironment(): TerrainEnvironment {
  const group = new Group()
  const hemisphere = new HemisphereLight(0xcfe8dd, 0x121916, 1.35)
  const sun = new DirectionalLight(0xfff4d6, 2.8)
  sun.position.set(180, 320, 120)
  const fill = new DirectionalLight(0x73b8d8, 0.45)
  fill.position.set(-160, 80, -240)
  group.add(hemisphere, sun, fill)

  return {
    group,
    sun,
    update() {},
    applyToScene(scene) {
      scene.background = new Color(0x07100f)
      scene.fog = new FogExp2(0x07100f, 0.0003)
    },
    dispose() {
      hemisphere.dispose()
      sun.dispose()
      fill.dispose()
    },
  }
}
