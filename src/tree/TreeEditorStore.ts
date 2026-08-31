import { ExternalStore } from '../terrain/core/ExternalStore'
import {
  DEFAULT_TREE_PARAMETERS,
  MAX_FOLIAGE_DENSITY,
  TREE_SPECIES_PRESETS,
  normalizeTreeParameters,
  type ProceduralTreeAsset,
  type TreeLodLevel,
  type TreeParameters,
  type TreeSpecies,
} from './generator/types'
import {
  generateForestLayout,
  generateForestRockLayout,
  type GeneratedForestRock,
  type ForestPresetId,
} from './forestPresets'

export type TreeDebugMode =
  | 'surface'
  | 'skeleton'
  | 'hierarchy'
  | 'continuations'
  | 'radii'
  | 'contacts'
  | 'burial'
  | 'topology'

export type ForestPosition = readonly [number, number, number]

/**
 * The collections the scene panel lists, one open at a time.
 *
 * Same arrangement as the terrain editor's `InspectorSection`, and for the same
 * reason: a single column that answers "what is in this forest" without also
 * trying to answer "what are this tree's numbers".
 */
export type TreeSceneSection = 'forest' | 'catalogue' | 'floor' | 'placements'

export interface TreePrototype {
  id: string
  species: TreeSpecies
  variation: number
  variationName: string
  parameters: TreeParameters
  asset?: ProceduralTreeAsset
  dirty: boolean
  building: boolean
  warmingMaterials: boolean
  buildRevision: number
  compiledRevision?: number
  buildProgress: number
  status: string
}

export interface TreePlacement {
  id: string
  prototypeId: string
  position: ForestPosition
  rotation: number
  scale: number
  /** Pitch in radians. Non-zero means deadfall: a fallen, leafless stem. */
  tilt?: number
}

export interface TreeEditorSnapshot {
  prototypes: Readonly<Record<string, TreePrototype>>
  placements: readonly TreePlacement[]
  /** Boulders scattered with the stand; empty until a forest is generated. */
  rocks: readonly GeneratedForestRock[]
  selectedPlacementId?: string
  armedPrototypeId?: string
  /**
   * The variation the Plant tool re-arms with.
   *
   * Placing a tree disarms the brush, which is right — one click, one tree —
   * but it also used to mean the toolbar's Plant button had nothing to arm on
   * the next press and silently did nothing. Remembering the last choice makes
   * the tool a mode you stay in rather than a one-shot.
   */
  lastArmedPrototypeId?: string
  /** Undefined when every scene section is collapsed. */
  openSection?: TreeSceneSection
  lod: TreeLodLevel
  debugMode: TreeDebugMode
  showFoliage: boolean
  /**
   * Draw distant stems as baked cards instead of geometry.
   *
   * On by default, because it is what lets a field be a forest rather than a
   * copse: this machine tops out near a hundred and sixty full trees, and a
   * closed stand covering any real area is thousands. Turning it off is for
   * judging the geometry itself — the near band is unaffected either way.
   */
  impostors: boolean
  showHud: boolean
  /**
   * Ray-traced global illumination over the stand.
   *
   * Off by default. It voxelises the stand and runs a probe field, which costs
   * a second of build time and a couple of milliseconds a frame, and the
   * authored fill rig is a perfectly good approximation until you want to see
   * what the canopy is actually doing to the light.
   */
  gi: boolean
  /** Progress and telemetry from the GI rig, for the status line. */
  giStatus: string
  /**
   * Paints the indirect irradiance on its own, with no albedo, no direct light
   * and no authored fill. A stand lit by both a hemisphere and a probe field
   * looks much the same either way in aggregate; this is how you see which of
   * the two is shaping it.
   */
  giDebug: boolean
  /**
   * How much of the authored hemisphere/ambient/fill rig survives while GI is
   * on. Those lights approximate exactly what the probes compute, so leaving
   * them at full strength double-counts the bounce and flattens the result.
   */
  giFill: number
  forestPreset: ForestPresetId
  forestSeed: number
  forestDensity: number
  forestRadius: number
  status: string
}

