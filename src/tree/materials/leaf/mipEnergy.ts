/**
 * Restores energy lost when a cutout spray is minified into a few texels.
 *
 * Alpha-to-coverage preserves the projected silhouette, but the surviving
 * samples still represent a mixture of leaf and transparent card.  A modest
 * linear-space gain at coarse levels restores that unresolved leaf area.  The
 * cap is intentionally conservative: this is coverage compensation, not glow.
 */
export function compensateCutoutEnergy(
  data: Uint8Array,
  mipLevel: number,
): void {
  if (mipLevel < 2) return
  const gain = Math.min(1.34, 1 + (mipLevel - 1) * 0.075)
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3]! === 0) continue
    data[index] = encodeLinear(decodeSrgb(data[index]!) * gain)
    data[index + 1] = encodeLinear(decodeSrgb(data[index + 1]!) * gain)
    data[index + 2] = encodeLinear(decodeSrgb(data[index + 2]!) * gain)
  }
}

function decodeSrgb(value: number): number {
  const unit = value / 255
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
}

function encodeLinear(value: number): number {
  const bounded = Math.max(0, Math.min(1, value))
  const encoded = bounded <= 0.0031308
    ? bounded * 12.92
    : 1.055 * bounded ** (1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(encoded * 255)))
}
