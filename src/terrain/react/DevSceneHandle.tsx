import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'

/**
 * Publishes the live scene graph on `window.__meshterrainScene` in development
 * only. The browser screenshot harness uses it to read what was actually
 * rendered — sun direction, tone mapping, shadow state — instead of inferring
 * it from the source, which is how the offline capture tool and the editor
 * drifted apart in the first place.
 */
export function DevSceneHandle() {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const camera = useThree((state) => state.camera)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const globals = globalThis as Record<string, unknown>
    globals.__meshterrainScene = { gl, scene, camera }
    return () => {
      delete globals.__meshterrainScene
    }
  }, [camera, gl, scene])

  return null
}
