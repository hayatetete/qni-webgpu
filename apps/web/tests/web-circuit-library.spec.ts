import { expect, test, type Page } from '@playwright/test'
import { waitForStartupReady, waitForValue } from './support/web-spec-helpers'

const STORAGE_KEY = 'qni.circuit_library.v2'

test.describe.configure({ mode: 'serial' })

type LibraryDocument = {
  version: number
  active_id: string | null
  entries: Array<{
    id: string
    name: string
    circuit_json: string
    updated_at: number
    locked?: boolean
    origin: { kind: 'sample'; origin_id: string } | { kind: 'user'; locked: boolean }
  }>
}

const libraryList = async (page: Page): Promise<LibraryDocument> => {
  const raw = await page.evaluate(() => {
    const fn = (window as any).__qniCircuitLibraryList
    if (typeof fn !== 'function') {
      throw new Error('__qniCircuitLibraryList hook missing')
    }
    return fn()
  })
  return JSON.parse(raw) as LibraryDocument
}

const librarySave = async (page: Page, name: string, circuitJson: string): Promise<string> =>
  page.evaluate(({ name: n, circuitJson: json }) => {
    const fn = (window as any).__qniCircuitLibrarySave
    if (typeof fn !== 'function') {
      throw new Error('__qniCircuitLibrarySave hook missing')
    }
    return fn(n, json)
  }, { name, circuitJson })

const libraryLoad = async (page: Page, id: string): Promise<string> =>
  page.evaluate((entryId) => {
    const fn = (window as any).__qniCircuitLibraryLoad
    if (typeof fn !== 'function') {
      throw new Error('__qniCircuitLibraryLoad hook missing')
    }
    return fn(entryId)
  }, id)

const libraryRename = async (page: Page, id: string, name: string): Promise<void> =>
  page.evaluate(({ entryId, nextName }) => {
    const fn = (window as any).__qniCircuitLibraryRename
    if (typeof fn !== 'function') {
      throw new Error('__qniCircuitLibraryRename hook missing')
    }
    fn(entryId, nextName)
  }, { entryId: id, nextName: name })

const libraryDelete = async (page: Page, id: string): Promise<void> =>
  page.evaluate((entryId) => {
    const fn = (window as any).__qniCircuitLibraryDelete
    if (typeof fn !== 'function') {
      throw new Error('__qniCircuitLibraryDelete hook missing')
    }
    fn(entryId)
  }, id)

const libraryClear = async (page: Page): Promise<void> =>
  page.evaluate(() => {
    const fn = (window as any).__qniCircuitLibraryClear
    if (typeof fn !== 'function') {
      throw new Error('__qniCircuitLibraryClear hook missing')
    }
    fn()
  })

const waitForEmptyLibrary = async (page: Page): Promise<LibraryDocument> => {
  return await waitForValue(
    () => libraryList(page),
    (document) => document.active_id === null && document.entries.length === 0,
    'localStorage circuit library did not become empty',
  )
}

const clearLibraryUntilEmpty = async (page: Page): Promise<LibraryDocument> => {
  return await waitForValue(
    async () => {
      await libraryClear(page)
      return await libraryList(page)
    },
    (document) => document.active_id === null && document.entries.length === 0,
    'localStorage circuit library cleanup did not settle',
  )
}
const errorMessage = async (operation: () => Promise<unknown>): Promise<string> => {
  try {
    await operation()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('operation unexpectedly succeeded')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await waitForStartupReady(page)
  await clearLibraryUntilEmpty(page)
})

test('localStorage v2 circuit library supports save, list, load, rename, and delete without UI coupling', async ({ page }) => {
  const initial = await waitForEmptyLibrary(page)

  const circuitJson = '{"cols":[["H"],["•","X"]]}'
  const id = await librarySave(page, '  Bell state  ', circuitJson)
  let document = await libraryList(page)
  const savedActiveId = document.active_id
  const saved = document.entries[0]
  const loadedJson = await libraryLoad(page, id)
  const afterLoad = await libraryList(page)

  await libraryRename(page, id, '  Renamed Bell  ')
  document = await libraryList(page)
  const renamed = document.entries[0]

  const qftJson = '{"cols":[["QFT3"]]}'
  const qftId = await librarySave(page, 'QFT span', qftJson)
  document = await libraryList(page)
  const qft = document.entries[0]

  await libraryDelete(page, qftId)
  await libraryDelete(page, id)
  const final = await waitForEmptyLibrary(page)

  expect({
    initial,
    idMatches: /^ckt_\d+_[0-9a-f]{6}$/.test(id),
    savedActiveId,
    saved,
    savedTimestampOk: saved ? saved.updated_at > 0 : false,
    loadedJson,
    activeIdAfterLoad: afterLoad.active_id,
    renamedName: renamed?.name,
    renamedTimestampOk: renamed ? renamed.updated_at > 0 : false,
    qftActiveId: qft ? document.active_id : null,
    qft,
    final,
  }).toEqual({
    initial: { version: 2, active_id: null, entries: [] },
    idMatches: true,
    savedActiveId: id,
    saved: {
      id,
      name: 'Bell state',
      circuit_json: circuitJson,
      updated_at: saved?.updated_at,
      origin: { kind: 'user', locked: false },
    },
    savedTimestampOk: true,
    loadedJson: circuitJson,
    activeIdAfterLoad: id,
    renamedName: 'Renamed Bell',
    renamedTimestampOk: true,
    qftActiveId: qftId,
    qft: {
      id: qftId,
      name: 'QFT span',
      circuit_json: qftJson,
      updated_at: qft?.updated_at,
      origin: { kind: 'user', locked: false },
    },
    final: { version: 2, active_id: null, entries: [] },
  })
})

