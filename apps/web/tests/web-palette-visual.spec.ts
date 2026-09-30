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
  waitForValue,
  type CanvasPixel,
  type CircularBodySignature,
  type PixelSamplePoint,
  type Point,
} from './support/web-spec-helpers'

type HoverSnapshot = { hoveredPaletteIndex: number | null }

const POPOVER_OUTLINE: CanvasPixel = [183, 181, 172, 255] // Flexoki tx-3 #B7B5AC

const readCircuitColsFromHash = (url: string): unknown[] => {
  const hash = new URL(url).hash.slice(1)
  if (!hash) {
    return []
  }
  return JSON.parse(decodeURIComponent(hash)).cols
}
const waitForHashCols = async (page: { url(): string; waitForTimeout(ms: number): Promise<void> }, expected: unknown[]): Promise<void> => {
  const expectedJson = JSON.stringify(expected)
  await waitForValue(
    () => Promise.resolve(JSON.stringify(readCircuitColsFromHash(page.url()))),
    (seen) => seen === expectedJson,
    `URL hash columns did not become ${expectedJson}`,
  )
}

const hoverSnapshot = async (page: Page): Promise<HoverSnapshot> => {
  const snapshot = await page.evaluate(() => (window as any).__qniHoverSnapshotJson ?? null)
  if (snapshot === null) {
    throw new Error('hover snapshot hook missing')
  }
  return JSON.parse(snapshot)
}

test('palette gate hover outline uses Flexoki purple-400', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const gateCenter = getPaletteGateCenter(box.width, 0)
  await page.mouse.move(box.x + gateCenter.x, box.y + gateCenter.y)
  await page.waitForTimeout(50)
  const EGUI_PANEL_MARGIN = 8
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'hoverRing', x: gateCenter.x - UI_CONSTANTS.GATE_SIZE / 2 - 3, y: EGUI_PANEL_MARGIN + gateCenter.y },
  ])

  expect(pixelRgbDistance(pixels.hoverRing, [139, 126, 200, 255])).toBeLessThan(48)
})

test('palette tooltip uses the shared popover tail outline', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const gateCenter = getPaletteGateCenter(box.width, 0)
  const gateBottom = gateCenter.y + UI_CONSTANTS.GATE_SIZE / 2
  const tailApex = { x: gateCenter.x, y: gateBottom + 4 }
  await page.mouse.move(box.x + gateCenter.x, box.y + gateCenter.y)
  await page.waitForTimeout(150)

  const points: PixelSamplePoint[] = []
  for (let x = -8; x <= 8; x += 1) {
    for (let y = 0; y <= 8; y += 1) {
      points.push({ name: `tail${x}_${y}`, x: tailApex.x + x, y: tailApex.y + y })
    }
  }
  const pixels = await sampleCanvasPixels(page, canvas, points)
  const outlinePixels = Object.values(pixels).filter((pixel) => pixelRgbDistance(pixel, POPOVER_OUTLINE) <= 70).length

  expect(outlinePixels).toBeGreaterThanOrEqual(4)
})

test('Display section Probability slot preserves its palette hover index', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const probabilityCenter = getPaletteGateCenter(box.width, 20)
  await page.mouse.move(box.x + probabilityCenter.x, box.y + probabilityCenter.y)

  await expect.poll(async () => (await hoverSnapshot(page)).hoveredPaletteIndex).toBe(20)
})

test('Display section Density slot preserves its palette hover index', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const densityCenter = getPaletteGateCenter(box.width, 25)
  await page.mouse.move(box.x + densityCenter.x, box.y + densityCenter.y)

  await expect.poll(async () => (await hoverSnapshot(page)).hoveredPaletteIndex).toBe(25)
})

test('Density palette icon maximizes circle outlines without touching the hover frame', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const densityCenter = getPaletteGateCenter(box.width, 25)
  await page.mouse.move(box.x + densityCenter.x, box.y + densityCenter.y)
  await page.waitForTimeout(50)
  const EGUI_PANEL_MARGIN = 8
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'frameEdge', x: densityCenter.x - UI_CONSTANTS.GATE_SIZE / 2, y: EGUI_PANEL_MARGIN + densityCenter.y - UI_CONSTANTS.GATE_SIZE / 4 },
    { name: 'nearCircle', x: densityCenter.x - UI_CONSTANTS.GATE_SIZE / 2 + 1, y: EGUI_PANEL_MARGIN + densityCenter.y - UI_CONSTANTS.GATE_SIZE / 4 },
  ])

  expect({
    frameEdgeClear: pixelRgbDistance(pixels.frameEdge, [255, 252, 240, 255]) < 48,
    nearCircleVisible: pixelRgbDistance(pixels.nearCircle, [255, 252, 240, 255]) > 80,
  }).toEqual({ frameEdgeClear: true, nearCircleVisible: true })
})

