import { useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three/webgpu'
import type { ForestTreeInstance } from '../TreeAssetView'

/**
 * Where a prototype's stems stop being geometry and start being cards.
 *
 * Metres, measured to the trunk base. The band between the two is deliberately
 * wide: across it the card dissolves while the real tree grows in underneath,
 * and both are drawn, so a stem is never seen to change representation.
 */
export const IMPOSTOR_FADE_START = 62
export const IMPOSTOR_FADE_END = 96

export interface ImpostorSplit {
  near: ForestTreeInstance[]
  far: ForestTreeInstance[]
}

/**
 * Splits a stand into the part drawn as geometry and the part drawn as cards.
 *
 * Recomputed only when the camera has actually travelled, for the same reason
 * `DistanceLodForest` throttles its own reclassification: this produces React
 * state, and doing it per frame would rebuild both the geometry instance
 * buffers and the card buffer continuously while the viewer walks.
 *
 * Stems inside `IMPOSTOR_FADE_END` appear in *both* halves. That overlap is
 * what the dissolve needs — the card's alpha cutoff rises across the band until
 * nothing survives, and the geometry is already standing there when it goes.
 */
export function useImpostorSplit(
  instances: readonly ForestTreeInstance[],
): ImpostorSplit {
  const camera = useThree((state) => state.camera)
  const [split, setSplit] = useState<ImpostorSplit>({ near: [], far: [] })
  const at = useRef(new Vector3(Number.POSITIVE_INFINITY, 0, 0))
  const source = useRef<readonly ForestTreeInstance[]>([])

  useFrame(() => {
    const moved = at.current.distanceToSquared(camera.position) >= 4
    if (!moved && source.current === instances) return
    at.current.copy(camera.position)
    source.current = instances

    const near: ForestTreeInstance[] = []
    const far: ForestTreeInstance[] = []
    const handover = IMPOSTOR_FADE_END * IMPOSTOR_FADE_END
    for (const instance of instances) {
      const dx = instance.position[0] - camera.position.x
      const dy = instance.position[1] - camera.position.y
      const dz = instance.position[2] - camera.position.z
      if (dx * dx + dy * dy + dz * dz <= handover) near.push(instance)
      // Cards carry the whole stand, near ones included. They cost two
      // triangles each and the near ones have dissolved to nothing by the time
      // they matter, so excluding them would buy a rebuild of the card buffer
      // on every step the viewer takes and save nothing.
      far.push(instance)
    }
    setSplit({ near, far })
  })

  return split
}