export const TREE_VARIATION_NAMES = [
  'Signature',
  'High canopy',
  'Open grown',
  'Wind shaped',
  'Veteran',
  'Young stand',
  'Multi stem',
  'Storm relic',
  'Sapling',
  'Stump',
] as const

export function treePrototypeId(species: TreeSpecies, variation: number): string {
  return `${species}:${variation}`
}

/** Nine deterministic topology recipes per species, not cosmetic presets. */
export function parametersForTreeVariation(
  species: TreeSpecies,
  variation: number,
): TreeParameters {
  const base = TREE_SPECIES_PRESETS[species]
  const seed = variationSeed(base.seed, species, variation)
  const common = { ...base, seed }
  switch (variation) {
    case 1:
      return normalizeTreeParameters({
        ...common,
        height: base.height * 1.14,
        crownRadius: base.crownRadius * 0.78,
        axisForm: 'straight',
        crownForm: 'full',
        branchCount: base.branchCount + 2,
        age: Math.max(0.52, base.age * 0.88),
      })
    case 2:
      return normalizeTreeParameters({
        ...common,
        height: base.height * 0.82,
        crownRadius: base.crownRadius * 1.28,
        bolePlan: 'codominant',
        crownForm: 'reiterated',
        branchCount: base.branchCount + 1,
        rootSpread: base.rootSpread * 1.18,
      })
    case 3:
      return normalizeTreeParameters({
        ...common,
        axisForm: 'leaning',
        crownForm: 'lopsided',
        lean: Math.max(12, base.lean * 1.8),
        sinuosity: Math.max(0.65, base.sinuosity * 1.45),
        crownRadius: base.crownRadius * 1.08,
        lostLimbs: Math.max(1, base.lostLimbs),
      })
    case 4:
      return normalizeTreeParameters({
        ...common,
        age: Math.max(0.92, base.age),
        gnarl: Math.max(0.72, base.gnarl),
        crownForm: 'stagheaded',
        bolePlan: base.bolePlan === 'single' ? 'fused' : base.bolePlan,
        lostLimbs: Math.max(4, base.lostLimbs),
        twist: base.twist + 0.7,
        rootExposure: Math.max(0.55, base.rootExposure),
      })
    case 5:
      return normalizeTreeParameters({
        ...common,
        age: Math.min(0.48, base.age),
        height: base.height * 0.68,
        crownRadius: base.crownRadius * 0.72,
        trunkRadius: base.trunkRadius * 0.62,
        branchCount: Math.max(5, base.branchCount - 1),
        foliageDensity: Math.min(MAX_FOLIAGE_DENSITY, base.foliageDensity * 1.2),
        lostLimbs: 0,
      })
    case 6:
      return normalizeTreeParameters({
        ...common,
        bolePlan: 'multistem',
        axisForm: 'sinuous',
        crownForm: 'reiterated',
        rootForm: 'braided',
        sinuosity: Math.max(0.5, base.sinuosity),
        twist: base.twist + 0.45,
        crownRadius: base.crownRadius * 1.16,
      })
    // The regeneration layer: a knee-to-shoulder-height Jüngling, not a small
    // adult.
    //
    // Every other recipe here varies an adult. This one drops `age` into the
    // juvenile band, where the species architecture stops lifting a crown onto
    // a bole and starts describing a leader with branches to the ground — so
    // what changes is the *architecture*, and height and girth merely follow.
    // Reaching for `height` alone is what produces bonsai: a 30-metre beech
    // description rendered at a quarter scale, with a clear bole, a hollow
    // shell crown and a 15-centimetre trunk on a 7-metre stem.
    //
    // Slenderness is the giveaway the height floor cannot express on its own.
    // A four-metre sapling carries a stem a couple of centimetres thick, which
    // is a ratio near a hundred to one; an adult runs nearer twenty.
    case 8:
      return normalizeTreeParameters({
        ...common,
        age: 0.03,
        height: Math.max(4, base.height * 0.15),
        crownRadius: Math.max(0.5, base.crownRadius * 0.17),
        trunkRadius: Math.max(0.035, base.trunkRadius * 0.1),
        axisForm: 'straight',
        bolePlan: 'single',
        trunkDamage: 'intact',
        crownForm: 'full',
        rootForm: 'auto',
        branchCount: 5,
        lostLimbs: 0,
        gnarl: 0,
        twist: Math.min(base.twist, 0.2),
        lean: Math.min(base.lean, 4),
        sinuosity: Math.min(base.sinuosity, 0.4),
        rootExposure: 0,
        rootSpread: base.rootSpread * 0.28,
        rootCount: 5,
        foliageDensity: Math.min(MAX_FOLIAGE_DENSITY, base.foliageDensity * 1.15),
      })
    case 7:
      return normalizeTreeParameters({
        ...common,
        trunkDamage: 'snapped',
        crownForm: 'lopsided',
        axisForm: 'sinuous',
        lostLimbs: Math.max(5, base.lostLimbs),
        gnarl: Math.max(0.82, base.gnarl),
        sinuosity: Math.max(0.9, base.sinuosity),
        foliageDensity: base.foliageDensity * 0.58,
      })
    // What is left after a tree comes down, and the reason it needs its own
    // recipe rather than a scaled-down anything: every other variation here
    // changes a *tree*, and a stump is not a small tree. Girth, root flare and
    // age all stay adult — the ratio of a metre and a half of height to most of
    // a metre of radius is the entire read — and only the stem is gone. Scaling
    // a whole tree down to stump height instead gives a slender post, because
    // its girth scales with it.
    case 9:
      return normalizeTreeParameters({
        ...common,
        trunkDamage: 'snapped',
        crownForm: 'stagheaded',
        axisForm: 'straight',
        // Cut or snapped between knee and chest height, whatever the species'
        // full height was.
        height: Math.max(1.2, Math.min(2.4, base.height * 0.06)),
        crownRadius: 1.5,
        // Adult girth, untouched.
        trunkRadius: base.trunkRadius,
        age: Math.max(0.9, base.age),
        gnarl: 1,
        twist: base.twist,
        lostLimbs: 8,
        branchCount: 5,
        // No crown at all. A stump with foliage on it is a hedge.
        foliageDensity: 0,
        // The flare is the silhouette. A stump seen across a forest floor is
        // recognised by its buttresses spreading into the litter, not by the
        // cylinder above them.
        rootExposure: Math.max(0.72, base.rootExposure),
        rootSpread: Math.max(base.rootSpread, 6),
        rootSurfacings: Math.max(2, base.rootSurfacings),
        fluting: Math.max(0.5, base.fluting),
        lean: Math.min(base.lean, 3),
        sinuosity: 0,
      })
    default:
      return normalizeTreeParameters(common)
  }
}

