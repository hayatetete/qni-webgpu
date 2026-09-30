import { expect, test, type Page } from '@playwright/test'
import {
  pixelRgbDistance,
  sampleCanvasPixels,
  waitForStartupReady,
  pollForValue,
  waitForValue,
  type CanvasPixel,
} from './support/web-spec-helpers'

type Point = { x: number; y: number }
type ResizeGeometry = {
  items_top: number
  items_bottom: number
  handle_left: number
  handle_right: number
  footer_top: number
  footer_bottom: number
  first_row_top: number
  scroll_offset_y: number
  item_dragging: boolean
}
type CircuitLibrarySnapshot = {
  entries: Array<{ id: string; name: string; circuit_json: string; updated_at: number }>
  active_id: string
}

const TRIGGER: Point = { x: 40, y: 22 }
const EMPTY_JSON = '{"cols":[]}'
const ITEMS_CONTENT_PADDING_Y = 6
const SECTION_HEADER_HEIGHT = 26
const SECTION_HEADER_TOP_MARGIN = 6
const ITEM_HEIGHT = 36
const FLEXOKI_UI: CanvasPixel = [230, 228, 217, 255]
const mySectionScrollOffset = (sampleCount: number): number =>
  ITEMS_CONTENT_PADDING_Y + SECTION_HEADER_HEIGHT + sampleCount * ITEM_HEIGHT + SECTION_HEADER_TOP_MARGIN
const mySectionDividerLineOffset = (sampleCount: number): number =>
  mySectionScrollOffset(sampleCount) + SECTION_HEADER_HEIGHT / 2
const exampleMaxScrollOffset = (geometry: ResizeGeometry, sampleCount: number): number =>
  Math.max(0, mySectionDividerLineOffset(sampleCount) - (geometry.items_bottom - geometry.items_top))
const mySectionDividerScreenY = (geometry: ResizeGeometry, sampleCount: number): number =>
  geometry.items_top + mySectionDividerLineOffset(sampleCount) - geometry.scroll_offset_y

test.describe.configure({ mode: 'serial' })

const waitForCondition = async (
  page: Page,
  predicate: () => Promise<boolean>,
  description: string,
  attempts = 100,
): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return
    await page.waitForTimeout(50)
  }
  throw new Error(`timed out waiting for ${description}`)
}

const canvasBox = async (page: Page) => {
  const box = await page.locator('#egui-canvas').boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  return box
}

const clickCanvas = async (page: Page, point: Point): Promise<void> => {
  const box = await canvasBox(page)
  await page.mouse.click(box.x + point.x, box.y + point.y)
}

const seedCircuits = async (page: Page, count: number): Promise<void> => {
  await waitForCondition(page, async () => page.evaluate(() => typeof (window as any).__seedCircuits === 'function'), 'seed hook')
  const entries = Array.from({ length: count }, (_, index) => ({
    id: `circuit-${index + 1}`,
    name: `Circuit ${index + 1}`,
    circuit_json: EMPTY_JSON,
    updated_at: index + 1,
  }))
  await page.evaluate((payload) => {
    const seed = (window as any).__seedCircuits
    seed(JSON.stringify({ entries: payload, active_id: 'circuit-1' }))
  }, entries)
}

const seedExampleAndUserCircuits = async (page: Page, sampleCount: number, userCount: number): Promise<void> => {
  await waitForCondition(page, async () => page.evaluate(() => typeof (window as any).__seedCircuits === 'function'), 'seed hook')
  const samples = Array.from({ length: sampleCount }, (_, index) => ({
    id: `sample-${index + 1}`,
    name: `Sample ${index + 1}`,
    circuit_json: EMPTY_JSON,
    updated_at: index + 1,
    origin: { kind: 'sample', origin_id: `sample-${index + 1}` },
  }))
  const users = Array.from({ length: userCount }, (_, index) => ({
    id: `circuit-${index + 1}`,
    name: `Circuit ${index + 1}`,
    circuit_json: EMPTY_JSON,
    updated_at: sampleCount + index + 1,
    origin: { kind: 'user', locked: false },
  }))
  await page.evaluate((payload) => {
    const seed = (window as any).__seedCircuits
    seed(JSON.stringify({ entries: payload, active_id: 'circuit-1' }))
  }, [...samples, ...users])
}

const resizeGeometry = async (page: Page): Promise<ResizeGeometry | null> =>
  page.evaluate(() => {
    const raw = (window as any).__qniCircuitPickerResizeGeometryJson
    return typeof raw === 'string' ? JSON.parse(raw) as ResizeGeometry : null
  })

const waitForResizeGeometry = async (
  page: Page,
  predicate: (geometry: ResizeGeometry) => boolean = () => true,
  description = 'picker resize geometry',
): Promise<ResizeGeometry> => {
  const geometry = await waitForValue(
    () => resizeGeometry(page),
    (value) => value !== null && predicate(value),
    `timed out waiting for ${description}`,
  )
  if (!geometry) throw new Error('picker resize geometry missing')
  return geometry
}