test('palette measurement hover keeps the panel background inside the outline', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const measurementPaletteIndex = 19
  const gateCenter = getPaletteGateCenter(box.width, measurementPaletteIndex)
  await page.mouse.move(box.x + gateCenter.x, box.y + gateCenter.y)
  await page.waitForTimeout(50)
  const EGUI_PANEL_MARGIN = 8
  const pixels = await sampleCanvasPixels(page, canvas, [{ name: 'hoverInner', x: gateCenter.x - 17, y: EGUI_PANEL_MARGIN + gateCenter.y }])

  expect(pixelRgbDistance(pixels.hoverInner, [255, 252, 240, 255])).toBeLessThan(8)
})

const readCenteredConnectorStroke = async (page: Page): Promise<{ line: boolean[]; outside: boolean[] }> => {
  await waitForStartupReady(page, { waitForStateVector: true })
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const panelMargin = 8
  const connectorX = panelMargin + UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE
  const connectorY = panelMargin + UI_CONSTANTS.LINE_Y + UI_CONSTANTS.LINE_GAP / 2
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'leftOutside', x: connectorX - 3, y: connectorY },
    { name: 'leftInside', x: connectorX - 2, y: connectorY },
    { name: 'rightInside', x: connectorX + 1, y: connectorY },
    { name: 'rightOutside', x: connectorX + 2, y: connectorY },
  ])
  const isConnector = (pixel: CanvasPixel) => pixelRgbDistance(pixel, [58, 169, 159, 255]) < 8
  const isCircuitBg = (pixel: CanvasPixel) => pixelRgbDistance(pixel, [242, 240, 229, 255]) < 8

  return {
    line: [isConnector(pixels.leftInside), isConnector(pixels.rightInside)],
    outside: [isCircuitBg(pixels.leftOutside), isCircuitBg(pixels.rightOutside)],
  }
}

test('CNOT connector is centered as an even-width vertical stroke', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['•', 'X']] })))

  expect(await readCenteredConnectorStroke(page)).toEqual({
    line: [true, true],
    outside: [true, true],
  })
})

test('connected swap connector is centered as an even-width vertical stroke', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['Swap', 'Swap']] })))

  expect(await readCenteredConnectorStroke(page)).toEqual({
    line: [true, true],
    outside: [true, true],
  })
})

test('same-angle phase connector is centered as an even-width vertical stroke', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['P(π_4)', 'P(π_4)']] })))

  expect(await readCenteredConnectorStroke(page)).toEqual({
    line: [true, true],
    outside: [true, true],
  })
})

// 角度エディタは長押し判定を挟んで開くため、固定時間で待つと CPU 飽和時に
// 入力が空振りする。エディタが対象ゲートに紐づいたことを状態で待つ。
const waitForAngleEditor = async (page: Page, gateId: number): Promise<void> => {
  await waitForValue(
    () => page.evaluate(() => {
      const raw = Reflect.get(window, '__qniAngleInputGeometryJson')
      return typeof raw === 'string' ? raw : null
    }),
    (raw) => raw !== null && JSON.parse(raw).editor_gate_id === gateId,
    `angle editor did not become active for gate ${gateId}`,
  )
}

test('active same-angle phase editor masks the connector behind typed text', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['P(π_2)', 'P(π_2)', 'P(π_2)']] })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }

  const geometry = JSON.parse(await page.evaluate(() => (window as any).__qniAngleInputGeometryJson))
  const label = geometry.labels[1]
  await page.mouse.click((label.left + label.right) / 2, (label.top + label.bottom) / 2)
  await waitForAngleEditor(page, label.gate_id)
  await page.keyboard.type('111/3')
  await page.waitForTimeout(100)

  const pixels = await sampleCanvasPixels(page, canvas, [{
    name: 'maskedConnector',
    x: (label.left + label.right) / 2 - box.x,
    y: label.bottom - 4 - box.y,
  }])
  const activeGeometry = JSON.parse(await page.evaluate(() => (window as any).__qniAngleInputGeometryJson))

  expect({
    activeEditor: activeGeometry.editor_gate_id,
    maskedConnectorIsBackground: pixelRgbDistance(pixels.maskedConnector, [242, 240, 229, 255]) < 8,
  }).toEqual({
    activeEditor: label.gate_id,
    maskedConnectorIsBackground: true,
  })
})

test('invalid active angle editor restores the previous angle', async ({ page }) => {
  const expectedCols = [['P(π_2)']]
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: expectedCols })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const geometry = JSON.parse(await page.evaluate(() => (window as any).__qniAngleInputGeometryJson))
  const label = geometry.labels[0]
  await page.mouse.click((label.left + label.right) / 2, (label.top + label.bottom) / 2)
  await waitForAngleEditor(page, label.gate_id)
  await page.keyboard.type('hoge')
  await page.keyboard.press('Enter')
  // Enter の反映もフレームをまたぐ。閉じたことを状態で待ってから読む。
  const restoredJson = await waitForValue(
    () => page.evaluate(() => {
      const raw = Reflect.get(window, '__qniAngleInputGeometryJson')
      return typeof raw === 'string' ? raw : null
    }),
    (raw) => raw !== null && JSON.parse(raw).editor_gate_id === null,
    'angle editor did not close after Enter',
  )
  const restoredGeometry = JSON.parse(restoredJson ?? 'null')

  expect({
    cols: readCircuitColsFromHash(page.url()),
    editor: restoredGeometry.editor_gate_id,
    label: restoredGeometry.labels[0].text,
  }).toEqual({
    cols: expectedCols,
    editor: null,
    label: 'π/2',
  })
})

