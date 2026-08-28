import { clamp01, fbm, hash2, mix, smooth01, valueNoise } from '../proceduralNoise'
import { makeBladeShape } from './blade'
import { blemishAt, leafBaseColour, shadeBlade } from './pigment'
import type { LeafPlacement, LeafProfile, ShootSegment, SprayFields } from './types'

/** Depth the woody shoots occupy; every blade sits in front of them. */
const SHOOT_DEPTH = 0.5

/**
 * The woody shoots the leaves hang from — without them the spray floats.
 *
 * A current-season oak shoot is olive-brown and matte, not the near-black the
 * first pass used: a twig that dark reads as an inked line drawn between the
 * leaves rather than as wood catching the same sun they do.
 */
export function drawShoots(
  shoots: readonly ShootSegment[],
  fields: SprayFields,
): void {
  const {
    size, alpha, height, tint, surfaceRoughness, translucency, depthBuffer, basis,
  } = fields
  for (const [shootIndex, shoot] of shoots.entries()) {
    const runX = shoot.toX - shoot.fromX
    const runY = shoot.toY - shoot.fromY
    const length = Math.max(1e-5, Math.hypot(runX, runY))
    // Across the twig, pointing left of its heading.
    const acrossX = -runY / length
    const acrossY = runX / length
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
          const sideways = ((x - centreX) * acrossX + (y - centreY) * acrossY) /
            Math.max(0.5, span)
          const offset = Math.hypot(x - centreX, y - centreY) / Math.max(0.5, span)
          const coverage = smooth01((1 - offset) * 3)
          if (coverage <= 0.02) continue
          const index = y * size + x
          if (depthBuffer[index]! > SHOOT_DEPTH) continue
          // Round in section, so the normal map lights it as a cylinder.
          const round = Math.sqrt(Math.max(0, 1 - offset * offset))
          const bend = Math.max(-1, Math.min(1, sideways))
          const rise = Math.sqrt(Math.max(0, 1 - bend * bend))
          basis[index * 3] = acrossX * bend
          basis[index * 3 + 1] = acrossY * bend
          basis[index * 3 + 2] = rise
          // Lenticels: the pale flecks every young shoot is speckled with.
          // Without them a twig is a smooth extruded tube, and smooth extruded
          // tubes are why procedural branchlets read as wire.
          const fleck = smooth01(
            (valueNoise(x * 0.42, y * 0.42, 3391 + shootIndex * 71) - 0.72) / 0.1,
          )
          const grain = fbm(x * 0.14, y * 0.9, 5501, 3) - 0.5
          alpha[index] = Math.max(alpha[index]!, coverage)
          height[index] = Math.max(height[index]!, round * 0.55)
          depthBuffer[index] = SHOOT_DEPTH
          surfaceRoughness[index] = clamp01(0.74 + grain * 0.1 - fleck * 0.06)
          translucency[index] = 0
          // The cylindrical relief belongs in the normal map. Baking its light
          // side and dark side into albedo would double-light every twig.
          tint[index * 3] = 0.268 + grain * 0.05 + fleck * 0.1
          tint[index * 3 + 1] = 0.243 + grain * 0.045 + fleck * 0.095
          tint[index * 3 + 2] = 0.184 + grain * 0.03 + fleck * 0.08
        }
      }
    }
  }
}

/**
 * Rasterises one blade inside its own bounding box. Iterating the whole card
 * per leaf would be twenty times the work for the same result.
 */
