import { expect, test, type Page } from '@playwright/test'
import {
  chromium,
  dragPointer,
  getDragPreviewAboveStatePanelProbe,
  getPaletteGateCenter,
  getPlainChromiumLaunchOptions,
  getWebServerConfig,
  isDragPreviewFill,
  isGateBodyFill,
  isRegularGateFill,
  pixelRgbDistance,
  readEguiError,
  readMeasurementOutcomes,
  readStateVector,
  releasePointer,
  sampleCanvasPixels,
  UI_CONSTANTS,
  waitForAppReady,
  waitForBlochVectorsApprox,
  waitForCanvasContent,
  waitForStartupReady,
  waitForStateVectorApprox,
  waitForStateVectorLength,
  type CanvasPixel,
  type CircularBodySignature,
  type PixelSamplePoint,
  type Point,
} from './support/web-spec-helpers'

const EXEC_MODE_LOCAL_FILL: CanvasPixel = [111, 110, 105, 255] // Flexoki tx-2 #6F6E69
const EXEC_MODE_GPU_FILL: CanvasPixel = [32, 94, 166, 255] // Flexoki blue-600 #205EA6
const FLEXOKI_BLUE_600: CanvasPixel = [32, 94, 166, 255] // Flexoki blue-600 #205EA6
const STATE_POPUP_SURFACE: CanvasPixel = [255, 252, 240, 255] // Flexoki bg #FFFCF0
const STATE_POPUP_OUTLINE: CanvasPixel = [183, 181, 172, 255] // Flexoki tx-3 #B7B5AC

const readCircuitColsFromHash = (url: string): unknown[] => {
  const hash = new URL(url).hash.slice(1)
  if (!hash) {
    return []
  }
  return JSON.parse(decodeURIComponent(hash)).cols
}

const waitForHashCols = async (page: { url(): string; waitForTimeout(ms: number): Promise<void> }, expected: unknown[]): Promise<void> => {
  const expectedJson = JSON.stringify(expected)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (JSON.stringify(readCircuitColsFromHash(page.url())) === expectedJson) return
    await page.waitForTimeout(50)
  }
  throw new Error(`URL hash columns did not become ${expectedJson}`)
}

const execModeProbePoints = (cssWidth: number): PixelSamplePoint[] => [
  { name: 'local', x: cssWidth - 100, y: 23 },
  { name: 'gpu', x: cssWidth - 30, y: 23 },
]

const CIRCUIT_PICKER_TOOLBAR_SHIFT = 98 // default auto-width picker trigger + toolbar gap-2
const RUN_GPU_BUTTON_POINT: Point = { x: 236 + CIRCUIT_PICKER_TOOLBAR_SHIFT, y: 22 }
const TEST_REM = 32
const TEST_GATE_SIZE = UI_CONSTANTS.GATE_SIZE
const TEST_PALETTE_ROW_Y = 2.5 * TEST_REM
const TEST_PALETTE_ROW_GAP = 8
const TEST_PALETTE_PADDING_Y = 20
const TEST_PALETTE_CIRCUIT_GAP = 48
const TEST_CIRCUIT_LINE_Y =
  TEST_PALETTE_ROW_Y +
  TEST_GATE_SIZE * 2 +
  TEST_PALETTE_ROW_GAP +
  TEST_PALETTE_PADDING_Y +
  TEST_PALETTE_CIRCUIT_GAP +
  TEST_GATE_SIZE / 2
const TEST_CIRCUIT_LINE_GAP = UI_CONSTANTS.LINE_GAP

type StatePopupProbeGeometry = {
  cellCenter: Point
  popupTop: number
  popupHeight: number
  popupFill: PixelSamplePoint
  nearbyBackground: PixelSamplePoint
  popupValueAnchor: Point
}

const EGUI_PANEL_MARGIN = 8

const firstGateCenter = (): Point => ({
  x: EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE,
  y: EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_Y,
})

const firstGateOuterChromeProbe = (): PixelSamplePoint => {
  const gate = firstGateCenter()
  return {
    name: 'outerChrome',
    x: gate.x,
    y: gate.y - UI_CONSTANTS.GATE_SIZE / 2 - 3,
  }
}

const sampleFirstGateOuterChrome = async (page: Page) => {
  const pixels = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [firstGateOuterChromeProbe()])
  return pixels.outerChrome
}

const waitForFirstGateOuterChromeBlue = async (page: Page): Promise<boolean> => {
  let observed = false
  for (let attempt = 0; attempt < 8; attempt += 1) {
    observed = pixelRgbDistance(await sampleFirstGateOuterChrome(page), FLEXOKI_BLUE_600) < 60
    if (observed) return observed
    await page.waitForTimeout(50)
  }
  return observed
}