test('localStorage v2 circuit library rejects invalid names, invalid circuits, and corrupted documents', async ({ page }) => {
  const messages = [
    await errorMessage(() => librarySave(page, '   ', '{"cols":[]}')),
    await errorMessage(() => librarySave(page, 'Bad circuit', '{"bad":[]}')),
    await errorMessage(() => librarySave(page, 'Unknown gate', '{"cols":[["BAD"]]}')),
    await errorMessage(() => librarySave(page, 'Trailing garbage', '{"cols":[]} trailing')),
  ]

  await page.evaluate((key) => localStorage.setItem(key, '{not json'), STORAGE_KEY)
  messages.push(await errorMessage(() => libraryList(page)))

  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ version: 99, active_id: null, entries: [] })), STORAGE_KEY)
  messages.push(await errorMessage(() => libraryList(page)))

  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ version: 2, active_id: null })), STORAGE_KEY)
  messages.push(await errorMessage(() => libraryList(page)))

  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ version: 2, active_id: 'missing', entries: [] })), STORAGE_KEY)
  messages.push(await errorMessage(() => libraryList(page)))

  await page.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify({
      version: 2,
      active_id: null,
      entries: [{ id: 'bad', name: 'Bad', circuit_json: '{"cols":[]}', updated_at: 1 }],
    }))
  }, STORAGE_KEY)
  messages.push(await errorMessage(() => libraryList(page)))

  await page.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify({
      version: 2,
      active_id: null,
      entries: [{ id: 'bad', name: 'Bad', circuit_json: '{"cols":[]}', updated_at: 1, origin: { kind: 'sample', origin_id: 'bad', locked: true } }],
    }))
  }, STORAGE_KEY)
  messages.push(await errorMessage(() => libraryList(page)))

  await page.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify({
      version: 2,
      active_id: null,
      entries: [{ id: 'bad', name: 'Bad', circuit_json: '{"cols":[]}', updated_at: 1, origin: { kind: 'user', locked: false, origin_id: 'bad' } }],
    }))
  }, STORAGE_KEY)
  messages.push(await errorMessage(() => libraryList(page)))

  expect(messages.map((message) => message.replace(/^.*?(circuit|invalid|unsupported|localStorage)/, '$1'))).toEqual([
    'circuit name is empty',
    'invalid circuit json',
    'invalid circuit json',
    'invalid circuit json',
    'circuit library is corrupted',
    'unsupported circuit library version',
    'circuit library is corrupted',
    'circuit library is corrupted',
    'circuit library is corrupted',
    'circuit library is corrupted',
    'circuit library is corrupted',
  ])
})

test('localStorage v2 circuit library reports quota errors without mutating the document', async ({ page }) => {
  await page.evaluate((key) => {
    const originalSetItem = Storage.prototype.setItem
    ;(window as any).__restoreQniStorageSetItem = () => {
      Storage.prototype.setItem = originalSetItem
    }
    Storage.prototype.setItem = function patchedSetItem(name: string, value: string): void {
      if (name === key) {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      }
      originalSetItem.call(this, name, value)
    }
  }, STORAGE_KEY)

  let message: string
  try {
    message = await errorMessage(() => librarySave(page, 'Too large', '{"cols":[]}'))
  } finally {
    await page.evaluate(() => (window as any).__restoreQniStorageSetItem?.())
  }

  expect({
    quotaError: message.includes('localStorage error: QuotaExceededError'),
    document: await waitForEmptyLibrary(page),
  }).toEqual({
    quotaError: true,
    document: { version: 2, active_id: null, entries: [] },
  })
})
