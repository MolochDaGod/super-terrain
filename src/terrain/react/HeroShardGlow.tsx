import {
  THRUST_EMBER_DEPTH,
  THRUST_FACE_NORMAL,
  THRUST_WINDOWS,
} from '../demo/createThrustFormation'

/**
 * Real local illumination for the two CSG-authored ember chambers.
 *
 * There is intentionally no mesh in this component. The visible emitter is
 * the rear cap and walls produced by subtracting the tagged natural granite
 * chamber from the terrain itself; the terrain material reads that CSG tag as
 * emission. These lights provide the warm energy bounced onto the physical
 * lips and surrounding rock.
 */
export function HeroShardGlow() {
  // The emissive cap is the physical rear wall. A hot gas volume would light
  // the chamber from throughout its depth, so place the realtime point source
  // midway between that cap and the mouth; it remains completely inside the
  // subtractive volume while allowing the natural lip to receive warm bounce.
  const lightDepth = THRUST_EMBER_DEPTH * 0.72
  return (
    <group name="CSG ember chamber lights">
      {THRUST_WINDOWS.map((window, index) => {
        const position: [number, number, number] = [
          window.center.x - THRUST_FACE_NORMAL.x * lightDepth,
          window.center.y - THRUST_FACE_NORMAL.y * lightDepth,
          window.center.z - THRUST_FACE_NORMAL.z * lightDepth,
        ]
        return (
          <pointLight
            key={index}
            name="light inside CSG ember chamber"
            color="#ff7420"
            intensity={window.radius * 95}
            distance={window.radius * 4.3}
            decay={2}
            position={position}
          />
        )
      })}
    </group>
  )
}
