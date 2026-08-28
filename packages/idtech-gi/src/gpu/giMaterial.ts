import {
  Color,
  IrradianceNode,
  MeshPhysicalNodeMaterial,
  type Material,
  type Mesh,
  type Object3D,
} from 'three/webgpu'
import type { Node } from './nodes.ts'

type Builder = any

/**
 * A standard PBR material that contributes the GI field as indirect diffuse.
 *
 * Injecting through `setupMaterialLightings` rather than `emissiveNode` means
 * the irradiance goes through the same path as an environment probe: it is
 * multiplied by the albedo *and* the material's ambient occlusion, and it is
 * shadowed and tone mapped with everything else. Emissive would bypass all of
 * that and read as a glow.
 */
export class GiPhysicalNodeMaterial extends MeshPhysicalNodeMaterial {
  /** vec3 node: indirect irradiance at the shading point. */
  giIrradiance: Node = null

  setupMaterialLightings(builder: Builder): Node {
    const lightings = (super.setupMaterialLightings as (b: Builder) => Node[]).call(
      this,
      builder,
    )
    if (this.giIrradiance) lightings.push(new IrradianceNode(this.giIrradiance) as Node)
    return lightings
  }
}

const COPIED = [
  'map',
  'normalMap',
  'normalScale',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'aoMapIntensity',
  'alphaMap',
  'emissiveMap',
  'bumpMap',
  'bumpScale',
  'displacementMap',
  'roughness',
  'metalness',
  'alphaTest',
  'alphaToCoverage',
  'transparent',
  'opacity',
  'side',
  'flatShading',
  'wireframe',
  'vertexColors',
  'depthWrite',
  'depthTest',
  'toneMapped',
  'name',
] as const

/**
 * Rebuilds a loaded glTF material as a node material we can extend.
 *
 * The renderer maps `MeshStandardMaterial` onto a node material internally, but
 * that instance is not reachable, so node properties set on the source material
 * are dropped. Converting explicitly is the only way to attach a lighting node.
 */
export function toGiMaterial(source: Material, irradiance: Node): GiPhysicalNodeMaterial {
  const target = new GiPhysicalNodeMaterial()
  const src = source as Material & Record<string, unknown>
  for (const key of COPIED) {
    const value = src[key]
    if (value !== undefined && value !== null) (target as unknown as Record<string, unknown>)[key] = value
  }
  if (src.color instanceof Color) target.color.copy(src.color)
  if (src.emissive instanceof Color) target.emissive.copy(src.emissive)
  if (typeof src.emissiveIntensity === 'number') target.emissiveIntensity = src.emissiveIntensity
  // glTF `MASK` becomes an alphaTest on an opaque draw; keep it opaque so the
  // foliage cutouts still write depth.
  if (target.alphaTest > 0) target.transparent = false
  target.envMapIntensity = 0
  target.giIrradiance = irradiance
  return target
}

/**
 * Swaps every material under `root` for a GI-aware one. Returns a restore
 * function so the demo can toggle back to the untouched scene.
 */
export function applyGiMaterials(
  root: Object3D,
  irradiance: Node,
): { restore: () => void; count: number } {
  const originals: Array<[Mesh, Material | Material[]]> = []
  const converted = new Map<Material, GiPhysicalNodeMaterial>()
  root.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    originals.push([mesh, mesh.material])
    const swap = (material: Material) => {
      let next = converted.get(material)
      if (!next) {
        next = toGiMaterial(material, irradiance)
        converted.set(material, next)
      }
      return next
    }
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(swap)
      : swap(mesh.material)
  })
  return {
    count: converted.size,
    restore() {
      for (const [mesh, material] of originals) mesh.material = material
      for (const material of converted.values()) material.dispose()
    },
  }
}
