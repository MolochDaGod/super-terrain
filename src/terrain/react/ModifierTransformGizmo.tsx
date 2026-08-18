import { useEffect, useMemo, useRef } from 'react'
import { TransformControls } from '@react-three/drei'
import { Object3D } from 'three'
import type { TransformControls as TransformControlsImpl } from 'three-stdlib'
import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'
import {
  modifierTransformPivot,
  normalizedTransform,
} from '../modifiers/transform'
import {
  useEditorSnapshot,
  useModifierRevision,
} from './hooks'
import { useTransformDragSession } from './useTransformDragSession'
import { useTransformControlsPointerBridge } from './useTransformControlsPointerBridge'

export function ModifierTransformGizmo({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
}) {
  const revision = useModifierRevision(terrain)
  const snapshot = useEditorSnapshot(editor)
  const target = useMemo(() => new Object3D(), [])
  const transformControls = useRef<TransformControlsImpl>(null)
  useTransformControlsPointerBridge(transformControls)
  const modifier = snapshot.selectedModifierId
    ? terrain.modifiers.get(snapshot.selectedModifierId)
    : undefined
  const editable = modifier?.type === 'boolean-volume' ? modifier : undefined

  const commitTransform = () => {
    if (!editable) return
    const current = terrain.modifiers.get(editable.id)
    if (!current || current.type !== 'boolean-volume') return
    const pivot = modifierTransformPivot(current)
    const scale = Math.max(
      0.05,
      (target.scale.x + target.scale.y + target.scale.z) / 3,
    )
    target.scale.setScalar(scale)
    terrain.updateModifierTransform(current.id, {
      offset: {
        x: target.position.x - pivot.x,
        y: target.position.y - pivot.y,
        z: target.position.z - pivot.z,
      },
      pitch: target.rotation.x,
      yaw: target.rotation.y,
      roll: target.rotation.z,
      scale,
    })
  }
  const { begin, finish, isActive } = useTransformDragSession({
    editor,
    enabled:
      editable !== undefined &&
      snapshot.tool === 'select' &&
      snapshot.cameraMode === 'orbit',
    ownerKey: editable?.id ?? 'none',
    commit: commitTransform,
    committedStatus: 'CSG transform committed · rebuild queued',
  })

  useEffect(() => {
    if (!editable) return
    if (isActive()) return
    const pivot = modifierTransformPivot(editable)
    const transform = normalizedTransform(editable.transform)
    target.position.set(
      pivot.x + transform.offset.x,
      pivot.y + transform.offset.y,
      pivot.z + transform.offset.z,
    )
    target.rotation.set(
      transform.pitch ?? 0,
      transform.yaw,
      transform.roll ?? 0,
      'XYZ',
    )
    target.scale.setScalar(transform.scale)
    target.updateMatrixWorld(true)
  }, [editable, isActive, revision, target])

  if (
    !editable ||
    snapshot.tool !== 'select' ||
    snapshot.cameraMode !== 'orbit'
  ) {
    return null
  }
  return (
    <>
      <primitive object={target} />
      <TransformControls
        ref={transformControls}
        object={target}
        mode={snapshot.transformMode}
        space={snapshot.transformMode === 'scale' ? 'local' : 'world'}
        size={0.8}
        onMouseDown={begin}
        onMouseUp={finish}
      />
    </>
  )
}
