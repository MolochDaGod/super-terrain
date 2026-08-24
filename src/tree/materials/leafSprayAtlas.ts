import { fbm, mix, clamp01, smooth01, valueNoise } from './proceduralNoise'
import type { TreeSpecies } from '../generator/types'

/**
 * Content keeps clear of the card border by this fraction. A blade that runs
 * off the edge is cut by a dead-straight line in the crown, and straight cuts
 * through foliage are one of the loudest artefacts a canopy can have.
 */
const MARGIN = 0.06

export interface LeafSprayMaps {
  albedo: Uint8Array
  normal: Uint8Array
  /** Roughness in R, translucency mask in G — thin leaf blade vs thick midrib. */
  roughness: Uint8Array
  size: number
}

/**
 * Bakes one leaf *spray*: a twiglet carrying a dozen or more leaves, composed
 * into a single card texture.
 *
 * A card is only worth drawing if what it holds could not be afforded as
 * geometry, so the leaves are laid out here the way the species actually
 * arranges them — English oak leaves are near-sessile, alternate, crowded
 * toward the shoot tip, and cluster into rosettes rather than spacing evenly
 * along the stem. Getting that arrangement right is most of what separates a
 * card that reads as foliage from one that reads as a decal.
 */
export function bakeLeafSpray(
  seed: number,
  species: TreeSpecies,
  variant: number,
  size: number,
): LeafSprayMaps {
  const pixels = size * size
  const albedo = new Uint8Array(pixels * 4)
  const normal = new Uint8Array(pixels * 4)
  const roughness = new Uint8Array(pixels * 4)
  const height = new Float32Array(pixels)
  const alpha = new Float32Array(pixels)
  const tint = new Float32Array(pixels * 3)
  const translucency = new Float32Array(pixels)
  const pine = species === 'windswept-pine'

  // A real depth buffer, so a blade in front of another blade wins on depth
  // rather than on whichever happens to have the taller surface relief.
  const depthBuffer = new Float32Array(pixels)
  const { leaves, shoots } = layoutSpray(seed + variant * 7717, variant, pine)
  drawShoots(shoots, alpha, height, tint, translucency, depthBuffer, size)
  for (const leaf of leaves) {
    drawLeaf(leaf, alpha, height, tint, translucency, depthBuffer, size, pine)
  }

  // Push every channel outward into the transparent texels before anything is
  // packed. Mip generation averages each channel against alpha independently,
  // so a cutout whose transparent texels hold nothing bleeds that nothing into
  // every edge — and it is not only the albedo that matters. Undilated height
  // gives the rim garbage normals and undilated roughness makes it mirror
  // bright, which together are the dark, glinting halo that gives away a
  // game-foliage atlas from across a field.
  dilate(tint, alpha, size, 8)
  dilateChannel(height, alpha, size, 8)
  dilateChannel(translucency, alpha, size, 8)

  for (let index = 0; index < pixels; index += 1) {
    const opacity = clamp01(alpha[index]!)
    const offset = index * 4
    const byteAlpha = Math.round(opacity * 255)
    albedo[offset] = toByte(tint[index * 3]!)
    albedo[offset + 1] = toByte(tint[index * 3 + 1]!)
    albedo[offset + 2] = toByte(tint[index * 3 + 2]!)
    albedo[offset + 3] = byteAlpha
    // Waxy cuticle on the lit face, matte where the blade is thin and veined.
    const rough = clamp01(0.52 + (1 - height[index]!) * 0.3)
    roughness[offset] = toByte(rough)
    roughness[offset + 1] = toByte(translucency[index]!)
    roughness[offset + 2] = 0
    roughness[offset + 3] = byteAlpha
  }
  heightToNormal(height, alpha, normal, size)
  return { albedo, normal, roughness, size }
}

interface LeafPlacement {
  /** Petiole attachment, in 0..1 card space. */
  x: number
  y: number
  /** Direction the blade points, radians, 0 = +x. */
  angle: number
  length: number
  width: number
  /** Foreshortening from the leaf's own tilt out of the card plane. */
  squash: number
  shade: number
  hue: number
  /** Higher is nearer the viewer; decides overdraw and how shaded a blade is. */
  depth: number
  curl: number
}

interface ShootSegment {
  fromX: number
  fromY: number
  toX: number
  toY: number
  width: number
}

