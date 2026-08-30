import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Line,
  LineBasicNodeMaterial,
  Mesh,
  MeshBasicNodeMaterial,
  OctahedronGeometry,
  Raycaster,
  Vector2,
  Vector3,
  DoubleSide,
} from 'three/webgpu'
import type { Camera, Object3D } from 'three/webgpu'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import type { TerrainRenderBackend } from '../../terrain/rendering/TerrainRenderBackend'
import { useEditorSnapshot } from '../../terrain/react/hooks'
import { sampleForestSpline, type ForestField } from '../forestField'
import type { ForestFieldStore } from '../ForestFieldStore'
import { useForestFieldSnapshot } from './useForestFieldSnapshot'

/** How far above the ground the ribbon and handles float, in metres. */
const HOVER = 0.6

/**
 * Half-width of the drawn spline ribbon, in metres.
 *
 * Scaled to the field's own fringe rather than fixed, because a fixed value
 * cannot be right at both ends of this tool's range: a metre-wide painted line
 * is legible standing in a stand and is a sub-pixel thread from the two hundred
 * metres up a viewer draws a forest from, which is exactly how the first
 * version looked — nothing on the ground but a row of floating handles.
 */
function ribbonHalfWidth(feather: number): number {
  return Math.min(9, Math.max(1.2, feather * 0.28))
}

/** Screen pixels within which a click counts as grabbing a node. */
const HANDLE_GRAB_PIXELS = 14

/**
 * The spline, drawn on the ground it was drawn on.
 *
 * A one-pixel line is what a first attempt at this always is, and it is
 * unreadable over a lit landscape at any distance: it disappears against pale
 * rock, aliases into dashes as the camera moves, and gives no sense of which
 * side of a ridge it is on. A ribbon laid on the terrain — sampled at the same
 * two-metre spacing the spline itself is sampled at — reads as paint on the
 * ground, which is what it is meant to be, and it follows the relief so a
 * viewer can see the field running over a shoulder and down into a hollow.
 */
export function ForestSplineOverlay({
  terrain,
  forest,
  editor,
  backend,
}: {
  terrain: WorldTerrain
  forest: ForestFieldStore
  editor: EditorStore
  backend: TerrainRenderBackend
}) {
  const snapshot = useForestFieldSnapshot(forest)
  const { tool } = useEditorSnapshot(editor)
  const camera = useThree((state) => state.camera)
  const group = useMemo(() => {
    const root = new Group()
    root.name = 'forest-spline-overlay'
    // Never a raycast target: node picking is done analytically in screen
    // space, and letting the selection tool hit these would make a forest
    // field's own gizmo shadow the terrain behind it.
    root.raycast = () => undefined
    return root
  }, [])

  const materials = useMemo(() => createOverlayMaterials(), [])
  useEffect(() => () => materials.dispose(), [materials])

  const handles = useRef<HandleRecord[]>([])

  // Rebuilt whenever any spline geometry changes. A drag bumps this once per
  // pointer move, which is a few hundred terrain height samples and a buffer
  // rewrite — cheap enough to be immediate, which is the whole reason the
  // forest itself is not rebuilt here.
  useEffect(() => {
    for (const child of [...group.children]) {
      group.remove(child)
      disposeOverlayObject(child)
    }
    handles.current = []
    if (tool !== 'forest') return

    const sample = (x: number, z: number) => terrain.sampleHeight(x, z)
    for (const field of snapshot.fields) {
      if (!field.visible) continue
      const selected = field.id === snapshot.selectedFieldId
      const polyline = sampleForestSpline(field.nodes, field.closed)
      if (polyline.length >= 2) {
        const ribbon = new Mesh(
          buildRibbonGeometry(
            polyline,
            field.closed,
            sample,
            ribbonHalfWidth(field.feather),
          ),
          selected ? materials.ribbonSelected : materials.ribbon,
        )
        ribbon.frustumCulled = false
        ribbon.renderOrder = 10_000
        ribbon.raycast = () => undefined
        group.add(ribbon)

        if (!field.closed) {
          for (const side of [-1, 1] as const) {
            const edge = new Line(
              buildOffsetLineGeometry(polyline, field.width * side, sample),
              selected ? materials.edgeSelected : materials.edge,
            )
            edge.frustumCulled = false
            edge.renderOrder = 10_000
            edge.raycast = () => undefined
            group.add(edge)
          }
        }
      }

      field.nodes.forEach((node, index) => {
        const mesh = new Mesh(
          materials.handleGeometry,
          selected ? materials.handleSelected : materials.handle,
        )
        mesh.position.set(node.x, sample(node.x, node.z) + HOVER, node.z)
        mesh.frustumCulled = false
        mesh.renderOrder = 10_001
        mesh.raycast = () => undefined
        group.add(mesh)
        handles.current.push({ fieldId: field.id, index, object: mesh })
      })
    }
  }, [group, materials, snapshot.fields, snapshot.selectedFieldId, snapshot.splineRevision, terrain, tool])

  // Handles keep a constant size on screen. A gizmo that shrinks with distance
  // is unusable on a four-kilometre world: the node you need is a sub-pixel
  // speck long before the forest it controls is out of sight.
  useFrame(() => {
    if (tool !== 'forest') return
    for (const record of handles.current) {
      const distance = camera.position.distanceTo(record.object.position)
      record.object.scale.setScalar(Math.max(0.35, distance * 0.014))
    }
  })

  return (
    <>
      <primitive object={group} />
      <ForestSplineController
        terrain={terrain}
        forest={forest}
        editor={editor}
        backend={backend}
        handles={handles}
      />
    </>
  )
}

