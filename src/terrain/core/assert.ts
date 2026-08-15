export function terrainAssert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition && import.meta.env.DEV) {
    throw new Error(`[WorldTerrain] ${message}`)
  }
}