interface SprayComposition {
  /** Side shoots off the main axis. */
  primaryCount: number
  /** Chance a side shoot forks again. */
  secondaryChance: number
  /** Leaves carried by the main axis. */
  axisLeaves: number
  /** Leaves carried by each side shoot. */
  sideLeaves: number
  /** Blade length as a fraction of the card. */
  leafScale: number
  /** How far up the card the axis reaches. */
  axisTop: number
  /** How far the side shoots reach across it. */
  spread: number
}

/**
 * Four genuinely different spray compositions, one per atlas slot.
 *
 * Re-seeding one composition is not variety: the eye reads the *layout* — where
 * the mass sits, how far the shoots reach, how crowded the tip is — long before
 * it reads which individual blade went where. Four reseeds of one layout tile
 * across a crown as a single repeating grain, which is exactly what a canopy
 * built from them looks like.
 */
function compositionFor(variant: number, pine: boolean): SprayComposition {
  if (pine) {
    return {
      primaryCount: 2 + (variant % 2),
      secondaryChance: 0,
      axisLeaves: 18,
      sideLeaves: 12,
      leafScale: 0.13,
      axisTop: 0.88,
      spread: 0.16,
    }
  }
  switch (variant % 4) {
    // A single long shoot: sparse, open, mostly axis. Reads as the leading
    // edge of a branchlet and is what lets sky through the crown boundary.
    case 0:
      return {
        primaryCount: 2,
        secondaryChance: 0.2,
        axisLeaves: 13,
        sideLeaves: 6,
        leafScale: 0.2,
        axisTop: 0.9,
        spread: 0.19,
      }
    // A wide fan: two heavy side shoots low, mass carried out to the sides.
    case 1:
      return {
        primaryCount: 4,
        secondaryChance: 0.7,
        axisLeaves: 8,
        sideLeaves: 10,
        leafScale: 0.185,
        axisTop: 0.72,
        spread: 0.32,
      }
    // A terminal rosette: short axis, everything crowded into the last third,
    // which is how an oak's current-season growth actually presents.
    case 2:
      return {
        primaryCount: 3,
        secondaryChance: 0.5,
        axisLeaves: 15,
        sideLeaves: 9,
        leafScale: 0.18,
        axisTop: 0.6,
        spread: 0.24,
      }
    // A dense twiggy cluster: many short shoots, the interior filler.
    default:
      return {
        primaryCount: 5,
        secondaryChance: 0.8,
        axisLeaves: 9,
        sideLeaves: 8,
        leafScale: 0.17,
        axisTop: 0.8,
        spread: 0.26,
      }
  }
}

/**
 * Lays out one spray from its composition.
 *
 * Leaf size relative to the card is the whole game. Too large and the blades
 * overlap into a solid green paddle with no holes through it: the card stops
 * being foliage and becomes a decal, and a crown built from those reads as
 * cabbage. Too small and the deep lobes that identify an oak fall below the
 * texture's resolution and turn into edge noise. A real oak twig shows sky
 * through it nearly everywhere, and the negative space between blades carries
 * as much of the read as the blades do.
 */
