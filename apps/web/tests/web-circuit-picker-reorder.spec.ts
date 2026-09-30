import { expect, test, type Page } from '@playwright/test'
import {
  pixelRgbDistance,
  sampleCanvasPixels,
  waitForStartupReady,
  pollForValue,
  waitForValue,
  type CanvasPixel,
} from './support/web-spec-helpers'

type CircuitLibrarySnapshot = {
  entries: Array<{ id: string; name: string; circuit_json: string; updated_at: number }>
  active_id: string
}

type Point = { x: number; y: number }
type HoverSnapshot = { hoveredGateId: number | null; hoveredPaletteIndex: number | null }
type PickerDropdownGeometry = {
  trigger_top: number
  trigger_bottom: number
  topbar_bottom: number
  dropdown_top: number
  dropdown_bottom: number
}
type SubmenuGeometry = {
  index: number
  parent_row_top: number
  kebab_left: number
  kebab_right: number
  submenu_left: number
  submenu_right: number
  submenu_top: number
}

const ONE_JSON = '{"cols":[["H"]]}'
const TWO_JSON = '{"cols":[["X"]]}'
const THREE_JSON = '{"cols":[["QFT4"]]}'
const STORAGE_KEY = 'qni.circuit_library.v2'
const FLEXOKI_BG: CanvasPixel = [255, 252, 240, 255]
const FLEXOKI_BG_2: CanvasPixel = [242, 240, 229, 255]
const FLEXOKI_UI: CanvasPixel = [230, 228, 217, 255]
const FLEXOKI_TX: CanvasPixel = [16, 15, 15, 255]

const TRIGGER: Point = { x: 40, y: 22 }
const ROW_1: Point = { x: 80, y: 100 }
const ROW_2: Point = { x: 80, y: 136 }
const ROW_3: Point = { x: 80, y: 172 }
const KEBAB_X = 226
const SUBMENU_X = 320
const MOVE_DOWN_Y = 208

const snapshot = async (page: Page): Promise<CircuitLibrarySnapshot> => {
  const raw = await page.evaluate(() => {
    const getter = (window as any).__qniCircuitPickerSnapshot
    if (typeof getter !== 'function') throw new Error('__qniCircuitPickerSnapshot hook missing')
    return getter()
  })
  return JSON.parse(raw) as CircuitLibrarySnapshot
}
const waitForCondition = async (page: Page, predicate: () => Promise<boolean>, description: string): Promise<void> => {
  await waitForValue(
    async () => {
      try {
        return await predicate()
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('hook missing')) {
          throw error
        }
        return false
      }
    },
    (value) => value,
    `timed out waiting for ${description}`,
  )
}

const seedLibrary = async (page: Page, activeId = 'two'): Promise<void> => {
  const library = {
    entries: [
      { id: 'one', name: 'One', circuit_json: ONE_JSON, updated_at: 1 },
      { id: 'two', name: 'Two', circuit_json: TWO_JSON, updated_at: 2 },
      { id: 'three', name: 'Three', circuit_json: THREE_JSON, updated_at: 3 },
    ],
    active_id: activeId,
  }
  await waitForCondition(page, async () => page.evaluate(() => typeof (window as any).__seedCircuits === 'function'), 'seed hook')
  await page.evaluate((payload) => {
    const seed = (window as any).__seedCircuits
    if (typeof seed !== 'function') throw new Error('__seedCircuits hook missing')
    seed(JSON.stringify(payload))
  }, library)
  await waitForCondition(page, async () => (await snapshot(page)).active_id === activeId, `active circuit ${activeId}`)
}

const canvasBox = async (page: Page) => {
  const box = await page.locator('#egui-canvas').boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  return box!
}

const clickCanvas = async (page: Page, point: Point): Promise<void> => {
  const box = await canvasBox(page)
  await page.mouse.click(box.x + point.x, box.y + point.y)
}

