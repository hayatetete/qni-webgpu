import { expect, test, type Page } from '@playwright/test'
import { waitForStartupReady, waitForValue } from './support/web-spec-helpers'

type CircuitLibrarySnapshot = {
  entries: Array<{ id: string; name: string; circuit_json: string; updated_at: number }>
  active_id: string
}

type ToolbarDuplicateGeometry = {
  left: number
  right: number
  top: number
  bottom: number
  hovered: boolean
}

const STORAGE_KEY = 'qni.circuit_library.v2'

const snapshot = async (page: Page): Promise<CircuitLibrarySnapshot> => {
  const raw = await page.evaluate(() => {
    const getter = (window as any).__qniCircuitPickerSnapshot
    if (typeof getter !== 'function') throw new Error('__qniCircuitPickerSnapshot hook missing')
    return getter()
  })
  return JSON.parse(raw) as CircuitLibrarySnapshot
}

const duplicateGeometry = async (page: Page): Promise<ToolbarDuplicateGeometry> => {
  const geometry = await waitForValue(
    async () => {
      const raw = await page.evaluate(() => (window as any).__qniToolbarDuplicateGeometryJson)
      return typeof raw === 'string' ? (JSON.parse(raw) as ToolbarDuplicateGeometry) : null
    },
    (value) => value !== null,
    'toolbar Duplicate geometry was not published',
  )
  if (!geometry) throw new Error('toolbar Duplicate geometry missing')
  return geometry
}

const waitForSnapshot = async (
  page: Page,
  predicate: (state: CircuitLibrarySnapshot) => boolean,
  description: string,
): Promise<CircuitLibrarySnapshot> => {
  const state = await waitForValue(
    async () => {
      try {
        return await snapshot(page)
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('__qniCircuitPickerSnapshot hook missing')) {
          throw error
        }
        return null
      }
    },
    (value) => value !== null && predicate(value),
    `timed out waiting for circuit picker snapshot: ${description}`,
  )
  if (!state) throw new Error('circuit picker snapshot missing')
  return state
}

const canvasBox = async (page: Page) => {
  const box = await page.locator('#egui-canvas').boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  return box!
}

const duplicateCenter = async (page: Page) => {
  const rect = await duplicateGeometry(page)
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
}

const clickDuplicate = async (page: Page): Promise<void> => {
  const box = await canvasBox(page)
  const point = await duplicateCenter(page)
  await page.mouse.click(box.x + point.x, box.y + point.y)
}

const storedDocument = async (page: Page): Promise<any> =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), STORAGE_KEY)

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await waitForStartupReady(page, { waitForStateVector: true })
})

test('toolbar Duplicate inserts a copy right after the active circuit and activates it', async ({ page }) => {
  const before = await snapshot(page)
  const activeIndex = before.entries.findIndex((entry) => entry.id === before.active_id)
  if (activeIndex < 0) throw new Error('active circuit missing before duplicate')
  const active = before.entries[activeIndex]
  if (!active) throw new Error('active circuit missing before duplicate')

  await clickDuplicate(page)

  const after = await waitForSnapshot(page, (state) => state.entries.length === before.entries.length + 1, 'duplicate inserted')
  const inserted = after.entries[activeIndex + 1]
  const stored = await storedDocument(page)
  expect({ inserted, activeId: after.active_id, storedActiveId: stored.active_id, storedInserted: stored.entries.find((entry: { id: string }) => entry.id === inserted.id) }).toMatchObject({
    inserted: { name: `${active.name} (copy)`, circuit_json: active.circuit_json },
    activeId: inserted.id,
    storedActiveId: inserted.id,
    storedInserted: { id: inserted.id, name: `${active.name} (copy)`, circuit_json: active.circuit_json, origin: { kind: 'user', locked: false } },
  })
})

test('toolbar Duplicate increments copy suffixes on consecutive clicks', async ({ page }) => {
  let state = await snapshot(page)
  for (const expectedLength of [state.entries.length + 1, state.entries.length + 2, state.entries.length + 3]) {
    await clickDuplicate(page)
    state = await waitForSnapshot(
      page,
      (snapshot) => snapshot.entries.length === expectedLength,
      `duplicate inserted at length ${expectedLength}`,
    )
  }

  const myNames = state.entries.filter((entry) => entry.name.startsWith('Circuit 1')).map((entry) => entry.name)
  expect({ names: myNames, activeId: state.active_id }).toEqual({
    names: ['Circuit 1', 'Circuit 1 (copy)', 'Circuit 1 (copy 2)', 'Circuit 1 (copy 3)'],
    activeId: state.entries.at(-1)?.id,
  })
})

test('toolbar Duplicate active copy stays active after reload', async ({ page }) => {
  await clickDuplicate(page)
  const duplicated = await waitForSnapshot(page, (state) => state.active_id !== 'current', 'duplicate active')
  const duplicatedId = duplicated.active_id

  await page.reload()
  await waitForStartupReady(page)
  const reloaded = await waitForSnapshot(page, (state) => state.active_id === duplicatedId, 'duplicate active after reload')

  expect(reloaded.active_id).toBe(duplicatedId)
})

test('toolbar Duplicate exposes the Duplicate circuit tooltip on hover', async ({ page }) => {
  const box = await canvasBox(page)
  const point = await duplicateCenter(page)
  await page.locator('#egui-canvas').hover({ position: point })
  await page.waitForTimeout(200)

  const tooltip = await waitForValue(
    () => page.evaluate(() => (window as any).__qniToolbarTooltipText),
    (value) => value === 'Duplicate circuit',
    'timed out waiting for Duplicate circuit tooltip',
  )
  const geometry = await duplicateGeometry(page)
  expect({ tooltip, hovered: geometry.hovered }).toEqual({ tooltip: 'Duplicate circuit', hovered: true })
})