interface HandleRecord {
  fieldId: string
  index: number
  object: Mesh
}

/**
 * Draw and drag, from one capture-phase listener.
 *
 * Bound on `window` rather than the canvas, in the capture phase, for the same
 * reason the ground brush is: the terrain view's own pointer handlers live on
 * the canvas, and a drag that reached them would open a sculpt stroke under
 * the node being moved. Capturing first, and stopping the event once it is
 * clear the gesture belongs to a spline, keeps the two from ever both acting.
 */
function ForestSplineController({
  terrain,
  forest,
  editor,
  backend,
  handles,
}: {
  terrain: WorldTerrain
  forest: ForestFieldStore
  editor: EditorStore
  backend: TerrainRenderBackend
  handles: React.RefObject<HandleRecord[]>
}) {
  const canvas = useThree((state) => state.gl.domElement)
  const camera = useThree((state) => state.camera)
  const { tool } = useEditorSnapshot(editor)

  useEffect(() => {
    if (tool !== 'forest') return
    const raycaster = new Raycaster()
    const ndc = new Vector2()
    const projected = new Vector3()
    let drag: { fieldId: string; index: number; pointerId: number } | undefined

    const groundAt = (event: PointerEvent): Vector3 | null => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, camera as unknown as Camera)
      const hit = backend.raycast(raycaster)
      if (hit) return new Vector3(hit.point.x, hit.point.y, hit.point.z)
      // Terrain that has not streamed in yet still has a height field. Falling
      // back to it means a field can be drawn across ground the renderer has
      // not built, which is ordinary on a four-kilometre world seen from above.
      return marchHeightField(raycaster, terrain)
    }

    const handleAt = (event: PointerEvent): HandleRecord | undefined => {
      const rect = canvas.getBoundingClientRect()
      let best: HandleRecord | undefined
      let bestDistance = HANDLE_GRAB_PIXELS
      for (const record of handles.current ?? []) {
        projected.copy(record.object.position).project(camera)
        if (projected.z > 1) continue
        const x = rect.left + ((projected.x + 1) / 2) * rect.width
        const y = rect.top + ((1 - projected.y) / 2) * rect.height
        const distance = Math.hypot(event.clientX - x, event.clientY - y)
        if (distance < bestDistance) {
          bestDistance = distance
          best = record
        }
      }
      return best
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.composedPath().includes(canvas)) return
      const record = handleAt(event)
      if (record) {
        event.preventDefault()
        event.stopPropagation()
        if (event.altKey) {
          forest.removeNode(record.fieldId, record.index)
          return
        }
        forest.patch({
          selectedFieldId: record.fieldId,
          activeNodeIndex: record.index,
          interacting: true,
        })
        drag = { fieldId: record.fieldId, index: record.index, pointerId: event.pointerId }
        return
      }

      const snapshot = forest.getSnapshot()
      if (!snapshot.drawing || !snapshot.selectedFieldId) return
      const point = groundAt(event)
      if (!point) return
      event.preventDefault()
      event.stopPropagation()
      forest.appendNode(snapshot.selectedFieldId, { x: point.x, z: point.z })
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      const point = groundAt(event)
      if (!point) return
      event.preventDefault()
      event.stopPropagation()
      forest.moveNode(drag.fieldId, drag.index, { x: point.x, z: point.z })
    }

    const endDrag = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      drag = undefined
      // The field has been dirty for the whole drag and nothing has regrown it.
      // Clearing the interaction flag is what releases it to the bake driver —
      // one regrow, on release, instead of one per pointer move.
      forest.patch({
        interacting: false,
        activeNodeIndex: undefined,
        status: 'Spline moved · regrowing the field',
      })
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'Enter' && forest.getSnapshot().drawing) {
        event.preventDefault()
        forest.finishDrawing()
      }
      if (event.key === 'Escape') forest.patch({ drawing: false })
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerup', endDrag, true)
    window.addEventListener('pointercancel', endDrag, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerup', endDrag, true)
      window.removeEventListener('pointercancel', endDrag, true)
      window.removeEventListener('keydown', onKeyDown)
      if (drag) forest.patch({ interacting: false, activeNodeIndex: undefined })
    }
  }, [backend, camera, canvas, forest, handles, terrain, tool])

  return null
}

