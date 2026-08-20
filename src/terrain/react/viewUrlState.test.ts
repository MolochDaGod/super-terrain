import { describe, expect, it } from 'vitest'
import { readViewUrlState } from './viewUrlState'

describe('readViewUrlState', () => {
  it('reads a full viewpoint', () => {
    const state = readViewUrlState('?cam=1,2,3&target=4,5,6&fov=35&quality=full&ui=off')
    expect(state.position).toEqual([1, 2, 3])
    expect(state.target).toEqual([4, 5, 6])
    expect(state.fov).toBe(35)
    expect(state.quality).toBe('full')
    expect(readViewUrlState('?debug=albedo').debug).toBe('albedo')
    expect(readViewUrlState('?debug=nonsense').debug).toBeUndefined()
    expect(state.hideUi).toBe(true)
    expect(readViewUrlState('?reset=1').reset).toBe(true)
  })

  it('ignores malformed vectors rather than throwing', () => {
    const state = readViewUrlState('?cam=1,2&target=a,b,c')
    expect(state.position).toBeUndefined()
    expect(state.target).toBeUndefined()
    expect(state.hideUi).toBe(false)
  })

  it('defaults to the editor view', () => {
    expect(readViewUrlState('')).toEqual({
      position: undefined,
      target: undefined,
      fov: undefined,
      quality: undefined,
      debug: undefined,
      exposure: undefined,
      hideUi: false,
      reset: false,
    })
  })
})
