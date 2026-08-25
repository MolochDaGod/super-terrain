import { ExternalStore } from '../terrain/core/ExternalStore'
import { DEFAULT_FOLIAGE_WIND, type FoliageWindSettings } from './FoliageSystem'
import type { FoliageSpeciesId } from './foliageSpecies'

export type FoliageTool = 'none' | 'paint' | 'erase'

/**
 * Work that has to happen on the render thread, queued from React.
 *
 * Filling and clearing are compute dispatches, and the renderer only exists
 * inside the frame loop. Queuing the intent rather than reaching for a renderer
 * from an event handler is what keeps the store free of graphics objects.
 */
export type FoliageCommand =
  | { kind: 'fill'; species: FoliageSpeciesId }
  | { kind: 'clear' }
  | { kind: 'reseed' }

export interface FoliageEditorSnapshot {
  /** Whether the layer draws at all. */
  visible: boolean
  tool: FoliageTool
  species: FoliageSpeciesId
  /** Brush footprint in metres. */
  radius: number
  /** Weight added per second of dragging. */
  flow: number
  /** 0 feathered, 1 hard edged. */
  hardness: number
  /** Global clump abundance. */
  density: number
  wind: FoliageWindSettings
  painting: boolean
  status: string
}

export class FoliageEditorStore extends ExternalStore<FoliageEditorSnapshot> {
  private commands: FoliageCommand[] = []

  constructor() {
    super({
      visible: true,
      tool: 'none',
      species: 'meadow-fescue',
      radius: 6,
      flow: 0.5,
      hardness: 0.25,
      density: 1,
      wind: { ...DEFAULT_FOLIAGE_WIND },
      painting: false,
      status: 'Ground cover ready',
    })
  }

  patch(values: Partial<FoliageEditorSnapshot>): void {
    this.update((current) => ({ ...current, ...values }))
  }

  patchWind(values: Partial<FoliageWindSettings>): void {
    this.update((current) => ({
      ...current,
      wind: { ...current.wind, ...values },
    }))
  }

  /** Painting state changes every pointer move; React does not need each one. */
  setPainting(painting: boolean): void {
    if (this.getSnapshot().painting === painting) return
    this.patch({ painting })
  }

  enqueue(command: FoliageCommand): void {
    this.commands.push(command)
  }

  takeCommands(): FoliageCommand[] {
    if (this.commands.length === 0) return EMPTY_COMMANDS
    const pending = this.commands
    this.commands = []
    return pending
  }
}

const EMPTY_COMMANDS: FoliageCommand[] = []
