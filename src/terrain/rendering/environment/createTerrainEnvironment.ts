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
export type TerrainEnvironmentLook = 'terrain' | 'forest' | 'wooded-landscape'

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
  shadow: {
    mapSize: number
    maxFar: number
    lightMargin: number
    cascades: number
    /**
     * How many frames apart successive cascades redraw.
     *
     * Cascade `i` redraws every `1 + i * cascadeStagger` frames while the
     * camera is moving; 0 keeps every cascade on every frame. Only the near
     * cascade carries shadows the eye can resolve edges in, and the far one
     * covers a box hundreds of metres across whose texels are the better part
     * of a metre — two frames of lag there moves its contents by a fraction of
     * a texel at any speed a person walks or flies at.
     *
     * This is what buys the budget for every LOD to cast (see
     * `foliageCastsShadow`). Three full cascade passes a frame become about
     * 1.8, and the saving lands on exactly the passes whose staleness cannot
     * be seen.
     */
    cascadeStagger: number
    /**
     * How completely a shadowed surface loses the sun, 0..1.
     *
     * 1 is a lid. That is right for rock and for a building, and wrong for a
     * canopy: a leaf transmits a few per cent of what lands on it, a canopy is
     * full of gaps smaller than the shadow map's texel, and the light that
     * comes through both is what a forest interior is actually lit by.
     *
     * It also replaces something that used to happen by accident. While the
     * far LOD of a crown cast nothing, a stand leaked a great deal of sun in
     * from every tree more than sixty metres off, and the fill in this rig was
     * tuned on top of that leak. Making every LOD cast (see
     * `foliageCastsShadow`) closed the lid properly and the interior went
     * nearly black — correct for an opaque canopy, and not what a wood looks
     * like. This is the same light back, minus the popping: it arrives evenly,
     * from a physical cause, instead of appearing whenever a tree crossed a
     * distance threshold.
     */
    intensity: number
  }
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
    shadow: {
      mapSize: 1536,
      maxFar: 2_200,
      lightMargin: 800,
      cascades: 3,
      cascadeStagger: 1,
      intensity: 1,
    },
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
    shadow: {
      mapSize: 2048,
      maxFar: 260,
      lightMargin: 120,
      cascades: 3,
      cascadeStagger: 1,
      // A closed beech canopy passes something like a twentieth of the light
      // that lands on it, and its gaps pass a good deal more than that at
      // scales the shadow map cannot resolve — a shadow map texel is
      // centimetres across at the near cascade and metres at the far one, so
      // every gap smaller than that is averaged away into solid occlusion.
      // The correction has to cover all of it.
      //
      // 0.66 was measured against a stand at pole-stage spacing. With the
      // stems thinned to what a mature high forest actually carries there is
      // more direct light to begin with, and the remaining shadow can afford
      // to be softer still: a fifth of the sun surviving in shade is about
      // what a photograph of a beech interior shows between the dapples.
      intensity: 0.8,
    },
    // Fill sized to what a closed canopy actually does to light rather than to
    // what it blocks.
    //
    // The first pass of this rig reasoned only about occlusion — the canopy
    // shuts the sky out, so the fill came down — and produced an interior whose
    // mean luminance was 0.098 with half of every frame crushed flat to black.
    // That is not what the inside of a wet forest looks like: the canopy is a
    // diffuser, not a lid, and the light it does pass has been scattered by
    // leaves and bounced off litter so many times that shade there carries far
    // more fill than shade in the open does. Photographically the interior is
    // low-key and *low-contrast*, not low-key and clipped.
    //
    // So the sky term is green-grey rather than blue, the ground term is the
    // brown of wet leaf litter, and both are strong enough that a surface
    // facing away from every gap still resolves its own texture.
    //
    // Raised a second time when the canopy started casting shadows properly.
    // Until then most of the stand was excluded from the shadow map, so the
    // interior was being lit by sunlight that a real canopy would have stopped;
    // fixing that took the measured mean from 0.166 down to 0.118 in one step.
    // The light has to come back as *fill* rather than as exposure, because
    // fill is what the canopy actually supplies and because exposure would
    // take the sky gaps with it.
    hemisphere: { sky: 0x93a596, ground: 0x54432f, intensity: 1.72 },
    ambient: { colour: 0x3f4c3d, intensity: 0.62 },
    frontFill: { colour: 0x9aa79b, intensity: 0.6 },
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
  'wooded-landscape': {
    // The authored hero angle, kept.
    //
    // The forest rig's 24-degree mid-morning sun is right for getting light
    // between trunks and wrong for this world: the whole demo composition —
    // the thrust slab's bedding shadows, the backlit ranges, the rim on every
    // ridge — is built around a low three-quarter backlight, and raising the
    // sun ten degrees flattens all of it at once. What is taken from the forest
    // rig is its *fill*: a warm, strong, leaf-and-litter bounce that keeps
    // shade readable instead of the blue near-black an open-sky rig gives.
    // Softer than the landscape rig's 4.35, and deliberately.
    //
    // What reads as harsh is the ratio between the sunlit face and the shaded
    // one, not the absolute brightness of either. Taking the key down and the
    // fill up narrows that ratio from about nine to one to about five, which
    // is the difference between a face that bleaches out at grazing incidence
    // and one that keeps its bedding.
    sun: { elevation: 14, azimuth: 142, colour: 0xffd9b0, intensity: 3.85 },
    shadow: {
      mapSize: 2048,
      maxFar: 2_200,
      lightMargin: 800,
      cascades: 3,
      cascadeStagger: 1,
      // 0.85 rather than a lid.
      //
      // Not for the forest rig's reason — there is no canopy here whose gaps
      // fall below a texel — but for the plain one: on a clear day the sky is
      // a hemisphere of light and a shadowed slope is lit by all of it. A
      // shadow that takes the sun away completely is what makes a landscape
      // read as harsh, and it is the single biggest difference between this
      // rig and the forest one the tree workspace is graded against.
      intensity: 0.85,
    },
    // The forest rig's fill, near enough, on a landscape's geometry. It is
    // where nearly all of the softness comes from: shade that still resolves
    // its own texture instead of falling into the toe of the curve.
    hemisphere: { sky: 0x8fa2a2, ground: 0x47402f, intensity: 1.45 },
    ambient: { colour: 0x3f4c3d, intensity: 0.5 },
    frontFill: { colour: 0x9aa79b, intensity: 0.62 },
    sky: {
      turbidity: 4.4,
      rayleigh: 1.1,
      // Bright enough to carry the horizon on its own now the authored
      // photograph is gone, and no brighter. At 0.46 the sky was most of what
      // the frame clipped: nine per cent of the image and a fifth of the sky
      // band pinned at white, which the tree workspace — measured at zero per
      // cent clipped — never does.
      intensity: 0.22,
      cloudCoverage: 0.42,
      // The authored panorama is what this look exists to remove. The sky model
      // draws its own clouds and horizon gradient in the same physical units as
      // the sun lighting the ground, so the horizon no longer carries a
      // photograph's own exposure baked into it.
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
  sun.shadow.intensity = rig.shadow.intensity
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
  // The node refits its frustums every frame from whichever camera it is
  // pointed at, so the only thing driven manually from here is which camera
  // that is and how deep each cascade's shadow camera reaches. See
  // `fitCascadeDepth` and the rebind in `update`.
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

  /**
   * Gives every cascade's shadow camera a depth range that reaches its casters.
   *
   * CSM builds its cascade lights by cloning the source light's shadow, and a
   * `DirectionalLightShadow` reaches 500 units out of the box. It then parks
   * each cascade light `lightMargin` beyond the top of that cascade's box along
   * the light direction, so the shortest distance from the light to anything it
   * could shadow is the margin itself. On this rig the margin alone is 800
   * metres and the far box is kilometres across: every caster in the world sat
   * behind the far plane, all three maps came back empty, and the landscape
   * rendered fully lit with `castShadow` set on all 138 sections. The forest
   * workspace never hit it — 120 metres of margin over boxes a few hundred
   * metres wide fits inside 500 with room to spare, which is exactly why the
   * tree editor's cascades looked right and the same code here cast nothing.
   *
   * Sized per cascade rather than once for the widest, because the near
   * cascade's bias is a fraction of its own depth range: giving it the far
   * cascade's kilometres would trade the missing shadows for peter-panning.
   * A cascade's light-space depth cannot exceed its frustum's own diagonal,
   * which is the box width `_updateShadowBounds` already derived from it.
   */
  const fitCascadeDepth = (): void => {
    for (const light of cascades?.lights ?? []) {
      const shadowCamera = light.shadow?.camera
      if (!shadowCamera) continue
      const boxWidth = shadowCamera.right - shadowCamera.left
      shadowCamera.near = 1
      shadowCamera.far = rig.shadow.lightMargin + boxWidth
      shadowCamera.updateProjectionMatrix()
    }
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

  let shadowFrame = 0

  /**
   * Dirties the cascades that are due this frame.
   *
   * `everyCascade` is for changes that are not the camera moving — a caster
   * appeared, the terrain remeshed, the cascade lights were just created. Those
   * invalidate the *contents* of every map, and a schedule that skipped one
   * would leave a tree standing in the far field casting nothing for two
   * frames after it appeared. Camera motion is the opposite case: the contents
   * are unchanged and only the box has slid, which is precisely the update the
   * far cascades can afford to take late.
   */
  const invalidateShadowMaps = (everyCascade: boolean): void => {
    const lights = cascades?.lights ?? []
    if (lights.length === 0) {
      // CSM creates its private lights lazily during async material setup. The
      // source shadow is cloned, so this also dirties their first render.
      sun.shadow.needsUpdate = true
      return
    }
    const stagger = Math.max(0, rig.shadow.cascadeStagger)
    for (let index = 0; index < lights.length; index += 1) {
      const shadow = lights[index]!.shadow
      if (!shadow) continue
      shadow.autoUpdate = false
      const period = everyCascade ? 1 : 1 + index * stagger
      if (shadowFrame % period === 0) shadow.needsUpdate = true
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

      shadowFrame += 1
      // Whose frustum the cascades are fitted to.
      //
      // CSM binds itself, once, to whichever camera first compiles a lit
      // material — and in this workspace that is not the viewer's. The water's
      // planar reflector renders the scene from a camera mirrored through the
      // water plane before the main pass ever runs, so the node latched onto
      // that one and spent every frame afterwards fitting its boxes to a
      // frustum pointing into the reflected world. The tree workspace has no
      // water, which is the other half of why its cascades were fine.
      //
      // Only after the node has built its lights: `setup()` initialises them
      // exactly once, and only while `camera` is still null, so pinning this
      // any earlier would leave it with no cascades at all.
      const cascadesRebound =
        cascades !== undefined &&
        cascades.lights.length > 0 &&
        cascades.camera !== camera
      if (cascadesRebound) cascades!.camera = camera

      if (projectionChanged || cascadesRebound) cascades?.updateFrustums()
      // `updateFrustums` resizes every cascade box, and the depth range has to
      // follow it.
      if (projectionChanged || cascadesRebound || cascadesCreated) fitCascadeDepth()
      if (cameraChanged || terrainChanged || cascadesCreated || cascadesRebound) {
        invalidateShadowMaps(
          terrainChanged || cascadesCreated || cascadesRebound || projectionChanged,
        )
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
