import { expect, test, type Page } from '@playwright/test'
import {
  getPaletteGateCenter,
  pixelRgbDistance,
  sampleCanvasPixels,
  UI_CONSTANTS,
  waitForStartupReady,
  waitForValue,
  type CanvasPixel,
} from './support/web-spec-helpers'

type CircuitLibrarySnapshot = {
  entries: Array<{
    id: string
    name: string
    circuit_json: string
    updated_at: number
    locked: boolean
    origin: { kind: string; locked?: boolean; origin_id?: string }
  }>
  active_id: string
  active_locked: boolean
  active_kind: string
}

type ButtonGeometry = { left: number; right: number; top: number; bottom: number; hovered: boolean; tooltip: string }
type HoverSnapshot = { hoveredGateId: number | null; hoveredPaletteIndex: number | null; hoveredStep: number | null }

const BELL_JSON = '{"cols":[["H"],["•","X"]]}'
const H_JSON = '{"cols":[["H"]]}'
const X_JSON = '{"cols":[["X"]]}'
const EGUI_PANEL_MARGIN = 8
const CANVAS_BACKGROUND: CanvasPixel = [242, 240, 229, 255] // Flexoki bg-2 #F2F0E5.
const GATE_HOVER_BORDER: CanvasPixel = [139, 126, 200, 255] // Flexoki purple-400 #8B7EC8.
const GATE_SELECTION_BORDER: CanvasPixel = [32, 94, 166, 255] // Flexoki blue-600 #205EA6.

const snapshot = async (page: Page): Promise<CircuitLibrarySnapshot> => {
  const raw = await page.evaluate(() => {
    const getter = (window as any).__qniCircuitPickerSnapshot
    if (typeof getter !== 'function') throw new Error('__qniCircuitPickerSnapshot hook missing')
    return getter()
  })
  return JSON.parse(raw) as CircuitLibrarySnapshot
}
const waitForSnapshot = async (
  page: Page,
  predicate: (state: CircuitLibrarySnapshot) => boolean,
  description: string,
): Promise<CircuitLibrarySnapshot> => {
  return await waitForValue(
    () => snapshot(page),
    predicate,
    `timed out waiting for ${description}`,
  )
}

const waitForHashPayload = async (page: Page, expected: string): Promise<void> => {
  await waitForValue(
    () => page.evaluate(() => decodeURIComponent(window.location.hash.slice(1))),
    (payload) => payload === expected,
    `timed out waiting for URL hash payload ${expected}`,
  )
}

const canvasBox = async (page: Page) => {
  const box = await page.locator('#egui-canvas').boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  return box
}

const toolbarGeometry = async (page: Page, key: string): Promise<ButtonGeometry> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const raw = await page.evaluate((name) => (window as any)[name], key)
    if (typeof raw === 'string') return JSON.parse(raw) as ButtonGeometry
    await page.waitForTimeout(50)
  }
  throw new Error(`${key} was not published`)
}

const hoverSnapshot = async (page: Page): Promise<HoverSnapshot> => {
  const raw = await page.evaluate(() => (window as any).__qniHoverSnapshotJson ?? null)
  if (typeof raw !== 'string') throw new Error('__qniHoverSnapshotJson hook missing')
  return JSON.parse(raw) as HoverSnapshot
}

const waitForHoverStep = async (page: Page, expected: number): Promise<HoverSnapshot> => {
  return await waitForValue(
    () => hoverSnapshot(page),
    (snapshot) => snapshot.hoveredStep === expected,
    `hoveredStep did not become ${expected}`,
  )
}

