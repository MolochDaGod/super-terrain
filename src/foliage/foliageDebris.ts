import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  IndirectStorageBufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
  SphereGeometry,
  type Renderer,
} from 'three/webgpu'
import type ComputeNode from 'three/src/nodes/gpgpu/ComputeNode.js'
import * as TSL from 'three/tsl'
import type { FoliageGroundHeightField } from './foliageGroundHeight'
import type { FoliageMaskField } from './FoliageMaskField'
import { hash21, hash22, hash24, valueNoise2 } from './foliageNoise'
import { foliageCameraPosition, foliageFrustumPlanes } from './foliageRuntime'
import { FOLIAGE_SURFACE_ROWS } from './foliageSurfaces'

/** See the note in `FoliagePopulation`: these are node builders, not values. */
type ShaderValue = any

const {
  Fn,
  If,
  atomicAdd,
  atomicStore,
  attribute,
  cameraViewMatrix,
  clamp,
  cos,
  float,
  floor,
  instanceIndex,
  instancedArray,
  mix,
  normalGeometry,
  normalize,
  positionGeometry,
  positionWorld,
  sin,
  smoothstep,
  step,
  storage,
  texture,
  uint,
  vec2,
  vec3,
  vec4,
} = TSL as unknown as Record<string, ShaderValue>

/**
 * The things lying on a forest floor that are not plants.
 *
 * A stand rendered as trunks standing in ground cover is missing the whole
 * middle of what a floor actually is. Between the ferns there are fallen
 * twigs, the odd branch that came down in the last storm, and stones — and
 * they matter out of all proportion to their size, because they are the only
 * objects at the viewer's feet with a *hard* silhouette. Everything else down
 * there is soft: blades, fronds, litter, moss. A single stick lying across the
 * frame gives the eye something to measure the rest against, and its shadow is
 * the only contact shadow at that scale.
 *
 * Placed by exactly the same machinery as the blades — a camera-anchored grid,
 * a hash per cell, an atomic append and an indirect draw, nothing read back —
 * so the cost is one small compute dispatch and one draw per variant, and a
 * moving camera does not make any of it swim.
 */

export interface FoliageDebrisVariant {
  name: string
  /**
   * Share of accepted slots this variant takes, cumulative. A slot's hash is
   * compared against these in order, so the numbers are boundaries in 0..1.
   */
  share: number
  /** Metres, low and high, of the item's long axis. */
  length: readonly [number, number]
  /** 1 is wood, 0 is stone. Drives the albedo family and the roughness. */
  woodiness: number
  geometry: () => BufferGeometry
}

/**
 * Metres between candidate slots, and how far the field reaches.
 *
 * Debris is a near-field effect and nothing else: a twig is two centimetres
 * across, so past twenty-odd metres it is smaller than a pixel and drawing it
 * buys nothing but overdraw. The grid is sized so the whole field fits inside
 * the range at which the items are still resolvable.
 */
const DEBRIS_CELL = 0.85
const DEBRIS_GRID = 78
const DEBRIS_RANGE = 28
const DEBRIS_FADE = 7

const DEBRIS_VARIANTS: readonly FoliageDebrisVariant[] = [
  {
    name: 'twig',
    // The commonest thing on a floor by a wide margin.
    share: 0.58,
    length: [0.11, 0.34],
    woodiness: 1,
    geometry: () => stick(0.02, 0.032, 5, 2, 0.1),
  },
  {
    name: 'branch',
    share: 0.82,
    length: [0.5, 1.5],
    woodiness: 1,
    geometry: () => forkedStick(),
  },
  {
    name: 'stone',
    share: 1,
    length: [0.08, 0.3],
    woodiness: 0,
    geometry: () => pebble(),
  },
]

const DEBRIS_CAPACITY = DEBRIS_GRID * DEBRIS_GRID

export interface FoliageDebrisField {
  meshes: Mesh[]
  reset: ComputeNode[]
  populate: ComputeNode[]
  dispose(): void
}

