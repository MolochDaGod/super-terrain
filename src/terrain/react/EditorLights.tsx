import { useEffect, useMemo } from 'react'
import {
  MeshBasicNodeMaterial,
  Object3D,
  SphereGeometry,
} from 'three/webgpu'
import type { EditorStore } from '../editor/EditorStore'
import type { EditorLight, EditorSpotLight } from '../editor/lights'
import { useEditorSnapshot } from './hooks'

export function EditorLights({ editor }: { editor: EditorStore }) {
  const { lights, selectedLightId, uiViewMode } = useEditorSnapshot(editor)

  return (
    <group name="Editor lights">
      {lights.map((light) => (
        <EditorLightObject
          key={light.id}
          light={light}
          selected={light.id === selectedLightId}
          showMarker={uiViewMode === 'editor'}
        />
      ))}
    </group>
  )
}

function EditorLightObject({
  light,
  selected,
  showMarker,
}: {
  light: EditorLight
  selected: boolean
  showMarker: boolean
}) {
  const position: [number, number, number] = [
    light.position.x,
    light.position.y,
    light.position.z,
  ]

  return (
    <>
      {light.type === 'point' ? (
        <pointLight
          name={light.name}
          color={light.color}
          intensity={light.intensity}
          distance={light.distance}
          decay={light.decay}
          position={position}
          visible={light.visible}
        />
      ) : (
        <EditorSpotLightObject light={light} />
      )}
      {showMarker && (
        <LightMarker
          light={light}
          selected={selected}
          position={position}
        />
      )}
    </>
  )
}

function EditorSpotLightObject({ light }: { light: EditorSpotLight }) {
  const target = useMemo(() => new Object3D(), [])
  target.name = `${light.name} Target`
  target.position.set(light.target.x, light.target.y, light.target.z)

  return (
    <>
      <primitive object={target} />
      <spotLight
        name={light.name}
        color={light.color}
        intensity={light.intensity}
        distance={light.distance}
        decay={light.decay}
        angle={light.angle}
        penumbra={light.penumbra}
        position={[light.position.x, light.position.y, light.position.z]}
        target={target}
        visible={light.visible}
      />
    </>
  )
}

function LightMarker({
  light,
  selected,
  position,
}: {
  light: EditorLight
  selected: boolean
  position: [number, number, number]
}) {
  const geometry = useMemo(() => new SphereGeometry(2.2, 12, 8), [])
  const material = useMemo(
    () =>
      new MeshBasicNodeMaterial({
        color: light.color,
        depthTest: false,
        transparent: true,
        opacity: selected ? 1 : 0.72,
      }),
    [light.color, selected],
  )

  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => () => material.dispose(), [material])

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={position}
      scale={selected ? 1.5 : 1}
      renderOrder={1000}
      visible={light.visible}
      userData={{ pickTarget: { kind: 'light', id: light.id } }}
    />
  )
}