export function drawLeaf(
  leaf: LeafPlacement,
  profile: LeafProfile,
  fields: SprayFields,
): void {
  const {
    size, alpha, height, tint, surfaceRoughness, translucency, depthBuffer, layers,
    basis,
  } = fields
  // Families whose blade is a narrow strap have no lamina to chew and only
  // one rib to interrupt the transmitted light.
  const strap = profile.family === 'needle-fascicle' ||
    profile.family === 'scale-spray' || profile.family === 'rosette'
  const shape = makeBladeShape(profile, leaf.variation, leaf.width)
  const cosine = Math.cos(leaf.angle)
  const sine = Math.sin(leaf.angle)
  const reach = leaf.length * size
  const originX = leaf.x * size
  const originY = leaf.y * size
  // The blade runs from -petiole to just past 1 along u and out to `reach`
  // across, both scaled back into texels; the across extent shrinks with tilt.
  const alongSpan = reach * 1.08
  const acrossSpan = reach * shape.reach * leaf.squash + 2
  const bound = Math.hypot(alongSpan, acrossSpan)
  const minX = Math.max(0, Math.floor(originX - bound))
  const maxX = Math.min(size - 1, Math.ceil(originX + bound))
  const minY = Math.max(0, Math.floor(originY - bound))
  const maxY = Math.min(size - 1, Math.ceil(originY + bound))
  // Albedo is calibrated as the leaf's front-face reflectance proxy. Lighting,
  // card overlap, and crown occlusion must happen at render time; multiplying
  // colour by atlas depth here was permanent double-shading.
  const baseColour = leafBaseColour(profile, leaf.variation, leaf.pigment)
  const seed = Math.round(leaf.variation * 65_536)
  // Most blades in a summer canopy carry some feeding damage, a few carry a
  // lot, and a clean population of thirty identical undamaged leaves is an
  // unmistakable tell.
  const damage = Math.pow(hash2(seed, 17, 0x9e37), 2.1) * profile.damage
  // A sun leaf is a markedly thicker, glossier object than a shade leaf off the
  // same tree. Both traits track the same exposure, so they share one draw.
  const exposure = hash2(seed, 23, 0x2c9f)
  const bladeThickness = mix(1.06, 0.62, exposure)
  const cuticle = Math.pow(exposure, 1.4)
  // The plane this blade lies in. `squash` is the cosine of how far the leaf is
  // turned out of the card, so the rest of the normal is the sine of that angle
  // laid along the blade's own across-axis. Which way it leans is not
  // recoverable from a foreshortened outline, so it is drawn per leaf.
  const lean = Math.sqrt(Math.max(0, 1 - leaf.squash * leaf.squash)) *
    (hash2(seed, 41, 0x63b1) < 0.5 ? -1 : 1)
  const planeX = -sine * lean
  const planeY = cosine * lean
  const planeZ = Math.max(0.12, leaf.squash)
  const holes = strap ? [] : chewMarks(seed, damage)
  const depth = 0.55 + leaf.depth * 0.45

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - originX
      const dy = y - originY
      // Into the blade's own frame: u runs base to tip, v across the midrib,
      // both in units of blade length so the outline and venation agree.
      const u = (dx * cosine + dy * sine) / reach
      if (u < -leaf.petiole || u > 1.02) continue
      const v = (-dx * sine + dy * cosine) / (reach * Math.max(0.08, leaf.squash))
      const side = Math.sign(v) || 1

      let coverage: number
      let index = y * size + x
      if (u < 0) {
        // The petiole. Short, but a blade attached at a mathematical point
        // reads as a sticker rather than as something grown onto the twig.
        const edge = (shape.stalkHalfWidth - Math.abs(v)) * reach * leaf.squash
        coverage = smooth01(edge / 1.6) * smooth01((u + leaf.petiole) / 0.02)
        if (coverage <= 0.02) continue
        if (depth < depthBuffer[index]! - 0.02) continue
        depthBuffer[index] = depth
        alpha[index] = Math.max(alpha[index]!, coverage)
        layers[index] = layers[index]! + coverage
        height[index] = Math.max(height[index]!, 0.5)
        basis[index * 3] = planeX
        basis[index * 3 + 1] = planeY
        basis[index * 3 + 2] = planeZ
        surfaceRoughness[index] = 0.66
        translucency[index] = 0.12
        tint[index * 3] = baseColour[0] * 0.86 + 0.05
        tint[index * 3 + 1] = baseColour[1] * 0.8 + 0.03
        tint[index * 3 + 2] = baseColour[2] * 0.9 + 0.02
        continue
      }

      const halfWidth = shape.halfWidth(u, side)
      if (halfWidth <= 0) continue
      const across = clamp01(Math.abs(v) / Math.max(1e-4, halfWidth))
      // Texel-space distance to the rim, so the antialiasing ramp stays a
      // constant width on screen however the blade is tilted or scaled.
      const rim = (halfWidth - Math.abs(v)) * reach * Math.max(0.08, leaf.squash)
      // A two-and-a-half-texel ramp rather than a one-texel one. A near-1-bit
      // cutout produces thousands of sub-pixel alpha steps around a lobed rim,
      // which shimmer under camera motion and dissolve in the first mip.
      coverage = smooth01(rim / 2.6)
      // Chewed holes and margin notches, cut out of the coverage rather than
      // painted on. Real damage removes lamina; a brown patch that still
      // occludes the sky behind it fools nobody in a backlit crown.
      const bite = chewAt(holes, u, v, halfWidth)
      coverage *= 1 - bite
      if (coverage <= 0.02) continue
      index = y * size + x

      // Only a *decisively* nearer blade wins. Rejecting on a hairline depth
      // difference punched pinholes straight through the leaf bodies.
      if (depth < depthBuffer[index]! - 0.02) continue
      depthBuffer[index] = depth
      layers[index] = layers[index]! + coverage

      const veins = shape.veins(u, v, side)
      // Cross-sectional curl: an oak leaf is a shallow trough, never a plane.
      // This is what makes the spray catch light in bands instead of flat.
      // Cupping carries most of the relief and the venation only breaks it up.
      // Weighted the other way round, every vein embosses into a hard ridge and
      // the blade reads as stamped metal, while the broad trough that should
      // give the leaf a soft gradient from midrib to margin disappears.
      const trough = (across * across - 0.28) * leaf.curl
      const blade = 0.42 + trough * 0.62 + veins.midrib * 0.16 +
        veins.lateral * 0.055 + veins.reticulate * 0.06 +
        // Fine surface grain at the scale of the epidermal cells. Small, but
        // its absence is what makes a procedural blade look moulded from vinyl:
        // every real leaf breaks a highlight into hundreds of tiny facets
        // rather than reflecting it as one clean sheet.
        fbm(x * 0.55, y * 0.55, 7717, 2) * 0.045 +
        fbm(x * 0.09, y * 0.09, 331, 3) * 0.04
      const blemish = blemishAt(u, across, leaf.variation, damage)
      const colour = shadeBlade(
        baseColour, profile, u, across, leaf.variation, veins, blemish,
      )

      // Dry margins and raised veins scatter a little more broadly than the
      // waxy blade. The *spread* matters as much as the level: a canopy whose
      // every texel is within a few percent of one roughness has a single
      // uniform sheen wherever the sun catches it, which is the plastic read.
      // A young glossy blade and a dusty old one are genuinely different
      // materials and have to be allowed to look it.
      const veinMask = clamp01(veins.midrib * 0.7 + veins.lateral * 0.5)
      const cuticleNoise = (valueNoise(u * 5.7, across * 4.1, 1481) - 0.5) * 0.05
      const margin = smooth01((across - 0.72) * 3.6)
      surfaceRoughness[index] = clamp01(
        // A developed cuticle is glossier, not rougher. The former positive
        // term made exposed leaves simultaneously brightest and chalkiest,
        // flattening the entire crown into one hard diffuse response.
        profile.baseRoughness + (1 - cuticle) * 0.16 + veinMask * 0.075 +
          margin * 0.05 + blemish * 0.2 + cuticleNoise,
      )

      alpha[index] = Math.max(alpha[index]!, coverage)
      // Straight-alpha, like the tint below and for the same reason. Scaling
      // the relief by coverage puts a cliff in the height field along every
      // antialiased contour, and `packNormals` takes a central difference of
      // this field: a one-texel drop of a full blade height tilts the rim
      // normal almost perpendicular to the leaf. That is the dark outline
      // around every cutout — shading, not blending, which is why it survives
      // against a bright sky and gets worse with distance as the mip chain
      // promotes more rim texels past the alpha test.
      //
      // Dilation cannot repair it either: it only fills texels below alpha
      // 0.02, and the whole antialiased band sits above that.
      height[index] = blade
      basis[index * 3] = planeX
      basis[index * 3 + 1] = planeY
      basis[index * 3 + 2] = planeZ
      // Albedo and surface properties are straight-alpha values. Premultiplying
      // them by coverage makes every antialiased contour dark and glossy after
      // mip filtering — precisely the black fringe cutout foliage is prone to.
      tint[index * 3] = colour[0]
      tint[index * 3 + 1] = colour[1]
      tint[index * 3 + 2] = colour[2]
      // Thin between the veins, opaque along them: that contrast is what makes
      // a backlit canopy glow in a lace pattern rather than as a flat panel.
      // Dead tissue is thinner still and lets more through.
      //
      // The whole-blade level has to vary too. Sitting every lamina texel at
      // one ceiling made a backlit crown light up as a single flat sheet of
      // lime, because the shader had nothing to modulate. A sun leaf really is
      // several times thicker than a shade leaf from the same tree, and within
      // one blade the lamina thins toward the margin and the apex.
      const thinning = mix(0.82, 1.12, across * 0.6 + u * 0.4)
      translucency[index] = clamp01(
        (profile.translucency * bladeThickness * thinning -
          veins.midrib * 0.62 - veins.lateral * (strap ? 0.08 : 0.34) -
          veins.reticulate * 0.06 + blemish * 0.12),
      )
    }
  }
}

