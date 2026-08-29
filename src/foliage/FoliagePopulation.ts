import {
  BufferGeometry,
  IndirectStorageBufferAttribute,
  Mesh,
  type Material,
  type Renderer,
} from 'three/webgpu'
import type ComputeNode from 'three/src/nodes/gpgpu/ComputeNode.js'
import {
  Fn,
  If,
  atomicAdd,
  atomicStore,
  clamp,
  float,
  floor,
  instanceIndex,
  instancedArray,
  int,
  max,
  min,
  mix,
  smoothstep,
  sqrt,
  step,
  storage,
  uint,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { createFoliageClumpGeometry } from './foliageClumpGeometry'
import type { FoliageMaskField } from './FoliageMaskField'
import { fbm2, hash21, hash22, valueNoise2 } from './foliageNoise'
import {
  foliageCameraPosition,
  foliageDensity,
  foliageFrustumPlanes,
} from './foliageRuntime'
import { FOLIAGE_MASK_ROWS } from './foliageSpecies'
import {
  FOLIAGE_DENSITY_SCALES,
  foliageSpeciesRow,
} from './foliageSpeciesUniforms'

/**
 * TSL node graphs are far more permissive than the published type surface,
 * which models each node by its declared output type. Storage element access,
 * atomics and uniform-array indexing all land outside that model. Naming the
 * escape hatch once is clearer than scattering `as any` through the kernel.
 */
type ShaderValue = any

export interface FoliageRingConfig {
  name: string
  /** Metres between candidate slots. One clump may stand in each. */
  cell: number
  /** Candidate slots along one side of the camera-anchored grid. */
  grid: number
  /** Metres from the camera at which this ring starts and stops. */
  inner: number
  outer: number
  /** Metres over which clumps grow in at the inner edge and shrink out at the outer. */
  fadeIn: number
  fadeOut: number
  /**
   * Blade width multiplier, and the reason the rings are not visibly different
   * densities.
   *
   * The quantity that has to stay constant across rings is `blades per square
   * metre × blade width` — that product is what the eye reads as how thick the
   * sward is. A ring is coarser than the one inside it in two ways at once: its
   * cells are further apart, and it draws fewer segments per blade. It pays
   * that back in two ways as well: more blades in each clump, and wider blades.
   *
   * Width alone cannot do it. Compensating a six-fold cell ratio purely by
   * widening gives metre-wide blades that read as slabs. Compensating purely
   * by blade count throws the triangle budget away on geometry nobody can
   * resolve. Each ring below therefore raises its blade count until the
   * remaining shortfall is a width multiplier small enough to stay invisible,
   * and the comment on each ring records the blades per square metre it
   * actually achieves so the ratios can be checked rather than trusted.
   */
  widthBoost: number
  heightBoost: number
  blades: number
  segments: number
  /**
   * Metres the blades of one clump scatter over.
   *
   * Scaled to the ring's cell, so twenty blades in a coarse cell spread across
   * it instead of standing in a spike with bare ground between spikes.
   */
  spread: number
}

/**
 * Three concentric candidate grids, from a dense near field to a coarse far one.
 *
 * The bands overlap slightly and each ring scales its clumps in and out across
 * its overlap, so a blade never appears or vanishes in one frame — it grows.
 * That is cheaper and steadier than dithered cross-fading and it survives
 * temporal antialiasing, which stochastic LOD does not.
 */
export const FOLIAGE_RINGS: readonly FoliageRingConfig[] = [
  {
    name: 'near',
    cell: 0.22,
    grid: 150,
    inner: 0,
    outer: 16,
    fadeIn: 0,
    fadeOut: 4,
    blades: 5,
    segments: 4,
    // 5 blades per 0.0484 m² — 103 blades per square metre, the reference every
    // other ring's width multiplier is calibrated against.
    widthBoost: 1,
    heightBoost: 1,
    spread: 0.1,
  },
  {
    name: 'mid',
    cell: 0.62,
    grid: 164,
    inner: 12,
    outer: 50,
    fadeIn: 4,
    fadeOut: 14,
    blades: 11,
    segments: 2,
    // 28.6 blades per square metre. 103 / 28.6 = 3.6.
    widthBoost: 3.6,
    heightBoost: 1.06,
    spread: 0.27,
  },
  {
    name: 'far',
    cell: 1.4,
    grid: 222,
    inner: 36,
    outer: 155,
    fadeIn: 14,
    fadeOut: 37,
    blades: 28,
    segments: 1,
    // 14.3 blades per square metre. 103 / 14.3 = 7.2. Twenty-eight single-quad
    // blades in one clump is two triangles each: at this range the per-instance
    // cost dominates, so blades are the cheap half of the coverage budget and
    // width is the expensive one — a wide blade is a visible slab long before a
    // numerous one is a cost.
    widthBoost: 7.2,
    heightBoost: 1.16,
    spread: 0.6,
  },
  {
    name: 'horizon',
    cell: 3,
    grid: 178,
    inner: 118,
    outer: 262,
    fadeIn: 37,
    fadeOut: 62,
    blades: 40,
    segments: 1,
    // 4.4 blades per square metre. 103 / 4.4 = 23.4. In world units that is a
    // seventeen-centimetre blade, which sounds absurd until you note that this
    // ring never draws anything closer than a hundred and eighteen metres,
    // where it is a single pixel across.
    widthBoost: 23.4,
    heightBoost: 1.2,
    spread: 1.25,
  },
]

/** The metre at which instanced blades have fully given way to the ground canopy. */
export const FOLIAGE_INSTANCED_RANGE =
  FOLIAGE_RINGS[FOLIAGE_RINGS.length - 1].outer

const createInstanceBuffer = (capacity: number) =>
  instancedArray(capacity * 2, 'vec4')
export type FoliageInstanceBuffer = ReturnType<typeof createInstanceBuffer>

/** Slots reserved across every ring, and where each ring's slice starts. */
export const FOLIAGE_RING_OFFSETS = ((): number[] => {
  const offsets: number[] = []
  let next = 0
  for (const ring of FOLIAGE_RINGS) {
    offsets.push(next)
    next += ring.grid * ring.grid
  }
  return offsets
})()

export const FOLIAGE_INSTANCE_CAPACITY = FOLIAGE_RINGS.reduce(
  (total, ring) => total + ring.grid * ring.grid,
  0,
)

/**
 * One instance buffer for every ring.
 *
 * Each ring owns a disjoint slice and each ring's geometry carries the offset
 * of that slice as a constant vertex attribute, so all three levels of detail
 * are drawn by a single material and compile to a single pipeline. Three
 * near-identical materials would triple the shader compilation the editor has
 * to finish before it dares submit a frame, for no visual difference at all.
 */
export function createFoliageInstanceBuffer(): FoliageInstanceBuffer {
  return createInstanceBuffer(FOLIAGE_INSTANCE_CAPACITY)
}

const createInstanceReader = (buffer: FoliageInstanceBuffer) =>
  storage(
    (buffer as ShaderValue).value,
    'vec4',
    FOLIAGE_INSTANCE_CAPACITY * 2,
  ).toReadOnly()
export type FoliageInstanceReader = ReturnType<typeof createInstanceReader>

/**
 * A read-only view of the same buffer, for the vertex stage.
 *
 * WGSL will not bind a `read_write` storage buffer to a vertex shader at all,
 * so the compute pass and the draw cannot share one node. Two nodes over the
 * same attribute resolve to the same GPU buffer with two access declarations,
 * which is precisely what the restriction is asking for.
 */
export function createFoliageInstanceReader(
  buffer: FoliageInstanceBuffer,
): FoliageInstanceReader {
  return createInstanceReader(buffer)
}

export interface FoliageRing {
  config: FoliageRingConfig
  capacity: number
  offset: number
  geometry: BufferGeometry
  mesh: Mesh
  populate: ComputeNode
  reset: ComputeNode
}

/**
 * GPU-resident placement.
 *
 * Every frame each ring re-derives its whole clump list from the camera
 * position and the painted mask, appends the survivors into a compacted
 * buffer with an atomic, and draws exactly that many instances through an
 * indirect draw. Nothing is read back, nothing is streamed, and no placement
 * state persists between frames — a clump's position, lean, hue and phase are
 * all functions of the world cell it stands in, so the grid can slide under a
 * moving camera without anything shifting.
 */
export function createFoliageRings(
  mask: FoliageMaskField,
  instances: FoliageInstanceBuffer,
  material: Material,
): FoliageRing[] {
  return FOLIAGE_RINGS.map((config, index) =>
    createFoliageRing(config, FOLIAGE_RING_OFFSETS[index], mask, instances, material),
  )
}

function createFoliageRing(
  config: FoliageRingConfig,
  offset: number,
  mask: FoliageMaskField,
  instances: FoliageInstanceBuffer,
  material: Material,
): FoliageRing {
  const capacity = config.grid * config.grid
  const geometry = createFoliageClumpGeometry({
    blades: config.blades,
    segments: config.segments,
    ringOffset: offset,
    spread: config.spread,
  })

  const indexCount = (geometry.getIndex()?.count ?? 0)
  const indirectAttribute = new IndirectStorageBufferAttribute(
    new Uint32Array([indexCount, 0, 0, 0, 0]),
    5,
  )
  indirectAttribute.name = `foliage-indirect-${config.name}`
  geometry.setIndirect(indirectAttribute)
  const indirect: ShaderValue = storage(indirectAttribute, 'uint', 5).toAtomic()

  const mesh = new Mesh(geometry, material)
  mesh.name = `foliage-${config.name}`
  // The population kernel writes world-space positions, so the mesh must not
  // add a transform of its own. Culling is likewise already done — per clump,
  // in the kernel — and three culling the whole ring against a bounding sphere
  // it cannot know would only ever be wrong.
  mesh.matrixAutoUpdate = false
  mesh.frustumCulled = false
  mesh.receiveShadow = true
  mesh.castShadow = false
  mesh.renderOrder = 2

  const reset = Fn(() => {
    atomicStore(indirect.element(uint(1)), uint(0))
  })().compute(1)

  const populate = createPopulateKernel(
    config,
    capacity,
    offset,
    mask,
    instances,
    indirect,
  )

  return { config, capacity, offset, geometry, mesh, populate, reset }
}

function createPopulateKernel(
  config: FoliageRingConfig,
  capacity: number,
  ringOffset: number,
  mask: FoliageMaskField,
  instances: FoliageInstanceBuffer,
  indirect: ShaderValue,
): ComputeNode {
  const { cell, grid, inner, outer, fadeIn, fadeOut } = config
  const half = (grid * cell) / 2
  const maskResolution = mask.resolution
  const maskField = mask.fieldSize
  const maskBuffer = mask.buffer
  const scales = FOLIAGE_DENSITY_SCALES

  return Fn(() => {
    const slotX = float(instanceIndex.mod(uint(grid)))
    const slotZ = float(instanceIndex.div(uint(grid)))

    // Anchoring the grid to a whole number of cells is what keeps a clump
    // standing still. The candidate's world position is a function of its cell
    // alone, so a camera that moves half a cell does not drag the meadow with
    // it — it simply retires slots off one edge and introduces them on the
    // other, already carrying the randomness that cell has always had.
    const originX = floor(foliageCameraPosition.x.div(cell)).mul(cell).sub(half)
    const originZ = floor(foliageCameraPosition.z.div(cell)).mul(cell).sub(half)
    const cellX = originX.add(slotX.mul(cell))
    const cellZ = originZ.add(slotZ.mul(cell))

    const jitter = hash22(vec2(cellX, cellZ).mul(0.917).add(11.3))
    const positionX = cellX.add(jitter.x.sub(0.5).mul(cell * 0.94))
    const positionZ = cellZ.add(jitter.y.sub(0.5).mul(cell * 0.94))

    // Distance in three dimensions, not across the ground.
    //
    // Level of detail is about how large something lands on screen, and a
    // camera fifty metres up is fifty metres from the clump directly beneath
    // it. Selecting rings by horizontal distance alone put that clump in the
    // finest ring — full near-field density under an aerial view — while
    // everything the viewer was actually looking at fell into the coarsest one.
    const toCamera = vec3(
      positionX.sub(foliageCameraPosition.x),
      foliageCameraPosition.y.negate(),
      positionZ.sub(foliageCameraPosition.z),
    )
    const distance = toCamera.length()

    // Each ring's inner fade band is exactly the previous ring's outer fade
    // band, so the two shares always sum to one. What the clump is scaled by
    // is therefore the *square root* of its share: a clump scaled to s covers
    // s² of the ground, and s₁² + s₂² = 1 is the only way the pair adds up to
    // the coverage of either one alone. Scaling by the share itself — the
    // obvious thing — leaves each overlap band at half the density of the
    // rings either side of it, which is a visible thinning ring around the
    // camera at exactly the distance the eye is drawn to.
    const outerShare = smoothstep(float(outer), float(outer - fadeOut), distance)
    const share = inner > 0
      ? smoothstep(float(inner), float(inner + fadeIn), distance).mul(outerShare)
      : outerShare
    const fade = sqrt(share)

    If(share.greaterThan(0.0004), () => {
      // Nudging the mask lookup by a fraction of a texel and then point
      // sampling gives a ragged, dithered species boundary for two loads.
      // Bilinear filtering would cost four times as much and produce a smooth
      // gradient — which is exactly what a real ecotone does not look like.
      const blur = hash22(vec2(positionX, positionZ).mul(2.71).add(53.1))
      const texel = maskField / maskResolution
      const sampleX = positionX.add(blur.x.sub(0.5).mul(texel * 1.7))
      const sampleZ = positionZ.add(blur.y.sub(0.5).mul(texel * 1.7))
      const maskU = sampleX.div(maskField).add(0.5)
      const maskV = sampleZ.div(maskField).add(0.5)
      const inField = step(0, maskU)
        .mul(step(maskU, 1))
        .mul(step(0, maskV))
        .mul(step(maskV, 1))

      const column = clamp(floor(maskU.mul(maskResolution)), 0, maskResolution - 1)
      const row = clamp(floor(maskV.mul(maskResolution)), 0, maskResolution - 1)
      const maskIndex = uint(row.mul(maskResolution).add(column))
        .mul(uint(FOLIAGE_MASK_ROWS))
      // Species weights, already scaled by each one's clump abundance so a
      // brush at full strength lays the right number of ferns and the right
      // number of fescue tufts rather than the same count of both.
      const weighted: ShaderValue[] = []
      for (let maskRow = 0; maskRow < FOLIAGE_MASK_ROWS; maskRow += 1) {
        const scaleRow = vec4(
          scales[maskRow * 4] ?? 0,
          scales[maskRow * 4 + 1] ?? 0,
          scales[maskRow * 4 + 2] ?? 0,
          scales[maskRow * 4 + 3] ?? 0,
        )
        weighted.push(maskBuffer.element(maskIndex.add(uint(maskRow))).mul(scaleRow))
      }

      // Running sums, one per species boundary. The last is the total.
      const cumulative: ShaderValue[] = []
      let running: ShaderValue | null = null
      for (const group of weighted) {
        for (const channel of ['x', 'y', 'z', 'w'] as const) {
          running = running === null ? group[channel] : running.add(group[channel])
          cumulative.push(running)
        }
      }
      const total = cumulative[cumulative.length - 1]!.mul(inField)

      const draw = hash21(vec2(positionX, positionZ).mul(5.13).add(97.7))
      const pick = draw.mul(total)
      // Branchless weighted choice: the index is simply how many cumulative
      // thresholds the draw cleared.
      let speciesFloat: ShaderValue = step(cumulative[0]!, pick)
      for (let i = 1; i < cumulative.length - 1; i += 1) {
        speciesFloat = speciesFloat.add(step(cumulative[i]!, pick))
      }
      const species = int(min(speciesFloat, float(scales.length - 1)))

      const accept = hash21(vec2(positionZ, positionX).mul(3.37).add(7.91))

      // Clumping, gaps and breaks.
      //
      // A painted weight says how much of a plant belongs in a cell, and the
      // mask's cell is 0.78 metres. Spending that weight evenly — which is
      // what a bare `weight × density` acceptance does — gives a floor whose
      // every square metre carries the same fraction of everything, and no
      // real ground is like that at any scale. Two fields fix it, and both are
      // functions of position alone so nothing swims as the grid slides.
      //
      // The first is per species: a patch field at the species' own scale,
      // mixed in by its own `clumping`. A moss mat is barely touched by it; a
      // bracken stand is almost entirely decided by it, which is what turns a
      // painted weight of 0.5 from "half as many fronds everywhere" into "a
      // continuous stand here and nothing there".
      //
      // The second applies to everything at once: the openings. A closed floor
      // still has bare patches a couple of metres across where a root plate,
      // a rotting log or simply the drip line has kept the cover off, and it
      // is those interruptions — not the plants — that read as forest rather
      // than as lawn.
      const row6 = foliageSpeciesRow(species, 6)
      const patchScale = max(row6.y, float(0.5))
      const patchField = fbm2(
        vec2(positionX, positionZ)
          .div(patchScale)
          .add(vec2(float(species).mul(31.7), float(species).mul(17.3))),
      )
      // 1.9 rather than 1: the smoothstep's mean over an fbm is close to a
      // half, and a multiplier that did not put it back would quietly halve
      // the density of every clumping species relative to what was painted.
      const patchiness = mix(
        float(1),
        smoothstep(0.3, 0.66, patchField).mul(1.9),
        clamp(row6.x, 0, 1),
      )
      const opening = smoothstep(
        0.08,
        0.3,
        valueNoise2(vec2(positionX, positionZ).mul(0.055).add(19.7)),
      ).mul(0.78).add(0.22)

      const coverage = clamp(total, 0, 1)
        .mul(foliageDensity)
        .mul(patchiness)
        .mul(opening)

      If(accept.lessThan(coverage), () => {
        const variation: ShaderValue = hash21(vec2(cellX, cellZ).mul(1.61).add(311.7))
        const row0 = foliageSpeciesRow(species, 0)
        const row1 = foliageSpeciesRow(species, 1)

        const heightScale: ShaderValue = float(1)
          .add(variation.sub(0.5).mul(row0.y).mul(2))
          .mul(config.heightBoost)
          .mul(fade)
        const height = row0.x.mul(heightScale)
        const widthScale: ShaderValue = float(0.82)
          .add(jitter.x.mul(0.36))
          .mul(config.widthBoost)
          .mul(fade)

        // Sphere-versus-frustum in world space, with a margin that absorbs the
        // single frame of latency between the CPU publishing the planes and
        // this dispatch reading them. Grass that pops in at the very edge of
        // the screen is worse than grass that is culled a metre late.
        const centre = vec3(positionX, height.mul(0.5), positionZ)
        const radius = height.mul(0.62).add(row1.y).add(cell * 0.6).add(1.5)
        const visible = float(1).toVar('foliageVisible')
        for (let plane = 0; plane < 6; plane += 1) {
          const boundary = foliageFrustumPlanes.element(plane) as ShaderValue
          visible.mulAssign(
            step(0, boundary.xyz.dot(centre).add(boundary.w).add(radius)),
          )
        }

        If(visible.greaterThan(0.5), () => {
          const slot: ShaderValue = atomicAdd(indirect.element(uint(1)), uint(1))
          If(slot.lessThan(uint(capacity)), () => {
            const yaw = hash21(vec2(cellZ, cellX).mul(8.71).add(13.9)).mul(6.28318)
            const base = slot.add(uint(ringOffset)).mul(uint(2))
            instances
              .element(base)
              .assign(vec4(positionX, 0, positionZ, yaw))
            // Species and local coverage share a lane: the integer part names
            // the plant, the fraction records how thickly the mask says it is
            // growing here. The material needs both and neither justifies a
            // third vec4 across fifty thousand instances.
            const packedSpecies = float(species).add(
              clamp(total, 0, 0.985).mul(0.985),
            )
            instances
              .element(base.add(uint(1)))
              .assign(vec4(heightScale, widthScale, packedSpecies, variation))
          })
        })
      })
    })
  })().compute(capacity)
}

/** One reset and one populate dispatch per ring, in that order. */
export function runFoliagePopulation(
  renderer: Renderer,
  rings: readonly FoliageRing[],
): void {
  for (const ring of rings) renderer.compute(ring.reset)
  for (const ring of rings) renderer.compute(ring.populate)
}

export function disposeFoliageRings(rings: readonly FoliageRing[]): void {
  for (const ring of rings) ring.geometry.dispose()
}
