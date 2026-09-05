/**
 * Image import dialog for terrain heightmaps and props.
 * 
 * UI for dropping/picking PNG images, choosing mode (heightmap vs prop),
 * and applying to the terrain.
 */

import { memo, useState, useCallback } from 'react'
import { FileImage, Mountain, X } from 'lucide-react'
import type { WorldTerrain } from '../../terrain/WorldTerrain'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import {
  importHeightmapAsTerrain,
  loadImageFromFile,
  validateImageForImport,
  type ImageImportMode,
} from '../../terrain/import/imageBuilder'

interface ImageImportDialogProps {
  terrain: WorldTerrain
  editor: EditorStore
  open: boolean
  onClose: () => void
}

export const ImageImportDialog = memo(function ImageImportDialog({
  terrain,
  editor,
  open,
  onClose,
}: ImageImportDialogProps) {
  const [mode, setMode] = useState<ImageImportMode>('heightmap')
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleFileSelect = useCallback(async (file: File) => {
    setError(null)
    try {
      const img = await loadImageFromFile(file)
      const validation = validateImageForImport(img)
      
      if (!validation.valid) {
        setError(validation.error ?? 'Invalid image')
        return
      }
      
      // Create preview URL
      const url = URL.createObjectURL(file)
      setImageUrl(url)
      setImage(img)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load image')
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) {
      void handleFileSelect(file)
    }
  }, [handleFileSelect])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      void handleFileSelect(file)
    }
  }, [handleFileSelect])

  const handleApply = useCallback(async () => {
    if (!image) return
    
    setImporting(true)
    setError(null)
    
    try {
      if (mode === 'heightmap') {
        const result = await importHeightmapAsTerrain(image, terrain, {
          targetX: 0,
          targetZ: 0,
        })
        
        if (result) {
          // Apply mesh to terrain section using replaceSectionMesh
          const sectionKey = { x: result.sectionX, z: result.sectionZ }
          const insertedCount = terrain.replaceSectionMesh(sectionKey, result.mesh)
          
          editor.patch({
            status: `Heightmap imported to section (${result.sectionX}, ${result.sectionZ}) with ${insertedCount} triangles`,
          })
        } else {
          setError('Failed to generate terrain mesh from heightmap')
        }
      } else {
        setError('Prop import requires img2threejs port (see imageBuilder.ts)')
      }
      
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }, [image, mode, terrain, editor, onClose])

  const handleClose = useCallback(() => {
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl)
    }
    setImage(null)
    setImageUrl(null)
    setError(null)
    onClose()
  }, [imageUrl, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="relative max-w-lg rounded-2xl border border-white/[0.09] bg-[#0b1312]/95 p-6 shadow-2xl">
        <button
          type="button"
          className="absolute right-3 top-3 grid size-6 place-items-center text-white/40 transition hover:text-white/80"
          onClick={handleClose}
          aria-label="Close"
        >
          <X size={14} />
        </button>

        <h2 className="text-base font-semibold text-white/85">
          Import Image as Terrain
        </h2>
        <p className="mt-1 text-[11px] text-white/42">
          Drop a PNG heightmap or concept image
        </p>

        <div className="mt-4 space-y-3">
          {/* Mode selector */}
          <div className="flex gap-2">
            <button
              type="button"
              data-active={mode === 'heightmap'}
              className="flex-1 rounded-lg border border-white/[0.09] bg-white/[0.02] px-3 py-2 text-[11px] transition data-[active=true]:border-[#77e8be]/40 data-[active=true]:bg-[#77e8be]/10 data-[active=true]:text-[#a6f2d5]"
              onClick={() => setMode('heightmap')}
            >
              <Mountain size={14} className="mx-auto mb-1" />
              Heightmap → Terrain
            </button>
            <button
              type="button"
              data-active={mode === 'prop'}
              className="flex-1 rounded-lg border border-white/[0.09] bg-white/[0.02] px-3 py-2 text-[11px] transition data-[active=true]:border-[#77e8be]/40 data-[active=true]:bg-[#77e8be]/10 data-[active=true]:text-[#a6f2d5]"
              onClick={() => setMode('prop')}
            >
              <FileImage size={14} className="mx-auto mb-1" />
              Concept → Prop
            </button>
          </div>

          {/* Drop zone */}
          <div
            className="relative rounded-lg border-2 border-dashed border-white/[0.09] bg-white/[0.02] p-8 text-center transition hover:border-white/[0.15]"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
          >
            {imageUrl ? (
              <div className="space-y-2">
                <img
                  src={imageUrl}
                  alt="Preview"
                  className="mx-auto max-h-48 rounded border border-white/[0.09]"
                />
                <p className="text-[11px] text-white/60">
                  {image?.width} × {image?.height}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <FileImage size={32} className="mx-auto text-white/20" />
                <p className="text-[11px] text-white/60">
                  Drop image here or click to browse
                </p>
              </div>
            )}
            
            <input
              type="file"
              accept="image/png,image/jpeg,image/jpg"
              className="absolute inset-0 cursor-pointer opacity-0"
              onChange={handleFileInput}
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
              {error}
            </div>
          )}

          {mode === 'prop' && (
            <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-[11px] text-yellow-400">
              Prop import requires img2threejs port. See imageBuilder.ts for details.
            </div>
          )}
        </div>

        <div className="mt-6 flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-lg border border-white/[0.09] bg-white/[0.02] px-4 py-2 text-[11px] text-white/70 transition hover:bg-white/[0.04]"
            onClick={handleClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="flex-1 rounded-lg bg-[#77e8be]/90 px-4 py-2 text-[11px] font-medium text-[#07100f] transition hover:bg-[#77e8be] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={handleApply}
            disabled={!image || importing || mode === 'prop'}
          >
            {importing ? 'Importing…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
})
