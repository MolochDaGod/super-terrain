import { clamp, sectionId, worldToSection } from '../core/bounds'
import type { ResidencyState, SectionId, SectionKey, Vec3Like } from '../core/types'
import type { TerrainConfig } from '../config'

export interface StreamCandidate {
  id: SectionId
  key: SectionKey
  priority: number
  distance: number
  visible: boolean
  prefetch: boolean
}

interface ResidencyRecord {
  state: ResidencyState
  lastTouched: number
  cpuBytes: number
  gpuBytes: number
}

export interface StreamingSnapshot {
  sourceResident: number
  compiledCpu: number
  gpuResident: number
  visible: number
  cpuBytes: number
  gpuBytes: number
  loadsPerSecond: number
  evictionsPerSecond: number
}

export function streamingPriority(
  distanceInSections: number,
  forwardAlignment: number,
  editFocused: boolean,
  visible: boolean,
): number {
  return (
    10_000 -
    distanceInSections * 350 +
    Math.max(0, forwardAlignment) * 900 +
    (visible ? 1_500 : 0) +
    (editFocused ? 10_000 : 0)
  )
}

export class TerrainStreamer {
  private readonly config: TerrainConfig
  private residency = new Map<SectionId, ResidencyRecord>()
  private desired = new Set<SectionId>()
  private previousPosition?: Vec3Like
  private previousUpdate = performance.now()
  private velocity = { x: 0, y: 0, z: 0 }
  private loadEvents: number[] = []
  private evictionEvents: number[] = []

  constructor(config: TerrainConfig) {
    this.config = config
  }

  update(
    camera: Vec3Like,
    qualityScale: number,
    editFocus?: Vec3Like,
    now = performance.now(),
  ): StreamCandidate[] {
    const deltaSeconds = Math.max((now - this.previousUpdate) / 1000, 1 / 240)
    if (this.previousPosition) {
      const smoothing = 0.18
      this.velocity.x +=
        ((camera.x - this.previousPosition.x) / deltaSeconds - this.velocity.x) *
        smoothing
      this.velocity.y +=
        ((camera.y - this.previousPosition.y) / deltaSeconds - this.velocity.y) *
        smoothing
      this.velocity.z +=
        ((camera.z - this.previousPosition.z) / deltaSeconds - this.velocity.z) *
        smoothing
    }
    this.previousPosition = { ...camera }
    this.previousUpdate = now

    const center = worldToSection(camera.x, camera.z, this.config.sectionSize)
    const baseRadius = Math.max(
      2,
      Math.round(this.config.renderRadiusSections * clamp(qualityScale, 0.5, 1)),
    )
    const prefetch = Math.max(
      0,
      Math.round(this.config.prefetchSections * clamp((qualityScale - 0.45) * 1.8, 0, 1)),
    )
    const searchRadius = baseRadius + prefetch
    const speed = Math.hypot(this.velocity.x, this.velocity.z)
    const forwardX = speed > 1 ? this.velocity.x / speed : 0
    const forwardZ = speed > 1 ? this.velocity.z / speed : 0
    const worldHalf = this.config.worldSize * 0.5
    const minSection = Math.floor(-worldHalf / this.config.sectionSize)
    const maxSection = Math.ceil(worldHalf / this.config.sectionSize) - 1
    const nextDesired = new Set<SectionId>()
    const candidates: StreamCandidate[] = []

    for (let dz = -searchRadius; dz <= searchRadius; dz += 1) {
      for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
        const key = { x: center.x + dx, z: center.z + dz }
        if (
          key.x < minSection ||
          key.x > maxSection ||
          key.z < minSection ||
          key.z > maxSection
        ) {
          continue
        }
        const distance = Math.hypot(dx, dz)
        if (distance > searchRadius + 0.25) continue
        const alignment = distance > 0 ? (dx * forwardX + dz * forwardZ) / distance : 1
        const inBaseRadius = distance <= baseRadius + 0.25
        if (!inBaseRadius && alignment < 0.12) continue
        const id = sectionId(key)
        const editSection = editFocus
          ? worldToSection(editFocus.x, editFocus.z, this.config.sectionSize)
          : undefined
        const editFocused = editSection?.x === key.x && editSection.z === key.z
        candidates.push({
          id,
          key,
          distance,
          visible: inBaseRadius,
          prefetch: !inBaseRadius,
          priority: streamingPriority(distance, alignment, editFocused, inBaseRadius),
        })
        nextDesired.add(id)
      }
    }

