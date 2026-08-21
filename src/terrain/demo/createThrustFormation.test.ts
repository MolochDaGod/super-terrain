import { describe, expect, it } from 'vitest'
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Euler,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Raycaster,
  Vector3,
} from 'three'
import { compileTerrainSection } from '../compiler/compileSection'
import { cutterGeometry } from '../modifiers/boolean/CutterVolume'
import { encodeModifiers, type CompileSectionRequest } from '../workers/protocol'
import {
  THRUST_FACE_NORMAL,
  THRUST_EMBER_DEPTH,
  THRUST_ROTATION,
  THRUST_WINDOW_ROLL,
  THRUST_WINDOWS,
  createThrustFormationModifiers,
} from './createThrustFormation'
import { createShowcaseTerrainModifiers } from './createShowcaseModifiers'

describe('authored thrust formation', () => {
  it('uses natural mesh solids for every added and removed formation', () => {
    for (const modifier of createThrustFormationModifiers()) {
      expect(modifier.type).toBe('boolean-volume')
      if (modifier.type !== 'boolean-volume') continue
      expect(modifier.volumes.every((volume) => volume.kind === 'mesh')).toBe(true)
    }
  }, 15_000)

  it('cuts two blind natural chambers with real terrain rear caps', () => {
    const modifiers = createThrustFormationModifiers()
    const solidMesh = renderSections(compileWindowSections(modifiers.slice(0, -1)))
    const cutMesh = renderSections(compileWindowSections(modifiers))
    const outward = new Vector3(
      THRUST_FACE_NORMAL.x,
      THRUST_FACE_NORMAL.y,
      THRUST_FACE_NORMAL.z,
    ).normalize()
    const inward = outward.clone().negate()
    const formationOrientation = new Quaternion().setFromEuler(
      new Euler(...THRUST_ROTATION, 'XYZ'),
    ).multiply(
      new Quaternion().setFromEuler(
        new Euler(0, 0, THRUST_WINDOW_ROLL, 'XYZ'),
      ),
    )

    const windowModifier = modifiers.at(-1)
    if (!windowModifier) throw new Error('Expected window modifier')
    if (windowModifier.type !== 'boolean-volume') throw new Error('Expected window volume')
    expect(windowModifier.volumes).toHaveLength(THRUST_WINDOWS.length * 2)
    expect(windowModifier.volumes.every((volume) => volume.kind === 'mesh')).toBe(true)
    expect(windowModifier.volumes.filter((volume) =>
      volume.interior === 'ember'
    )).toHaveLength(THRUST_WINDOWS.length)
    for (const [windowIndex, window] of THRUST_WINDOWS.entries()) {
      const origin = new Vector3(
        window.center.x,
        window.center.y,
        window.center.z,
      ).addScaledVector(outward, 100)
      const solidHits = new Raycaster(origin, inward, 0, 600)
        .intersectObject(solidMesh, true)
      const cutHits = new Raycaster(origin, inward, 0, 600)
        .intersectObject(cutMesh, true)
      const solidHit = solidHits[0]
      const cutterMesh = new Mesh(
        cutterGeometry(windowModifier.volumes[windowIndex * 2], 1, 13_371),
        new MeshBasicMaterial({ side: DoubleSide }),
      )
      const cutterHits = new Raycaster(origin, inward, 0, 600)
        .intersectObject(cutterMesh, false)
      const cutterHit = cutterHits[0]
      expect(cutterHit).toBeDefined()
      expect(solidHit).toBeDefined()
      expect(cutHits.length).toBeGreaterThan(0)
      // The first remaining surface is the cutter's own rear cap and must sit
      // behind the uncut face, but before the original rear shell. That is the
      // topological distinction between a blind chamber and both a decal and a
      // through-hole with a second backing mesh.
      expect(cutHits[0].distance).toBeGreaterThan(solidHit.distance + 4)
      expect(cutHits[0].distance).toBeLessThan(solidHits.at(-1)!.distance)
      // Prove a useful natural mouth around that ray in both local axes.
      for (const [localX, localY] of [
        [window.rx * 0.42, 0],
        [-window.rx * 0.42, 0],
        [0, window.ry * 0.42],
        [0, -window.ry * 0.42],
      ]) {
        const offset = new Vector3(localX, localY, 0)
          .applyQuaternion(formationOrientation)
          .multiplyScalar(1.08)
        const apertureOrigin = new Vector3(
          window.center.x,
          window.center.y,
          window.center.z,
        ).add(offset).addScaledVector(outward, 100)
        const apertureHits = new Raycaster(apertureOrigin, inward, 0, 600)
          .intersectObject(cutMesh, true)
        expect(apertureHits.length).toBeGreaterThan(0)
        expect(apertureHits[0].distance).toBeGreaterThan(solidHit.distance + 2)
      }
      cutterMesh.geometry.dispose()
      ;(cutterMesh.material as MeshBasicMaterial).dispose()
    }

    disposeRenderedSections(solidMesh)
    disposeRenderedSections(cutMesh)
  }, 60_000)

  it('keeps both blind chambers recessed after the patch field is composed', () => {
    const sorted = createShowcaseTerrainModifiers(13_371).sort((left, right) =>
      left.priority === right.priority
        ? left.id.localeCompare(right.id)
        : left.priority - right.priority,
    )
    const compiled = compileWindowSections(sorted)
    const mesh = renderSections(compiled)
    const outward = new Vector3(
      THRUST_FACE_NORMAL.x,
      THRUST_FACE_NORMAL.y,
      THRUST_FACE_NORMAL.z,
    ).normalize()
    for (const window of THRUST_WINDOWS) {
      const origin = new Vector3(
        window.center.x,
        window.center.y,
        window.center.z,
      ).addScaledVector(outward, 100)
      const normalHits = new Raycaster(origin, outward.clone().negate(), 0, 600)
        .intersectObject(mesh, true)
      expect(normalHits.length).toBeGreaterThan(0)
      expect(normalHits[0].distance).toBeGreaterThan(104)
      // The shipped camera is close enough that its rays are not exactly
      // parallel to the face normal at either off-centre window. This catches
      // a tapered sidewall that leaves a normal ray open but hides the backing
      // in the actual perspective frame.
      const camera = new Vector3(0, 175, -170)
      const towardWindow = new Vector3(
        window.center.x,
        window.center.y,
        window.center.z,
      ).sub(camera)
      const windowDistance = towardWindow.length()
      const perspectiveHits = new Raycaster(
        camera,
        towardWindow.normalize(),
        0,
        windowDistance + THRUST_EMBER_DEPTH + 16,
      ).intersectObject(mesh, true)
      expect(perspectiveHits.length).toBeGreaterThan(0)
      expect(perspectiveHits[0].distance).toBeGreaterThan(windowDistance - 8)

      const backingCenter = new Vector3(
        window.center.x,
        window.center.y,
        window.center.z,
      ).addScaledVector(outward, -THRUST_EMBER_DEPTH)
      const towardBacking = backingCenter.clone().sub(camera)
      const backingDistance = towardBacking.length()
      expect(
        new Raycaster(
          camera,
          towardBacking.normalize(),
          0,
          backingDistance + 8,
        ).intersectObject(mesh, true).length,
      ).toBeGreaterThan(0)
    }
    const taggedVertices = compiled.reduce((count, section) => {
      const material = section.lod.surfaceFields?.[4]
      if (!material) return count
      for (let offset = 0; offset < material.length; offset += 4) {
        if ((material[offset] >> 8) > 0) count += 1
      }
      return count
    }, 0)
    expect(taggedVertices).toBeGreaterThan(100)
    disposeRenderedSections(mesh)
  }, 60_000)
})