function layoutSpray(
  seed: number,
  variant: number,
  pine: boolean,
): { leaves: LeafPlacement[]; shoots: ShootSegment[] } {
  const random = seededSequence(seed)
  const plan = compositionFor(variant, pine)
  const shoots: ShootSegment[] = []
  const bearers: { shoot: ShootSegment; leaves: number }[] = []

  const axisBow = (random() - 0.5) * 0.12
  const axis: ShootSegment = {
    fromX: 0.5 - axisBow,
    fromY: MARGIN,
    toX: 0.5 + axisBow,
    toY: plan.axisTop,
    width: 0.0078,
  }
  shoots.push(axis)
  bearers.push({ shoot: axis, leaves: plan.axisLeaves })

  for (let index = 0; index < plan.primaryCount; index += 1) {
    const along = 0.12 + ((index + random() * 0.7) / plan.primaryCount) * 0.76
    const side = index % 2 === 0 ? 1 : -1
    const reach = plan.spread * (0.7 + random() * 0.6) * (1 - along * 0.3)
    const primary: ShootSegment = {
      fromX: mix(axis.fromX, axis.toX, along),
      fromY: mix(axis.fromY, axis.toY, along),
      toX: mix(axis.fromX, axis.toX, along) + side * reach,
      toY: mix(axis.fromY, axis.toY, along) + reach * (0.3 + random() * 0.55),
      width: 0.005,
    }
    shoots.push(primary)
    bearers.push({ shoot: primary, leaves: plan.sideLeaves })
    if (random() > plan.secondaryChance) continue
    const forkAt = 0.35 + random() * 0.4
    const secondaryReach = reach * (0.4 + random() * 0.32)
    const secondary: ShootSegment = {
      fromX: mix(primary.fromX, primary.toX, forkAt),
      fromY: mix(primary.fromY, primary.toY, forkAt),
      toX: mix(primary.fromX, primary.toX, forkAt) + side * secondaryReach * 0.45,
      toY: mix(primary.fromY, primary.toY, forkAt) + secondaryReach,
      width: 0.0033,
    }
    shoots.push(secondary)
    bearers.push({ shoot: secondary, leaves: Math.round(plan.sideLeaves * 0.7) })
  }

  const leaves: LeafPlacement[] = []
  for (const [shootIndex, bearer] of bearers.entries()) {
    const { shoot, leaves: count } = bearer
    const isAxis = shootIndex === 0
    const runX = shoot.toX - shoot.fromX
    const runY = shoot.toY - shoot.fromY
    const heading = Math.atan2(runY, runX)
    for (let index = 0; index < count; index += 1) {
      // Alternate, not opposite. Oak sets one leaf per node on a spiral, so
      // consecutive blades must be offset *along* the shoot as well as across
      // it — placing left and right at the same station gives the paired,
      // pinnate look of an ash or a rowan.
      const step = (index + 0.75) / count
      const along = Math.pow(step, 0.72)
      const side = index % 2 === 0 ? 1 : -1
      const divergence = Math.cos(index * 2.399963229728653)
      const spread = (0.45 + Math.abs(divergence) * 0.55) * side
      // Blades rake forward toward the tip, the way weight and light pull them.
      const rake = mix(0.45, 1.4, along)
      const scale = plan.leafScale *
        mix(0.74, 1.14, Math.sin(along * Math.PI * 0.92)) *
        (isAxis ? 1 : 0.86) *
        (0.82 + random() * 0.36)
      leaves.push({
        x: shoot.fromX + runX * along + (random() - 0.5) * 0.016,
        y: shoot.fromY + runY * along + (random() - 0.5) * 0.016,
        angle: heading + Math.atan2(spread, rake),
        length: scale,
        // Half-width as a fraction of length. An English oak leaf is close to
        // two to one, so a quarter. At the value this started with the blade
        // came out wider than it was long, which crushed three broad lobes into
        // a span of a few texels and turned the whole outline into fine teeth.
        width: scale * (pine ? 0.06 : 0.29 + random() * 0.05),
        squash: 0.62 + random() * 0.38,
        shade: 0.82 + random() * 0.3,
        hue: random(),
        depth: random(),
        curl: (random() - 0.5) * 1.5,
      })
    }
  }
  // Back to front, so nearer blades overwrite the ones behind them.
  leaves.sort((a, b) => a.depth - b.depth)
  return { leaves, shoots }
}

/** The woody shoots the leaves hang from — without them the spray floats. */
function drawShoots(
  shoots: readonly ShootSegment[],
  alpha: Float32Array,
  height: Float32Array,
  tint: Float32Array,
  translucency: Float32Array,
  depthBuffer: Float32Array,
  size: number,
): void {
  for (const shoot of shoots) {
    const steps = Math.ceil(
      Math.hypot(shoot.toX - shoot.fromX, shoot.toY - shoot.fromY) * size * 1.4,
    )
    for (let step = 0; step <= steps; step += 1) {
      const t = step / Math.max(1, steps)
      const centreX = mix(shoot.fromX, shoot.toX, t) * size
      const centreY = mix(shoot.fromY, shoot.toY, t) * size
      const span = shoot.width * size * mix(1.3, 0.45, t)
      for (let y = Math.floor(centreY - span - 1); y <= centreY + span + 1; y += 1) {
        if (y < 0 || y >= size) continue
        for (let x = Math.floor(centreX - span - 1); x <= centreX + span + 1; x += 1) {
          if (x < 0 || x >= size) continue
          const distance = Math.hypot(x - centreX, y - centreY) / Math.max(0.5, span)
          const coverage = smooth01((1 - distance) * 3)
          if (coverage <= 0.02) continue
          const index = y * size + x
          if (depthBuffer[index]! > 0.5) continue
          const shading = 0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - distance * distance))
          alpha[index] = Math.max(alpha[index]!, coverage)
          height[index] = Math.max(height[index]!, coverage * 0.8)
          depthBuffer[index] = 0.5
          translucency[index] = 0
          tint[index * 3] = 0.29 * shading
          tint[index * 3 + 1] = 0.23 * shading
          tint[index * 3 + 2] = 0.15 * shading
        }
      }
    }
  }
}

