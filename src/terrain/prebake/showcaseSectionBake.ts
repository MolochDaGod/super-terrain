import type { TerrainConfig } from '../config'
import type { CompiledSection } from '../core/types'
import { decodeSectionBake } from './sectionBake'
import showcaseBakeUrl from '../react/assets/showcase-sections-v22.bin.gz?url'

const SHOWCASE_BAKE_URL = showcaseBakeUrl

export const SHOWCASE_BAKED_SECTION_IDS = [
  '1:0',
  '2:0',
  '3:0',
  '1:1',
  '2:1',
  '3:1',
] as const

/** Loads the exact CSG result for the six expensive landmark cells. */
export async function loadShowcaseSectionBake(
  config: TerrainConfig,
): Promise<CompiledSection[]> {
  if (!supportsShowcaseBake(config) || typeof window === 'undefined') return []
  if (new URLSearchParams(location.search).has('nobake')) return []
  try {
    const response = await fetch(SHOWCASE_BAKE_URL, { cache: 'force-cache' })
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`)
    }
    // Browsers transparently decode HTTP `Content-Encoding: gzip`, while some
    // static hosts serve the same .gz file as opaque octets. Inspect the bytes
    // instead of the header so both delivery modes work without ever trying to
    // inflate an already-decoded payload.
    const payload = await response.arrayBuffer()
    const signature = new Uint8Array(payload, 0, Math.min(2, payload.byteLength))
    let bytes = payload
    if (signature[0] === 0x1f && signature[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('gzip decompression is unavailable')
      }
      const stream = new Blob([payload])
        .stream()
        .pipeThrough(new DecompressionStream('gzip'))
      bytes = await new Response(stream).arrayBuffer()
    }
    const sections = decodeSectionBake(bytes)
    for (const section of sections) {
      if (section.lods.length !== 1 || section.lods[0]?.level !== 1) {
        throw new Error(`Unexpected baked LOD set for ${section.key.x}:${section.key.z}`)
      }
    }
    return sections
  } catch (error) {
    // A stale service worker or an older browser must never prevent editing.
    // The normal worker path is slower but produces the same authoritative CSG.
    console.warn('Showcase section bake unavailable; compiling live instead', error)
    return []
  }
}

function supportsShowcaseBake(config: TerrainConfig): boolean {
  return (
    config.seed === 13_371 &&
    config.sectionSize === 128 &&
    config.operationHalo === 12 &&
    config.lodResolutions.length === 5 &&
    config.lodResolutions.every((resolution, index) =>
      resolution === [88, 44, 22, 11, 6][index],
    )
  )
}
