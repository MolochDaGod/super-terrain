import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Sphere,
  Vector3,
} from 'three/webgpu'

export interface TerrainBrickGeometry {
  /** Stable within one section/LOD as long as a triangle stays in its cell. */
  cellKey: string
  geometry: BufferGeometry
  triangleCount: number
}

interface BrickAccumulator {
  indices: number[]
  min: Vector3
  max: Vector3
}

/**
 * Clusters an indexed terrain surface into cubic spatial bricks. Vertex
 * attributes are shared; only the much smaller index streams are partitioned.
 * A triangle belongs to the cell containing its centroid, while the resulting
 * bounds include all three vertices and are therefore conservative even when
 * a large triangle crosses a cell boundary.
 */
export function createTerrainBrickGeometries(
  source: BufferGeometry,
  brickSize: number,
): TerrainBrickGeometry[] {
  const position = source.getAttribute('position') as BufferAttribute | undefined
  const index = source.getIndex()
  if (!position || !index || index.count === 0) return []

  const size = Math.max(1e-3, brickSize)
  const cells = new Map<string, BrickAccumulator>()
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()

  for (let offset = 0; offset + 2 < index.count; offset += 3) {
    const ia = index.getX(offset)
    const ib = index.getX(offset + 1)
    const ic = index.getX(offset + 2)
    a.fromBufferAttribute(position, ia)
    b.fromBufferAttribute(position, ib)
    c.fromBufferAttribute(position, ic)
    const cellX = Math.floor((a.x + b.x + c.x) / (3 * size))
    const cellY = Math.floor((a.y + b.y + c.y) / (3 * size))
    const cellZ = Math.floor((a.z + b.z + c.z) / (3 * size))
    const cellKey = `${cellX}:${cellY}:${cellZ}`
    let cell = cells.get(cellKey)
    if (!cell) {
      cell = {
        indices: [],
        min: new Vector3(Infinity, Infinity, Infinity),
        max: new Vector3(-Infinity, -Infinity, -Infinity),
      }
      cells.set(cellKey, cell)
    }
    cell.indices.push(ia, ib, ic)
    cell.min.min(a).min(b).min(c)
    cell.max.max(a).max(b).max(c)
  }

  return [...cells.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cellKey, cell]) => {
      const geometry = new BufferGeometry()
      for (const [name, attribute] of Object.entries(source.attributes)) {
        geometry.setAttribute(name, attribute)
      }
      geometry.setIndex(new BufferAttribute(new Uint32Array(cell.indices), 1))
      geometry.boundingBox = new Box3(cell.min.clone(), cell.max.clone())
      geometry.boundingSphere = new Sphere()
      geometry.boundingBox.getBoundingSphere(geometry.boundingSphere)
      geometry.userData.terrainBrickCell = cellKey
      return {
        cellKey,
        geometry,
        triangleCount: cell.indices.length / 3,
      }
    })
}

/** Expands conservative brick bounds after speculative vertex deformation. */
export function expandTerrainBrickBounds(
  bricks: readonly TerrainBrickGeometry[],
  amount: number,
): void {
  for (const brick of bricks) {
    brick.geometry.boundingBox?.expandByScalar(amount)
    if (brick.geometry.boundingSphere) {
      brick.geometry.boundingSphere.radius += amount
    }
  }
}
