import { ExternalStore } from '../terrain/core/ExternalStore'
import {
  generateForestLayoutInRegion,
  generateForestRockLayoutInRegion,
  type ForestPresetId,
  type GeneratedForestRock,
} from '../tree/forestPresets'
import { treePrototypeId, type TreePlacement } from '../tree/TreeEditorStore'
import {
  buildForestRegion,
  type ForestField,
  type ForestFieldNode,
  type ForestRegion,
} from './forestField'

/** What one field grew into. Discarded and rebuilt whenever the spline moves. */
export interface ForestFieldBake {
  fieldId: string
  placements: readonly TreePlacement[]
  rocks: readonly GeneratedForestRock[]
  /** Every prototype the placements reference, so the scene can compile them. */
  prototypeIds: readonly string[]
  /** Ground normal per placement id, for the trunk contact decals. */
  groundNormals: ReadonlyMap<string, readonly [number, number, number]>
  /** The coverage raster, kept for the floor blend and the ground-cover paint. */
  region: ForestRegion
  /** Milliseconds the bake took, for the status line. */
  elapsedMs: number
}

export interface ForestFieldSnapshot {
  fields: readonly ForestField[]
  bakes: Readonly<Record<string, ForestFieldBake>>
  selectedFieldId?: string
  /** The node the pointer is dragging, if any. */
  activeNodeIndex?: number
  /**
   * Whether clicking the terrain appends a node.
   *
   * Drawing and editing are the same tool, as they are in Unreal: a click on
   * empty ground extends the spline, a drag on a node moves it. This flag is
   * what a newly created field starts in and what "Finish" turns off, so a
   * viewer who has finished a shape can drag its nodes without every stray
   * click adding another one.
   */
  drawing: boolean
  /**
   * True while a node is being dragged.
   *
   * The bake driver refuses to run while it is set, which is what makes
   * dragging a control point on a two-thousand-stem forest free: the spline
   * redraws every pointer move, the forest regrows once, on release.
   */
  interacting: boolean
  /** Whether releasing a drag regrows the field, or waits to be asked. */
  autoGrow: boolean
  /** Set by an explicit Grow, so a field regrows even with auto-grow off. */
  growRequested: boolean
  /** Revision bumped whenever any spline geometry changes, for the overlay. */
  splineRevision: number
  status: string
}

/**
 * Stems past which this machine has been measured to struggle.
 *
 * A hundred and eighty. Measured, not guessed: a stand of about a hundred and
 * sixty planted trees is where this hardware stops holding a comfortable frame
 * rate, and a forest field at full density over a couple of hundred metres
 * produces two to three times that.
 *
 * Recorded rather than enforced. A field that wants six hundred stems is a
 * legitimate thing to author — for a capture, for a different machine — and
 * refusing to grow it would be worse than saying so in the status line.
 */
export const FOREST_STEM_WARNING = 180

let nextFieldNumber = 1

export class ForestFieldStore extends ExternalStore<ForestFieldSnapshot> {
  constructor() {
    super({
      fields: [],
      bakes: {},
      drawing: false,
      interacting: false,
      autoGrow: true,
      growRequested: false,
      splineRevision: 0,
      status: 'No forests drawn',
    })
  }

  patch(values: Partial<ForestFieldSnapshot>): void {
    this.update((current) => ({ ...current, ...values }))
  }

  get selectedField(): ForestField | undefined {
    const snapshot = this.getSnapshot()
    return snapshot.fields.find((field) => field.id === snapshot.selectedFieldId)
  }

  /** Starts a new, empty spline and puts the tool into drawing mode. */
  createField(preset: ForestPresetId = 'mossy-old-growth'): string {
    const id = `forest-${nextFieldNumber++}`
    const field: ForestField = {
      id,
      name: `Forest ${nextFieldNumber - 1}`,
      nodes: [],
      closed: true,
      width: 30,
      // Twenty-five metres of fringe. A stand that thins over less than about
      // a crown diameter still reads as a wall of trees with a line under it.
      feather: 25,
      preset,
      // Not 1.
      //
      // A full-density field over a couple of hundred metres of ground comes
      // out at four hundred stems, and this machine is measured to hold about
      // a hundred and sixty comfortably — so the very first forest a viewer
      // draws would run at a sixth of the frame rate the editor otherwise
      // does. Opening at a stand that is thinner than a closed high forest and
      // letting it be raised is a better first minute than opening at one that
      // is correct and unusable.
      density: 0.6,
      seed: 1 + Math.floor(Math.random() * 0x7ffffffe),
      visible: true,
      dirty: true,
    }
    this.update((current) => ({
      ...current,
      fields: [...current.fields, field],
      selectedFieldId: id,
      activeNodeIndex: undefined,
      drawing: true,
      status: 'Click the terrain to drop spline nodes · Enter to finish',
    }))
    return id
  }