/**
 * Rasterises one blade inside its own bounding box. Iterating the whole card
 * per leaf would be twenty times the work for the same result.
 */
function drawLeaf(
  leaf: LeafPlacement,
  alpha: Float32Array,
  height: Float32Array,
  tint: Float32Array,
  translucency: Float32Array,
  depthBuffer: Float32Array,
  size: number,
  pine: boolean,
): void {
  const cosine = Math.cos(leaf.angle)
  const sine = Math.sin(leaf.angle)
  const reach = leaf.length * size
  const originX = leaf.x * size
  const originY = leaf.y * size
  const minX = Math.max(0, Math.floor(originX - reach * 1.1))
  const maxX = Math.min(size - 1, Math.ceil(originX + reach * 1.1))
  const minY = Math.max(0, Math.floor(originY - reach * 1.1))
  const maxY = Math.min(size - 1, Math.ceil(originY + reach * 1.1))
  // Depth decides both overdraw order and how much the blade is shaded by the
  // leaves in front of it.
  const depthShade = mix(0.46, 1, leaf.depth)

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - originX
      const dy = y - originY
      // Into the blade's own frame: u runs base to tip, v across the midrib.
      const u = (dx * cosine + dy * sine) / reach
      const v = (-dx * sine + dy * cosine) / (reach * leaf.width / leaf.length) *
        (1 / Math.max(0.3, leaf.squash))
      if (u < 0 || u > 1) continue
      const halfWidth = pine ? pineBlade(u) : oakBlade(u, leaf.hue, Math.sign(v) || 1)
      if (halfWidth <= 0) continue
      const edge = (halfWidth - Math.abs(v)) * reach * 0.5
      // A two-and-a-half-texel ramp rather than a one-texel one. A near-1-bit
      // cutout produces thousands of sub-pixel alpha steps around a lobed rim,
      // which shimmer under camera motion and dissolve in the first mip.
      const coverage = smooth01(edge / 3.4)
      if (coverage <= 0.02) continue
      const index = y * size + x
      const across = clamp01(Math.abs(v) / Math.max(1e-3, halfWidth))

      // Cross-sectional curl: an oak leaf is a shallow trough, never a plane.
      // This is what makes the spray catch light in bands instead of flat.
      const trough = (across * across - 0.28) * leaf.curl
      const midrib = Math.exp(-across * 9)
      const lateral = lateralVeins(u, across)
      const blade = 0.42 + trough * 0.3 + midrib * 0.3 + lateral * 0.12 +
        fbm(x * 0.09, y * 0.09, 331, 3) * 0.06
      const depth = 0.55 + leaf.depth * 0.45
      // Only a *decisively* nearer blade wins. Rejecting on a hairline depth
      // difference punched pinholes straight through the leaf bodies.
      if (depth < depthBuffer[index]! - 0.02) continue
      depthBuffer[index] = depth

      const flush = valueNoise(u * 3.2 + leaf.hue * 9, across * 2.4, 977) - 0.5
      // Autumn-ready base: a green oak leaf still carries carotenoid warmth at
      // the margins and along the veins, and a flat green never looks alive.
      const margin = smooth01((across - 0.62) * 3.4)
      // The vein network has to exist in the *albedo*, not only in the height
      // field: veins are visibly paler and yellower than the blade between
      // them, and without that break a leaf is a flat fill that no lighting
      // model can rescue.
      const veinLight = midrib * 0.16 + lateral * 0.09
      const shading = leaf.shade * depthShade *
        (0.86 + 0.14 * Math.sqrt(Math.max(0, 1 - across * across)))
      const red = (pine ? 0.2 : 0.3 + margin * 0.15 + flush * 0.07 + veinLight) *
        shading
      const green = (pine ? 0.36 : 0.5 - margin * 0.05 + flush * 0.05 +
        veinLight * 0.72) * shading
      const blue = (pine ? 0.22 : 0.14 + flush * 0.03 + veinLight * 0.3) * shading

      alpha[index] = Math.max(alpha[index]!, coverage)
      height[index] = blade * coverage
      tint[index * 3] = mix(tint[index * 3]!, red, coverage)
      tint[index * 3 + 1] = mix(tint[index * 3 + 1]!, green, coverage)
      tint[index * 3 + 2] = mix(tint[index * 3 + 2]!, blue, coverage)
      // Thin between the veins, opaque along them: that contrast is what makes
      // a backlit canopy glow in a lace pattern rather than as a flat panel.
      translucency[index] = clamp01(
        (1 - midrib * 0.85 - lateral * 0.35) * mix(0.55, 1, leaf.depth),
      ) * coverage
    }
  }
}