// 押下と移動が同じフレームに入るとドラッグ開始を取りこぼすことがある
// (CPU 飽和時に顕著)。開始を `item_dragging` で確かめ、始まっていなければやり直す。
const itemDragging = async (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const raw = Reflect.get(window, '__qniCircuitPickerResizeGeometryJson')
    return typeof raw === 'string' ? JSON.parse(raw).item_dragging === true : false
  })

const dragCanvas = async (page: Page, from: Point, to: Point): Promise<void> => {
  const box = await canvasBox(page)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.mouse.move(box.x + from.x, box.y + from.y)
    await page.mouse.down()
    await page.mouse.move(box.x + from.x, box.y + from.y + 8, { steps: 3 })
    const started = await pollForValue(() => itemDragging(page), (value) => value, { timeout: 2_000 })
    if (!started) {
      await page.mouse.up()
      continue
    }
    await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 8 })
    await page.mouse.up()
    return
  }
  throw new Error('timed out waiting for item drag to start')
}

const dragCanvasAndCancel = async (page: Page, from: Point, to: Point): Promise<void> => {
  const box = await canvasBox(page)
  await page.mouse.move(box.x + from.x, box.y + from.y)
  await page.mouse.down()
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 8 })
  await page.keyboard.press('Escape')
  await page.mouse.move(box.x + to.x, box.y + to.y - 24, { steps: 4 })
  await page.mouse.up()
}

const entryIds = async (page: Page): Promise<string[]> => (await snapshot(page)).entries.map((entry) => entry.id)

const hoverSnapshot = async (page: Page): Promise<HoverSnapshot> =>
  page.evaluate(() => JSON.parse((window as any).__qniHoverSnapshotJson ?? '{}') as HoverSnapshot)

const pickerDropdownGeometry = async (page: Page): Promise<PickerDropdownGeometry | null> =>
  page.evaluate(() => {
    const raw = (window as any).__qniCircuitPickerDropdownGeometryJson
    return typeof raw === 'string' ? JSON.parse(raw) as PickerDropdownGeometry : null
  })

const submenuGeometry = async (page: Page): Promise<SubmenuGeometry | null> =>
  page.evaluate(() => {
    const raw = (window as any).__qniCircuitPickerGeometryJson
    return typeof raw === 'string' ? JSON.parse(raw) as SubmenuGeometry : null
  })

const storedEntryIds = async (page: Page): Promise<string[]> =>
  page.evaluate((key) => {
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null')
    return stored?.entries?.map((entry: { id: string }) => entry.id) ?? []
  }, STORAGE_KEY)

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await waitForStartupReady(page, { waitForStateVector: true })
  await seedLibrary(page)
  await clickCanvas(page, TRIGGER)
  await page.waitForTimeout(200)
})

test('circuit picker dropdown attaches to the topbar with no vertical gap', async ({ page }) => {
  await waitForCondition(page, async () => (await pickerDropdownGeometry(page)) !== null, 'picker dropdown geometry')
  const geometry = (await pickerDropdownGeometry(page))!
  expect({
    attachedToTopbar: Math.abs(geometry.dropdown_top - geometry.topbar_bottom) <= 0.5,
    belowTrigger: geometry.dropdown_top > geometry.trigger_bottom,
  }).toEqual({ attachedToTopbar: true, belowTrigger: true })
})

test('hovering a picker row uses the pointing-hand cursor', async ({ page }) => {
  const box = await canvasBox(page)
  await page.mouse.move(box.x + ROW_2.x, box.y + ROW_2.y)
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#egui-canvas')
    return canvas && getComputedStyle(canvas).cursor === 'pointer'
  })
  const cursor = await page.locator('#egui-canvas').evaluate((canvas) => getComputedStyle(canvas).cursor)

  expect(cursor).toBe('pointer')
})

