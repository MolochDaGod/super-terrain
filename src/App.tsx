import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Cpu, Wrench } from 'lucide-react'
import { EditorShortcuts } from './components/editor/EditorShortcuts'
import { HelpOverlay } from './components/editor/HelpOverlay'
import { InspectorPanel } from './components/editor/InspectorPanel'
import { EditorMenuBar } from './components/editor/MenuBar'
import { NewWorldDialog } from './components/editor/NewWorldDialog'
import { PerformanceHud } from './components/editor/PerformanceHud'
import {
  OverlayQuickControl,
  RenderQuickControls,
} from './components/editor/QuickControls'
import { ScenePanel } from './components/editor/ScenePanel'
import { StatusBar } from './components/editor/StatusBar'
import { Toolbar } from './components/editor/Toolbar'
import { WelcomeSplash } from './components/editor/WelcomeSplash'
import { hasSeenWelcome } from './components/editor/welcomeSeen'
import type { Workspace } from './components/editor/WorkspaceToggle'
import { WorldTerrain } from './terrain/WorldTerrain'
import {
  loadWorldRecipe,
  saveWorldRecipe,
  terrainConfigFor,
  type WorldRecipe,
} from './terrain/world/worldRecipe'
import { EditorStore } from './terrain/editor/EditorStore'
import { TerrainScene } from './terrain/react/TerrainScene'
import { WebGpuCanvas } from './terrain/react/WebGpuCanvas'
import { useEditorSnapshot } from './terrain/react/hooks'
import { currentViewUrlState } from './terrain/react/viewUrlState'
import { FoliageEditorStore } from './foliage/FoliageEditorStore'
import { ForestFieldStore } from './forest/ForestFieldStore'
import { TreeMenuBar } from './tree/TreeMenuBar'
import { TreeEditorStore } from './tree/TreeEditorStore'
import { TreeScene } from './tree/TreeScene'
import { TreeWorkspacePanels } from './tree/TreeWorkspacePanels'

