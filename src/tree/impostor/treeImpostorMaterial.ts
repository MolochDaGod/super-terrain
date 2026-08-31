import { DoubleSide, MeshBasicNodeMaterial, type Texture } from 'three/webgpu'
import * as TSL from 'three/tsl'
import {
  IMPOSTOR_GRID,
  IMPOSTOR_PITCHES,
  IMPOSTOR_YAW_STEPS,
} from './treeImpostorAtlas'

/** See the note in the foliage materials — these are node builders, not maths. */
type ShaderValue = any

const {
  asin, atan, attribute, cameraPosition, clamp, cross, float, floor, fract,
  length, mix, mod, normalize, positionGeometry, select, smoothstep, texture,
  uniform, varying, vec2, vec3, vec4,
} = TSL as unknown as Record<string, ShaderValue>

export interface TreeImpostorMaterialOptions {
  atlas: Texture
  /**
   * Metres over which a card gives way to the real tree.
   *
   * Cards are wrong close up — a flat picture of a tree does not part around
   * the camera, does not self-shadow, and shows its baked bearing the moment
   * you can resolve a branch. Inside `nearFadeEnd` the geometry draws instead
   * and the card is gone; between the two both are present and the card's alpha
   * ramps, so a tree is never seen to pop from one representation to the other.
   */
  nearFadeStart: number
  nearFadeEnd: number
  /** Half-width and half-height of one card, in metres, from the bake. */
  radius: number
  halfHeight: number
  /** Height of the baked frame's centre above the trunk base, in metres. */
  centreHeight: number
}

/**
 * Draws the baked cards.
 *
 * ## The quad faces the camera outright, not just around Y
 *
 * A cylindrical billboard — one that spins about the world up axis and no
 * further — is the usual choice, and it is the wrong one here. It is edge-on,
 * and therefore invisible, exactly when the camera is above the canopy looking
 * down, which in a terrain editor is most of the time. A view-aligned quad is
 * also what agrees with the bake: every cell was rendered by an orthographic
 * camera pointed at the tree's centre, so a card held perpendicular to the view
 * presents the same rectangle the bake framed.
 *
 * ## Choosing the cell
 *
 * The view direction is taken into the instance's own yaw frame, so a tree
 * planted with a random bearing shows a different face than its neighbour and a
 * stand does not read as one silhouette stamped in rows. Azimuth picks a
 * bearing and elevation picks a row; the two nearest bearings are sampled and
 * cross-faded, because a hard switch between adjacent cells is a visible flick
 * on every tree at once as the camera pans, which is far more noticeable than
 * the brief double-exposure the blend costs.
 */
