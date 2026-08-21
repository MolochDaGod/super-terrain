import {
  addAt,
  at,
  createField,
  type Field,
  fillField,
  wrapIndex,
} from './field'
import { clamp01, fbm, hashInt, makeRng, mix, smoothstep, worley } from './noise'

/**
 * Building blocks shared by the rock recipes.
 *
 * Each function models one physical process — clastic deposition, jointing,
 * bedding, mineral segregation — rather than one noise trick, so the recipes
 * read as geology and the results stay correlated across the maps.
 */

export interface ClastOptions {
  /** Clasts placed per tile. */
  count: number
  /** Radius range in pixels. */
  minRadius: number
  maxRadius: number
  /** Power-law exponent for the size distribution; >1 favours small clasts. */
  sizeBias?: number
  /** How far a clast pokes out of the matrix, as a fraction of its radius. */
  protrusion?: number
  /** Elongation range; 1 is equant. */
  minAspect?: number
  maxAspect?: number
  /** 0 rounds the clast, 1 makes it a flat-topped angular chip. */
  angularity?: number
  /**
   * Number of fracture planes truncating each fragment. Rock breaks along
   * flat surfaces, so a broken chip has straight edges and facets; without
   * them a scatter of ellipsoids reads unmistakably as beans.
   */
  facets?: number
  seed: number
}

export interface ClastResult {
  /** Height contribution, in the same units as the matrix. */
  height: Field
  /** Coverage mask in [0,1]. */
  mask: Field
  /** Per-clast random value in [0,1], for mineral assignment. */
  id: Field
  /** Distance from the clast edge, normalised; 1 at the centre. */
  core: Field
}

/**
 * Scatters ellipsoidal clasts with a power-law size distribution.
 *
 * Real scree and conglomerate grade continuously from cobbles to grit, and
 * the size histogram is close to a power law. Sampling that distribution and
 * compositing by height (rather than blending) reproduces the way small
 * fragments pack into the gaps between larger ones, including the occlusion
 * contacts between them.
 */
