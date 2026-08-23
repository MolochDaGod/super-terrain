import { describe, expect, it } from 'vitest'
import { createZip } from './zip'

describe('createZip', () => {
  it('rejects parent traversal paths', () => {
    expect(() => createZip([{ path: '../world.tscn', data: '' }])).toThrow(
      'Unsafe ZIP path',
    )
  })

  it('writes matching local and central directory counts', () => {
    const zip = createZip([
      { path: 'a.txt', data: 'alpha' },
      { path: 'nested/b.bin', data: new Uint8Array([1, 2, 3]) },
    ])
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    const end = zip.length - 22
    expect(view.getUint32(end, true)).toBe(0x06054b50)
    expect(view.getUint16(end + 8, true)).toBe(3)
    expect(view.getUint16(end + 10, true)).toBe(3)
    expect(view.getUint32(view.getUint32(end + 16, true), true)).toBe(0x02014b50)
  })

  it('writes explicit parent directory records for Godot package extraction', () => {
    const zip = createZip([{ path: 'assets/world.glb', data: new Uint8Array([1]) }])
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    const firstNameLength = view.getUint16(26, true)
    expect(new TextDecoder().decode(zip.subarray(30, 30 + firstNameLength))).toBe('assets/')

    const end = zip.length - 22
    const central = view.getUint32(end + 16, true)
    expect(view.getUint32(central, true)).toBe(0x02014b50)
    expect(view.getUint32(central + 38, true) & 0x10).toBe(0x10)
  })
})