  selectField(id?: string): void {
    this.patch({
      selectedFieldId: id,
      activeNodeIndex: undefined,
      drawing: false,
      status: id ? 'Forest field selected' : 'Selection cleared',
    })
  }

  removeField(id: string): void {
    this.update((current) => {
      const bakes = { ...current.bakes }
      delete bakes[id]
      return {
        ...current,
        fields: current.fields.filter((field) => field.id !== id),
        bakes,
        selectedFieldId: current.selectedFieldId === id ? undefined : current.selectedFieldId,
        drawing: false,
        splineRevision: current.splineRevision + 1,
        status: 'Forest field removed',
      }
    })
  }

  patchField(id: string, values: Partial<ForestField>): void {
    this.update((current) => ({
      ...current,
      fields: current.fields.map((field) =>
        field.id === id ? { ...field, ...values, dirty: true } : field,
      ),
      splineRevision: current.splineRevision + 1,
    }))
  }

  appendNode(id: string, node: ForestFieldNode): void {
    this.update((current) => ({
      ...current,
      fields: current.fields.map((field) =>
        field.id === id
          ? { ...field, nodes: [...field.nodes, node], dirty: true }
          : field,
      ),
      splineRevision: current.splineRevision + 1,
      status: 'Node added',
    }))
  }

  /**
   * Moves one control point.
   *
   * Deliberately does not rebuild anything: a drag is dozens of these a second
   * and a rebake is a layout pass over a quarter of a million candidates. The
   * field is simply marked dirty and the overlay redraws the curve, which is
   * the part a viewer is actually watching while they drag.
   */
  moveNode(id: string, index: number, node: ForestFieldNode): void {
    this.update((current) => ({
      ...current,
      fields: current.fields.map((field) => {
        if (field.id !== id) return field
        if (index < 0 || index >= field.nodes.length) return field
        const nodes = [...field.nodes]
        nodes[index] = node
        return { ...field, nodes, dirty: true }
      }),
      splineRevision: current.splineRevision + 1,
    }))
  }

  removeNode(id: string, index: number): void {
    this.update((current) => ({
      ...current,
      fields: current.fields.map((field) =>
        field.id === id
          ? { ...field, nodes: field.nodes.filter((_, i) => i !== index), dirty: true }
          : field,
      ),
      activeNodeIndex: undefined,
      splineRevision: current.splineRevision + 1,
      status: 'Node removed',
    }))
  }

  finishDrawing(): void {
    this.patch({ drawing: false, status: 'Spline finished · drag its nodes to reshape it' })
  }

  markAllDirty(): void {
    this.update((current) => ({
      ...current,
      fields: current.fields.map((field) => ({ ...field, dirty: true })),
    }))
  }

  /** Asks for one pass of growing, whatever auto-grow is set to. */
  requestGrow(id?: string): void {
    this.update((current) => ({
      ...current,
      fields: current.fields.map((field) =>
        !id || field.id === id ? { ...field, dirty: true } : field,
      ),
      growRequested: true,
      status: id ? 'Growing the field…' : 'Growing every field…',
    }))
  }

  /**
   * The next field to grow, or nothing.
   *
   * Returns nothing at all while a node is being dragged: that is the promise
   * the spline tool makes, and the one that keeps a drag interactive.
   */
  nextDirtyField(): ForestField | undefined {
    const snapshot = this.getSnapshot()
    if (snapshot.interacting) return undefined
    if (!snapshot.autoGrow && !snapshot.growRequested) return undefined
    const field = snapshot.fields.find(
      (candidate) => candidate.dirty && candidate.nodes.length >= 2,
    )
    if (!field && snapshot.growRequested) this.patch({ growRequested: false })
    return field
  }