export function scatterClasts(size: number, options: ClastOptions): ClastResult {
  const height = createField(size)
  const mask = createField(size)
  const id = createField(size)
  const core = createField(size)
  const rng = makeRng(options.seed)
  const sizeBias = options.sizeBias ?? 2.2
  const protrusion = options.protrusion ?? 0.55
  const minAspect = options.minAspect ?? 1
  const maxAspect = options.maxAspect ?? 1.6
  const angularity = options.angularity ?? 0.35

  for (let c = 0; c < options.count; c += 1) {
    const t = Math.pow(rng(), sizeBias)
    const radius = mix(options.maxRadius, options.minRadius, t)
    const aspect = mix(minAspect, maxAspect, rng())
    const angle = rng() * Math.PI * 2
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const cx = rng() * size
    const cy = rng() * size
    const clastId = rng()
    const peak = radius * protrusion * mix(0.7, 1.25, rng())
    // Faceting: an angular fragment has a flattened crown and steeper sides.
    const shape = mix(0.5, 1.6, rng())
    // Angularity varies clast to clast: a lag mixes freshly broken chips with
    // fragments that have been rounded by transport, and giving every clast
    // the same profile is what makes a scatter read as one repeated bean.
    const clastAngularity = clamp01(angularity * mix(0.35, 1.5, rng()))
    // Irregular outline. An ellipse is the wrong silhouette for anything but
    // a well-rounded river cobble; lobing the rim per clast gives the broken,
    // asymmetric outline that a fragment actually has.
    const lobeCount = 2 + Math.floor(rng() * 4)
    const lobePhase = rng() * Math.PI * 2
    const lobeDepth = mix(0.05, 0.28, rng())
    const ra = radius * aspect
    const rb = radius / aspect
    const reach = Math.ceil(Math.max(ra, rb)) + 1
    const ix = Math.round(cx)
    const iy = Math.round(cy)

    // Fracture planes truncating this fragment.
    const facetCount = Math.round(mix(0, options.facets ?? 3, rng()))
    const facetCos: number[] = []
    const facetSin: number[] = []
    const facetDistance: number[] = []
    for (let f = 0; f < facetCount; f += 1) {
      const fa = rng() * Math.PI * 2
      facetCos.push(Math.cos(fa))
      facetSin.push(Math.sin(fa))
      facetDistance.push(mix(0.3, 0.9, rng()))
    }

    for (let oy = -reach; oy <= reach; oy += 1) {
      for (let ox = -reach; ox <= reach; ox += 1) {
        const px = ix + ox - cx
        const py = iy + oy - cy
        const lx = (px * cos + py * sin) / ra
        const ly = (-px * sin + py * cos) / rb
        const d2 = lx * lx + ly * ly
        if (d2 >= 1) continue
        const lobe = 1 + Math.sin(Math.atan2(ly, lx) * lobeCount + lobePhase) * lobeDepth
        const d = Math.sqrt(d2) / lobe
        if (d >= 1) continue
        // Superelliptic profile: `angularity` pushes the crown flat and the
        // flank vertical, turning a pebble into a broken chip.
        const rounded = Math.sqrt(1 - d2)
        const flat = Math.pow(1 - Math.pow(d, 2 + shape * 4), 0.7)
        let profile = mix(rounded, flat, clastAngularity)
        // Clip against each fracture plane. The clip is applied in the
        // fragment's own frame, so the resulting straight edges are as
        // elongated as the fragment is.
        for (let f = 0; f < facetCount; f += 1) {
          const t = lx * facetCos[f]! + ly * facetSin[f]!
          if (t > facetDistance[f]!) {
            profile -= (t - facetDistance[f]!) * 2.4
            if (profile <= 0) break
          }
        }
        if (profile <= 0) continue
        const h = profile * peak
        const gx = wrapIndex(ix + ox, size)
        const gy = wrapIndex(iy + oy, size)
        const index = gy * size + gx
        if (h > height.data[index]!) {
          height.data[index] = h
          id.data[index] = clastId
          core.data[index] = 1 - d
        }
        const cover = smoothstep(0.98, 0.86, d)
        if (cover > mask.data[index]!) mask.data[index] = cover
      }
    }
  }

  return { height, mask, id, core }
}

export interface JointOptions {
  /** Cells across the tile along the joint-normal direction. */
  period: number
  /** Cell elongation; >1 stretches blocks horizontally. */
  aspect?: number
  /** Cell centre jitter in [0,1]. */
  jitter?: number
  /** Joint width in cell units. */
  width?: number
  /** Amplitude of the wander applied to the joint traces, in pixels. */
  wander?: number
  wanderPeriod?: number
  /** Rotation of the whole network, radians. */
  rotation?: number
  seed: number
}

export interface JointResult {
  /** 1 inside a joint, 0 on intact rock. */
  groove: Field
  /** Per-block random value in [0,1]. */
  block: Field
  /** Distance to the nearest joint in pixels, clamped. */
  distance: Field
}

/**
 * A jointed block network.
 *
 * Brittle rock fails along intersecting joint sets, and the blocks between
 * them move independently — that is why a real cliff face is a mosaic of
 * offset facets rather than a continuously undulating surface. The traces are
 * domain-warped so they wander like fractures instead of following the cell
 * lattice.
 */
export function jointNetwork(size: number, options: JointOptions): JointResult {
  const groove = createField(size)
  const block = createField(size)
  const distance = createField(size)
  const aspect = options.aspect ?? 1
  const jitter = options.jitter ?? 0.85
  const width = options.width ?? 0.035
  const wander = options.wander ?? size / 48
  const wanderPeriod = options.wanderPeriod ?? 6
  const rotation = options.rotation ?? 0
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const cellsPerPixel = options.period / size

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size
      const v = y / size
      const wx =
        x + fbm(u * wanderPeriod, v * wanderPeriod, wanderPeriod, options.seed + 11) * wander
      const wy =
        y + fbm(u * wanderPeriod, v * wanderPeriod, wanderPeriod, options.seed + 29) * wander
      const rx = wx * cos - wy * sin
      const ry = wx * sin + wy * cos
      const w = worley(rx * cellsPerPixel, ry * cellsPerPixel, options.period, options.seed, jitter, aspect)
      const edge = w.f2 - w.f1
      const index = y * size + x
      groove.data[index] = 1 - smoothstep(0, width, edge)
      block.data[index] = (w.id & 0xffff) / 65536
      distance.data[index] = Math.min(1, edge / width)
    }
  }
  return { groove, block, distance }
}

