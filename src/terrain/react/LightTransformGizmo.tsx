import { useLayoutEffect, useMemo, useRef } from 'react'
import { TransformControls } from '@react-three/drei'
import { Object3D, Vector3 } from 'three'
import type { TransformControls as TransformControlsImpl } from 'three-stdlib'
import type { EditorStore } from '../editor/EditorStore'
import { useEditorSnapshot } from './hooks'
import { useTransformDragSession } from './useTransformDragSession'
import { useTransformControlsPointerBridge } from './useTransformControlsPointerBridge'
import {
  setQuaternionFromSpotlightDirection,
  spotlightDirectionFromQuaternion,
} from './spotlightTransform'

const DEFAULT_SPOT_TARGET_DISTANCE = 24

export function LightTransformGizmo({ editor }: { editor: EditorStore }) {
  const snapshot = useEditorSnapshot(editor)
  const target = useMemo(() => new Object3D(), [])
  const targetPoint = useMemo(() => new Vector3(), [])
  const forward = useMemo(() => new Vector3(), [])
  const transformControls = useRef<TransformControlsImpl>(null)
  useTransformControlsPointerBridge(transformControls)

  const light = snapshot.selectedLightId
    ? snapshot.lights.find((entry) => entry.id === snapshot.selectedLightId)
    : undefined
  const mode =
    light?.type === 'spot' && snapshot.transformMode === 'rotate'
      ? 'rotate'
      : 'translate'

  const commitTransform = () => {
    if (!light) return
    const position = {
      x: target.position.x,
      y: target.position.y,
      z: target.position.z,
    }

    if (light.type === 'point') {
      editor.updateLight(light.id, { position })
      return
    }

    if (mode === 'translate') {
      const deltaX = position.x - light.position.x
      const deltaY = position.y - light.position.y
      const deltaZ = position.z - light.position.z
      editor.updateLight(light.id, {
        position,
        target: {
          x: light.target.x + deltaX,
          y: light.target.y + deltaY,
          z: light.target.z + deltaZ,
        },
      })
      return
    }

    const currentTargetDistance = targetPoint
      .set(
        light.target.x - light.position.x,
        light.target.y - light.position.y,
        light.target.z - light.position.z,
      )
      .length()
    const targetDistance =
      currentTargetDistance > 0.001
        ? currentTargetDistance
        : DEFAULT_SPOT_TARGET_DISTANCE
    spotlightDirectionFromQuaternion(target.quaternion, forward)
      .multiplyScalar(targetDistance)
    editor.updateLight(light.id, {
      target: {
        x: position.x + forward.x,
        y: position.y + forward.y,
        z: position.z + forward.z,
      },
    })
  }

  const enabled =
    light !== undefined &&
    light.visible &&
    snapshot.tool === 'select' &&
    snapshot.cameraMode === 'orbit'
  const { begin, finish, isActive } = useTransformDragSession({
    editor,
    enabled,
    ownerKey: light?.id ?? 'none',
    commit: commitTransform,
    committedStatus: light ? `${light.name} transform saved` : 'Light transform saved',
  })

  useLayoutEffect(() => {
    if (!light || isActive()) return
    target.position.set(light.position.x, light.position.y, light.position.z)
    target.scale.setScalar(1)
    if (light.type === 'spot') {
      targetPoint.set(
        light.target.x - light.position.x,
        light.target.y - light.position.y,
        light.target.z - light.position.z,
      )
      setQuaternionFromSpotlightDirection(target.quaternion, targetPoint)
    } else {
      target.quaternion.identity()
    }
    target.updateMatrixWorld(true)
  }, [isActive, light, target, targetPoint])

  if (!enabled) return null
  return (
    <>
      <primitive object={target} />
      <TransformControls
        ref={transformControls}
        object={target}
        mode={mode}
        space="world"
        size={0.8}
        onMouseDown={begin}
        onMouseUp={finish}
      />
    </>
  )
}