test('active angle editor normalizes coefficient fraction', async ({ page }) => {
  const expectedCols = [['P(π_2)']]
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['P(π_4)']] })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const geometry = JSON.parse(await page.evaluate(() => (window as any).__qniAngleInputGeometryJson))
  const label = geometry.labels[0]
  await page.mouse.click((label.left + label.right) / 2, (label.top + label.bottom) / 2)
  await waitForAngleEditor(page, label.gate_id)
  await page.keyboard.type('1/2')
  await page.keyboard.press('Enter')
  await waitForHashCols(page, expectedCols)

  expect(readCircuitColsFromHash(page.url())).toEqual(expectedCols)
})

test('palette Phase drop shows its π/2 default angle label', async ({ page }) => {
  await page.goto('/')
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }

  const panelMargin = 8
  const phasePaletteIndex = 9
  const phaseSource = getPaletteGateCenter(box.width, phasePaletteIndex)
  const expectedHashCols = [['P(π_2)']]
  await dragPointer(page, phaseSource, {
    x: UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE,
    y: UI_CONSTANTS.LINE_Y,
  })
  await waitForHashCols(page, expectedHashCols)

  const screenshot = await canvas.screenshot({ type: 'png' })
  const gateCenter = {
    x: panelMargin + UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE,
    y: panelMargin + UI_CONSTANTS.LINE_Y,
  }
  const darkPixels = await page.evaluate<
    number,
    { base64: string; cssWidth: number; cssHeight: number; gateCenter: Point }
  >(async ({ base64, cssWidth, cssHeight, gateCenter }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${base64}`
    await new Promise((resolve, reject) => {
      img.onload = () => resolve(null)
      img.onerror = () => reject(new Error('Failed to decode screenshot'))
    })

    const probe = document.createElement('canvas')
    probe.width = img.width
    probe.height = img.height
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      return 0
    }
    ctx.drawImage(img, 0, 0)
    const scaleX = img.width / cssWidth
    const scaleY = img.height / cssHeight
    let count = 0
    for (let y = gateCenter.y - 38; y <= gateCenter.y - 20; y += 1) {
      for (let x = gateCenter.x - 18; x <= gateCenter.x + 18; x += 1) {
        const data = ctx.getImageData(Math.floor(x * scaleX), Math.floor(y * scaleY), 1, 1).data
        if (data[0] < 120 && data[1] < 120 && data[2] < 120 && data[3] > 0) {
          count += 1
        }
      }
    }
    return count
  }, { base64: screenshot.toString('base64'), cssWidth: box.width, cssHeight: box.height, gateCenter })

  expect({ hashCols: readCircuitColsFromHash(page.url()), labelVisible: darkPixels > 4 }).toEqual({
    hashCols: expectedHashCols,
    labelVisible: true,
  })
})

test('dragged insert preview does not pull a connector off the gate center', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H', 'X']] })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }

  const panelMargin = 8
  const controlPaletteIndex = 14
  const controlStart = getPaletteGateCenter(box.width, controlPaletteIndex)
  const slot0CenterX = panelMargin + UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE
  const insertPreviewX = slot0CenterX + UI_CONSTANTS.SLOT_SPACING / 2
  const wire0CenterY = panelMargin + UI_CONSTANTS.LINE_Y
  await dragPointer(page, { x: controlStart.x, y: panelMargin + controlStart.y }, { x: insertPreviewX, y: wire0CenterY }, 10, false)
  await page.waitForTimeout(50)

  const connectorY = wire0CenterY + UI_CONSTANTS.LINE_GAP / 2
  const pixels = await sampleCanvasPixels(page, canvas, [{ name: 'connectorAtOccupiedSlot', x: slot0CenterX, y: connectorY }])
  await releasePointer(page, { x: insertPreviewX, y: wire0CenterY })

  expect(isRegularGateFill(pixels.connectorAtOccupiedSlot)).toBe(false)
})

const readConnectorBelowHoveredTopGate = async (page: Page): Promise<CanvasPixel> => {
  await waitForStartupReady(page, { waitForStateVector: true })
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const panelMargin = 8
  const connectorX = panelMargin + UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE
  const topGateY = panelMargin + UI_CONSTANTS.LINE_Y
  await page.mouse.move(box.x + connectorX, box.y + topGateY)
  await page.waitForTimeout(50)
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'connectorBelowHoveredTopGate', x: connectorX, y: topGateY + 14 },
  ])
  return pixels.connectorBelowHoveredTopGate
}

test('CNOT connector stays visible while hovering the control gate', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['•', 'X']] })))

  expect(pixelRgbDistance(await readConnectorBelowHoveredTopGate(page), [58, 169, 159, 255])).toBeLessThan(8)
})

test('connected swap connector stays visible while hovering the swap gate', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['Swap', 'Swap']] })))

  expect(pixelRgbDistance(await readConnectorBelowHoveredTopGate(page), [58, 169, 159, 255])).toBeLessThan(8)
})

test('palette probability display preview uses four Gaussian rows', async ({ page }) => {
  await page.goto('/')

  await waitForStartupReady(page, { waitForStateVector: true })
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const EGUI_PANEL_MARGIN = 8
  const probabilityPaletteIndex = 20
  const gateCenter = getPaletteGateCenter(box.width, probabilityPaletteIndex)
  const left = gateCenter.x - UI_CONSTANTS.GATE_SIZE / 2
  const top = EGUI_PANEL_MARGIN + gateCenter.y - UI_CONSTANTS.GATE_SIZE / 2
  const samples: PixelSamplePoint[] = [
    { name: 'row1Bar', x: left + 5, y: top + 5 },
    { name: 'row1Tail', x: left + 15, y: top + 5 },
    { name: 'row2Bar', x: left + 20, y: top + 15 },
    { name: 'row2EdgeA', x: left + 29, y: top + 15 },
    { name: 'row2EdgeB', x: left + 30, y: top + 15 },
    { name: 'row2EdgeC', x: left + 31, y: top + 15 },
    { name: 'row2Tail', x: left + 34, y: top + 15 },
    { name: 'row3Bar', x: left + 14, y: top + 25 },
    { name: 'row3Tail', x: left + 26, y: top + 25 },
    { name: 'row4Bar', x: left + 4, y: top + 35 },
    { name: 'row4Tail', x: left + 12, y: top + 35 },
    { name: 'divider1InsideBar', x: left + 20, y: top + 10 },
    { name: 'divider1', x: left + 36, y: top + 10 },
    { name: 'divider2', x: left + 36, y: top + 20 },
    { name: 'divider3', x: left + 36, y: top + 30 },
  ]
  const pixels = await sampleCanvasPixels(page, canvas, samples)
  const isBlue200 = (pixel: CanvasPixel) => pixelRgbDistance(pixel, [146, 191, 219, 255]) < 36
  const isBlue400 = (pixel: CanvasPixel) => pixelRgbDistance(pixel, [67, 133, 190, 255]) < 48
  const isBarTone = (pixel: CanvasPixel) => isBlue200(pixel) || isBlue400(pixel)
  const isPaper = (pixel: CanvasPixel) => pixelRgbDistance(pixel, [255, 252, 240, 255]) < 12
  const isUi2 = (pixel: CanvasPixel) => pixelRgbDistance(pixel, [218, 216, 206, 255]) < 24

  expect({
    row1: [isBlue200(pixels.row1Bar), isPaper(pixels.row1Tail)],
    row2: [
      isBlue200(pixels.row2Bar),
      [pixels.row2EdgeA, pixels.row2EdgeB, pixels.row2EdgeC].some(isBlue400),
      isPaper(pixels.row2Tail),
    ],
    row3: [isBlue200(pixels.row3Bar), isPaper(pixels.row3Tail)],
    row4: [isBlue200(pixels.row4Bar), isPaper(pixels.row4Tail)],
    dividers: [
      isBarTone(pixels.divider1InsideBar),
      isUi2(pixels.divider1),
      isUi2(pixels.divider2),
      isUi2(pixels.divider3),
    ],
  }).toEqual({
    row1: [true, true],
    row2: [true, true, true],
    row3: [true, true],
    row4: [true, true],
    dividers: [true, true, true, true],
  })
})

test('SVG SDF gate labels keep palette and circuit glyph weight aligned', async ({ page }) => {
  await page.setViewportSize({ width: 1001, height: 800 })
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H'], ['X'], ['Y'], ['Z'], ['X^½'], ['S'], ['S†'], ['T'], ['T†'], ['P'], ['Rx'], ['Ry'], ['Rz'], ['QFT2'], ['QFT†2']] })))

  await waitForStartupReady(page, { waitForStateVector: true })
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }

  const EGUI_PANEL_MARGIN = 8
  const gateSize = UI_CONSTANTS.GATE_SIZE
  const labels = [
    { name: 'H', paletteIndex: 0, circuitIndex: 0, circuitYOffset: 0 },
    { name: 'X', paletteIndex: 1, circuitIndex: 1, circuitYOffset: 0 },
    { name: 'Y', paletteIndex: 2, circuitIndex: 2, circuitYOffset: 0 },
    { name: 'Z', paletteIndex: 3, circuitIndex: 3, circuitYOffset: 0 },
    { name: 'SqrtX', paletteIndex: 4, circuitIndex: 4, circuitYOffset: 0 },
    { name: 'S', paletteIndex: 5, circuitIndex: 5, circuitYOffset: 0 },
    { name: 'SDagger', paletteIndex: 6, circuitIndex: 6, circuitYOffset: 0 },
    { name: 'T', paletteIndex: 7, circuitIndex: 7, circuitYOffset: 0 },
    { name: 'TDagger', paletteIndex: 8, circuitIndex: 8, circuitYOffset: 0 },
    { name: 'Phase', paletteIndex: 9, circuitIndex: 9, circuitYOffset: 0 },
    { name: 'RX', paletteIndex: 10, circuitIndex: 10, circuitYOffset: 0 },
    { name: 'RY', paletteIndex: 11, circuitIndex: 11, circuitYOffset: 0 },
    { name: 'RZ', paletteIndex: 12, circuitIndex: 12, circuitYOffset: 0 },
    { name: 'QFT', paletteIndex: 22, circuitIndex: 13, circuitYOffset: UI_CONSTANTS.LINE_GAP / 2 },
    { name: 'QFTDagger', paletteIndex: 23, circuitIndex: 14, circuitYOffset: UI_CONSTANTS.LINE_GAP / 2 },
  ] as const
  const centers = Object.fromEntries(labels.flatMap(({ name, paletteIndex, circuitIndex, circuitYOffset }) => {
    const paletteCenter = getPaletteGateCenter(box.width, paletteIndex)
    return [
      [`palette${name}`, { x: paletteCenter.x, y: EGUI_PANEL_MARGIN + paletteCenter.y }],
      [`circuit${name}`, {
        x: EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE + UI_CONSTANTS.SLOT_SPACING * circuitIndex,
        y: EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_Y + circuitYOffset,
      }],
    ]
  }))
  const screenshot = await canvas.screenshot({ type: 'png' })
  const metrics = await page.evaluate<
    Record<string, { count: number; width: number; height: number }>,
    { base64: string; cssWidth: number; cssHeight: number; gateSize: number; centers: Record<string, Point> }
  >(async ({ base64, cssWidth, cssHeight, gateSize, centers }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${base64}`
    await new Promise((resolve, reject) => {
      img.onload = () => resolve(null)
      img.onerror = () => reject(new Error('Failed to decode screenshot'))
    })

    const probe = document.createElement('canvas')
    probe.width = img.width
    probe.height = img.height
    const ctx = probe.getContext('2d')
    if (!ctx) {
      throw new Error('expected 2d context')
    }
    ctx.drawImage(img, 0, 0)
    const scaleX = img.width / cssWidth
    const scaleY = img.height / cssHeight
    const measure = (name: string, { x: cx, y: cy }: Point) => {
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      let count = 0
      const left = cx - gateSize / 2
      const top = cy - gateSize / 2
      const isCircularBody = name.endsWith('X') || name.endsWith('Phase')
      const circleCenter = gateSize / 2
      const circleRadius = gateSize / 2 - 1
      for (let y = 4; y < gateSize - 4; y += 1) {
        for (let x = 4; x < gateSize - 4; x += 1) {
          if (isCircularBody) {
            const dx = x - circleCenter
            const dy = y - circleCenter
            if (Math.sqrt(dx * dx + dy * dy) > circleRadius) continue
          }
          const [r, g, b, a] = ctx.getImageData(Math.floor((left + x) * scaleX), Math.floor((top + y) * scaleY), 1, 1).data
          const isLabelInk = a > 128 && r > 245 && g > 243 && b > 232
          if (isLabelInk) {
            count += 1
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
          }
        }
      }
      return { count, width: maxX - minX + 1, height: maxY - minY + 1 }
    }
    return Object.fromEntries(Object.entries(centers).map(([name, center]) => [name, measure(name, center)]))
  }, { base64: screenshot.toString('base64'), cssWidth: box.width, cssHeight: box.height, gateSize, centers })

  expect(metrics).toEqual({
    paletteH: { count: 44, width: 12, height: 16 },
    circuitH: { count: 44, width: 12, height: 16 },
    paletteX: { count: 36, width: 10, height: 10 },
    circuitX: { count: 36, width: 10, height: 10 },
    paletteY: { count: 38, width: 12, height: 16 },
    circuitY: { count: 38, width: 12, height: 16 },
    paletteZ: { count: 40, width: 12, height: 16 },
    circuitZ: { count: 40, width: 12, height: 16 },
    paletteSqrtX: { count: 65, width: 25, height: 19 },
    circuitSqrtX: { count: 65, width: 25, height: 19 },
    paletteS: { count: 58, width: 12, height: 18 },
    circuitS: { count: 58, width: 12, height: 18 },
    paletteSDagger: { count: 58, width: 12, height: 18 },
    circuitSDagger: { count: 58, width: 12, height: 18 },
    paletteT: { count: 42, width: 12, height: 16 },
    circuitT: { count: 42, width: 12, height: 16 },
    paletteTDagger: { count: 42, width: 12, height: 16 },
    circuitTDagger: { count: 42, width: 12, height: 16 },
    palettePhase: { count: 45, width: 14, height: 20 },
    circuitPhase: { count: 45, width: 14, height: 20 },
    paletteRX: { count: 61, width: 21, height: 12 },
    circuitRX: { count: 61, width: 21, height: 12 },
    paletteRY: { count: 43, width: 20, height: 12 },
    circuitRY: { count: 43, width: 20, height: 12 },
    paletteRZ: { count: 61, width: 20, height: 12 },
    circuitRZ: { count: 61, width: 20, height: 12 },
    paletteQFT: { count: 91, width: 32, height: 14 },
    circuitQFT: { count: 91, width: 32, height: 14 },
    paletteQFTDagger: { count: 92, width: 32, height: 20 },
    circuitQFTDagger: { count: 92, width: 32, height: 20 },
  })
})

