import { useEffect, useMemo } from 'react'
import {
  BufferAttribute,
  CircleGeometry,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  MultiplyBlending,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three/webgpu'
import * as TSL from 'three/tsl'
import type { GeneratedForestRock } from './forestPresets'
import type { TreePlacement, TreePrototype } from './TreeEditorStore'

/** See the note in the foliage materials: these are node builders, not maths. */
type ShaderValue = any

const { attribute, clamp, float, mix, positionWorld, smoothstep, vec3, vec4 } =
  TSL as unknown as Record<string, ShaderValue>

/**
 * The two things that stop a stand from looking like trees standing on a
 * photograph of a floor.
 *
 * The first is contact. A trunk meeting the ground with nothing between them
 * is the single most legible "pasted on" cue there is: in life the litter
 * banks up against the bole, the root plate lifts the ground either side of
 * it, and none of the sky reaches the few centimetres where the two meet. The
 * skirt below is that occlusion, drawn as a multiplying decal so it darkens
 * whatever the floor happens to be rather than painting a grey ring on it.
 *
 * The second is interruption. `generateForestRockLayout` has been producing
 * boulder placements for a while and nothing was drawing them, so the floor
 * had no hard obstacles on it at all above twig scale — and a floor with no
 * obstacles reads as a plane however good its material is.
 */

/** How far the occlusion reaches, as a multiple of the trunk's own radius. */
const SKIRT_SPAN = 4.2

/** The darkest the skirt gets, right at the bole. */
const SKIRT_DEPTH = 0.34

export function ForestFloorProps({
  placements,
  prototypes,
  rocks,
  groundNormals,
}: {
  placements: readonly TreePlacement[]
  prototypes: Readonly<Record<string, TreePrototype>>
  rocks: readonly GeneratedForestRock[]
  /**
   * Ground normal per placement id, where the floor is not a plane.
   *
   * The lab's ground is flat and needs none of this. A forest grown on terrain
   * does: a disc lying in the XZ plane on a one-in-three slope has half its rim
   * a metre underground and the other half a metre in the air, which turns the
   * one element whose whole job is to hide the seam between a trunk and the
   * ground into the thing that advertises it.
   */
  groundNormals?: ReadonlyMap<string, readonly [number, number, number]>
}) {
  return (
    <>
      <TrunkContactSkirts
        placements={placements}
        prototypes={prototypes}
        groundNormals={groundNormals}
      />
      <ForestBoulders rocks={rocks} />
    </>
  )
}

/**
 * A soft occlusion disc under every stem.
 *
 * Multiplying rather than blending: the amount of sky a square centimetre of
 * litter can see is a property of the geometry around it, not of the light, so
 * the right operation is to scale whatever the floor's own shading came to.
 * An alpha-blended dark disc would instead paint a flat grey patch that stays
 * exactly as grey in a sunbeam as it is in deep shade, which is the classic
 * decal tell.
 *
 * One instanced draw for the whole stand.
 */
function TrunkContactSkirts({
  placements,
  prototypes,
  groundNormals,
}: {
  placements: readonly TreePlacement[]
  prototypes: Readonly<Record<string, TreePrototype>>
  groundNormals?: ReadonlyMap<string, readonly [number, number, number]>
}) {
  const geometry = useMemo(() => skirtGeometry(), [])
  const material = useMemo(() => skirtMaterial(), [])
  useEffect(() => {
    return () => {
      geometry.dispose()
      material.dispose()
    }
  }, [geometry, material])

  // Fallen stems get no skirt: a log lying on the floor occludes a line, not a
  // disc, and a round patch of shade under one is worse than none.
  const standing = placements.filter((placement) => !placement.tilt)

  const mesh = useMemo(() => {
    const instanced = new InstancedMesh(geometry, material, Math.max(1, standing.length))
    instanced.name = 'forest-trunk-contact'
    instanced.count = standing.length
    instanced.frustumCulled = false
    instanced.castShadow = false
    instanced.receiveShadow = false
    // After the ground and the grass, before anything transparent.
    instanced.renderOrder = 3
    const matrix = new Matrix4()
    const position = new Vector3()
    const rotation = new Quaternion()
    const yaw = new Quaternion()
    const normal = new Vector3()
    const scale = new Vector3()
    standing.forEach((placement, index) => {
      const trunk = prototypes[placement.prototypeId]?.parameters.trunkRadius ?? 0.4
      // Well clear of the bole. The occlusion a trunk casts on its own litter
      // reaches a good deal further than the trunk is wide, because it is the
      // root plate and the banked leaves doing it, not the cylinder.
      const span = Math.max(0.75, trunk * placement.scale * SKIRT_SPAN)
      // Lifted proportionally to its own span, not by a fixed two centimetres:
      // a wide skirt on a slope needs more clearance than a narrow one, and the
      // amount it needs is exactly the relief across its own footprint.
      const ground = groundNormals?.get(placement.id)
      position.set(
        placement.position[0],
        placement.position[1] + (ground ? 0.02 + span * 0.06 : 0.02),
        placement.position[2],
      )
      yaw.setFromAxisAngle(UP, placement.rotation)
      if (ground) {
        normal.set(ground[0], ground[1], ground[2]).normalize()
        rotation.setFromUnitVectors(UP, normal).multiply(yaw)
      } else {
        rotation.copy(yaw)
      }
      scale.set(span, 1, span)
      matrix.compose(position, rotation, scale)
      instanced.setMatrixAt(index, matrix)
    })
    instanced.instanceMatrix.needsUpdate = true
    return instanced
  }, [geometry, groundNormals, material, prototypes, standing])

  useEffect(() => () => mesh.dispose(), [mesh])
  if (standing.length === 0) return null
  return <primitive object={mesh} />
}

const UP = /*@__PURE__*/ new Vector3(0, 1, 0)

/**
 * A disc lying flat, carrying its own falloff and a ragged rim.
 *
 * The rim matters: a perfect circle of shade under every trunk is a pattern
 * the eye finds within a second of walking through the stand. Displacing the
 * outer ring per vertex by a hash of its angle costs nothing and breaks it.
 */
function skirtGeometry(): BufferGeometry {
  const segments = 28
  const geometry = new CircleGeometry(1, segments)
  geometry.rotateX(-Math.PI / 2)
  const position = geometry.getAttribute('position') as BufferAttribute
  const falloff = new Float32Array(position.count)
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index)
    const z = position.getZ(index)
    const radius = Math.hypot(x, z)
    if (radius > 0.001) {
      const angle = Math.atan2(z, x)
      const ragged = 0.74 + 0.26 * (
        0.5 + 0.5 * Math.sin(angle * 3.1 + 1.7) * Math.cos(angle * 5.3 - 0.4)
      )
      position.setX(index, (x / radius) * radius * ragged)
      position.setZ(index, (z / radius) * radius * ragged)
    }
    falloff[index] = radius
  }
  geometry.setAttribute('skirtRadius', new BufferAttribute(falloff, 1))
  geometry.computeVertexNormals()
  return geometry
}

function skirtMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial()
  material.name = 'trunk contact occlusion'
  material.blending = MultiplyBlending
  // WebGPU refuses a multiply blend on a straight-alpha material: the factors
  // it sets up assume the colour has already been scaled by alpha. The skirt
  // is opaque-alpha everywhere, so this costs nothing and is the difference
  // between an occlusion decal and a white disc.
  material.premultipliedAlpha = true
  material.transparent = true
  material.depthWrite = false
  material.fog = false
  material.toneMapped = false
  const radius = attribute('skirtRadius', 'float')
  // Sharp against the bole, long and soft going out. Contact occlusion falls
  // off far faster than linearly with distance, and a linear ramp reads as a
  // painted vignette.
  const occlusion = float(1).sub(
    smoothstep(0, 1, radius).oneMinus().mul(SKIRT_DEPTH),
  )
  material.colorNode = vec4(vec3(occlusion, occlusion, occlusion), 1)
  return material
}

/**
 * The boulders the layout has always generated and nothing has ever drawn.
 *
 * Not the full granite pipeline — that is a dual-contoured mesh with its own
 * LOD chain, and forty-eight of them would cost more than the trees do. This
 * is one displaced icosahedron drawn once for the whole scatter, which is what
 * a boulder at five to twenty metres actually needs: a hard, irregular
 * silhouette breaking the floor, and lichen on the side that gets the light.
 */
