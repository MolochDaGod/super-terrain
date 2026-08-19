import type { SectionId } from '../core/types'
import type { StreamCandidate } from '../streaming/TerrainStreamer'

/**
 * One byte per terrain section describing whether the streamed mesh is the
 * authoritative visible surface. The array is uploaded directly as a tiny R8
 * texture and sampled by the horizon proxy material.
 */
export class HorizonProxyMask {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
  revision = 0

  private readonly scratch: Uint8Array
  private readonly minSectionX: number
  private readonly minSectionZ: number

  constructor(worldSize: number, sectionSize: number) {
    const worldHalf = worldSize * 0.5
    this.minSectionX = Math.floor(-worldHalf / sectionSize)
    this.minSectionZ = Math.floor(-worldHalf / sectionSize)
    const maxSection = Math.ceil(worldHalf / sectionSize) - 1
    this.width = maxSection - this.minSectionX + 1
    this.height = this.width
    this.data = new Uint8Array(this.width * this.height)
    this.scratch = new Uint8Array(this.data.length)
  }

  update(
    candidates: Iterable<StreamCandidate>,
    isResident: (id: SectionId) => boolean,
  ): boolean {
    this.scratch.fill(0)

    for (const candidate of candidates) {
      if (!candidate.visible || !isResident(candidate.id)) continue
      const x = candidate.key.x - this.minSectionX
      const z = candidate.key.z - this.minSectionZ
      if (x < 0 || x >= this.width || z < 0 || z >= this.height) continue
      this.scratch[z * this.width + x] = 255
    }

    for (let index = 0; index < this.data.length; index += 1) {
      if (this.data[index] === this.scratch[index]) continue
      this.data.set(this.scratch)
      this.revision += 1
      return true
    }
    return false
  }

  clear(): boolean {
    if (!this.data.some(Boolean)) return false
    this.data.fill(0)
    this.revision += 1
    return true
  }
}
