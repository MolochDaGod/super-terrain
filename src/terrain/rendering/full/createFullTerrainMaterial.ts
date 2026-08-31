import {
  DoubleSide,
  MeshStandardNodeMaterial,
  type Texture,
} from 'three/webgpu'
import {
  cameraPosition,
  cameraViewMatrix,
  clamp,
  dot,
  faceDirection,
  float,
  mix,
  normalize,
  normalWorld,
  positionWorld,
  sign,
  smoothstep,
  texture,
  triplanarTexture,
  vec2,
  vec3,
} from 'three/tsl'
import {
  DEFAULT_TERRAIN_MATERIAL_SETTINGS,
  type TerrainMaterialSettings,
} from '../materialSettings'
import { applyTerrainPaint } from '../terrainPaintMaterial'
import {
  createGeologyDetailTexture,
  createGroundCoverDetailTexture,
} from '../textures/createSurfaceDetailTextures'
import { getProceduralSurfaceTextures } from '../textures/proceduralSurfaceTextures'
import { THRUST_FACE_NORMAL } from '../../demo/createThrustFormation'
import { layerWeights, reliefNormal, terrainSlowFields } from './surface'
import { forestFloorBlend } from '../../../foliage/forestFloorBlend'

/**
 * The steep and flat surfaces are procedural bakes rather than scans.
 *
 * `getProceduralSurfaceTextures` returns the same four textures for every
 * caller and bakes each surface exactly once per page, off the main thread.
 * The textures it hands back are valid immediately — a one-pixel average
 * colour — and the real pixels are written into those same objects when the
 * bake lands, so this material never has to be rebuilt and no pipeline is
 * recompiled. Binding them on more meshes, or walking the camera up to a
 * face, costs nothing beyond the sampling that any texture would need.
 */

/** Unlit inspection views used by the browser review harness. */
export type FullMaterialDebug =
  | 'none'
  | 'albedo'
  | 'normal'
  | 'relief'
  | 'layers'
  | 'strata'
  | 'crack'
  | 'blocks'
  | 'buttress'
  | 'scan'

export interface FullTerrainMaterialOptions {
  /** Scales the texture-driven relief; 0 leaves the geometric normal intact. */
  detailScale?: number
  debug?: FullMaterialDebug
  materialSettings?: TerrainMaterialSettings
}

/**
 * Production terrain material.
 *
 * Material classification, bedding attitude, macro variation, curvature and
 * cavity are compiled into the section vertices. The fragment stage spends its
 * budget where it remains visible: one correlated PBR scan feeds albedo,
 * tangent-space normal, roughness, AO and derivative height through a shared
 * triplanar frame. This replaces the former 42 Perlin call sites plus two
 * parallax marches while preserving physical agreement between every lobe.
 */