const defaultStateCircleLayout = (qubits: number): { cols: number; rows: number; size: number; gap: number } => {
  const cols = qubits === 1 ? 2 : qubits <= 3 ? 2 ** qubits : qubits <= 4 ? 8 : qubits <= 6 ? 16 : 32
  const rows = 2 ** qubits / cols
  const size = qubits <= 3 ? 64 : qubits === 4 ? 48 : qubits <= 6 ? 32 : 16
  const lineWidth = qubits <= 6 ? 2 : 1
  return { cols, rows, size, gap: lineWidth + 1 }
}

const defaultStatePopupProbeGeometry = (
  cssWidth: number,
  cssHeight: number,
  qubits = 1,
  displayIndex = 0,
  panX = 0,
): StatePopupProbeGeometry => {
  const EGUI_PANEL_MARGIN = 8
  const STATE_PANEL_WIDTH = UI_CONSTANTS.STATE_VIEWPORT_DEFAULT_WIDTH
  const STATE_VIEWPORT_HEIGHT = UI_CONSTANTS.STATE_VIEWPORT_DEFAULT_HEIGHT
  const STATE_HANDLE_HEIGHT = UI_CONSTANTS.STATE_HANDLE_HEIGHT
  const STATE_BOTTOM_MARGIN = UI_CONSTANTS.STATE_CIRCLE_BOTTOM_MARGIN
  const innerWidth = cssWidth - EGUI_PANEL_MARGIN * 2
  const innerHeight = cssHeight - EGUI_PANEL_MARGIN * 2
  const stateRectMinX = EGUI_PANEL_MARGIN + innerWidth / 2 - STATE_PANEL_WIDTH / 2
  const stateRectMinY =
    EGUI_PANEL_MARGIN + innerHeight - STATE_BOTTOM_MARGIN - STATE_VIEWPORT_HEIGHT - STATE_HANDLE_HEIGHT
  const viewportMinY = stateRectMinY + STATE_HANDLE_HEIGHT
  const circle = defaultStateCircleLayout(qubits)
  const gridWidth = circle.size * circle.cols + circle.gap * (circle.cols - 1)
  const gridHeight = circle.size * circle.rows + circle.gap * (circle.rows - 1)
  const gridOriginX = gridWidth <= STATE_PANEL_WIDTH
    ? Math.max(stateRectMinX, Math.min(stateRectMinX + STATE_PANEL_WIDTH - gridWidth, stateRectMinX + (STATE_PANEL_WIDTH - gridWidth) / 2 + panX))
    : Math.max(stateRectMinX + STATE_PANEL_WIDTH - gridWidth, Math.min(stateRectMinX, stateRectMinX + panX))
  const gridOriginY =
    gridHeight <= STATE_VIEWPORT_HEIGHT ? viewportMinY + (STATE_VIEWPORT_HEIGHT - gridHeight) / 2 : viewportMinY
  const col = displayIndex % circle.cols
  const row = Math.floor(displayIndex / circle.cols)
  const cellCenter = {
    x: gridOriginX + col * (circle.size + circle.gap) + circle.size / 2,
    y: gridOriginY + row * (circle.size + circle.gap) + circle.size / 2,
  }
  const popupHeight = 108
  const popupTop = cellCenter.y - circle.size / 2 - 4 - 8 - popupHeight
  const POPUP_WIDTH = 296
  const POPUP_PAD_X = 16
  const POPUP_HEADER_TEXT_H = 20
  const POPUP_HEADER_GAP = 8
  const POPUP_ICON_SIZE = 16
  const POPUP_ICON_TEXT_GAP = 8
  const POPUP_VALUE_X_OFFSET = POPUP_ICON_SIZE + POPUP_ICON_TEXT_GAP + 96
  return {
    cellCenter,
    popupTop,
    popupHeight,
    popupFill: { name: 'popupFill', x: cellCenter.x, y: popupTop + 16 },
    nearbyBackground: { name: 'nearbyBackground', x: cellCenter.x, y: popupTop - 12 },
    popupValueAnchor: {
      x: cellCenter.x - POPUP_WIDTH / 2 + POPUP_PAD_X + POPUP_VALUE_X_OFFSET,
      y: popupTop + 12 + POPUP_HEADER_TEXT_H + POPUP_HEADER_GAP - 2,
    },
  }
}

