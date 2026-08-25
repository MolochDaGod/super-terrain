import {
  add,
  cross,
  hashUnit,
  multiply,
  normalize,
  TreeRandom,
  vec3,
} from './math'
import type {
  SemanticTreeGraph,
  TreeFruitData,
  TreeLodLevel,
  TreeVec3,
} from './types'

/** Compiles pendant fruit bunches into one inexpensive instanced organ batch. */
export function compileFruit(
  graph: SemanticTreeGraph,
  level: TreeLodLevel,
): TreeFruitData {
  if (level === 2 || graph.fruitClusters.length === 0) return emptyFruit()
  const matrices: number[] = []
  const colors: number[] = []
  const stride = level === 0 ? 1 : 2

  for (const cluster of graph.fruitClusters) {
    const random = new TreeRandom(cluster.seed + level * 7919)
    const strandCount = cluster.strandCount
    const axis = normalize(cluster.axis, vec3(0, -1, 0))
    const tangent = normalize(cluster.radial, vec3(1, 0, 0))
    const bitangent = normalize(cross(axis, tangent), vec3(0, 0, 1))

    if (cluster.model === 'coconut-cluster') {
      for (let index = 0; index < cluster.count; index += stride) {
        const angle = index * Math.PI * (3 - Math.sqrt(5)) + random.range(-0.18, 0.18)
        const outward = add(
          multiply(tangent, Math.cos(angle)),
          multiply(bitangent, Math.sin(angle)),
        )
        const layer = index / Math.max(1, cluster.count - 1)
        const position = add(
          cluster.center,
          add(
            multiply(outward, cluster.spread * random.range(0.24, 1)),
            multiply(axis, cluster.length * (0.12 + layer * 0.72 + random.range(-0.08, 0.08))),
          ),
        )
        const longAxis = normalize(add(axis, multiply(outward, random.range(0.08, 0.28))), axis)
        const xAxis = normalize(cross(bitangent, longAxis), tangent)
        const zAxis = normalize(cross(xAxis, longAxis), bitangent)
        const radius = cluster.fruitRadius * random.range(0.82, 1.16)
        appendMatrix(
          matrices,
          xAxis,
          longAxis,
          zAxis,
          position,
          radius * random.range(0.9, 1.04),
          radius * random.range(1.12, 1.34),
          radius * random.range(0.86, 1.02),
        )
        const maturity = random.unit()
        const shade = random.range(0.82, 1.08)
        colors.push(
          (0.105 + maturity * 0.055) * shade,
          (0.16 - maturity * 0.095) * shade,
          (0.032 - maturity * 0.018) * shade,
        )
      }
      continue
    }

    for (let index = 0; index < cluster.count; index += stride) {
      const strand = index % strandCount
      const strandEnd = 0.68 + hashUnit(cluster.seed, strand, strandCount, 0) * 0.32
      const t = random.range(0.055, strandEnd)
      const fanT = strand / Math.max(1, strandCount - 1)
      const azimuth = (fanT - 0.5) * 1.7 +
        (hashUnit(strand, cluster.seed, strandCount, 17) - 0.5) * 0.14
      const radial = add(
        multiply(tangent, Math.cos(azimuth)),
        multiply(bitangent, Math.sin(azimuth)),
      )
      const envelope = cluster.spread * Math.sin(t * Math.PI * 0.72)
      // Fruits crowd into irregular lobes around each rachilla rather than
      // exposing one mathematically clean bead string. The strand still
      // controls the bunch's load path, while this local cloud supplies the
      // dense, weighty mass seen from ordinary tree-view distances.
      const localJitter = cluster.fruitRadius * random.range(0.8, 3.8)
      const aroundStrand = add(
        multiply(radial, random.signed()),
        multiply(bitangent, random.signed()),
      )
      const position = add(
        cluster.center,
        add(
          multiply(axis, cluster.length * (0.08 + t * 0.92)),
          add(multiply(radial, envelope), multiply(aroundStrand, localJitter)),
        ),
      )
      const longAxis = normalize(add(axis, multiply(radial, random.range(0.03, 0.14))), axis)
      const xAxis = normalize(cross(bitangent, longAxis), tangent)
      const zAxis = normalize(cross(xAxis, longAxis), bitangent)
      const radius = cluster.fruitRadius * random.range(0.66, 1.3)
      appendMatrix(
        matrices,
        xAxis,
        longAxis,
        zAxis,
        position,
        radius,
        radius * random.range(1.55, 1.9),
        radius * random.range(0.82, 1.04),
      )
      const ripeness = random.range(0, 1)
      const dusty = random.range(0.82, 1.08)
      if (ripeness < 0.13) {
        colors.push(0.12 * dusty, 0.085 * dusty, 0.018 * dusty)
      } else if (ripeness > 0.7) {
        colors.push(0.052 * dusty, 0.014 * dusty, 0.004 * dusty)
      } else {
        colors.push(
          (0.145 - ripeness * 0.075) * dusty,
          (0.052 - ripeness * 0.03) * dusty,
          (0.009 - ripeness * 0.003) * dusty,
        )
      }
    }
  }

  return {
    matrices: Float32Array.from(matrices),
    colors: Float32Array.from(colors),
    count: matrices.length / 16,
  }
}

function appendMatrix(
  target: number[],
  xAxis: TreeVec3,
  yAxis: TreeVec3,
  zAxis: TreeVec3,
  position: TreeVec3,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
): void {
  target.push(
    xAxis.x * scaleX, xAxis.y * scaleX, xAxis.z * scaleX, 0,
    yAxis.x * scaleY, yAxis.y * scaleY, yAxis.z * scaleY, 0,
    zAxis.x * scaleZ, zAxis.y * scaleZ, zAxis.z * scaleZ, 0,
    position.x, position.y, position.z, 1,
  )
}

function emptyFruit(): TreeFruitData {
  return {
    matrices: new Float32Array(),
    colors: new Float32Array(),
    count: 0,
  }
}
