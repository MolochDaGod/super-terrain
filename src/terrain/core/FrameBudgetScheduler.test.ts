import { describe, expect, it, vi } from 'vitest'
import { FrameBudgetScheduler } from './FrameBudgetScheduler'

describe('frame budget scheduler', () => {
  it('defers work that exceeds upload or swap budgets', () => {
    const scheduler = new FrameBudgetScheduler({
      cpuTerrainMs: 2,
      gpuUploadBytes: 1_000,
      sectionSwaps: 1,
    })
    const small = vi.fn()
    const tooLarge = vi.fn()
    scheduler.beginFrame(16)
    scheduler.enqueue({
      id: 'small',
      kind: 'swap',
      priority: 2,
      estimatedCpuMs: 0.1,
      uploadBytes: 500,
      swaps: 1,
      run: small,
    })
    scheduler.enqueue({
      id: 'large',
      kind: 'upload',
      priority: 1,
      estimatedCpuMs: 0.1,
      uploadBytes: 2_000,
      run: tooLarge,
    })
    scheduler.runFrame()
    expect(small).toHaveBeenCalledOnce()
    expect(tooLarge).not.toHaveBeenCalled()
    expect(scheduler.pendingTaskCount).toBe(1)
  })

  it('coalesces tasks by id in favor of the newest equal-priority work', () => {
    const scheduler = new FrameBudgetScheduler({
      cpuTerrainMs: 2,
      gpuUploadBytes: 1_000,
      sectionSwaps: 1,
    })
    const oldTask = vi.fn()
    const newTask = vi.fn()
    scheduler.beginFrame(16)
    scheduler.enqueue({ id: 'preview', kind: 'maintenance', priority: 1, estimatedCpuMs: 0.1, run: oldTask })
    scheduler.enqueue({ id: 'preview', kind: 'maintenance', priority: 1, estimatedCpuMs: 0.1, run: newTask })
    scheduler.runFrame()
    expect(oldTask).not.toHaveBeenCalled()
    expect(newTask).toHaveBeenCalledOnce()
  })

  it('keeps a swap progress floor after a severely over-budget frame', () => {
    const scheduler = new FrameBudgetScheduler({
      cpuTerrainMs: 1.5,
      gpuUploadBytes: 6_000_000,
      sectionSwaps: 2,
      targetFrameMs: 16.67,
    })
    const swap = vi.fn()
    for (let frame = 0; frame < 120; frame += 1) scheduler.beginFrame(40)
    scheduler.enqueue({
      id: 'ready-section',
      kind: 'swap',
      priority: 10,
      estimatedCpuMs: 0.42,
      uploadBytes: 80_000,
      swaps: 1,
      run: swap,
    })
    scheduler.runFrame()
    expect(swap).toHaveBeenCalledOnce()
  })

  it('admits one task that can never fit inside the absolute upload cap', () => {
    const scheduler = new FrameBudgetScheduler({
      cpuTerrainMs: 2,
      gpuUploadBytes: 1_000,
      sectionSwaps: 2,
    })
    const oversized = vi.fn()
    const following = vi.fn()
    scheduler.beginFrame(16)
    scheduler.enqueue({
      id: 'dense-csg-section',
      kind: 'swap',
      priority: 10,
      estimatedCpuMs: 0.42,
      uploadBytes: 1_050,
      swaps: 1,
      run: oversized,
    })
    scheduler.enqueue({
      id: 'ordinary-section',
      kind: 'swap',
      priority: 1,
      estimatedCpuMs: 0.1,
      uploadBytes: 100,
      swaps: 1,
      run: following,
    })

    scheduler.runFrame()

    expect(oversized).toHaveBeenCalledOnce()
    expect(following).not.toHaveBeenCalled()
    expect(scheduler.uploadedBytesThisFrame).toBe(1_050)
    expect(scheduler.pendingTaskCount).toBe(1)

    scheduler.beginFrame(16)
    scheduler.runFrame()
    expect(following).toHaveBeenCalledOnce()
  })

  it('temporarily widens upload budgets while a warm cache is hydrating', () => {
    const scheduler = new FrameBudgetScheduler({
      cpuTerrainMs: 1.5,
      gpuUploadBytes: 1_000,
      sectionSwaps: 1,
    })
    const swaps = [vi.fn(), vi.fn(), vi.fn()]
    scheduler.beginFrame(16, 3)
    for (let index = 0; index < swaps.length; index += 1) {
      scheduler.enqueue({
        id: `cached-${index}`,
        kind: 'swap',
        priority: 10 - index,
        estimatedCpuMs: 0.1,
        uploadBytes: 300,
        swaps: 1,
        run: swaps[index],
      })
    }

    scheduler.runFrame()

    expect(swaps.every((swap) => swap.mock.calls.length === 1)).toBe(true)
  })

  it('prefers what a task class was measured to cost over its declared estimate', () => {
    const scheduler = new FrameBudgetScheduler({
      cpuTerrainMs: 20,
      gpuUploadBytes: 1_000_000,
      sectionSwaps: 8,
    })
    const enqueueSwap = (index: number, run: () => void) =>
      scheduler.enqueue({
        id: `swap:${index}`,
        kind: 'swap',
        priority: 10 - index,
        // Wildly optimistic, exactly like the constants at the real call sites.
        estimatedCpuMs: 0.4,
        uploadBytes: 100,
        swaps: 1,
        run,
      })

    // One frame teaches the scheduler what a swap really costs.
    scheduler.beginFrame(16)
    enqueueSwap(0, () => {
      const until = performance.now() + 12
      while (performance.now() < until) { /* burn a realistic swap */ }
    })
    scheduler.runFrame()
    expect(scheduler.measuredCosts().get('swap')).toBeGreaterThan(8)

    // The next frame charges the following swaps at the measured rate, so the
    // 20 ms allowance no longer admits a whole queue of them on the strength of
    // a 0.4 ms claim.
    scheduler.beginFrame(16)
    const later = [vi.fn(), vi.fn(), vi.fn()]
    later.forEach((run, index) => enqueueSwap(index + 1, run))
    scheduler.runFrame()
    expect(later.filter((run) => run.mock.calls.length === 1)).toHaveLength(1)
    expect(scheduler.pendingTaskCount).toBe(2)
  })

  it('always runs the head of the queue, however small the allowance has become', () => {
    const scheduler = new FrameBudgetScheduler({
      cpuTerrainMs: 4,
      gpuUploadBytes: 1_000_000,
      sectionSwaps: 8,
      targetFrameMs: 16.67,
    })
    // Slow frames shrink the per-frame allowance to its floor. Once a measured
    // cost is larger than that floor, an admission test without a progress
    // guarantee declines the task on every subsequent frame, which stops the
    // queue for good rather than merely slowing it.
    for (let frame = 0; frame < 200; frame += 1) scheduler.beginFrame(90)
    const runs: number[] = []
    for (let frame = 0; frame < 6; frame += 1) {
      scheduler.beginFrame(90)
      scheduler.enqueue({
        id: `swap:${frame}`,
        kind: 'swap',
        priority: 10,
        estimatedCpuMs: 3,
        uploadBytes: 100,
        swaps: 1,
        run: () => {
          runs.push(frame)
          const until = performance.now() + 3
          while (performance.now() < until) { /* over the shrunken allowance */ }
        },
      })
      scheduler.runFrame()
    }
    expect(runs).toHaveLength(6)
  })
})
