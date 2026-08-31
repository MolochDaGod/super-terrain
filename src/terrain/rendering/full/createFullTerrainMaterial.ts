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

/**
 * How far the coarse octave of a bake is stretched past its authored width.
 *
 * Not a free knob. `cliffSideRecipe` is a 1.8 m capture, so 6.11 puts its
 * eleven beds at 1.0 m each and its joint blocks at 1 to 2 m — the band a
 * cliff is actually read at from fifty to three hundred metres, and the band
 * the old 35x stretch skipped straight over. Past about eight the beds start
 * to read as terracing and the pitting disappears below a pixel before the
 * fine octave has faded in to replace it; below about four the repeat becomes
 * visible faster than the detail improves.
 */
const COARSE_TILE_FACTOR = 6.11
/**
 * The same factor for the top-down ground capture. `rockGroundRecipe` is a 2 m
 * tile of clasts, so this keeps a cobble at roughly 7 cm rather than the 25 cm
 * boulders a 14.5 m tile made of them.
 */
const GROUND_TILE_FACTOR = 3.6
/**
 * Where the fine octave is worth sampling, in metres of view distance.
 *
 * A 1.8 m tile at 1K is 1.8 mm per texel. Past roughly eighty metres that is
 * far below a screen pixel, so the octave contributes nothing but the mip
 * chain's average — a flat grey that dilutes the coarse octave it is added to.
 * Fading it out is not a saving, it is what keeps the distant massif from
 * going soft.
 */
const DETAIL_OCTAVE_NEAR = 34
const DETAIL_OCTAVE_FAR = 190
/**
 * Strength of the fine octave's normal, relative to the coarse one's.
 *
 * A normal map stores slope, and slope is dimensionless, so both octaves hand
 * back perturbations of the same magnitude however they are scaled. That makes
 * the honest ratio `1 / COARSE_TILE_FACTOR`: only the fine octave is being
 * sampled at the width its slopes were baked for, and the coarse one is
 * overstating its relief by exactly the factor it was stretched by.
 *
 * It is not the ratio used, and the reason is worth stating. A 1.8 m bake has
 * no metre-scale structure in it to give; the coarse octave is a stand-in for
 * the large form, and honouring its true amplitude would leave a face beyond
 * thirty metres — where the fine octave has faded — with almost no relief at
 * all. So the coarse octave keeps its exaggeration and the fine one comes in
 * just below parity: enough to carry the grain and the pitting at close range,
 * not enough to bury the joint network under a uniform fizz.
 */
