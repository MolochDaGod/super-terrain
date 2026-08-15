import type { TerrainModifier } from '../modifiers/types'
import { deserializeWorld, serializeWorld } from './serialization'

export interface TerrainStorage {
  load(worldId: string): Promise<TerrainModifier[] | undefined>
  save(worldId: string, modifiers: TerrainModifier[]): Promise<void>
  clear(worldId: string): Promise<void>
}

export class IndexedDbTerrainStorage implements TerrainStorage {
  private readonly databaseName: string
  private readonly storeName: string

  constructor(databaseName = 'meshterrain-worlds', storeName = 'terrain-worlds') {
    this.databaseName = databaseName
    this.storeName = storeName
  }

  async load(worldId: string): Promise<TerrainModifier[] | undefined> {
    if (typeof indexedDB === 'undefined') return undefined
    const database = await this.open()
    const serialized = await requestResult<string | undefined>(
      database.transaction(this.storeName, 'readonly').objectStore(this.storeName).get(worldId),
    )
    database.close()
    return serialized ? deserializeWorld(serialized).modifiers : undefined
  }

  async save(worldId: string, modifiers: TerrainModifier[]): Promise<void> {
    if (typeof indexedDB === 'undefined') return
    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readwrite')
    transaction.objectStore(this.storeName).put(serializeWorld(worldId, modifiers), worldId)
    await transactionComplete(transaction)
    database.close()
  }

  async clear(worldId: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return
    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readwrite')
    transaction.objectStore(this.storeName).delete(worldId)
    await transactionComplete(transaction)
    database.close()
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) {
          request.result.createObjectStore(this.storeName)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
