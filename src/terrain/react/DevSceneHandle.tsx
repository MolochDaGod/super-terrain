import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Raycaster, Vector2 } from 'three/webgpu'
import type { WorldTerrain } from '../WorldTerrain'

/**
 * Publishes the live scene graph on `window.__meshterrainScene` in development
 * only. The browser screenshot harness uses it to read what was actually
 * rendered — sun direction, tone mapping, shadow state — instead of inferring
 * it from the source, which is how the offline capture tool and the editor
 * drifted apart in the first place.
 */
export function DevSceneHandle({ terrain }: { terrain: WorldTerrain }) {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)
  const controls = useThree((state) => state.controls)
  const mountedAt = useRef(performance.now())
  const quietSince = useRef(0)
  const settledAt = useRef(0)
  const sampledFrames = useRef(0)
  const raycaster = useRef(new Raycaster())
  const pointer = useRef(new Vector2())
  const diagnosticPixel = useRef(parseDiagnosticPixel())

  useFrame(() => {
    if (!import.meta.env.DEV) return
    sampledFrames.current += 1
    if (sampledFrames.current % 15 !== 0) return
    const metrics = terrain.metrics.getSnapshot()
    const now = performance.now()
    const busy =
      metrics.workerQueuedJobs > 0 ||
      metrics.workerActiveJobs > 0 ||
      metrics.sectionsRebuilding > 0 ||
      metrics.visibleSections === 0
    if (busy) {
      quietSince.current = 0
    } else if (quietSince.current === 0) {
      quietSince.current = now
    } else if (settledAt.current === 0 && now - quietSince.current >= 1_000) {
      settledAt.current = now
    }
    const elapsed = settledAt.current > 0
      ? settledAt.current - mountedAt.current
      : now - mountedAt.current
    gl.domElement.setAttribute('role', 'img')
    const diagnostic = diagnosticPixel.current
    let rayLabel = ''
    if (diagnostic) {
      const bounds = gl.domElement.getBoundingClientRect()
      pointer.current.set(
        diagnostic.x / Math.max(1, bounds.width) * 2 - 1,
        -(diagnostic.y / Math.max(1, bounds.height) * 2 - 1),
      )
      raycaster.current.setFromCamera(pointer.current, camera)
      const hit = raycaster.current.intersectObjects(scene.children, true)[0]
      if (hit) {
        const baseHeight = terrain.sampleHeight(hit.point.x, hit.point.z)
        rayLabel = ` · ray ${diagnostic.x},${diagnostic.y}: ` +
          `${hit.object.name || hit.object.parent?.name || hit.object.type} ` +
          `at ${hit.point.toArray().map((value) => Math.round(value)).join(',')} ` +
          `(base ${Math.round(baseHeight)}, delta ${Math.round(hit.point.y - baseHeight)})`
      }
    }
    gl.domElement.setAttribute(
      'aria-label',
      [
        `MeshTerrain ${settledAt.current > 0 ? 'settled' : 'loading'}`,
        `${Math.round(elapsed)}ms`,
        `${Math.round(metrics.fps)}fps`,
        `${metrics.visibleSections} sections`,
        `${metrics.trianglesRendered} triangles`,
        `lod ${metrics.trianglesByLod.join('/')}`,
        `jobs ${metrics.workerActiveJobs} active/${metrics.workerQueuedJobs} queued`,
        `compile p50/p95 ${Math.round(metrics.compileP50Ms)}/${Math.round(metrics.compileP95Ms)}ms`,
      ].join(' · ') + rayLabel,
    )
  })

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const globals = globalThis as Record<string, unknown>
    globals.__meshterrainScene = {
      gl,
      scene,
      camera,
      /**
       * Moves the view, controller and all.
       *
       * Setting `camera.position` from a console does not stick: the orbit
       * controller owns the camera and writes its own state back on the next
       * frame, so an external move survives for one frame and is then undone.
       * Anything driving the editor from outside — the review harness, a
       * reproduction script — has to go through the controller, and this is the
       * one place that knows where it is.
       */
      placeCamera(
        position: [number, number, number],
        target: [number, number, number],
      ) {
        camera.position.set(position[0], position[1], position[2])
        const controller = controls as {
          target?: { set(x: number, y: number, z: number): void }
          update?: () => void
        } | null
        controller?.target?.set(target[0], target[1], target[2])
        controller?.update?.()
        camera.lookAt(target[0], target[1], target[2])
        camera.updateMatrixWorld(true)
        return { position: camera.position.toArray(), target }
      },
      /** Browser-review diagnostic: identifies the actual surface at a pixel. */
      raycastPixel(x: number, y: number, width: number, height: number) {
        pointer.current.set(x / width * 2 - 1, -(y / height * 2 - 1))
        raycaster.current.setFromCamera(pointer.current, camera)
        return raycaster.current.intersectObjects(scene.children, true).slice(0, 8).map((hit) => ({
          distance: Number(hit.distance.toFixed(2)),
          name: hit.object.name || hit.object.parent?.name || hit.object.type,
          point: hit.point.toArray().map((value) => Number(value.toFixed(1))),
        }))
      },
    }
    return () => {
      delete globals.__meshterrainScene
      gl.domElement.removeAttribute('role')
      gl.domElement.removeAttribute('aria-label')
    }
  }, [camera, controls, gl, scene])

  return null
}

function parseDiagnosticPixel(): { x: number; y: number } | undefined {
  if (typeof location === 'undefined') return undefined
  const value = new URLSearchParams(location.search).get('ray')
  if (!value) return undefined
  const [x, y] = value.split(',').map(Number)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
}
