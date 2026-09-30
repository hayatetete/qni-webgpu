import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  DRAG_PREVIEW_FILL,
  dragPointer,
  getPaletteGateCenter,
  pixelRgbDistance,
  readAmplitudeCell,
  sampleCanvasPixels,
  UI_CONSTANTS,
  waitForStartupReady,
  waitForValue,
  type AmplitudeCell,
} from './support/web-spec-helpers'

const GATE_SIZE = UI_CONSTANTS.GATE_SIZE
const LINE_LEFT_OFFSET = UI_CONSTANTS.LINE_LEFT_OFFSET
const LINE_Y = UI_CONSTANTS.LINE_Y
const AMPLITUDE_PALETTE_INDEX = 24
const AMPLITUDE_SURFACE: [number, number, number, number] = [255, 252, 240, 255]
const AMPLITUDE_DISK: [number, number, number, number] = [146, 191, 219, 255]
const AMPLITUDE_DISK_BORDER: [number, number, number, number] = [67, 133, 190, 255]
const AMPLITUDE_HOVER_RING: [number, number, number, number] = [139, 126, 200, 255]
const SPAN_RESIZE_HANDLE_BG: [number, number, number, number] = [58, 169, 159, 255]
const AMPLITUDE_ICON_NEEDLE: [number, number, number, number] = [16, 15, 15, 255]
const AMPLITUDE_NONZERO_OUTLINE: [number, number, number, number] = [111, 110, 105, 255]
const FLEXOKI_TX_3: [number, number, number, number] = [183, 181, 172, 255]
const EGUI_PANEL_MARGIN = 8
const amplitudeFirstCellCenterX = (column: number): number =>
  LINE_LEFT_OFFSET + GATE_SIZE + UI_CONSTANTS.SLOT_SPACING * column + (UI_CONSTANTS.SLOT_SPACING - GATE_SIZE) / 2
const amplitudeCellCenterX = (column: number, cell: number): number =>
  amplitudeFirstCellCenterX(column) + GATE_SIZE * cell
const amplitudeCircleBackgroundProbeXs = (column: number): number[] =>
  Array.from({ length: 9 }, (_, index) => amplitudeFirstCellCenterX(column) + GATE_SIZE * 0.6 + index)
const AMPLITUDE_ZERO_OUTLINE: [number, number, number, number] = [218, 216, 206, 255]
const circuitHash = (cols: unknown[]): string => encodeURIComponent(JSON.stringify({ cols }))
const readCircuitColsFromHash = (url: string): unknown[] => JSON.parse(decodeURIComponent(new URL(url).hash.slice(1))).cols
const waitForHashCols = async (page: { url(): string; waitForTimeout(ms: number): Promise<void> }, expected: unknown[]): Promise<void> => {
  const expectedJson = JSON.stringify(expected)
  await waitForValue(
    () => Promise.resolve(JSON.stringify(readCircuitColsFromHash(page.url()))),
    (seen) => seen === expectedJson,
    `URL hash columns did not become ${expectedJson}`,
  )
}

const waitForAmplitudeCell = async (
  page: Parameters<typeof readAmplitudeCell>[0],
  gateId: number,
  outcome: number,
): Promise<AmplitudeCell> => {
  const cell = await waitForValue(
    () => readAmplitudeCell(page, gateId, outcome),
    (value) => value !== null,
    `Amplitude cell ${gateId}:${outcome} did not become available`,
  )
  if (!cell) throw new Error(`Amplitude cell ${gateId}:${outcome} is null`)
  return cell
}

const sampleUnsnappedAmps1DragPixel = async (
  page: Page,
  offset: { x: number; y: number },
  targetOffset: { x: number; y: number } = { x: -120, y: 60 },
) => {
  await page.goto('/')
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const source = getPaletteGateCenter(box.width, AMPLITUDE_PALETTE_INDEX)
  const target = { x: source.x + targetOffset.x, y: source.y + targetOffset.y }
  await dragPointer(page, source, target, 6, false)
  const samples = await sampleCanvasPixels(page, canvas, [
    { name: 'probe', x: target.x + offset.x, y: target.y + offset.y },
  ])
  await page.mouse.up()

  return samples.probe
}

