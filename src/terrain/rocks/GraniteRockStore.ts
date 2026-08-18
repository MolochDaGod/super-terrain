import {
  cloneGraniteRock,
  normalizeGraniteRockParameters,
  normalizeGraniteRockTransform,
  type GraniteRock,
  type GraniteRockParameters,
  type GraniteRockTransform,
} from './types'

let fallbackRockId = 0

export class GraniteRockStore {
  private rocks: GraniteRock[] = []
  private revision = 0
  private listeners = new Set<() => void>()

  getSnapshot = (): number => this.revision

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  add(rock: GraniteRock): GraniteRock {
    const normalized = normalizeRock(rock)
    this.rocks.push(normalized)
    this.touch()
    return cloneGraniteRock(normalized)
  }

  create(options: {
    name?: string
    parameters: GraniteRockParameters
    transform: GraniteRockTransform
  }): GraniteRock {
    return this.add({
      id: createRockId(),
      name: options.name ?? `Granite ${this.rocks.length + 1}`,
      visible: true,
      parameters: options.parameters,
      transform: options.transform,
    })
  }

  get(id: string): GraniteRock | undefined {
    const rock = this.rocks.find((item) => item.id === id)
    return rock ? cloneGraniteRock(rock) : undefined
  }

  snapshot(): GraniteRock[] {
    return this.rocks.map(cloneGraniteRock)
  }

  updateParameters(id: string, parameters: GraniteRockParameters): boolean {
    const rock = this.rocks.find((item) => item.id === id)
    if (!rock) return false
    rock.parameters = normalizeGraniteRockParameters(parameters)
    this.touch()
    return true
  }

  updateTransform(id: string, transform: GraniteRockTransform): boolean {
    const rock = this.rocks.find((item) => item.id === id)
    if (!rock) return false
    rock.transform = normalizeGraniteRockTransform(transform)
    this.touch()
    return true
  }

  setVisible(id: string, visible: boolean): boolean {
    const rock = this.rocks.find((item) => item.id === id)
    if (!rock || rock.visible === visible) return false
    rock.visible = visible
    this.touch()
    return true
  }

  rename(id: string, name: string): boolean {
    const rock = this.rocks.find((item) => item.id === id)
    if (!rock) return false
    rock.name = name.trim() || rock.name
    this.touch()
    return true
  }

  remove(id: string): GraniteRock | undefined {
    const index = this.rocks.findIndex((item) => item.id === id)
    if (index === -1) return undefined
    const [removed] = this.rocks.splice(index, 1)
    this.touch()
    return cloneGraniteRock(removed)
  }

  replace(rocks: GraniteRock[]): void {
    this.rocks = rocks
      .filter((rock) => rock && typeof rock.id === 'string')
      .map(normalizeRock)
    this.touch()
  }

  clear(): void {
    if (this.rocks.length === 0) return
    this.rocks = []
    this.touch()
  }

  get count(): number {
    return this.rocks.length
  }

  get sourceRevision(): number {
    return this.revision
  }

  private touch(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}

function normalizeRock(rock: GraniteRock): GraniteRock {
  return {
    id: rock.id,
    name: typeof rock.name === 'string' && rock.name.trim() ? rock.name.trim() : 'Granite rock',
    visible: rock.visible !== false,
    parameters: normalizeGraniteRockParameters(rock.parameters),
    transform: normalizeGraniteRockTransform(rock.transform),
  }
}

function createRockId(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${fallbackRockId++}`
  return `rock-${suffix}`
}
