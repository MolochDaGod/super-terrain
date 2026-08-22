import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  LineBasicNodeMaterial,
  LineSegments,
} from 'three/webgpu'
import type { EditorStore } from '../editor/EditorStore'
import { ignoreRaycast } from './ignoreRaycast'

/** Arm length of the crosshair, in metres. */
const ARM = 6

/**
 * The placed 3D cursor.
 *
 * Drawn as three world-axis arms rather than a ring, so it reads as a point in
 * space with an orientation rather than as another brush outline — it has to be
 * distinguishable at a glance from the brush cursor it shares the viewport
 * with. Depth testing is off: a cursor placed on the far side of a ridge is
 * still the point the next Add will use, so hiding it would be a lie.
 */
export function WorldCursorMarker({ editor }: { editor: EditorStore }) {
  const lines = useRef<LineSegments>(null)
  const geometry = useMemo(() => {
    const positions = new Float32Array([
      -ARM, 0, 0, ARM, 0, 0,
      0, -ARM, 0, 0, ARM, 0,
      0, 0, -ARM, 0, 0, ARM,
    ])
    const created = new BufferGeometry()
    created.setAttribute('position', new BufferAttribute(positions, 3))
    return created
  }, [])
  const material = useMemo(
    () =>
      new LineBasicNodeMaterial({
        color: 0xffd08a,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        blending: AdditiveBlending,
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
    const marker = lines.current
    if (!marker) return
    const snapshot = editor.getSnapshot()
    const cursor = snapshot.worldCursor
    marker.visible = snapshot.uiViewMode === 'editor' && cursor !== undefined
    if (!cursor) return
    marker.position.set(cursor.x, cursor.y, cursor.z)
  })

  return (
    <lineSegments
      ref={lines}
      geometry={geometry}
      material={material}
      renderOrder={10_001}
      visible={false}
      raycast={ignoreRaycast}
    />
  )
}