function App() {
  const editor = useMemo(() => new EditorStore(), [])
  const treeEditor = useMemo(() => new TreeEditorStore(), [])
  const foliageEditor = useMemo(() => new FoliageEditorStore(), [])
  // Forest fields outlive a world rebuild deliberately: a spline is drawn in
  // world coordinates and a new world is the same coordinate space. What it
  // does not outlive is the ground under it, so every field is marked for
  // regrowing when the world changes.
  const forestFields = useMemo(() => new ForestFieldStore(), [])
  const view = useMemo(() => currentViewUrlState(), [])
  const [workspace, setWorkspace] = useState<Workspace>(() => view.editor ?? 'terrain')
  const changeWorkspace = useCallback((next: Workspace) => {
    setWorkspace(next)
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    url.searchParams.set('editor', next)
    window.history.replaceState(window.history.state, '', url)
  }, [])
  // The recipe is state because generating a world means building a different
  // WorldTerrain: seed, landform model and authored content are all fixed at
  // construction, and pretending otherwise would leave half the streaming
  // pipeline holding the previous world's sections.
  const [recipe, setRecipe] = useState<WorldRecipe>(() => loadWorldRecipe())
  const [worldGeneration, setWorldGeneration] = useState(0)
  const terrain = useMemo(
    () => new WorldTerrain(terrainConfigFor(recipe)),
    // A new generation is exactly what "throw this world away" means.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recipe, worldGeneration],
  )

  const createWorld = useCallback(
    (next: WorldRecipe) => {
      saveWorldRecipe(next)
      setRecipe(next)
      setWorldGeneration((generation) => generation + 1)
      editor.patch({
        selectedRockId: undefined,
        selectedModifierId: undefined,
        selectedLightId: undefined,
        worldCursor: undefined,
        lights: [],
        status: 'Building a new world…',
      })
      // The splines survive; what grew from them does not. A stand planted on
      // the old world's heights would stand in the new world's air.
      forestFields.markAllDirty()
    },
    [editor, forestFields],
  )
  const editorSnapshot = useEditorSnapshot(editor)
  const terrainWorkspace = workspace === 'terrain'
  const editorUiVisible =
    terrainWorkspace && editorSnapshot.uiViewMode === 'editor' && !view.hideUi
  const webGpuAvailable = typeof navigator !== 'undefined' && Boolean(navigator.gpu)

  // A URL viewpoint is how the browser review harness reproduces a frame, and
  // the render mode has to come with it: `preview` is a different material.
  useEffect(() => {
    if (view.quality) editor.patch({ renderMode: view.quality })
    // `clean` is what actually removes the in-scene overlays — modifier bounds,
    // CSG volume previews, brush cursor. Hiding only the panels leaves those
    // floating in the frame, which is how a review capture ends up with
    // translucent lenses hanging over the terrain.
    if (view.hideUi) editor.patch({ cursorVisible: false, uiViewMode: 'clean' })
  }, [editor, view])

  useEffect(() => {
    let active = true
    // `?reset=1` discards the saved world, so the frame is of the shipped scene
    // and not of whatever this browser profile cached from an earlier build.
    // A generated world always starts from nothing: its document was discarded
    // when it was made, and loading the previous world's edits into it would
    // put the demo's caves in a plain that has no massif to cut them from.
    const discardSavedWorld = view.reset || recipe.preset !== 'showcase'
    void terrain.initialize({ discardSavedWorld }).then(() => {
      if (active) {
        editor.patch({
          activeSculptLayerId: terrain.getSculptLayers()[0]?.id,
          status: 'Stream scheduler online',
        })
      }
    })
    return () => {
      active = false
      terrain.dispose()
    }
  }, [editor, recipe, terrain, view])

  // Handle for the screenshot harness: it polls streaming telemetry to know
  // when a frame has actually settled instead of guessing with a timeout.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const globals = globalThis as Record<string, unknown>
    globals.__meshterrain = { terrain, editor }
    globals.__forestFields = forestFields
    return () => {
      delete globals.__meshterrain
      delete globals.__forestFields
    }
  }, [editor, forestFields, terrain])

  useEffect(() => {
    terrain.setOverlay(editorUiVisible ? editorSnapshot.overlay : 'none')
  }, [editorSnapshot.overlay, editorUiVisible, terrain])

  // First visit only, and never in a capture: the harness would photograph the
  // dialog instead of the terrain.
  useEffect(() => {
    if (view.hideUi || hasSeenWelcome()) return
    editor.patch({ showWelcome: true })
  }, [editor, view.hideUi])

  return (
    <main className="relative h-svh w-full overflow-hidden bg-[#07100f] text-white">
      {webGpuAvailable ? (
        <div className="absolute inset-0">
          <WebGpuCanvas
            key={workspace}
            dpr={dprForMode(editorSnapshot.dprMode)}
            cameraPosition={terrainWorkspace ? undefined : view.position ?? [45, 13, 48]}
          >
            {terrainWorkspace ? (
              <TerrainScene
              key={worldGeneration}
              terrain={terrain}
              editor={editor}
              forest={forestFields}
              trees={treeEditor}
              foliage={foliageEditor}
            />
            ) : (
              <TreeScene
                editor={editor}
                store={treeEditor}
                foliage={foliageEditor}
                terrain={terrain}
              />
            )}
          </WebGpuCanvas>
        </div>
      ) : (
        <WebGpuUnavailable />
      )}

      {editorUiVisible && (
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,transparent_35%,rgba(2,8,7,0.34)_100%)]" />
      )}
      {editorUiVisible && (
        <EditorMenuBar
          terrain={terrain}
          editor={editor}
          workspace={workspace}
          onWorkspaceChange={changeWorkspace}
        />
      )}
      {!terrainWorkspace && !view.hideUi && (
        <>
          <TreeMenuBar
            editor={editor}
            store={treeEditor}
            workspace={workspace}
            onWorkspaceChange={changeWorkspace}
          />
          <TreeWorkspacePanels
            editor={editor}
            store={treeEditor}
            foliage={foliageEditor}
          />
        </>
      )}
      {editorUiVisible && (
        <>
          <Toolbar terrain={terrain} editor={editor} />
          <ScenePanel terrain={terrain} editor={editor} forest={forestFields} />
          <InspectorPanel
            terrain={terrain}
            editor={editor}
            forest={forestFields}
            foliage={foliageEditor}
          />
          <RenderQuickControls editor={editor} />
          <OverlayQuickControl terrain={terrain} editor={editor} />
          <PerformanceHud terrain={terrain} editor={editor} />
          <HelpOverlay editor={editor} />
          <WelcomeSplash editor={editor} />
          <NewWorldDialog editor={editor} current={recipe} onCreate={createWorld} />
          <StatusBar terrain={terrain} editor={editor} />
        </>
      )}
      {/* Shortcuts stay bound in clean mode: Esc and the eye button are how
          the editor comes back once every panel is hidden. */}
      {!view.hideUi && terrainWorkspace && (
        <EditorShortcuts terrain={terrain} editor={editor} />
      )}
      {!view.hideUi && terrainWorkspace && editorSnapshot.uiViewMode === 'clean' && (
        <RestoreUiButton editor={editor} />
      )}
    </main>
  )
}

/** The single control that survives "hide all editor UI". */
function RestoreUiButton({ editor }: { editor: EditorStore }) {
  return (
    <button
      type="button"
      title="Show editor UI"
      aria-label="Show editor UI"
      className="pointer-events-auto absolute right-3 top-3 z-30 grid size-8 place-items-center rounded-lg border border-white/[0.09] bg-[#0b1312]/80 text-white/45 backdrop-blur-xl transition hover:text-white/85"
      onClick={() =>
        editor.patch({ uiViewMode: 'editor', status: 'Editor UI restored' })
      }
    >
      <Wrench size={14} />
    </button>
  )
}

function dprForMode(mode: 'low' | 'medium' | 'full'): number {
  const nativeDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  if (mode === 'low') return Math.min(nativeDpr, 0.75)
  if (mode === 'medium') return Math.min(nativeDpr, 1)
  return nativeDpr
}

function WebGpuUnavailable() {
  return (
    <div className="absolute inset-0 grid place-items-center p-6">
      <section className="max-w-md rounded-2xl border border-[#ff9d78]/20 bg-[#111715] p-6 text-center shadow-2xl">
        <div className="mx-auto grid size-10 place-items-center rounded-xl bg-[#ff9d78]/10 text-[#ff9d78]">
          <AlertTriangle size={18} />
        </div>
        <h2 className="mt-4 text-sm font-semibold text-white/85">WebGPU is required</h2>
        <p className="mt-2 text-[11px] leading-relaxed text-white/42">
          This editor intentionally uses Three.js WebGPURenderer and will not silently fall back to WebGL. Open it in a current WebGPU-capable browser.
        </p>
        <div className="mt-4 flex items-center justify-center gap-2 font-mono text-[9px] text-white/28">
          <Cpu size={11} /> navigator.gpu unavailable
        </div>
      </section>
    </div>
  )
}

export default App