test('clicking a placed gate paints selection chrome without selecting a palette drop', async ({ page }) => {
  await page.goto('/')
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }

  const source = getPaletteGateCenter(box.width, 0)
  const target = {
    x: UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE,
    y: UI_CONSTANTS.LINE_Y,
  }
  const gate = firstGateCenter()

  await dragPointer(page, source, target)
  await waitForHashCols(page, [['H']])
  const afterDropIsBlue = await waitForFirstGateOuterChromeBlue(page)

  await page.mouse.click(box.x + gate.x, box.y + gate.y)
  const afterClickIsBlue = await waitForFirstGateOuterChromeBlue(page)

  expect({ afterDropIsBlue, afterClickIsBlue }).toEqual({
    afterDropIsBlue: false,
    afterClickIsBlue: true,
  })
})

test('execution mode toggle switches visually without recomputing state', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? 1000
  const points = execModeProbePoints(cssWidth)

  const waitForModeFill = async (mode: 'local' | 'gpu') => {
    const expected = mode === 'local' ? EXEC_MODE_LOCAL_FILL : EXEC_MODE_GPU_FILL
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const pixels = await sampleCanvasPixels(page, canvas, points)
      if (pixelRgbDistance(pixels[mode], expected) < 36) return
      await page.waitForTimeout(50)
    }
    throw new Error(`execution mode ${mode} did not reach expected fill`)
  }

  const initialState = await readStateVector(page)
  await waitForModeFill('local')

  await page.mouse.click((box?.x ?? 0) + points[1].x, (box?.y ?? 0) + points[1].y)
  await waitForModeFill('gpu')
  const stateAfterMouseGpu = await readStateVector(page)

  await page.mouse.click((box?.x ?? 0) + points[0].x, (box?.y ?? 0) + points[0].y)
  await waitForModeFill('local')
  const stateAfterMouseLocal = await readStateVector(page)

  await page.mouse.click((box?.x ?? 0) + cssWidth / 2, (box?.y ?? 0) + 300)
  await page.keyboard.press('Tab')
  await page.keyboard.press('ArrowRight')
  await waitForModeFill('gpu')
  await page.keyboard.press('ArrowLeft')
  await waitForModeFill('local')
  await page.keyboard.press('Enter')
  await waitForModeFill('gpu')
  await page.keyboard.press('Space')
  await waitForModeFill('local')
  expect({ stateAfterMouseGpu, stateAfterMouseLocal, stateAfterKeyboard: await readStateVector(page) }).toEqual({
    stateAfterMouseGpu: initialState,
    stateAfterMouseLocal: initialState,
    stateAfterKeyboard: initialState,
  })
})

test('empty hash checkpoint overrides a stale qni path payload on load', async ({ page }) => {
  const pathPayload = encodeURIComponent(JSON.stringify({ cols: [['X']] }))
  const emptyHash = encodeURIComponent(JSON.stringify({ cols: [] }))
  await page.goto(`/${pathPayload}#${emptyHash}`)

  await waitForStartupReady(page, { waitForStateVector: true })

  expect(readCircuitColsFromHash(page.url())).toEqual([])
  await waitForStateVectorApprox(page, [1, 0, 0, 0])
})

test('Run GPU submits small GPU-mode circuits without using the local panel', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? 1000
  const points = execModeProbePoints(cssWidth)

  await page.mouse.click((box?.x ?? 0) + points[1].x, (box?.y ?? 0) + points[1].y)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pixels = await sampleCanvasPixels(page, canvas, points)
    if (pixelRgbDistance(pixels.gpu, EXEC_MODE_GPU_FILL) < 36) break
    if (attempt === 49) throw new Error('GPU mode did not reach expected fill')
    await page.waitForTimeout(50)
  }

  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      const payload = JSON.parse(payloadJson)
      ;(window as any).__qniLastQiskitRequest = payload
      const result = {
        status: 'completed',
        runner: 'test',
        qubits: payload.qubits,
        shots: payload.shots,
        histogram: { '0': 512, '1': 512 },
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const REM = 32
  const GATE_SIZE = UI_CONSTANTS.GATE_SIZE
  const CIRCUIT_PADDING = 2 * REM
  const QUBIT_LABEL_WIDTH = 3 * 14
  const QUBIT_LABEL_GAP = 0.5 * REM
  const PALETTE_ROW_Y = 2.5 * REM
  const PALETTE_ROW_GAP = 8
  const PALETTE_PADDING_Y = 20
  const PALETTE_CIRCUIT_GAP = 48
  const LINE_LEFT_OFFSET = CIRCUIT_PADDING + QUBIT_LABEL_WIDTH + QUBIT_LABEL_GAP
  const LINE_Y =
    PALETTE_ROW_Y + GATE_SIZE * 2 + PALETTE_ROW_GAP + PALETTE_PADDING_Y + PALETTE_CIRCUIT_GAP + GATE_SIZE / 2

  const hSource = getPaletteGateCenter(cssWidth, 0)
  const targetX = LINE_LEFT_OFFSET + GATE_SIZE
  await dragPointer(page, hSource, { x: targetX, y: LINE_Y })

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (JSON.stringify(readCircuitColsFromHash(page.url())) === JSON.stringify([['H']])) break
    if (attempt === 49) throw new Error('H gate did not appear in URL hash')
    await page.waitForTimeout(50)
  }
  await page.mouse.click((box?.x ?? 0) + RUN_GPU_BUTTON_POINT.x, (box?.y ?? 0) + RUN_GPU_BUTTON_POINT.y)

  let qiskitStatus: string | undefined
  for (let attempt = 0; attempt < 50; attempt += 1) {
    qiskitStatus = await page.evaluate(() => (window as any).__qniLastQiskitResult?.status)
    if (qiskitStatus === 'completed') break
    await page.waitForTimeout(50)
  }
  expect({ hashCols: readCircuitColsFromHash(page.url()), qiskitStatus }).toEqual({
    hashCols: [['H']],
    qiskitStatus: 'completed',
  })
})

