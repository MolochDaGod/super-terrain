import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { encodePng } from '../capture/png'
import { PROCEDURAL_SURFACES } from '../../src/terrain/rendering/textures/procedural/materials'
import { normalizeField } from '../../src/terrain/rendering/textures/procedural/field'
import { cavityField, horizonOcclusion } from '../../src/terrain/rendering/textures/procedural/occlusion'
import { curvatureField, slopeField, stretchField } from '../../src/terrain/rendering/textures/procedural/field'

/** Dumps every intermediate field of one recipe, for diagnosing artefacts. */
const id = process.env.TEXTURE_ONLY ?? 'cliff-side'
const size = Number(process.env.TEXTURE_SIZE ?? 512)
const outDir = resolve(process.cwd(), '.textures/debug')
mkdirSync(outDir, { recursive: true })

const recipe = PROCEDURAL_SURFACES[id as keyof typeof PROCEDURAL_SURFACES]
const fields = recipe.build(size, 1)
const data = fields.data ?? {}
const metresPerPixel = recipe.physicalWidth / size
const ao = horizonOcclusion(fields.height, {
  directions: 16,
  radius: Math.max(8, size / 32),
  heightScale: recipe.reliefDepth / metresPerPixel,
  intensity: 1.1,
  ...fields.ao,
})
const derived = recipe.derive
  ? recipe.derive(
      {
        height: fields.height,
        ao,
        cavity: cavityField(fields.height, Math.max(2, size / 256), 1.4),
        slope: stretchField(slopeField(fields.height), 0.01, 0.99),
        data,
      },
      1,
    )
  : {}
const all = { height: fields.height, ao, ...data, ...derived, curvature: curvatureField(fields.height, 1) }
for (const [name, field] of Object.entries(all)) {
  const norm = normalizeField(field)
  const pixels = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    const v = Math.round(norm.data[i]! * 255)
    pixels[i * 4] = v
    pixels[i * 4 + 1] = v
    pixels[i * 4 + 2] = v
    pixels[i * 4 + 3] = 255
  }
  writeFileSync(resolve(outDir, `${id}-${name}.png`), encodePng(pixels, size, size))
  console.log(name)
}
