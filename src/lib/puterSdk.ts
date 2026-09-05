/**
 * Puter.js SDK integration for cloud storage of terrain projects.
 * 
 * Loads SDK from https://js.puter.com/v2/ following the same pattern as
 * Grudge-Studio-Forge artifacts/game-forge/src/lib/puterSdk.ts.
 * 
 * Storage structure: /GRUDACHAIN/projects/super-terrain/<mapId>/
 * - world.json: serialized terrain state
 * - metadata.json: project metadata (name, created, modified)
 * 
 * Puter is IDE/FS only. Island state stays Railway when this lab wires to fleet.
 * Guest sessions use IndexedDB. Admin seats: grudachain / molochdadev.
 */

interface PuterFileSystem {
  read(path: string): Promise<Blob>
  write(path: string, content: Blob | ArrayBuffer): Promise<void>
  list(path: string): Promise<{ name: string; is_dir: boolean }[]>
  delete(path: string): Promise<void>
  mkdir(path: string): Promise<void>
}

interface PuterKV {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  del(key: string): Promise<void>
}

interface PuterAuth {
  signIn(): Promise<void>
  signOut(): Promise<void>
  isSignedIn(): boolean
  getUser(): { username: string } | null
}

interface Puter {
  fs: PuterFileSystem
  kv: PuterKV
  auth: PuterAuth
}

declare global {
  interface Window {
    puter?: Puter
  }
}

let puterLoadPromise: Promise<Puter> | null = null

/**
 * Load and initialize Puter SDK from js.puter.com/v2/.
 * Returns cached instance on subsequent calls.
 */
export async function loadPuterSdk(): Promise<Puter> {
  if (window.puter) return window.puter

  if (puterLoadPromise) return puterLoadPromise

  puterLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://js.puter.com/v2/'
    script.async = true
    script.onload = () => {
      if (window.puter) {
        resolve(window.puter)
      } else {
        reject(new Error('Puter SDK loaded but window.puter not found'))
      }
    }
    script.onerror = () => {
      reject(new Error('Failed to load Puter SDK from js.puter.com/v2/'))
    }
    document.head.appendChild(script)
  })

  return puterLoadPromise
}

/**
 * Sign in to Puter. Opens authentication flow.
 */
export async function signInToPuter(): Promise<void> {
  const puter = await loadPuterSdk()
  await puter.auth.signIn()
}

/**
 * Sign out from Puter.
 */
export async function signOutFromPuter(): Promise<void> {
  const puter = await loadPuterSdk()
  await puter.auth.signOut()
}

/**
 * Check if user is signed in to Puter.
 */
export async function isPuterSignedIn(): Promise<boolean> {
  try {
    const puter = await loadPuterSdk()
    return puter.auth.isSignedIn()
  } catch {
    return false
  }
}

/**
 * Get current Puter user info.
 */
export async function getPuterUser(): Promise<{ username: string } | null> {
  try {
    const puter = await loadPuterSdk()
    return puter.auth.getUser()
  } catch {
    return null
  }
}

/**
 * Save terrain project to Puter filesystem under /GRUDACHAIN/projects/super-terrain/<mapId>/
 * Creates directory structure on first save.
 */
export async function saveTerrainProjectToPuter(
  name: string,
  data: unknown,
  mapId?: string,
): Promise<string> {
  const puter = await loadPuterSdk()
  if (!puter.auth.isSignedIn()) {
    throw new Error('Must be signed in to Puter to save projects')
  }

  // Ensure base directory exists
  await ensureProjectDirectory(puter)

  // Generate new mapId if not provided
  const projectMapId = mapId ?? generateMapId()
  const projectDir = `/GRUDACHAIN/projects/super-terrain/${projectMapId}`

  // Create project directory
  try {
    await puter.fs.mkdir(projectDir)
  } catch {
    // Directory might already exist for update
  }

  // Save world data
  const worldBlob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  await puter.fs.write(`${projectDir}/world.json`, worldBlob)

  // Save metadata
  const metadata = {
    name,
    mapId: projectMapId,
    savedAt: new Date().toISOString(),
  }
  const metadataBlob = new Blob([JSON.stringify(metadata, null, 2)], {
    type: 'application/json',
  })
  await puter.fs.write(`${projectDir}/metadata.json`, metadataBlob)

  return projectMapId
}