  /**
   * Grows one field.
   *
   * Explicit, and one field per call, because this is the expensive operation
   * in the whole system: a raster, a rejection-sampled layout over up to six
   * hundred thousand candidates, and a terrain height query per accepted stem.
   * Nothing about a drag triggers it — which is the point, and what makes
   * dragging a node on a two-thousand-stem forest cost nothing at all.
   */
  bakeField(field: ForestField, sampleGround: GroundSampler): void {
    const started = performance.now()
    const region = buildForestRegion(field)
    if (!region) {
      this.update((current) => ({
        ...current,
        fields: current.fields.map((entry) =>
          entry.id === field.id ? { ...entry, dirty: false } : entry,
        ),
        status: 'A forest field needs at least two nodes',
      }))
      return
    }

    const layout = generateForestLayoutInRegion(
      field.preset,
      field.seed,
      region,
      field.density,
    )
    const prototypeIds = new Set<string>()
    const placements: TreePlacement[] = []
    const groundNormals = new Map<string, readonly [number, number, number]>()
    let rejectedForSlope = 0
    for (const [index, tree] of layout.entries()) {
      const ground = sampleGround(tree.position[0], tree.position[2])
      if (ground.slope > MAX_PLANTING_SLOPE) {
        rejectedForSlope += 1
        continue
      }
      const prototypeId = treePrototypeId(tree.species, tree.variation)
      prototypeIds.add(prototypeId)
      const id = `${field.id}-t${index}`
      groundNormals.set(id, ground.normal)
      placements.push({
        id,
        prototypeId,
        // The layout's own y is the deadfall lift — a fallen bole resting on
        // its own radius — so it is added to the ground rather than replacing
        // it. Everything else arrives at zero and simply lands.
        position: [tree.position[0], ground.height + tree.position[1], tree.position[2]],
        rotation: tree.rotation,
        scale: tree.scale,
        tilt: tree.tilt || undefined,
      })
    }

    const rocks = generateForestRockLayoutInRegion(
      field.preset,
      field.seed,
      region,
      field.density,
    ).map((rock) => ({
      ...rock,
      position: [
        rock.position[0],
        sampleGround(rock.position[0], rock.position[2]).height,
        rock.position[2],
      ] as readonly [number, number, number],
    }))

    const elapsedMs = performance.now() - started
    const bake: ForestFieldBake = {
      fieldId: field.id,
      placements,
      rocks,
      prototypeIds: [...prototypeIds],
      groundNormals,
      region,
      elapsedMs,
    }

    this.update((current) => {
      const fields = current.fields.map((entry) =>
        entry.id === field.id ? { ...entry, dirty: false } : entry,
      )
      const bakes = { ...current.bakes, [field.id]: bake }
      const total = Object.values(bakes).reduce(
        (sum, entry) => sum + entry.placements.length,
        0,
      )
      const slopeNote = rejectedForSlope > 0
        ? ` · ${rejectedForSlope} dropped on steep ground`
        : ''
      const warning = total > FOREST_STEM_WARNING
        ? ` · ${total} stems in the world, past the ${FOREST_STEM_WARNING} this machine holds comfortably`
        : ''
      return {
        ...current,
        fields,
        bakes,
        status: `${field.name}: ${placements.length} stems in ${elapsedMs.toFixed(0)} ms${slopeNote}${warning}`,
      }
    })
  }
}

/**
 * Steepest ground a stem is planted on, as a gradient rather than an angle.
 *
 * 0.85 is about forty degrees. Trees do grow on slopes steeper than that, but
 * their root plates tilt and their boles sweep, and this generator produces
 * neither — so a stem planted on a cliff reads as a pole driven into rock,
 * which is worse than a bare cliff.
 */
const MAX_PLANTING_SLOPE = 0.85

export interface GroundSample {
  height: number
  /** Gradient magnitude: rise over run, not degrees. */
  slope: number
  /** Unit surface normal built from the same two differences. */
  normal: readonly [number, number, number]
}

export type GroundSampler = (x: number, z: number) => GroundSample

/**
 * Height and slope from a plain height query.
 *
 * Central differences over a couple of metres rather than the terrain's own
 * normals: the compiled mesh's normal includes every bump the relief shader
 * puts on it, and a stem should be rejected for standing on a mountainside,
 * not for standing on a boulder.
 */
export function createGroundSampler(
  sampleHeight: (x: number, z: number) => number,
  step = 2,
): GroundSampler {
  return (x, z) => {
    const height = sampleHeight(x, z)
    const dx = (sampleHeight(x + step, z) - sampleHeight(x - step, z)) / (2 * step)
    const dz = (sampleHeight(x, z + step) - sampleHeight(x, z - step)) / (2 * step)
    const length = Math.hypot(dx, 1, dz)
    return {
      height,
      slope: Math.hypot(dx, dz),
      normal: [-dx / length, 1 / length, -dz / length],
    }
  }
}