export class TreeEditorStore extends ExternalStore<TreeEditorSnapshot> {
  private nextPlacement = 2

  constructor() {
    const initial = createPrototype(DEFAULT_TREE_PARAMETERS.species, 0)
    super({
      prototypes: { [initial.id]: initial },
      placements: [{
        id: 'tree-1',
        prototypeId: initial.id,
        position: [0, 0, 0],
        rotation: 0,
        scale: 1,
      }],
      selectedPlacementId: 'tree-1',
      lastArmedPrototypeId: initial.id,
      openSection: 'forest',
      lod: 0,
      impostors: true,
      debugMode: 'surface',
      showFoliage: true,
      showHud: false,
      gi: false,
      giStatus: '',
      giDebug: false,
      giFill: 0.12,
      rocks: [],
      forestPreset: 'mossy-old-growth',
      forestSeed: 42017,
      forestDensity: 1,
      // The ground is four hundred metres across. Radius is extent, not budget
      // — the layout spends a capped stem budget, so widening it scatters the
      // same trees into groves and glades across more of that ground rather
      // than multiplying them. A hundred and forty metres covers most of the
      // world; drop it if you want a single copse to work on.
      forestRadius: 140,
      status: 'Forest workspace ready',
    })
  }

  patch(values: Partial<TreeEditorSnapshot>): void {
    this.update((current) => ({ ...current, ...values }))
  }