test('palette panel keeps its corners and shadow while dragging', async ({ page }) => {
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

  const PALETTE_SIZE = UI_CONSTANTS.PALETTE_SIZE
  const PALETTE_GAP = UI_CONSTANTS.PALETTE_GAP
  const PALETTE_ROW_Y = UI_CONSTANTS.PALETTE_ROW_Y
  const PALETTE_ROW_GAP = UI_CONSTANTS.PALETTE_ROW_GAP
  const PALETTE_SECTION_GAP = UI_CONSTANTS.PALETTE_SECTION_GAP
  const PALETTE_SEPARATOR_WIDTH = UI_CONSTANTS.PALETTE_SEPARATOR_WIDTH
  const PALETTE_DISPLAY_COLUMNS = UI_CONSTANTS.PALETTE_DISPLAY_COLUMNS
  const PALETTE_PADDING_X = UI_CONSTANTS.PALETTE_PADDING_X
  const PALETTE_PADDING_Y = UI_CONSTANTS.PALETTE_PADDING_Y
  const PALETTE_ROW1_COUNT = 13
  const PALETTE_ROW2_COUNT = 9
  const row1Width = PALETTE_ROW1_COUNT * PALETTE_SIZE + (PALETTE_ROW1_COUNT - 1) * PALETTE_GAP
  const row2Width = PALETTE_ROW2_COUNT * PALETTE_SIZE + (PALETTE_ROW2_COUNT - 1) * PALETTE_GAP
  const gatesWidth = Math.max(row1Width, row2Width)
  const displayWidth = PALETTE_DISPLAY_COLUMNS * PALETTE_SIZE + (PALETTE_DISPLAY_COLUMNS - 1) * PALETTE_GAP
  const paletteWidth = gatesWidth + PALETTE_SECTION_GAP + PALETTE_SEPARATOR_WIDTH + PALETTE_SECTION_GAP + displayWidth
  const paletteHeight = 2 * PALETTE_SIZE + PALETTE_ROW_GAP
  const paletteStartX = Math.round(cssWidth / 2 - paletteWidth / 2)
  const paletteRect = {
    x: paletteStartX - PALETTE_PADDING_X,
    y: PALETTE_ROW_Y - PALETTE_PADDING_Y,
    width: paletteWidth + PALETTE_PADDING_X * 2,
    height: paletteHeight + PALETTE_PADDING_Y * 2,
  }
  const hSource = getPaletteGateCenter(cssWidth, 0)
  const dragTarget = { x: hSource.x + 80, y: hSource.y + 80 }
  const panelPoints = [
    { name: 'corner', x: paletteRect.x + 2, y: paletteRect.y + 2 },
    { name: 'fill', x: paletteRect.x + 24, y: paletteRect.y + 24 },
    { name: 'shadow', x: paletteRect.x + paletteRect.width / 2, y: paletteRect.y + paletteRect.height + 10 },
    { name: 'background', x: paletteRect.x - 20, y: paletteRect.y + paletteRect.height + 10 },
  ]

  const beforeDrag = await sampleCanvasPixels(page, canvas, panelPoints)

  await dragPointer(page, hSource, dragTarget, 6, false)
  await page.waitForTimeout(50)
  const duringDrag = await sampleCanvasPixels(page, canvas, panelPoints)

  const stablePanelParts = ['corner', 'fill'].map((name) => {
    const before = beforeDrag[name]
    const during = duringDrag[name]
    const diff = Math.abs(before[0] - during[0]) + Math.abs(before[1] - during[1]) + Math.abs(before[2] - during[2])
    return diff < 40
  })
  const shadowBrightness = duringDrag.shadow[0] + duringDrag.shadow[1] + duringDrag.shadow[2]
  const backgroundBrightness = duringDrag.background[0] + duringDrag.background[1] + duringDrag.background[2]
  expect({
    stablePanelParts,
    cornerDiffersFromFill: pixelRgbDistance(duringDrag.corner, duringDrag.fill) > 10,
    shadowVisible: Math.abs(shadowBrightness - backgroundBrightness) > 10,
  }).toEqual({ stablePanelParts: [true, true], cornerDiffersFromFill: true, shadowVisible: true })

  await page.mouse.up()
})

