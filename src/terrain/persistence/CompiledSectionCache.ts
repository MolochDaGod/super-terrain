import type { TerrainConfig } from '../config'
import type { SectionKey } from '../core/types'
import type {
  BrushStrokeModifier,
  SculptLayerModifier,
  TerrainModifier,
} from '../modifiers/types'

/**
 * Bump this whenever compiler semantics change without a corresponding input
 * change. Config and modifier changes are fingerprinted separately below.
 */
export const COMPILED_SECTION_CACHE_VERSION = 'meshterrain-section-v4'

/**
 * Produces small, deterministic section fingerprints without serializing the
 * same large CSG operand once per intersecting cell.
 */
export class CompiledSectionCacheSignatures {
  private modifierRevision = -1
  private modifierFingerprints = new Map<TerrainModifier, string>()

  async create(
    config: TerrainConfig,
    key: SectionKey,
    modifiers: readonly TerrainModifier[],
    modifierRevision: number,
  ): Promise<string> {
    if (modifierRevision !== this.modifierRevision) {
      this.modifierRevision = modifierRevision
      this.modifierFingerprints.clear()
    }

    const sculptLayers = new Map(
      modifiers
        .filter(
          (modifier): modifier is SculptLayerModifier =>
            modifier.type === 'sculpt-layer',
        )
        .map((layer) => [layer.id, layer]),
    )
    const geometryModifiers = modifiers.filter(
      (modifier) =>
        modifier.type !== 'sculpt-layer' &&
        modifier.type !== 'material-settings',
    )
    const fingerprints = geometryModifiers.map((modifier) =>
      this.fingerprintModifier(modifier, sculptLayers),
    )

    return stableDigest({
        version: COMPILED_SECTION_CACHE_VERSION,
        key,
        config: {
          worldSize: config.worldSize,
          sectionSize: config.sectionSize,
          lodResolutions: config.lodResolutions,
          operationHalo: config.operationHalo,
          seed: config.seed,
          worldProfile: config.worldProfile,
        },
        // Order is significant: equal-priority modifiers are evaluated in the
        // stack's stable order, so the digest preserves the queried sequence.
        modifiers: fingerprints,
      })
  }

  private fingerprintModifier(
    modifier: Exclude<
      TerrainModifier,
      SculptLayerModifier | { type: 'material-settings' }
    >,
    sculptLayers: ReadonlyMap<string, SculptLayerModifier>,
  ): string {
    const existing = this.modifierFingerprints.get(modifier)
    if (existing) return existing

    const normalized = { ...modifier } as Record<string, unknown>
    // IDs are editor identity, not compiler input. The array position above
    // already captures the only output-relevant role IDs have: stack order.
    delete normalized.id
    if (modifier.type === 'brush-stroke') {
      normalizeSculptLayer(normalized, modifier, sculptLayers)
    }
    const fingerprint = stableDigest(normalized)
    this.modifierFingerprints.set(modifier, fingerprint)
    return fingerprint
  }
}

function normalizeSculptLayer(
  normalized: Record<string, unknown>,
  modifier: BrushStrokeModifier,
  sculptLayers: ReadonlyMap<string, SculptLayerModifier>,
): void {
  delete normalized.sculptLayerId
  if (!modifier.sculptLayerId) return
  const layer = sculptLayers.get(modifier.sculptLayerId)
  normalized.enabled = modifier.enabled && (layer?.enabled ?? true)
  normalized.strength =
    modifier.strength * clamp01(layer?.opacity ?? 1)
}

function stableDigest(value: unknown): string {
  const hash = new StableHash128()
  hash.value(value)
  return hash.finish()
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/**
 * Allocation-free canonical hashing for large numeric mesh operands. Four
 * independently mixed 32-bit lanes give a 128-bit cache identity while
 * avoiding multi-megabyte JSON strings during scene boot.
 */
class StableHash128 {
  private first = 0x811c9dc5
  private second = 0x9e3779b9
  private third = 0x85ebca77
  private fourth = 0xc2b2ae3d
  private readonly numberBuffer = new ArrayBuffer(8)
  private readonly numberView = new DataView(this.numberBuffer)

  value(value: unknown): void {
    if (value === null) {
      this.byte(0)
      return
    }
    if (typeof value === 'number') {
      this.byte(1)
      this.number(value)
      return
    }
    if (typeof value === 'string') {
      this.byte(2)
      this.uint32(value.length)
      for (let index = 0; index < value.length; index += 1) {
        this.word(value.charCodeAt(index))
      }
      return
    }
    if (typeof value === 'boolean') {
      this.byte(value ? 4 : 3)
      return
    }
    if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === 'number') {
        this.byte(9)
        this.uint32(value.length)
        for (const entry of value) this.number(entry as number)
        return
      }
      this.byte(5)
      this.uint32(value.length)
      for (const entry of value) this.value(entry)
      return
    }
    if (ArrayBuffer.isView(value)) {
      this.byte(6)
      this.value(value.constructor.name)
      const bytes = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      )
      this.uint32(bytes.byteLength)
      const words = Math.floor(bytes.byteLength / 4)
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let index = 0; index < words; index += 1) {
        this.word(view.getUint32(index * 4, true))
      }
      for (let index = words * 4; index < bytes.byteLength; index += 1) {
        this.byte(bytes[index])
      }
      return
    }
    if (typeof value === 'object') {
      this.byte(7)
      const record = value as Record<string, unknown>
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
      this.uint32(keys.length)
      for (const key of keys) {
        this.value(key)
        this.value(record[key])
      }
      return
    }
    this.byte(8)
  }

  finish(): string {
    return [this.first, this.second, this.third, this.fourth]
      .map((value) => hex32(avalanche(value)))
      .join('')
  }

  private uint32(value: number): void {
    this.word(value >>> 0)
  }

  private number(value: number): void {
    this.numberView.setFloat64(0, value, true)
    this.word(this.numberView.getUint32(0, true))
    this.word(this.numberView.getUint32(4, true))
  }

  private byte(value: number): void {
    this.word(value & 0xff)
  }

  private word(value: number): void {
    this.first = Math.imul(this.first ^ value, 0x01000193)
    this.second = Math.imul(this.second ^ value, 0x85ebca6b)
    this.third = Math.imul(this.third ^ value, 0xc2b2ae35)
    this.fourth = Math.imul(this.fourth ^ value, 0x27d4eb2f)
  }
}

function avalanche(value: number): number {
  let mixed = value >>> 0
  mixed ^= mixed >>> 16
  mixed = Math.imul(mixed, 0x7feb352d)
  mixed ^= mixed >>> 15
  mixed = Math.imul(mixed, 0x846ca68b)
  return (mixed ^ (mixed >>> 16)) >>> 0
}
