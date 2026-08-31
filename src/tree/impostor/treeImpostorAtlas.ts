import {
  LinearFilter,
  OrthographicCamera,
  RenderTarget,
  Vector3,
  type Object3D,
  type Renderer,
} from 'three/webgpu'
import type { TreeBounds } from '../generator/types'

/**
 * Distant trees, as baked cards rather than as geometry.
 *
 * A forested hillside is thousands of trees. This renderer draws them as real
 * meshes, and on the machine this was measured on a hundred and sixty of those
 * is the ceiling before the tab dies — so a forest could only ever be a copse,
 * and a *range* of forested slopes was not expressible at all. That is not a
 * tuning problem with the tree generator; a closed stand at 560 stems a hectare
 * covering a single square kilometre is fifty-six thousand stems, and no amount
 * of mesh simplification gets real geometry to that number.
 *
 * What gets there is the observation that past forty or fifty metres a conifer
 * is a silhouette with some shading in it. Two triangles carrying a baked
 * picture of that silhouette cost about a four-thousandth of the geometry, and
 * at the range where they are used the difference is not visible — which is why
 * every open-world renderer that has ever drawn a forest does this.
 *
 * ## What is baked
 *
 * Sixteen views of one tree: eight compass bearings at eye level and the same
 * eight from thirty degrees up, laid out in a four-by-four grid. Eight bearings
 * is enough because a tree is roughly radially symmetric and the shader blends
 * the two nearest; the second elevation row exists because this is a terrain
 * editor whose camera spends much of its life above the canopy looking down,
 * and a single eye-level row seen from above is a row of cards edge-on.
 *
 * One atlas: rgb the shaded colour, a the coverage mask. The tree is baked
 * *as it is lit*, which is a real limitation and a deliberate one. Baking a
 * world-normal atlas as well and relighting the card per frame is the textbook
 * answer, and it needs a material override across a NodeMaterial tree whose
 * foliage is already several batched instanced meshes — a large amount of
 * machinery to buy correctness under a moving sun, in an editor whose sun does
 * not move while you look at a hillside. What the cards do instead is carry a
 * per-instance lighting term of their own, so a stand still has light and shade
 * across it rather than being one flat stamp repeated.
 *
 * ## Why it is baked a view at a time
 *
 * Rendering sixteen views of a full tree in one go is a stall of a few hundred
 * milliseconds, on the frame a forest first comes into range — which is exactly
 * the frame the viewer is moving. `bakeNextView` renders exactly one cell per
 * call and reports whether more remain, so the caller can spend one view per
 * frame and the cost never appears as a hitch. The atlas is allocated up front
 * and handed out immediately, so the impostor material binds it once, is never
 * rebuilt, and simply gets better-looking over the following sixteen frames.
 */

/** Bearings around the tree. */
export const IMPOSTOR_YAW_STEPS = 8
/** Elevation rows: eye level, and looking down from thirty degrees. */
export const IMPOSTOR_PITCH_STEPS = 2
export const IMPOSTOR_PITCHES = [0, Math.PI / 6] as const
/** Cells per atlas row, and therefore the grid. */
export const IMPOSTOR_GRID = 4
/** Pixels per cell. Four across a 2048 atlas. */
export const IMPOSTOR_CELL = 512
export const IMPOSTOR_ATLAS_SIZE = IMPOSTOR_CELL * IMPOSTOR_GRID
export const IMPOSTOR_VIEW_COUNT = IMPOSTOR_YAW_STEPS * IMPOSTOR_PITCH_STEPS

export interface TreeImpostorAtlas {
  /** rgb shaded albedo, a coverage. */
  albedo: RenderTarget
  /**
   * Half-width and half-height of the card in metres, and the height of the
   * bounds centre above the trunk base.
   *
   * The card is not the tree's bounding box: it is the box the bake camera
   * framed, so the quad the shader builds and the pixels in the cell agree
   * exactly. Getting this wrong does not look like a sizing error — it looks
   * like the trees are floating, or sunk, or the wrong species.
   */
  radius: number
  halfHeight: number
  centreHeight: number
  /** Views still to render. Zero means the atlas is complete. */
  pending: number
  dispose(): void
}