/**
 * Sedimentary bedding: a stack of layers of varying thickness, each with an
 * index the shading stage can use to give it its own lithology.
 */
export function beddingField(
  size: number,
  layers: number,
  seed: number,
  options: { wander?: number; wanderPeriod?: number; dip?: number } = {},
): { index: Field; phase: Field } {
  const index = createField(size)
  const phase = createField(size)
  const wander = options.wander ?? 0.02
  const wanderPeriod = options.wanderPeriod ?? 4
  const dip = options.dip ?? 0
  // Irregular bed thicknesses come from a random walk over the bed boundaries.
  const rng = makeRng(seed)
  const thickness: number[] = []
  let total = 0
  for (let i = 0; i < layers; i += 1) {
    const t = mix(0.45, 1.9, Math.pow(rng(), 1.6))
    thickness.push(t)
    total += t
  }
  const boundaries: number[] = [0]
  let acc = 0
  for (let i = 0; i < layers; i += 1) {
    acc += thickness[i]! / total
    boundaries.push(acc)
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size
      const v = y / size
      const warped =
        v +
        dip * (u - 0.5) +
        fbm(u * wanderPeriod, v * wanderPeriod, wanderPeriod, seed + 5, { octaves: 3 }) * wander
      const t = warped - Math.floor(warped)
      // Binary search would be overkill for a few dozen beds.
      let bed = 0
      while (bed < layers - 1 && t >= boundaries[bed + 1]!) bed += 1
      const lo = boundaries[bed]!
      const hi = boundaries[bed + 1]!
      const i = y * size + x
      index.data[i] = bed
      phase.data[i] = (t - lo) / Math.max(1e-6, hi - lo)
    }
  }
  return { index, phase }
}

/**
 * Thin, closely spaced cleavage laminae — the fissility of slate and shale.
 *
 * Modelled as a warped sawtooth so each lamina terminates with a sharp step
 * rather than a symmetric groove, which is how split rock actually looks.
 */
export function laminaeField(
  size: number,
  count: number,
  seed: number,
  options: {
    wander?: number
    sharpness?: number
    dip?: number
    /**
     * Per-pixel phase shift in laminae. Passing a per-block value offsets the
     * layering across every fracture, which is what a displaced block
     * actually does and what stops the lamination reading as a ruled grid
     * drawn over the whole wall.
     */
    offset?: Field
    /** Per-pixel spacing multiplier; varies how finely the rock splits. */
    spacing?: Field
  } = {},
): { step: Field; index: Field } {
  const wander = options.wander ?? 0.9
  const sharpness = options.sharpness ?? 0.14
  const dip = options.dip ?? 0
  const offset = options.offset
  const spacing = options.spacing
  const step = createField(size)
  const index = createField(size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size
      const v = y / size
      const warp =
        fbm(u * 5, v * 5, 5, seed, { octaves: 4, stretchX: 3 }) * (wander / count) +
        fbm(u * 19, v * 19, 19, seed + 3, { octaves: 3, stretchX: 4 }) * (wander / count) * 0.35
      const i0 = y * size + x
      const localCount = spacing ? count * (0.6 + spacing.data[i0]! * 0.8) : count
      const t =
        (v + dip * (u - 0.5) + warp) * localCount + (offset ? offset.data[i0]! * 3.7 : 0)
      const lamina = Math.floor(t)
      const f = t - lamina
      const i = y * size + x
      // Sharp split at the base of each lamina, gently rising to its top.
      step.data[i] = smoothstep(0, sharpness, f) * mix(0.85, 1, f)
      index.data[i] = lamina
    }
  }
  return { step, index }
}