test('palette control gate keeps its icon while dragging', async ({ page }) => {
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

  const PALETTE_SIZE = UI_CONSTANTS.PALETTE_SIZE
  const dragSource = getPaletteGateCenter(cssWidth, 0)
  const dragTarget = { x: dragSource.x + 80, y: dragSource.y + 80 }
  const controlCenter = getPaletteGateCenter(cssWidth, 14)
  const controlRect = {
    x: controlCenter.x - PALETTE_SIZE / 2,
    y: controlCenter.y - PALETTE_SIZE / 2,
  }
  const signaturePoints = [
    { name: 'center', x: controlRect.x + PALETTE_SIZE / 2, y: controlRect.y + PALETTE_SIZE / 2 },
    { name: 'top', x: controlRect.x + PALETTE_SIZE / 2, y: controlRect.y + 6 },
    { name: 'bottom', x: controlRect.x + PALETTE_SIZE / 2, y: controlRect.y + PALETTE_SIZE - 6 },
    { name: 'left', x: controlRect.x + 6, y: controlRect.y + PALETTE_SIZE / 2 },
    { name: 'right', x: controlRect.x + PALETTE_SIZE - 6, y: controlRect.y + PALETTE_SIZE / 2 },
  ]

  const beforeDrag = await sampleCanvasPixels(page, canvas, signaturePoints)

  await dragPointer(page, dragSource, dragTarget, 6, false)
  await page.waitForTimeout(50)
  const duringDrag = await sampleCanvasPixels(page, canvas, signaturePoints)

  const stableIconPixels = Object.keys(beforeDrag).map((name) => {
    const before = beforeDrag[name]
    const during = duringDrag[name]
    const diff = Math.abs(before[0] - during[0]) + Math.abs(before[1] - during[1]) + Math.abs(before[2] - during[2])
    return diff < 40
  })
  expect(stableIconPixels).toEqual(Object.keys(beforeDrag).map(() => true))

  await page.mouse.up()
})