const DETAIL_OCTAVE_WEIGHT = 0.62
/** The same, for the shallower top-down ground capture. */
const GROUND_DETAIL_OCTAVE_WEIGHT = 0.48

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
  // --- how large one tile of a bake is, in metres ---------------------------
  //
  // The bake is authored at a physical size and says so: `cliffSideRecipe` lays
  // down eleven beds, three joint sets and five scales of pitting across
  // `physicalWidth` metres, and `heightToNormal` encodes the slopes that
  // `reliefDepth` metres of relief across that width actually produce. Choosing
  // a UV scale is therefore not a free parameter — it is a claim about how big
  // the photographed rock was, and every quantity in the bake is calibrated
  // against it.
  //
  // This used to be a hard-coded 1/64, picked to keep the repeat off the screen.
  // It stretched a 1.8 m tile across 64 m, which is the whole of what made a
  // cliff read as bland: every millimetre grain socket became a 4 cm pit, every
  // 16 cm bed became a 5.7 m band, and the normal map — unchanged, because a
  // normal map stores slope and slope is dimensionless — went on describing
  // 0.17 m of relief as though it were six metres. What survived to the screen
  // was the joint network alone, magnified thirty-five times into soft dark
  // gouges with nothing at all between them.
  //
  // Two octaves of the same bake replace it. The coarse one is stretched, but
  // by a stated and modest factor that puts the recipe's own structure at the
  // size the eye reads as cliff: 1.3 m beds and 2 m joint slabs. The fine one
  // runs at the authored width, where the grain and the pitting are the size
  // they were baked to be. Neither is a substitute for the other — the coarse
  // octave carries the face at a hundred metres, the fine one is what makes it
  // hold up at five.
  const cliffTile = cliffSurface.physicalWidth * COARSE_TILE_FACTOR
  const cliffDetailTile = cliffSurface.physicalWidth
  const cliffScale = float(1 / cliffTile)
  // Deliberately not a whole-number ratio of the coarse scale. Two octaves of
  // one texture at commensurate scales put their repeats on top of each other
  // and the lattice survives both; at 6.11 and 1 the two grids only re-align
  // every 11 m of coarse tile, which is 67 m of world and past where the fine
  // octave has faded out anyway.
  const cliffDetailScale = float(1 / cliffDetailTile)
  const cliffFrameX = scanPosition.yz.mul(vec2(scanAxisSign.x, 1))
  const cliffFrameY = scanPosition.zx.mul(vec2(scanAxisSign.y, 1))
  const cliffFrameZ = scanPosition.xy.mul(vec2(scanAxisSign.z, 1))
  const cliffUvX = cliffFrameX.mul(cliffScale)
  const cliffUvY = cliffFrameY.mul(cliffScale)
  const cliffUvZ = cliffFrameZ.mul(cliffScale)
  // The fine octave is rotated out of the coarse octave's frame as well as
  // scaled out of it. Sharing a frame leaves both octaves' joint sets running
  // in the same two directions, which reads as one texture sharpened rather
  // than as two scales of rock.
  const detailRotation = (uv: any) => vec2(
    uv.x.mul(0.788).sub(uv.y.mul(0.616)),
    uv.x.mul(0.616).add(uv.y.mul(0.788)),
  )
  const cliffDetailUvX = detailRotation(cliffFrameX).mul(cliffDetailScale)
  const cliffDetailUvY = detailRotation(cliffFrameY).mul(cliffDetailScale)
  const cliffDetailUvZ = detailRotation(cliffFrameZ).mul(cliffDetailScale)
  // The ground scan is a top-down capture. Rotate its planar frame away from
  // the section grid and let mirrored wrapping double the apparent repeat.
  // Same rule as the cliff: the tile is the width the recipe was authored at,
  // multiplied by one stated factor. `rockGroundRecipe` is a 2 m capture, so
  // the coarse octave puts its clasts at a believable size instead of the
  // 7.3x-magnified boulders a 14.5 m tile made of them.
  const groundTile = groundSurface.physicalWidth * GROUND_TILE_FACTOR
  const groundDetailTile = groundSurface.physicalWidth
  const groundFrame = vec2(
    position.x.mul(0.829).add(position.z.mul(0.559)),
    position.z.mul(0.829).sub(position.x.mul(0.559)),
  )
  const groundUv = groundFrame.mul(float(1 / groundTile))
  const groundDetailUv = detailRotation(groundFrame).mul(
    float(1 / groundDetailTile),
  )
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
  // The fine octave's own height, from the ARM alpha of the same fetch that
  // supplies its occlusion and roughness.
  //
  // Only the height is taken from the fine octave, and only the cliff's. Its
  // albedo would be a second copy of the same photograph at a second scale,
  // which is how a surface starts to look like a texture multiplied by itself
  // rather than like rock; its roughness and AO are already carried well
  // enough by the coarse octave, which is sampled at every pixel this one is.
  // Height is the exception because height is what the eye reads as *depth*,
  // and depth at the scale of a hand is precisely what was missing.
  const cliffDetailArm = sampleScan(
    rockScanArm,
    cliffDetailUvX,
    cliffDetailUvY,
    cliffDetailUvZ,
    -0.04,
  )
  const groundDetailArm = texture(groundScanArm, groundDetailUv)
    .bias(float(-0.04))
  const detailDisplacement = mix(
    groundDetailArm.a,
    cliffDetailArm.a,
    scanDomain,
  ).toVar('terrainDetailScanDisplacement')
  // Both scan octaves darken where they are recessed. Multiplying the coarse
  // occlusion by the fine one is what puts contact shadow into the grain
  // sockets and the pit floors instead of leaving them as flat colour.
  const detailOcclusion = mix(
    groundDetailArm.r,
    cliffDetailArm.r,
    scanDomain,
  ).toVar('terrainDetailScanOcclusion')
  // The bake writes the surface height into the ARM alpha, so the height comes
  // out of a fetch that had to happen anyway. It used to be two more textures
  // — one per surface — each carrying eight bits of height replicated across
  // all four channels, and each costing a *sampler*. WebGPU guarantees sixteen
  // samplers per fragment stage and this adapter offers exactly sixteen, which
  // this material was already using, so the two redundant maps were the whole
  // of the headroom budget. See `packArm`.
  const scanDisplacement = scanArm.a.toVar('terrainSelectedScanDisplacement')
  const flatScanNormal = normalize(vec3(
    scanAxisSign.x.mul(scanWeights.x),
    scanAxisSign.y.mul(scanWeights.y),
    scanAxisSign.z.mul(scanWeights.z),
  ))
  /**
   * One octave of the cliff normal map, as a world-space perturbation.
   *
   * Convert each OpenGL tangent-space normal into the rotated scan volume,
   * then blend there before returning to world space. Merely treating this map
   * as height would reproduce the fake embossed look this material replaces.
   *
   * A *perturbation* rather than a normal is what makes two octaves
   * composable: perturbations add, whereas two normalised normals averaged
   * together give a third direction that is shallower than either and loses
   * the fine octave entirely wherever the coarse one is steep.
   */
  const cliffOctavePerturbation = (
    uvX: any,
    uvY: any,
    uvZ: any,
    label: string,
  ) => {
    const normalX = texture(rockScanNormal, uvX)
      .bias(float(-0.12)).rgb.mul(2).sub(1)
      .toVar(`${label}X`)
    const normalY = texture(rockScanNormal, uvY)
      .bias(float(-0.12)).rgb.mul(2).sub(1)
      .toVar(`${label}Y`)
    const normalZ = texture(rockScanNormal, uvZ)
      .bias(float(-0.12)).rgb.mul(2).sub(1)
      .toVar(`${label}Z`)
    const mapped = normalize(
      normalize(vec3(
        normalX.z.mul(scanAxisSign.x),
        normalX.x.mul(scanAxisSign.x),
        normalX.y,
      )).mul(scanWeights.x)
        .add(normalize(vec3(
          normalY.y,
          normalY.z.mul(scanAxisSign.y),
          normalY.x.mul(scanAxisSign.y),
        )).mul(scanWeights.y))
        .add(normalize(vec3(
          normalZ.x.mul(scanAxisSign.z),
          normalZ.y,
          normalZ.z.mul(scanAxisSign.z),
        )).mul(scanWeights.z)),
    )
    const perturbation = mapped.sub(flatScanNormal)
    // Back out of the thrust attitude the scan volume was rotated into.
    return vec3(
      perturbation.x.mul(0.84).sub(perturbation.y.mul(0.54)),
      perturbation.x.mul(0.54).add(perturbation.y.mul(0.84)),
      perturbation.z,
    )
  }
  // How much of the fine octave survives to this pixel. See
  // `DETAIL_OCTAVE_NEAR`: past the far end a 1.8 m tile is well below a screen
  // pixel and the octave is contributing its own mip average, which is flat.
  const scanViewDistance = cameraPosition.sub(position).length()
    .toVar('terrainScanViewDistance')
  const detailOctave = smoothstep(
    DETAIL_OCTAVE_FAR,
    DETAIL_OCTAVE_NEAR,
    scanViewDistance,
  ).toVar('terrainDetailOctave')

  // --- how much of the face is broken, and how much is one slab -------------
  //
  // A bake tiles at one density forever. That is the second half of what makes
  // a procedural cliff read as a texture rather than as rock, and fixing the
  // *scale* of the tile does not touch it: eleven metres of correctly-sized
  // joint blocks, repeated identically over a three-hundred-metre massif, is
  // still one pattern. What a real face has instead is *zones* — a buttress of
  // massive unjointed rock beside a shattered gully, a clean slab where a
  // block came away last winter — varying over tens of metres, which is
  // exactly the band no tiling texture can reach.
  //
  // Every input here was already being fetched or interpolated. `slow.jointing`
  // is the compiler's own fracture-density field and until now decided only
  // whether bedding was exposed; `broad` is the 28 m geology tap, of which one
  // channel was driving a six-per-cent colour wobble; `slow.curvature` says
  // which parts of the landform are ribs and which are hollows. Ribs stand in
  // the weather and shatter, hollows collect what falls off them and stay
  // buried, and that correlation is what stops this reading as a second noise
  // field laid over the first.
  const fracture = clamp(
    slow.jointing.mul(0.52)
      .add(broad.g.mul(0.46))
      .add(slow.curvature.mul(0.5).add(0.5).mul(0.34))
      .sub(0.16),
    0,
    1,
  ).toVar('terrainFractureDensity')
  // Massive rock keeps about a third of the bake's relief, shattered rock half
  // again more than it. The range is deliberately wide: a modest one reads as
  // the same surface unevenly lit rather than as two kinds of rock.
  const fractureRelief = mix(float(0.34), float(1.42), fracture)
    .toVar('terrainFractureRelief')
  const cliffWorldPerturbation = cliffOctavePerturbation(
    cliffUvX,
    cliffUvY,
    cliffUvZ,
    'terrainScanNormal',
  ).add(
    // The fine octave is added at its physical weight rather than at parity.
    // Both octaves come from one bake, so both encode the slopes of
    // `reliefDepth` metres of relief; over a tile `COARSE_TILE_FACTOR` times
    // smaller those same slopes describe that much less world relief, and
    // adding them as equals is what would turn a rock face into a uniform
    // fizz of high-frequency bump with no large form left in it.
    cliffOctavePerturbation(
      cliffDetailUvX,
      cliffDetailUvY,
      cliffDetailUvZ,
      'terrainScanDetailNormal',
    ).mul(detailOctave.mul(DETAIL_OCTAVE_WEIGHT)),
  )
  const groundNormalSign = sign(geometricNormal.y)
  const groundOctavePerturbation = (uv: any, label: string) => {
    const sampled = texture(groundScanNormal, uv)
      .bias(float(-0.12)).rgb.mul(2).sub(1)
      .toVar(label)
    return normalize(vec3(
      sampled.x.mul(0.829).sub(sampled.y.mul(0.559)),
      sampled.z.mul(groundNormalSign),
      sampled.x.mul(0.559).add(sampled.y.mul(0.829)),
    )).sub(vec3(0, groundNormalSign, 0))
  }
  const groundPerturbation = groundOctavePerturbation(
    groundUv,
    'terrainSelectedGroundNormal',
  ).add(
    groundOctavePerturbation(
      groundDetailUv,
      'terrainSelectedGroundDetailNormal',
    ).mul(detailOctave.mul(GROUND_DETAIL_OCTAVE_WEIGHT)),
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

  // Rock value varies over tens of metres by far more than the six per cent
  // this used to allow, and it varies for the same reason the relief does.
  // Freshly broken rock in a shattered zone exposes unweathered mineral and is
  // pale; a massive panel that has stood for centuries carries lichen, dust
  // and case-hardening and goes dark. Keying the value to the same `fracture`
  // field that decides the relief is what makes a panel read as one piece of
  // rock rather than as a bright patch that happens to sit near a rough one.
  const rockVariation = mix(float(0.82), float(1.12), broad.r)
    .mul(mix(float(0.88), float(1.14), fracture))
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
  // Each octave contributes the relief it physically has: `reliefDepth` metres
  // across `physicalWidth` metres of tile, scaled by however much that tile was
  // stretched to reach its world size. This used to be a flat 0.72 m against a
  // 64 m tile whose normal map was simultaneously claiming six metres, so the
  // two lobes built from one bake disagreed about the same rock by a factor of
  // eight — the displacement said "gentle swell", the normal said "canyon", and
  // the lighting split the difference into the soft grey smear this replaces.
  const coarseRelief = cliffSurface.reliefDepth * COARSE_TILE_FACTOR
  const fineRelief = cliffSurface.reliefDepth
  const rockHeight = scanDisplacement
    .mul(coarseRelief)
    .add(detailDisplacement.mul(fineRelief).mul(detailOctave))
    .mul(fractureRelief)
    .add(bandRiser.mul(bedExposure).mul(0.46))
  const reliefHeight = mix(turfHeight, rockHeight, rocky)
    .mul(detailScale)
    .toVar('terrainReliefHeight')
  const viewDistance = scanViewDistance
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
  ).mul(rocky).mul(fractureRelief).mul(detailScale)
  const shadedNormal = vec3(normalize(
    vec3(displacementNormal).add(
      vec3(worldScanPerturbation).mul(scanNormalStrength),
    ),
  )).toVar('terrainShadedNormal')

  const cavity = clamp(
    slow.occlusion
      .mul(mix(float(1), scanArm.r, rocky.mul(0.68)))
      // The fine octave's own occlusion, faded in with it. Grain sockets and
      // solution pits are holes a centimetre across; what identifies them as
      // holes rather than as dark speckle is that they are darker than the
      // face around them for a reason the normal agrees with.
      .mul(mix(float(1), detailOcclusion, rocky.mul(detailOctave).mul(0.55)))
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
