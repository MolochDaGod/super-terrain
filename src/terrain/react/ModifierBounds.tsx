import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BoxGeometry,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu'
import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'
import { TunnelModifierPreview } from './TunnelModifierPreview'
import { BooleanVolumePreview } from './BooleanVolumePreview'
import { ignoreRaycast } from './ignoreRaycast'

interface ModifierBoundsProps {
  terrain: WorldTerrain
  editor: EditorStore
}

export function ModifierBounds({ terrain, editor }: ModifierBoundsProps) {
  const mesh = useRef<Mesh>(null)
  const geometry = useMemo(() => new BoxGeometry(1, 1, 1), [])
  const material = useMemo(
    () =>
      new MeshBasicNodeMaterial({
        color: 0x77e8be,
        wireframe: true,
        transparent: true,
        opacity: 0.34,
        depthTest: false,
      }),
    [],
  )

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  useFrame(() => {
    const boundsMesh = mesh.current
    if (!boundsMesh) return
    const id = editor.getSnapshot().selectedModifierId
    const modifier = id ? terrain.modifiers.get(id) : undefined
    boundsMesh.visible = Boolean(modifier && modifier.type !== 'boolean-subtract')
    if (!modifier) return
    const bounds = modifier.bounds
    boundsMesh.position.set(
      (bounds.min.x + bounds.max.x) * 0.5,
      (bounds.min.y + bounds.max.y) * 0.5,
      (bounds.min.z + bounds.max.z) * 0.5,
    )
    boundsMesh.scale.set(
      Math.max(0.01, bounds.max.x - bounds.min.x),
      Math.max(0.01, bounds.max.y - bounds.min.y),
      Math.max(0.01, bounds.max.z - bounds.min.z),
    )
    material.color.set(
      modifier.type === 'boolean-subtract' || modifier.type === 'boolean-volume'
        ? 0xffa56f
        : 0x77e8be,
    )
  })

  return (
    <>
      <mesh
        ref={mesh}
        geometry={geometry}
        material={material}
        renderOrder={9_999}
        visible={false}
        raycast={ignoreRaycast}
      />
      <TunnelModifierPreview terrain={terrain} editor={editor} />
      <BooleanVolumePreview terrain={terrain} editor={editor} />
    </>
  )
}
