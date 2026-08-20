import { useCallback, useMemo } from 'react'
import { Group } from 'three/webgpu'
import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'
import { useEditorSnapshot } from './hooks'
import { DevSceneHandle } from './DevSceneHandle'
import { EditorCamera } from './EditorCamera'
import { HorizonProxy } from './HorizonProxy'
import { ModifierBounds } from './ModifierBounds'
import { TerrainEnvironment } from './TerrainEnvironment'
import { TerrainRenderPipeline } from './TerrainRenderPipeline'
import { TerrainView } from './TerrainView'
import { ModifierTransformGizmo } from './ModifierTransformGizmo'
import { GraniteRockScene } from './GraniteRockScene'
import { HeroShardGlow } from './HeroShardGlow'
import { ValleyWater } from './ValleyWater'
import { EditorLights } from './EditorLights'
import { LightTransformGizmo } from './LightTransformGizmo'
import { ThreeTerrainRenderBackend } from '../rendering/ThreeTerrainRenderBackend'
import { currentViewUrlState } from './viewUrlState'

interface TerrainSceneProps {
  terrain: WorldTerrain
  editor: EditorStore
}

export function TerrainScene({ terrain, editor }: TerrainSceneProps) {
  const { renderMode, uiViewMode } = useEditorSnapshot(editor)
  const showEditorOverlays = uiViewMode === 'editor'
  const terrainGroup = useMemo(() => new Group(), [])
  const debugView = useMemo(() => currentViewUrlState().debug ?? 'none', [])
  const terrainBackend = useMemo(
    () => new ThreeTerrainRenderBackend(
      terrainGroup,
      terrain.config.sectionSize,
      debugView,
    ),
    [debugView, terrain.config.sectionSize, terrainGroup],
  )

  // Surfaced in the status bar: the first switch to full quality spends a
  // moment building shaders, and silence there looks like a freeze.
  const onCompilingChange = useCallback(
    (compiling: boolean) => {
      editor.patch({
        status: compiling
          ? 'Building full-quality shaders…'
          : `${renderMode === 'full' ? 'Full' : 'Preview'} quality ready`,
      })
    },
    [editor, renderMode],
  )

  return (
    <>
      <TerrainEnvironment mode={renderMode} config={terrain.config} />
      <HorizonProxy
        terrain={terrain}
        mode={renderMode}
      />
      <TerrainView
        terrain={terrain}
        editor={editor}
        group={terrainGroup}
        backend={terrainBackend}
      />
      <ValleyWater terrain={terrain} mode={renderMode} />
      <GraniteRockScene terrain={terrain} editor={editor} />
      <HeroShardGlow />
      <EditorLights editor={editor} />
      {showEditorOverlays && (
        <>
          <LightTransformGizmo editor={editor} />
          <ModifierBounds terrain={terrain} editor={editor} />
          <ModifierTransformGizmo terrain={terrain} editor={editor} />
        </>
      )}
      <DevSceneHandle />
      <EditorCamera terrain={terrain} editor={editor} />
      <TerrainRenderPipeline
        mode={renderMode}
        onCompilingChange={onCompilingChange}
        beforeRender={(renderer, scene, camera) => {
          terrainBackend.updateOcclusion(renderer, camera, scene)
        }}
      />
    </>
  )
}
