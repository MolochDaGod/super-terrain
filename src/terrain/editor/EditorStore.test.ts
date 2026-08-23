import { describe, expect, it } from 'vitest'
import { EditorStore } from './EditorStore'

describe('EditorStore lights', () => {
  it('defaults to full rendering at medium viewport DPR quality', () => {
    const editor = new EditorStore()

    expect(editor.getSnapshot().renderMode).toBe('full')
    expect(editor.getSnapshot().dprMode).toBe('medium')
  })

  it('adds, selects, updates, toggles, and removes a point light', () => {
    const editor = new EditorStore()
    const id = editor.addLight('point')

    expect(editor.getSnapshot().selectedLightId).toBe(id)
    expect(editor.getSnapshot().lights).toHaveLength(1)
    expect(editor.getSnapshot().lights[0]).toMatchObject({
      id,
      type: 'point',
      position: { x: 0, y: 80, z: 0 },
      visible: true,
    })

    editor.updateLight(id, {
      name: 'Key Light',
      color: '#ff8844',
      intensity: 24,
      distance: 260,
      visible: false,
      position: { x: 42, y: 90, z: -12 },
    })

    expect(editor.getSnapshot().lights[0]).toMatchObject({
      name: 'Key Light',
      color: '#ff8844',
      intensity: 24,
      distance: 260,
      visible: false,
      position: { x: 42, y: 90, z: -12 },
    })

    editor.removeLight(id)
    expect(editor.getSnapshot().lights).toEqual([])
    expect(editor.getSnapshot().selectedLightId).toBeUndefined()
  })

  it('places spot lights above the terrain cursor with an editable target', () => {
    const editor = new EditorStore()
    editor.setCursor(
      { x: 120, y: 35, z: -80 },
      { x: 0, y: 1, z: 0 },
    )
    const id = editor.addLight('spot')
    const light = editor.getSnapshot().lights[0]

    expect(light).toMatchObject({
      id,
      type: 'spot',
      position: { x: 120, y: 53, z: -80 },
      target: { x: 120, y: 29, z: -80 },
    })

    editor.updateLight(id, {
      angle: Math.PI / 3,
      penumbra: 0.75,
      target: { x: 130, y: 20, z: -70 },
    })

    expect(editor.getSnapshot().lights[0]).toMatchObject({
      angle: Math.PI / 3,
      penumbra: 0.75,
      target: { x: 130, y: 20, z: -70 },
    })
  })
})