/** Per-pixel hash in [0,1]; used for grain-scale mineral speckle. */
export function speckleField(size: number, seed: number, density = 1): Field {
  return fillField(size, (_u, _v, x, y) => {
    const h = ((Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b) ^ seed) >>> 0) / 4294967296
    return h < density ? h / density : 0
  })
}

/**
 * Crustose lichen colonies.
 *
 * Lichen grows on exposed, stable rock, spreading radially from a founding
 * point at well under a millimetre a year, so a colony is a rounded crust
 * with a lobed, slightly raised margin. Colonies are scattered rather than
 * derived from a cell lattice: a lattice clips every colony against its
 * neighbours' cell walls, leaving straight cuts that no organism makes.
 */
export function lichenField(
  size: number,
  seed: number,
  options: {
    colonies?: number
    minRadius?: number
    maxRadius?: number
    ragged?: number
  } = {},
): Field {
  const colonies = options.colonies ?? 90
  const minRadius = options.minRadius ?? size / 90
  const maxRadius = options.maxRadius ?? size / 12
  const ragged = options.ragged ?? 0.55
  const out = createField(size)
  const rng = makeRng(seed)
  for (let c = 0; c < colonies; c += 1) {
    // Colony ages are roughly exponentially distributed, so small ones
    // dominate and the occasional old one is conspicuous.
    const radius = mix(minRadius, maxRadius, Math.pow(rng(), 2.1))
    const cx = rng() * size
    const cy = rng() * size
    const lobes = 3 + Math.floor(rng() * 6)
    const phase = rng() * Math.PI * 2
    const lobeDepth = mix(0.12, 0.42, rng()) * ragged
    const strength = mix(0.55, 1, rng())
    const noiseSeed = Math.floor(rng() * 100000)
    const reach = Math.ceil(radius * 1.6) + 2
    const ix = Math.round(cx)
    const iy = Math.round(cy)
    for (let oy = -reach; oy <= reach; oy += 1) {
      for (let ox = -reach; ox <= reach; ox += 1) {
        const px = ix + ox - cx
        const py = iy + oy - cy
        const d = Math.hypot(px, py)
        if (d > reach) continue
        const angle = Math.atan2(py, px)
        // Lobed margin plus a fine fringe; the fringe is what makes the edge
        // read as growth rather than as a stamped circle.
        const lobe = Math.sin(angle * lobes + phase) * lobeDepth
        const fringe =
          fbm(
            (Math.cos(angle) * d) / size * 34,
            (Math.sin(angle) * d) / size * 34,
            34,
            seed + noiseSeed,
            { octaves: 4 },
          ) * ragged * 0.45
        const edge = radius * (1 + lobe + fringe)
        const value = smoothstep(edge, edge * 0.55, d) * strength
        if (value > 0) {
          const gx = wrapIndex(ix + ox, size)
          const gy = wrapIndex(iy + oy, size)
          const index = gy * size + gx
          if (value > out.data[index]!) out.data[index] = value
        }
      }
    }
  }
  return out
}

/**
 * Dry vegetation filaments: thin curved strands following a flow field.
 * Sparse by design — a few catch the light and read as dead grass, a carpet
 * of them reads as fur.
 */