/**
 * A tapered, slightly bent stick lying along its own X axis.
 *
 * Authored lying down rather than standing up, so the instance transform is a
 * yaw and a small roll instead of a full orientation — one less thing to get
 * wrong and two fewer trigonometric calls per vertex.
 */
function stick(
  tipRadius: number,
  buttRadius: number,
  sides: number,
  segments: number,
  bend: number,
): BufferGeometry {
  const geometry = new CylinderGeometry(tipRadius, buttRadius, 1, sides, segments)
  geometry.rotateZ(Math.PI / 2)
  const position = geometry.getAttribute('position') as BufferAttribute
  // A perfectly straight stick is a dowel. The bend is a single quadratic, so
  // it costs nothing and it is the difference between a twig and a peg.
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index)
    position.setY(index, position.getY(index) + (0.25 - x * x) * bend)
  }
  geometry.computeVertexNormals()
  // Non-indexed throughout, so every variant's indirect draw uses the same
  // four-word layout. A couple of dozen triangles do not need an index.
  const flat = geometry.toNonIndexed()
  geometry.dispose()
  return flat
}

/** A branch with one side stub, which is what makes it read as a branch. */
function forkedStick(): BufferGeometry {
  const main = stick(0.014, 0.038, 5, 3, 0.06)
  const stub = stick(0.008, 0.018, 4, 1, 0.02)
  stub.scale(0.34, 1, 1)
  stub.rotateY(0.9)
  stub.translate(0.1, 0.008, 0.09)
  return concatenate([main, stub])
}

/** A low water-worn dome. Squashed, because a stone on a floor is half buried. */
function pebble(): BufferGeometry {
  const geometry = new SphereGeometry(0.5, 7, 4)
  geometry.scale(1, 0.46, 0.78)
  const position = geometry.getAttribute('position') as BufferAttribute
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index)
    const y = position.getY(index)
    const z = position.getZ(index)
    // Faceting: a pebble is not an ellipsoid, and the flats are where its
    // highlights come from.
    const facet = 0.86 + 0.14 * Math.sin(x * 9.1 + z * 7.3 + y * 5.7)
    position.setXYZ(index, x * facet, y * facet, z * facet)
  }
  geometry.computeVertexNormals()
  const flat = geometry.toNonIndexed()
  geometry.dispose()
  return flat
}

function concatenate(parts: readonly BufferGeometry[]): BufferGeometry {
  // Every builder already returns non-indexed geometry, so this is a straight
  // append of two attribute arrays.
  const total = parts.reduce(
    (sum, part) => sum + (part.getAttribute('position') as BufferAttribute).count,
    0,
  )
  const positions = new Float32Array(total * 3)
  const normals = new Float32Array(total * 3)
  let cursor = 0
  for (const part of parts) {
    const partPosition = part.getAttribute('position') as BufferAttribute
    const partNormal = part.getAttribute('normal') as BufferAttribute
    positions.set(partPosition.array as Float32Array, cursor * 3)
    normals.set(partNormal.array as Float32Array, cursor * 3)
    cursor += partPosition.count
    part.dispose()
  }
  const merged = new BufferGeometry()
  merged.setAttribute('position', new BufferAttribute(positions, 3))
  merged.setAttribute('normal', new BufferAttribute(normals, 3))
  return merged
}

/**
 * The debris field: one instance buffer, one material, one draw per variant.
 *
 * Each variant owns a disjoint slice of the buffer and carries the slice's
 * offset as a constant vertex attribute, exactly as the blade rings do, so all
 * three share a single pipeline.
 */
