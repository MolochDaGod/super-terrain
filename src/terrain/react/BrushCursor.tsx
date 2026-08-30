import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AdditiveBlending,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  RingGeometry,
  Vector3,
} from 'three/webgpu'
import type {
  EditorStore,
  EditorTool,
  WaterPaintMode,
} from '../editor/EditorStore'

interface BrushCursorProps {
  editor: EditorStore
}

/** Tools that add material, versus the ones that take it away. */
const SUBTRACTIVE_TOOLS = new Set<EditorTool>([
  'lower',
  'scrape',
  'tunnel',
  'dig',
])

const ADDITIVE_COLOR = 0x7ef0c8
const SUBTRACTIVE_COLOR = 0xffa56f
const NEUTRAL_COLOR = 0xa8c8ff
const WATER_ADD_COLOR = 0x6fd0ff

export function BrushCursor({ editor }: BrushCursorProps) {
  const group = useRef<Group>(null)
  const rim = useRef<Mesh>(null)
  const core = useRef<Mesh>(null)
  const fill = useRef<Mesh>(null)

  // A flat annulus rather than a torus: uniform scaling keeps its width an
  // honest fraction of the brush, so the ring reads as bold on a wide brush and
  // fine on a narrow one instead of dissolving into a hairline at both ends.
  const rimGeometry = useMemo(() => new RingGeometry(0.972, 1, 96), [])
  const coreGeometry = useMemo(() => new RingGeometry(0.978, 1, 96), [])
  const fillGeometry = useMemo(() => new RingGeometry(0, 1, 96), [])

  const rimMaterial = useMemo(
    () => cursorMaterial(0.95),
    [],
  )
  const coreMaterial = useMemo(() => cursorMaterial(0.5), [])
  const fillMaterial = useMemo(() => cursorMaterial(0.07), [])

  const cursorAxis = useMemo(() => new Vector3(0, 0, 1), [])
  const cursorNormal = useMemo(() => new Vector3(0, 1, 0), [])

  useEffect(
    () => () => {
      for (const geometry of [rimGeometry, coreGeometry, fillGeometry]) {
        geometry.dispose()
      }
      for (const material of [rimMaterial, coreMaterial, fillMaterial]) {
        material.dispose()
      }
    },
    [
      rimGeometry,
      coreGeometry,
      fillGeometry,
      rimMaterial,
      coreMaterial,
      fillMaterial,
    ],
  )

  useFrame(() => {
    const cursor = group.current
    if (!cursor || !rim.current || !core.current || !fill.current) return
    const snapshot = editor.getSnapshot()
    // The viewport verbs — camera, select, 3D cursor — have no brush footprint,
    // so drawing one would promise an edit that dragging will not make.
    cursor.visible =
      snapshot.uiViewMode === 'editor' &&
      snapshot.cursorVisible &&
      snapshot.tool !== 'select' &&
      snapshot.tool !== 'camera' &&
      snapshot.tool !== 'forest' &&
      snapshot.tool !== 'cursor'
    if (!cursor.visible) return

    // Water is a level surface, so its footprint is the horizontal disc the
    // stroke actually floods and not a ring draped over the slope.
    const followsSurface =
      snapshot.tool !== 'water' &&
      (snapshot.brushDomain === 'mesh' ||
      snapshot.tool === 'paint' ||
      snapshot.tool === 'tunnel' ||
      snapshot.tool === 'dig')
    cursorNormal
      .set(
        followsSurface ? snapshot.cursorNormal.x : 0,
        followsSurface ? snapshot.cursorNormal.y : 1,
        followsSurface ? snapshot.cursorNormal.z : 0,
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

    const radius = snapshot.tool === 'tunnel'
      ? snapshot.tunnelRadius
      : snapshot.tool === 'dig'
        ? snapshot.digRadius
        : snapshot.tool === 'water'
          ? snapshot.waterRadius
          : snapshot.brushRadius
    rim.current.scale.setScalar(radius)
    fill.current.scale.setScalar(radius)

    // The inner ring is the brush's flat top, drawn from the same expression
    // the sculpt kernel uses. Where it sits tells the user how much of the
    // footprint moves at full strength before the profile starts to taper.
    const hasProfile =
      snapshot.tool !== 'tunnel' &&
      snapshot.tool !== 'dig' &&
      snapshot.tool !== 'water'
    const coreRadius = radius * (1 - clamp01(snapshot.brushFalloff)) * 0.9
    core.current.visible = hasProfile && coreRadius > radius * 0.06
    core.current.scale.setScalar(coreRadius)

    const color = cursorColor(snapshot.tool, snapshot.waterMode)
    for (const material of [rimMaterial, coreMaterial, fillMaterial]) {
      material.color.set(color)
    }
    // Pressing brightens the footprint, and strength drives how much of it
    // lights up, so the amount of material a drag will move is visible before
    // the first dab lands rather than only after it.
    const emphasis = snapshot.dragging ? 1 : 0.62
    rimMaterial.opacity = 0.95 * emphasis
    coreMaterial.opacity = 0.5 * emphasis
    fillMaterial.opacity =
      (0.03 + clamp01(snapshot.brushStrength) * 0.09) * emphasis
  })

  return (
    <group ref={group} visible={false}>
      <mesh
        ref={fill}
        geometry={fillGeometry}
        material={fillMaterial}
        renderOrder={10_000}
      />
      <mesh
        ref={core}
        geometry={coreGeometry}
        material={coreMaterial}
        renderOrder={10_001}
      />
      <mesh
        ref={rim}
        geometry={rimGeometry}
        material={rimMaterial}
        renderOrder={10_002}
      />
    </group>
  )
}

function cursorMaterial(opacity: number): MeshBasicNodeMaterial {
  return new MeshBasicNodeMaterial({
    color: ADDITIVE_COLOR,
    transparent: true,
    opacity,
    side: DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: AdditiveBlending,
  })
}

function cursorColor(tool: EditorTool, waterMode: WaterPaintMode): number {
  if (tool === 'water') {
    return waterMode === 'add' ? WATER_ADD_COLOR : SUBTRACTIVE_COLOR
  }
  if (SUBTRACTIVE_TOOLS.has(tool)) return SUBTRACTIVE_COLOR
  if (tool === 'raise' || tool === 'clay') return ADDITIVE_COLOR
  return NEUTRAL_COLOR
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
