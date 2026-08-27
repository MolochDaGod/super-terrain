import {
  AmbientLight,
  BackSide,
  Camera,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Scene,
  SphereGeometry,
  type Texture,
  Vector3,
} from 'three/webgpu'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js'
import { cameraPosition, fog, normalize, positionWorld, uniform } from 'three/tsl'
import { aerialPerspective, syncSunDirection } from '../full/atmosphere'
import type { TerrainConfig } from '../../config'
import type { TerrainRenderMode } from '../renderModes'
import { DEFAULT_SUN, setSunAngles } from './sunPosition'
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

/**
 * Which world the lighting is for.
 *
 * `terrain` is a kilometre-scale landscape under an open sky: a low sun, a
 * bright blue hemisphere and cascades reaching the far ridges. `forest` is the
 * inside of a stand, which is a different lighting problem in every respect —
 * the sky is a few bright slivers rather than the dominant source, almost all
 * the fill has been filtered green through leaves or bounced off brown litter,
 * and the shadow budget belongs in the first fifty metres where the dapples
 * are, not spread over two kilometres of ridge.
 */
export type TerrainEnvironmentLook = 'terrain' | 'forest'

export interface TerrainEnvironmentOptions {
  /** Cascaded shadows. Disable to fall back to one wide shadow frustum. */
  cascadedShadows?: boolean
  /** Turns the sun's shadow casting off entirely, for A/B comparison. */
  shadows?: boolean
  /** Lightweight authored backdrop; physical sun and fog still come from the sky model. */
  skyTexture?: Texture
  look?: TerrainEnvironmentLook
}

/**
 * The light rig, as numbers rather than as code.
 *
 * Both looks run the same four sources — sun, hemisphere, ambient and a
 * camera-side fill — so the difference between an open valley and a forest
 * floor is entirely in this table. Keeping it as data is what makes the two
 * comparable: every value below has a counterpart to be read against.
 */
interface LightRig {
  sun: { elevation: number; azimuth: number; colour: number; intensity: number }
  /** Shadow map edge in texels, and how far the cascades reach in metres. */
  shadow: { mapSize: number; maxFar: number; lightMargin: number; cascades: number }
  hemisphere: { sky: number; ground: number; intensity: number }
  ambient: { colour: number; intensity: number }
  frontFill: { colour: number; intensity: number }
  sky: {
    turbidity: number
    rayleigh: number
    intensity: number
    cloudCoverage: number
    /** The authored cloud panorama. A forest interior has no use for one. */
    backdrop: boolean
  }
}