  armPlacement(species: TreeSpecies, variation: number): void {
    const id = treePrototypeId(species, variation)
    this.update((current) => ({
      ...current,
      prototypes: current.prototypes[id]
        ? current.prototypes
        : { ...current.prototypes, [id]: createPrototype(species, variation) },
      armedPrototypeId: id,
      lastArmedPrototypeId: id,
      status: `${TREE_VARIATION_NAMES[variation] ?? 'Variation'} ${species.replaceAll('-', ' ')} armed · click the ground to place`,
    }))
  }

  /**
   * Makes sure every prototype in the list exists, without disturbing any that
   * already do.
   *
   * The terrain workspace's forests reference prototypes by id and never author
   * them: the catalogue and its compiled assets belong to the tree lab, and a
   * forest field grown on terrain is a list of placements pointing into it.
   * This is the one call that crosses between them.
   */
  ensurePrototypes(
    entries: readonly { species: TreeSpecies; variation: number }[],
  ): void {
    const current = this.getSnapshot()
    const added: Record<string, TreePrototype> = {}
    for (const entry of entries) {
      const id = treePrototypeId(entry.species, entry.variation)
      if (current.prototypes[id] || added[id]) continue
      added[id] = createPrototype(entry.species, entry.variation)
    }
    if (Object.keys(added).length === 0) return
    this.patch({ prototypes: { ...current.prototypes, ...added } })
  }

  cancelPlacement(): void {
    this.patch({ armedPrototypeId: undefined, status: 'Placement cancelled' })
  }

  placeArmed(position: ForestPosition): void {
    const current = this.getSnapshot()
    if (!current.armedPrototypeId) return
    const id = `tree-${this.nextPlacement++}`
    const placement: TreePlacement = {
      id,
      prototypeId: current.armedPrototypeId,
      position,
      rotation: deterministicRotation(id, position),
      scale: 1,
    }
    this.patch({
      placements: [...current.placements, placement],
      selectedPlacementId: id,
      armedPrototypeId: undefined,
      status: 'Tree placed · edit it in the inspector to update every match',
    })
  }

  selectPlacement(id?: string): void {
    const current = this.getSnapshot()
    const prototypeId = id
      ? current.placements.find((placement) => placement.id === id)?.prototypeId
      : undefined
    this.patch({
      selectedPlacementId: id,
      armedPrototypeId: undefined,
      lastArmedPrototypeId: prototypeId ?? current.lastArmedPrototypeId,
      status: id ? 'Tree selected' : 'Selection cleared',
    })
  }

  patchSelectedParameters(values: Partial<TreeParameters>): void {
    const snapshot = this.getSnapshot()
    const placement = selectedTreePlacement(snapshot)
    if (!placement) return
    const prototype = snapshot.prototypes[placement.prototypeId]
    if (!prototype) return
    const parameters = normalizeTreeParameters({ ...prototype.parameters, ...values })
    this.replacePrototype(prototype.id, {
      ...prototype,
      parameters,
      dirty: true,
      status: 'Appearance changed · recompile to update every matching tree',
    }, 'Appearance changed · recompile when ready')
  }

