import type { Object3D } from 'three/webgpu'

/**
 * How a scene object says "I am selectable, and this is what I am".
 *
 * Viewport picking is done in one place — see `TerrainView` — rather than by
 * hanging a click handler on every object. One raycast can then compare an
 * object hit against the terrain hit behind it and decide between selecting
 * something and clearing the selection, which two independent handlers racing
 * on the same pointer event cannot do.
 */
export interface PickTarget {
  kind: 'rock' | 'light' | 'modifier'
  id: string
}

export function pickTargetOf(object: Object3D): PickTarget | undefined {
  let node: Object3D | null = object
  while (node) {
    const target = node.userData.pickTarget as PickTarget | undefined
    if (target) return target
    node = node.parent
  }
  return undefined
}
