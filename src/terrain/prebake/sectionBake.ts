import type { CompiledLOD, CompiledSection } from '../core/types'

const MAGIC = 0x3142544d // "MTB1" in little endian.
const LEGACY_FORMAT_VERSION = 1
const FORMAT_VERSION = 2
const ARRAY_COUNT = 12
const MISSING_SOURCE_LEVEL = 0xffff_ffff

type NumericArray = Float32Array | Uint32Array | Uint16Array
type NumericArrayConstructor<T extends NumericArray> = {
  readonly BYTES_PER_ELEMENT: number
  new (buffer: ArrayBuffer): T
}

/** Compact binary transport for immutable, already-compiled showcase cells. */
export function encodeSectionBake(
  sections: readonly CompiledSection[],
): Uint8Array {
  const writer = new BinaryWriter()
  writer.u32(MAGIC)
  writer.u32(FORMAT_VERSION)
  writer.u32(sections.length)
  for (const section of sections) {
    writer.i32(section.key.x)
    writer.i32(section.key.z)
    writer.f32(section.bounds.min.x)
    writer.f32(section.bounds.min.y)
    writer.f32(section.bounds.min.z)
    writer.f32(section.bounds.max.x)
    writer.f32(section.bounds.max.y)
    writer.f32(section.bounds.max.z)
    writer.u32(section.lods.length)
    for (const lod of section.lods) writeLod(writer, lod)
  }
  return writer.finish()
}

export function decodeSectionBake(bytes: ArrayBuffer | Uint8Array): CompiledSection[] {
  let buffer: ArrayBuffer
  if (bytes instanceof Uint8Array) {
    buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
  } else {
    buffer = bytes
  }
  const reader = new BinaryReader(buffer)
  if (reader.u32() !== MAGIC) throw new Error('Invalid terrain section bake signature')
  const formatVersion = reader.u32()
  if (
    formatVersion !== LEGACY_FORMAT_VERSION &&
    formatVersion !== FORMAT_VERSION
  ) {
    throw new Error('Unsupported terrain section bake version')
  }
  const sectionCount = reader.u32()
  if (sectionCount > 4_096) throw new Error('Terrain section bake is unreasonably large')
  const sections: CompiledSection[] = []
  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const key = { x: reader.i32(), z: reader.i32() }
    const bounds = {
      min: { x: reader.f32(), y: reader.f32(), z: reader.f32() },
      max: { x: reader.f32(), y: reader.f32(), z: reader.f32() },
    }
    const lodCount = reader.u32()
    if (lodCount === 0 || lodCount > 16) {
      throw new Error(`Invalid LOD count in baked section ${key.x}:${key.z}`)
    }
    const lods: CompiledLOD[] = []
    let cpuBytes = 0
    let gpuBytes = 0
    for (let lodIndex = 0; lodIndex < lodCount; lodIndex += 1) {
      const lod = readLod(reader, formatVersion)
      lods.push(lod)
      gpuBytes += lod.gpuBytes
      cpuBytes +=
        lod.gpuBytes +
        (lod.stableVertexIds?.byteLength ?? 0) +
        (lod.sourceVertexIndices?.byteLength ?? 0)
    }
    const source = lods[0]!
    sections.push({
      key,
      sourceRevision: 0,
      bounds,
      lods,
      cpuBytes,
      gpuBytes,
      metadata: {
        compileMs: 0,
        vertexCount: source.positions.length / 3,
        triangleCount: source.indices.length / 3,
        density: source.positions.length / 3 / (128 * 128),
        hasArbitraryTopology: true,
        validationWarnings: 0,
      },
    })
  }
  reader.expectEnd()
  return sections
}

function writeLod(writer: BinaryWriter, lod: CompiledLOD): void {
  writer.u32(lod.level)
  writer.u32(lod.sourceLevel ?? MISSING_SOURCE_LEVEL)
  writer.f32(lod.geometricError)
  const arrays: readonly NumericArray[] = [
    lod.positions,
    lod.stableVertexIds ?? new Uint32Array(),
    lod.sourceVertexIndices ?? new Uint32Array(),
    lod.normals,
    lod.colors,
    ...(lod.surfaceFields ?? emptySurfaceFields()),
    lod.paintWeights ?? new Uint16Array(),
    lod.indices,
  ]
  if (arrays.length !== ARRAY_COUNT) throw new Error('Incomplete compiled terrain LOD')
  for (const array of arrays) writer.typed(array)
}

