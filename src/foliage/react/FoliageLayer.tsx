import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTexture } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import {
  AdditiveBlending,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  Plane,
  Raycaster,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type Object3D,
  type Renderer,
} from 'three/webgpu'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import groundArmUrl from '../../terrain/react/assets/rock-ground-arm-1k.jpg'
import groundMapUrl from '../../terrain/react/assets/rock-ground-diffuse-1k.jpg'
import groundNormalUrl from '../../terrain/react/assets/rock-ground-normal-gl-1k.jpg'
import { FoliageSystem } from '../FoliageSystem'
import { MEADOW_FLOOR, type FoliageFloorRecipe } from '../foliageFloor'
import type { FoliageEditorStore } from '../FoliageEditorStore'
import { foliageSpeciesIndex } from '../foliageSpecies'
import { foliageSurfaceIndex } from '../foliageSurfaces'
import { useFoliageSnapshot } from './useFoliageSnapshot'

/** Metres of soil texture per tile. Matches the tree workspace's review ground. */
const SOIL_TILE_SIZE = 5

const GROUND_PLANE = /*@__PURE__*/ new Plane(new Vector3(0, 1, 0), 0)

export interface FoliageLayerProps {
  store: FoliageEditorStore
  /**
   * The floor this layer opens on: which ground layers cover the soil, which
   * plants colonise it, and how dark the soil under all of it reads.
   *
   * Everything in it is laid down as ordinary brush strokes, so nothing here
   * is privileged over what the user paints afterwards — including the ground
   * layers, which used to be constants compiled into the material and were
   * therefore impossible to erase.
   */
  recipe?: FoliageFloorRecipe
  /**
   * Compiles the layer against the real multisampled scene attachment before
   * anything is shown. Without it the first frame that includes the grass
   * builds a large pipeline synchronously, inside the frame, which the
   * browser's GPU watchdog is entitled to treat as a hang.
   */
  warmup?: (object: Object3D) => Promise<void>
}

