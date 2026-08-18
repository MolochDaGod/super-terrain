import { useCallback } from 'react'
import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'
import { useEditorSnapshot } from './hooks'
import { EditorCamera } from './EditorCamera'
import { HorizonProxy } from './HorizonProxy'
import { ModifierBounds } from './ModifierBounds'
import { TerrainEnvironment } from './TerrainEnvironment'
import { TerrainRenderPipeline } from './TerrainRenderPipeline'
import { TerrainView } from './TerrainView'
import { ModifierTransformGizmo } from './ModifierTransformGizmo'
import { GraniteRockScene } from './GraniteRockScene'

interface TerrainSceneProps {
  terrain: WorldTerrain
  editor: EditorStore
}

export function TerrainScene({ terrain, editor }: TerrainSceneProps) {
  const { renderMode } = useEditorSnapshot(editor)

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
        worldSize={terrain.config.worldSize}
        seed={terrain.config.seed}
        mode={renderMode}
      />
      <TerrainView terrain={terrain} editor={editor} />
      <GraniteRockScene terrain={terrain} editor={editor} />
      <ModifierBounds terrain={terrain} editor={editor} />
      <ModifierTransformGizmo terrain={terrain} editor={editor} />
      <EditorCamera terrain={terrain} editor={editor} />
      <TerrainRenderPipeline mode={renderMode} onCompilingChange={onCompilingChange} />
    </>
  )
}
