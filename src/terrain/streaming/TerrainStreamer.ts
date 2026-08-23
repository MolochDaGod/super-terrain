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

export interface StreamingView {
  focus: Vec3Like
  verticalFovRadians: number
  aspect: number
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
  viewAlignment = 0,
): number {
  return (
    10_000 -
    distanceInSections * 350 +
    Math.max(0, forwardAlignment) * 900 +
    clamp(viewAlignment, -1, 1) * 1_200 +
    (visible ? 1_500 : 0) +
    (editFocused ? 10_000 : 0)
  )
}

export class TerrainStreamer {
  private readonly config: TerrainConfig
  private residency = new Map<SectionId, ResidencyRecord>()
  private desired = new Set<SectionId>()
  private visible = new Set<SectionId>()
  private previousPosition?: Vec3Like
  private previousUpdate = performance.now()
  private velocity = { x: 0, y: 0, z: 0 }
  private loadEvents: number[] = []
  private evictionEvents: number[] = []
  private visibleRadius?: number
  private targetVisibleRadius?: number

  constructor(config: TerrainConfig) {
    this.config = config
  }

  update(
    camera: Vec3Like,
    qualityScale: number,
    editFocus?: Vec3Like,
    now = performance.now(),
    view?: StreamingView,
  ): StreamCandidate[] {
    const trackingPoint = view?.focus ?? camera
    const deltaSeconds = Math.max((now - this.previousUpdate) / 1000, 1 / 240)
    if (this.previousPosition) {
      const smoothing = 0.18
      this.velocity.x +=
        ((trackingPoint.x - this.previousPosition.x) / deltaSeconds - this.velocity.x) *
        smoothing
      this.velocity.y +=
        ((trackingPoint.y - this.previousPosition.y) / deltaSeconds - this.velocity.y) *
        smoothing
      this.velocity.z +=
        ((trackingPoint.z - this.previousPosition.z) / deltaSeconds - this.velocity.z) *
        smoothing
    }
    this.previousPosition = { ...trackingPoint }
    this.previousUpdate = now

    const center = worldToSection(
      trackingPoint.x,
      trackingPoint.z,
      this.config.sectionSize,
    )
    // The visible working set is centered on the orbit/fly target and expands
    // with the projected viewport footprint. Frame pressure is absorbed by LOD
    // and prefetch first; it must never make already-visible terrain disappear.
    const requiredRadius = requiredViewRadiusSections(this.config, camera, view)
    this.targetVisibleRadius = requiredRadius
    this.visibleRadius =
      this.visibleRadius === undefined || requiredRadius >= this.visibleRadius
        ? requiredRadius
        : Math.max(requiredRadius, this.visibleRadius - deltaSeconds * 0.35)
    const baseRadius = this.visibleRadius
    const prefetch = Math.max(
      0,
      Math.round(this.config.prefetchSections * clamp((qualityScale - 0.45) * 1.8, 0, 1)),
    )
    const visibilityHysteresis = 1
    const searchRadius = Math.ceil(
      baseRadius + Math.max(prefetch, visibilityHysteresis),
    )
    const speed = Math.hypot(this.velocity.x, this.velocity.z)
    const forwardX = speed > 1 ? this.velocity.x / speed : 0
    const forwardZ = speed > 1 ? this.velocity.z / speed : 0
    const viewDirectionX = trackingPoint.x - camera.x
    const viewDirectionZ = trackingPoint.z - camera.z
    const viewDirectionLength = Math.hypot(viewDirectionX, viewDirectionZ) || 1
    const viewForwardX = viewDirectionX / viewDirectionLength
    const viewForwardZ = viewDirectionZ / viewDirectionLength
    const worldHalf = this.config.worldSize * 0.5
    const minSection = Math.floor(-worldHalf / this.config.sectionSize)
    const maxSection = Math.ceil(worldHalf / this.config.sectionSize) - 1
    const nextDesired = new Set<SectionId>()
    const nextVisible = new Set<SectionId>()
    const candidates: StreamCandidate[] = []

    // Clamped to the world rather than swept as a full square around the
    // camera. The residency radius now reaches the far corner of the map, so an
    // unclamped sweep would spend most of its iterations rejecting cells that
    // are outside the world entirely -- roughly eight times as many as the
    // world contains, every frame the camera moves.
    const firstX = Math.max(minSection, center.x - searchRadius)
    const lastX = Math.min(maxSection, center.x + searchRadius)
    const firstZ = Math.max(minSection, center.z - searchRadius)
    const lastZ = Math.min(maxSection, center.z + searchRadius)
    for (let z = firstZ; z <= lastZ; z += 1) {
      const dz = z - center.z
      for (let x = firstX; x <= lastX; x += 1) {
        const dx = x - center.x
        const key = { x, z }
        const distance = Math.hypot(dx, dz)
        if (distance > searchRadius + 0.25) continue
        const alignment = distance > 0 ? (dx * forwardX + dz * forwardZ) / distance : 1
        const sectionWorldX = (key.x + 0.5) * this.config.sectionSize
        const sectionWorldZ = (key.z + 0.5) * this.config.sectionSize
        const viewOffsetX = sectionWorldX - camera.x
        const viewOffsetZ = sectionWorldZ - camera.z
        const viewOffsetLength = Math.hypot(viewOffsetX, viewOffsetZ) || 1
        const viewAlignment =
          (viewOffsetX * viewForwardX + viewOffsetZ * viewForwardZ) /
          viewOffsetLength
        const id = sectionId(key)
        const inBaseRadius =
          distance <= baseRadius + 0.25 ||
          (this.visible.has(id) && distance <= baseRadius + visibilityHysteresis)
        if (!inBaseRadius && alignment < 0.12) continue
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
          priority: streamingPriority(
            distance,
            alignment,
            editFocused,
            inBaseRadius,
            viewAlignment,
          ),
        })
        nextDesired.add(id)
        if (inBaseRadius) nextVisible.add(id)
      }
    }

    this.desired = nextDesired
    this.visible = nextVisible
    candidates.sort((a, b) => b.priority - a.priority)
    this.trimEventHistory(now)
    return candidates
  }

  /**
   * True once camera velocity and the hysteretic visible radius have converged.
   * Until then update() must keep running even for identical camera inputs.
   */
  get isSettled(): boolean {
    return (
      Math.hypot(this.velocity.x, this.velocity.y, this.velocity.z) < 0.1 &&
      this.visibleRadius !== undefined &&
      this.targetVisibleRadius !== undefined &&
      Math.abs(this.visibleRadius - this.targetVisibleRadius) < 0.01
    )
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
    // Mutated rather than replaced: this runs once per resident section per
    // frame, and a thousand fresh records a frame is pure garbage-collector
    // pressure for a record whose identity nothing depends on.
    if (current) {
      current.state = state
      if (this.desired.has(id)) current.lastTouched = now
      if (cpuBytes !== undefined) current.cpuBytes = cpuBytes
      if (gpuBytes !== undefined) current.gpuBytes = gpuBytes
      return
    }
    this.residency.set(id, {
      state,
      lastTouched: now,
      cpuBytes: cpuBytes ?? 0,
      gpuBytes: gpuBytes ?? 0,
    })
  }

  isDesired(key: SectionKey): boolean {
    return this.desired.has(sectionId(key))
  }

  isVisible(key: SectionKey): boolean {
    return this.visible.has(sectionId(key))
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

export function requiredViewRadiusSections(
  config: Pick<
    TerrainConfig,
    | 'sectionSize'
    | 'renderRadiusSections'
    | 'maxRenderRadiusSections'
  >,
  camera: Vec3Like,
  view?: StreamingView,
): number {
  if (!view) return config.renderRadiusSections
  const distanceToFocus = Math.hypot(
    camera.x - view.focus.x,
    camera.y - view.focus.y,
    camera.z - view.focus.z,
  )
  const halfVertical =
    distanceToFocus * Math.tan(clamp(view.verticalFovRadians, 0.2, 2.2) * 0.5)
  const halfViewport = halfVertical * Math.max(1, view.aspect)
  // Two guards cover the full diagonal footprint and keep the exact terrain
  // in front of the coarse horizon proxy. Background residency is controlled
  // separately by prefetch/hysteresis, so this visual guard need not inflate
  // the cold compile queue.
  const footprintRadius = Math.ceil(halfViewport / config.sectionSize) + 2
  return clamp(
    footprintRadius,
    config.renderRadiusSections,
    config.maxRenderRadiusSections,
  )
}
