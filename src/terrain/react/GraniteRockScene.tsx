import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { TransformControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import type { TransformControls as TransformControlsImpl } from 'three-stdlib'
import {
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu'
import type { Group, Mesh, PerspectiveCamera } from 'three/webgpu'
import type { WorldTerrain } from '../WorldTerrain'
import type { EditorStore } from '../editor/EditorStore'
import {
  createGraniteLodDitherBoundaries,
  createGraniteRockMaterial,
  updateGraniteRockMaterial,
} from '../rocks/createGraniteRockMaterial'
import {
  drawableGraniteLodWeights,
  graniteLodWeightsForLevel,
  projectedGraniteErrorPixels,
  settleGraniteLodWeights,
  targetGraniteLodWeights,
} from '../rocks/graniteRockLod'
import {
  graniteLodForDetail,
  loadGraniteRockResources,
  type GraniteRockResources,
} from '../rocks/graniteRockResources'
import {
  graniteRockScaleMagnitude,
  graniteSourceSeed,
  normalizeGraniteRockScale,
  type GraniteRock,
} from '../rocks/types'
import {
  useEditorSnapshot,
  useGraniteRockRevision,
} from './hooks'
import { useTransformDragSession } from './useTransformDragSession'
import { useTransformControlsPointerBridge } from './useTransformControlsPointerBridge'

export function GraniteRockScene({
  terrain,
  editor,
}: {
  terrain: WorldTerrain
  editor: EditorStore
}) {
  useGraniteRockRevision(terrain)
  const editorSnapshot = useEditorSnapshot(editor)
  const rocks = terrain.rocks.snapshot()

  return (
    <group name="authored-granite-rocks">
      {rocks.map((rock) => (
        <GraniteRockObject
          key={rock.id}
          rock={rock}
          terrain={terrain}
          editor={editor}
          selected={
            editorSnapshot.uiViewMode === 'editor' &&
            editorSnapshot.selectedRockId === rock.id
          }
          transformMode={editorSnapshot.transformMode}
          editable={
            editorSnapshot.tool === 'select' &&
            editorSnapshot.uiViewMode === 'editor' &&
            editorSnapshot.cameraMode === 'orbit'
          }
        />
      ))}
    </group>
  )
}

function GraniteRockObject({
  rock,
  terrain,
  editor,
  selected,
  transformMode,
  editable,
}: {
  rock: GraniteRock
  terrain: WorldTerrain
  editor: EditorStore
  selected: boolean
  transformMode: 'translate' | 'rotate' | 'scale'
  editable: boolean
}) {
  const [target, setTarget] = useState<Group | null>(null)
  const [resources, setResources] = useState<GraniteRockResources | null>(null)
  const transformControls = useRef<TransformControlsImpl>(null)
  const lodMeshes = useRef<Array<Mesh | null>>([null, null, null])
  const rockWorldPosition = useMemo(() => new Vector3(), [])
  const cameraWorldPosition = useMemo(() => new Vector3(), [])
  const rockWorldScale = useMemo(() => new Vector3(), [])
  useTransformControlsPointerBridge(transformControls)
  const targetRef = useCallback((node: Group | null) => setTarget(node), [])
  const sourceSeed = graniteSourceSeed(rock.parameters.seed)
  const lodLevel = graniteLodForDetail(rock.parameters.detail)
  const effectivePlacementScale =
    rock.parameters.placementScale *
    graniteRockScaleMagnitude(rock.transform.scale)
  const {
    detailStrength,
    lichen,
    moss,
    snow,
    surfaceSeed,
    wetness,
  } = rock.parameters

  useEffect(() => {
    let live = true
    setResources(null)
    void loadGraniteRockResources(sourceSeed).then(
      (loaded) => {
        if (live) setResources(loaded)
      },
      (error: unknown) => {
        if (!live) return
        editor.patch({
          status: `Granite source asset failed to load · ${error instanceof Error ? error.message : String(error)}`,
        })
      },
    )
    return () => {
      live = false
    }
  }, [editor, sourceSeed])

  const materialBundle = useMemo(() => {
    if (!resources) return null
    const weights = graniteLodWeightsForLevel(lodLevel)
    const boundaries = createGraniteLodDitherBoundaries(weights)
    return {
      boundaries,
      weights,
      materials: ([0, 1, 2] as const).map((level) =>
        createGraniteRockMaterial(
          { ...rock.parameters, placementScale: effectivePlacementScale },
          resources,
          level,
          boundaries,
        ),
      ),
    }
    // Biome controls are uniforms and update below without rebuilding the graph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePlacementScale, lodLevel, resources])
  useEffect(() => {
    if (materialBundle) {
      for (const material of materialBundle.materials) updateGraniteRockMaterial(material, {
        detailStrength,
        lichen,
        moss,
        snow,
        surfaceSeed,
        wetness,
      })
    }
  }, [
    detailStrength,
    lichen,
    materialBundle,
    moss,
    snow,
    surfaceSeed,
    wetness,
  ])
  const outlineMaterial = useMemo(
    () =>
      new MeshBasicNodeMaterial({
        color: 0x77e8be,
        wireframe: true,
        transparent: true,
        opacity: 0.32,
        depthTest: true,
        depthWrite: false,
      }),
    [],
  )

  useEffect(
    () => () => {
      for (const material of materialBundle?.materials ?? []) material.dispose()
    },
    [materialBundle],
  )
  useEffect(() => () => outlineMaterial.dispose(), [outlineMaterial])

  useFrame((state, deltaSeconds) => {
    if (!materialBundle || !resources || !target || !rock.visible) return
    const camera = state.camera as PerspectiveCamera
    if (!camera.isPerspectiveCamera) return
    target.updateWorldMatrix(true, false)
    camera.updateWorldMatrix(true, false)
    target.getWorldPosition(rockWorldPosition)
    camera.getWorldPosition(cameraWorldPosition)
    target.getWorldScale(rockWorldScale)
    const maximumInstanceScale = Math.max(
      Math.abs(rockWorldScale.x),
      Math.abs(rockWorldScale.y),
      Math.abs(rockWorldScale.z),
    ) * rock.parameters.placementScale
    const distance = rockWorldPosition.distanceTo(cameraWorldPosition)
    const viewportHeight = state.gl.domElement.height || 1080
    const fov = camera.getEffectiveFOV()
    const lod1Pixels = projectedGraniteErrorPixels(
      resources.lodErrors[0] * 1.7 * maximumInstanceScale,
      distance,
      fov,
      viewportHeight,
    )
    const lod2Pixels = projectedGraniteErrorPixels(
      resources.lodErrors[1] * 1.7 * maximumInstanceScale,
      distance,
      fov,
      viewportHeight,
    )
    const targetWeights = targetGraniteLodWeights(
      lod1Pixels,
      lod2Pixels,
      lodLevel,
    )
    materialBundle.weights = settleGraniteLodWeights(
      materialBundle.weights,
      targetWeights,
      Math.min(0.1, deltaSeconds),
    )
    const drawable = drawableGraniteLodWeights(materialBundle.weights)
    for (let level = 0; level < 3; level += 1) {
      const mesh = lodMeshes.current[level]
      if (mesh) {
        const visible = drawable[level]! > 0.002
        mesh.userData.hizDesiredVisible = visible
        mesh.visible = visible
      }
    }
    materialBundle.boundaries.first.value = drawable[0]
    materialBundle.boundaries.second.value = drawable[0] + drawable[1]
  })

  const commitTransform = () => {
    if (!target) return
    // TransformControls scales in the object's local space, so each handle
    // already writes its own axis. Keep all three instead of averaging them.
    const scale = normalizeGraniteRockScale({
      x: target.scale.x,
      y: target.scale.y,
      z: target.scale.z,
    })
    target.scale.set(scale.x, scale.y, scale.z)
    terrain.updateGraniteRockTransform(rock.id, {
      position: {
        x: target.position.x,
        y: target.position.y,
        z: target.position.z,
      },
      rotation: {
        x: target.rotation.x,
        y: target.rotation.y,
        z: target.rotation.z,
      },
      scale,
    })
  }
  const { begin, finish, isActive } = useTransformDragSession({
    editor,
    enabled: selected && editable && rock.visible && target !== null,
    ownerKey: rock.id,
    commit: commitTransform,
    committedStatus: `${rock.name} transform saved`,
  })

  useLayoutEffect(() => {
    if (!target || isActive()) return
    target.position.set(
      rock.transform.position.x,
      rock.transform.position.y,
      rock.transform.position.z,
    )
    target.rotation.set(
      rock.transform.rotation.x,
      rock.transform.rotation.y,
      rock.transform.rotation.z,
      'XYZ',
    )
    target.scale.set(
      rock.transform.scale.x,
      rock.transform.scale.y,
      rock.transform.scale.z,
    )
    target.updateMatrixWorld(true)
  }, [
    isActive,
    rock.transform.position.x,
    rock.transform.position.y,
    rock.transform.position.z,
    rock.transform.rotation.x,
    rock.transform.rotation.y,
    rock.transform.rotation.z,
    rock.transform.scale.x,
    rock.transform.scale.y,
    rock.transform.scale.z,
    target,
  ])

  return (
    <>
      <group
        ref={targetRef}
        name={rock.name}
        visible={rock.visible}
        // Picking is resolved once, against the whole scene, in TerrainView.
        userData={{ pickTarget: { kind: 'rock', id: rock.id } }}
      >
        {resources && materialBundle && (
          <group scale={rock.parameters.placementScale} dispose={null}>
            {resources.geometries.map((geometry, level) => (
              <mesh
                key={level}
                ref={(node) => {
                  lodMeshes.current[level] = node
                }}
                geometry={geometry}
                material={materialBundle.materials[level]}
                visible={level === lodLevel}
                renderOrder={level}
                castShadow
                receiveShadow
                userData={{
                  hizCullable: true,
                  hizDesiredVisible: level === lodLevel,
                }}
              />
            ))}
            {selected && (
              <mesh
                geometry={resources.geometries[lodLevel]}
                material={outlineMaterial}
                scale={1.003}
                renderOrder={8_500}
              />
            )}
          </group>
        )}
      </group>
      {selected && editable && rock.visible && target && (
        <TransformControls
          ref={transformControls}
          object={target}
          mode={transformMode}
          space={transformMode === 'scale' ? 'local' : 'world'}
          size={0.8}
          onMouseDown={begin}
          onMouseUp={finish}
        />
      )}
    </>
  )
}