function ForestBoulders({ rocks }: { rocks: readonly GeneratedForestRock[] }) {
  const geometry = useMemo(() => boulderGeometry(), [])
  const material = useMemo(() => boulderMaterial(), [])
  useEffect(() => {
    return () => {
      geometry.dispose()
      material.dispose()
    }
  }, [geometry, material])

  const mesh = useMemo(() => {
    const instanced = new InstancedMesh(geometry, material, Math.max(1, rocks.length))
    instanced.name = 'forest-boulders'
    instanced.count = rocks.length
    instanced.frustumCulled = false
    instanced.castShadow = true
    instanced.receiveShadow = true
    const matrix = new Matrix4()
    const position = new Vector3()
    const rotation = new Quaternion()
    const tilt = new Quaternion()
    const scale = new Vector3()
    rocks.forEach((rock, index) => {
      const random = mulberry(rock.seed)
      // Sunk to a bit under half its height. A boulder resting exactly on a
      // plane is the one thing that never happens on a real forest floor.
      const bury = 0.3 + random() * 0.22
      position.set(rock.position[0], rock.scale * (0.5 - bury), rock.position[2])
      rotation.setFromAxisAngle(UP, rock.rotation)
      tilt.setFromAxisAngle(
        new Vector3(random() - 0.5, 0, random() - 0.5).normalize(),
        (random() - 0.5) * 0.5,
      )
      rotation.multiply(tilt)
      // Boulders are wider than they are tall, and no two the same.
      scale.set(
        rock.scale * (0.9 + random() * 0.5),
        rock.scale * (0.6 + random() * 0.35),
        rock.scale * (0.9 + random() * 0.5),
      )
      matrix.compose(position, rotation, scale)
      instanced.setMatrixAt(index, matrix)
    })
    instanced.instanceMatrix.needsUpdate = true
    return instanced
  }, [geometry, material, rocks])

  useEffect(() => () => mesh.dispose(), [mesh])
  if (rocks.length === 0) return null
  return <primitive object={mesh} />
}

function boulderGeometry(): BufferGeometry {
  const geometry = new IcosahedronGeometry(0.5, 2)
  const position = geometry.getAttribute('position') as BufferAttribute
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index)
    const y = position.getY(index)
    const z = position.getZ(index)
    // Two frequencies: the lumps that give it a shape, and the facets that
    // give it edges to catch light on.
    const lump = Math.sin(x * 5.1 + 1.3) * Math.cos(z * 4.3 - 0.7) * Math.sin(y * 3.7)
    const facet = Math.sin(x * 17.3) * Math.cos(y * 13.9) * Math.sin(z * 15.1)
    const displaced = 1 + lump * 0.17 + facet * 0.045
    position.setXYZ(index, x * displaced, y * displaced, z * displaced)
  }
  geometry.computeVertexNormals()
  return geometry
}

function boulderMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial()
  material.name = 'forest boulder'
  material.metalness = 0
  material.roughness = 0.82
  // Lichen and moss on the upper surfaces, soil staining at the base. Both
  // are functions of world position and the shading normal, so no two rocks
  // in the scatter get the same treatment even though they share a mesh.
  const up = clamp((TSL.normalWorld as ShaderValue).y, 0, 1)
  const low = smoothstep(0.55, 0.05, positionWorld.y)
  // Rock to rock variation without an instance attribute: a slow field over
  // the ground, sampled at a scale coarse enough that one boulder sits inside
  // a single lobe of it. Two rocks a few metres apart differ; one rock does
  // not differ across itself.
  const vein = smoothstep(
    0.3,
    0.7,
    (TSL.mx_noise_float as ShaderValue)(positionWorld.xz.mul(0.07)).add(0.5),
  )
  const stone = mix(vec3(0.072, 0.071, 0.069), vec3(0.116, 0.114, 0.108), vein)
  const lichen = vec3(0.086, 0.104, 0.062)
  const stained = vec3(0.045, 0.036, 0.026)
  const withLichen = mix(stone, lichen, up.mul(0.55))
  material.colorNode = vec4(mix(withLichen, stained, low.mul(0.6)), 1)
  material.roughnessNode = mix(float(0.72), float(0.9), up)
  return material
}

function mulberry(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