const snapshot = async (page: Page): Promise<CircuitLibrarySnapshot> => {
  const raw = await page.evaluate(() => {
    const getter = (window as any).__qniCircuitPickerSnapshot
    if (typeof getter !== 'function') throw new Error('__qniCircuitPickerSnapshot hook missing')
    return getter()
  })
  return JSON.parse(raw) as CircuitLibrarySnapshot
}

const entryIds = async (page: Page): Promise<string[]> => (await snapshot(page)).entries.map((entry) => entry.id)

const openPicker = async (page: Page, count = 16): Promise<ResizeGeometry> => {
  await page.goto('/')
  await waitForStartupReady(page, { waitForStateVector: true })
  await seedCircuits(page, count)
  await clickCanvas(page, TRIGGER)
  return waitForResizeGeometry(page)
}

const openPickerWithExample = async (page: Page, userCount = 16): Promise<ResizeGeometry> => {
  await page.goto('/')
  await waitForStartupReady(page, { waitForStateVector: true })
  await seedExampleAndUserCircuits(page, 1, userCount)
  await clickCanvas(page, TRIGGER)
  return waitForResizeGeometry(page)
}

const openPickerWithExamples = async (page: Page, sampleCount = 8, userCount = 18): Promise<ResizeGeometry> => {
  await page.goto('/')
  await waitForStartupReady(page, { waitForStateVector: true })
  await seedExampleAndUserCircuits(page, sampleCount, userCount)
  await clickCanvas(page, TRIGGER)
  return waitForResizeGeometry(page)
}

const wheelCanvas = async (page: Page, point: Point, deltaY: number): Promise<void> => {
  const box = await canvasBox(page)
  await page.mouse.move(box.x + point.x, box.y + point.y)
  await page.mouse.wheel(0, deltaY)
}

const itemsCenter = (geometry: ResizeGeometry): Point => ({
  x: (geometry.handle_left + geometry.handle_right) / 2,
  y: (geometry.items_top + geometry.items_bottom) / 2,
})

const visibleDragStart = (geometry: ResizeGeometry): Point => ({
  x: geometry.handle_left + 64,
  y: geometry.items_top + 72,
})

const firstRowDragStart = (geometry: ResizeGeometry): Point => ({
  x: geometry.handle_left + 64,
  y: geometry.first_row_top + 18,
})

const firstMyRowDragStart = (geometry: ResizeGeometry, sampleCount: number): Point => ({
  x: geometry.handle_left + 64,
  y:
    geometry.items_top
    + mySectionScrollOffset(sampleCount)
    + SECTION_HEADER_HEIGHT
    + ITEM_HEIGHT / 2
    - geometry.scroll_offset_y,
})

const footerPlusSample = (geometry: ResizeGeometry): Point => ({
  x: geometry.handle_left + 16,
  y: (geometry.footer_top + geometry.footer_bottom) / 2 - 1,
})

const lockedRowIconSample = (geometry: ResizeGeometry): Point => ({
  x: geometry.handle_left + 16,
  y: geometry.first_row_top + 24,
})

// 押下と小さな移動が同じフレームに入ると、ドラッグ開始のしきい値判定が成立せず
// 取りこぼすことがある (CPU が飽和すると顕著)。開始を状態で確かめ、始まって
// いなければ離してやり直す。`web-picker-resize.spec.ts` の separator ドラッグと
// 同じ形。
const beginItemDrag = async (page: Page, point: Point): Promise<void> => {
  const box = await canvasBox(page)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.mouse.move(box.x + point.x, box.y + point.y)
    await page.mouse.down()
    await page.mouse.move(box.x + point.x, box.y + point.y + 8, { steps: 3 })
    const started = await pollForValue(
      () => resizeGeometry(page),
      (geometry) => geometry !== null && geometry.item_dragging,
      { timeout: 2_000 },
    )
    if (started?.item_dragging) return
    await page.mouse.up()
  }
  throw new Error('timed out waiting for item drag to start')
}

const moveHeldPointer = async (page: Page, point: Point): Promise<void> => {
  const box = await canvasBox(page)
  await page.mouse.move(box.x + point.x, box.y + point.y, { steps: 8 })
}

test('drag-to-reorder top edge auto-scroll decreases the items pane offset', async ({ page }) => {
  const opened = await openPicker(page, 18)
  await wheelCanvas(page, itemsCenter(opened), 360)
  const before = await waitForResizeGeometry(page, (geometry) => geometry.scroll_offset_y > 80, 'pre-scrolled items pane')
  await beginItemDrag(page, visibleDragStart(before))
  await moveHeldPointer(page, { x: before.handle_left + 64, y: before.items_top + 8 })
  await page.waitForTimeout(700)
  const after = await waitForResizeGeometry(page, (geometry) => geometry.scroll_offset_y < before.scroll_offset_y - 20, 'top edge auto-scroll')
  await page.mouse.up()

  expect(after.scroll_offset_y < before.scroll_offset_y).toBe(true)
})