/**
 * English-oak blade half-width along its length.
 *
 * The identity of the shape is *few, deep, rounded* lobes: three or four a side,
 * with sinuses cutting most of the way to the midrib, and no two the same size.
 * High-frequency scalloping around the rim is the wrong cue entirely — it reads
 * as bracken or sweet chestnut, and it is also what aliases into shimmering
 * mush the moment the card is minified.
 */
function oakBlade(u: number, variation: number, side: number): number {
  // Three or four lobes a side, never more. At card resolution a fifth lobe is
  // sub-pixel and contributes nothing but aliasing.
  const lobeCount = variation < 0.5 ? 3 : 4
  // A blunt, rounded apex. Oak leaves do not taper to a point.
  const body = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.86)), 0.42)
  // Widest above the middle is the cue that says oak rather than maple.
  const bias = 1 - 0.38 * Math.pow(Math.max(0, 0.58 - u) / 0.58, 1.5)
  // The two halves of a real oak leaf are never mirror images: the lobes on one
  // side sit between the lobes on the other, and one side usually carries an
  // extra. Perfect bilateral symmetry is one of the clearest procedural tells
  // there is, and it costs nothing to break.
  const phase = variation * 2.3 + (side < 0 ? 0.38 : 0)
  const wobble = Math.sin(u * 5.1 + phase * 3.7) * 0.12
  // A raised cosine, not a rectified sine, and no fractional exponent on it.
  // |sin| has a cusp at every zero and a sub-one power puts one back at every
  // minimum, either of which cuts sharp V-notches and leaves the lobes pointed
  // — a holly or a thistle. An oak's sinuses have rounded *floors* and its
  // lobes rounded *crowns*, and a plain cosine is smooth at both.
  const wave = 0.5 - 0.5 * Math.cos((u * lobeCount + 0.28 + wobble) * Math.PI * 2)
  // Sinuses cut roughly half way to the midrib.
  const lobing = 0.44 + wave * 0.56
  // A narrow, near-sessile base with small auricles, not a long petiole.
  const auricle = u < 0.1 ? 0.3 + u * 4 : 1
  return Math.max(0, body * bias * lobing * auricle)
}

function pineBlade(u: number): number {
  return Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.02)), 0.28)
}

function lateralVeins(u: number, across: number): number {
  // Veins run from the midrib into each lobe tip, so their spacing has to track
  // the same frequency the blade outline uses.
  const band = Math.abs(Math.sin((u * 3.6 + across * 0.9) * Math.PI))
  return Math.pow(band, 26) * (1 - across * 0.4)
}

/**
 * Flood-fills the RGB of transparent texels from their nearest opaque
 * neighbour, leaving alpha untouched. Standard alpha dilation.
 */
