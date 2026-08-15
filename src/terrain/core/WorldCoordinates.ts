import type { SectionKey, Vec3Like } from './types'

export interface RenderOrigin {
  section: SectionKey
  world: Vec3Like
}

/** Keeps section identity integer-based and centralizes future origin rebasing. */
export class WorldCoordinates {
  readonly sectionSize: number
  private origin: RenderOrigin = {
    section: { x: 0, z: 0 },
    world: { x: 0, y: 0, z: 0 },
  }

  constructor(sectionSize: number) {
    this.sectionSize = sectionSize
  }

  get renderOrigin(): RenderOrigin {
    return this.origin
  }

  updateForCamera(camera: Vec3Like, threshold = 4_096): RenderOrigin | undefined {
    const distance = Math.hypot(
      camera.x - this.origin.world.x,
      camera.z - this.origin.world.z,
    )
    if (distance < threshold) return undefined
    const section = {
      x: Math.floor(camera.x / this.sectionSize),
      z: Math.floor(camera.z / this.sectionSize),
    }
    this.origin = {
      section,
      world: {
        x: section.x * this.sectionSize,
        y: 0,
        z: section.z * this.sectionSize,
      },
    }
    return this.origin
  }

  toRenderPosition(world: Vec3Like): Vec3Like {
    return {
      x: world.x - this.origin.world.x,
      y: world.y - this.origin.world.y,
      z: world.z - this.origin.world.z,
    }
  }
}