export function FoliageLayer({
  store,
  recipe = MEADOW_FLOOR,
  warmup,
}: FoliageLayerProps) {
  const renderer = useThree((state) => state.gl) as unknown as Renderer
  const camera = useThree((state) => state.camera)
  const canvas = useThree((state) => state.gl.domElement)
  const size = useThree((state) => state.size)
  const dpr = useThree((state) => state.viewport.dpr)
  const controls = useThree((state) => state.controls) as OrbitControlsImpl | null
  const snapshot = useFoliageSnapshot(store)

  const [map, normalMap, armMap] = useTexture([
    groundMapUrl,
    groundNormalUrl,
    groundArmUrl,
  ])
  useMemo(() => {
    for (const texture of [map, normalMap, armMap]) {
      texture.wrapS = RepeatWrapping
      texture.wrapT = RepeatWrapping
      texture.anisotropy = 8
      texture.needsUpdate = true
    }
    map.colorSpace = SRGBColorSpace
  }, [armMap, map, normalMap])

  // Keyed by the soil tint alone. The rest of the recipe is painted through
  // the mask at runtime, so changing preset does not rebuild the material — it
  // repaints the field. The tint is the one part that is genuinely baked in,
  // because it multiplies the soil map before anything samples it.
  const soilTint = recipe.soilTint
  const tintKey = soilTint.join(',')
  const system = useMemo(
    () =>
      new FoliageSystem({
        map,
        normalMap,
        armMap,
        tileSize: SOIL_TILE_SIZE,
        soilTint: tintKey.split(',').map(Number) as unknown as
          readonly [number, number, number],
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [armMap, map, normalMap, tintKey],
  )
  useEffect(() => () => system.dispose(), [system])

  // Hidden until its pipelines exist, then revealed by the store's visibility.
  const warmed = useRef(false)
  useEffect(() => {
    system.group.visible = false
    if (!warmup) {
      warmed.current = true
      return
    }
    let cancelled = false
    void warmup(system.group).then(
      () => {
        if (!cancelled) warmed.current = true
      },
      (error: unknown) => {
        if (cancelled) return
        // A failed warm-up must not mean no grass: the pipeline will simply be
        // built on first use instead.
        console.error('Foliage warm-up failed', error)
        warmed.current = true
      },
    )
    return () => {
      cancelled = true
    }
  }, [system, warmup])

  // Development handle. The only way to know how many clumps a ring actually
  // placed is to read its indirect draw argument, and that is a GPU readback:
  // fine for a console query, never in the frame loop.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const globals = globalThis as Record<string, unknown>
    globals.__foliage = {
      system,
      store,
      counts: async () =>
        Promise.all(
          system.rings.map(async (ring) => {
            const buffer = await (
              renderer as unknown as {
                getArrayBufferAsync(attribute: unknown): Promise<ArrayBuffer>
              }
            ).getArrayBufferAsync(ring.geometry.indirect)
            const args = new Uint32Array(buffer)
            return {
              ring: ring.config.name,
              drawn: args[1],
              capacity: ring.capacity,
              triangles: (args[1] * args[0]) / 3,
            }
          }),
        ),
    }
    return () => {
      delete globals.__foliage
    }
  }, [renderer, store, system])

  const cursor = useBrushCursor()
  const pointer = usePointerPainting(store, camera, canvas, controls, snapshot.tool)

  const elapsed = useRef(0)

  useFrame((_, delta) => {
    const state = store.getSnapshot()
    elapsed.current += Math.min(delta, 0.1)

    // Idempotent: it returns immediately once this recipe has been queued, and
    // re-queues from scratch when the workspace switches to another preset.
    system.seed(recipe)

    for (const command of store.takeCommands()) {
      if (command.kind === 'clear') {
        system.clear(renderer)
      } else if (command.kind === 'fill') {
        system.fill(
          renderer,
          state.layer === 'surface'
            ? foliageSurfaceIndex(state.surface)
            : foliageSpeciesIndex(state.species),
          'paint',
          state.layer,
        )
      } else {
        system.reseed(renderer, recipe)
      }
    }

    // Before the visibility gate: the floor has to be laid down whether or not
    // anyone is looking at it, or hiding the layer while it seeds would leave
    // it permanently half-painted.
    system.pump(renderer)

    system.setDensity(state.density)
    system.setWind(state.wind)

    const stroke = pointer.consumeStroke(delta)
    if (stroke) {
      system.paint(renderer, {
        ...stroke,
        species: state.layer === 'surface'
          ? foliageSurfaceIndex(state.surface)
          : foliageSpeciesIndex(state.species),
        layer: state.layer,
        radius: state.radius,
        hardness: state.hardness,
        mode: state.tool === 'erase' ? 'erase' : 'paint',
      })
    }

    cursor.update(pointer.hover.current, state.radius, state.tool, state.painting)

    system.group.visible = warmed.current && state.visible
    if (!system.group.visible) return
    system.update(renderer, camera, elapsed.current, Math.max(1, size.height * dpr))
  }, 0.4)

  return (
    <>
      <primitive object={system.group} />
      <primitive object={cursor.object} />
    </>
  )
}

