import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
  TorusGeometry,
} from 'three/webgpu'
import type { EditorStore } from '../editor/EditorStore'

interface BrushCursorProps {
  editor: EditorStore
}

export function BrushCursor({ editor }: BrushCursorProps) {
  const mesh = useRef<Mesh>(null)
  const geometry = useMemo(() => new TorusGeometry(1, 0.018, 8, 72), [])
  const material = useMemo(
    () =>
      new MeshBasicNodeMaterial({
        color: 0xb7f6df,
        transparent: true,
        opacity: 0.92,
        depthTest: false,
        blending: AdditiveBlending,
      }),
    [],
  )
  const cursorAxis = useMemo(() => new Vector3(0, 0, 1), [])
  const cursorNormal = useMemo(() => new Vector3(0, 1, 0), [])

  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  useFrame(() => {
    const cursor = mesh.current
    if (!cursor) return
    const snapshot = editor.getSnapshot()
    cursor.visible =
      snapshot.uiViewMode === 'editor' &&
      snapshot.cursorVisible &&
      snapshot.tool !== 'select'
    cursorNormal
      .set(
        snapshot.brushDomain === 'mesh' || snapshot.tool === 'paint'
          ? snapshot.cursorNormal.x
          : 0,
        snapshot.brushDomain === 'mesh' || snapshot.tool === 'paint'
          ? snapshot.cursorNormal.y
          : 1,
        snapshot.brushDomain === 'mesh' || snapshot.tool === 'paint'
          ? snapshot.cursorNormal.z
          : 0,
      )
      .normalize()
    cursor.position
      .set(
        snapshot.cursorPosition.x,
        snapshot.cursorPosition.y,
        snapshot.cursorPosition.z,
      )
      .addScaledVector(cursorNormal, 0.16)
    cursor.quaternion.setFromUnitVectors(cursorAxis, cursorNormal)
    cursor.scale.setScalar(
      snapshot.tool === 'tunnel' ? snapshot.tunnelRadius : snapshot.brushRadius,
    )
    material.color.set(snapshot.dragging ? 0x65e8ff : 0xb7f6df)
  })

  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      material={material}
      renderOrder={10_000}
      visible={false}
    />
  )
}