export function strandField(
  size: number,
  seed: number,
  options: { clumps?: number; strandsPerClump?: number; length?: number; curl?: number } = {},
): Field {
  const clumps = options.clumps ?? 26
  const strandsPerClump = options.strandsPerClump ?? 9
  const length = options.length ?? size / 22
  const curl = options.curl ?? 1.1
  const out = createField(size)
  const rng = makeRng(seed)
  for (let c = 0; c < clumps; c += 1) {
    const ox = rng() * size
    const oy = rng() * size
    for (let s = 0; s < strandsPerClump; s += 1) {
      let px = ox + (rng() - 0.5) * length * 0.7
      let py = oy + (rng() - 0.5) * length * 0.7
      let angle = rng() * Math.PI * 2
      const bend = (rng() - 0.5) * curl
      const steps = Math.max(3, Math.round(length * mix(0.5, 1.3, rng())))
      const brightness = mix(0.5, 1, rng())
      for (let i = 0; i < steps; i += 1) {
        angle += bend / steps
        px += Math.cos(angle)
        py += Math.sin(angle)
        const taper = 1 - i / steps
        addAt(out, Math.round(px), Math.round(py), brightness * taper * 0.9)
      }
    }
  }
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = clamp01(out.data[i]!)
  return out
}

/** Reads a named field defensively; recipes share a context bag. */
export function readField(data: Record<string, Field>, name: string, index: number): number {
  const field = data[name]
  return field ? field.data[index]! : 0
}

export { at }

export interface FractureLevel {
  /** Cells across the tile. */
  period: number
  /** Cell elongation; >1 makes blocks wider than tall. */
  aspect?: number
  jitter?: number
  /** Height offset range for this level. */
  amplitude: number
  /** Facet tilt as a fraction of the amplitude. */
  tilt?: number
  rotation?: number
  /** Trace wander in pixels. */
  wander?: number
  wanderPeriod?: number
  /** Fraction of boundaries that open into a visible joint. */
  openness?: number
}

export interface FractureMosaic {
  /** Faceted height: piecewise-planar blocks with hard boundaries. */
  height: Field
  /** Random value of the finest block containing each pixel. */
  blockId: Field
  /** Random value of the coarsest block; groups fine blocks into domains. */
  domainId: Field
  /**
   * Visible joint mask: 1 in the trace of any joint that has opened at all.
   * Drives darkening and occlusion, not geometry.
   */
  joint: Field
  /**
   * Carve mask for joints that have opened wide enough to be a real slot.
   * Kept separate from `joint` on purpose: carving every trace gives each
   * one a wall tilted into the light, and a lit wall one or two pixels wide
   * reads as a bright line drawn beside every crack. Tight joints therefore
   * get darkness without geometry, and only the genuinely open ones are cut.
   */
  carve: Field
  /** Normalised distance to the nearest block boundary, 1 well inside. */
  interior: Field
}

/**
 * A hierarchical mosaic of fractured blocks.
 *
 * Real jointed rock does not have cracks drawn on a smooth surface: it is a
 * packing of rigid blocks that have each settled to a slightly different
 * depth and attitude, and the "crack" you see is the step between two
 * neighbouring faces plus whatever has weathered out of the gap. Building it
 * that way — piecewise-planar facets composited by replacement, at several
 * nested scales — is what produces the hard silhouette edges and the
 * variable-width shadow lines that a scan has and a drawn crack network never
 * does.
 */