test('control gate uses the qni-style standalone circular dot', async ({ page }) => {
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

  const palettePos = getPaletteGateCenter(cssWidth, 14)
  const controlCenter = { x: palettePos.x, y: palettePos.y + 8 }
  const signaturePoints = [
    { name: 'center', x: controlCenter.x, y: controlCenter.y },
    { name: 'inner-left', x: controlCenter.x - 4, y: controlCenter.y },
    { name: 'inner-right', x: controlCenter.x + 4, y: controlCenter.y },
    { name: 'inner-top', x: controlCenter.x, y: controlCenter.y - 4 },
    { name: 'inner-bottom', x: controlCenter.x, y: controlCenter.y + 4 },
    { name: 'outside-left', x: controlCenter.x - 10, y: controlCenter.y },
    { name: 'outside-right', x: controlCenter.x + 10, y: controlCenter.y },
    { name: 'outside-top', x: controlCenter.x, y: controlCenter.y - 10 },
    { name: 'outside-bottom', x: controlCenter.x, y: controlCenter.y + 10 },
  ] satisfies PixelSamplePoint[]

  const pixels = await sampleCanvasPixels(page, canvas, signaturePoints)
  const isControlFill = ([r, g, b]: CanvasPixel): boolean => r < 90 && g > 120 && b > 100 && b < 180

  expect({
    filled: ['center', 'inner-left', 'inner-right', 'inner-top', 'inner-bottom'].map((name) => isControlFill(pixels[name])),
    outside: ['outside-left', 'outside-right', 'outside-top', 'outside-bottom'].map((name) => isControlFill(pixels[name])),
  }).toEqual({ filled: [true, true, true, true, true], outside: [false, false, false, false] })
})