function dilate(
  tint: Float32Array,
  alpha: Float32Array,
  size: number,
  passes: number,
): void {
  const filled = new Uint8Array(size * size)
  for (let index = 0; index < filled.length; index += 1) {
    filled[index] = alpha[index]! > 0.02 ? 1 : 0
  }
  const offsets = [-1, 1, -size, size, -size - 1, -size + 1, size - 1, size + 1]
  for (let pass = 0; pass < passes; pass += 1) {
    const next = Uint8Array.from(filled)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = y * size + x
        if (filled[index]) continue
        let red = 0
        let green = 0
        let blue = 0
        let found = 0
        for (const [offsetIndex, offset] of offsets.entries()) {
          const neighbourX = x + [-1, 1, 0, 0, -1, 1, -1, 1][offsetIndex]!
          const neighbourY = y + [0, 0, -1, 1, -1, -1, 1, 1][offsetIndex]!
          if (neighbourX < 0 || neighbourX >= size) continue
          if (neighbourY < 0 || neighbourY >= size) continue
          const neighbour = index + offset
          if (!filled[neighbour]) continue
          red += tint[neighbour * 3]!
          green += tint[neighbour * 3 + 1]!
          blue += tint[neighbour * 3 + 2]!
          found += 1
        }
        if (found === 0) continue
        tint[index * 3] = red / found
        tint[index * 3 + 1] = green / found
        tint[index * 3 + 2] = blue / found
        next[index] = 1
      }
    }
    filled.set(next)
  }
}

/** Single-channel {@link dilate}, for the height and translucency fields. */
function dilateChannel(
  values: Float32Array,
  alpha: Float32Array,
  size: number,
  passes: number,
): void {
  const filled = new Uint8Array(size * size)
  for (let index = 0; index < filled.length; index += 1) {
    filled[index] = alpha[index]! > 0.02 ? 1 : 0
  }
  const dx = [-1, 1, 0, 0, -1, 1, -1, 1]
  const dy = [0, 0, -1, 1, -1, -1, 1, 1]
  for (let pass = 0; pass < passes; pass += 1) {
    const next = Uint8Array.from(filled)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = y * size + x
        if (filled[index]) continue
        let total = 0
        let found = 0
        for (let step = 0; step < 8; step += 1) {
          const nx = x + dx[step]!
          const ny = y + dy[step]!
          if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue
          const neighbour = ny * size + nx
          if (!filled[neighbour]) continue
          total += values[neighbour]!
          found += 1
        }
        if (found === 0) continue
        values[index] = total / found
        next[index] = 1
      }
    }
    filled.set(next)
  }
}

function heightToNormal(
  height: Float32Array,
  alpha: Float32Array,
  target: Uint8Array,
  size: number,
): void {
  const strength = size * 0.012
  for (let y = 0; y < size; y += 1) {
    const above = Math.max(0, y - 1)
    const below = Math.min(size - 1, y + 1)
    for (let x = 0; x < size; x += 1) {
      const left = Math.max(0, x - 1)
      const right = Math.min(size - 1, x + 1)
      const dx = (height[y * size + right]! - height[y * size + left]!) * strength
      const dy = (height[below * size + x]! - height[above * size + x]!) * strength
      const inverse = 1 / Math.hypot(dx, dy, 1)
      const offset = (y * size + x) * 4
      target[offset] = toByte(-dx * inverse * 0.5 + 0.5)
      target[offset + 1] = toByte(-dy * inverse * 0.5 + 0.5)
      target[offset + 2] = toByte(inverse * 0.5 + 0.5)
      target[offset + 3] = Math.round(clamp01(alpha[y * size + x]!) * 255)
    }
  }
}

/** Small deterministic generator, so a variant is reproducible from its seed. */
function seededSequence(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function toByte(value: number): number {
  return Math.round(clamp01(value) * 255)
}

/**
 * Rasterises one blade filling the frame. A diagnostic: in a finished spray
 * thirty overlapping leaves make it impossible to tell whether the outline
 * itself is wrong or whether the overlaps only look that way.
 */
export function bakeSingleBlade(
  species: TreeSpecies,
  variation: number,
  size: number,
): Uint8Array {
  const rgba = new Uint8Array(size * size * 4)
  const pine = species === 'windswept-pine'
  for (let y = 0; y < size; y += 1) {
    const u = 1 - (y + 0.5) / size
    for (let x = 0; x < size; x += 1) {
      const across = ((x + 0.5) / size - 0.5) * 2 / (pine ? 0.06 : 0.27)
      const halfWidth = pine ? pineBlade(u) : oakBlade(u, variation, Math.sign(across) || 1)
      const inside = Math.abs(across) <= halfWidth
      const offset = (y * size + x) * 4
      rgba[offset] = inside ? 60 : 150
      rgba[offset + 1] = inside ? 120 : 150
      rgba[offset + 2] = inside ? 40 : 150
      rgba[offset + 3] = 255
    }
  }
  return rgba
}