/** One bite taken out of a blade, in blade space. */
interface ChewMark {
  u: number
  v: number
  radius: number
  /** 0 keeps the mark interior; 1 pulls it out through the nearest margin. */
  marginal: number
}

/**
 * Where an insect has fed on this blade.
 *
 * Damage is deliberately sparse and compact. A general wash of brownness over
 * every leaf reads as dirt on the lens; a handful of distinct holes and notched
 * margins on a minority of blades reads as a summer canopy.
 */
function chewMarks(seed: number, damage: number): ChewMark[] {
  const count = Math.floor(damage * 4.2)
  const marks: ChewMark[] = []
  for (let index = 0; index < count; index += 1) {
    const marginal = hash2(seed, index * 7 + 3, 0x4d1b)
    marks.push({
      u: 0.16 + hash2(seed, index * 11 + 5, 0x33f1) * 0.74,
      v: (hash2(seed, index * 13 + 9, 0x77c3) - 0.5) * 2,
      radius: 0.022 + hash2(seed, index * 17 + 1, 0x1a2b) * 0.055,
      marginal: marginal > 0.45 ? 1 : 0,
    })
  }
  return marks
}

function chewAt(
  marks: readonly ChewMark[],
  u: number,
  v: number,
  halfWidth: number,
): number {
  if (marks.length === 0) return 0
  let bite = 0
  for (const mark of marks) {
    // A marginal bite is anchored to the rim on its own side, so it opens the
    // outline into a notch instead of leaving a floating interior hole.
    const centreV = mark.marginal
      ? Math.sign(mark.v || 1) * halfWidth
      : mark.v * halfWidth * 0.62
    const du = (u - mark.u) / mark.radius
    const dv = (v - centreV) / mark.radius
    const distance = Math.hypot(du, dv)
    // Irregular rim: chewing leaves a ragged edge, never a punched circle.
    const ragged = 1 + (valueNoise(u * 26, v * 26, 811) - 0.5) * 0.5
    bite = Math.max(bite, smooth01((ragged - distance) / 0.45))
  }
  return clamp01(bite)
}
