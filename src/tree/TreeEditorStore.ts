import { ExternalStore } from '../terrain/core/ExternalStore'
import {
  DEFAULT_TREE_PARAMETERS,
  TREE_SPECIES_PRESETS,
  normalizeTreeParameters,
  type ProceduralTreeAsset,
  type TreeLodLevel,
  type TreeParameters,
  type TreeSpecies,
} from './generator/types'
import { loadTreeDraft, saveTreeDraft } from './treePersistence'

export type TreeDebugMode =
  | 'surface'
  | 'skeleton'
  | 'hierarchy'
  | 'continuations'
  | 'radii'
  | 'contacts'
  | 'burial'
  | 'topology'

export interface TreeEditorSnapshot {
  parameters: TreeParameters
  asset?: ProceduralTreeAsset
  lod: TreeLodLevel
  debugMode: TreeDebugMode
  showFoliage: boolean
  building: boolean
  warmingMaterials: boolean
  dirty: boolean
  buildRevision: number
  compiledRevision?: number
  buildProgress: number
  status: string
}

export class TreeEditorStore extends ExternalStore<TreeEditorSnapshot> {
  constructor() {
    super({
      parameters: loadTreeDraft() ?? DEFAULT_TREE_PARAMETERS,
      lod: 0,
      debugMode: 'surface',
      showFoliage: true,
      building: false,
      warmingMaterials: false,
      dirty: false,
      buildRevision: 1,
      buildProgress: 0,
      status: 'Tree workspace ready',
    })
  }

  patch(values: Partial<TreeEditorSnapshot>): void {
    this.update((current) => ({ ...current, ...values }))
  }

  patchParameters(values: Partial<TreeParameters>): void {
    this.update((current) => ({
      ...current,
      parameters: normalizeTreeParameters({ ...current.parameters, ...values }),
      dirty: true,
      status: 'Recipe changed · regenerate to compile geometry',
    }))
  }

  applySpecies(species: TreeSpecies): void {
    const parameters = { ...TREE_SPECIES_PRESETS[species] }
    saveTreeDraft(parameters)
    this.update((current) => ({
      ...current,
      parameters,
      dirty: false,
      buildRevision: current.buildRevision + 1,
      warmingMaterials: false,
      status: `Generating ${species.replaceAll('-', ' ')}…`,
    }))
  }

  regenerate(): void {
    const parameters = this.getSnapshot().parameters
    saveTreeDraft(parameters)
    this.update((current) => ({
      ...current,
      dirty: false,
      buildRevision: current.buildRevision + 1,
      warmingMaterials: false,
      status: 'Regenerating tree…',
    }))
  }

  randomize(): void {
    const seed = 1 + Math.floor(Math.random() * 0x7ffffffe)
    const parameters = normalizeTreeParameters({
      ...this.getSnapshot().parameters,
      seed,
    })
    saveTreeDraft(parameters)
    this.update((current) => ({
      ...current,
      parameters,
      dirty: false,
      buildRevision: current.buildRevision + 1,
      warmingMaterials: false,
      status: `Generating seed ${seed}…`,
    }))
  }

  beginBuild(revision: number): boolean {
    if (revision !== this.getSnapshot().buildRevision) return false
    this.patch({
      building: true,
      warmingMaterials: false,
      buildProgress: 0,
      status: 'Preparing tree worker…',
    })
    return true
  }

  reportProgress(revision: number, status: string, buildProgress: number): void {
    if (revision !== this.getSnapshot().buildRevision) return
    this.patch({ status, buildProgress })
  }

  finishBuild(revision: number, asset: ProceduralTreeAsset): void {
    if (revision !== this.getSnapshot().buildRevision) return
    this.patch({
      asset,
      compiledRevision: revision,
      building: false,
      warmingMaterials: true,
      buildProgress: 0.96,
      status: 'Geometry ready · preparing WebGPU materials…',
    })
  }

  finishMaterialWarmup(revision: number): void {
    const snapshot = this.getSnapshot()
    if (revision !== snapshot.buildRevision || revision !== snapshot.compiledRevision) return
    this.patch({
      warmingMaterials: false,
      buildProgress: 1,
      status: `Tree ready · ${((snapshot.asset?.stats.generationMs ?? 0) / 1000).toFixed(1)} s`,
    })
  }

  failMaterialWarmup(revision: number, error: unknown): void {
    const snapshot = this.getSnapshot()
    if (revision !== snapshot.buildRevision || revision !== snapshot.compiledRevision) return
    this.patch({
      warmingMaterials: false,
      status: `WebGPU material preparation failed · ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
  }

  failBuild(revision: number, error: unknown): void {
    if (revision !== this.getSnapshot().buildRevision) return
    this.patch({
      building: false,
      warmingMaterials: false,
      status: `Tree generation failed · ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}