/** The painted footprint, drawn flat on the ground the brush actually writes to. */
function useBrushCursor() {
  const object = useMemo(() => {
    const material = new MeshBasicNodeMaterial({
      color: 0x8ce8a6,
      transparent: true,
      opacity: 0.85,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    const mesh = new Mesh(new RingGeometry(0.965, 1, 96), material)
    mesh.name = 'foliage-brush-cursor'
    mesh.rotation.x = -Math.PI / 2
    mesh.renderOrder = 10_002
    mesh.frustumCulled = false
    mesh.visible = false
    return mesh
  }, [])

  useEffect(
    () => () => {
      object.geometry.dispose()
      ;(object.material as MeshBasicNodeMaterial).dispose()
    },
    [object],
  )

  const update = useCallback(
    (
      hover: Vector3 | null,
      radius: number,
      tool: string,
      painting: boolean,
    ) => {
      object.visible = tool !== 'none' && hover !== null
      if (!object.visible || !hover) return
      object.position.set(hover.x, 0.045, hover.z)
      object.scale.setScalar(radius)
      const material = object.material as MeshBasicNodeMaterial
      material.color.set(tool === 'erase' ? 0xffa56f : 0x8ce8a6)
      material.opacity = painting ? 1 : 0.6
    },
    [object],
  )

  return { object, update }
}

interface PendingStroke {
  fromX: number
  fromZ: number
  toX: number
  toZ: number
  flow: number
}

/**
 * Pointer capture for the brush.
 *
 * The listeners are bound on `window` in the capture phase so a painting drag
 * never reaches the canvas, where the orbit controller is waiting for it. The
 * controller's left button is unbound for the duration and rotation moves to
 * the right button, so the camera stays usable while a tool is armed rather
 * than the user having to disarm it to look around.
 */
function usePointerPainting(
  store: FoliageEditorStore,
  camera: THREE_Camera,
  canvas: HTMLCanvasElement,
  controls: OrbitControlsImpl | null,
  tool: string,
) {
  const raycaster = useMemo(() => new Raycaster(), [])
  const ndc = useMemo(() => new Vector2(), [])
  const hit = useMemo(() => new Vector3(), [])
  const hover = useRef<Vector3 | null>(null)
  const last = useRef<{ x: number; z: number } | null>(null)
  const pending = useRef<PendingStroke | null>(null)
  const down = useRef(false)

  const project = useCallback(
    (event: PointerEvent): Vector3 | null => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, camera)
      return raycaster.ray.intersectPlane(GROUND_PLANE, hit)
    },
    [camera, canvas, hit, ndc, raycaster],
  )

  useEffect(() => {
    if (tool === 'none') {
      hover.current = null
      down.current = false
      last.current = null
      store.setPainting(false)
      return
    }

    const previousButtons = controls
      ? { ...controls.mouseButtons }
      : undefined
    if (controls) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      controls.mouseButtons = { ...controls.mouseButtons, LEFT: null } as any
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.composedPath().includes(canvas)) return
      const point = project(event)
      if (!point) return
      event.stopPropagation()
      event.preventDefault()
      down.current = true
      hover.current = point.clone()
      last.current = { x: point.x, z: point.z }
      pending.current = {
        fromX: point.x,
        fromZ: point.z,
        toX: point.x,
        toZ: point.z,
        flow: 1,
      }
      store.setPainting(true)
    }

    const onPointerMove = (event: PointerEvent) => {
      const point = project(event)
      if (!point) {
        hover.current = null
        return
      }
      hover.current = hover.current ?? new Vector3()
      hover.current.copy(point)
      if (!down.current) return
      event.stopPropagation()
      const from = last.current ?? { x: point.x, z: point.z }
      const existing = pending.current
      pending.current = {
        fromX: existing?.fromX ?? from.x,
        fromZ: existing?.fromZ ?? from.z,
        toX: point.x,
        toZ: point.z,
        flow: 1,
      }
      last.current = { x: point.x, z: point.z }
    }

    const onPointerUp = (event: PointerEvent) => {
      if (event.button !== 0 || !down.current) return
      event.stopPropagation()
      down.current = false
      last.current = null
      store.setPainting(false)
    }

    const onLeave = () => {
      hover.current = null
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerup', onPointerUp, true)
    canvas.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      canvas.removeEventListener('pointerleave', onLeave)
      if (controls && previousButtons) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        controls.mouseButtons = previousButtons as any
      }
      down.current = false
      store.setPainting(false)
    }
  }, [canvas, controls, project, store, tool])

  const consumeStroke = useCallback(
    (delta: number) => {
      const stroke = pending.current
      if (!stroke) return null
      // A stroke that is still being dragged keeps its head as the next
      // segment's tail, so a slow drag paints continuously rather than
      // re-stamping the same dab.
      pending.current = down.current
        ? {
            fromX: stroke.toX,
            fromZ: stroke.toZ,
            toX: stroke.toX,
            toZ: stroke.toZ,
            flow: 1,
          }
        : null
      const state = store.getSnapshot()
      return {
        fromX: stroke.fromX,
        fromZ: stroke.fromZ,
        toX: stroke.toX,
        toZ: stroke.toZ,
        flow: Math.min(1, state.flow * Math.min(delta, 0.05) * 14),
      }
    },
    [store],
  )

  return { hover, consumeStroke }
}

type THREE_Camera = Parameters<Raycaster['setFromCamera']>[1]