export function createFoliageDebris(
  mask: FoliageMaskField,
  ground: FoliageGroundHeightField,
): FoliageDebrisField {
  const capacity = DEBRIS_CAPACITY * DEBRIS_VARIANTS.length
  const instances = instancedArray(capacity * 2, 'vec4')
  const reader = storage(
    (instances as ShaderValue).value,
    'vec4',
    capacity * 2,
  ).toReadOnly()

  const material = createDebrisMaterial(reader, mask)
  const meshes: Mesh[] = []
  const reset: ComputeNode[] = []
  const populate: ComputeNode[] = []

  DEBRIS_VARIANTS.forEach((variant, index) => {
    const geometry = variant.geometry()
    const vertices = (geometry.getAttribute('position') as BufferAttribute).count
    const meta = new Float32Array(vertices * 2)
    const offset = index * DEBRIS_CAPACITY
    for (let vertex = 0; vertex < vertices; vertex += 1) {
      meta[vertex * 2] = offset
      meta[vertex * 2 + 1] = variant.woodiness
    }
    geometry.setAttribute('debrisMeta', new BufferAttribute(meta, 2))

    const indirectAttribute = new IndirectStorageBufferAttribute(
      new Uint32Array([vertices, 0, 0, 0]),
      4,
    )
    indirectAttribute.name = `foliage-debris-indirect-${variant.name}`
    geometry.setIndirect(indirectAttribute)
    const indirect: ShaderValue = storage(indirectAttribute, 'uint', 4).toAtomic()

    const mesh = new Mesh(geometry, material)
    mesh.name = `foliage-debris-${variant.name}`
    mesh.matrixAutoUpdate = false
    // Culled per item in the kernel, so three culling the whole field against
    // a bounding sphere it cannot know would only ever be wrong.
    mesh.frustumCulled = false
    mesh.receiveShadow = true
    // Debris does cast. It is the cheapest geometry in the scene — no alpha
    // test, a couple of dozen triangles — and its shadow is the contact that
    // stops a stick from hovering a centimetre above the litter.
    mesh.castShadow = true
    meshes.push(mesh)

    reset.push(Fn(() => {
      atomicStore(indirect.element(uint(1)), uint(0))
    })().compute(1))

    populate.push(
      createDebrisKernel(variant, index, offset, mask, instances, indirect, ground),
    )
  })

  return {
    meshes,
    reset,
    populate,
    dispose() {
      for (const mesh of meshes) mesh.geometry.dispose()
      material.dispose()
    },
  }
}