test('toolbar undo and redo restore committed circuit history', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? 1000

  const REM = 32
  const GATE_SIZE = UI_CONSTANTS.GATE_SIZE
  const SLOT_SPACING = UI_CONSTANTS.SLOT_SPACING
  const CIRCUIT_PADDING = 2 * REM
  const QUBIT_LABEL_WIDTH = 3 * 14
  const QUBIT_LABEL_GAP = 0.5 * REM
  const PALETTE_ROW_Y = 2.5 * REM
  const PALETTE_ROW_GAP = 8
  const PALETTE_PADDING_Y = 20
  const PALETTE_CIRCUIT_GAP = 48
  const LINE_LEFT_OFFSET = CIRCUIT_PADDING + QUBIT_LABEL_WIDTH + QUBIT_LABEL_GAP
  const LINE_Y =
    PALETTE_ROW_Y + GATE_SIZE * 2 + PALETTE_ROW_GAP + PALETTE_PADDING_Y + PALETTE_CIRCUIT_GAP + GATE_SIZE / 2

  const xSource = getPaletteGateCenter(cssWidth, 1)
  const hSource = getPaletteGateCenter(cssWidth, 0)
  const targetX = LINE_LEFT_OFFSET + GATE_SIZE
  const targetX2 = targetX + SLOT_SPACING
  const clickToolbar = async (x: number): Promise<void> => {
    await page.mouse.click((box?.x ?? 0) + x, (box?.y ?? 0) + 18)
  }

  await dragPointer(page, xSource, { x: targetX, y: LINE_Y })
  await waitForHashCols(page, [['X']])
  await waitForStateVectorApprox(page, [0, 0, 1, 0])

  await dragPointer(page, hSource, { x: targetX2, y: LINE_Y })
  await waitForHashCols(page, [['X'], ['H']])
  await waitForStateVectorApprox(page, [Math.SQRT1_2, 0, -Math.SQRT1_2, 0])

  await clickToolbar(26 + CIRCUIT_PICKER_TOOLBAR_SHIFT)
  await waitForHashCols(page, [['X']])
  await waitForStateVectorApprox(page, [0, 0, 1, 0])

  await clickToolbar(26 + CIRCUIT_PICKER_TOOLBAR_SHIFT)
  await waitForHashCols(page, [])
  await waitForStateVectorApprox(page, [1, 0, 0, 0])

  await clickToolbar(62 + CIRCUIT_PICKER_TOOLBAR_SHIFT)
  await waitForHashCols(page, [['X']])
  await waitForStateVectorApprox(page, [0, 0, 1, 0])

  await clickToolbar(62 + CIRCUIT_PICKER_TOOLBAR_SHIFT)
  await waitForHashCols(page, [['X'], ['H']])
  await waitForStateVectorApprox(page, [Math.SQRT1_2, 0, -Math.SQRT1_2, 0])

  await clickToolbar(98 + CIRCUIT_PICKER_TOOLBAR_SHIFT)
  await waitForHashCols(page, [])
  await waitForStateVectorApprox(page, [1, 0, 0, 0])

  await clickToolbar(26 + CIRCUIT_PICKER_TOOLBAR_SHIFT)
  await waitForHashCols(page, [['X'], ['H']])
  await waitForStateVectorApprox(page, [Math.SQRT1_2, 0, -Math.SQRT1_2, 0])

  await clickToolbar(62 + CIRCUIT_PICKER_TOOLBAR_SHIFT)
  await waitForHashCols(page, [])
  await waitForStateVectorApprox(page, [1, 0, 0, 0])
})