export function fractureMosaic(
  size: number,
  levels: FractureLevel[],
  seed: number,
  /**
   * Optional structural coordinate, in tile units, replacing v for the cell
   * lookup. Passing a bedding or foliation coordinate makes every block
   * boundary honour the structure instead of cutting across it — the
   * difference between a jointed cliff and a crazed one.
   */
  coordY?: Field,
): FractureMosaic {
  const height = createField(size)
  const blockId = createField(size)
  const domainId = createField(size)
  const joint = createField(size)
  const carve = createField(size)
  const interior = createField(size, 1)

  levels.forEach((level, levelIndex) => {
    const aspect = level.aspect ?? 1
    const jitter = level.jitter ?? 0.9
    const tilt = level.tilt ?? 0.45
    const rotation = level.rotation ?? 0
    const wander = level.wander ?? size / (level.period * 6)
    const wanderPeriod = level.wanderPeriod ?? Math.max(2, Math.round(level.period / 2))
    const openness = level.openness ?? 0.5
    const levelSeed = seed + levelIndex * 7717
    const cos = Math.cos(rotation)
    const sin = Math.sin(rotation)
    const cellsPerPixel = level.period / size

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x
        const u = x / size
        const v = y / size
        // Wandering the sample point, not the cell centres, keeps the block
        // boundaries irregular at every scale without breaking the tiling.
        // Two wander scales: a broad one that makes the trace meander, and a
        // fine one that makes its edge ragged at the scale of the grains that
        // actually broke. A boundary that is smooth at pixel scale reads as a
        // vector outline no matter how irregular its overall path is.
        const fineWander = wanderPeriod * 7
        const wx =
          x +
          fbm(u * wanderPeriod, v * wanderPeriod, wanderPeriod, levelSeed + 11, { octaves: 3 }) * wander +
          fbm(u * fineWander, v * fineWander, fineWander, levelSeed + 13, { octaves: 3 }) * wander * 0.3
        const wy =
          y +
          fbm(u * wanderPeriod, v * wanderPeriod, wanderPeriod, levelSeed + 29, { octaves: 3 }) * wander +
          fbm(u * fineWander, v * fineWander, fineWander, levelSeed + 31, { octaves: 3 }) * wander * 0.3
        const sx = (wx * cos - wy * sin) * cellsPerPixel
        const sy = coordY
          ? coordY.data[i]! * level.period + (wy - y) * cellsPerPixel
          : (wx * sin + wy * cos) * cellsPerPixel

        const w = worley(sx, sy, level.period, levelSeed, jitter, aspect)
        const h = hashInt(w.id)
        const offset = ((h & 0xffff) / 65536 - 0.5) * level.amplitude
        // Facet attitude: a plane through the block, sampled from the offset
        // to the block centre so it is exactly constant per block.
        const tx = (((h >>> 16) & 0xff) / 255 - 0.5) * tilt * level.amplitude
        const ty = (((h >>> 24) & 0xff) / 255 - 0.5) * tilt * level.amplitude
        height.data[i]! += offset + w.dx * tx + w.dy * ty

        const edge = w.f2 - w.f1
        // The width of the boundary zone has to scale with the size of the
        // step across it. Treating every level's boundary as equally
        // significant paints a full-resolution crack lattice over the whole
        // surface, which reads as crazed glaze rather than as jointing.
        const normalised = clamp01(edge / (0.09 * (0.25 + level.amplitude * 2)))
        if (normalised < interior.data[i]!) interior.data[i] = normalised
        // Only some boundaries have actually opened; the rest are tight and
        // show only as the step between the two faces.
        const open = ((hashInt(w.id + 977) >>> 7) & 0xff) / 255 < openness ? 1 : 0
        // Aperture is drawn from a heavy-tailed distribution, so most joints
        // are tight seams and a few have opened into real slots. A network
        // where every crack is the same width is the clearest single sign
        // that a fracture pattern was drawn rather than formed.
        const aperture = Math.pow(((hashInt(w.id + 313) >>> 9) & 0xff) / 255, 2.6)
        const width = 0.016 + 0.13 * aperture
        const profile = 1 - smoothstep(0, width, edge)
        const trace = open * profile
        if (trace > joint.data[i]!) joint.data[i] = Math.min(1, trace)
        const cut = trace * profile * aperture * (0.35 + level.amplitude * 3)
        if (cut > carve.data[i]!) carve.data[i] = Math.min(1, cut)

        if (levelIndex === levels.length - 1) blockId.data[i] = (h & 0xffff) / 65536
        if (levelIndex === 0) domainId.data[i] = (h & 0xffff) / 65536
      }
    }
  })

  return { height, blockId, domainId, joint, carve, interior }
}

/**
 * Multi-scale pitting and granular relief.
 *
 * A broken rock face is not a plane: it is covered in the negative space left
 * by grains that have fallen out, solution pits, and the conchoidal chips of
 * its own breakage. Reviewers read a smooth facet as plastic immediately, and
 * no amount of colour detail compensates, because the normal map is what
 * carries the impression at grazing light. Each octave here is a Worley pit
 * field with per-cell depth, so most cells stay nearly flat and a minority
 * are properly excavated — which is how a weathered face actually looks under
 * a hand lens.
 */
