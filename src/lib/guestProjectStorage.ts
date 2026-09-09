/**
 * Guest project storage via IndexedDB.
 * 
 * Fallback for Puter cloud storage when user is not signed in.
 * Stores project snapshots locally in the browser.
 */

const DB_NAME = 'grudge-terrain-guest-projects'
const STORE_NAME = 'projects'
const DB_VERSION = 1

interface ProjectRecord {
  mapId: string
  name: string
  worldData: unknown
  savedAt: string
}

/**
 * Open or create the IndexedDB database.
 */
async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'mapId' })
      }
    }
  })
}

/**
 * Save a project to guest IndexedDB.
 * Returns the mapId (generated if not provided).
 */
export async function saveGuestProject(
  name: string,
  worldData: unknown,
  mapId?: string,
): Promise<string> {
  const db = await openDatabase()
  const projectMapId = mapId ?? `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

  const record: ProjectRecord = {
    mapId: projectMapId,
    name,
    worldData,
    savedAt: new Date().toISOString(),
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.put(record)

    request.onsuccess = () => {
      db.close()
      resolve(projectMapId)
    }
    request.onerror = () => {
      db.close()
      reject(request.error)
    }
  })
}

/**
 * Load a project from guest IndexedDB.
 */
export async function loadGuestProject(mapId: string): Promise<unknown> {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.get(mapId)

    request.onsuccess = () => {
      db.close()
      const record = request.result as ProjectRecord | undefined
      if (record) {
        resolve(record.worldData)
      } else {
        reject(new Error('Project not found'))
      }
    }
    request.onerror = () => {
      db.close()
      reject(request.error)
    }
  })
}

/**
 * List all guest projects.
 */
export async function listGuestProjects(): Promise<
  Array<{ mapId: string; name: string; savedAt: string }>
> {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.getAll()

    request.onsuccess = () => {
      db.close()
      const records = request.result as ProjectRecord[]
      resolve(
        records.map((r) => ({
          mapId: r.mapId,
          name: r.name,
          savedAt: r.savedAt,
        })),
      )
    }
    request.onerror = () => {
      db.close()
      reject(request.error)
    }
  })
}

/**
 * Delete a guest project.
 */
export async function deleteGuestProject(mapId: string): Promise<void> {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.delete(mapId)

    request.onsuccess = () => {
      db.close()
      resolve()
    }
    request.onerror = () => {
      db.close()
      reject(request.error)
    }
  })
}