const measureColorRunWidthAtY = async (
  page: Page,
  locator: Locator,
  y: number,
  target: readonly [number, number, number, number],
): Promise<number> => {
  const screenshot = await locator.screenshot({ type: 'png' })
  const box = await locator.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  return page.evaluate(
    async ({ base64, cssWidth, cssHeight, target, y }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${base64}`
      await new Promise((resolve, reject) => {
        img.onload = () => resolve(null)
        img.onerror = () => reject(new Error('Failed to decode screenshot'))
      })
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return 0
      ctx.drawImage(img, 0, 0)
      const scaleX = img.width / cssWidth
      const scaleY = img.height / cssHeight
      const row = Math.max(0, Math.min(img.height - 1, Math.floor(y * scaleY)))
      let first = Number.POSITIVE_INFINITY
      let last = Number.NEGATIVE_INFINITY
      const rowPixels = ctx.getImageData(0, row, img.width, 1).data
      for (let x = 0; x < img.width; x += 1) {
        const offset = x * 4
        const distance =
          Math.abs(rowPixels[offset] - target[0]) +
          Math.abs(rowPixels[offset + 1] - target[1]) +
          Math.abs(rowPixels[offset + 2] - target[2])
        if (distance <= 40) {
          first = Math.min(first, x)
          last = Math.max(last, x)
        }
      }
      return last >= first ? Math.round((last - first + 1) / scaleX) : 0
    },
    {
      base64: screenshot.toString('base64'),
      cssWidth: box.width,
      cssHeight: box.height,
      target,
      y,
    },
  )
}

test.describe.configure({ mode: 'serial' })

test.describe('Amplitude Display', () => {
  test('palette Amps symbol drops as Amps1', async ({ page }) => {
    await page.goto('/')
    await waitForStartupReady(page, { waitForStateVector: true })

    const canvas = page.locator('#egui-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('expected egui canvas to be measurable')
    const source = getPaletteGateCenter(box.width, AMPLITUDE_PALETTE_INDEX)
    await dragPointer(page, source, { x: LINE_LEFT_OFFSET + GATE_SIZE, y: LINE_Y })
    await waitForHashCols(page, [['Amps1']])

    expect(readCircuitColsFromHash(page.url())).toEqual([['Amps1']])
  })

  test('palette Amps icon draws the Q-like phase tail', async ({ page }) => {
    await page.goto('/')
    await waitForStartupReady(page, { waitForStateVector: true })

    const canvas = page.locator('#egui-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('expected egui canvas to be measurable')
    const center = getPaletteGateCenter(box.width, AMPLITUDE_PALETTE_INDEX)
    const samples = await sampleCanvasPixels(page, canvas, [
      { name: 'tail', x: center.x + 8, y: center.y + 16 },
    ])

    expect(pixelRgbDistance(samples.tail, AMPLITUDE_ICON_NEEDLE)).toBeLessThanOrEqual(90)
  })

  test('palette Amps icon omits the square matrix frame', async ({ page }) => {
    await page.goto('/')
    await waitForStartupReady(page, { waitForStateVector: true })

    const canvas = page.locator('#egui-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('expected egui canvas to be measurable')
    const center = getPaletteGateCenter(box.width, AMPLITUDE_PALETTE_INDEX)
    const samples = await sampleCanvasPixels(page, canvas, [
      { name: 'corner', x: center.x - 19, y: center.y - 19 },
    ])

    expect(pixelRgbDistance(samples.corner, AMPLITUDE_SURFACE)).toBeLessThanOrEqual(48)
  })

  test('palette Amps icon keeps the frame edge clear', async ({ page }) => {
    await page.goto('/')
    await waitForStartupReady(page, { waitForStateVector: true })

    const canvas = page.locator('#egui-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('expected egui canvas to be measurable')
    const center = getPaletteGateCenter(box.width, AMPLITUDE_PALETTE_INDEX)
    const samples = await sampleCanvasPixels(page, canvas, [
      { name: 'frameEdge', x: center.x - 20, y: center.y },
    ])

    expect(pixelRgbDistance(samples.frameEdge, AMPLITUDE_SURFACE)).toBeLessThan(48)
  })

  test('palette Amps icon keeps the circle near the frame', async ({ page }) => {
    await page.goto('/')
    await waitForStartupReady(page, { waitForStateVector: true })

    const canvas = page.locator('#egui-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('expected egui canvas to be measurable')
    const center = getPaletteGateCenter(box.width, AMPLITUDE_PALETTE_INDEX)
    const samples = await sampleCanvasPixels(page, canvas, [
      { name: 'nearCircle', x: center.x - 18, y: center.y },
    ])

    expect(pixelRgbDistance(samples.nearCircle, AMPLITUDE_SURFACE)).toBeGreaterThan(80)
  })

  test('placed Amps1 keeps the matrix frame edge clear', async ({ page }) => {
    await page.goto(`/#${circuitHash([['H'], ['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 2, 0)

    const canvas = page.locator('#egui-canvas')
    const left = EGUI_PANEL_MARGIN + amplitudeFirstCellCenterX(1) - GATE_SIZE / 2
    const samples = await sampleCanvasPixels(page, canvas, [
      { name: 'frameEdge', x: left, y: LINE_Y },
    ])

    expect(pixelRgbDistance(samples.frameEdge, AMPLITUDE_ZERO_OUTLINE)).toBeLessThan(48)
  })

  test('placed Amps1 keeps the circle near the matrix frame', async ({ page }) => {
    await page.goto(`/#${circuitHash([['H'], ['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 2, 0)

    const canvas = page.locator('#egui-canvas')
    const left = EGUI_PANEL_MARGIN + amplitudeFirstCellCenterX(1) - GATE_SIZE / 2
    const samples = await sampleCanvasPixels(page, canvas, [
      { name: 'nearCircle', x: left + 3, y: LINE_Y },
    ])

    expect(pixelRgbDistance(samples.nearCircle, AMPLITUDE_SURFACE)).toBeGreaterThan(80)
  })

  test('unsnapped dragged Amps1 keeps the left empty circle interior white', async ({ page }) => {
    const pixel = await sampleUnsnappedAmps1DragPixel(page, { x: 8, y: 0 })

    expect(pixelRgbDistance(pixel, AMPLITUDE_SURFACE)).toBeLessThanOrEqual(60)
  })

  test('unsnapped dragged Amps1 keeps the right empty circle interior white', async ({ page }) => {
    const pixel = await sampleUnsnappedAmps1DragPixel(page, { x: 48, y: 0 })

    expect(pixelRgbDistance(pixel, AMPLITUDE_SURFACE)).toBeLessThanOrEqual(60)
  })

  test('unsnapped dragged Amps1 keeps the matrix background purple outside circles', async ({ page }) => {
    const pixel = await sampleUnsnappedAmps1DragPixel(page, { x: 28, y: 0 })

    expect(pixelRgbDistance(pixel, DRAG_PREVIEW_FILL)).toBeLessThanOrEqual(90)
  })

  test('unsnapped dragged Amps1 draws the live-display zero outline', async ({ page }) => {
    const pixel = await sampleUnsnappedAmps1DragPixel(page, { x: 30, y: 2 })

    expect(pixelRgbDistance(pixel, AMPLITUDE_ZERO_OUTLINE)).toBeLessThanOrEqual(40)
  })

  test('unsnapped dragged Amps1 stays visible above the palette layer', async ({ page }) => {
    const pixel = await sampleUnsnappedAmps1DragPixel(page, { x: 28, y: 0 }, { x: -40, y: 0 })

    expect(pixelRgbDistance(pixel, DRAG_PREVIEW_FILL)).toBeLessThanOrEqual(90)
  })

  test('unsnapped palette Amps1 drag keeps an existing Amps1 display rendered', async ({ page }) => {
    await page.goto(`/#${circuitHash([['H'], ['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 2, 0)

    const canvas = page.locator('#egui-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('expected egui canvas to be measurable')
    const source = getPaletteGateCenter(box.width, AMPLITUDE_PALETTE_INDEX)
    await dragPointer(page, source, { x: source.x - 40, y: source.y }, 6, false)
    const samples = await sampleCanvasPixels(page, canvas, [
      { name: 'existingDisk', x: amplitudeCellCenterX(1, 0), y: LINE_Y },
    ])
    await page.mouse.up()

    expect(pixelRgbDistance(samples.existingDisk, AMPLITUDE_DISK)).toBeLessThanOrEqual(90)
  })

  test('snapped dragged Amps1 renders live GPU circles before drop', async ({ page }) => {
    await page.goto('/')
    await waitForStartupReady(page, { waitForStateVector: true })

    const canvas = page.locator('#egui-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('expected egui canvas to be measurable')
    const source = getPaletteGateCenter(box.width, AMPLITUDE_PALETTE_INDEX)
    await dragPointer(page, source, { x: LINE_LEFT_OFFSET + GATE_SIZE, y: LINE_Y }, 6, false)
    await waitForAmplitudeCell(page, 1, 0)
    const samples = await sampleCanvasPixels(page, canvas, [
      { name: 'liveDisk', x: 170, y: 256 },
    ])
    await page.mouse.up()

    expect(pixelRgbDistance(samples.liveDisk, AMPLITUDE_DISK)).toBeLessThanOrEqual(90)
  })

  test('snapped dragged Amps1 paints the gap around circles purple', async ({ page }) => {
    await page.goto('/')
    await waitForStartupReady(page, { waitForStateVector: true })

    const canvas = page.locator('#egui-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('expected egui canvas to be measurable')
    const source = getPaletteGateCenter(box.width, AMPLITUDE_PALETTE_INDEX)
    await dragPointer(page, source, { x: LINE_LEFT_OFFSET + GATE_SIZE, y: LINE_Y }, 6, false)
    await waitForAmplitudeCell(page, 1, 0)
    const samples = await sampleCanvasPixels(
      page,
      canvas,
      amplitudeCircleBackgroundProbeXs(0).map((x, index) => ({ name: `circleGap${index}`, x, y: LINE_Y })),
    )
    await page.mouse.up()
    const purpleSampleCount = Object.values(samples).filter(
      (sample) => pixelRgbDistance(sample, DRAG_PREVIEW_FILL) <= 90,
    ).length

    expect(purpleSampleCount).toBeGreaterThan(0)
  })

  test('snapped dragged Amps1 keeps the empty circle interior white', async ({ page }) => {
    await page.goto('/')
    await waitForStartupReady(page, { waitForStateVector: true })

    const canvas = page.locator('#egui-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('expected egui canvas to be measurable')
    const source = getPaletteGateCenter(box.width, AMPLITUDE_PALETTE_INDEX)
    await dragPointer(page, source, { x: LINE_LEFT_OFFSET + GATE_SIZE, y: LINE_Y }, 6, false)
    await waitForAmplitudeCell(page, 1, 1)
    const samples = await sampleCanvasPixels(page, canvas, [
      { name: 'emptyCircleInterior', x: amplitudeCellCenterX(0, 1), y: LINE_Y },
    ])
    await page.mouse.up()

    expect(pixelRgbDistance(samples.emptyCircleInterior, AMPLITUDE_SURFACE)).toBeLessThanOrEqual(60)
  })

  test('snapped drag keeps a stationary Amps1 display rendered', async ({ page }) => {
    await page.goto(`/#${circuitHash([['H'], ['Amps1'], [], ['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })

    const canvas = page.locator('#egui-canvas')
    await waitForAmplitudeCell(page, 3, 0)
    await dragPointer(
      page,
      { x: amplitudeFirstCellCenterX(1), y: LINE_Y },
      { x: amplitudeFirstCellCenterX(1), y: LINE_Y + UI_CONSTANTS.LINE_GAP },
      6,
      false,
    )
    await page.waitForTimeout(100)
    const samples = await sampleCanvasPixels(page, canvas, [
      { name: 'stationaryDisk', x: amplitudeCellCenterX(3, 0), y: LINE_Y },
    ])
    await page.mouse.up()

    expect(pixelRgbDistance(samples.stationaryDisk, AMPLITUDE_DISK)).toBeLessThanOrEqual(90)
  })

  test('resizing Amps3 to Amps4 shifts the right display past the grown footprint', async ({ page }) => {
    await page.goto(`/#${circuitHash([['H'], ['Amps3'], [1], ['Amps2']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })

    const canvas = page.locator('#egui-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('expected egui canvas to be measurable')
    const gateHeight = (3 - 1) * UI_CONSTANTS.LINE_GAP + GATE_SIZE
    const gateWidth = UI_CONSTANTS.SLOT_SPACING + GATE_SIZE
    const handle = {
      x: EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + UI_CONSTANTS.SLOT_SPACING - GATE_SIZE / 2 + gateWidth / 2,
      y: EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2 + gateHeight + 9,
    }
    await page.mouse.move(box.x + handle.x, box.y + handle.y)
    await page.mouse.down()
    await page.mouse.move(box.x + handle.x, box.y + handle.y + UI_CONSTANTS.LINE_GAP, { steps: 8 })
    await page.mouse.up()
    await waitForHashCols(page, [['H'], ['Amps4'], [1], [1], [1], ['Amps2']])

    expect(readCircuitColsFromHash(page.url())).toEqual([['H'], ['Amps4'], [1], [1], [1], ['Amps2']])
  })

  test('Amps4 bottom handle renders at 60 percent of the body width', async ({ page }) => {
    await page.goto(`/#${circuitHash([['Amps4']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 1, 0)

    const canvas = page.locator('#egui-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('expected egui canvas to be measurable')
    const gateHeight = (4 - 1) * UI_CONSTANTS.LINE_GAP + GATE_SIZE
    const gateWidth = (4 - 1) * UI_CONSTANTS.SLOT_SPACING + GATE_SIZE
    await page.mouse.move(
      box.x + EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE - GATE_SIZE / 2 + gateWidth / 2,
      box.y + EGUI_PANEL_MARGIN + LINE_Y,
    )
    await page.waitForTimeout(300)
    const width = await measureColorRunWidthAtY(
      page,
      canvas,
      EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2 + gateHeight + 9,
      SPAN_RESIZE_HANDLE_BG,
    )

    expect(width).toBe(125)
  })

  test('Amps1 captures coherent GPU amplitudes after H', async ({ page }) => {
    await page.goto(`/#${circuitHash([['H'], ['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })

    const cell = await waitForAmplitudeCell(page, 2, 0)

    expect({
      re: Math.round(cell.re * 1000) / 1000,
      im: Math.round(cell.im * 1000) / 1000,
      quality: Math.round(cell.quality * 1000) / 1000,
      span: cell.span,
    }).toEqual({ re: 0.707, im: 0, quality: 1, span: 1 })
  })

  test('Amps1 emits the second basis amplitude after H', async ({ page }) => {
    await page.goto(`/#${circuitHash([['H'], ['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })

    const cell = await waitForAmplitudeCell(page, 2, 1)

    expect(Math.round(cell.re * 1000) / 1000).toBe(0.707)
  })

  test('full-span Amps disables phase locking', async ({ page }) => {
    await page.goto(`/#${circuitHash([['H'], ['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })

    const cell = await waitForAmplitudeCell(page, 2, 0)

    expect(cell.phaseLockIndex).toBe(0xffffffff)
  })

  test('partial-span Amps keeps deterministic phase lock enabled', async ({ page }) => {
    await page.goto(`/#${circuitHash([['H', 'H'], ['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })

    const cell = await waitForAmplitudeCell(page, 3, 0)

    expect(cell.phaseLockIndex).toBe(0)
  })

  test('controlled Amps filters amplitudes by column controls', async ({ page }) => {
    await page.goto(`/#${circuitHash([['H', 1], ['•', 'Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })

    const cell = await waitForAmplitudeCell(page, 3, 0)

    expect(Math.round(cell.re * 1000) / 1000).toBe(1)
  })

  test('post-measure Amps reads the collapsed GPU state', async ({ page }) => {
    await page.goto(`/#${circuitHash([['X'], ['Measure'], ['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })

    const cell = await waitForAmplitudeCell(page, 3, 1)

    expect(Math.round(cell.re * 1000) / 1000).toBe(1)
  })

  test('entangled Amps exposes incoherent quality below the coherent threshold', async ({ page }) => {
    await page.goto(`/#${circuitHash([['H'], ['•', 'X'], ['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })

    const cell = await waitForAmplitudeCell(page, 4, 0)

    expect(Math.round(cell.quality * 1000) / 1000).toBe(0.5)
  })

  test('Amps1 draws the zero-probability basis outline', async ({ page }) => {
    await page.goto(`/#${circuitHash([['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 1, 1)

    const samples = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
      { name: 'zeroOutline', x: 210, y: 237 },
    ])

    expect(pixelRgbDistance(samples.zeroOutline, AMPLITUDE_ZERO_OUTLINE)).toBeLessThanOrEqual(90)
  })

  test('Amps1 draws the probability disk inset border in dark blue', async ({ page }) => {
    await page.goto(`/#${circuitHash([['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 1, 0)

    const samples = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
      { name: 'diskBorder', x: EGUI_PANEL_MARGIN + amplitudeCellCenterX(0, 0) + 16, y: LINE_Y + 6 },
    ])

    expect(pixelRgbDistance(samples.diskBorder, AMPLITUDE_DISK_BORDER)).toBeLessThanOrEqual(90)
  })

  test('Amps1 leaves the non-zero outline outside the disk border', async ({ page }) => {
    await page.goto(`/#${circuitHash([['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 1, 0)

    const samples = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
      { name: 'nonZeroOutline', x: EGUI_PANEL_MARGIN + amplitudeCellCenterX(0, 0) + 17, y: LINE_Y + 6 },
    ])

    expect(pixelRgbDistance(samples.nonZeroOutline, AMPLITUDE_NONZERO_OUTLINE)).toBeLessThanOrEqual(90)
  })

  test('Amps1 keeps non-zero circle outline inside the matrix frame', async ({ page }) => {
    await page.goto(`/#${circuitHash([['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 1, 0)

    const samples = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
      { name: 'topFrame', x: 170, y: 236 },
    ])

    expect(pixelRgbDistance(samples.topFrame, AMPLITUDE_ZERO_OUTLINE)).toBeLessThanOrEqual(90)
  })

  test('Amps1 leaves the gap between adjacent circles unruled', async ({ page }) => {
    await page.goto(`/#${circuitHash([['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 1, 1)

    const samples = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
      { name: 'cellGap', x: 198, y: 256 },
    ])

    expect(pixelRgbDistance(samples.cellGap, AMPLITUDE_SURFACE)).toBeLessThanOrEqual(60)
  })

  test('hovering Amps1 colors the circle outline purple', async ({ page }) => {
    await page.goto(`/#${circuitHash([['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 1, 0)
    await page.mouse.move(170, 256)

    const samples = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
      { name: 'circleLeft', x: 160, y: 264 },
    ])

    expect(pixelRgbDistance(samples.circleLeft, AMPLITUDE_HOVER_RING)).toBeLessThanOrEqual(90)
  })

  test('hovering Amps1 shows the host hover frame', async ({ page }) => {
    await page.goto(`/#${circuitHash([['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 1, 0)
    await page.mouse.move(170, 256)

    const samples = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
      {
        name: 'hostFrame',
        x: amplitudeFirstCellCenterX(0) + GATE_SIZE * 0.7,
        y: LINE_Y - GATE_SIZE / 2 + 4,
      },
    ])

    expect(pixelRgbDistance(samples.hostFrame, AMPLITUDE_HOVER_RING)).toBeLessThanOrEqual(40)
  })

  test('Amps1 popup uses the shared top popover tail outline', async ({ page }) => {
    await page.goto(`/#${circuitHash([['H'], ['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 2, 0)

    const canvas = page.locator('#egui-canvas')
    const circleCenterX = EGUI_PANEL_MARGIN + amplitudeCellCenterX(1, 0)
    const circleRadius = GATE_SIZE / 2 - 1 - 1.5
    const tailApexY = LINE_Y - circleRadius - 4
    await page.mouse.move(circleCenterX, LINE_Y)
    await page.waitForTimeout(150)

    const points = []
    for (let x = -8; x <= 8; x += 1) {
      for (let y = 0; y <= 8; y += 1) {
        points.push({ name: `tail${x}_${y}`, x: circleCenterX + x, y: tailApexY + y })
      }
    }
    const pixels = await sampleCanvasPixels(page, canvas, points)
    const outlinePixels = Object.values(pixels).filter((pixel) => pixelRgbDistance(pixel, FLEXOKI_TX_3) <= 70).length

    expect(outlinePixels).toBeGreaterThanOrEqual(12)
  })

  test('Amps1 popup paints canonical header and metric rows', async ({ page }) => {
    await page.goto(`/#${circuitHash([['H'], ['Amps1']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 2, 0)

    const canvas = page.locator('#egui-canvas')
    const circleCenterX = EGUI_PANEL_MARGIN + amplitudeCellCenterX(1, 0)
    const circleRadius = GATE_SIZE / 2 - 1 - 1.5
    const popupLeft = circleCenterX - 296 / 2
    const popupTop = LINE_Y - circleRadius - 4 - 8 - 108
    await page.mouse.move(circleCenterX, LINE_Y)
    await page.waitForTimeout(150)

    const points = []
    for (let x = 16; x <= 276; x += 4) {
      for (let y = 12; y <= 92; y += 3) {
        points.push({ name: `content${x}_${y}`, x: popupLeft + x, y: popupTop + y })
      }
    }
    const pixels = await sampleCanvasPixels(page, canvas, points)
    const contentInk = Object.values(pixels).filter(([r, g, b]) => r < 130 && g < 130 && b < 130).length

    expect(contentInk).toBeGreaterThanOrEqual(45)
  })

  test('Amps10 keeps tiny non-zero amplitudes on the non-zero outline color', async ({ page }) => {
    const hColumn = Array.from({ length: 10 }, () => 'H')
    await page.goto(`/#${circuitHash([hColumn, ['Amps10']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 11, 0)

    const samples = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
      { name: 'tinyNonzeroOutline', x: 218, y: 247 },
    ])

    expect(pixelRgbDistance(samples.tinyNonzeroOutline, AMPLITUDE_NONZERO_OUTLINE)).toBeLessThanOrEqual(130)
  })

  test('Amps15 still draws visible tiny outcome circles', async ({ page }) => {
    const hColumn = Array.from({ length: 15 }, () => 'H')
    await page.goto(`/#${circuitHash([hColumn, ['Amps15']])}`)
    await waitForStartupReady(page, { waitForStateVector: true })
    await waitForAmplitudeCell(page, 16, 0)

    const samples = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
      { name: 'tinyCircle', x: 217, y: 245 },
    ])

    expect(pixelRgbDistance(samples.tinyCircle, AMPLITUDE_SURFACE)).toBeGreaterThan(90)
  })
})