const LIGHT_RIGS: Record<TerrainEnvironmentLook, LightRig> = {
  // Late afternoon over open ground: warm raking sun, blue sky bounce.
  terrain: {
    sun: { elevation: 14, azimuth: 142, colour: 0xffd0a6, intensity: 4.35 },
    shadow: { mapSize: 1536, maxFar: 2_200, lightMargin: 800, cascades: 3 },
    hemisphere: { sky: 0x748ba8, ground: 0x292a2d, intensity: 0.92 },
    ambient: { colour: 0x303947, intensity: 0.052 },
    frontFill: { colour: 0x879bb8, intensity: 0.94 },
    sky: {
      turbidity: 4.1,
      rayleigh: 1.12,
      intensity: 0.18,
      cloudCoverage: 0.38,
      backdrop: true,
    },
  },
  // Mid-morning inside a closed stand. The sun is high enough to reach the
  // floor in patches rather than raking under the canopy, and everything it
  // misses is lit by leaf-filtered green and litter bounce — which is why the
  // shadows in a forest photograph are warm brown and not blue. The hemisphere
  // is a third of the terrain's: an interior that keeps an open-sky fill has
  // no shadow left to make dapples out of, which is the whole read.
  forest: {
    // Lower than noon on purpose. A high sun drops light straight onto the
    // canopy and almost none of it reaches eye level; the raking morning angle
    // is what sends light *between* the trunks and gives a stand its lit
    // mid-ground and its long floor shadows.
    sun: { elevation: 24, azimuth: 152, colour: 0xffeccb, intensity: 5.2 },
    shadow: { mapSize: 2048, maxFar: 260, lightMargin: 120, cascades: 3 },
    hemisphere: { sky: 0x77878a, ground: 0x362e24, intensity: 0.7 },
    ambient: { colour: 0x2b332f, intensity: 0.1 },
    frontFill: { colour: 0x86948f, intensity: 0.32 },
    sky: {
      turbidity: 5.4,
      rayleigh: 1.05,
      // Dimmer than the open-sky rig. Seen from a forest floor the sky is a
      // handful of small gaps, and at landscape brightness each of them blows
      // out and pulls the eye off the subject — the frame then reads as a
      // stand photographed against a light box.
      intensity: 0.1,
      cloudCoverage: 0.3,
      backdrop: false,
    },
  },
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
  const rig = LIGHT_RIGS[options.look ?? 'terrain']
  // The sun is shared state: the sky model, the atmosphere uniforms and the
  // haze all read it. Setting it from the rig here rather than relying on the
  // module default is what lets two workspaces have different times of day
  // without the order they were opened in deciding the result.
  setSunAngles(rig.sun.elevation, rig.sun.azimuth)
  syncSunDirection()
  const group = new Group()

  const sky = new SkyMesh()
  sky.scale.setScalar(SKY_SCALE)
  sky.turbidity.value = rig.sky.turbidity
  sky.rayleigh.value = rig.sky.rayleigh
  sky.mieCoefficient.value = 0.006
  sky.mieDirectionalG.value = 0.84
  sky.sunPosition.value.copy(DEFAULT_SUN.direction)
  // Cumulus. An empty gradient sky is one of the strongest tells that a frame
  // is synthetic, and clouds also give the eye a scale reference at the horizon.
  sky.cloudCoverage.value = rig.sky.cloudCoverage
  sky.cloudDensity.value = 0.46
  sky.cloudScale.value = 0.00072
  sky.cloudElevation.value = 0.38
  sky.cloudSpeed.value = 0.00004
  sky.renderOrder = -1000
  // Preetham radiance is authored in its own arbitrary scale; this brings it
  // into the same linear range as the sun-lit ground so neither clips.
  const skyIntensity = uniform(rig.sky.intensity)
  sky.material.colorNode = (sky.material.colorNode as any).mul(skyIntensity)
  group.add(sky)

  const skyBackdrop = options.skyTexture && rig.sky.backdrop
    ? createCinematicSkyBackdrop(options.skyTexture)
    : undefined
  if (skyBackdrop) group.add(skyBackdrop)

  // A low sun has lost most of its blue to the long atmospheric path, and what
  // is left is strong: the terrain reference's lit rock is a warm gold at
  // several times the brightness of its own sky-lit shade. The forest rig
  // carries a higher, whiter sun for the same reason in reverse — what reaches
  // a stand's floor has come almost straight down through the gaps.
  const sun = new DirectionalLight(rig.sun.colour, rig.sun.intensity)
  sun.position.copy(DEFAULT_SUN.direction).multiplyScalar(2_400)
  sun.castShadow = options.shadows ?? true
  sun.shadow.mapSize.set(rig.shadow.mapSize, rig.shadow.mapSize)
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
  const skyFill = new HemisphereLight(
    rig.hemisphere.sky, rig.hemisphere.ground, rig.hemisphere.intensity,
  )
  group.add(skyFill)
  const ambient = new AmbientLight(rig.ambient.colour, rig.ambient.intensity)
  group.add(ambient)

  // A real valley receives a directional lobe from the open sky behind the
  // camera, not a uniform ambient wash. This cool, shadowless bounce lets the
  // backlit landmark retain its fracture and grain while the occluded ravines
  // stay dark. Uniformly raising the hemisphere flattened both into grey.
  const frontFill = new DirectionalLight(rig.frontFill.colour, rig.frontFill.intensity)
  frontFill.castShadow = false
  group.add(frontFill, frontFill.target)

  // Cascades. One shadow map stretched over kilometres gives metre-wide texels
  // and loses every contact shadow; four cascades keep the near field sharp
  // while still reaching the far ridges.
  // The node binds itself to the active camera on first setup and refits its
  // frustums every frame, so it must not be driven manually from here.
  let cascades: CSMShadowNode | undefined
  if (sun.castShadow && (options.cascadedShadows ?? true)) {
    cascades = new CSMShadowNode(sun, {
      cascades: rig.shadow.cascades,
      maxFar: rig.shadow.maxFar,
      mode: 'practical',
      lightMargin: rig.shadow.lightMargin,
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
  const frontDirection = new Vector3()
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
      skyBackdrop?.position.set(anchor.x, 0, anchor.z)
      sun.target.position.set(anchor.x, 0, anchor.z)
      sun.position
        .copy(DEFAULT_SUN.direction)
        .multiplyScalar(2_400)
        .add(sun.target.position)
      sun.target.updateMatrixWorld()
      sun.updateMatrixWorld()
      // Put the fill on the camera side of the scene. The old fixed world-space
      // position ended up behind the north-facing showcase camera and turned
      // the landmark's detailed face into a black silhouette.
      camera.getWorldDirection(frontDirection)
      frontFill.target.position
        .copy(anchor)
        .addScaledVector(frontDirection, 520)
      frontFill.target.position.y -= 70
      frontFill.position
        .copy(anchor)
        .addScaledVector(frontDirection, -920)
      frontFill.position.y += 560
      frontFill.target.updateMatrixWorld()
      frontFill.updateMatrixWorld()
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
      if (skyBackdrop) {
        skyBackdrop.geometry.dispose()
        skyBackdrop.material.dispose()
      }
      cascades?.dispose()
      sun.dispose()
      skyFill.dispose()
      ambient.dispose()
      frontFill.dispose()
      void config
    },
  }
}

function createCinematicSkyBackdrop(
  textureMap: Texture,
): Mesh<SphereGeometry, MeshBasicNodeMaterial> {
  const geometry = new SphereGeometry(SKY_SCALE * 0.985, 72, 36)
  const material = new MeshBasicNodeMaterial({
    name: 'cinematic cloud panorama',
    map: textureMap,
    color: 0xe0e4e9,
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
  const backdrop = new Mesh(geometry, material)
  backdrop.name = 'photographic alpine cloud dome'
  backdrop.renderOrder = -999
  backdrop.frustumCulled = false
  // Put the panorama's warm break on the same side as the analytic sun.
  backdrop.rotation.y = Math.PI - 0.72
  return backdrop
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