function readLod(reader: BinaryReader, formatVersion: number): CompiledLOD {
  const level = reader.u32()
  const encodedSourceLevel = formatVersion >= 2
    ? reader.u32()
    : MISSING_SOURCE_LEVEL
  const geometricError = reader.f32()
  const positions = reader.typed(Float32Array)
  const stableVertexIds = reader.typed(Uint32Array)
  const sourceVertexIndices = formatVersion >= 2
    ? reader.typed(Uint32Array)
    : new Uint32Array()
  const normals = reader.typed(Float32Array)
  const colors = reader.typed(Float32Array)
  const surfaceFields = [
    reader.typed(Uint16Array),
    reader.typed(Uint16Array),
    reader.typed(Uint16Array),
    reader.typed(Uint16Array),
    reader.typed(Uint16Array),
  ] as const
  const paintWeights = reader.typed(Uint16Array)
  const indices = reader.typed(Uint32Array)
  const gpuBytes =
    positions.byteLength +
    normals.byteLength +
    colors.byteLength +
    surfaceFields.reduce((sum, field) => sum + field.byteLength, 0) +
    paintWeights.byteLength +
    indices.byteLength
  return {
    level,
    sourceLevel:
      encodedSourceLevel === MISSING_SOURCE_LEVEL
        ? undefined
        : encodedSourceLevel,
    geometricError,
    positions,
    stableVertexIds: stableVertexIds.length > 0 ? stableVertexIds : undefined,
    sourceVertexIndices:
      sourceVertexIndices.length > 0 ? sourceVertexIndices : undefined,
    normals,
    colors,
    surfaceFields,
    paintWeights,
    indices,
    triangleCount: indices.length / 3,
    gpuBytes,
  }
}

function emptySurfaceFields(): readonly Uint16Array[] {
  return [
    new Uint16Array(),
    new Uint16Array(),
    new Uint16Array(),
    new Uint16Array(),
    new Uint16Array(),
  ]
}

class BinaryWriter {
  private bytes = new Uint8Array(1_024)
  private view = new DataView(this.bytes.buffer)
  private offset = 0

  u32(value: number): void {
    this.ensure(4)
    this.view.setUint32(this.offset, value, true)
    this.offset += 4
  }

  i32(value: number): void {
    this.ensure(4)
    this.view.setInt32(this.offset, value, true)
    this.offset += 4
  }

  f32(value: number): void {
    this.ensure(4)
    this.view.setFloat32(this.offset, value, true)
    this.offset += 4
  }

  typed(array: NumericArray): void {
    this.u32(array.length)
    const source = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    this.ensure(source.byteLength)
    this.bytes.set(source, this.offset)
    this.offset += source.byteLength
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.offset)
  }

  private ensure(extra: number): void {
    if (this.offset + extra <= this.bytes.length) return
    let capacity = this.bytes.length
    while (capacity < this.offset + extra) capacity *= 2
    const grown = new Uint8Array(capacity)
    grown.set(this.bytes)
    this.bytes = grown
    this.view = new DataView(grown.buffer)
  }
}

class BinaryReader {
  private readonly view: DataView
  private readonly buffer: ArrayBuffer
  private offset = 0

  constructor(buffer: ArrayBuffer) {
    this.buffer = buffer
    this.view = new DataView(buffer)
  }

  u32(): number {
    this.require(4)
    const value = this.view.getUint32(this.offset, true)
    this.offset += 4
    return value
  }

  i32(): number {
    this.require(4)
    const value = this.view.getInt32(this.offset, true)
    this.offset += 4
    return value
  }

  f32(): number {
    this.require(4)
    const value = this.view.getFloat32(this.offset, true)
    this.offset += 4
    return value
  }

  typed<T extends NumericArray>(constructor: NumericArrayConstructor<T>): T {
    const length = this.u32()
    const byteLength = length * constructor.BYTES_PER_ELEMENT
    this.require(byteLength)
    const copy = this.buffer.slice(this.offset, this.offset + byteLength)
    this.offset += byteLength
    return new constructor(copy)
  }

  expectEnd(): void {
    if (this.offset !== this.buffer.byteLength) {
      throw new Error('Trailing bytes in terrain section bake')
    }
  }

  private require(byteLength: number): void {
    if (this.offset + byteLength > this.buffer.byteLength) {
      throw new Error('Truncated terrain section bake')
    }
  }
}
