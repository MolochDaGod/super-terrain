import type { CompiledSection, SectionId } from '../core/types'
import type { TerrainModifier } from '../modifiers/types'
import type { GraniteRock } from '../rocks/types'
import { COMPILED_SECTION_CACHE_VERSION } from './CompiledSectionCache'
import {
  createSerializedWorld,
  deserializeWorld,
  type SerializedTerrainWorld,
} from './serialization'

export interface CompiledSectionCacheRecord {
  sectionId: SectionId
  signature: string
  compiled: CompiledSection
}

export interface TerrainStorage {
  load(worldId: string): Promise<TerrainModifier[] | undefined>
  /** Optional for legacy/in-memory adapters; absent means no authored rocks. */
  loadRocks?(worldId: string): Promise<GraniteRock[] | undefined>
  /** Optional for legacy/in-memory adapters; absent disables the mesh cache. */
  loadCompiledSectionKeys?(worldId: string): Promise<SectionId[]>
  loadCompiledSections?(
    worldId: string,
    sectionIds: readonly SectionId[],
  ): Promise<CompiledSectionCacheRecord[]>
  saveCompiledSections?(
    worldId: string,
    records: readonly CompiledSectionCacheRecord[],
  ): Promise<void>
  save(
    worldId: string,
    modifiers: TerrainModifier[],
    rocks?: GraniteRock[],
  ): Promise<void>
  clear(worldId: string): Promise<void>
}

export class IndexedDbTerrainStorage implements TerrainStorage {
  private readonly databaseName: string
  private readonly storeName: string
  private readonly compiledStoreName: string

  constructor(databaseName = 'meshterrain-worlds', storeName = 'terrain-worlds') {
    this.databaseName = databaseName
    this.storeName = storeName
    this.compiledStoreName = `${storeName}-compiled-sections`
  }

  async load(worldId: string): Promise<TerrainModifier[] | undefined> {
    if (typeof indexedDB === 'undefined') return undefined
    const database = await this.open()
    const serialized = await requestResult<StoredTerrainWorld | undefined>(
      database.transaction(this.storeName, 'readonly').objectStore(this.storeName).get(worldId),
    )
    database.close()
    return serialized ? deserializeWorld(serialized).modifiers : undefined
  }

  async loadRocks(worldId: string): Promise<GraniteRock[] | undefined> {
    if (typeof indexedDB === 'undefined') return undefined
    const database = await this.open()
    const serialized = await requestResult<StoredTerrainWorld | undefined>(
      database.transaction(this.storeName, 'readonly').objectStore(this.storeName).get(worldId),
    )
    database.close()
    return serialized ? deserializeWorld(serialized).rocks : undefined
  }

  async loadCompiledSectionKeys(worldId: string): Promise<SectionId[]> {
    if (typeof indexedDB === 'undefined') return []
    const database = await this.open()
    const transaction = database.transaction(
      [this.storeName, this.compiledStoreName],
      'readonly',
    )
    const completion = transactionComplete(transaction)
    const storedVersion = await requestResult<string | undefined>(
      transaction
        .objectStore(this.storeName)
        .get(compiledCacheVersionKey(worldId)),
    )
    if (storedVersion !== COMPILED_SECTION_CACHE_VERSION) {
      await completion
      database.close()
      return []
    }
    const keys = await requestResult<IDBValidKey[]>(
      transaction
        .objectStore(this.compiledStoreName)
        .index('worldId')
        .getAllKeys(worldId),
    )
    await completion
    database.close()
    return keys.flatMap((key) => {
      if (!Array.isArray(key) || typeof key[1] !== 'string') return []
      return [key[1] as SectionId]
    })
  }

  async loadCompiledSections(
    worldId: string,
    sectionIds: readonly SectionId[],
  ): Promise<CompiledSectionCacheRecord[]> {
    if (typeof indexedDB === 'undefined' || sectionIds.length === 0) return []
    const database = await this.open()
    const transaction = database.transaction(this.compiledStoreName, 'readonly')
    const completion = transactionComplete(transaction)
    const store = transaction.objectStore(this.compiledStoreName)
    const stored = await Promise.all(
      sectionIds.map((id) =>
        requestResult<StoredCompiledSection | undefined>(
          store.get([worldId, id]),
        ),
      ),
    )
    await completion
    database.close()
    return stored.flatMap((record) =>
      record
        ? [{
            sectionId: record.sectionId,
            signature: record.signature,
            compiled: record.compiled,
          }]
        : [],
    )
  }

  async saveCompiledSections(
    worldId: string,
    records: readonly CompiledSectionCacheRecord[],
  ): Promise<void> {
    if (typeof indexedDB === 'undefined' || records.length === 0) return
    const database = await this.open()
    const transaction = database.transaction(
      [this.storeName, this.compiledStoreName],
      'readwrite',
    )
    const store = transaction.objectStore(this.compiledStoreName)
    transaction.objectStore(this.storeName).put(
      COMPILED_SECTION_CACHE_VERSION,
      compiledCacheVersionKey(worldId),
    )
    const savedAt = Date.now()
    for (const record of records) {
      store.put({
        worldId,
        sectionId: record.sectionId,
        signature: record.signature,
        compiled: record.compiled,
        savedAt,
      } satisfies StoredCompiledSection)
    }
    await transactionComplete(transaction)
    database.close()
  }

  async save(
    worldId: string,
    modifiers: TerrainModifier[],
    rocks: GraniteRock[] = [],
  ): Promise<void> {
    if (typeof indexedDB === 'undefined') return
    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readwrite')
    transaction.objectStore(this.storeName).put(
      createSerializedWorld(worldId, modifiers, rocks),
      worldId,
    )
    await transactionComplete(transaction)
    database.close()
  }

  async clear(worldId: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return
    const database = await this.open()
    const transaction = database.transaction(
      [this.storeName, this.compiledStoreName],
      'readwrite',
    )
    transaction.objectStore(this.storeName).delete(worldId)
    transaction
      .objectStore(this.storeName)
      .delete(compiledCacheVersionKey(worldId))
    const compiledStore = transaction.objectStore(this.compiledStoreName)
    const cursorRequest = compiledStore.index('worldId').openKeyCursor(worldId)
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) return
      compiledStore.delete(cursor.primaryKey)
      cursor.continue()
    }
    await transactionComplete(transaction)
    database.close()
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 2)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) {
          request.result.createObjectStore(this.storeName)
        }
        if (!request.result.objectStoreNames.contains(this.compiledStoreName)) {
          const store = request.result.createObjectStore(
            this.compiledStoreName,
            { keyPath: ['worldId', 'sectionId'] },
          )
          store.createIndex('worldId', 'worldId')
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
}

interface StoredCompiledSection {
  worldId: string
  sectionId: SectionId
  signature: string
  compiled: CompiledSection
  savedAt: number
}

type StoredTerrainWorld = string | SerializedTerrainWorld

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

function compiledCacheVersionKey(worldId: string): string {
  return `__compiled-cache-version__:${worldId}`
}
