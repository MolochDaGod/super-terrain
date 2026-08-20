import { useEffect, useMemo } from 'react'
import { MeshBasicNodeMaterial, SphereGeometry } from 'three/webgpu'
import { clamp, mix, normalView, pow, vec3 } from 'three/tsl'
import { SHARD_FACE_NORMAL, SHARD_WINDOWS } from '../demo/createHeroShard'

/**
 * Molten rock at the back of the shard's two windows.
 *
 * Two things have to be true for this to read as a light source rather than as
 * an orange decal: the glowing body has to sit *inside* the opening so the rock
 * lip occludes part of it, and it has to light the rock around it. So each
 * window gets an emissive body deep in the passage — bright enough that the
 * bloom in the post chain picks it up — and a point light at the same place,
 * which is what puts the warm bounce on the lip and on the face outside.
 *
 * The body is a smooth molten sphere: what shows through the opening is liquid
 * rock, and liquid has no fracture surfaces to break the glow over.
 *
 * The point lights go through the clustered lighting path, which is what that
 * path is for: many small local lights the single scene sun cannot express.
 */
export function HeroShardGlow() {
  const geometry = useMemo(() => new SphereGeometry(1, 32, 20), [])

  const material = useMemo(() => {
    const value = new MeshBasicNodeMaterial()
    // A constant emissive sphere renders as a flat disc, which is what a decal
    // looks like. Melt is not uniform: the face turned toward the viewer is
    // looking down into the hottest part of the body while the limb is seen
    // through a long slant of its own cooling crust, so the centre runs to
    // yellow-white and the edge to dull red. Keying the emission to the view
    // normal is the cheapest honest version of that, and it also gives the
    // bloom a bright core to bite on instead of an even wash.
    //
    // Values above 1 are deliberate: this is a self-luminous surface at a
    // couple of thousand kelvin, and the tone mapper is what brings it back
    // into range — which is also what gives it its gradient. But not far above
    // 1. AgX desaturates as it compresses, so an emissive keyed high enough to
    // be unmistakably bright comes out of the tone mapper as a white disc with
    // an orange rim, which is exactly what molten rock does not look like.
    // Keeping the peak just over unity and letting bloom carry the sense of
    // brightness is what holds the colour.
    value.colorNode = mix(
      vec3(0.72, 0.08, 0.01),
      vec3(1.7, 0.42, 0.05),
      pow(clamp(normalView.z, 0, 1), 1.7),
    )
    return value
  }, [])

  useEffect(
    () => () => {
      material.dispose()
      geometry.dispose()
    },
    [geometry, material],
  )

  return (
    <group name="Hero shard glow">
      {SHARD_WINDOWS.map((window, index) => (
        <group
          key={index}
          // Recessed down the bore, away from the face the frame looks at, so
          // the opening's own lip cuts into the body instead of the glow
          // sitting on the rock like a sticker.
          position={[
            window.center.x + SHARD_FACE_NORMAL.x * window.radius * 1.15,
            window.center.y,
            window.center.z + SHARD_FACE_NORMAL.z * window.radius * 1.15,
          ]}
        >
          <mesh geometry={geometry} material={material} scale={window.radius * 0.28} />
          <pointLight
            color="#ff7326"
            intensity={window.radius * 120}
            distance={window.radius * 5}
            decay={2}
          />
        </group>
      ))}
    </group>
  )
}
