export class ExternalStore<T> {
  private listeners = new Set<() => void>()
  private snapshot: T

  constructor(snapshot: T) {
    this.snapshot = snapshot
  }

  getSnapshot = (): T => this.snapshot

  set(next: T): void {
    if (Object.is(next, this.snapshot)) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  update(updater: (current: T) => T): void {
    this.set(updater(this.snapshot))
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