test('Local mode refuses a 17th qubit drop', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1200 })
  const col0: Array<string | number> = Array(16).fill(1)
  col0[15] = 'X'
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [col0] })))

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? 1000
  const source = getPaletteGateCenter(cssWidth, 0)
  const targetY17 = TEST_CIRCUIT_LINE_Y + 16 * TEST_CIRCUIT_LINE_GAP
  await dragPointer(page, source, { x: 180, y: targetY17 }, 8, true)
  await page.waitForTimeout(100)

  const cols = readCircuitColsFromHash(page.url()) as unknown[][]
  expect({
    localCapacityPreserved: cols.every((col) => col.length <= 16),
    stateVectorLength: (await readStateVector(page)).length,
  }).toEqual({ localCapacityPreserved: true, stateVectorLength: 131072 })
})

test('GPU mode accepts a 17th qubit drop', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1200 })
  const col0: Array<string | number> = Array(16).fill(1)
  col0[15] = 'X'
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [col0] })))

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? 1000
  const points = execModeProbePoints(cssWidth)

  await page.mouse.click((box?.x ?? 0) + points[1].x, (box?.y ?? 0) + points[1].y)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pixels = await sampleCanvasPixels(page, canvas, points)
    if (pixelRgbDistance(pixels.gpu, EXEC_MODE_GPU_FILL) < 36) break
    if (attempt === 49) throw new Error('GPU mode did not reach expected fill')
    await page.waitForTimeout(50)
  }

  const source = getPaletteGateCenter(cssWidth, 0)
  const targetY17 = TEST_CIRCUIT_LINE_Y + 16 * TEST_CIRCUIT_LINE_GAP
  await dragPointer(page, source, { x: 180, y: targetY17 }, 8, true)
  await page.waitForTimeout(100)

  const cols = readCircuitColsFromHash(page.url()) as unknown[][]
  expect(cols.some((col) => col.length === 17)).toBe(true)
})

test('17-qubit GPU circuit keeps Local mode unavailable', async ({ page }) => {
  const col0: Array<string | number> = Array(17).fill(1)
  col0[16] = 'X'
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [col0] })))

  await waitForStartupReady(page)

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? 1000
  const points = execModeProbePoints(cssWidth)
  const waitForGpu = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const pixels = await sampleCanvasPixels(page, canvas, points)
      if (pixelRgbDistance(pixels.gpu, EXEC_MODE_GPU_FILL) < 36) return
      await page.waitForTimeout(50)
    }
    throw new Error('GPU mode did not reach expected fill')
  }

  await waitForGpu()
  const cols = readCircuitColsFromHash(page.url()) as unknown[][]
  expect(cols[0]).toHaveLength(17)

  await page.mouse.click((box?.x ?? 0) + points[0].x, (box?.y ?? 0) + points[0].y)
  await waitForGpu()

  await page.keyboard.press('Tab')
  await page.keyboard.press('ArrowLeft')
  await waitForGpu()
})

test('state panel hover does not drive circuit step preview', async ({ page }) => {
  const col0: Array<string | number> = Array(8).fill(1)
  col0[7] = 'X'
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [col0] })))

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }

  const REM = 32
  const GATE_SIZE = UI_CONSTANTS.GATE_SIZE
  const SLOT_SPACING = UI_CONSTANTS.SLOT_SPACING
  const CIRCUIT_PADDING = 2 * REM
  const QUBIT_LABEL_WIDTH = 3 * 14
  const QUBIT_LABEL_GAP = 0.5 * REM
  const LINE_LEFT_OFFSET = CIRCUIT_PADDING + QUBIT_LABEL_WIDTH + QUBIT_LABEL_GAP
  const EGUI_PANEL_MARGIN = 8
  const slotCenter = (column: number) =>
    EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING * column
  const stepLineX = (column: number) => slotCenter(column) + SLOT_SPACING * 0.5
  const hoveredColumn = 2
  const probeY = 480
  const probePoints: PixelSamplePoint[] = [
    { name: 'line', x: stepLineX(hoveredColumn), y: probeY },
    { name: 'background', x: stepLineX(hoveredColumn) + 8, y: probeY },
  ]
  const stepLineContrast = async (): Promise<number> => {
    const pixels = await sampleCanvasPixels(page, canvas, probePoints)
    return pixelRgbDistance(pixels.line, pixels.background)
  }

  await page.mouse.move(
    (box?.x ?? 0) + slotCenter(hoveredColumn),
    (box?.y ?? 0) + probeY
  )
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await stepLineContrast() > 50) break
    if (attempt === 49) throw new Error('state-panel hover did not show the step preview')
    await page.waitForTimeout(50)
  }

  await page.mouse.move(
    (box?.x ?? 0) + slotCenter(hoveredColumn),
    (box?.y ?? 0) + 560
  )
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await stepLineContrast() < 25) return
    if (attempt === 49) throw new Error('state-panel hover kept driving the step preview')
    await page.waitForTimeout(50)
  }
})

