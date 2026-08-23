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

  /**
   * Replaces the snapshot without waking subscribers.
   *
   * For state that a `useFrame` consumer reads straight off `getSnapshot` and
   * that React only ever displays: the value must be current the moment it is
   * asked for, but nothing has to re-render at the rate it changes. A caller
   * using this owes its subscribers a `notifyListeners` at some sensible rate.
   */
  protected setWithoutNotifying(next: T): void {
    if (Object.is(next, this.snapshot)) return
    this.snapshot = next
  }

  protected notifyListeners(): void {
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
