import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'
import { EditorCamera } from './EditorCamera'
import { HorizonProxy } from './HorizonProxy'
import { ModifierBounds } from './ModifierBounds'
import { TerrainView } from './TerrainView'

interface TerrainSceneProps {
  terrain: WorldTerrain
  editor: EditorStore
}

export function TerrainScene({ terrain, editor }: TerrainSceneProps) {
  return (
    <>
      <color attach="background" args={['#07100f']} />
      <fogExp2 attach="fog" args={['#07100f', 0.0003]} />
      <hemisphereLight args={['#cfe8dd', '#121916', 1.35]} />
      <directionalLight
        color="#fff4d6"
        intensity={2.8}
        position={[180, 320, 120]}
      />
      <directionalLight
        color="#73b8d8"
        intensity={0.45}
        position={[-160, 80, -240]}
      />
      <HorizonProxy
        worldSize={terrain.config.worldSize}
        seed={terrain.config.seed}
      />
      <TerrainView terrain={terrain} editor={editor} />
      <ModifierBounds terrain={terrain} editor={editor} />
      <EditorCamera terrain={terrain} editor={editor} />
    </>
  )
}