test('pressed row shows dragged styling before movement threshold', async ({ page }) => {
  const box = await canvasBox(page)
  await page.mouse.move(box.x + ROW_2.x, box.y + ROW_2.y)
  await page.mouse.down()
  try {
    await page.waitForTimeout(80)
    const pixels = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
      { name: 'pressed-row-fill', x: 180, y: ROW_2.y },
      { name: 'next-row-paper', x: 180, y: ROW_2.y + 24 },
    ])
    const fill = pixels['pressed-row-fill']
    const ids = await entryIds(page)
    expect({
      pressedFillUsesUi: pixelRgbDistance(fill, FLEXOKI_UI) < 40,
      pressedFillDiffersFromPaper: pixelRgbDistance(fill, FLEXOKI_BG) > 45,
      nextRowStaysPaper: pixelRgbDistance(pixels['next-row-paper'], FLEXOKI_BG) < 25,
      ids,
    }).toEqual({
      pressedFillUsesUi: true,
      pressedFillDiffersFromPaper: true,
      nextRowStaysPaper: true,
      ids: ['one', 'two', 'three'],
    })
  } finally {
    await page.mouse.up()
  }
})

test('dragging the third item above the first reorders to [3, 1, 2]', async ({ page }) => {
  await dragCanvas(page, ROW_3, { x: ROW_1.x + 48, y: ROW_1.y - 18 })

  await waitForCondition(page, async () => (await entryIds(page)).join(',') === 'three,one,two', 'third item reordered first')
  const idsAfterDrag = await entryIds(page)
  const activeAfterDrag = (await snapshot(page)).active_id
  const storedIds = await storedEntryIds(page)

  expect({
    idsAfterDrag,
    activeAfterDrag,
    storedIds,
  }).toEqual({
    idsAfterDrag: ['three', 'one', 'two'],
    activeAfterDrag: 'two',
    storedIds: ['three', 'one', 'two'],
  })
})

test('dragging the first item to the end reorders to [2, 3, 1]', async ({ page }) => {
  await dragCanvas(page, ROW_1, { x: ROW_3.x + 36, y: ROW_3.y + 28 })

  await waitForCondition(page, async () => (await entryIds(page)).join(',') === 'two,three,one', 'first item reordered last')
  expect({ ids: await entryIds(page), activeId: (await snapshot(page)).active_id }).toEqual({
    ids: ['two', 'three', 'one'],
    activeId: 'two',
  })
})

test('Escape while dragging cancels reorder', async ({ page }) => {
  await dragCanvasAndCancel(page, ROW_3, { x: ROW_1.x + 48, y: ROW_1.y - 18 })

  await waitForCondition(page, async () => (await entryIds(page)).join(',') === 'one,two,three', 'drag cancel restored order')
  expect({ ids: await entryIds(page), activeId: (await snapshot(page)).active_id }).toEqual({
    ids: ['one', 'two', 'three'],
    activeId: 'two',
  })
})

test('picker overlay suppresses underlying circuit and palette hover', async ({ page }) => {
  const box = await canvasBox(page)
  await page.mouse.move(box.x + KEBAB_X, box.y + ROW_2.y)

  await expect.poll(async () => await hoverSnapshot(page)).toMatchObject({
    hoveredGateId: null,
    hoveredPaletteIndex: null,
  })
})

test('kebab hover darkens only the dots without painting a chip', async ({ page }) => {
  const box = await canvasBox(page)
  await page.mouse.move(box.x + KEBAB_X, box.y + ROW_1.y)
  await page.waitForTimeout(120)

  const pixels = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
    { name: 'row-hover-fill-under-kebab', x: KEBAB_X - 7, y: ROW_1.y },
    { name: 'hover-dot', x: KEBAB_X, y: ROW_1.y },
  ])

  expect({
    rowKeepsHoverFill: pixelRgbDistance(pixels['row-hover-fill-under-kebab'], FLEXOKI_BG_2) < 25,
    noChipFill: pixelRgbDistance(pixels['row-hover-fill-under-kebab'], FLEXOKI_UI) > 20,
    dotsDarken: pixelRgbDistance(pixels['hover-dot'], FLEXOKI_TX) < 80,
  }).toEqual({ rowKeepsHoverFill: true, noChipFill: true, dotsDarken: true })
})

