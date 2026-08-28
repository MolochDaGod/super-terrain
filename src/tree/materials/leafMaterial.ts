import {
  DoubleSide,
  MeshStandardNodeMaterial,
  PhysicalLightingModel,
  Vector2,
} from 'three/webgpu'
import {
  faceDirection,
  attribute,
  Fn,
  float,
  fwidth,
  mat4,
  max,
  mix,
  normalize,
  normalLocal,
  normalMap,
  normalView,
  positionLocal,
  positionViewDirection,
  texture,
  transformNormal,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { foliageSway } from './foliageWind'
import {
  LEAF_ALPHA_TEST,
  type LeafAtlasTextures,
  type LeafCardTextures,
} from './proceduralTreeTextures'

type VectorNode = Node<'vec3'>

/**
 * Shadow-aware leaf scattering. The substantial surface floor is deliberate:
 * thick rosettes and araucaria scales still scatter within their cuticle even
 * though much less light travels straight through the whole blade.
 */
/**
 * Atlas alpha to a one-pixel coverage ramp for alpha-to-coverage.
 *
 * `fwidth` is how fast the alpha is changing per pixel, so dividing the signed
 * distance from the cutoff by it yields a value that crosses 0 to 1 over
 * roughly one pixel wherever the silhouette is. The isoline stays exactly where
 * a hard test at `LEAF_ALPHA_TEST` would put it, which is what the mip chain's
 * coverage matching is calibrated against.
 *
 * The result is self-normalising: dividing by the per-pixel slope makes the
 * transition one pixel wide at every distance, so there is nothing to hand over
 * to at range. Blending toward a hard cutout past some slope, which is the
 * obvious-looking safety net, does the opposite of helping — the blend itself
 * produces intermediate coverage across a whole depth band and dithers it.
 *
 * With alpha to coverage off this decides the cut boundary to sub-texel
 * accuracy instead of at whichever texel centre crosses the threshold, which
 * keeps blade edges from crawling as a card is approached. It is also the
 * prerequisite for switching coverage back on: doing that without this is what
 * produced the speckle in the first place.
 */
function cutoutCoverage(alpha: Node<'float'>): Node<'float'> {
  const slope = max(fwidth(alpha), float(1e-5))
  return alpha.sub(LEAF_ALPHA_TEST).div(slope).add(0.5).clamp()
}

/**
 * How much extra ambient a leaf returns because light passes through it.
 *
 * The physics puts a ceiling on this. A leaf transmits roughly as much as it
 * reflects, so a double-sided card under uniform ambient should return at most
 * about twice a Lambertian surface of the same albedo — that is, this term
 * should add roughly `irradiance * albedo / PI` on top of what
 * `PhysicalLightingModel` already contributed. `surfaceScatter` runs 0.45 to
 * 0.9, so the multiplier that lands on `1/PI` is about 0.47.
 *
 * It was 3, which put the extra term at 1.35 to 2.7 times `albedo * irradiance`
 * — four to eight times the Lambert term it was added to. That is why foliage
 * read as luminous next to every other surface no matter what the lighting did:
 * under ambient, a leaf was returning five to nine times the energy that bark
 * or ground with the same albedo returned, biased green on top. It also swamped
 * global illumination, since the probe field arrives through this same
 * `irradiance` and was being amplified by the same factor on leaves alone.
 */
const LEAF_AMBIENT_TRANSMISSION = 0.5

class LeafLightingModel extends PhysicalLightingModel {
  private readonly translucency: Node<'float'>
  private readonly transmitted: VectorNode

  constructor(
    translucency: Node<'float'>,
    transmitted: VectorNode,
  ) {
    super()
    this.translucency = translucency
    this.transmitted = transmitted
  }

  indirectDiffuse(builder: Parameters<PhysicalLightingModel['indirect']>[0]): void {
    super.indirectDiffuse(builder)
    const context = (builder as unknown as {
      context: { irradiance: VectorNode; reflectedLight: { indirectDiffuse: VectorNode } }
    }).context
    // Open-sky fill from the far hemisphere. This is not emissive: it scales
    // the irradiance the renderer actually computed and vanishes under a dark
    // environment. The floor prevents thick foliage becoming an opaque cutout.
    const surfaceScatter = this.translucency.mul(0.45).add(0.45)
    context.reflectedLight.indirectDiffuse.addAssign(
      context.irradiance.mul(surfaceScatter).mul(LEAF_AMBIENT_TRANSMISSION)
        .mul(this.transmitted),
    )
  }

  direct(
    input: Parameters<PhysicalLightingModel['direct']>[0],
    builder: Parameters<PhysicalLightingModel['direct']>[1],
  ): void {
    super.direct(input, builder)
    const lightDirection = input.lightDirection as VectorNode
    const lightColor = input.lightColor as VectorNode
    const directDiffuse = input.reflectedLight.directDiffuse as VectorNode
    const surfaceScatter = this.translucency.mul(0.45).add(0.45)

    // Soft surface-layer wrap around the terminator.
    const cosine = normalView.dot(lightDirection)
    const wrapped = cosine.add(0.4).div(1.4).clamp()
    directDiffuse.addAssign(
      lightColor.mul(wrapped.sub(cosine.clamp())).mul(surfaceScatter)
        .mul(0.48).mul(this.transmitted),
    )

    // Selective straight-through sun, confined to genuinely translucent tissue.
    const bent = normalize(lightDirection.add(normalView.mul(0.35)))
    const behind = positionViewDirection.dot(bent.negate()).clamp().pow(5.5)
    directDiffuse.addAssign(
      lightColor.mul(behind).mul(this.translucency).mul(0.72).mul(this.transmitted),
    )
  }
}

class LeafNodeMaterial extends MeshStandardNodeMaterial {
  private readonly translucency: Node<'float'>
  private readonly transmitted: VectorNode

  constructor(
    translucency: Node<'float'>,
    transmitted: VectorNode,
  ) {
    super()
    this.translucency = translucency
    this.transmitted = transmitted
  }

  override setupLightingModel(): PhysicalLightingModel {
    return new LeafLightingModel(this.translucency, this.transmitted)
  }
}

/**
 * The material one batch of leaf-spray cards is drawn with.
 *
 * Everything species- or atlas-specific is read out of the packed surface map,
 * so adding a channel is a change here and in the baker rather than another
 * whole texture bound per draw.
 */
export function createFoliageMaterial(
  card: LeafCardTextures | LeafAtlasTextures | undefined,
  attributeInstancing = card !== undefined && 'variants' in card,
): MeshStandardNodeMaterial {
  if (!card) {
    const material = new MeshStandardNodeMaterial({
      name: 'far foliage mass',
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
    })
    if (attributeInstancing) {
      applyAttributeInstanceTransform(material, { wind: true })
      material.colorNode = vec4(
        attribute<'vec3'>('treeInstanceColor', 'vec3'), 1,
      )
    }
    return material
  }

  const atlasUv = 'variants' in card
    ? vec2(
        uv().x.add(attribute<'float'>('leafVariant', 'float')).div(card.variants),
        uv().y,
      )
    : undefined
  const instanceTint = atlasUv
    ? attribute<'vec3'>('treeInstanceColor', 'vec3')
    : vec3(1)
  const surface = atlasUv ? texture(card.surfaceMap, atlasUv) : texture(card.surfaceMap)
  const albedo = atlasUv ? texture(card.map, atlasUv) : texture(card.map)
  // R roughness, G blade translucency, B card-local ambient occlusion. Reading
  // three properties from one texture rather than three keeps the leaf atlas to
  // three maps per variant.
  // Wide enough to pass the authored range through. The atlas now carries a
  // genuine gloss spread between young and weathered blades; a narrow clamp
  // flattens that back into the single uniform sheen it was written to break.
  // Clamping at all only guards corrupt or legacy atlases.
  const roughnessChannel = surface.r.clamp(0.34, 0.92)
  const translucency = surface.g
  const occlusion = surface.b

  const transmitted = albedo.rgb.mul(vec3(0.92, 1.02, 0.76))

  // 1 on a back face, 0 on a front face.
  const underside = faceDirection.mul(-0.5).add(0.5)

  const material = new LeafNodeMaterial(translucency, transmitted)
  material.name = 'leaf spray card'
  material.vertexColors = !atlasUv
  if (attributeInstancing) applyAttributeInstanceTransform(material, { wind: true })
  if (atlasUv) {
    material.normalNode = normalMap(texture(card.normalMap, atlasUv).rgb, vec2(0.28))
  } else {
    material.map = card.map
    material.normalMap = card.normalMap
  }
  // Enough tangent relief to separate the blades within a spray, while the
  // bowed card still provides the branchlet-scale change in orientation. The
  // atlas relief is now dominated by broad blade cupping rather than by vein
  // ridges, so this can be raised without embossing every cutout into a thick
  // plastic badge — the cupping is what gives a blade its soft gradient from
  // midrib to margin, and without it the leaf is a flat paper shape.
  material.normalScale = new Vector2(0.28, 0.28)
  material.roughness = 1
  material.metalness = 0
  material.side = DoubleSide
  // Alpha to coverage was here to antialias the cutout, and measurement says
  // it cannot pay for itself in a canopy.
  //
  // It turns the fragment's alpha into a stochastic MSAA sample mask, so every
  // pixel that is not fully inside or fully outside a blade resolves as a
  // mixture of the blade and whatever is behind it. In a stand that background
  // is the dark canopy interior, which is why backlit foliage came out covered
  // in black speckle, worst when looking into the sun — the moment lit blade
  // and shaded interior are furthest apart.
  //
  // Sharpening the coverage to one pixel (see `cutoutCoverage`) removes it on
  // near and middle foliage but not in the depth of the canopy, because there
  // several cards stack inside a single pixel and every pixel is a silhouette
  // pixel for one of them. At that density alpha to coverage has no silhouette
  // left to antialias and only contributes noise. The frames with it off are
  // cleaner at every distance, and the geometry edges of the cards are still
  // antialiased by MSAA itself.
  material.alphaTest = 0.02
  material.alphaToCoverage = false
  material.depthWrite = true

  // The abaxial surface of a leaf is genuinely a different material: paler,
  // greyer from the wax and the hair layer, and much more matte than the glossy
  // upper cuticle. Drawing both sides with the adaxial texture is why
  // double-sided foliage reads as cardboard whichever way it faces.
  //
  // The alpha has to be carried through explicitly. A `colorNode` replaces the
  // material's whole colour setup, map included, so handing it a vec3 silently
  // drops the atlas cutout and every card renders as a solid opaque quad.
  material.colorNode = vec4(
    albedo.rgb
      .mul(mix(vec3(1, 1, 1), vec3(1.06, 0.92, 1.08), underside))
      .mul(instanceTint),
    cutoutCoverage(albedo.a),
  )
  material.roughnessNode = mix(roughnessChannel, roughnessChannel.add(0.16), underside)
  // Card-local occlusion for the geometry the card stands in for. It is applied
  // to the ambient term only, so a sunlit blade deep in the spray can still
  // catch a direct highlight.
  material.aoNode = occlusion
  return material
}

/** Opaque compound leaves use real pinna geometry rather than atlas cutouts. */
export function createFrondMaterial(attributeInstancing = false): MeshStandardNodeMaterial {
  const material = new LeafNodeMaterial(float(0.13), vec3(0.1, 0.21, 0.045))
  material.name = 'segmented palm frond'
  material.color.set(0xaaaaaa)
  material.vertexColors = true
  material.roughness = 0.86
  material.metalness = 0
  material.side = DoubleSide
  if (attributeInstancing) {
    applyAttributeInstanceTransform(material)
    material.colorNode = vec4(
      attribute<'vec3'>('treeInstanceColor', 'vec3').mul(vec3(0.667)),
      1,
    )
  }
  return material
}

export function applyAttributeInstanceTransform(
  material: MeshStandardNodeMaterial,
  { wind = false }: { wind?: boolean } = {},
): void {
  const instanceMatrix = mat4(
    attribute<'vec4'>('treeInstanceMatrix0', 'vec4'),
    attribute<'vec4'>('treeInstanceMatrix1', 'vec4'),
    attribute<'vec4'>('treeInstanceMatrix2', 'vec4'),
    attribute<'vec4'>('treeInstanceMatrix3', 'vec4'),
  )
  material.positionNode = Fn(() => {
    const placed = instanceMatrix.mul(positionLocal).xyz
    const worldNormal = transformNormal(normalLocal, instanceMatrix)
    if (!wind) {
      normalLocal.assign(worldNormal)
      return placed
    }
    // The matrix's translation column is where this spray meets its twig. The
    // sway is a rotation about that point, so the offset is what turns and the
    // anchor is what stays.
    const anchor = attribute<'vec4'>('treeInstanceMatrix3', 'vec4').xyz
    const swayed = foliageSway(anchor, placed.sub(anchor), worldNormal)
    normalLocal.assign(swayed.normal)
    return anchor.add(swayed.position)
  })()
}