test('anti-control gate uses the qni-style open circular dot', async ({ page }) => {
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

  const palettePos = getPaletteGateCenter(cssWidth, 15)
  const antiControlCenter = { x: palettePos.x, y: palettePos.y + 8 }
  const signaturePoints: PixelSamplePoint[] = [
    { name: 'center', x: antiControlCenter.x, y: antiControlCenter.y },
    { name: 'outside-left', x: antiControlCenter.x - 12, y: antiControlCenter.y },
    { name: 'outside-right', x: antiControlCenter.x + 12, y: antiControlCenter.y },
  ]
  for (let dy = -8; dy <= 8; dy += 2) {
    for (let dx = -8; dx <= 8; dx += 2) {
      if (dx === 0 && dy === 0) {
        continue
      }
      signaturePoints.push({ name: `ring-${dx},${dy}`, x: antiControlCenter.x + dx, y: antiControlCenter.y + dy })
    }
  }

  const pixels = await sampleCanvasPixels(page, canvas, signaturePoints)
  const isAntiControlStroke = ([r, g, b]: CanvasPixel): boolean => r < 90 && g > 120 && b > 100 && b < 180

  const ringStrokeCount = signaturePoints
    .filter(({ name }) => name.startsWith('ring-'))
    .filter(({ name }) => isAntiControlStroke(pixels[name])).length
  expect({
    centerOpen: isAntiControlStroke(pixels.center),
    ringVisible: ringStrokeCount >= 8,
    outside: ['outside-left', 'outside-right'].map((name) => isAntiControlStroke(pixels[name])),
  }).toEqual({ centerOpen: false, ringVisible: true, outside: [false, false] })
})

