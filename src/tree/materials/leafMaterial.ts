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
  mat4,
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
      // Kept below the fluorescent v19 response (4.25), but high enough that
      // the distant crown retains olive midtones instead of collapsing black.
      context.irradiance.mul(surfaceScatter).mul(3).mul(this.transmitted),
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
      applyAttributeInstanceTransform(material)
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
  if (attributeInstancing) applyAttributeInstanceTransform(material)
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
  // A soft threshold plus alpha-to-coverage: hard-cut leaf edges are the
  // single most recognisable "game foliage from 2010" artefact, and MSAA
  // coverage dithering removes it without paying for sorted transparency.
  // Shared with the mip builder, which rescales alpha per level so the same
  // fraction of texels survives this threshold at every distance. Two separate
  // constants would drift and the canopy would thin out again with no
  // obvious cause.
  material.alphaTest = LEAF_ALPHA_TEST
  material.alphaToCoverage = true
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
    albedo.a,
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
): void {
  const instanceMatrix = mat4(
    attribute<'vec4'>('treeInstanceMatrix0', 'vec4'),
    attribute<'vec4'>('treeInstanceMatrix1', 'vec4'),
    attribute<'vec4'>('treeInstanceMatrix2', 'vec4'),
    attribute<'vec4'>('treeInstanceMatrix3', 'vec4'),
  )
  material.positionNode = Fn(() => {
    normalLocal.assign(transformNormal(normalLocal, instanceMatrix))
    return instanceMatrix.mul(positionLocal).xyz
  })()
}