const waitForCanvasBackgroundPixel = async (page: Page, point: { x: number; y: number }): Promise<CanvasPixel> => {
  const canvas = page.locator('#egui-canvas')
  let lastPixel: CanvasPixel | null = null

  try {
    return await waitForValue(
      async () => {
        const pixels = await sampleCanvasPixels(page, canvas, [{ name: 'probe', x: point.x, y: point.y }])
        const p = pixels.probe
        if (p[3] > 0) {
          lastPixel = p
        }
        return p
      },
      (p) => p[3] > 0 && pixelRgbDistance(p, CANVAS_BACKGROUND) < 16,
      'canvas probe did not match background color',
    )
  } catch (error) {
    if (lastPixel) return lastPixel
    throw new Error('canvas probe did not produce an opaque pixel')
  }
}

const clickToolbarButton = async (page: Page, key: string): Promise<void> => {
  const box = await canvasBox(page)
  const geometry = await toolbarGeometry(page, key)
  await page.mouse.click(box.x + (geometry.left + geometry.right) / 2, box.y + (geometry.top + geometry.bottom) / 2)
}

const seedLibrary = async (page: Page, payload: unknown): Promise<void> => {
  await page.evaluate((library) => {
    const seed = (window as any).__seedCircuits
    if (typeof seed !== 'function') throw new Error('__seedCircuits hook missing')
    seed(JSON.stringify(library))
  }, payload)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await waitForStartupReady(page, { waitForStateVector: true })
})

test('sample circuits expose a disabled locked toolbar state', async ({ page }) => {
  await seedLibrary(page, {
    entries: [{ id: 'bell', name: 'Bell state', circuit_json: BELL_JSON, updated_at: 1, origin: { kind: 'sample', origin_id: 'bell' } }],
    active_id: 'bell',
  })
  await waitForSnapshot(page, (state) => state.active_kind === 'example', 'sample active')

  const geometry = await toolbarGeometry(page, '__qniToolbarLockGeometryJson')

  expect(geometry.tooltip).toBe('Locked (sample) — duplicate to edit')
})

test('duplicating a sample creates an unlocked My circuit', async ({ page }) => {
  await seedLibrary(page, {
    entries: [{ id: 'bell', name: 'Bell state', circuit_json: BELL_JSON, updated_at: 1, origin: { kind: 'sample', origin_id: 'bell' } }],
    active_id: 'bell',
  })
  await waitForSnapshot(page, (state) => state.active_kind === 'example', 'sample active')

  await clickToolbarButton(page, '__qniToolbarDuplicateGeometryJson')
  const state = await waitForSnapshot(page, (next) => next.active_kind === 'my', 'duplicate active')

  expect(state.entries.find((entry) => entry.id === state.active_id)?.locked).toBe(false)
})

test('locked active circuit does not paint the edit palette', async ({ page }) => {
  await seedLibrary(page, {
    entries: [{ id: 'bell', name: 'Bell state', circuit_json: BELL_JSON, updated_at: 1, origin: { kind: 'sample', origin_id: 'bell' } }],
    active_id: 'bell',
  })
  await waitForSnapshot(page, (state) => state.active_locked === true, 'locked sample active')

  const box = await canvasBox(page)
  const paletteGate = getPaletteGateCenter(box.width, 0)
  const pixel = await waitForCanvasBackgroundPixel(page, {
    x: paletteGate.x + UI_CONSTANTS.GATE_SIZE / 2 - 6,
    y: EGUI_PANEL_MARGIN + paletteGate.y + UI_CONSTANTS.GATE_SIZE / 2 - 6,
  })

  expect(pixelRgbDistance(pixel, CANVAS_BACKGROUND)).toBeLessThan(16)
})

test('locked active circuit keeps placed gates out of hover state', async ({ page }) => {
  await seedLibrary(page, {
    entries: [{ id: 'bell', name: 'Bell state', circuit_json: BELL_JSON, updated_at: 1, origin: { kind: 'sample', origin_id: 'bell' } }],
    active_id: 'bell',
  })
  await waitForSnapshot(page, (state) => state.active_locked === true, 'locked sample active')

  const box = await canvasBox(page)
  const gateCenter = {
    x: EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE,
    y: EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_Y,
  }
  await page.mouse.move(box.x + gateCenter.x, box.y + gateCenter.y)
  const snapshot = await waitForHoverStep(page, 0)

  expect(snapshot.hoveredGateId).toBeNull()
})