function createTarget(name: string): RenderTarget {
  const target = new RenderTarget(IMPOSTOR_ATLAS_SIZE, IMPOSTOR_ATLAS_SIZE, {
    depthBuffer: true,
    // Every cell is written once and read at every scale afterwards, so the
    // atlas wants mipmaps — but they must not bleed one bearing into the next.
    // Generating them is left to the sampler's own minification: a cell is 512
    // pixels and an impostor is at most a few dozen across, so the difference
    // between a mipped and an unmipped fetch here is one of cost, not of
    // correctness, and the seam a mip chain would introduce across cell
    // boundaries is a real artefact rather than a theoretical one.
    generateMipmaps: false,
  })
  target.texture.name = name
  target.texture.minFilter = LinearFilter
  target.texture.magFilter = LinearFilter
  return target
}

export function createTreeImpostorAtlas(bounds: TreeBounds): TreeImpostorAtlas {
  // Frame the tree with a little air, so a branch that reaches past the
  // nominal bounds is clipped by the card rather than by the cell.
  const width = Math.max(
    bounds.max.x - bounds.min.x,
    bounds.max.z - bounds.min.z,
  )
  const height = bounds.max.y - bounds.min.y
  const radius = Math.max(width * 0.5, 0.5) * 1.06
  const halfHeight = Math.max(height * 0.5, 0.5) * 1.04
  return {
    albedo: createTarget('tree impostor albedo'),
    radius,
    halfHeight,
    centreHeight: (bounds.max.y + bounds.min.y) * 0.5 - bounds.min.y,
    // One extra step, spent entirely on clearing. See `bakeNextView`.
    pending: IMPOSTOR_VIEW_COUNT + 1,
    dispose() {
      this.albedo.dispose()
    },
  }
}

/** Where one view sits in the atlas, in cells. */
export function impostorCell(view: number): { column: number; row: number } {
  return { column: view % IMPOSTOR_GRID, row: Math.floor(view / IMPOSTOR_GRID) }
}

/** The bearing and elevation one view was baked from. */
export function impostorDirection(view: number): Vector3 {
  const yawIndex = view % IMPOSTOR_YAW_STEPS
  const pitchIndex = Math.floor(view / IMPOSTOR_YAW_STEPS)
  const yaw = (yawIndex / IMPOSTOR_YAW_STEPS) * Math.PI * 2
  const pitch = IMPOSTOR_PITCHES[pitchIndex] ?? 0
  return new Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  )
}

const bakeCamera = /*@__PURE__*/ new OrthographicCamera()
const bakeTarget = /*@__PURE__*/ new Vector3()
const bakeEye = /*@__PURE__*/ new Vector3()

/**
 * Renders exactly one view into the atlas and returns whether more remain.
 *
 * `subject` is the tree, already built and already carrying its own materials —
 * the same object the near ranks draw. Baking what is actually rendered rather
 * than a second, simplified copy is what keeps a card and the geometry it
 * cross-fades into from being visibly different trees.
 */
