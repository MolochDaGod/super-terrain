/**
 * Image import builder for terrain heightmaps and props.
 * 
 * Handles two workflows:
 * 1. Heightmap/satellite → terrain using this repo's existing compiler
 *    (heightField.ts, AdaptiveHeightMesh.ts partitioned mesh)
 * 2. Concept/prop image → THREE.Group via img2threejs factory approach
 *    (reconstruction-by-code, NOT photogrammetry, NOT simple heightmap)
 * 
 * This is a minimal viable integration. Full img2threejs port would be a
 * separate effort - we reference the approach from MolochDaGod/img2threejs fork.
 */

import { createErrorBoundedHeightMesh, type AdaptiveHeightMesh } from '../compiler/AdaptiveHeightMesh'
import type { WorldTerrain } from '../WorldTerrain'
import type { Vec3Like } from '../core/types'

export type ImageImportMode = 'heightmap' | 'prop'

export interface ImageImportOptions {
  mode: ImageImportMode
  image: HTMLImageElement
  terrain: WorldTerrain
  /** For heightmaps: where to place the imported terrain */
  targetX?: number
  targetZ?: number
  /** For heightmaps: physical size in meters */
  physicalSize?: number
  /** For props: where to place the group on terrain */
  placeOnTerrain?: boolean
}

export interface HeightmapImportResult {
  mesh: AdaptiveHeightMesh
  sectionX: number
  sectionZ: number
}

/**
 * Import a heightmap or satellite image as terrain using the adaptive compiler.
 * Uses this repo's partitioned mesh approach (not a single PlaneGeometry).
 */
export async function importHeightmapAsTerrain(
  image: HTMLImageElement,
  terrain: WorldTerrain,
  options: {
    targetX?: number
    targetZ?: number
    physicalSize?: number
  } = {},
): Promise<HeightmapImportResult | null> {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.drawImage(image, 0, 0)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  
  // Extract height values from image (grayscale luminance)
  const heightValues = new Float32Array(canvas.width * canvas.height)
  for (let i = 0; i < heightValues.length; i += 1) {
    const r = imageData.data[i * 4]
    const g = imageData.data[i * 4 + 1]
    const b = imageData.data[i * 4 + 2]
    // Convert to grayscale luminance 0-1
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    heightValues[i] = luminance
  }
  
  // Default to section 0,0 if not specified
  const sectionX = options.targetX ?? 0
  const sectionZ = options.targetZ ?? 0
  const physicalSize = options.physicalSize ?? terrain.config.sectionSize
  
  // Height scale: map 0-1 luminance to elevation range
  const minElevation = 0
  const maxElevation = 200 // meters
  
  // Build adaptive mesh using this repo's compiler
  const resolution = Math.min(canvas.width, canvas.height, 128)
  const mesh = createErrorBoundedHeightMesh({
    originX: sectionX * terrain.config.sectionSize,
    originZ: sectionZ * terrain.config.sectionSize,
    size: physicalSize,
    resolution,
    errorTolerance: 0.5,
    evaluate: (worldX: number, worldZ: number): Vec3Like => {
      // Sample heightmap
      const u = (worldX - sectionX * terrain.config.sectionSize) / physicalSize
      const v = (worldZ - sectionZ * terrain.config.sectionSize) / physicalSize
      
      const ix = Math.floor(u * (canvas.width - 1))
      const iz = Math.floor(v * (canvas.height - 1))
      const clamped_x = Math.max(0, Math.min(canvas.width - 1, ix))
      const clamped_z = Math.max(0, Math.min(canvas.height - 1, iz))
      
      const index = clamped_z * canvas.width + clamped_x
      const heightValue = heightValues[index] ?? 0
      const elevation = minElevation + heightValue * (maxElevation - minElevation)
      
      return {
        x: worldX,
        y: elevation,
        z: worldZ,
      }
    },
  })
  
  if (!mesh) return null
  
  return {
    mesh,
    sectionX,
    sectionZ,
  }
}

/**
 * Placeholder for prop import via img2threejs approach.
 * 
 * The full implementation would port generate_threejs_factory.py logic
 * from MolochDaGod/img2threejs/forge/stage3_build/ to generate a
 * THREE.Group factory from a concept image.
 * 
 * For now, this returns null to indicate the feature needs the full port.
 * A complete implementation would:
 * 1. Analyze the reference image (edge detection, depth estimation)
 * 2. Generate a TypeScript THREE.Group factory (reconstruction-by-code)
 * 3. Instantiate and place the group on terrain
 */
export async function importPropAsGroup(
  _image: HTMLImageElement,
  _terrain: WorldTerrain,
  _placeOnTerrain = true,
): Promise<unknown | null> {
  // TODO: Port img2threejs factory generation
  // This would require:
  // - Image analysis (edges, depth, structure)
  // - Code generation for THREE.Group factory
  // - Group instantiation and placement
  
  console.warn(
    'Prop import via img2threejs requires porting generate_threejs_factory.py logic. ' +
    'See MolochDaGod/img2threejs/forge/stage3_build/ for reference implementation.',
  )
  
  return null
}

/**
 * Validate image for import (size, format checks).
 */
export function validateImageForImport(
  image: HTMLImageElement,
): { valid: boolean; error?: string } {
  if (image.width === 0 || image.height === 0) {
    return { valid: false, error: 'Image dimensions are zero' }
  }
  
  if (image.width > 4096 || image.height > 4096) {
    return { valid: false, error: 'Image too large (max 4096x4096)' }
  }
  
  if (image.width < 32 || image.height < 32) {
    return { valid: false, error: 'Image too small (min 32x32)' }
  }
  
  return { valid: true }
}

/**
 * Load image from file picker or drop event.
 */
export function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('File is not an image'))
      return
    }
    
    const img = new Image()
    const url = URL.createObjectURL(file)
    
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }
    
    img.src = url
  })
}
