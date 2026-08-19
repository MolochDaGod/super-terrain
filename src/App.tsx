import { useEffect, useMemo } from 'react'
import { AlertTriangle, Cpu } from 'lucide-react'
import { EditorShortcuts } from './components/editor/EditorShortcuts'
import { HelpOverlay } from './components/editor/HelpOverlay'
import { InspectorPanel } from './components/editor/InspectorPanel'
import { LightsPanel } from './components/editor/LightsPanel'
import { PerformanceHud } from './components/editor/PerformanceHud'
import { StatusBar } from './components/editor/StatusBar'
import { ToolRail } from './components/editor/ToolRail'
import { TopBar } from './components/editor/TopBar'
import { WorldTerrain } from './terrain/WorldTerrain'
import { EditorStore } from './terrain/editor/EditorStore'
import { TerrainScene } from './terrain/react/TerrainScene'
import { WebGpuCanvas } from './terrain/react/WebGpuCanvas'
import { useEditorSnapshot } from './terrain/react/hooks'

function App() {
  const terrain = useMemo(() => new WorldTerrain(), [])
  const editor = useMemo(() => new EditorStore(), [])
  const editorSnapshot = useEditorSnapshot(editor)
  const editorUiVisible = editorSnapshot.uiViewMode === 'editor'
  const webGpuAvailable = typeof navigator !== 'undefined' && Boolean(navigator.gpu)

  useEffect(() => {
    let active = true
    void terrain.initialize().then(() => {
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
      <TopBar terrain={terrain} editor={editor} />
      {editorUiVisible && (
        <>
          <ToolRail editor={editor} />
          <LightsPanel editor={editor} />
          <InspectorPanel terrain={terrain} editor={editor} />
          <PerformanceHud terrain={terrain} editor={editor} />
          <HelpOverlay editor={editor} />
          <EditorShortcuts editor={editor} />
        </>
      )}
      <StatusBar terrain={terrain} editor={editor} />
    </main>
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