export function pittedSurface(
  size: number,
  seed: number,
  octaves: Array<{ cells: number; depth: number; density?: number; aspect?: number }>,
): Field {
  const out = createField(size)
  octaves.forEach((octave, index) => {
    const density = octave.density ?? 0.45
    const aspect = octave.aspect ?? 1
    const cellsPerPixel = octave.cells / size
    const octaveSeed = seed + index * 4813
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const w = worley(x * cellsPerPixel, y * cellsPerPixel, octave.cells, octaveSeed, 1, aspect)
        const roll = ((hashInt(w.id + 17) >>> 11) & 0xffff) / 65536
        if (roll > density) continue
        // Depth is drawn from a wide, skewed range: most pits are barely
        // there and a few are properly excavated. A uniform depth reads as a
        // regular dimple pattern — the golf-ball look — rather than as damage.
        const depthRoll = ((hashInt(w.id + 31) >>> 5) & 0xff) / 255
        const depth = octave.depth * mix(0.08, 1.5, depthRoll * depthRoll)
        const radius = mix(0.24, 0.66, ((hashInt(w.id + 53) >>> 9) & 0xff) / 255)
        // Pits are not round. Lobing the rim by a per-pit harmonic gives them
        // the irregular outline a plucked grain socket actually has.
        const shape = hashInt(w.id + 71)
        const lobes = 2 + (shape & 3)
        const phase = ((shape >>> 5) & 0xff) / 255 * Math.PI * 2
        const wobble = Math.sin(Math.atan2(w.dy, w.dx) * lobes + phase) * 0.32
        const rim = radius * (1 + wobble)
        const profile = smoothstep(rim, rim * 0.2, w.f1)
        out.data[y * size + x]! -= profile * depth
      }
    }
  })
  return out
}

export interface JointSetSpec {
  /**
   * Integer lattice direction of the joint-set normal. Integers keep the set
   * exactly periodic over the tile, so the traces wrap without a seam.
   */
  nx: number
  ny: number
  /** Joint planes across the tile along the normal. */
  count: number
  /** Fraction of the planes in the set that actually opened. */
  presence?: number
  /** Trace wander in tile units. */
  wander?: number
  wanderPeriod?: number
  /** Height offset the blocks of this set take, in height units. */
  amplitude: number
  /** Facet tilt as a fraction of the amplitude. */
  tilt?: number
  /**
   * How far each joint runs before it dies out. 1 is a plane that crosses the
   * whole tile; lower values break it into segments.
   */
  continuity?: number
  /** Multiplies the aperture of the whole set. */
  aperture?: number
}

export interface JointedRock {
  /** Faceted height: blocks offset and tilted between the joint planes. */
  height: Field
  /** Carve mask for open joints, weighted by aperture. */
  carve: Field
  /** Random value per block. */
  blockId: Field
  /** Random value of the block in the coarsest set only. */
  domainId: Field
  /** Normalised distance to the nearest significant joint. */
  interior: Field
}

/**
 * Brittle jointing as intersecting sets of quasi-planar fractures.
 *
 * A Voronoi tessellation is the obvious way to make a block pattern and the
 * wrong one: its cells are equant and its boundaries are all the same length,
 * so the result reads as dried mud rather than as jointed rock. Real rock
 * masses fail along a handful of *sets* — families of near-parallel planes,
 * each with its own orientation and spacing — and the blocks are what is left
 * between them. That produces the through-going fractures, the long thin
 * blocks and the T-junctions that a tessellation never gives, and it lets one
 * set be metre-spaced while another is centimetre-spaced.
 *
 * Each plane is individually present or absent, has its own aperture, and
 * dies out along its own length, so the network has the range of trace
 * lengths that a real face shows.
 */
