import type { Vec3Like } from '../core/types'

export type EditorLightType = 'point' | 'spot'

interface EditorLightBase {
  id: string
  name: string
  color: string
  intensity: number
  distance: number
  decay: number
  position: Vec3Like
  visible: boolean
}

export interface EditorPointLight extends EditorLightBase {
  type: 'point'
}

export interface EditorSpotLight extends EditorLightBase {
  type: 'spot'
  angle: number
  penumbra: number
  target: Vec3Like
}

export type EditorLight = EditorPointLight | EditorSpotLight

export interface EditorLightPatch {
  name?: string
  color?: string
  intensity?: number
  distance?: number
  decay?: number
  position?: Vec3Like
  visible?: boolean
  angle?: number
  penumbra?: number
  target?: Vec3Like
}

export function createEditorLight(
  type: EditorLightType,
  id: string,
  index: number,
  position: Vec3Like,
): EditorLight {
  const base = {
    id,
    name: `${type === 'point' ? 'Point' : 'Spot'} Light ${index}`,
    color: type === 'point' ? '#ffd2a1' : '#b9d8ff',
    intensity: type === 'point' ? 8 : 12,
    distance: 180,
    decay: 1.6,
    position,
    visible: true,
  }

  if (type === 'point') return { ...base, type }
  return {
    ...base,
    type,
    angle: Math.PI / 5,
    penumbra: 0.4,
    target: { x: position.x, y: position.y - 24, z: position.z },
  }
}

export function patchEditorLight(
  light: EditorLight,
  patch: EditorLightPatch,
): EditorLight {
  if (light.type === 'point') {
    return {
      ...light,
      name: patch.name ?? light.name,
      color: patch.color ?? light.color,
      intensity: patch.intensity ?? light.intensity,
      distance: patch.distance ?? light.distance,
      decay: patch.decay ?? light.decay,
      position: patch.position ?? light.position,
      visible: patch.visible ?? light.visible,
    }
  }
  return { ...light, ...patch }
}