test('drag-to-reorder top edge auto-scroll stops at the My Circuits divider', async ({ page }) => {
  const opened = await openPickerWithExample(page, 18)
  await wheelCanvas(page, itemsCenter(opened), 360)
  const before = await waitForResizeGeometry(page, (geometry) => geometry.scroll_offset_y > mySectionScrollOffset(1) + 80, 'pre-scrolled My pane')
  await beginItemDrag(page, visibleDragStart(before))
  await moveHeldPointer(page, { x: before.handle_left + 64, y: before.items_top + 8 })
  await waitForResizeGeometry(
    page,
    (geometry) => Math.abs(geometry.scroll_offset_y - mySectionScrollOffset(1)) <= 1,
    'top edge auto-scroll reaches the My divider',
  )
  await page.waitForTimeout(300)
  const after = await waitForResizeGeometry(page)
  await page.mouse.up()

  expect(Math.abs(after.scroll_offset_y - mySectionScrollOffset(1)) <= 1).toBe(true)
})

test('drag-to-reorder bottom edge auto-scroll increases the items pane offset', async ({ page }) => {
  const before = await openPicker(page, 18)
  await beginItemDrag(page, firstRowDragStart(before))
  await moveHeldPointer(page, { x: before.handle_left + 64, y: before.items_bottom - 8 })
  await page.waitForTimeout(700)
  const after = await waitForResizeGeometry(page, (geometry) => geometry.scroll_offset_y > before.scroll_offset_y + 20, 'bottom edge auto-scroll')
  await page.mouse.up()

  expect(after.scroll_offset_y > before.scroll_offset_y).toBe(true)
})

test('example drag-to-reorder bottom edge auto-scroll stops at the My Circuits divider', async ({ page }) => {
  const before = await openPickerWithExamples(page)
  await beginItemDrag(page, firstRowDragStart(before))
  await moveHeldPointer(page, { x: before.handle_left + 64, y: before.items_bottom - 8 })
  await waitForResizeGeometry(
    page,
    (geometry) => Math.abs(geometry.scroll_offset_y - exampleMaxScrollOffset(before, 8)) <= 1,
    'bottom edge auto-scroll reaches the My divider',
  )
  await page.waitForTimeout(300)
  const after = await waitForResizeGeometry(page)
  await page.mouse.up()

  expect(Math.abs(after.scroll_offset_y - exampleMaxScrollOffset(before, 8)) <= 1).toBe(true)
})

test('example dragged row stays above the My Circuits divider', async ({ page }) => {
  const before = await openPickerWithExamples(page, 3, 3)
  const dividerY = mySectionDividerScreenY(before, 3)
  await beginItemDrag(page, firstRowDragStart(before))
  await moveHeldPointer(page, { x: before.handle_left + 64, y: dividerY + 40 })
  await page.waitForTimeout(200)
  const pixels = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
    { name: 'below-divider', x: before.handle_left + 160, y: dividerY + 30 },
  ])
  await page.mouse.up()

  expect(pixelRgbDistance(pixels['below-divider'], FLEXOKI_UI) > 45).toBe(true)
})

test('my dragged row stays below the My Circuits divider', async ({ page }) => {
  const before = await openPickerWithExamples(page, 3, 3)
  const dividerY = mySectionDividerScreenY(before, 3)
  await beginItemDrag(page, firstMyRowDragStart(before, 3))
  await moveHeldPointer(page, { x: before.handle_left + 64, y: dividerY - 40 })
  await page.waitForTimeout(200)
  const pixels = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
    { name: 'above-divider', x: before.handle_left + 160, y: dividerY - 40 },
  ])
  await page.mouse.up()

  expect(pixelRgbDistance(pixels['above-divider'], FLEXOKI_UI) > 45).toBe(true)
})

test('picker locked row icon matches the footer plus color', async ({ page }) => {
  const geometry = await openPickerWithExamples(page, 1, 1)
  const pixels = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
    { name: 'lock-icon', ...lockedRowIconSample(geometry) },
    { name: 'footer-plus', ...footerPlusSample(geometry) },
  ])

  expect(pixelRgbDistance(pixels['lock-icon'], pixels['footer-plus'])).toBeLessThan(35)
})

test('drag-to-reorder commits an auto-scrolled slot on mouseup', async ({ page }) => {
  const before = await openPicker(page, 12)
  await beginItemDrag(page, firstRowDragStart(before))
  await moveHeldPointer(page, { x: before.handle_left + 64, y: before.items_bottom - 8 })
  await waitForCondition(
    page,
    async () => ((await resizeGeometry(page))?.scroll_offset_y ?? 0) > 20,
    'bottom auto-scroll moves the items pane',
    200,
  )
  await page.mouse.up()
  await waitForCondition(page, async () => (await entryIds(page))[0] !== 'circuit-1', 'auto-scrolled reorder commit')

  expect((await entryIds(page))[0]).not.toBe('circuit-1')
})