test('state cell popup tail joins the body without a hairline seam', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? 1000
  const cssHeight = box?.height ?? 800

  const geometry = defaultStatePopupProbeGeometry(cssWidth, cssHeight)
  const popupContrast = async (): Promise<number> => {
    const pixels = await sampleCanvasPixels(page, canvas, [geometry.popupFill, geometry.nearbyBackground])
    return pixelRgbDistance(pixels.popupFill, pixels.nearbyBackground)
  }

  await page.mouse.move((box?.x ?? 0) + geometry.cellCenter.x, (box?.y ?? 0) + geometry.cellCenter.y)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await popupContrast()) > 20) break
    if (attempt === 49) throw new Error('state-cell popup did not become visible')
    await page.waitForTimeout(50)
  }
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'tailJoin', x: geometry.cellCenter.x, y: geometry.popupTop + geometry.popupHeight - 1 },
  ])

  expect(pixelRgbDistance(pixels.tailJoin, STATE_POPUP_SURFACE)).toBeLessThanOrEqual(45)
})

test('state cell popup tail has a visible outline on its slanted sides', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? 1000
  const cssHeight = box?.height ?? 800

  const geometry = defaultStatePopupProbeGeometry(cssWidth, cssHeight)
  const popupContrast = async (): Promise<number> => {
    const pixels = await sampleCanvasPixels(page, canvas, [geometry.popupFill, geometry.nearbyBackground])
    return pixelRgbDistance(pixels.popupFill, pixels.nearbyBackground)
  }

  await page.mouse.move((box?.x ?? 0) + geometry.cellCenter.x, (box?.y ?? 0) + geometry.cellCenter.y)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await popupContrast()) > 20) break
    if (attempt === 49) throw new Error('state-cell popup did not become visible')
    await page.waitForTimeout(50)
  }
  const tailTop = geometry.popupTop + geometry.popupHeight
  const tailOutlineSamples: PixelSamplePoint[] = []
  for (let y = 1; y <= 8; y += 1) {
    for (let x = 1; x <= 9; x += 1) {
      tailOutlineSamples.push({ name: `tailLeft${x}_${y}`, x: geometry.cellCenter.x - x, y: tailTop + y })
      tailOutlineSamples.push({ name: `tailRight${x}_${y}`, x: geometry.cellCenter.x + x, y: tailTop + y })
    }
  }
  const pixels = await sampleCanvasPixels(page, canvas, tailOutlineSamples)
  const isOutline = (pixel: CanvasPixel): boolean => pixelRgbDistance(pixel, STATE_POPUP_OUTLINE) <= 70
  const outlineVisible = {
    left: Object.entries(pixels).filter(([name, pixel]) => name.startsWith('tailLeft') && isOutline(pixel)).length >= 8,
    right: Object.entries(pixels).filter(([name, pixel]) => name.startsWith('tailRight') && isOutline(pixel)).length >= 8,
  }

  expect(outlineVisible).toEqual({ left: true, right: true })
})

test('state cell popup body shifts under the tail near the left panel edge', async ({ page }) => {
  const col0: Array<string | number> = Array(7).fill(1)
  col0[6] = 'H'
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [col0] })))

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? 1000
  const cssHeight = box?.height ?? 800
  const geometry = defaultStatePopupProbeGeometry(cssWidth, cssHeight, 7)
  const popupContrast = async (): Promise<number> => {
    const pixels = await sampleCanvasPixels(page, canvas, [geometry.popupFill, geometry.nearbyBackground])
    return pixelRgbDistance(pixels.popupFill, pixels.nearbyBackground)
  }

  await page.mouse.move((box?.x ?? 0) + geometry.cellCenter.x, (box?.y ?? 0) + geometry.cellCenter.y)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await popupContrast()) > 20) break
    if (attempt === 49) throw new Error('state-cell popup did not become visible')
    await page.waitForTimeout(50)
  }
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'tailBaseUnderBody', x: geometry.cellCenter.x - 6, y: geometry.popupTop + geometry.popupHeight - 4 },
  ])

  expect(pixelRgbDistance(pixels.tailBaseUnderBody, STATE_POPUP_SURFACE)).toBeLessThanOrEqual(45)
})