const CIRCUIT_BACKGROUND: CanvasPixel = [242, 240, 229, 255]
const CIRCUIT_WIRE: CanvasPixel = [218, 216, 206, 255]

const openPlacedAntiControlCircuit = async (page: Page) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['◦', 'X']] })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const EGUI_PANEL_MARGIN = 8
  const antiControlCenter: Point = {
    x: EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE,
    y: EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_Y,
  }
  return { canvas, antiControlCenter }
}

test('placed anti-control masks the qubit wire in its hollow center', async ({ page }) => {
  const { canvas, antiControlCenter } = await openPlacedAntiControlCircuit(page)
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'center', x: antiControlCenter.x, y: antiControlCenter.y },
  ])

  expect(pixelRgbDistance(pixels.center, CIRCUIT_BACKGROUND) < 24).toBe(true)
})

test('placed anti-control keeps the left qubit wire visible', async ({ page }) => {
  const { canvas, antiControlCenter } = await openPlacedAntiControlCircuit(page)
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'wire-left', x: antiControlCenter.x - 12, y: antiControlCenter.y },
  ])

  expect(pixelRgbDistance(pixels['wire-left'], CIRCUIT_WIRE) < 48).toBe(true)
})

test('placed anti-control keeps the right qubit wire visible', async ({ page }) => {
  const { canvas, antiControlCenter } = await openPlacedAntiControlCircuit(page)
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'wire-right', x: antiControlCenter.x + 12, y: antiControlCenter.y },
  ])

  expect(pixelRgbDistance(pixels['wire-right'], CIRCUIT_WIRE) < 48).toBe(true)
})

test('placed anti-control keeps the lower connector visible', async ({ page }) => {
  const { canvas, antiControlCenter } = await openPlacedAntiControlCircuit(page)
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'connector-below', x: antiControlCenter.x, y: antiControlCenter.y + 16 },
  ])

  expect(isRegularGateFill(pixels['connector-below'])).toBe(true)
})

test('placed anti-control keeps the connector continuous toward the target', async ({ page }) => {
  const { canvas, antiControlCenter } = await openPlacedAntiControlCircuit(page)
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'connector-mid', x: antiControlCenter.x, y: antiControlCenter.y + 24 },
  ])

  expect(isRegularGateFill(pixels['connector-mid'])).toBe(true)
})

test('placed anti-control keeps its ring visible after masking the hollow center', async ({ page }) => {
  const { canvas, antiControlCenter } = await openPlacedAntiControlCircuit(page)
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'ring-left', x: antiControlCenter.x - 6, y: antiControlCenter.y },
  ])

  expect(isRegularGateFill(pixels['ring-left'])).toBe(true)
})

test('control and anti-control have matching outer diameters', async ({ page }) => {
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

  const centerFor = (index: number): Point => {
    const pos = getPaletteGateCenter(cssWidth, index)
    return { x: pos.x, y: pos.y + 8 }
  }
  const screenshot = await canvas.screenshot({ type: 'png' })

  const bounds = await page.evaluate<
    Record<string, { width: number; height: number }>,
    { base64: string; cssWidth: number; cssHeight: number; centers: Record<string, Point> }
  >(async ({ base64, cssWidth: width, cssHeight: height, centers }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${base64}`
    await new Promise((resolve, reject) => {
      img.onload = () => resolve(null)
      img.onerror = () => reject(new Error('Failed to decode screenshot'))
    })

    const probe = document.createElement('canvas')
    probe.width = img.width
    probe.height = img.height
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      throw new Error('2D canvas unavailable')
    }
    ctx.drawImage(img, 0, 0)

    const scaleX = img.width / width
    const scaleY = img.height / height
    const sample = (x: number, y: number): CanvasPixel => {
      const data = ctx.getImageData(Math.floor(x * scaleX), Math.floor(y * scaleY), 1, 1).data
      return [data[0], data[1], data[2], data[3]]
    }
    const isControlGreen = ([r, g, b]: CanvasPixel): boolean => r < 90 && g > 120 && b > 100 && b < 180

    return Object.fromEntries(Object.entries(centers).map(([name, center]) => {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let y = center.y - 12; y <= center.y + 12; y += 1) {
        for (let x = center.x - 12; x <= center.x + 12; x += 1) {
          if (!isControlGreen(sample(x, y))) {
            continue
          }
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
        }
      }
      return [name, { width: maxX - minX + 1, height: maxY - minY + 1 }]
    }))
  }, {
    base64: screenshot.toString('base64'),
    cssWidth,
    cssHeight,
    centers: {
      control: centerFor(14),
      antiControl: centerFor(15),
    },
  })

  expect({
    widthAligned: Math.abs(bounds.control.width - bounds.antiControl.width) <= 1,
    heightAligned: Math.abs(bounds.control.height - bounds.antiControl.height) <= 1,
  }).toEqual({ widthAligned: true, heightAligned: true })
})
