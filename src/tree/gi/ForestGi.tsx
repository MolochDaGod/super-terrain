import { useEffect, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three/webgpu'
import type {
  AmbientLight,
  DirectionalLight,
  HemisphereLight,
  Light,
  Object3D,
  PerspectiveCamera,
  Renderer,
  Scene,
} from 'three/webgpu'
import { SousaGI, createDebugMaterial, createIrradianceInjector } from '@workspace/idtech-gi'
import { buildForestProxy, type ForestProxyTree } from './forestProxy'
import type { TreeEditorStore } from '../TreeEditorStore'
import { useTreeEditorSnapshot } from '../useTreeEditorSnapshot'

interface DimmedLight {
  light: Light
  intensity: number
}

/**
 * id-Tech-style global illumination for the forest workspace.
 *
 * Mounted only while the View menu's toggle is on. Building the volume takes a
 * second or so, so the component reports progress and the scene keeps rendering
 * on the authored rig until the field is ready.
 */
export function ForestGi({
  store,
  onStatus,
}: {
  store: TreeEditorStore
  onStatus?: (status: string) => void
}) {
  const snapshot = useTreeEditorSnapshot(store)
  const scene = useThree((state) => state.scene) as unknown as Scene
  const renderer = useThree((state) => state.gl) as unknown as Renderer
  const camera = useThree((state) => state.camera) as PerspectiveCamera
  const [gi, setGi] = useState<SousaGI | null>(null)
  // Held in a ref rather than read from props inside the effects: the rig
  // reports progress into the same store this component subscribes to, so a
  // callback in a dependency array would rebuild the volume on every status
  // line it wrote.
  const status = useRef(onStatus)
  status.current = onStatus
  const injector = useRef<ReturnType<typeof createIrradianceInjector> | null>(null)
  const dimmed = useRef<DimmedLight[]>([])
  const rescanIn = useRef(0)
  const patchedMaterials = useRef(0)
  const fill = Math.min(1, Math.max(0, snapshot.giFill))

  // The stand only needs re-voxelising when its trees change, not when the
  // camera moves or a panel re-renders.
  const layoutKey = snapshot.placements
    .map((placement) => {
      const prototype = snapshot.prototypes[placement.prototypeId]
      const parameters = prototype?.parameters
      return `${placement.position.join(',')}|${placement.scale}|${placement.rotation}|${placement.tilt ?? 0}|${parameters?.height ?? 0}|${parameters?.crownRadius ?? 0}`
    })
    .join(';')

  useEffect(() => {
    let cancelled = false
    const trees: ForestProxyTree[] = []
    for (const placement of snapshot.placements) {
      const parameters = snapshot.prototypes[placement.prototypeId]?.parameters
      if (!parameters) continue
      trees.push({
        position: placement.position,
        rotation: placement.rotation,
        scale: placement.scale,
        tilt: placement.tilt,
        height: parameters.height,
        crownRadius: parameters.crownRadius,
        trunkRadius: parameters.trunkRadius,
      })
    }
    if (trees.length === 0) {
      status.current?.('GI: waiting for a stand')
      return
    }

    let built: SousaGI | null = null
    void (async () => {
      const voxels = await buildForestProxy(trees, {
        onProgress: (fraction, label) =>
          status.current?.(`GI: ${label} ${(fraction * 100).toFixed(0)}%`),
      })
      if (cancelled) {
        voxels.dispose()
        return
      }
      built = SousaGI.fromVoxels(voxels, {
        probes: {
          // A stand is wide and low. Wider probe spacing than an interior wants
          // costs nothing here, because there is no small-scale geometry for
          // the bounce to resolve — the occluders are crowns metres across.
          spacing: 1.6,
          resolution: 16,
          raysPerProbe: 64,
        },
      })
      if (cancelled) {
        built.dispose()
        return
      }
      setGi(built)
      status.current?.('GI: converging')
    })()
    return () => {
      cancelled = true
      built?.dispose()
      setGi(null)
    }
    // `layoutKey` is the whole dependency: it summarises every placement and
    // prototype dimension the proxy reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey])

  // Match the GI's key light to the scene's, and hand the authored fill rig
  // over to the probe field.
  useEffect(() => {
    if (!gi) return
    const direction = new Vector3()
    const target = new Vector3()
    const restore: DimmedLight[] = []
    scene.traverse((object) => {
      const light = object as Light & {
        isDirectionalLight?: boolean
        isHemisphereLight?: boolean
        isAmbientLight?: boolean
      }
      if (!light.isLight) return
      if (light.isDirectionalLight) {
        const directional = light as DirectionalLight
        // The shadow caster is the sun; the others are fill.
        if (directional.castShadow) {
          directional.getWorldPosition(direction)
          directional.target.getWorldPosition(target)
          gi.setSun(
            direction.sub(target).normalize(),
            directional.color.clone(),
            directional.intensity,
          )
          return
        }
      } else if (!light.isHemisphereLight && !light.isAmbientLight) {
        return
      }
      restore.push({ light, intensity: light.intensity })
      light.intensity *= fill
    })
    dimmed.current = restore

    // Seed the sky model from the hemisphere the look already defines, so the
    // GI's own sky term agrees with the backdrop rather than inventing one.
    const hemisphere = restore.find(
      (entry) => (entry.light as { isHemisphereLight?: boolean }).isHemisphereLight,
    )?.light as HemisphereLight | undefined
    const ambient = restore.find(
      (entry) => (entry.light as { isAmbientLight?: boolean }).isAmbientLight,
    )?.light as AmbientLight | undefined
    if (hemisphere) {
      // Undo the dimming to recover the look's authored sky, which is what the
      // probe rays should see when they escape the canopy.
      const authored = restoreScale(hemisphere.intensity, fill)
      const sky = hemisphere.color.clone().multiplyScalar(authored)
      const ground = hemisphere.groundColor.clone().multiplyScalar(authored)
      gi.setSky(sky, sky.clone().lerp(ground, 0.45), ground)
    } else if (ambient) {
      const flat = ambient.color
        .clone()
        .multiplyScalar(restoreScale(ambient.intensity, fill))
      gi.setSky(flat, flat, flat.clone().multiplyScalar(0.4))
    }

    return () => {
      for (const entry of dimmed.current) entry.light.intensity = entry.intensity
      dimmed.current = []
    }
  }, [gi, scene, fill])

  useEffect(() => {
    if (!gi || !snapshot.giDebug) return
    const material = createDebugMaterial(gi, 'gi')
    if (!material) return
    const previous = scene.overrideMaterial
    scene.overrideMaterial = material
    return () => {
      scene.overrideMaterial = previous
      material.dispose()
    }
  }, [gi, scene, snapshot.giDebug])

  // Injection is separate from construction: the forest swaps materials as
  // trees cross LOD boundaries, so new ones keep appearing.
  useEffect(() => {
    if (!gi) return
    const inject = createIrradianceInjector(gi.irradianceNode)
    injector.current = inject
    patchedMaterials.current = inject.scan(scene as unknown as Object3D)
    return () => {
      inject.restoreAll()
      injector.current = null
    }
  }, [gi, scene])

  useFrame((_, delta) => {
    if (!gi) return
    rescanIn.current -= delta
    if (rescanIn.current <= 0) {
      rescanIn.current = 0.5
      patchedMaterials.current += injector.current?.scan(scene as unknown as Object3D) ?? 0
    }
    gi.update(renderer, camera)
  }, 0.75)

  useEffect(() => {
    if (!gi) return
    const id = setInterval(() => {
      const stats = gi.stats()
      status.current?.(
        `GI · ${stats.voxelDims.join('×')} @ ${stats.voxelCell.toFixed(2)}m ` +
          `(${stats.occupancy.toLocaleString()} filled) · ` +
          `${stats.probeCount.toLocaleString()} probes · ` +
          `${stats.raysPerFrame.toLocaleString()} rays/frame · ` +
          `${patchedMaterials.current} materials`,
      )
    }, 1000)
    return () => clearInterval(id)
  }, [gi])

  return null
}

/** Recovers a light's authored intensity from the dimmed one. */
function restoreScale(intensity: number, fillScale: number): number {
  return fillScale > 1e-3 ? intensity / fillScale : intensity
}