test('state cell popup body shifts under the tail near the right panel edge', async ({ page }) => {
  const col0: Array<string | number> = Array(7).fill(1)
  col0[6] = 'H'
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [col0] })))

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? 1000
  const cssHeight = box?.height ?? 800
  const firstCell = defaultStatePopupProbeGeometry(cssWidth, cssHeight, 7)
  await dragPointer(
    page,
    { x: cssWidth / 2, y: firstCell.cellCenter.y },
    { x: cssWidth / 2 - 40, y: firstCell.cellCenter.y },
  )
  const geometry = defaultStatePopupProbeGeometry(cssWidth, cssHeight, 7, 31, -14)
  const popupContrast = async (): Promise<number> => {
    const pixels = await sampleCanvasPixels(page, canvas, [geometry.popupFill, geometry.nearbyBackground])
    return pixelRgbDistance(pixels.popupFill, pixels.nearbyBackground)
  }

  await page.mouse.move((box?.x ?? 0) + geometry.cellCenter.x, (box?.y ?? 0) + geometry.cellCenter.y)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await popupContrast()) > 20) break
    if (attempt === 49) throw new Error('state-cell popup did not become visible')
    await page.waitForTimeout(50)
  }
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'tailBaseUnderBody', x: geometry.cellCenter.x + 6, y: geometry.popupTop + geometry.popupHeight - 4 },
  ])

  expect(pixelRgbDistance(pixels.tailBaseUnderBody, STATE_POPUP_SURFACE)).toBeLessThanOrEqual(45)
})

test('state cell popup hides while dragging over the state panel', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? 1000
  const cssHeight = box?.height ?? 800

  const geometry = defaultStatePopupProbeGeometry(cssWidth, cssHeight)
  const popupContrast = async (): Promise<number> => {
    const pixels = await sampleCanvasPixels(page, canvas, [geometry.popupFill, geometry.nearbyBackground])
    return pixelRgbDistance(pixels.popupFill, pixels.nearbyBackground)
  }

  const popupValueAnchor = geometry.popupValueAnchor
  const popupValuePoints: PixelSamplePoint[] = []
  for (let y = popupValueAnchor.y; y <= popupValueAnchor.y + 56; y += 4) {
    for (let x = popupValueAnchor.x; x <= popupValueAnchor.x + 148; x += 6) {
      popupValuePoints.push({ name: `popupValue-${popupValuePoints.length}`, x, y })
    }
  }
  const popupValueInkCount = async (): Promise<number> => {
    const pixels = await sampleCanvasPixels(page, canvas, [geometry.popupFill, ...popupValuePoints])
    return popupValuePoints.filter(
      (point) => pixelRgbDistance(pixels[point.name], pixels.popupFill) > 80
    ).length
  }

  await page.mouse.move((box?.x ?? 0) + geometry.cellCenter.x, (box?.y ?? 0) + geometry.cellCenter.y)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await popupContrast()) > 20 && (await popupValueInkCount()) > 10) break
    if (attempt === 49) throw new Error('state-cell popup did not become visible')
    await page.waitForTimeout(50)
  }

  const hSource = getPaletteGateCenter(cssWidth, 0)
  await dragPointer(page, hSource, geometry.cellCenter, 8, false)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await popupContrast() < 15) break
    if (attempt === 49) throw new Error('state-cell popup did not hide during drag')
    await page.waitForTimeout(50)
  }
  await page.mouse.up()
})

