import { useEffect, useMemo } from 'react'
import { Mesh, MeshBasicNodeMaterial } from 'three/webgpu'
import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'
import { cutterGeometry } from '../modifiers/boolean/CutterVolume'
import {
  transformedBooleanVolume,
  transformedTunnel,
} from '../modifiers/transform'
import {
  useEditorSnapshot,
  useModifierRevision,
} from './hooks'
import { ignoreRaycast } from './ignoreRaycast'

export function BooleanVolumePreview({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
}) {
  const revision = useModifierRevision(terrain)
  const snapshot = useEditorSnapshot(editor)
  const selected = snapshot.selectedModifierId
    ? terrain.modifiers.get(snapshot.selectedModifierId)
    : undefined
  const volume = selected?.type === 'boolean-volume'
    ? transformedBooleanVolume(selected)
    : selected?.type === 'boolean-subtract'
      ? {
          operation: 'subtract' as const,
          volumes: transformedTunnel(selected).carves ?? [],
        }
      : undefined
  const geometries = useMemo(
    () =>
      volume?.volumes.map((cutter) =>
        cutterGeometry(cutter, 0.45, terrain.config.seed),
      ) ?? [],
    // The modifier revision is the document-level invalidation signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revision, snapshot.selectedModifierId, terrain.config.seed],
  )
  const material = useMemo(
    () =>
      new MeshBasicNodeMaterial({
        color: volume?.operation === 'add' ? 0x77e8be : 0xffa56f,
        wireframe: true,
        transparent: true,
        opacity: 0.42,
        depthTest: false,
        depthWrite: false,
      }),
    [volume?.operation],
  )
  const meshes = useMemo(
    () => geometries.map((geometry) => new Mesh(geometry, material)),
    [geometries, material],
  )

  useEffect(
    () => () => {
      for (const geometry of geometries) geometry.dispose()
      material.dispose()
    },
    [geometries, material],
  )

  if (!volume) return null
  return (
    <group renderOrder={9_998}>
      {meshes.map((mesh, index) => (
        <primitive key={index} object={mesh} raycast={ignoreRaycast} />
      ))}
    </group>
  )
}