    this.desired = nextDesired
    candidates.sort((a, b) => b.priority - a.priority)
    this.trimEventHistory(now)
    return candidates
  }

  touch(
    key: SectionKey,
    state: ResidencyState,
    cpuBytes = 0,
    gpuBytes = 0,
    now = performance.now(),
  ): void {
    const id = sectionId(key)
    const previous = this.residency.get(id)
    if (!previous || previous.state === 'UNLOADED') this.loadEvents.push(now)
    this.residency.set(id, { state, lastTouched: now, cpuBytes, gpuBytes })
  }

  setState(
    key: SectionKey,
    state: ResidencyState,
    cpuBytes?: number,
    gpuBytes?: number,
    now = performance.now(),
  ): void {
    const id = sectionId(key)
    const current = this.residency.get(id)
    this.residency.set(id, {
      state,
      lastTouched: this.desired.has(id) ? now : (current?.lastTouched ?? now),
      cpuBytes: cpuBytes ?? current?.cpuBytes ?? 0,
      gpuBytes: gpuBytes ?? current?.gpuBytes ?? 0,
    })
  }

  isDesired(key: SectionKey): boolean {
    return this.desired.has(sectionId(key))
  }

  collectEvictions(now = performance.now()): SectionId[] {
    const snapshot = this.snapshot()
    const overGpu = snapshot.gpuBytes > this.config.maxGpuBytes
    const overCpu = snapshot.cpuBytes > this.config.maxCpuCompiledBytes
    const candidates = [...this.residency.entries()]
      .filter(
        ([id, record]) =>
          !this.desired.has(id) &&
          (overGpu || overCpu || now - record.lastTouched > this.config.sectionRetentionMs),
      )
      .sort((a, b) => a[1].lastTouched - b[1].lastTouched)
    return candidates.map(([id]) => id)
  }

  evicted(id: SectionId, now = performance.now()): void {
    if (this.residency.delete(id)) this.evictionEvents.push(now)
  }

  snapshot(now = performance.now()): StreamingSnapshot {
    this.trimEventHistory(now)
    let sourceResident = 0
    let compiledCpu = 0
    let gpuResident = 0
    let visible = 0
    let cpuBytes = 0
    let gpuBytes = 0
    for (const record of this.residency.values()) {
      sourceResident += record.state !== 'UNLOADED' ? 1 : 0
      compiledCpu +=
        record.state === 'COMPILED_CPU' ||
        record.state === 'GPU_RESIDENT' ||
        record.state === 'VISIBLE'
          ? 1
          : 0
      gpuResident +=
        record.state === 'GPU_RESIDENT' || record.state === 'VISIBLE' ? 1 : 0
      visible += record.state === 'VISIBLE' ? 1 : 0
      cpuBytes += record.cpuBytes
      gpuBytes += record.gpuBytes
    }
    return {
      sourceResident,
      compiledCpu,
      gpuResident,
      visible,
      cpuBytes,
      gpuBytes,
      loadsPerSecond: this.loadEvents.length,
      evictionsPerSecond: this.evictionEvents.length,
    }
  }

  private trimEventHistory(now: number): void {
    const cutoff = now - 1000
    this.loadEvents = this.loadEvents.filter((time) => time >= cutoff)
    this.evictionEvents = this.evictionEvents.filter((time) => time >= cutoff)
  }
}