  recompileSelected(): void {
    const snapshot = this.getSnapshot()
    const prototype = selectedTreePrototype(snapshot)
    if (!prototype) return
    this.replacePrototype(prototype.id, {
      ...prototype,
      dirty: false,
      buildRevision: prototype.buildRevision + 1,
      warmingMaterials: false,
      status: 'Queued for compilation',
    }, `Recompiling ${matchingCount(snapshot, prototype.id)} matching trees…`)
  }

  randomizeSelected(): void {
    const prototype = selectedTreePrototype(this.getSnapshot())
    if (!prototype) return
    const parameters = normalizeTreeParameters({
      ...prototype.parameters,
      seed: 1 + Math.floor(Math.random() * 0x7ffffffe),
    })
    this.replacePrototype(prototype.id, {
      ...prototype,
      parameters,
      dirty: false,
      buildRevision: prototype.buildRevision + 1,
      warmingMaterials: false,
      status: 'Random topology queued',
    }, 'Generating a new shared topology…')
  }

  duplicateSelected(): void {
    const snapshot = this.getSnapshot()
    const source = selectedTreePlacement(snapshot)
    if (!source) return
    const id = `tree-${this.nextPlacement++}`
    const placement: TreePlacement = {
      ...source,
      id,
      position: [source.position[0] + 2.5, source.position[1], source.position[2] + 2.5],
      rotation: source.rotation + 0.38,
    }
    this.patch({
      placements: [...snapshot.placements, placement],
      selectedPlacementId: id,
      status: 'Tree instance duplicated',
    })
  }

  deleteSelected(): void {
    const snapshot = this.getSnapshot()
    if (!snapshot.selectedPlacementId) return
    this.patch({
      placements: snapshot.placements.filter(
        (placement) => placement.id !== snapshot.selectedPlacementId,
      ),
      selectedPlacementId: undefined,
      status: 'Tree instance removed',
    })
  }

  clearForest(): void {
    this.patch({
      placements: [],
      rocks: [],
      selectedPlacementId: undefined,
      status: 'Forest cleared',
    })
  }

  generateForest(options: Partial<Pick<
    TreeEditorSnapshot,
    'forestPreset' | 'forestSeed' | 'forestDensity' | 'forestRadius'
  >> = {}): void {
    const current = this.getSnapshot()
    const forestPreset = options.forestPreset ?? current.forestPreset
    const forestSeed = options.forestSeed ?? current.forestSeed
    const forestDensity = options.forestDensity ?? current.forestDensity
    const forestRadius = options.forestRadius ?? current.forestRadius
    const layout = generateForestLayout(
      forestPreset,
      forestSeed,
      forestRadius,
      forestDensity,
    )
    const prototypes: Record<string, TreePrototype> = {}
    const placements = layout.map((tree) => {
      const prototypeId = treePrototypeId(tree.species, tree.variation)
      prototypes[prototypeId] = current.prototypes[prototypeId]
        ?? createPrototype(tree.species, tree.variation)
      return {
        id: `tree-${this.nextPlacement++}`,
        prototypeId,
        position: tree.position,
        rotation: tree.rotation,
        scale: tree.scale,
        tilt: tree.tilt,
      } satisfies TreePlacement
    })
    const rocks = generateForestRockLayout(
      forestPreset,
      forestSeed,
      forestRadius,
      forestDensity,
    )
    this.patch({
      prototypes,
      placements,
      rocks,
      selectedPlacementId: undefined,
      armedPrototypeId: undefined,
      forestPreset,
      forestSeed,
      forestDensity,
      forestRadius,
      lod: 0,
      status: `Generated ${placements.length} trees across ${Object.keys(prototypes).length} instanced prototypes` +
        (rocks.length > 0 ? ` · ${rocks.length} boulders` : ''),
    })
  }

  randomizeForest(): void {
    this.generateForest({
      forestSeed: 1 + Math.floor(Math.random() * 0x7ffffffe),
    })
  }

