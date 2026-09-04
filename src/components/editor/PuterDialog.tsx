/**
 * Puter authentication and project management UI.
 * 
 * Shows sign-in status, project list, and save/load controls.
 */

import { memo, useState, useEffect, useCallback } from 'react'
import { Cloud, LogIn, LogOut, Save, FolderOpen, Trash2, X } from 'lucide-react'
import {
  signInToPuter,
  signOutFromPuter,
  isPuterSignedIn,
  getPuterUser,
  saveTerrainProjectToPuter,
  loadTerrainProjectFromPuter,
  listTerrainProjects,
  deleteTerrainProject,
  setLastProjectId,
} from '../../lib/puterSdk'
import type { EditorStore } from '../../terrain/editor/EditorStore'
import type { WorldTerrain } from '../../terrain/WorldTerrain'

interface PuterDialogProps {
  terrain: WorldTerrain
  editor: EditorStore
  open: boolean
  onClose: () => void
}

export const PuterDialog = memo(function PuterDialog({
  terrain,
  editor,
  open,
  onClose,
}: PuterDialogProps) {
  const [signedIn, setSignedIn] = useState(false)
  const [user, setUser] = useState<{ username: string } | null>(null)
  const [projects, setProjects] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const [action, setAction] = useState<'save' | 'load'>('save')

  const refreshAuth = useCallback(async () => {
    try {
      const isSignedIn = await isPuterSignedIn()
      setSignedIn(isSignedIn)
      
      if (isSignedIn) {
        const userData = await getPuterUser()
        setUser(userData)
        const projectList = await listTerrainProjects()
        setProjects(projectList)
      } else {
        setUser(null)
        setProjects([])
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to check auth status')
    }
  }, [])

  useEffect(() => {
    if (open) {
      void refreshAuth()
    }
  }, [open, refreshAuth])

  const handleSignIn = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await signInToPuter()
      await refreshAuth()
      editor.patch({ status: 'Signed in to Puter' })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setLoading(false)
    }
  }, [refreshAuth, editor])

  const handleSignOut = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await signOutFromPuter()
      await refreshAuth()
      editor.patch({ status: 'Signed out from Puter' })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign out failed')
    } finally {
      setLoading(false)
    }
  }, [refreshAuth, editor])

  const handleSave = useCallback(async () => {
    if (!projectName.trim()) {
      setError('Project name required')
      return
    }
    
    setLoading(true)
    setError(null)
    
    try {
      // Serialize current world state
      const worldData = {
        config: terrain.config,
        modifiers: terrain.modifiers.snapshot(),
        rocks: terrain.rocks.snapshot(),
        water: terrain.water.serialize(),
        lights: editor.getSnapshot().lights,
        savedAt: new Date().toISOString(),
      }
      
      await saveTerrainProjectToPuter(projectName.trim(), worldData)
      await setLastProjectId(projectName.trim())
      await refreshAuth()
      editor.patch({ status: `Project "${projectName.trim()}" saved to Puter` })
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setLoading(false)
    }
  }, [projectName, terrain, editor, refreshAuth, onClose])

  const handleLoad = useCallback(async (name: string) => {
    setLoading(true)
    setError(null)
    
    try {
      const data = await loadTerrainProjectFromPuter(name)
      await setLastProjectId(name)
      editor.patch({ status: `Project "${name}" loaded from Puter (reload world to apply)` })
      // TODO: Apply loaded data to terrain (requires world reload)
      console.log('Loaded project data:', data)
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Load failed')
    } finally {
      setLoading(false)
    }
  }, [editor, onClose])

  const handleDelete = useCallback(async (name: string) => {
    if (!confirm(`Delete project "${name}"?`)) return
    
    setLoading(true)
    setError(null)
    
    try {
      await deleteTerrainProject(name)
      await refreshAuth()
      editor.patch({ status: `Project "${name}" deleted` })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setLoading(false)
    }
  }, [refreshAuth, editor])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="relative max-w-md rounded-2xl border border-white/[0.09] bg-[#0b1312]/95 p-6 shadow-2xl">
        <button
          type="button"
          className="absolute right-3 top-3 grid size-6 place-items-center text-white/40 transition hover:text-white/80"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={14} />
        </button>

        <div className="flex items-center gap-2">
          <Cloud size={16} className="text-[#77e8be]" />
          <h2 className="text-base font-semibold text-white/85">
            Puter Cloud Storage
          </h2>
        </div>
        <p className="mt-1 text-[11px] text-white/42">
          Save and load terrain projects to your Puter account
        </p>

        <div className="mt-4 space-y-3">
          {!signedIn ? (
            <div className="space-y-2">
              <p className="text-[11px] text-white/60">
                Sign in to access cloud storage
              </p>
              <button
                type="button"
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#77e8be]/90 px-4 py-2 text-[11px] font-medium text-[#07100f] transition hover:bg-[#77e8be] disabled:cursor-not-allowed disabled:opacity-40"
                onClick={handleSignIn}
                disabled={loading}
              >
                <LogIn size={14} />
                Sign in to Puter
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-white/[0.09] bg-white/[0.02] px-3 py-2">
                <div className="text-[11px]">
                  <p className="text-white/80">Signed in as</p>
                  <p className="font-medium text-[#77e8be]">{user?.username}</p>
                </div>
                <button
                  type="button"
                  className="rounded-lg border border-white/[0.09] px-3 py-1.5 text-[10px] text-white/60 transition hover:bg-white/[0.04]"
                  onClick={handleSignOut}
                  disabled={loading}
                >
                  <LogOut size={12} className="inline" /> Sign out
                </button>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  data-active={action === 'save'}
                  className="flex-1 rounded-lg border border-white/[0.09] bg-white/[0.02] px-3 py-2 text-[11px] transition data-[active=true]:border-[#77e8be]/40 data-[active=true]:bg-[#77e8be]/10 data-[active=true]:text-[#a6f2d5]"
                  onClick={() => setAction('save')}
                >
                  <Save size={14} className="mx-auto mb-1" />
                  Save Project
                </button>
                <button
                  type="button"
                  data-active={action === 'load'}
                  className="flex-1 rounded-lg border border-white/[0.09] bg-white/[0.02] px-3 py-2 text-[11px] transition data-[active=true]:border-[#77e8be]/40 data-[active=true]:bg-[#77e8be]/10 data-[active=true]:text-[#a6f2d5]"
                  onClick={() => setAction('load')}
                >
                  <FolderOpen size={14} className="mx-auto mb-1" />
                  Load Project
                </button>
              </div>

              {action === 'save' && (
                <div className="space-y-2">
                  <input
                    type="text"
                    placeholder="Project name"
                    className="w-full rounded-lg border border-white/[0.09] bg-white/[0.02] px-3 py-2 text-[11px] text-white/85 placeholder:text-white/30"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                  />
                  <button
                    type="button"
                    className="w-full rounded-lg bg-[#77e8be]/90 px-4 py-2 text-[11px] font-medium text-[#07100f] transition hover:bg-[#77e8be] disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={handleSave}
                    disabled={loading || !projectName.trim()}
                  >
                    Save to Puter
                  </button>
                </div>
              )}

              {action === 'load' && (
                <div className="space-y-2">
                  {projects.length === 0 ? (
                    <p className="text-center text-[11px] text-white/40">
                      No saved projects
                    </p>
                  ) : (
                    <div className="max-h-48 space-y-1 overflow-y-auto">
                      {projects.map((name) => (
                        <div
                          key={name}
                          className="flex items-center justify-between rounded-lg border border-white/[0.09] bg-white/[0.02] px-3 py-2"
                        >
                          <button
                            type="button"
                            className="flex-1 text-left text-[11px] text-white/80 hover:text-white/100"
                            onClick={() => handleLoad(name)}
                            disabled={loading}
                          >
                            {name}
                          </button>
                          <button
                            type="button"
                            className="ml-2 text-white/40 hover:text-red-400"
                            onClick={() => handleDelete(name)}
                            disabled={loading}
                            aria-label="Delete"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
              {error}
            </div>
          )}
        </div>

        <div className="mt-4 text-[10px] text-white/30">
          Admin seats: grudachain / molochdadev
        </div>
      </div>
    </div>
  )
})
