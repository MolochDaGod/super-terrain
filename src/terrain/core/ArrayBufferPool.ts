export class ArrayBufferPool {
  private buckets = new Map<number, ArrayBuffer[]>()
  private allocations = 0
  private reuses = 0

  acquire(minimumBytes: number): ArrayBuffer {
    const bucketSize = nextPowerOfTwo(Math.max(256, minimumBytes))
    const bucket = this.buckets.get(bucketSize)
    const buffer = bucket?.pop()
    if (buffer) {
      this.reuses += 1
      return buffer
    }
    this.allocations += 1
    return new ArrayBuffer(bucketSize)
  }

  release(buffer: ArrayBuffer): void {
    if (buffer.byteLength === 0) return
    const bucket = this.buckets.get(buffer.byteLength)
    if (bucket && bucket.length < 16) bucket.push(buffer)
    else if (!bucket) this.buckets.set(buffer.byteLength, [buffer])
  }

  clear(): void {
    this.buckets.clear()
  }

  stats(): { allocations: number; reuses: number; pooled: number } {
    let pooled = 0
    for (const bucket of this.buckets.values()) pooled += bucket.length
    return { allocations: this.allocations, reuses: this.reuses, pooled }
  }
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(value))
}
