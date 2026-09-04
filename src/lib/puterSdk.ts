/**
 * Puter.js SDK integration for cloud storage of terrain projects.
 * 
 * Loads SDK from https://js.puter.com/v2/ following the same pattern as
 * Grudge-Studio-Forge artifacts/game-forge/src/lib/puterSdk.ts.
 * 
 * Puter is IDE/FS only. Island state stays Railway when this lab wires to fleet.
 * Guest sessions use IndexedDB. Admin seats: grudachain / molochdadev.
 */

interface PuterFileSystem {
  read(path: string): Promise<Blob>
  write(path: string, content: Blob | ArrayBuffer): Promise<void>
  list(path: string): Promise<{ name: string; is_dir: boolean }[]>
  delete(path: string): Promise<void>
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
 * Save terrain project blob to Puter filesystem under /terrain-projects/{name}.json
 */
export async function saveTerrainProjectToPuter(
  name: string,
  data: unknown,
): Promise<void> {
  const puter = await loadPuterSdk()
  if (!puter.auth.isSignedIn()) {
    throw new Error('Must be signed in to Puter to save projects')
  }

  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const path = `/terrain-projects/${name}.json`
  await puter.fs.write(path, blob)
}

/**
 * Load terrain project from Puter filesystem.
 */
export async function loadTerrainProjectFromPuter(name: string): Promise<unknown> {
  const puter = await loadPuterSdk()
  if (!puter.auth.isSignedIn()) {
    throw new Error('Must be signed in to Puter to load projects')
  }

  const path = `/terrain-projects/${name}.json`
  const blob = await puter.fs.read(path)
  const text = await blob.text()
  return JSON.parse(text)
}

/**
 * List all terrain projects in Puter filesystem.
 */
export async function listTerrainProjects(): Promise<string[]> {
  const puter = await loadPuterSdk()
  if (!puter.auth.isSignedIn()) {
    return []
  }

  try {
    const items = await puter.fs.list('/terrain-projects')
    return items
      .filter((item) => !item.is_dir && item.name.endsWith('.json'))
      .map((item) => item.name.replace(/\.json$/, ''))
  } catch {
    // Directory doesn't exist yet
    return []
  }
}

/**
 * Delete terrain project from Puter filesystem.
 */
export async function deleteTerrainProject(name: string): Promise<void> {
  const puter = await loadPuterSdk()
  if (!puter.auth.isSignedIn()) {
    throw new Error('Must be signed in to Puter to delete projects')
  }

  const path = `/terrain-projects/${name}.json`
  await puter.fs.delete(path)
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