/**
 * Load terrain project from Puter filesystem.
 */
export async function loadTerrainProjectFromPuter(mapId: string): Promise<unknown> {
  const puter = await loadPuterSdk()
  if (!puter.auth.isSignedIn()) {
    throw new Error('Must be signed in to Puter to load projects')
  }

  const projectDir = `/GRUDACHAIN/projects/super-terrain/${mapId}`
  const blob = await puter.fs.read(`${projectDir}/world.json`)
  const text = await blob.text()
  return JSON.parse(text)
}

/**
 * List all terrain projects in Puter filesystem.
 * Returns array of project metadata.
 */
export async function listTerrainProjects(): Promise<
  Array<{ mapId: string; name: string; savedAt?: string }>
> {
  const puter = await loadPuterSdk()
  if (!puter.auth.isSignedIn()) {
    return []
  }

  try {
    await ensureProjectDirectory(puter)
    const items = await puter.fs.list('/GRUDACHAIN/projects/super-terrain')
    const projects: Array<{ mapId: string; name: string; savedAt?: string }> = []

    for (const item of items) {
      if (item.is_dir) {
        try {
          const metadataBlob = await puter.fs.read(
            `/GRUDACHAIN/projects/super-terrain/${item.name}/metadata.json`,
          )
          const metadataText = await metadataBlob.text()
          const metadata = JSON.parse(metadataText) as {
            name: string
            mapId: string
            savedAt?: string
          }
          projects.push({
            mapId: item.name,
            name: metadata.name,
            savedAt: metadata.savedAt,
          })
        } catch {
          // Skip projects with missing/invalid metadata
        }
      }
    }

    return projects
  } catch {
    // Directory doesn't exist yet
    return []
  }
}

/**
 * Delete terrain project from Puter filesystem.
 */
export async function deleteTerrainProject(mapId: string): Promise<void> {
  const puter = await loadPuterSdk()
  if (!puter.auth.isSignedIn()) {
    throw new Error('Must be signed in to Puter to delete projects')
  }

  const projectDir = `/GRUDACHAIN/projects/super-terrain/${mapId}`
  
  // Delete files first
  try {
    await puter.fs.delete(`${projectDir}/world.json`)
  } catch {
    // File might not exist
  }
  try {
    await puter.fs.delete(`${projectDir}/metadata.json`)
  } catch {
    // File might not exist
  }
  
  // Delete directory
  await puter.fs.delete(projectDir)
}

/**
 * Save last opened project ID to puter.kv for quick access.
 */
export async function setLastProjectId(id: string): Promise<void> {
  try {
    const puter = await loadPuterSdk()
    if (puter.auth.isSignedIn()) {
      await puter.kv.set('last_project_id', id)
    }
  } catch {
    // KV is optional, don't fail if it doesn't work
  }
}

/**
 * Get last opened project ID from puter.kv.
 */
export async function getLastProjectId(): Promise<string | null> {
  try {
    const puter = await loadPuterSdk()
    if (puter.auth.isSignedIn()) {
      return await puter.kv.get('last_project_id')
    }
  } catch {
    // KV is optional
  }
  return null
}

/**
 * Generate a unique map ID for a new project.
 */
function generateMapId(): string {
  return `map_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Ensure Puter directory structure exists: /GRUDACHAIN/projects/super-terrain/
 */
async function ensureProjectDirectory(puter: Puter): Promise<void> {
  try {
    // Try to list the directory - if it fails, create the structure
    await puter.fs.list('/GRUDACHAIN/projects/super-terrain')
  } catch {
    // Create directory structure
    try {
      await puter.fs.mkdir('/GRUDACHAIN')
    } catch {
      // Directory might already exist
    }
    try {
      await puter.fs.mkdir('/GRUDACHAIN/projects')
    } catch {
      // Directory might already exist
    }
    try {
      await puter.fs.mkdir('/GRUDACHAIN/projects/super-terrain')
    } catch {
      // Directory might already exist
    }
  }
}