function createDebrisKernel(
  variant: FoliageDebrisVariant,
  index: number,
  offset: number,
  mask: FoliageMaskField,
  instances: ShaderValue,
  indirect: ShaderValue,
  ground: FoliageGroundHeightField,
): ComputeNode {
  const half = (DEBRIS_GRID * DEBRIS_CELL) / 2
  const maskResolution = mask.resolution
  const maskField = mask.fieldSize
  const maskOrigin = mask.origin
  const surfaceBuffer = mask.surfaceBuffer
  const lowShare = index === 0 ? 0 : DEBRIS_VARIANTS[index - 1]!.share
  const highShare = variant.share

  return Fn(() => {
    const slotX = float(instanceIndex.mod(uint(DEBRIS_GRID)))
    const slotZ = float(instanceIndex.div(uint(DEBRIS_GRID)))
    const originX = floor(foliageCameraPosition.x.div(DEBRIS_CELL))
      .mul(DEBRIS_CELL).sub(half)
    const originZ = floor(foliageCameraPosition.z.div(DEBRIS_CELL))
      .mul(DEBRIS_CELL).sub(half)
    const cellX = originX.add(slotX.mul(DEBRIS_CELL))
    const cellZ = originZ.add(slotZ.mul(DEBRIS_CELL))

    const jitter = hash22(vec2(cellX, cellZ).mul(1.317).add(41.7))
    const positionX = cellX.add(jitter.x.sub(0.5).mul(DEBRIS_CELL * 0.92))
    const positionZ = cellZ.add(jitter.y.sub(0.5).mul(DEBRIS_CELL * 0.92))

    // The camera's height above the ground here, not its world Y. See the same
    // correction in `FoliagePopulation`: measuring from sea level puts every
    // twig on a hillside past the debris range, so a forest floor eighty metres
    // up carries no sticks, cones or stones at all.
    const groundY = ground.sampleHeight(positionX, positionZ).toVar('debrisGroundY')
    const toCamera = vec3(
      positionX.sub(foliageCameraPosition.x),
      groundY.sub(foliageCameraPosition.y),
      positionZ.sub(foliageCameraPosition.z),
    )
    const distance = toCamera.length()
    const fade = smoothstep(
      float(DEBRIS_RANGE),
      float(DEBRIS_RANGE - DEBRIS_FADE),
      distance,
    )

    If(fade.greaterThan(0.02), () => {
      // Which variant this slot would carry, if it carries anything. Drawn
      // once per slot from a hash that does not depend on the variant, so the
      // three kernels partition the same slots rather than competing for them
      // — two sticks never end up in the same place.
      const kind = hash21(vec2(positionZ, positionX).mul(2.11).add(3.77))
      const mine = step(float(lowShare), kind).mul(step(kind, float(highShare)))

      // Debris collects where litter does. A meadow has none of this, and the
      // gate is the painted ground layer rather than a constant, so clearing
      // the litter with the eraser clears the sticks lying on it too.
      const maskU = positionX.sub(maskOrigin.x).div(maskField).add(0.5)
      const maskV = positionZ.sub(maskOrigin.y).div(maskField).add(0.5)
      const inField = step(0, maskU).mul(step(maskU, 1))
        .mul(step(0, maskV)).mul(step(maskV, 1))
      const column = clamp(floor(maskU.mul(maskResolution)), 0, maskResolution - 1)
      const row = clamp(floor(maskV.mul(maskResolution)), 0, maskResolution - 1)
      const surface: ShaderValue = surfaceBuffer.element(
        uint(row.mul(maskResolution).add(column)).mul(uint(FOLIAGE_SURFACE_ROWS)),
      )
      // Leaf litter and needle duff carry it; moss buries it; bare earth is
      // bare because something has been over it.
      const bed = clamp(surface.x.add(surface.y).sub(surface.w.mul(0.5)), 0, 1)

      // The same broad opening field the plants use, so a clearing in the
      // cover is a clearing in the debris too rather than a patch of bare
      // ground neatly strewn with sticks.
      const patchiness = smoothstep(
        0.24,
        0.62,
        valueNoise2(vec2(positionX, positionZ).mul(0.21).add(7.3)),
      ).mul(0.75).add(0.25)

      const accept = hash21(vec2(positionX, positionZ).mul(6.31).add(23.9))
      const coverage = bed.mul(inField).mul(patchiness).mul(mine).mul(0.5)

      If(accept.lessThan(coverage), () => {
        const dice = hash24(vec2(positionX.mul(1.7), positionZ.mul(2.3)))
        const length = float(variant.length[0]).add(
          dice.x.mul(variant.length[1] - variant.length[0]),
        )
        const yaw = dice.y.mul(6.28318)
        // Never quite flat: one end is always propped on something.
        const roll = dice.z.sub(0.5).mul(0.5)

        const centre = vec3(positionX, length.mul(0.2), positionZ)
        const radius = length.mul(0.7).add(0.4)
        const visible = float(1).toVar('debrisVisible')
        for (let plane = 0; plane < 6; plane += 1) {
          const boundary = foliageFrustumPlanes.element(plane) as ShaderValue
          visible.mulAssign(
            step(0, boundary.xyz.dot(centre).add(boundary.w).add(radius)),
          )
        }

        If(visible.greaterThan(0.5), () => {
          const slot: ShaderValue = atomicAdd(indirect.element(uint(1)), uint(1))
          If(slot.lessThan(uint(DEBRIS_CAPACITY)), () => {
            const base = slot.add(uint(offset)).mul(uint(2))
            instances
              .element(base)
              .assign(vec4(positionX, groundY, positionZ, yaw))
            instances
              .element(base.add(uint(1)))
              .assign(vec4(length.mul(fade), roll, dice.w, bed))
          })
        })
      })
    })
  })().compute(DEBRIS_CAPACITY)
}

