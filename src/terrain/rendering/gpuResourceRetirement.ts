/**
 * Deferred disposal of GPU-backed Three resources.
 *
 * Disposing a geometry, material or texture destroys its WebGPU buffers the
 * moment it is called, and two properties of the renderer make the *timing* of
 * that call load-bearing:
 *
 *  - A command encoder is open for the whole of `renderer.render()`. A buffer
 *    destroyed while the encoder holds a reference to it fails validation at
 *    submit, not at destruction.
 *  - `compileAsync` captures a work list and then walks it across `await`
 *    boundaries, re-initialising geometry attributes as it goes. Disposing a
 *    resource that is still in a captured work list resurrects a destroyed
 *    buffer handle inside the backend's attribute cache, and every later frame
 *    that draws it fails.
 *
 * Retirements are therefore queued and released from `drainGpuRetirements()`,
 * which the render pipeline calls at the top of a frame — before it encodes
 * anything and never inside a compile. Each batch is also held for one full
 * frame so a resource dropped by a React commit mid-frame is never destroyed
 * inside the render that still lists it.
 */

type Retirement = () => void

/** Retirements queued since the last drain. */
let queued: Retirement[] = []
/** When the oldest undrained retirement was queued. */
let queuedSince = 0
/** The previous drain's queue, released at the start of the next frame. */
let holding: Retirement[] = []
let compileDepth = 0
let lastFrameDrain = 0
let fallbackTimer: ReturnType<typeof setTimeout> | undefined

/** How long the renderer may be idle before retirement stops waiting for it. */
const IDLE_DRAIN_DELAY_MS = 250

/**
 * How long a retirement may be held back by an in-flight compile.
 *
 * The compile gate exists to stop a disposal landing inside a captured work
 * list, which is a narrow race. Waiting on it without a bound is not: a forest
 * that re-warms as the camera moves can keep a compile in flight more or less
 * permanently, and the queue then grows by a geometry batch per reclassify
 * until the tab is killed. A held resource is at worst a stale handle for a
 * frame; a queue that never drains is a crash, so the bound wins.
 */
const MAX_COMPILE_HOLD_MS = 1_200

/** Queues a disposal for the next safe point in the frame. */
export function retireGpuResource(dispose: Retirement): void {
  if (queued.length === 0) queuedSince = now()
  queued.push(dispose)
  scheduleIdleDrain()
}

/**
 * Releases everything that has been queued for a full frame. Safe only where
 * the renderer owns no open encoder: the top of a frame, or an idle renderer.
 */
export function drainGpuRetirements(): void {
  // A compile is walking a work list that may still name these resources —
  // but only for as long as `MAX_COMPILE_HOLD_MS`.
  if (compileDepth > 0 && now() - queuedSince < MAX_COMPILE_HOLD_MS) return
  if (holding.length > 0) {
    const batch = holding
    holding = []
    for (const retire of batch) retire()
  }
  if (queued.length > 0) {
    holding = queued
    queued = []
    queuedSince = now()
  }
}

/** Frame-driven drain. Also records that the renderer is live. */
export function drainGpuRetirementsForFrame(): void {
  lastFrameDrain = now()
  drainGpuRetirements()
}

/**
 * Marks an asynchronous pipeline compile as in flight. Retirement waits for
 * every tracked compile to finish, because `compileAsync` keeps using the
 * geometries it captured long after the call returns control to the caller.
 */
export async function trackGpuCompilation<T>(run: () => Promise<T>): Promise<T> {
  compileDepth += 1
  try {
    return await run()
  } finally {
    compileDepth -= 1
  }
}

/** Diagnostic for the review harness: how much is waiting to be released. */
export function gpuRetirementBacklog(): number {
  return queued.length + holding.length
}

/** Test hook: releases everything immediately. */
export function flushGpuRetirements(): void {
  compileDepth = 0
  drainGpuRetirements()
  drainGpuRetirements()
}

/**
 * A workspace can be unmounted, or the canvas hidden, with resources still
 * queued. Nothing is encoding then, so a timer is a safe fallback — but only
 * once the frame loop has actually stopped calling in.
 */
function scheduleIdleDrain(): void {
  if (fallbackTimer !== undefined) return
  fallbackTimer = setTimeout(() => {
    fallbackTimer = undefined
    if (queued.length === 0 && holding.length === 0) return
    if (now() - lastFrameDrain < IDLE_DRAIN_DELAY_MS) {
      scheduleIdleDrain()
      return
    }
    drainGpuRetirements()
    drainGpuRetirements()
    if (queued.length > 0 || holding.length > 0) scheduleIdleDrain()
  }, IDLE_DRAIN_DELAY_MS)
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}