/**
 * Where a ray meets the height field, by marching it.
 *
 * Only used where the compiled terrain has nothing to hit — beyond the resident
 * radius, or before a section has streamed. The step is deliberately coarse and
 * then bisected: a forest node is placed to the nearest metre by hand anyway,
 * and the alternative is a hundred height samples per pointer move.
 */
function marchHeightField(raycaster: Raycaster, terrain: WorldTerrain): Vector3 | null {
  const origin = raycaster.ray.origin
  const direction = raycaster.ray.direction
  if (direction.y >= -1e-4) return null
  const probe = new Vector3()
  let previous = origin.y - terrain.sampleHeight(origin.x, origin.z)
  for (let distance = 4; distance < 8_000; distance *= 1.06) {
    probe.copy(origin).addScaledVector(direction, distance)
    const gap = probe.y - terrain.sampleHeight(probe.x, probe.z)
    if (gap <= 0 && previous > 0) {
      // One bisection pass over the bracketing interval is a few centimetres
      // at any distance a forest is drawn from.
      let low = distance / 1.06
      let high = distance
      for (let step = 0; step < 24; step += 1) {
        const middle = (low + high) / 2
        probe.copy(origin).addScaledVector(direction, middle)
        if (probe.y - terrain.sampleHeight(probe.x, probe.z) > 0) low = middle
        else high = middle
      }
      probe.copy(origin).addScaledVector(direction, high)
      probe.y = terrain.sampleHeight(probe.x, probe.z)
      return probe.clone()
    }
    previous = gap
  }
  return null
}

interface OverlayMaterials {
  ribbon: MeshBasicNodeMaterial
  ribbonSelected: MeshBasicNodeMaterial
  edge: LineBasicNodeMaterial
  edgeSelected: LineBasicNodeMaterial
  handle: MeshBasicNodeMaterial
  handleSelected: MeshBasicNodeMaterial
  handleGeometry: OctahedronGeometry
  dispose(): void
}

