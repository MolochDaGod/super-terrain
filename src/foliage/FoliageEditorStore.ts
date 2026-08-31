import { ExternalStore } from '../terrain/core/ExternalStore'
import { DEFAULT_FOLIAGE_WIND, type FoliageWindSettings } from './FoliageSystem'
import type { FoliagePaintLayer } from './FoliageMaskField'
import type { FoliageSpeciesId } from './foliageSpecies'
import type { FoliageSurfaceId } from './foliageSurfaces'

export type FoliageTool = 'none' | 'paint' | 'erase'

/**
 * Work that has to happen on the render thread, queued from React.
 *
 * Filling and clearing are compute dispatches, and the renderer only exists
 * inside the frame loop. Queuing the intent rather than reaching for a renderer
 * from an event handler is what keeps the store free of graphics objects.
 */
export type FoliageCommand =
  /** Lay the armed brush over the whole field. */
  | { kind: 'fill' }
  /** Wipe every plant and every ground layer. */
  | { kind: 'clear' }
  /** Wipe, then re-run the floor recipe the workspace opened with. */
  | { kind: 'reseed' }

export interface FoliageEditorSnapshot {
  /** Whether the layer draws at all. */
  visible: boolean
  tool: FoliageTool
  /**
   * Which field the brush writes: the plants standing on the floor, or the
   * floor itself. The two palettes are separate because they are separate
   * data; picking from either one arms it.
   */
  layer: FoliagePaintLayer
  species: FoliageSpeciesId
  /** The armed ground layer, used when `layer` is `surface`. */
  surface: FoliageSurfaceId
  /** Brush footprint in metres. */
  radius: number
  /** Weight added per second of dragging. */
  flow: number
  /** 0 feathered, 1 hard edged. */
  hardness: number
  /** Global clump abundance. */
  density: number
  /**
   * Whether open ground outside the forest fields grows grass of its own.
   *
   * On by default: a world whose hillsides are bare unless somebody paints a
   * forest onto them is the state this replaced. Off is for authoring, where
   * seeing only what has been placed by hand is the point — and for measuring,
   * since the grassland is the largest single population the layer draws.
   */
  grassland: boolean
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
      layer: 'plants',
      species: 'meadow-fescue',
      surface: 'leaf-litter',
      radius: 6,
      flow: 0.5,
      hardness: 0.25,
      density: 1,
      grassland: true,
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
