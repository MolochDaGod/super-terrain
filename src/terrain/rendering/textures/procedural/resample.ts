/**
 * Expands an RGBA bake without introducing a second filtering convention.
 *
 * The preview bake is deliberately small so it lands quickly. WebGPU texture
 * allocations cannot be resized in place, though, so the worker expands that
 * preview to the final allocation size before transferring it to the page.
 * Hardware filtering and mip generation smooth the temporary result there;
 * the later full bake replaces it pixel-for-pixel.
 */
export function resizeRgbaNearest(
  source: Uint8Array,
  sourceSize: number,
  targetSize: number,
): Uint8Array {
  if (!Number.isInteger(sourceSize) || sourceSize <= 0) {
    throw new Error(`Invalid source texture size: ${sourceSize}`)
  }
  if (!Number.isInteger(targetSize) || targetSize <= 0) {
    throw new Error(`Invalid target texture size: ${targetSize}`)
  }
  if (source.byteLength !== sourceSize * sourceSize * 4) {
    throw new Error(
      `RGBA source has ${source.byteLength} bytes; expected ${sourceSize * sourceSize * 4}`,
    )
  }
  if (sourceSize === targetSize) return source

  const target = new Uint8Array(targetSize * targetSize * 4)
  for (let y = 0; y < targetSize; y += 1) {
    const sourceY = Math.min(
      sourceSize - 1,
      Math.floor((y * sourceSize) / targetSize),
    )
    for (let x = 0; x < targetSize; x += 1) {
      const sourceX = Math.min(
        sourceSize - 1,
        Math.floor((x * sourceSize) / targetSize),
      )
      const sourceOffset = (sourceY * sourceSize + sourceX) * 4
      const targetOffset = (y * targetSize + x) * 4
      target[targetOffset] = source[sourceOffset]!
      target[targetOffset + 1] = source[sourceOffset + 1]!
      target[targetOffset + 2] = source[sourceOffset + 2]!
      target[targetOffset + 3] = source[sourceOffset + 3]!
    }
  }
  return target
}