  beginBuild(id: string, revision: number): boolean {
    const prototype = this.getSnapshot().prototypes[id]
    if (!prototype || revision !== prototype.buildRevision || prototype.building) return false
    this.replacePrototype(id, {
      ...prototype,
      building: true,
      warmingMaterials: false,
      buildProgress: 0,
      status: 'Preparing tree worker…',
    })
    return true
  }

  reportProgress(id: string, revision: number, status: string, buildProgress: number): void {
    const prototype = this.getSnapshot().prototypes[id]
    if (!prototype || revision !== prototype.buildRevision) return
    this.replacePrototype(id, { ...prototype, status, buildProgress })
  }

  finishBuild(id: string, revision: number, asset: ProceduralTreeAsset): void {
    const prototype = this.getSnapshot().prototypes[id]
    if (!prototype || revision !== prototype.buildRevision) return
    this.replacePrototype(id, {
      ...prototype,
      asset,
      compiledRevision: revision,
      building: false,
      warmingMaterials: false,
      buildProgress: 1,
      status: 'Ready',
    }, `${prototype.variationName} ${prototype.species.replaceAll('-', ' ')} ready`)
  }

  failBuild(id: string, revision: number, error: unknown): void {
    const prototype = this.getSnapshot().prototypes[id]
    if (!prototype || revision !== prototype.buildRevision) return
    const message = error instanceof Error ? error.message : String(error)
    this.replacePrototype(id, {
      ...prototype,
      building: false,
      warmingMaterials: false,
      status: `Compilation failed · ${message}`,
    }, `Tree compilation failed · ${message}`)
  }

  /** Compatibility helpers retained for the development handle. */
  applySpecies(species: TreeSpecies): void { this.armPlacement(species, 0) }
  regenerate(): void { this.recompileSelected() }
  randomize(): void { this.randomizeSelected() }
  finishMaterialWarmup(): void {}
  failMaterialWarmup(): void {}

  private replacePrototype(id: string, prototype: TreePrototype, status?: string): void {
    this.update((current) => ({
      ...current,
      prototypes: { ...current.prototypes, [id]: prototype },
      status: status ?? current.status,
    }))
  }
}

export function selectedTreePlacement(
  snapshot: TreeEditorSnapshot,
): TreePlacement | undefined {
  return snapshot.placements.find(
    (placement) => placement.id === snapshot.selectedPlacementId,
  )
}

export function selectedTreePrototype(
  snapshot: TreeEditorSnapshot,
): TreePrototype | undefined {
  const placement = selectedTreePlacement(snapshot)
  return placement ? snapshot.prototypes[placement.prototypeId] : undefined
}

function createPrototype(species: TreeSpecies, variation: number): TreePrototype {
  return {
    id: treePrototypeId(species, variation),
    species,
    variation,
    variationName: TREE_VARIATION_NAMES[variation] ?? `Variation ${variation + 1}`,
    parameters: parametersForTreeVariation(species, variation),
    dirty: false,
    building: false,
    warmingMaterials: false,
    buildRevision: 1,
    buildProgress: 0,
    status: 'Queued',
  }
}

function variationSeed(base: number, species: string, variation: number): number {
  let hash = (base ^ Math.imul(variation + 1, 0x45d9f3b)) >>> 0
  for (let index = 0; index < species.length; index += 1) {
    hash = Math.imul(hash ^ species.charCodeAt(index), 0x01000193) >>> 0
  }
  return (hash & 0x7fffffff) || variation + 1
}

function deterministicRotation(id: string, position: ForestPosition): number {
  let hash = Math.imul(
    Math.round(position[0] * 31) ^ Math.round(position[2] * 47),
    2654435761,
  )
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619)
  }
  return ((hash >>> 0) / 0xffffffff) * Math.PI * 2
}

function matchingCount(snapshot: TreeEditorSnapshot, prototypeId: string): number {
  return snapshot.placements.filter(
    (placement) => placement.prototypeId === prototypeId,
  ).length
}
