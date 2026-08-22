import { useEffect, useMemo } from 'react'
import { AlertTriangle, Cpu, Wrench } from 'lucide-react'
import { EditorShortcuts } from './components/editor/EditorShortcuts'
import { HelpOverlay } from './components/editor/HelpOverlay'
import { InspectorPanel } from './components/editor/InspectorPanel'
import { EditorMenuBar } from './components/editor/MenuBar'
import { ObjectToolbar } from './components/editor/ObjectToolbar'
import { PerformanceHud } from './components/editor/PerformanceHud'
import { StatusBar } from './components/editor/StatusBar'
import { ToolRail } from './components/editor/ToolRail'
import { WorldTerrain } from './terrain/WorldTerrain'
import { EditorStore } from './terrain/editor/EditorStore'
import { TerrainScene } from './terrain/react/TerrainScene'
import { WebGpuCanvas } from './terrain/react/WebGpuCanvas'
import { useEditorSnapshot } from './terrain/react/hooks'
import { currentViewUrlState } from './terrain/react/viewUrlState'

function App() {
  const terrain = useMemo(() => new WorldTerrain(), [])
  const editor = useMemo(() => new EditorStore(), [])
  const view = useMemo(() => currentViewUrlState(), [])
  const editorSnapshot = useEditorSnapshot(editor)
  const editorUiVisible = editorSnapshot.uiViewMode === 'editor' && !view.hideUi
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
    void terrain.initialize({ discardSavedWorld: view.reset }).then(() => {
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
  }, [editor, terrain, view])

  // Handle for the screenshot harness: it polls streaming telemetry to know
  // when a frame has actually settled instead of guessing with a timeout.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const globals = globalThis as Record<string, unknown>
    globals.__meshterrain = { terrain, editor }
    return () => {
      delete globals.__meshterrain
    }
  }, [editor, terrain])

  useEffect(() => {
    terrain.setOverlay(editorUiVisible ? editorSnapshot.overlay : 'none')
  }, [editorSnapshot.overlay, editorUiVisible, terrain])

  return (
    <main className="relative h-svh w-full overflow-hidden bg-[#07100f] text-white">
      {webGpuAvailable ? (
        <div className="absolute inset-0">
          <WebGpuCanvas dpr={dprForMode(editorSnapshot.dprMode)}>
            <TerrainScene terrain={terrain} editor={editor} />
          </WebGpuCanvas>
        </div>
      ) : (
        <WebGpuUnavailable />
      )}

      {editorUiVisible && (
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,transparent_35%,rgba(2,8,7,0.34)_100%)]" />
      )}
      {editorUiVisible && <EditorMenuBar terrain={terrain} editor={editor} />}
      {editorUiVisible && (
        <>
          <ObjectToolbar terrain={terrain} editor={editor} />
          <ToolRail editor={editor} />
          <InspectorPanel terrain={terrain} editor={editor} />
          <PerformanceHud terrain={terrain} editor={editor} />
          <HelpOverlay editor={editor} />
          <StatusBar terrain={terrain} editor={editor} />
        </>
      )}
      {/* Shortcuts stay bound in clean mode: Esc and the eye button are how
          the editor comes back once every panel is hidden. */}
      {!view.hideUi && <EditorShortcuts terrain={terrain} editor={editor} />}
      {!view.hideUi && editorSnapshot.uiViewMode === 'clean' && (
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