export function jointSets(
  size: number,
  specs: JointSetSpec[],
  seed: number,
  /** Optional structural coordinate replacing v, so sets can follow bedding. */
  coordY?: Field,
): JointedRock {
  const height = createField(size)
  const carve = createField(size)
  const blockId = createField(size)
  const domainId = createField(size)
  const interior = createField(size, 1)
  const blockHash = new Int32Array(size * size)

  specs.forEach((spec, specIndex) => {
    const presence = spec.presence ?? 0.6
    const wander = spec.wander ?? 0.02
    const wanderPeriod = spec.wanderPeriod ?? 4
    const continuity = spec.continuity ?? 0.7
    const apertureScale = spec.aperture ?? 1
    const setSeed = seed + specIndex * 6247
    const normalLength = Math.hypot(spec.nx, spec.ny) || 1

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x
        const u = x / size
        const v = coordY ? coordY.data[i]! : y / size

        // Position across the set, in plane numbers.
        const drift =
          fbm(u * wanderPeriod, v * wanderPeriod, wanderPeriod, setSeed + 11, { octaves: 4 }) *
            wander +
          fbm(u * wanderPeriod * 6, v * wanderPeriod * 6, wanderPeriod * 6, setSeed + 17, {
            octaves: 3,
          }) *
            wander *
            0.28
        const across = (spec.nx * u + spec.ny * v + drift) * spec.count
        const plane = Math.round(across)
        // Joint spacing is irregular. Displacing each plane from its lattice
        // position is what stops a set from reading as ruled lines and lets
        // wide and narrow blocks sit side by side, as they do in the field.
        const jitter = ((hashInt(plane * 374761393 + setSeed + 5) & 0xff) / 255 - 0.5) * 0.62
        const offset = across - plane - jitter
        // Position along the set, used to make each plane die out.
        const along = (-spec.ny * u + spec.nx * v) * spec.count

        const planeHash = hashInt(plane * 2654435761 + setSeed)
        const opened = (planeHash & 0xff) / 255 < presence
        const segment = fbm(
          along * 0.7,
          plane * 0.37,
          Math.max(2, Math.round(spec.count)),
          setSeed + 29,
          { octaves: 3 },
        )
        const alive = opened && segment * 0.5 + 0.5 < continuity

        // Blocks: the cell between two planes, combined across every set.
        const cell = Math.floor(across + 0.5)
        blockHash[i] = Math.imul(blockHash[i]! ^ (cell + 7919), 0x27d4eb2f)
        if (specIndex === 0) domainId.data[i] = (hashInt(cell + setSeed) & 0xffff) / 65536

        // Distance to this plane, in tile units, then normalised.
        const distance = Math.abs(offset) / spec.count / normalLength
        const aperture =
          apertureScale * Math.pow(((planeHash >>> 9) & 0xff) / 255, 2.2)
        const width = (0.0006 + 0.006 * aperture) * (alive ? 1 : 0)
        if (width > 0) {
          const profile = 1 - smoothstep(0, width, distance)
          const cut = profile * profile * (0.3 + aperture)
          if (cut > carve.data[i]!) carve.data[i] = Math.min(1, cut)
          const near = clamp01(distance / Math.max(width, 1e-6))
          if (near < interior.data[i]!) interior.data[i] = near
        }
      }
    }
  })

  // Height comes from the completed block identity, so a block is one facet
  // no matter how many sets bound it.
  specs.forEach((spec, specIndex) => {
    const tilt = spec.tilt ?? 0.5
    const setSeed = seed + specIndex * 6247
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = y * size + x
        const u = x / size
        const v = coordY ? coordY.data[i]! : y / size
        const across = (spec.nx * u + spec.ny * v) * spec.count
        const local = across - Math.round(across)
        const h = hashInt(blockHash[i]! + setSeed)
        const step = ((h & 0xffff) / 65536 - 0.5) * spec.amplitude
        const lean = (((h >>> 16) & 0xff) / 255 - 0.5) * tilt * spec.amplitude
        height.data[i]! += step + local * lean * 2
        if (specIndex === specs.length - 1) blockId.data[i] = (h & 0xffff) / 65536
      }
    }
  })

  return { height, carve, blockId, domainId, interior }
}
