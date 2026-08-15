export interface BenchmarkSample {
  name: string
  durationMs: number
  timestamp: number
}

export class BenchmarkHistory {
  private samples: BenchmarkSample[] = []

  record(name: string, durationMs: number): void {
    this.samples.push({ name, durationMs, timestamp: performance.now() })
    if (this.samples.length > 240) this.samples.splice(0, this.samples.length - 240)
  }

  percentile(name: string, quantile: number): number {
    const values = this.samples
      .filter((sample) => sample.name === name)
      .map((sample) => sample.durationMs)
      .sort((a, b) => a - b)
    if (values.length === 0) return 0
    const index = Math.min(values.length - 1, Math.floor(values.length * quantile))
    return values[index]
  }

  snapshot(): readonly BenchmarkSample[] {
    return this.samples
  }
}