function createDebrisMaterial(
  reader: ShaderValue,
  mask: FoliageMaskField,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial()
  material.name = 'forest floor debris'
  material.metalness = 0
  material.roughness = 0.85

  const meta = attribute('debrisMeta', 'vec2')
  const slot = uint(meta.x).add(instanceIndex).mul(uint(2))
  const placement = reader.element(slot).toVar('debrisPlacement')
  const traits = reader.element(slot.add(uint(1))).toVar('debrisTraits')

  const anchor = placement.xyz
  const yaw = placement.w
  const size = traits.x
  const roll = traits.y
  const seed = traits.z
  const woodiness = meta.y

  // Local space is authored lying along X with a unit length, so the whole
  // transform is a scale, a roll about the long axis and a yaw about up.
  const scaled = positionGeometry.mul(size)
  const rolled = vec3(
    scaled.x,
    scaled.y.mul(cos(roll)).sub(scaled.z.mul(sin(roll))),
    scaled.y.mul(sin(roll)).add(scaled.z.mul(cos(roll))),
  )
  const turn = (value: ShaderValue): ShaderValue => vec3(
    value.x.mul(cos(yaw)).sub(value.z.mul(sin(yaw))),
    value.y,
    value.x.mul(sin(yaw)).add(value.z.mul(cos(yaw))),
  )
  // Lifted by its own half-thickness so it rests on the litter rather than
  // being buried to its axis, and dropped a little so it beds into it.
  const world = turn(rolled).add(anchor).add(vec3(0, size.mul(0.021), 0))

  const rolledNormal = vec3(
    normalGeometry.x,
    normalGeometry.y.mul(cos(roll)).sub(normalGeometry.z.mul(sin(roll))),
    normalGeometry.y.mul(sin(roll)).add(normalGeometry.z.mul(cos(roll))),
  )
  const worldNormal = normalize(turn(rolledNormal))

  // Colour. Weathered wood is a grey-brown that has lost almost all its
  // saturation; a stone is a cooler grey with a hint of the local mineral.
  const wood = mix(
    vec3(0.052, 0.038, 0.026),
    vec3(0.104, 0.086, 0.062),
    seed,
  )
  const stone = mix(
    vec3(0.062, 0.062, 0.058),
    vec3(0.126, 0.124, 0.116),
    seed,
  )
  const body = mix(stone, wood, woodiness)

  // Moss grows on the upper faces of anything that has been lying still, and
  // this is where the ground layer earns its keep twice: the same painted moss
  // that greens the floor greens the sticks on it, so the two never disagree.
  const fieldUv = positionWorld.xz
    .sub(mask.origin)
    .div(mask.fieldSize)
    .add(0.5)
  const mossWeight: ShaderValue = texture(mask.surfaces[0]!, fieldUv).z
  const upward = clamp(worldNormal.y, 0, 1)
  const mossPatch = smoothstep(0.35, 0.75, valueNoise2(positionWorld.xz.mul(4.6)))
  const mossed = clamp(mossWeight.mul(upward).mul(mossPatch).mul(0.85), 0, 1)
  const albedo = mix(body, vec3(0.05, 0.098, 0.042), mossed)

  material.positionNode = world
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(worldNormal, 0)).xyz)
  material.colorNode = vec4(albedo, 1)
  material.roughnessNode = clamp(
    mix(float(0.62), float(0.92), woodiness).sub(mossed.mul(0.12)),
    0.3,
    1,
  )
  material.metalnessNode = float(0)
  return material
}

/** One reset and one populate dispatch per variant, in that order. */
export function runFoliageDebris(
  renderer: Renderer,
  field: FoliageDebrisField,
): void {
  for (const node of field.reset) renderer.compute(node)
  for (const node of field.populate) renderer.compute(node)
}