test('starting a row drag closes an open kebab submenu', async ({ page }) => {
  const box = await canvasBox(page)
  await clickCanvas(page, { x: KEBAB_X, y: ROW_1.y })
  await page.waitForTimeout(160)

  await page.mouse.move(box.x + ROW_3.x, box.y + ROW_3.y)
  await page.mouse.down()
  await page.mouse.move(box.x + ROW_3.x, box.y + ROW_3.y + 8, { steps: 4 })
  await page.mouse.up()

  await clickCanvas(page, { x: SUBMENU_X, y: MOVE_DOWN_Y })
  await waitForCondition(page, async () => (await entryIds(page)).join(',') === 'one,two,three', 'submenu move ignored after row drag')
  expect(await entryIds(page)).toEqual(['one', 'two', 'three'])
})

test('clicking the open kebab trigger closes its submenu', async ({ page }) => {
  await clickCanvas(page, { x: KEBAB_X, y: ROW_1.y })
  await page.waitForTimeout(160)
  await clickCanvas(page, { x: KEBAB_X, y: ROW_1.y })

  await clickCanvas(page, { x: SUBMENU_X, y: MOVE_DOWN_Y })
  await waitForCondition(page, async () => (await entryIds(page)).join(',') === 'one,two,three', 'submenu move ignored after close')
  expect(await entryIds(page)).toEqual(['one', 'two', 'three'])
})

test('kebab click opens the submenu without starting a drag', async ({ page }) => {
  await clickCanvas(page, { x: KEBAB_X, y: ROW_1.y })
  await page.waitForTimeout(200)
  await clickCanvas(page, { x: SUBMENU_X, y: MOVE_DOWN_Y })

  await waitForCondition(page, async () => (await entryIds(page)).join(',') === 'two,one,three', 'submenu move applied')
  expect(await entryIds(page)).toEqual(['two', 'one', 'three'])
})

test('submenu top edge aligns to the parent row on right and flipped anchors', async ({ page }) => {
  await clickCanvas(page, { x: KEBAB_X, y: ROW_1.y })
  await waitForCondition(
    page,
    async () => {
      const geometry = await submenuGeometry(page)
      return geometry !== null && geometry.submenu_left > geometry.kebab_right
    },
    'right-anchored submenu geometry',
  )
  const rightAnchored = (await submenuGeometry(page))!

  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    const global = window as any
    global.__qniCircuitPickerGeometryJson = undefined
  })
  await page.setViewportSize({ width: 380, height: 800 })
  await waitForCondition(page, async () => (await pickerDropdownGeometry(page)) !== null, 'flipped picker dropdown geometry')
  await clickCanvas(page, { x: KEBAB_X, y: ROW_1.y })

  await waitForCondition(
    page,
    async () => {
      const geometry = await submenuGeometry(page)
      return geometry !== null && geometry.submenu_right < geometry.kebab_left
    },
    'flipped submenu geometry',
  )
  const flipped = (await submenuGeometry(page))!
  expect({
    rightTopAligned: Math.abs(rightAnchored.submenu_top - rightAnchored.parent_row_top) <= 0.5,
    rightSideAnchored: rightAnchored.submenu_left > rightAnchored.kebab_right,
    flippedTopAligned: Math.abs(flipped.submenu_top - flipped.parent_row_top) <= 0.5,
    flippedLeftSideAnchored: flipped.submenu_right < flipped.kebab_left,
  }).toEqual({
    rightTopAligned: true,
    rightSideAnchored: true,
    flippedTopAligned: true,
    flippedLeftSideAnchored: true,
  })
})
