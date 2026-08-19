import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
  Vector3,
} from 'three/webgpu'
import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'
import { transformedTunnel } from '../modifiers/transform'
import { tunnelPathPoints } from '../modifiers/tunnel'
import { ignoreRaycast } from './ignoreRaycast'

const SEGMENT_COUNT = 3
const CONTROL_POINT_COUNT = 4

interface TunnelModifierPreviewProps {
  terrain: WorldTerrain
  editor: EditorStore
}

/** Cheap editor proxy; no CSG runs until the pointer is released. */
export function TunnelModifierPreview({
  terrain,
  editor,
}: TunnelModifierPreviewProps) {
  const group = useRef<Group>(null)
  const segments = useRef<Array<Mesh | null>>([])
  const controlPoints = useRef<Array<Mesh | null>>([])
  const cylinder = useMemo(
    () => new CylinderGeometry(1, 1, 1, 18, 1, true),
    [],
  )
  const sphere = useMemo(() => new SphereGeometry(1, 18, 10), [])
  const material = useMemo(
    () =>
      new MeshBasicNodeMaterial({
        color: 0xffa56f,
        wireframe: true,
        transparent: true,
        opacity: 0.3,
        depthTest: false,
      }),
    [],
  )
  const axis = useMemo(() => new Vector3(0, 1, 0), [])
  const start = useMemo(() => new Vector3(), [])
  const end = useMemo(() => new Vector3(), [])
  const direction = useMemo(() => new Vector3(), [])

  useEffect(
    () => () => {
      cylinder.dispose()
      sphere.dispose()
      material.dispose()
    },
    [cylinder, material, sphere],
  )

  useFrame(() => {
    const root = group.current
    if (!root) return
    const snapshot = editor.getSnapshot()
    const selected = snapshot.selectedModifierId
      ? terrain.modifiers.get(snapshot.selectedModifierId)
      : undefined
    root.visible = selected?.type === 'boolean-subtract'
    if (!selected || selected.type !== 'boolean-subtract') return

    const tunnel = transformedTunnel(selected)
    const path = tunnelPathPoints(tunnel)
    material.opacity = snapshot.dragging ? 0.42 : 0.24

    for (let index = 0; index < CONTROL_POINT_COUNT; index += 1) {
      const marker = controlPoints.current[index]
      if (!marker) continue
      marker.position.set(path[index].x, path[index].y, path[index].z)
      marker.scale.setScalar(tunnel.radius)
    }
    for (let index = 0; index < SEGMENT_COUNT; index += 1) {
      const segment = segments.current[index]
      if (!segment) continue
      start.set(path[index].x, path[index].y, path[index].z)
      end.set(path[index + 1].x, path[index + 1].y, path[index + 1].z)
      direction.copy(end).sub(start)
      const length = Math.max(0.001, direction.length())
      segment.position.copy(start).add(end).multiplyScalar(0.5)
      segment.quaternion.setFromUnitVectors(axis, direction.normalize())
      segment.scale.set(tunnel.radius, length, tunnel.radius)
    }
  })

  return (
    <group ref={group} renderOrder={9_998} visible={false}>
      {Array.from({ length: SEGMENT_COUNT }, (_, index) => (
        <mesh
          key={`segment-${index}`}
          ref={(value) => {
            segments.current[index] = value
          }}
          geometry={cylinder}
          material={material}
          raycast={ignoreRaycast}
        />
      ))}
      {Array.from({ length: CONTROL_POINT_COUNT }, (_, index) => (
        <mesh
          key={`point-${index}`}
          ref={(value) => {
            controlPoints.current[index] = value
          }}
          geometry={sphere}
          material={material}
          raycast={ignoreRaycast}
        />
      ))}
    </group>
  )
}
