export interface MeshValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export function validateMeshData(
  positions: Float32Array,
  indices: Uint32Array,
): MeshValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const vertexCount = positions.length / 3

  if (positions.length % 3 !== 0) errors.push('Position data is not xyz-aligned')
  if (indices.length % 3 !== 0) errors.push('Index data is not triangle-aligned')

  for (let index = 0; index < positions.length; index += 1) {
    if (!Number.isFinite(positions[index])) {
      errors.push(`Position component ${index} is not finite`)
      break
    }
  }

  for (let index = 0; index < indices.length; index += 1) {
    if (indices[index] >= vertexCount) {
      errors.push(`Triangle index ${indices[index]} exceeds vertex count`)
      break
    }
  }

  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const a = indices[triangle] * 3
    const b = indices[triangle + 1] * 3
    const c = indices[triangle + 2] * 3
    const abx = positions[b] - positions[a]
    const aby = positions[b + 1] - positions[a + 1]
    const abz = positions[b + 2] - positions[a + 2]
    const acx = positions[c] - positions[a]
    const acy = positions[c + 1] - positions[a + 1]
    const acz = positions[c + 2] - positions[a + 2]
    const crossX = aby * acz - abz * acy
    const crossY = abz * acx - abx * acz
    const crossZ = abx * acy - aby * acx
    if (crossX * crossX + crossY * crossY + crossZ * crossZ < 1e-12) {
      warnings.push(`Triangle ${triangle / 3} has near-zero area`)
      if (warnings.length >= 32) break
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