export function createFullTerrainMaterial(
  options: FullTerrainMaterialOptions = {},
) {
  const detailScale = options.detailScale ?? 1
  const debug = options.debug ?? 'none'
  const materialSettings =
    options.materialSettings ?? DEFAULT_TERRAIN_MATERIAL_SETTINGS
  const detailTexture = createGeologyDetailTexture()
  const groundCoverTexture = createGroundCoverDetailTexture()
  const cliffSurface = getProceduralSurfaceTextures('cliff-side')
  const groundSurface = getProceduralSurfaceTextures('rock-ground')
  const previewReady = Promise.all([
    cliffSurface.previewReady,
    groundSurface.previewReady,
  ]).then(() => undefined)
  const ready = Promise.all([
    cliffSurface.ready,
    groundSurface.ready,
  ]).then(() => undefined)
  void previewReady.catch(() => undefined)
  void ready.catch(() => undefined)
  const rockScanDiffuse = cliffSurface.albedo
  const rockScanNormal = cliffSurface.normal
  const rockScanArm = cliffSurface.arm
  const groundScanDiffuse = groundSurface.albedo
  const groundScanNormal = groundSurface.normal
  const groundScanArm = groundSurface.arm
  const material = new MeshStandardNodeMaterial({
    metalness: 0,
    side: DoubleSide,
  })

  // Tunnel backfaces use the opposite geometric normal. Keeping that rule at
  // the top makes the triplanar weights and the final lighting agree.
  const geometricNormal = normalize(normalWorld)
    .mul(faceDirection)
    .toVar('terrainGeometricNormal')
  const position = positionWorld
  const slow = terrainSlowFields(position)
  const weights = layerWeights(geometricNormal, slow)
  // What actually takes the rock scan's micro-normal, grading and roughness.
  //
  // This used to read `soil * 0.95 + meadow * 0.88 + grass * 0.8`, on the
  // grounds that the showcase's flat channels were wet shale and compact
  // moraine rather than vegetation. The consequence was that *every* channel
  // was between 80 and 100 per cent mineral, so the cliff scan's joints and
  // clast structure were stamped across pasture, and the six-layer
  // classification the compiler works so hard to produce could not express
  // itself in the frame: grass, meadow, soil, scree and rock were five tints of
  // one stone. Bare soil genuinely is mineral, so it keeps a little over half;
  // turf and dry meadow get none, and take their structure from the sward bake
  // below instead.
  const rocky = weights.rock
    .add(weights.scree)
    .add(weights.soil.mul(0.55))
    .clamp(0, 1)
    .toVar('terrainRockyCoverage')
  const vegetation = weights.grass
    .add(weights.meadow)
    .clamp(0, 1)
    .toVar('terrainVegetationCoverage')

  // The 28 m sample breaks up whole faces; the 4.5 m sample carries chips,
  // aggregate and normal response into the middle distance. Mipmaps and
  // anisotropy do the screen-footprint filtering in hardware.
  const detailNode = texture(detailTexture)
  const broad = triplanarTexture(
    detailNode,
    null,
    null,
    float(0.036),
    position,
    geometricNormal,
  ).toVar('terrainBroadDetail')
  const fine = triplanarTexture(
    detailNode,
    null,
    null,
    float(0.22),
    position.add(vec3(19.3, -7.1, 31.7)),
    geometricNormal,
  ).toVar('terrainFineDetail')
  // Rotate the scan volume into the thrust attitude. Every terrain section and
  // exact-CSG face samples this same world-space volume, so a patch cannot
  // reveal itself through a different UV density or material orientation.
  const scanPosition = vec3(
    position.x.mul(0.84).add(position.y.mul(0.54)),
    position.y.mul(0.84).sub(position.x.mul(0.54)),
    position.z,
  )
  const scanGeometricNormal = normalize(vec3(
    geometricNormal.x.mul(0.84).add(geometricNormal.y.mul(0.54)),
    geometricNormal.y.mul(0.84).sub(geometricNormal.x.mul(0.54)),
    geometricNormal.z,
  ))
  let scanWeights = scanGeometricNormal.abs()
  scanWeights = scanWeights.mul(scanWeights)
  scanWeights = scanWeights.mul(scanWeights)
  scanWeights = scanWeights.mul(scanWeights)
  scanWeights = scanWeights.div(scanWeights.dot(vec3(1)))
  const scanAxisSign = sign(scanGeometricNormal)
  // A cliff capture projected onto a horizontal floor turns its bedding into
  // parallel painted lanes. Conversely, a top-down gravel scan smeared across
  // a vertical face has no coherent joints. Keep one correlated PBR tuple for
  // each physical orientation and cross-fade the complete tuples over a broad
  // slope range. The transition is continuous in albedo, normal, ARM, height
  // and grading, so an exact-CSG intersection can never reveal a material seam.
  const cliffScale = float(1 / 64)
  const cliffUvX = scanPosition.yz
    .mul(cliffScale)
    .mul(vec2(scanAxisSign.x, 1))
  const cliffUvY = scanPosition.zx
    .mul(cliffScale)
    .mul(vec2(scanAxisSign.y, 1))
  const cliffUvZ = scanPosition.xy
    .mul(cliffScale)
    .mul(vec2(scanAxisSign.z, 1))
  // The ground scan is a top-down capture. Rotate its planar frame away from
  // the section grid and let mirrored wrapping double the apparent repeat.
  // One tile spans 14.5 m: about 14 mm/texel at 1K, comfortably finer than a
  // screen pixel in the shipped camera while keeping individual clasts at a
  // believable world size.
  const groundScale = float(1 / 14.5)
  const groundUv = vec2(
    position.x.mul(0.829).add(position.z.mul(0.559)),
    position.z.mul(0.829).sub(position.x.mul(0.559)),
  ).mul(groundScale)
  const sampleScan = (
    source: Texture,
    uvX: any,
    uvY: any,
    uvZ: any,
    mipBias: number,
  ) => {
    const scanX = texture(source, uvX).bias(float(mipBias))
    const scanY = texture(source, uvY).bias(float(mipBias))
    const scanZ = texture(source, uvZ).bias(float(mipBias))
    return scanX.mul(scanWeights.x)
      .add(scanY.mul(scanWeights.y))
      .add(scanZ.mul(scanWeights.z))
  }
  // A heightfield normal can describe a high mountain shoulder as only
  // moderately steep even though the exposed surface is still bedrock. Using
  // slope alone therefore assigned the smoother basin scan to the whole rear
  // massif, which is why it looked polished and textureless behind a crisp
  // landmark. Altitude progressively lowers the cliff threshold while the
  // low basin keeps the fractured ground capture.
  const focalRearX = position.x.sub(420).div(270)
  const focalRearZ = position.z.sub(395).div(235)
  const focalRearDistance = focalRearX.mul(focalRearX)
    .add(focalRearZ.mul(focalRearZ))
  const focalRearRock = smoothstep(0.32, 1.05, focalRearDistance)
    .oneMinus()
    .mul(smoothstep(68, 155, position.y))
  const cliffLikelihood = weights.slope
    .add(smoothstep(58, 205, position.y).mul(0.38))
    .add(focalRearRock.mul(0.28))
  const scanDomain = smoothstep(0.3, 0.66, cliffLikelihood)
    .toVar('terrainUnifiedScanDomain')
  const cliffDiffuse = sampleScan(
    rockScanDiffuse,
    cliffUvX,
    cliffUvY,
    cliffUvZ,
    -0.08,
  )
  const cliffArm = sampleScan(
    rockScanArm,
    cliffUvX,
    cliffUvY,
    cliffUvZ,
    -0.04,
  )
  const groundDiffuse = texture(groundScanDiffuse, groundUv)
    .bias(float(-0.08))
  const groundArm = texture(groundScanArm, groundUv)
    .bias(float(-0.04))
  const scanDiffuse = mix(groundDiffuse, cliffDiffuse, scanDomain)
    .toVar('terrainSelectedScanDiffuse')
  const scanArm = mix(groundArm, cliffArm, scanDomain)
    .toVar('terrainSelectedScanArm')
  // The bake writes the surface height into the ARM alpha, so the height comes
  // out of a fetch that had to happen anyway. It used to be two more textures
  // — one per surface — each carrying eight bits of height replicated across
  // all four channels, and each costing a *sampler*. WebGPU guarantees sixteen
  // samplers per fragment stage and this adapter offers exactly sixteen, which
  // this material was already using, so the two redundant maps were the whole
  // of the headroom budget. See `packArm`.
  const scanDisplacement = scanArm.a.toVar('terrainSelectedScanDisplacement')
  const scanNormalX = texture(rockScanNormal, cliffUvX)
    .bias(float(-0.12)).rgb.mul(2).sub(1)
    .toVar('terrainSelectedScanNormalX')
  const scanNormalY = texture(rockScanNormal, cliffUvY)
    .bias(float(-0.12)).rgb.mul(2).sub(1)
    .toVar('terrainSelectedScanNormalY')
  const scanNormalZ = texture(rockScanNormal, cliffUvZ)
    .bias(float(-0.12)).rgb.mul(2).sub(1)
    .toVar('terrainSelectedScanNormalZ')
  // Convert each OpenGL tangent-space normal into the rotated scan volume,
  // then blend there before returning to world space. Merely treating this map
  // as height would reproduce the fake embossed look this material replaces.
  const mappedScanNormalX = normalize(vec3(
    scanNormalX.z.mul(scanAxisSign.x),
    scanNormalX.x.mul(scanAxisSign.x),
    scanNormalX.y,
  ))
  const mappedScanNormalY = normalize(vec3(
    scanNormalY.y,
    scanNormalY.z.mul(scanAxisSign.y),
    scanNormalY.x.mul(scanAxisSign.y),
  ))
  const mappedScanNormalZ = normalize(vec3(
    scanNormalZ.x.mul(scanAxisSign.z),
    scanNormalZ.y,
    scanNormalZ.z.mul(scanAxisSign.z),
  ))
  const mappedScanNormal = normalize(
    mappedScanNormalX.mul(scanWeights.x)
      .add(mappedScanNormalY.mul(scanWeights.y))
      .add(mappedScanNormalZ.mul(scanWeights.z)),
  ).toVar('terrainRockScanNormal')
  const flatScanNormal = normalize(vec3(
    scanAxisSign.x.mul(scanWeights.x),
    scanAxisSign.y.mul(scanWeights.y),
    scanAxisSign.z.mul(scanWeights.z),
  ))
  const scanPerturbation = mappedScanNormal.sub(flatScanNormal)
  const cliffWorldPerturbation = vec3(
    scanPerturbation.x.mul(0.84).sub(scanPerturbation.y.mul(0.54)),
    scanPerturbation.x.mul(0.54).add(scanPerturbation.y.mul(0.84)),
    scanPerturbation.z,
  )
  const groundNormal = texture(groundScanNormal, groundUv)
    .bias(float(-0.12)).rgb.mul(2).sub(1)
    .toVar('terrainSelectedGroundNormal')
  const groundNormalSign = sign(geometricNormal.y)
  const mappedGroundNormal = normalize(vec3(
    groundNormal.x.mul(0.829).sub(groundNormal.y.mul(0.559)),
    groundNormal.z.mul(groundNormalSign),
    groundNormal.x.mul(0.559).add(groundNormal.y.mul(0.829)),
  ))
  const groundPerturbation = mappedGroundNormal.sub(
    vec3(0, groundNormalSign, 0),
  )
  const worldScanPerturbation = mix(
    groundPerturbation,
    cliffWorldPerturbation,
    scanDomain,
  ).toVar('terrainRockScanWorldPerturbation')

  // Strata share the same dipping plane and thickness used to terrace the
  // source mesh. The narrow riser bends the normal and therefore casts a real
  // grazing-light line instead of merely painting a stripe.
  const bandCoordinate = slow.bedded
    .dot(slow.beddingNormal)
    .div(slow.bedThickness)
    .toVar('terrainBandCoordinate')
  const bandPhase = bandCoordinate.fract().toVar('terrainBandPhase')
  const bandBody = smoothstep(0.08, 0.3, bandPhase)
    .mul(smoothstep(0.58, 0.98, bandPhase).oneMinus())
    .toVar('terrainBandBody')
  const bandRiser = smoothstep(0.015, 0.11, bandPhase)
    .mul(smoothstep(0.1, 0.24, bandPhase).oneMinus())
    .toVar('terrainBandRiser')
  const bedCut = smoothstep(
    0.16,
    0.64,
    dot(geometricNormal, slow.beddingNormal).abs().oneMinus(),
  )
  const bedExposure = slow.bedExposure
    // Authored mesh operands have no heightfield slope history at their new
    // faces. Give exposed rock a conservative baseline so the same geological
    // beds remain legible across those exact-CSG surfaces.
    .add(rocky.mul(0.44))
    .clamp(0, 1)
    .mul(bedCut)
    .mul(mix(float(0.56), float(1), slow.jointing))
    .mul(smoothstep(0.22, 0.68, weights.rock))
    .toVar('terrainBedExposure')

  // Measured diffuse families in linear space. Slow fields decide the matter;
  // texture channels only make that matter weathered and non-uniform.
  // This showcase is a stripped glacial basin, not an alpine pasture. The two
  // low-slope coverage channels remain useful deposition masks, but represent
  // wet shale and compact gravel here rather than grass and meadow.
  const scanLuminance = dot(
    scanDiffuse.rgb,
    vec3(0.2126, 0.7152, 0.0722),
  )
  const cliffRockDiffuse = mix(
    scanDiffuse.rgb,
    vec3(scanLuminance),
    float(0.82),
  )
    // Desaturate the warm sedimentary capture toward the reference limestone,
    // preserving the actual block/joint value structure in linear space.
    .mul(vec3(1.38, 1.42, 1.48))
    .add(vec3(0.014, 0.017, 0.022))
    .sub(vec3(0.14))
    .mul(1.18)
    .add(vec3(0.14))
    .clamp(0, 0.52)
  // The scan is nearly neutral, but contains a few tiny dry plants. The
  // showcase is stripped bare, so move only any green excess into a neutral
  // ochre while retaining the captured gravel, AO and displacement structure.
  const greenExcess = scanDiffuse.g
    .sub(scanDiffuse.r.max(scanDiffuse.b))
    .max(0)
  const groundNeutralScan = vec3(
    scanDiffuse.r.add(greenExcess.mul(0.14)),
    scanDiffuse.g.sub(greenExcess.mul(0.82)),
    scanDiffuse.b.add(greenExcess.mul(0.08)),
  )
  const groundLuminance = dot(
    groundNeutralScan,
    vec3(0.2126, 0.7152, 0.0722),
  )
  const groundRockDiffuse = mix(
    groundNeutralScan,
    vec3(groundLuminance),
    float(0.42),
  )
    .mul(vec3(0.9, 0.92, 0.96))
    .add(vec3(0.01, 0.012, 0.016))
    // Keep the photographed clast layout, but compress its broad value range.
    // Otherwise the few largest black stones advertise every repeat even when
    // the normal and height maps themselves tile invisibly under lighting.
    .sub(vec3(0.16))
    .mul(0.9)
    .add(vec3(0.16))
    .clamp(0, 0.52)
  const scanRockDiffuse = mix(
    groundRockDiffuse,
    cliffRockDiffuse,
    scanDomain,
  ).toVar('terrainRockScanGradedDiffuse')
  // --- ground cover ---------------------------------------------------------
  //
  // Sward is not one colour with a brightness ramp over it. At walking distance
  // it resolves into three things at once: the living crown of each tussock,
  // the bleached dead litter packed between the crowns, and the bare earth
  // showing through wherever the mat is thin. Ramping a single hue by a noise
  // field can reproduce none of that — and mixing the rock scan in at 56 per
  // cent, which is what this did, reproduces the opposite of it.
  //
  // A desert floor has exactly the same three components and differs only in
  // what each one is made of: the bare fraction is sand rather than humus, the
  // litter is bleached almost white, and the living fraction is the grey-green
  // of woody scrub instead of turf. So the climate is folded into the three
  // colours and the structure above them is shared. The reason a desert reads
  // as sparse is that the *coverage* is low, not that a different kind of
  // surface is being drawn.
  //
  // The structure comes from `groundCoverTexture` at two world scales, on a
  // planar frame rotated away from both the section grid and the ground scan's
  // own frame so the two bakes cannot beat against each other.
  const swardUv = vec2(
    position.x.mul(0.947).sub(position.z.mul(0.321)),
    position.z.mul(0.947).add(position.x.mul(0.321)),
  )
  // One tile per 0.9 m puts a tussock crown at about 4 cm, and one per 7.4 m
  // gives the patch-scale variation that stops a hillside reading as one mat.
  const swardClump = texture(groundCoverTexture, swardUv.mul(float(1 / 0.9)))
    .toVar('terrainSwardClump')
  const swardPatch = texture(groundCoverTexture, swardUv.mul(float(1 / 7.4)))
    .toVar('terrainSwardPatch')
  const crown = clamp(
    swardClump.r.mul(0.72).add(swardPatch.r.mul(0.46)),
    0,
    1,
  ).toVar('terrainSwardCrown')
  // How much of the ground is living crown rather than the dead litter packed
  // between the crowns.
  //
  // Calibrated against what `cellularCrown` actually produces, which is the
  // step the first pass got wrong: the old 0.34-0.74 window was carried over
  // from a Perlin clump field whose mean sits near 0.5, while a normalised
  // Voronoi crown averages about 0.47 with a much tighter spread. The result
  // was a tussock fraction near 0.23 — a hillside that is three quarters dead
  // straw, which is what a late-autumn pasture looks like and not what this
  // one is meant to be. Wet ground pushes it further toward living turf, which
  // is the whole visual difference between a valley floor and a dry spur.
  const tussock = clamp(
    smoothstep(0.2, 0.62, crown).mul(mix(float(0.82), float(1.12), slow.moisture)),
    0,
    1,
  ).toVar('terrainTussock')
  // Written as a rising smoothstep and inverted, never as a descending one:
  // WGSL leaves `smoothstep(high, low, x)` undefined, and the backends differ
  // on what they do with it.
  const swardThinning = smoothstep(0.08, 0.42, crown).oneMinus()
    .mul(mix(float(0.7), float(1.25), swardPatch.a))
    .clamp(0, 1)
    .toVar('terrainSwardThinning')
  const bladeShade = mix(float(0.86), float(1.1), swardClump.b)
  const swardHeight = swardClump.g
    .mul(0.62)
    .add(swardPatch.g.mul(0.38))
    .toVar('terrainSwardHeight')

  // The same climate blend the relief and roughness use, so every quantity
  // crosses over at one place. Splitting the thresholds puts sandstone colour
  // on ground that still carries alpine structure for a kilometre of margin.
  const arid = smoothstep(0.25, 0.75, slow.aridity).toVar('terrainAridBlend')
  const ironBudget = smoothstep(0.25, 0.78, slow.regionalTint)
  const macroTone = slow.macro

  // Measured diffuse reflectance, not a mood. Alpine turf sits near 0.13,
  // bleached litter near 0.25 and humic soil near 0.12. Sand is the same rock
  // as the cliff with its iron coatings abraded off by transport, so it is far
  // paler and less saturated while staying unmistakably related to it.
  const sandBase = mix(
    vec3(0.318, 0.252, 0.158),
    vec3(0.408, 0.345, 0.238),
    macroTone,
  ).mul(mix(float(0.95), float(1.06), ironBudget.oneMinus()))
  const bareEarth = mix(
    mix(vec3(0.118, 0.092, 0.066), vec3(0.176, 0.142, 0.104), macroTone),
    sandBase,
    arid,
  ).toVar('terrainBareEarth')
  const litterTone = mix(
    mix(vec3(0.152, 0.136, 0.088), vec3(0.208, 0.186, 0.122), macroTone),
    sandBase.mul(0.88),
    arid,
  ).toVar('terrainLitterTone')
  // Wet ground grows a deeper, bluer green than dry ground does, and that
  // difference along a drainage line is the strongest vegetation cue a
  // mountainside has.
  const liveTurf = mix(
    mix(
      mix(vec3(0.068, 0.104, 0.044), vec3(0.088, 0.138, 0.056), slow.moisture),
      vec3(0.128, 0.176, 0.076),
      macroTone,
    ),
    mix(vec3(0.082, 0.078, 0.038), vec3(0.152, 0.142, 0.078), macroTone),
    arid,
  ).toVar('terrainLiveTurf')

  // Stones sit *in* the sward, so they appear where the mat is thin and are
  // never brighter than the rock they broke from.
  const stoneColour = scanRockDiffuse
    .mul(0.48)
    .mul(mix(float(0.72), float(1.15), broad.b))
  const stoneMask = smoothstep(0.66, 0.88, fine.b)
    .mul(swardThinning)
    .toVar('terrainSwardStone')

  const grass = mix(
    mix(
      mix(litterTone, liveTurf, tussock).mul(bladeShade),
      bareEarth,
      swardThinning.mul(0.55),
    ),
    stoneColour,
    stoneMask,
  )
  // Dry ground: the same structure with the living fraction bleached out. The
  // contrast between this and green turf along a drainage line is what makes a
  // slope read as pasture rather than as a painted gradient.
  const meadow = mix(
    mix(
      mix(
        litterTone.mul(1.04),
        mix(litterTone, liveTurf, float(0.3)),
        tussock,
      ).mul(bladeShade),
      bareEarth.mul(1.1),
      swardThinning.mul(0.6),
    ),
    stoneColour.mul(1.06),
    stoneMask,
  )
  // Bare ground is genuinely mineral, so it keeps a share of the scan's clast
  // structure — but a share, not the 68 per cent that made it stone.
  const soil = mix(
    mix(bareEarth, mix(bareEarth, litterTone, float(0.45)), macroTone),
    scanRockDiffuse.mul(0.9),
    float(0.3),
  )
  const scree = mix(mix(
    vec3(0.072, 0.082, 0.092),
    vec3(0.138, 0.128, 0.112),
    slow.aridity,
  ), scanRockDiffuse.mul(0.96), float(0.76))
  let rock = mix(
    vec3(0.065, 0.078, 0.095),
    vec3(0.215, 0.225, 0.225),
    slow.regionalTint,
  )
  rock = mix(
    rock,
    vec3(0.2, 0.145, 0.09),
    slow.aridity.mul(0.2),
  )
  const bedTone = mix(float(0.9), float(1.08), bandBody)
  rock = mix(
    rock,
    vec3(0.07, 0.09, 0.055),
    slow.bakedLichen.mul(0.18),
  )
  // Let the capture supply real mineral variation without stamping its whole
  // rectangular colour composition onto every terrain-owned formation. The
  // correlated normal, AO, roughness and displacement remain at full strength.
  rock = mix(rock, scanRockDiffuse, float(0.52))
  rock = rock.mul(mix(float(0.9), float(1.1), slow.regionalTint))
  // Apply the geological tone after the scan so the authored strata remain
  // visible without manufacturing extra cracks from albedo luminance.
  rock = rock.mul(mix(float(1), bedTone, bedExposure))
  const snow = vec3(0.68, 0.73, 0.8)

  let albedo = grass.mul(weights.grass)
    .add(meadow.mul(weights.meadow))
    .add(soil.mul(weights.soil))
    .add(scree.mul(weights.scree))
    .add(rock.mul(weights.rock))
    .add(snow.mul(weights.snow))

  const rockVariation = mix(
    float(0.94),
    float(1.06),
    broad.r,
  )
  // --- how a hillside of one plant stops being one colour ------------------
  //
  // Coverage says "grass" over square kilometres at a time, and it is right to.
  // What stops that reading as paint is that real pasture varies by a great
  // deal more than the eight per cent this used to allow, and varies for
  // reasons the eye knows how to read.
  //
  // Aspect is the strongest of them and was missing entirely. A slope facing
  // the sun dries out, is grazed harder and goes to straw weeks earlier than
  // the shaded slope on the other side of the same spur; a north face stays
  // deep green into the autumn. That single difference is most of what gives a
  // real range its patchwork, and it costs one dot product against a fixed
  // world bearing — fixed, rather than the true sun vector, because the ground
  // does not re-dry when the sun moves and a hillside whose colour swings
  // through the day is far more wrong than one lit from a constant bearing.
  const sunward = clamp(
    geometricNormal.xz.dot(vec2(0.42, -0.91)).mul(0.5).add(0.5),
    0,
    1,
  ).toVar('terrainAspect')
  // Convexity dries ground out too: a rib sheds its water to the hollows
  // either side, so the ribs go straw first and the hollows stay green. This
  // is what draws the drainage pattern onto a green hillside.
  const parched = clamp(
    sunward.mul(0.62)
      .add(slow.curvature.mul(0.5).add(0.5).mul(0.3))
      .add(slow.macro.sub(0.5).mul(0.5)),
    0,
    1,
  ).toVar('terrainParched')
  const turfVariation = mix(float(0.78), float(1.24), broad.b)
    .mul(mix(float(0.9), float(1.14), parched))
  albedo = albedo
    .mul(mix(float(1), rockVariation, rocky))
    .mul(mix(float(1), turfVariation, vegetation.mul(0.85)))
  // Drying moves grass along a hue path, not a brightness ramp: chlorophyll
  // goes first and the carotenoid straw underneath it is what is left, so dry
  // pasture is yellower *and* warmer, never simply paler green. Ramping value
  // alone is what makes a procedural hillside read as one colour under a
  // lighting gradient however much variation is put into it.
  const strawShift = vec3(0.24, 0.1, -0.34)
  albedo = albedo.mul(
    strawShift.mul(parched.mul(vegetation).mul(0.5)).add(1),
  )
  const sparseLichen = smoothstep(0.6, 0.84, broad.b)
    .mul(slow.moisture.add(slow.flow.mul(0.35)).clamp(0, 1))
    .mul(vegetation)
    .mul(0.26)
  albedo = albedo.mul(sparseLichen.oneMinus())
    .add(vec3(0.038, 0.052, 0.032).mul(sparseLichen))
  // Cavity belongs in the material's AO lobe below. Baking the full field into
  // diffuse as well applied it twice and made broad ground hollows look like
  // black stains while exposed mesh-patch faces stayed clean.
  albedo = albedo.mul(mix(float(0.9), float(1.035), slow.occlusion))

  // The displacement map, normal map and albedo came from the same scan. Their
  // cracks therefore agree pixel-for-pixel instead of turning colour contrast
  // into unrelated embossed height.
  // Turf relief is the sward's own surface, not the rock's. Reading it from
  // `scanDisplacement` — a gravel capture — is what gave a hillside of pasture
  // the shading normal of a scree slope, and no amount of green on top of that
  // reads as grass: the eye identifies vegetation from how light breaks across
  // clumped, soft, sub-decimetre structure, and a clast field has none of it.
  // Crowns carry most of it, blade grain rides on top, and the broad geology
  // band stays in at a low weight because turf really does drape whatever the
  // ground beneath it is doing.
  const turfHeight = swardHeight
    .mul(0.16)
    .add(swardClump.b.mul(0.03))
    .add(broad.g.mul(0.06))
  const rockHeight = scanDisplacement
    .mul(0.72)
    .add(bandRiser.mul(bedExposure).mul(0.46))
  const reliefHeight = mix(turfHeight, rockHeight, rocky)
    .mul(detailScale)
    .toVar('terrainReliefHeight')
  const viewDistance = cameraPosition.sub(position).length()
  const bumpStrength = mix(
    float(0.84),
    float(0.34),
    smoothstep(160, 1_200, viewDistance),
  ).mul(detailScale)
  const displacementNormal = reliefNormal(
    position,
    geometricNormal,
    reliefHeight,
    bumpStrength,
  )
  const scanNormalStrength = mix(
    float(0.76),
    float(0.32),
    smoothstep(160, 1_200, viewDistance),
  ).mul(rocky).mul(detailScale)
  const shadedNormal = vec3(normalize(
    vec3(displacementNormal).add(
      vec3(worldScanPerturbation).mul(scanNormalStrength),
    ),
  )).toVar('terrainShadedNormal')

  const cavity = clamp(
    slow.occlusion
      .mul(mix(float(1), scanArm.r, rocky.mul(0.68)))
      .mul(mix(float(1), fine.a.mul(-0.2).add(1), rocky.mul(0.16))),
    0.54,
    1,
  )
  // Grass is glossier than litter or than rock, and its gloss varies with the
  // tussock structure — a crown catches a sheen its shaded flanks do not. That
  // varying sheen is what gives a distant slope of pasture the shifting light
  // that says grass rather than paint, and a single flat 0.94 across the whole
  // vegetated channel cannot produce it.
  const turfRoughness = mix(float(0.93), float(0.68), tussock)
    .mul(mix(float(1), float(1.06), swardThinning))
    .clamp(0.6, 0.97)
  const baseRoughness = weights.grass.mul(turfRoughness)
    .add(weights.meadow.mul(turfRoughness.add(0.05)))
    .add(weights.soil.mul(0.91))
    .add(weights.scree.mul(0.86))
    .add(weights.rock.mul(0.74))
    .add(weights.snow.mul(0.72))
  const scanRoughness = scanArm.g
    .mul(mix(float(0.9), float(1.02), slow.aridity))
    .clamp(0.52, 0.98)
  const roughness = mix(
    baseRoughness,
    scanRoughness,
    rocky.mul(0.88),
  ).clamp(0.52, 0.98)

  const painted = applyTerrainPaint(albedo, roughness, materialSettings)
  // `slow.ember` is baked only onto faces created by an ember-classified CSG
  // subtraction. The light source is therefore the actual blind-chamber wall
  // in the terrain mesh, not a card or a second silhouette-matching object.
  const emberMask = smoothstep(0.04, 0.72, slow.ember)
    .toVar('terrainEmberMask')
  // Only the rear cap faces the mouth directly. Side walls remain dark red and
  // receive the real point-light bounce, which reveals several metres of
  // recess instead of filling the aperture edge-to-edge with a flat glow.
  const emberCap = smoothstep(
    0.34,
    0.86,
    dot(
      geometricNormal,
      vec3(
        THRUST_FACE_NORMAL.x,
        THRUST_FACE_NORMAL.y,
        THRUST_FACE_NORMAL.z,
      ),
    ).abs(),
  ).toVar('terrainEmberCap')
  const emberHeat = broad.r.mul(0.2)
    .add(fine.g.mul(0.48))
    .add(scanDisplacement.mul(0.32))
    .toVar('terrainEmberHeat')
  // Keep the hottest colour to small mineral pockets. A low threshold turned
  // the complete rear cap into a flat yellow polygon even though that cap is
  // physically recessed; most of it should remain dark orange rock lit by the
  // actual chamber light.
  const emberCore = smoothstep(0.64, 0.88, emberHeat)
  const emberEmission = mix(
    vec3(0.032, 0.0008, 0.00005),
    // Keep the cap in the orange-red range after AgX instead of driving all
    // three display channels into the white shoulder of the tone curve.
    vec3(0.72, 0.085, 0.003),
    emberCore,
  ).mul(emberMask).mul(mix(float(0.035), float(1), emberCap))
  if (debug !== 'none') {
    material.lights = false
    switch (debug) {
      case 'albedo':
        material.colorNode = painted.color
        break
      case 'normal':
        material.colorNode = shadedNormal.mul(0.5).add(0.5)
        break
      case 'relief':
        material.colorNode = vec3(reliefHeight.mul(0.45).add(0.35))
        break
      case 'layers':
        material.colorNode = vec3(
          weights.rock,
          weights.grass.add(weights.meadow),
          weights.scree.add(weights.soil),
        ).add(vec3(weights.snow))
        break
      case 'strata':
        material.colorNode = vec3(bandBody.mul(bedExposure))
        break
      case 'crack':
        material.colorNode = vec3(fine.a)
        break
      case 'blocks':
        material.colorNode = vec3(broad.b)
        break
      case 'buttress':
        material.colorNode = vec3(slow.buttress)
        break
      case 'scan':
        // R = final cliff likelihood, G = geometric slope, B = altitude bias.
        // This view makes domain mistakes diagnosable without guessing from a
        // lit albedo that contains both material and shadow variation.
        material.colorNode = vec3(
          cliffLikelihood,
          weights.slope,
          smoothstep(58, 205, position.y),
        )
        break
    }
  } else {
    const emberRock = painted.color
      // The rear cap is hot rock, not a red-painted polygon. Actual orange
      // comes from sparse emission and the enclosed point source; unheated
      // mineral between those pockets remains dark, brown-grey stone.
      .mul(vec3(0.24, 0.18, 0.13))
      .add(vec3(0.008, 0.002, 0.001))
    const rock = mix(
      painted.color,
      emberRock,
      emberMask,
    )
    // The forest floor, where a forest has been drawn over this ground. The
    // blend is a multiply by zero everywhere else — see `forestFloorBlend` —
    // and it is applied to the terrain's own shaded surface rather than drawn
    // as a second one, which is what lets a stand's litter fade into a
    // hillside over tens of metres instead of ending at a silhouette.
    const floor = forestFloorBlend(
      rock,
      painted.roughness,
      shadedNormal,
      geometricNormal,
      positionWorld,
    )
    material.colorNode = floor.colour
    material.roughnessNode = floor.roughness
    material.normalNode = floor.normal.transformDirection(cameraViewMatrix)
    material.aoNode = cavity.mul(floor.ao)
    material.emissiveNode = emberEmission
  }

  return {
    material,
    previewReady,
    ready,
    dispose() {
      material.dispose()
      detailTexture.dispose()
      groundCoverTexture.dispose()
    },
  }
}