export function createTreeImpostorMaterial(
  options: TreeImpostorMaterialOptions,
): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    // Alpha-tested and opaque, never blended.
    //
    // Blending was the first attempt and it is wrong for foliage in every way
    // at once. A blended card writes no depth, so twenty thousand of them are
    // sorted against each other by object centre — which is one draw call, so
    // they are not sorted at all — and every card therefore shows the sky and
    // the cards behind it straight through the crown. That is the "half
    // transparent, weird against the horizon" look: not a wrong alpha value
    // anywhere, but the absence of an opaque surface.
    //
    // Alpha testing gives a card a real silhouette: inside it the fragment is
    // opaque and writes depth like any other surface, outside it there is no
    // fragment at all. Cards then occlude each other and the terrain correctly
    // and need no sorting.
    transparent: false,
    depthWrite: true,
    side: DoubleSide,
  })

  // xyz world position of the trunk base, w the scale multiplier.
  const placement = attribute('impostorPlacement', 'vec4')
  // x the instance's yaw, y a per-tree lighting variation, z a colour
  // variation, w unused.
  const variation = attribute('impostorVariation', 'vec4')

  const nearFadeStart = uniform(float(options.nearFadeStart))
  const nearFadeEnd = uniform(float(options.nearFadeEnd))
  const radius = uniform(float(options.radius))
  const halfHeight = uniform(float(options.halfHeight))
  const centreHeight = uniform(float(options.centreHeight))

  const scale = placement.w
  // The point the bake camera aimed at, in world space.
  const centre = placement.xyz.add(vec3(0, centreHeight.mul(scale), 0))
  const toCamera = cameraPosition.sub(centre)
  const view = normalize(toCamera)

  // A view-aligned frame with world up as the reference, so a card never rolls
  // about the view axis and a hillside of trees keeps a common vertical.
  const right = normalize(vec3(view.z.negate(), 0, view.x).add(vec3(1e-5, 0, 0)))
  // No negation. For a camera at +z the frame is right = (-1,0,0) and
  // cross(right, view) = (0,1,0), which is already world up; negating it hung
  // every card upside down.
  const up = normalize(cross(right, view))

  const corner = positionGeometry.xy
  const world = centre
    .add(right.mul(corner.x.mul(radius).mul(2).mul(scale)))
    .add(up.mul(corner.y.mul(halfHeight).mul(2).mul(scale)))

  // Object space, not view space. `positionNode` replaces the *local* vertex
  // position and three applies the model-view-projection to whatever it is
  // given; pre-multiplying by the view matrix here transforms every card twice
  // and throws the whole forest off screen. The mesh's own transform is the
  // identity, so a world position is a valid local one.
  material.positionNode = world

  // --- cell selection -------------------------------------------------------
  // Azimuth of the view in the instance's own frame, in turns.
  const yaw = variation.x
  const azimuth = atan(view.x, view.z).sub(yaw).div(Math.PI * 2)
  const bearing = fract(azimuth).mul(float(IMPOSTOR_YAW_STEPS))
  const bearingIndex = floor(bearing)
  const bearingBlend = bearing.sub(bearingIndex)

  // Elevation picks the row. The bake rows are eye level and thirty degrees, so
  // anything steeper than thirty is clamped to the upper row rather than
  // extrapolated — a card seen from directly overhead is a compromise however
  // it is chosen, and holding the steepest baked view is the stable one.
  const elevation = clamp(
    asin(clamp(view.y, -1, 1)).div(float(IMPOSTOR_PITCHES[1]!)),
    0,
    1,
  )
  const row = select(elevation.greaterThan(0.5), float(1), float(0))

  const cellUv = (index: ShaderValue): ShaderValue => {
    const cell = index.add(row.mul(float(IMPOSTOR_YAW_STEPS)))
    const column = mod(cell, float(IMPOSTOR_GRID))
    const line = floor(cell.div(float(IMPOSTOR_GRID)))
    // The quad's v runs bottom-up and a render target's texture runs top-down,
    // so the cell has to be sampled with v inverted. Without it every card is
    // hung upside down — which is subtle enough to miss on a black silhouette
    // and unmissable the moment the bake is bright enough to read.
    const inner = vec2(
      positionGeometry.x.add(0.5),
      positionGeometry.y.negate().add(0.5),
    )
    return vec2(column.add(inner.x), line.add(inner.y)).div(float(IMPOSTOR_GRID))
  }

  const atlas = texture(options.atlas)
  const near = atlas.sample(varying(cellUv(bearingIndex), 'impostorUvNear'))
  const far = atlas.sample(
    varying(cellUv(mod(bearingIndex.add(1), float(IMPOSTOR_YAW_STEPS))), 'impostorUvFar'),
  )
  const sampled = mix(near, far, bearingBlend)

  // A stand of identical stamps is the loudest tell a card forest has. Two
  // cheap per-instance terms break it: a brightness spread standing in for the
  // light each crown actually catches, and a slight hue spread for the species
  // and age variation a single baked tree cannot carry on its own.
  const lighting = mix(float(0.78), float(1.18), variation.y)
  const tint = mix(
    vec3(0.92, 1.02, 0.88),
    vec3(1.06, 0.99, 0.86),
    variation.z,
  )

  // Distance is measured to the card's centre, which is the same point the
  // geometry band measures to, so the two ramps are exact complements.
  const range = length(toCamera)
  const handover = smoothstep(nearFadeStart, nearFadeEnd, range)
  material.colorNode = vec4(sampled.rgb.mul(lighting).mul(tint), sampled.a)
  // The handover is a *dissolve*, not a fade, because an alpha-tested surface
  // has no partial opacity to fade with. Raising the cutoff toward one erodes
  // the crown from its thinnest parts inward until nothing survives, which is
  // how the card disappears as the real tree grows in underneath it — and it
  // reads as foliage thinning rather than as a tree going ghostly.
  material.alphaTestNode = mix(float(1.02), float(0.34), handover)
  return material
}