function compileWindowSections(
  modifiers: ReturnType<typeof createThrustFormationModifiers>,
) {
  return [
    { x: 2, z: 0 },
    { x: 2, z: 1 },
    // The small chamber begins in section (2, 0), but the thrust's inward
    // normal crosses x = 384 before reaching its natural rear cap. Include
    // the neighbouring section or the ray test mistakes a section seam for a
    // through-hole even though the compiled world is closed there.
    { x: 3, z: 1 },
  ].map((key, index) => {
    const request: CompileSectionRequest = {
      kind: 'compile-section',
      jobId: index + 1,
      key,
      revision: 1,
      priority: 1,
      config: {
        sectionSize: 128,
        lodResolutions: [44],
        seed: 13_371,
        operationHalo: 12,
      },
      modifiers: encodeModifiers(modifiers),
    }
    return { key, lod: compileTerrainSection(request).lods[0] }
  })
}

function renderSections(sections: ReturnType<typeof compileWindowSections>) {
  const group = new Group()
  for (const { key, lod } of sections) {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(lod.positions, 3))
    geometry.setIndex(new BufferAttribute(lod.indices, 1))
    geometry.translate(key.x * 128, 0, key.z * 128)
    group.add(new Mesh(
      geometry,
      new MeshBasicMaterial({ side: DoubleSide }),
    ))
  }
  return group
}

function disposeRenderedSections(group: Group) {
  for (const child of group.children) {
    if (!(child instanceof Mesh)) continue
    child.geometry.dispose()
    ;(child.material as MeshBasicMaterial).dispose()
  }
}
