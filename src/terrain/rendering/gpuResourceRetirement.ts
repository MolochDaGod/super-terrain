interface SubmittedWorkQueue {
  onSubmittedWorkDone(): Promise<void>
}

let submittedWorkRenderer: unknown
let retirementScheduled = false
let pendingRetirements: Array<() => void> = []

/** Publishes WebGPU's real completion fence to shared renderer cleanup. */
export function configureGpuResourceRetirement(renderer: unknown): () => void {
  submittedWorkRenderer = renderer
  // Keep the renderer during scene teardown because child cleanup effects can
  // run later. A replacement Canvas publishes its renderer here; a destroyed
  // device rejects its completion fence.
  return () => undefined
}

/**
 * Retires resources only after the current encoder is submitted and WebGPU
 * confirms that every queued reference to those resources has completed.
 */
export function retireGpuResource(dispose: () => void): void {
  pendingRetirements.push(dispose)
  if (retirementScheduled) return
  retirementScheduled = true
  setTimeout(() => {
    retirementScheduled = false
    const retirements = pendingRetirements
    pendingRetirements = []
    const queue = (submittedWorkRenderer as {
      backend?: { device?: { queue?: SubmittedWorkQueue } }
    } | undefined)?.backend?.device?.queue
    let completed: Promise<void> | undefined
    try {
      completed = queue?.onSubmittedWorkDone()
    } catch {
      completed = undefined
    }
    if (!completed) {
      for (const retire of retirements) retire()
      return
    }
    void completed.then(
      () => {
        for (const retire of retirements) retire()
      },
      () => {
        // A lost device owns no usable submitted work. Releasing CPU-side
        // Three resources is safe and avoids compounding the loss with leaks.
        for (const retire of retirements) retire()
      },
    )
  }, 0)
}