export function bakeNextView(
  atlas: TreeImpostorAtlas,
  renderer: Renderer,
  scene: Object3D,
  subject: Object3D,
): boolean {
  if (atlas.pending <= 0) return false

  const scissorable = renderer as unknown as {
    autoClear: boolean
    getClearAlpha(): number
    setClearAlpha(alpha: number): void
    setRenderTarget(target: RenderTarget | null): void
    clear(): void
    render(scene: Object3D, camera: OrthographicCamera): void
  }

  // The first step clears and draws nothing.
  //
  // A WebGPU clear is the render pass's `loadOp`, so it covers the whole
  // attachment however the scissor is set, and the viewport is read once when
  // the pass begins — which means a clear and a cell render issued together are
  // one pass with one viewport, and the cell render is lost. Giving the clear a
  // pass of its own is what makes the first bearing appear at all; it was the
  // one empty cell in the atlas for three attempts running.
  if (atlas.pending === IMPOSTOR_VIEW_COUNT + 1) {
    const previousClearAlpha = scissorable.getClearAlpha()
    const previousAutoClear = scissorable.autoClear
    const previousTarget = renderer.getRenderTarget()
    atlas.albedo.viewport.set(0, 0, IMPOSTOR_ATLAS_SIZE, IMPOSTOR_ATLAS_SIZE)
    atlas.albedo.scissorTest = false
    scissorable.setClearAlpha(0)
    try {
      scissorable.setRenderTarget(atlas.albedo)
      scissorable.autoClear = false
      scissorable.clear()
    } finally {
      scissorable.setClearAlpha(previousClearAlpha)
      scissorable.autoClear = previousAutoClear
      scissorable.setRenderTarget(previousTarget as RenderTarget | null)
    }
    atlas.pending -= 1
    return true
  }

  const view = IMPOSTOR_VIEW_COUNT - atlas.pending
  const { column, row } = impostorCell(view)
  const direction = impostorDirection(view)

  bakeTarget.set(0, atlas.centreHeight, 0)
  bakeEye.copy(direction).multiplyScalar(Math.max(atlas.radius, atlas.halfHeight) * 4)
  bakeEye.add(bakeTarget)

  // An orthographic frame, because a card is sampled as if from infinity. A
  // perspective bake gives every view its own vanishing point and the tree
  // appears to lean as the camera walks around it.
  bakeCamera.left = -atlas.radius
  bakeCamera.right = atlas.radius
  bakeCamera.top = atlas.halfHeight
  bakeCamera.bottom = -atlas.halfHeight
  bakeCamera.near = 0.01
  bakeCamera.far = Math.max(atlas.radius, atlas.halfHeight) * 12
  bakeCamera.position.copy(bakeEye)
  bakeCamera.up.set(0, 1, 0)
  bakeCamera.lookAt(bakeTarget)
  bakeCamera.updateProjectionMatrix()
  bakeCamera.updateMatrixWorld(true)

  const x = column * IMPOSTOR_CELL
  const y = row * IMPOSTOR_CELL
  const wasVisible = subject.visible
  subject.visible = true

  // Viewport and scissor are set on the *render target*, not on the renderer.
  //
  // Calling `renderer.setViewport` after `setRenderTarget` looks like it should
  // work and does not: binding a target resets the renderer's viewport to that
  // target's own, so the cell rectangle was overwritten before it was ever used
  // and every view was rendered across the whole 2048-pixel atlas, each one
  // wiping the last. The target's `viewport`/`scissor`/`scissorTest` are what
  // the backend actually reads. They belong to the target, so nothing has to be
  // restored on the renderer afterwards either — which is what was making the
  // editor's own frame land in a 512-pixel corner and the screen go black.

  // The cell must clear to *transparent*, not to the viewport's clear colour,
  // or every gap between the branches fills with opaque sky and each distant
  // tree draws as a solid rectangle instead of a silhouette.
  const previousClearAlpha = scissorable.getClearAlpha()
  const previousAutoClear = scissorable.autoClear
  const previousTarget = renderer.getRenderTarget()
  scissorable.setClearAlpha(0)
  try {
    scissorable.setRenderTarget(atlas.albedo)
    scissorable.autoClear = false
    // Cleared once, before the first view, and never again.
    //
    // In WebGPU a clear is the render pass's `loadOp`, which applies to the
    // whole attachment — the scissor rectangle cannot restrict it, however the
    // API is called. So clearing per cell wiped the fifteen views already baked
    // and the atlas ended up holding only whichever view ran last. The viewport
    // does restrict rasterisation, so after one clear each render writes only
    // its own cell and the rest of the atlas survives untouched.
    atlas.albedo.viewport.set(x, y, IMPOSTOR_CELL, IMPOSTOR_CELL)
    atlas.albedo.scissor.set(x, y, IMPOSTOR_CELL, IMPOSTOR_CELL)
    atlas.albedo.scissorTest = true
    scissorable.render(scene, bakeCamera)
  } finally {
    subject.visible = wasVisible
    scissorable.setClearAlpha(previousClearAlpha)
    scissorable.autoClear = previousAutoClear
    scissorable.setRenderTarget(previousTarget as RenderTarget | null)
  }

  atlas.pending -= 1
  return atlas.pending > 0
}