test('locked active circuit does not paint placed gate hover frame', async ({ page }) => {
  await seedLibrary(page, {
    entries: [{ id: 'bell', name: 'Bell state', circuit_json: BELL_JSON, updated_at: 1, origin: { kind: 'sample', origin_id: 'bell' } }],
    active_id: 'bell',
  })
  await waitForSnapshot(page, (state) => state.active_locked === true, 'locked sample active')

  const box = await canvasBox(page)
  const gateCenter = {
    x: EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE,
    y: EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_Y,
  }
  await page.mouse.move(box.x + gateCenter.x, box.y + gateCenter.y)
  await waitForHoverStep(page, 0)
  const pixels = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
    {
      name: 'hoverFrame',
      x: gateCenter.x,
      y: gateCenter.y - UI_CONSTANTS.GATE_SIZE / 2 - 3,
    },
  ])

  expect(pixelRgbDistance(pixels.hoverFrame, GATE_HOVER_BORDER) < 48).toBe(false)
})

test('locked active circuit does not paint a copy selection frame', async ({ page }) => {
  await seedLibrary(page, {
    entries: [{ id: 'bell', name: 'Bell state', circuit_json: BELL_JSON, updated_at: 1, origin: { kind: 'sample', origin_id: 'bell' } }],
    active_id: 'bell',
  })
  await waitForSnapshot(page, (state) => state.active_locked === true, 'locked sample active')

  const box = await canvasBox(page)
  const gateCenter = {
    x: EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE,
    y: EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_Y,
  }
  await page.mouse.click(box.x + gateCenter.x, box.y + gateCenter.y)
  await page.keyboard.press('Control+C')
  await page.waitForTimeout(50)
  const pixels = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
    {
      name: 'selectionFrame',
      x: gateCenter.x,
      y: gateCenter.y - UI_CONSTANTS.GATE_SIZE / 2 - 3,
    },
  ])

  expect(pixelRgbDistance(pixels.selectionFrame, GATE_SELECTION_BORDER) < 48).toBe(false)
})

test('locking a My circuit guards runtime URL apply', async ({ page }) => {
  const initialLockButton = await toolbarGeometry(page, '__qniToolbarLockGeometryJson')
  await seedLibrary(page, {
    entries: [{ id: 'mine', name: 'Mine', circuit_json: H_JSON, updated_at: 1, origin: { kind: 'user', locked: false } }],
    active_id: 'mine',
  })
  await waitForSnapshot(page, (state) => state.active_locked === false, 'unlocked My active')
  // ライブラリーのスナップショットはツールバー再描画より先に更新される。
  // 名前が短くなったあとのボタン座標を待たないと、古い座標で空白を押す。
  await waitForValue(
    () => toolbarGeometry(page, '__qniToolbarLockGeometryJson'),
    (button) => Math.abs(button.left - initialLockButton.left) > 1,
    'toolbar layout after switching to Mine',
  )

  await clickToolbarButton(page, '__qniToolbarLockGeometryJson')
  await waitForSnapshot(page, (state) => state.active_locked === true, 'My circuit locked')
  await page.evaluate((json) => {
    window.location.hash = encodeURIComponent(json)
  }, X_JSON)
  await page.evaluate((json) => {
    const apply = (window as any).__qniApplyUrlPayload
    if (typeof apply !== 'function') throw new Error('__qniApplyUrlPayload hook missing')
    apply(json)
  }, X_JSON)
  await waitForHashPayload(page, H_JSON)
  const state = await waitForSnapshot(page, (next) => next.active_locked === true, 'locked URL apply rejected')

  expect(state.entries.find((entry) => entry.id === 'mine')?.circuit_json).toBe(H_JSON)
})
