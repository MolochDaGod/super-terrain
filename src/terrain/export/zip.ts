export interface ZipFile {
  path: string
  data: Uint8Array | string
}

const encoder = new TextEncoder()

/**
 * Builds a standards-compliant, uncompressed ZIP in memory.
 *
 * The exported GLB is already binary and does not benefit much from running a
 * second compressor over it. Store mode also keeps this dependency-free and
 * makes the resulting Godot project readable by every ZIP implementation.
 */
export function createZip(files: readonly ZipFile[]): Uint8Array {
  const entries = withDirectoryEntries(files).map((file) => {
    const name = encoder.encode(normalizePath(file.path))
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data
    return {
      name,
      data,
      crc: crc32(data),
      offset: 0,
      directory: file.path.endsWith('/'),
    }
  })
  const localLength = entries.reduce(
    (length, entry) => length + 30 + entry.name.length + entry.data.length,
    0,
  )
  const centralLength = entries.reduce(
    (length, entry) => length + 46 + entry.name.length,
    0,
  )
  const output = new Uint8Array(localLength + centralLength + 22)
  const view = new DataView(output.buffer)
  let cursor = 0

  for (const entry of entries) {
    entry.offset = cursor
    view.setUint32(cursor, 0x04034b50, true)
    view.setUint16(cursor + 4, 20, true)
    view.setUint16(cursor + 6, 0x0800, true)
    view.setUint16(cursor + 8, 0, true)
    view.setUint16(cursor + 10, 0, true)
    view.setUint16(cursor + 12, 0, true)
    view.setUint32(cursor + 14, entry.crc, true)
    view.setUint32(cursor + 18, entry.data.length, true)
    view.setUint32(cursor + 22, entry.data.length, true)
    view.setUint16(cursor + 26, entry.name.length, true)
    view.setUint16(cursor + 28, 0, true)
    output.set(entry.name, cursor + 30)
    output.set(entry.data, cursor + 30 + entry.name.length)
    cursor += 30 + entry.name.length + entry.data.length
  }

  const centralOffset = cursor
  for (const entry of entries) {
    view.setUint32(cursor, 0x02014b50, true)
    view.setUint16(cursor + 4, 20, true)
    view.setUint16(cursor + 6, 20, true)
    view.setUint16(cursor + 8, 0x0800, true)
    view.setUint16(cursor + 10, 0, true)
    view.setUint16(cursor + 12, 0, true)
    view.setUint16(cursor + 14, 0, true)
    view.setUint32(cursor + 16, entry.crc, true)
    view.setUint32(cursor + 20, entry.data.length, true)
    view.setUint32(cursor + 24, entry.data.length, true)
    view.setUint16(cursor + 28, entry.name.length, true)
    view.setUint16(cursor + 30, 0, true)
    view.setUint16(cursor + 32, 0, true)
    view.setUint16(cursor + 34, 0, true)
    view.setUint16(cursor + 36, 0, true)
    // Godot's package installer does not synthesize parent directories while
    // extracting. The trailing-slash entries above therefore need the DOS
    // directory bit as well; general-purpose unzip tools tend to infer both.
    view.setUint32(cursor + 38, entry.directory ? 0x10 : 0, true)
    view.setUint32(cursor + 42, entry.offset, true)
    output.set(entry.name, cursor + 46)
    cursor += 46 + entry.name.length
  }

  view.setUint32(cursor, 0x06054b50, true)
  view.setUint16(cursor + 4, 0, true)
  view.setUint16(cursor + 6, 0, true)
  view.setUint16(cursor + 8, entries.length, true)
  view.setUint16(cursor + 10, entries.length, true)
  view.setUint32(cursor + 12, centralLength, true)
  view.setUint32(cursor + 16, centralOffset, true)
  view.setUint16(cursor + 20, 0, true)
  return output
}

/** Adds every parent before the file that needs it, once. */
function withDirectoryEntries(files: readonly ZipFile[]): ZipFile[] {
  const expanded: ZipFile[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const path = normalizePath(file.path)
    const parts = path.split('/')
    const directoryCount = parts.length - 1
    let parent = ''
    for (let index = 0; index < directoryCount; index += 1) {
      if (!parts[index]) continue
      parent += `${parts[index]}/`
      if (seen.has(parent)) continue
      seen.add(parent)
      expanded.push({ path: parent, data: new Uint8Array() })
    }
    if (seen.has(path)) {
      if (!path.endsWith('/')) throw new Error(`Duplicate ZIP path: ${path}`)
      continue
    }
    seen.add(path)
    expanded.push({ ...file, path })
  }
  return expanded
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '')
  if (!normalized || normalized.split('/').some((part) => part === '..')) {
    throw new Error(`Unsafe ZIP path: ${path}`)
  }
  return normalized
}

function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}