function createOverlayMaterials(): OverlayMaterials {
  // Drawn through the ground, like the handles.
  //
  // The first version depth-tested against the terrain and looked like green
  // paint spilt down a mountainside: the ribbon follows the height field while
  // the rendered surface is a compiled, LOD-selected mesh with CSG cut through
  // it, so the two disagree by a metre in places and the band surfaced only
  // where the disagreement happened to favour it. A gizmo that is legible only
  // where two representations of the ground happen to line up is worse than no
  // gizmo. It is an overlay, so it overlays.
  const ribbon = new MeshBasicNodeMaterial({
    color: 0x4fd6a0,
    transparent: true,
    opacity: 0.22,
    side: DoubleSide,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  const ribbonSelected = new MeshBasicNodeMaterial({
    color: 0x9ff5cd,
    transparent: true,
    opacity: 0.44,
    side: DoubleSide,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  const edge = new LineBasicNodeMaterial({
    color: 0x4fd6a0,
    transparent: true,
    opacity: 0.3,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  const edgeSelected = new LineBasicNodeMaterial({
    color: 0x9ff5cd,
    transparent: true,
    opacity: 0.6,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  const handle = new MeshBasicNodeMaterial({
    color: 0x77e8be,
    // Handles read through the terrain deliberately: a node on the far side of
    // a ridge is still part of the shape being edited, and hiding it is how a
    // spline becomes impossible to close.
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  const handleSelected = new MeshBasicNodeMaterial({
    color: 0xffe9a8,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  const handleGeometry = new OctahedronGeometry(1, 0)
  return {
    ribbon,
    ribbonSelected,
    edge,
    edgeSelected,
    handle,
    handleSelected,
    handleGeometry,
    dispose() {
      ribbon.dispose()
      ribbonSelected.dispose()
      edge.dispose()
      edgeSelected.dispose()
      handle.dispose()
      handleSelected.dispose()
      handleGeometry.dispose()
    },
  }
}

function disposeOverlayObject(object: Object3D): void {
  // Materials are shared and owned by `createOverlayMaterials`; only the
  // per-field geometry is this object's to release.
  const geometry = (object as { geometry?: BufferGeometry }).geometry
  geometry?.dispose()
}

type HeightSampler = (x: number, z: number) => number

function buildRibbonGeometry(
  polyline: readonly { x: number; z: number }[],
  closed: boolean,
  sample: HeightSampler,
  halfWidth: number,
): BufferGeometry {
  const points = closed ? [...polyline, polyline[0]!] : polyline
  const positions = new Float32Array(points.length * 6)
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!
    const previous = points[Math.max(0, index - 1)]!
    const next = points[Math.min(points.length - 1, index + 1)]!
    let tx = next.x - previous.x
    let tz = next.z - previous.z
    const length = Math.hypot(tx, tz) || 1
    tx /= length
    tz /= length
    const offsetX = -tz * halfWidth
    const offsetZ = tx * halfWidth
    const leftX = point.x + offsetX
    const leftZ = point.z + offsetZ
    const rightX = point.x - offsetX
    const rightZ = point.z - offsetZ
    positions[index * 6] = leftX
    positions[index * 6 + 1] = sample(leftX, leftZ) + HOVER
    positions[index * 6 + 2] = leftZ
    positions[index * 6 + 3] = rightX
    positions[index * 6 + 4] = sample(rightX, rightZ) + HOVER
    positions[index * 6 + 5] = rightZ
  }

  const segments = points.length - 1
  const indices = new Uint32Array(Math.max(0, segments) * 6)
  for (let index = 0; index < segments; index += 1) {
    const a = index * 2
    indices.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], index * 6)
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setIndex(new BufferAttribute(indices, 1))
  return geometry
}

function buildOffsetLineGeometry(
  polyline: readonly { x: number; z: number }[],
  offset: number,
  sample: HeightSampler,
): BufferGeometry {
  const positions = new Float32Array(polyline.length * 3)
  for (let index = 0; index < polyline.length; index += 1) {
    const point = polyline[index]!
    const previous = polyline[Math.max(0, index - 1)]!
    const next = polyline[Math.min(polyline.length - 1, index + 1)]!
    let tx = next.x - previous.x
    let tz = next.z - previous.z
    const length = Math.hypot(tx, tz) || 1
    tx /= length
    tz /= length
    const x = point.x - tz * offset
    const z = point.z + tx * offset
    positions[index * 3] = x
    positions[index * 3 + 1] = sample(x, z) + HOVER
    positions[index * 3 + 2] = z
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  return geometry
}

export type { ForestField }
