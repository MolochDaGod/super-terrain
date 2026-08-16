import { DoubleSide, MeshStandardNodeMaterial } from 'three/webgpu'
import {
  Fn,
  If,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  dFdx,
  dFdy,
  dot,
  faceDirection,
  float,
  max,
  mix,
  normalize,
  normalWorld,
  positionWorld,
  smoothstep,
  struct,
  vec3,
} from 'three/tsl'
import { SUN_DIRECTION } from './atmosphere'
import {
  parallaxPosition,
  parallaxShadow,
  parallaxStrength,
  viewVector,
} from './parallax'
import {
  layerWeights,
  reliefNormal,
  shadeSurface,
  surfaceDetail,
  terrainSlowFields,
} from './surface'

/**
 * Unlit inspection views. Shading bugs and material bugs look identical in a
 * finished frame; these separate them.
 */
export type FullMaterialDebug =
  | 'none'
  | 'albedo'
  | 'normal'
  | 'relief'
  | 'layers'
  | 'strata'
  | 'crack'
  | 'blocks'
  | 'buttress'

export interface FullTerrainMaterialOptions {
  /** Scales every micro-relief effect; 0 disables parallax entirely. */
  detailScale?: number
  debug?: FullMaterialDebug
}

function debugView(debug: FullMaterialDebug, surface: any) {
  switch (debug) {
    case 'albedo':
      // Scaled up: raw albedo is 0.03–0.12 and unreadable on screen.
      return surface.get('albedo').mul(6)
    case 'normal':
      return surface.get('normal').mul(0.5).add(0.5)
    case 'relief':
      return vec3(surface.get('reliefHeight').mul(0.35).add(0.5))
    case 'layers':
      return surface.get('layerDebug')
    case 'strata':
      return vec3(surface.get('strata'))
    case 'crack':
      return vec3(surface.get('crack'))
    case 'blocks':
      return vec3(surface.get('blocks'))
    case 'buttress':
      return vec3(surface.get('buttress'))
    default:
      return surface.get('albedo')
  }
}

const TerrainSurface = struct(
  {
    albedo: 'vec3',
    roughness: 'float',
    normal: 'vec3',
    occlusion: 'float',
    reliefHeight: 'float',
    layerDebug: 'vec3',
    strata: 'float',
    crack: 'float',
    blocks: 'float',
    buttress: 'float',
  },
  'TerrainSurface',
)

/**
 * The `full` terrain material.
 *
 * View-independent broad fields and terrain-scale cavity are cached with each
 * compiled section. Centimetre-scale relief remains procedural per pixel so it
 * stays sharper than the mesh vertex spacing. The pipeline per pixel is:
 *
 *   1. estimate the pixel's world footprint (drives every anti-alias fade)
 *   2. pick layer coverage from slope / altitude / macro noise
 *   3. march the view ray through the virtual micro-relief (parallax)
 *   4. resolve the layer stack by height at the parallaxed point
 *   5. shade albedo / roughness / cavity, and rebuild the normal from relief
 *
 * All four material slots read from one shared evaluation, so the expensive
 * steps are emitted exactly once per fragment.
 */
export function createFullTerrainMaterial(
  options: FullTerrainMaterialOptions = {},
) {
  const detailScale = options.detailScale ?? 1
  const debug = options.debug ?? 'none'
  const material = new MeshStandardNodeMaterial({
    metalness: 0,
    side: DoubleSide,
  })

  const evaluate = Fn(() => {
    const position = positionWorld
    // Sections render double-sided so tunnel interiors are visible. Without
    // flipping by face direction, every back face shades with an inverted
    // normal and comes out black.
    const geometricNormal = normalize(normalWorld)
      .mul(faceDirection)
      .toVar('geometricNormal')
    const { direction: view, distance: viewDistance } = viewVector(
      position,
      cameraPosition,
    )

    // World size of one pixel. Screen-space derivatives of the world position
    // are the only reliable measure here because the mesh has no UVs.
    const footprint = max(dFdx(position).length(), dFdy(position).length())
      .max(0.0005)
      .toVar('pixelFootprint')

    const slow = terrainSlowFields(position)
    const weights = layerWeights(position, geometricNormal, footprint, slow)
    const facing = clamp(dot(geometricNormal, view), 0, 1).toVar('surfaceFacing')

    const parallaxAmount = parallaxStrength(viewDistance, facing)
      .mul(detailScale)
      .toVar('parallaxAmount')
    // Parallax is a loop of noise evaluations; outside its fade range it
    // contributes nothing, so it must be branched around rather than multiplied
    // by zero after the fact.
    const shadedPosition = vec3(position).toVar('shadedPosition')
    If(parallaxAmount.greaterThan(0.01), () => {
      shadedPosition.assign(
        mix(
          position,
          parallaxPosition(position, geometricNormal, view, weights, parallaxAmount),
          parallaxAmount,
        ),
      )
    })

    const surface = surfaceDetail(
      shadedPosition,
      geometricNormal,
      weights,
      footprint,
      slow,
    )
    const shading = shadeSurface(weights, surface, slow)

    // Bump strength falls off with distance so relief never fights the
    // silhouette at range and distant terrain stays smooth.
    // Relief keeps contributing at range now that each band is band-limited;
    // only the very far field is flattened, to protect the silhouette.
    const bumpStrength = mix(float(1.35), float(0.75), smoothstep(120, 1_400, viewDistance))
      .mul(detailScale)
      .toVar('bumpStrength')
    const shadedNormal = reliefNormal(
      shadedPosition,
      geometricNormal,
      surface.normalHeight,
      bumpStrength,
    )

    const microShadow = float(1).toVar('microShadow')
    If(parallaxAmount.greaterThan(0.01), () => {
      microShadow.assign(
        mix(
          float(1),
          parallaxShadow(
            shadedPosition,
            geometricNormal,
            SUN_DIRECTION,
            weights,
            parallaxAmount,
          ),
          parallaxAmount,
        ),
      )
    })

    // Debug outputs are separate material variants. Do not make the normal
    // renderer carry their arithmetic merely because the struct can expose it.
    const layerDebug =
      debug === 'layers'
        ? vec3(
            surface.resolved.rock,
            surface.resolved.grass.add(surface.resolved.meadow),
            surface.resolved.scree.add(surface.resolved.soil),
          ).add(vec3(surface.resolved.snow))
        : vec3(0)

    return TerrainSurface(
      shading.albedo,
      shading.roughness,
      shadedNormal,
      clamp(shading.cavity.mul(microShadow).mul(slow.occlusion), 0.18, 1),
      debug === 'relief' ? surface.height : float(0),
      layerDebug,
      debug === 'strata' ? surface.detail.strata : float(0),
      debug === 'crack' ? surface.detail.crack : float(0),
      debug === 'blocks' ? surface.detail.blocks : float(0),
      debug === 'buttress' ? surface.detail.buttress : float(0),
    )
  })()

  const surface = evaluate as any
  if (debug !== 'none') {
    // Unlit: whatever is inspected must not be modulated by the lighting that
    // is under investigation.
    material.lights = false
    material.colorNode = debugView(debug, surface)
    return { material, dispose: () => material.dispose() }
  }

  material.colorNode = surface.get('albedo')
  material.roughnessNode = surface.get('roughness')
  material.normalNode = surface.get('normal').transformDirection(cameraViewMatrix)
  material.aoNode = surface.get('occlusion')

  return {
    material,
    dispose() {
      material.dispose()
    },
  }
}