test('snapped dragging grows state vector before drop without mutating URL', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const viewport = page.viewportSize()
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? (viewport?.width ?? 1000)

  const REM = 32
  const GATE_SIZE = UI_CONSTANTS.GATE_SIZE
  const CIRCUIT_PADDING = 2 * REM
  const QUBIT_LABEL_WIDTH = 3 * 14
  const QUBIT_LABEL_GAP = 0.5 * REM
  const PALETTE_ROW_Y = 2.5 * REM
  const PALETTE_ROW_GAP = 8
  const PALETTE_PADDING_Y = 20
  const PALETTE_CIRCUIT_GAP = 48
  const LINE_LEFT_OFFSET = CIRCUIT_PADDING + QUBIT_LABEL_WIDTH + QUBIT_LABEL_GAP
  const LINE_Y =
    PALETTE_ROW_Y + GATE_SIZE * 2 + PALETTE_ROW_GAP + PALETTE_PADDING_Y + PALETTE_CIRCUIT_GAP + GATE_SIZE / 2
  const LINE_GAP = UI_CONSTANTS.LINE_GAP

  const hSource = getPaletteGateCenter(cssWidth, 0)
  const targetX = LINE_LEFT_OFFSET + GATE_SIZE
  const targetY0 = LINE_Y
  const targetY1 = LINE_Y + LINE_GAP
  const targetY2 = LINE_Y + 2 * LINE_GAP

  await dragPointer(page, hSource, { x: targetX, y: targetY0 })

  await dragPointer(page, hSource, { x: targetX, y: targetY1 })
  await waitForStateVectorLength(page, 8)

  const colsBeforeDrag = readCircuitColsFromHash(page.url())
  await dragPointer(page, { x: targetX, y: targetY0 }, { x: targetX, y: targetY2 }, 6, false)

  const lengthDuringDrag = (await readStateVector(page)).length
  expect({ lengthDuringDrag, colsDuringDrag: readCircuitColsFromHash(page.url()) }).toEqual({
    lengthDuringDrag: 16,
    colsDuringDrag: colsBeforeDrag,
  })

  await releasePointer(page, { x: targetX, y: targetY2 })

  await waitForStateVectorLength(page, 16)
})

test('dragging a placed gate left of the circuit removes it', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H']] })))

  await waitForStartupReady(page, { waitForStateVector: true })

  const placedGateCenterX = UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE
  const outsideLeftSnapRadiusX = placedGateCenterX - UI_CONSTANTS.SNAP_DISTANCE - 1
  await dragPointer(
    page,
    { x: placedGateCenterX, y: TEST_CIRCUIT_LINE_Y },
    { x: outsideLeftSnapRadiusX, y: TEST_CIRCUIT_LINE_Y }
  )

  await waitForHashCols(page, [])
  expect(readCircuitColsFromHash(page.url())).toEqual([])
})

test('dropping within the 40px sticky snap range commits to the nearest slot', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const viewport = page.viewportSize()
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? (viewport?.width ?? 1000)

  const hSource = getPaletteGateCenter(cssWidth, 0)
  const targetX = UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE
  const verticalOffsetInside40pxSnap = 26
  await dragPointer(page, hSource, { x: targetX, y: TEST_CIRCUIT_LINE_Y + verticalOffsetInside40pxSnap })

  await waitForHashCols(page, [['H']])
  expect(readCircuitColsFromHash(page.url())).toEqual([['H']])
})

test('dropping between existing columns inserts a new column', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const viewport = page.viewportSize()
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? (viewport?.width ?? 1000)

  const REM = 32
  const GATE_SIZE = UI_CONSTANTS.GATE_SIZE
  const SLOT_SPACING = UI_CONSTANTS.SLOT_SPACING
  const CIRCUIT_PADDING = 2 * REM
  const QUBIT_LABEL_WIDTH = 3 * 14
  const QUBIT_LABEL_GAP = 0.5 * REM
  const PALETTE_ROW_Y = 2.5 * REM
  const PALETTE_ROW_GAP = 8
  const PALETTE_PADDING_Y = 20
  const PALETTE_CIRCUIT_GAP = 48
  const LINE_LEFT_OFFSET = CIRCUIT_PADDING + QUBIT_LABEL_WIDTH + QUBIT_LABEL_GAP
  const LINE_Y =
    PALETTE_ROW_Y + GATE_SIZE * 2 + PALETTE_ROW_GAP + PALETTE_PADDING_Y + PALETTE_CIRCUIT_GAP + GATE_SIZE / 2

  const hSource = getPaletteGateCenter(cssWidth, 0)
  const xSource = getPaletteGateCenter(cssWidth, 1)
  const ySource = getPaletteGateCenter(cssWidth, 2)
  const targetX = LINE_LEFT_OFFSET + GATE_SIZE
  const targetX2 = targetX + SLOT_SPACING
  const insertX = targetX + SLOT_SPACING / 2

  await dragPointer(page, hSource, { x: targetX, y: LINE_Y })
  await dragPointer(page, xSource, { x: targetX2, y: LINE_Y })

  await waitForHashCols(page, [['H'], ['X']])

  await dragPointer(page, ySource, { x: insertX, y: LINE_Y })

  await waitForHashCols(page, [['H'], ['Y'], ['X']])
})
