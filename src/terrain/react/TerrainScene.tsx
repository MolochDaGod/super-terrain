import { lazy, Suspense, useCallback, useMemo, useState } from 'react'
import { Group } from 'three/webgpu'
import type { Object3D } from 'three/webgpu'
import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'
import { useEditorSnapshot, useGraniteRockRevision } from './hooks'
import { DevSceneHandle } from './DevSceneHandle'
import { EditorCamera } from './EditorCamera'
import { HorizonProxy } from './HorizonProxy'
import { ModifierBounds } from './ModifierBounds'
import { TerrainEnvironment } from './TerrainEnvironment'
import { TerrainRenderPipeline } from './TerrainRenderPipeline'
import { TerrainView } from './TerrainView'
import { ModifierTransformGizmo } from './ModifierTransformGizmo'
import { HeroShardGlow } from './HeroShardGlow'
import { ValleyWater } from './ValleyWater'
import { EditorLights } from './EditorLights'
import { LightTransformGizmo } from './LightTransformGizmo'
import { ThreeTerrainRenderBackend } from '../rendering/ThreeTerrainRenderBackend'
import { currentViewUrlState } from './viewUrlState'
import type { ForestFieldStore } from '../../forest/ForestFieldStore'
import type { TreeEditorStore } from '../../tree/TreeEditorStore'
import { ForestSplineOverlay } from '../../forest/react/ForestSplineOverlay'
import { TerrainForestLayer } from '../../forest/react/TerrainForestLayer'
import { TerrainGroundCover } from '../../forest/react/TerrainGroundCover'
import type { FoliageEditorStore } from '../../foliage/FoliageEditorStore'

interface TerrainSceneProps {
  terrain: WorldTerrain
  editor: EditorStore
  forest: ForestFieldStore
  trees: TreeEditorStore
  foliage: FoliageEditorStore
}

// Granite authoring owns seven topology/bake sources and its own large node
// material graph. A fresh showcase contains no authored granite objects, so
// loading that entire subsystem on the critical path only delays first light.
const GraniteRockScene = lazy(async () => {
  const module = await import('./GraniteRockScene')
  return { default: module.GraniteRockScene }
})

export function TerrainScene({
  terrain,
  editor,
  forest,
  trees,
  foliage,
}: TerrainSceneProps) {
  const { environmentLook, renderMode, shadows, uiViewMode } = useEditorSnapshot(editor)
  useGraniteRockRevision(terrain)
  const hasGraniteRocks = terrain.rocks.count > 0
  const showEditorOverlays = uiViewMode === 'editor'
  const terrainGroup = useMemo(() => new Group(), [])
  const debugView = useMemo(() => currentViewUrlState().debug ?? 'none', [])
  // Published by the post stack so a layer mounted elsewhere can compile
  // against the same multisampled attachment the frame is drawn into.
  const [warmupObject, setWarmupObject] = useState<
    ((object: Object3D) => Promise<void>) | undefined
  >(undefined)
  const publishWarmup = useCallback(
    (warm: (object: Object3D) => Promise<void>) => setWarmupObject(() => warm),
    [],
  )
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
      if (compiling) {
        editor.patch({ status: 'Building full-quality shaders…' })
      } else if (renderMode === 'preview') {
        editor.patch({ status: 'Preview quality ready' })
      }
    },
    [editor, renderMode],
  )

  return (
    <>
      <TerrainEnvironment
        mode={renderMode}
        config={terrain.config}
        look={environmentLook}
        shadows={shadows}
      />
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
      <HeroShardGlow />
      {hasGraniteRocks && (
        <Suspense fallback={null}>
          <GraniteRockScene terrain={terrain} editor={editor} />
        </Suspense>
      )}
      <TerrainForestLayer
        terrain={terrain}
        forest={forest}
        trees={trees}
        warmup={warmupObject}
      />
      <TerrainGroundCover
        terrain={terrain}
        forest={forest}
        foliage={foliage}
        warmup={warmupObject}
      />
      <EditorLights editor={editor} />
      {showEditorOverlays && (
        <>
          <ForestSplineOverlay
            terrain={terrain}
            forest={forest}
            editor={editor}
            backend={terrainBackend}
          />
          <LightTransformGizmo editor={editor} />
          <ModifierBounds terrain={terrain} editor={editor} />
          <ModifierTransformGizmo terrain={terrain} editor={editor} />
        </>
      )}
      <DevSceneHandle terrain={terrain} />
      <EditorCamera terrain={terrain} editor={editor} />
      <TerrainRenderPipeline
        mode={renderMode}
        // The forest workspace's chain — atmospheric haze, sun shafts against a
        // depth map, and its grade — with the two constants that are
        // interior-scale swapped for open-country ones. See `PostLook`.
        look="wooded-landscape"
        exposure={LANDSCAPE_EXPOSURE}
        onWarmupReady={publishWarmup}
        onCompilingChange={onCompilingChange}
        beforeRender={(renderer, scene, camera) => {
          terrainBackend.updateOcclusion(renderer, camera, scene)
        }}
      />
    </>
  )
}

/**
 * What the tree look's chain is printed at over open ground.
 *
 * The forest interior it was written for is a low-key subject and runs at 1.4.
 * A valley under the same sun is not: most of the frame is directly lit rock
 * and sky, and an interior's exposure puts both at the top of the curve.
 */
const LANDSCAPE_EXPOSURE = 1.02
