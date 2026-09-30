import { expect, test } from '@playwright/test'
import {
  dragPointer,
  getPaletteGateCenter,
  pixelRgbDistance,
  readProbabilityDistributions,
  readMeasurementOutcomes,
  readStateVector,
  sampleCanvasPixels,
  UI_CONSTANTS,
  waitForStartupReady,
  pollForValue,
  waitForValue,
} from './support/web-spec-helpers'

const GATE_SIZE = UI_CONSTANTS.GATE_SIZE
const SLOT_SPACING = UI_CONSTANTS.SLOT_SPACING
const LINE_LEFT_OFFSET = UI_CONSTANTS.LINE_LEFT_OFFSET
const LINE_Y = UI_CONSTANTS.LINE_Y
const LINE_GAP = UI_CONSTANTS.LINE_GAP
const EGUI_PANEL_MARGIN = 8
const PROBABILITY_PALETTE_INDEX = 20
const DENSE_PROBABILITY_HOVER_LINE_MIN_PIXELS = 40
const FLEXOKI_TX_3: [number, number, number, number] = [183, 181, 172, 255]
const readCircuitColsFromHash = (url: string): unknown[] => JSON.parse(decodeURIComponent(new URL(url).hash.slice(1))).cols

const waitForHashCols = async (page: { url(): string; waitForTimeout(ms: number): Promise<void> }, expected: unknown[]): Promise<void> => {
  const expectedJson = JSON.stringify(expected)
  await waitForValue(
    () => Promise.resolve(JSON.stringify(readCircuitColsFromHash(page.url()))),
    (seen) => seen === expectedJson,
    `URL hash columns did not become ${expectedJson}`,
  )
}

const waitForProbabilityDistributions = async (page: Parameters<typeof readProbabilityDistributions>[0]): Promise<number[]> => {
  const result = await waitForValue(
    () => readProbabilityDistributions(page),
    (entries) => entries.length > 0,
    'Probability probabilities did not become available',
  )
  return result[0].probabilities
}

const selectedColumnReadoutEvidence = async (page: Parameters<typeof readProbabilityDistributions>[0]) => {
  const [probabilityEntries, measurementEntries, state] = await Promise.all([
    readProbabilityDistributions(page),
    readMeasurementOutcomes(page),
    readStateVector(page),
  ])
  const probs = probabilityEntries[0]?.probabilities ?? []
  return {
    p0: Math.round((probs[0] ?? -1) * 1000) / 1000,
    p1: Math.round((probs[1] ?? -1) * 1000) / 1000,
    measurementCount: measurementEntries.length,
    selectedState: [
      Math.round(((state[0] as number | undefined) ?? -1) * 1000) / 1000,
      Math.round(((state[2] as number | undefined) ?? -1) * 1000) / 1000,
    ],
  }
}

const EXPECTED_SELECTED_COLUMN_READOUT = {
  p0: 0.5,
  p1: 0.5,
  measurementCount: 1,
  selectedState: [0.707, 0.707],
}

const GROVER_ORACLE_COL = ['Z', '•', '◦', '•', '•']
const GROVER_DIFFUSER_COLS = [
  ['H', 'H', 'H', 'H', 1],
  ['•', '•', '•', '•', 'X'],
  ['H', 'H', 'H', 'H', 1],
]
const GROVER_ITERATION_COLS = [GROVER_ORACLE_COL, ...GROVER_DIFFUSER_COLS, ['Probability5']]
const GROVER_COLS = [
  ['X', 'X', 'X', 'X', 'X'],
  ['H', 'H', 'H', 'H', 'H'],
  ['Probability5'],
  ...GROVER_ITERATION_COLS,
  ...GROVER_ITERATION_COLS,
  ...GROVER_ITERATION_COLS,
  ...GROVER_ITERATION_COLS,
]

const waitForProbabilityPercentLabelEvidence = async (
  page: Parameters<typeof sampleCanvasPixels>[0],
  canvas: Parameters<typeof sampleCanvasPixels>[1],
  span: number,
): Promise<{ textPixels: number; bboxHeight: number }> => {
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const gateHeight = (span - 1) * LINE_GAP + GATE_SIZE
  return await pollForValue(
    async () => {
      const screenshot = await canvas.screenshot({ type: 'png' })
      const box = await canvas.boundingBox()
      if (!box) throw new Error('expected egui canvas to be measurable')
      return await page.evaluate(
        async ({ base64, cssWidth, cssHeight, gateLeft, gateTop, gateHeight }) => {
          const img = new Image()
          img.src = `data:image/png;base64,${base64}`
          await new Promise((resolve, reject) => {
            img.onload = () => resolve(null)
            img.onerror = () => reject(new Error('Failed to decode screenshot'))
          })
          const c = document.createElement('canvas')
          c.width = img.width
          c.height = img.height
          const ctx = c.getContext('2d', { willReadFrequently: true })
          if (!ctx) return { textPixels: 0, bboxHeight: 0 }
          ctx.drawImage(img, 0, 0)
          const scaleX = img.width / cssWidth
          const scaleY = img.height / cssHeight
          let textPixels = 0
          let minY = Number.POSITIVE_INFINITY
          let maxY = Number.NEGATIVE_INFINITY
          for (let y = Math.floor((gateTop + 4) * scaleY); y <= Math.floor((gateTop + gateHeight - 4) * scaleY); y += 1) {
            for (let x = Math.floor((gateLeft + 8) * scaleX); x <= Math.floor((gateLeft + 31) * scaleX); x += 1) {
              const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
              if (r < 150 && g < 150 && b < 150) {
                textPixels += 1
                minY = Math.min(minY, y)
                maxY = Math.max(maxY, y)
              }
            }
          }
          return {
            textPixels,
            bboxHeight: Number.isFinite(minY) ? Math.round((maxY - minY + 1) / scaleY) : 0,
          }
        },
        { base64: screenshot.toString('base64'), cssWidth: box.width, cssHeight: box.height, gateLeft, gateTop, gateHeight },
      )
    },
    (last) => last.textPixels > 32
  )
}

const waitForProbabilityDecimalPointEvidence = async (
  page: Parameters<typeof sampleCanvasPixels>[0],
  canvas: Parameters<typeof sampleCanvasPixels>[1],
): Promise<{ decimalPixels: number }> => {
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  return await pollForValue(
    async () => {
      const screenshot = await canvas.screenshot({ type: 'png' })
      const box = await canvas.boundingBox()
      if (!box) throw new Error('expected egui canvas to be measurable')
      return await page.evaluate(
        async ({ base64, cssWidth, cssHeight, gateLeft, gateTop }) => {
          const img = new Image()
          img.src = `data:image/png;base64,${base64}`
          await new Promise((resolve, reject) => {
            img.onload = () => resolve(null)
            img.onerror = () => reject(new Error('Failed to decode screenshot'))
          })
          const c = document.createElement('canvas')
          c.width = img.width
          c.height = img.height
          const ctx = c.getContext('2d', { willReadFrequently: true })
          if (!ctx) return { decimalPixels: 0 }
          ctx.drawImage(img, 0, 0)
          const scaleX = img.width / cssWidth
          const scaleY = img.height / cssHeight
          let decimalPixels = 0
          for (let y = Math.floor((gateTop + 8) * scaleY); y <= Math.floor((gateTop + 19) * scaleY); y += 1) {
            for (let x = Math.floor((gateLeft + 22.0) * scaleX); x <= Math.floor((gateLeft + 23.8) * scaleX); x += 1) {
              const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
              if (r < 120 && g < 120 && b < 120) decimalPixels += 1
            }
          }
          return { decimalPixels }
        },
        { base64: screenshot.toString('base64'), cssWidth: box.width, cssHeight: box.height, gateLeft, gateTop },
      )
    },
    (last) => last.decimalPixels > 0
  )
}

const waitForProbabilityBarPixels = async (
  page: Parameters<typeof sampleCanvasPixels>[0],
  canvas: Parameters<typeof sampleCanvasPixels>[1],
): Promise<{ barIsBlue: boolean; edgeIsBlue400: boolean; emptyIsPaper: boolean }> => {
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  return await pollForValue(
    async () => {
      const screenshot = await canvas.screenshot({ type: 'png' })
      const box = await canvas.boundingBox()
      if (!box) throw new Error('expected egui canvas to be measurable')
      return await page.evaluate(
        async ({ base64, cssWidth, cssHeight, gateLeft, gateTop }) => {
          const img = new Image()
          img.src = `data:image/png;base64,${base64}`
          await new Promise((resolve, reject) => {
            img.onload = () => resolve(null)
            img.onerror = () => reject(new Error('Failed to decode screenshot'))
          })
          const c = document.createElement('canvas')
          c.width = img.width
          c.height = img.height
          const ctx = c.getContext('2d', { willReadFrequently: true })
          if (!ctx) return { barIsBlue: false, edgeIsBlue400: false, emptyIsPaper: false }
          ctx.drawImage(img, 0, 0)
          const scaleX = img.width / cssWidth
          const scaleY = img.height / cssHeight
          const x0 = Math.floor((gateLeft + 2) * scaleX)
          const x1 = Math.floor((gateLeft + 38) * scaleX)
          const y0 = Math.floor((gateTop + 2) * scaleY)
          const y1 = Math.floor((gateTop + 38) * scaleY)
          let blue = 0
          let edge = 0
          let paper = 0
          for (let y = y0; y <= y1; y += 1) {
            for (let x = x0; x <= x1; x += 1) {
              const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
              if (Math.abs(r - 146) + Math.abs(g - 191) + Math.abs(b - 219) < 16) blue += 1
              if (Math.abs(r - 67) + Math.abs(g - 133) + Math.abs(b - 190) < 32) edge += 1
              if (Math.abs(r - 255) + Math.abs(g - 252) + Math.abs(b - 240) < 16) paper += 1
            }
          }
          return { barIsBlue: blue > 80, edgeIsBlue400: edge > 8, emptyIsPaper: paper > 80 }
        },
        { base64: screenshot.toString('base64'), cssWidth: box.width, cssHeight: box.height, gateLeft, gateTop },
      )
    },
    (last) => last.barIsBlue && last.edgeIsBlue400 && last.emptyIsPaper
  )
}
const readoutVisualStabilityEvidence = async (
  page: Parameters<typeof sampleCanvasPixels>[0],
  canvas: Parameters<typeof sampleCanvasPixels>[1],
  box: { x: number; y: number },
): Promise<{ probabilityDefaultFrames: number; missingMeasurementDigitFrames: number }> => {
  const probabilityGateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING - GATE_SIZE / 2
  const probabilityGateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const probabilityRowH = ((5 - 1) * LINE_GAP + GATE_SIZE) / 32
  const probabilityProbe = { x: probabilityGateLeft + 20, y: probabilityGateTop + probabilityRowH * 20.5 }
  const measureCenter = { x: EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING * 2, y: EGUI_PANEL_MARGIN + LINE_Y + 4 * LINE_GAP }
  let probabilityDefaultFrames = 0
  let missingMeasurementDigitFrames = 0
  for (const column of [0, 1, 0, 2, 1, 0]) {
    await page.mouse.move(box.x + EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING * column, box.y + EGUI_PANEL_MARGIN + LINE_Y)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    const screenshot = await canvas.screenshot({ type: 'png' })
    const canvasBox = await canvas.boundingBox()
    if (!canvasBox) throw new Error('expected egui canvas to be measurable')
    const evidence = await page.evaluate(
      async ({ base64, cssWidth, cssHeight, probabilityProbe, measureCenter }) => {
        const img = new Image()
        img.src = `data:image/png;base64,${base64}`
        await new Promise((resolve, reject) => {
          img.onload = () => resolve(null)
          img.onerror = () => reject(new Error('Failed to decode screenshot'))
        })
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext('2d', { willReadFrequently: true })
        if (!ctx) return { probabilityDefault: true, measurementDigitPixels: 0 }
        ctx.drawImage(img, 0, 0)
        const scaleX = img.width / cssWidth
        const scaleY = img.height / cssHeight
        const px = (xCss: number, yCss: number) => {
          const x = Math.round(xCss * scaleX)
          const y = Math.round(yCss * scaleY)
          return Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)) as [number, number, number]
        }
        const dist = (rgb: [number, number, number], target: [number, number, number]) =>
          Math.abs(rgb[0] - target[0]) + Math.abs(rgb[1] - target[1]) + Math.abs(rgb[2] - target[2])
        const probabilityDefault = dist(px(probabilityProbe.x, probabilityProbe.y), [146, 191, 219]) < 48
        let measurementDigitPixels = 0
        for (let y = measureCenter.y - 14; y <= measureCenter.y + 14; y += 1) {
          for (let x = measureCenter.x - 14; x <= measureCenter.x + 14; x += 1) {
            const rgb = px(x, y)
            if (dist(rgb, [32, 94, 166]) < 48 || dist(rgb, [175, 48, 41]) < 48) {
              measurementDigitPixels += 1
            }
          }
        }
        return { probabilityDefault, measurementDigitPixels }
      },
      {
        base64: screenshot.toString('base64'),
        cssWidth: canvasBox.width,
        cssHeight: canvasBox.height,
        probabilityProbe,
        measureCenter,
      },
    )
    if (evidence.probabilityDefault) probabilityDefaultFrames += 1
    if (evidence.measurementDigitPixels < 12) missingMeasurementDigitFrames += 1
  }
  return { probabilityDefaultFrames, missingMeasurementDigitFrames }
}

const waitForProbabilityHoverEvidence = async (
  page: Parameters<typeof sampleCanvasPixels>[0],
  canvas: Parameters<typeof sampleCanvasPixels>[1],
): Promise<{ rowBorder: boolean; popupText: boolean; popupDivider: boolean }> => {
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING - GATE_SIZE / 2
  const selectedRowTop = EGUI_PANEL_MARGIN + LINE_Y
  return await pollForValue(
    async () => {
      const screenshot = await canvas.screenshot({ type: 'png' })
      const box = await canvas.boundingBox()
      if (!box) throw new Error('expected egui canvas to be measurable')
      return await page.evaluate(
        async ({ base64, cssWidth, cssHeight, gateLeft, selectedRowTop }) => {
          const img = new Image()
          img.src = `data:image/png;base64,${base64}`
          await new Promise((resolve, reject) => {
            img.onload = () => resolve(null)
            img.onerror = () => reject(new Error('Failed to decode screenshot'))
          })
          const c = document.createElement('canvas')
          c.width = img.width
          c.height = img.height
          const ctx = c.getContext('2d', { willReadFrequently: true })
          if (!ctx) return { rowBorder: false, popupText: false, popupDivider: false }
          ctx.drawImage(img, 0, 0)
          const scaleX = img.width / cssWidth
          const scaleY = img.height / cssHeight
          const countMatching = (
            x0Css: number,
            x1Css: number,
            y0Css: number,
            y1Css: number,
            matches: (rgb: [number, number, number]) => boolean,
          ) => {
            let count = 0
            const x0 = Math.floor(x0Css * scaleX)
            const x1 = Math.floor(x1Css * scaleX)
            const y0 = Math.floor(y0Css * scaleY)
            const y1 = Math.floor(y1Css * scaleY)
            for (let y = y0; y <= y1; y += 1) {
              for (let x = x0; x <= x1; x += 1) {
                const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
                if (matches([r, g, b])) count += 1
              }
            }
            return count
          }
          let dividerRowMax = 0
          for (let y = Math.floor(250 * scaleY); y <= Math.floor(305 * scaleY); y += 1) {
            let row = 0
            for (let x = Math.floor(270 * scaleX); x <= Math.floor(430 * scaleX); x += 1) {
              const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
              if (Math.abs(r - 218) + Math.abs(g - 216) + Math.abs(b - 206) < 24) row += 1
            }
            dividerRowMax = Math.max(dividerRowMax, row)
          }
          return {
            rowBorder: countMatching(
              gateLeft,
              gateLeft + 40,
              selectedRowTop,
              selectedRowTop + 20,
              ([r, g, b]) => Math.abs(r - 139) + Math.abs(g - 126) + Math.abs(b - 200) < 48,
            ) > 40,
            popupText: countMatching(226, 450, 208, 336, ([r, g, b]) => r < 80 && g < 80 && b < 80) > 40,
            popupDivider: dividerRowMax > 64,
          }
        },
        { base64: screenshot.toString('base64'), cssWidth: box.width, cssHeight: box.height, gateLeft, selectedRowTop },
      )
    },
    (last) => last.rowBorder && last.popupText && last.popupDivider
  )
}

const waitForDenseProbabilityHoverLinePixels = async (
  page: Parameters<typeof sampleCanvasPixels>[0],
  canvas: Parameters<typeof sampleCanvasPixels>[1],
  localY: number,
): Promise<number> => {
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const hoverY = gateTop + localY
  return await pollForValue(
    async () => {
      const screenshot = await canvas.screenshot({ type: 'png' })
      const box = await canvas.boundingBox()
      if (!box) throw new Error('expected egui canvas to be measurable')
      return await page.evaluate(
        async ({ base64, cssWidth, cssHeight, gateLeft, hoverY, gateSize }) => {
          const img = new Image()
          img.src = `data:image/png;base64,${base64}`
          await new Promise((resolve, reject) => {
            img.onload = () => resolve(null)
            img.onerror = () => reject(new Error('Failed to decode screenshot'))
          })
          const c = document.createElement('canvas')
          c.width = img.width
          c.height = img.height
          const ctx = c.getContext('2d', { willReadFrequently: true })
          if (!ctx) return 0
          ctx.drawImage(img, 0, 0)
          const scaleX = img.width / cssWidth
          const scaleY = img.height / cssHeight
          let count = 0
          for (let y = Math.floor((hoverY - 2) * scaleY); y <= Math.ceil((hoverY + 2) * scaleY); y += 1) {
            for (let x = Math.floor((gateLeft + 4) * scaleX); x <= Math.ceil((gateLeft + gateSize - 4) * scaleX); x += 1) {
              const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
              if (Math.abs(r - 139) + Math.abs(g - 126) + Math.abs(b - 200) < 64) count += 1
            }
          }
          return count
        },
        { base64: screenshot.toString('base64'), cssWidth: box.width, cssHeight: box.height, gateLeft, hoverY, gateSize: GATE_SIZE },
      )
    },
    (last) => last > DENSE_PROBABILITY_HOVER_LINE_MIN_PIXELS
  )
}

const waitForScrolledProbabilityPopupEvidence = async (
  page: Parameters<typeof sampleCanvasPixels>[0],
  canvas: Parameters<typeof sampleCanvasPixels>[1],
): Promise<{
  popupAbovePalette: boolean
  popupValueText: boolean
  ketCentered: boolean
  valuesRightAligned: boolean
  rowsAligned: boolean
}> => {
  return await pollForValue(
    async () => {
      const screenshot = await canvas.screenshot({ type: 'png' })
      const box = await canvas.boundingBox()
      if (!box) throw new Error('expected egui canvas to be measurable')
      return await page.evaluate(
        async ({ base64, cssWidth, cssHeight }) => {
          const img = new Image()
          img.src = `data:image/png;base64,${base64}`
          await new Promise((resolve, reject) => {
            img.onload = () => resolve(null)
            img.onerror = () => reject(new Error('Failed to decode screenshot'))
          })
          const c = document.createElement('canvas')
          c.width = img.width
          c.height = img.height
          const ctx = c.getContext('2d', { willReadFrequently: true })
          if (!ctx) {
            return {
              popupAbovePalette: false,
              popupValueText: false,
              ketCentered: false,
              valuesRightAligned: false,
              rowsAligned: false,
            }
          }
          ctx.drawImage(img, 0, 0)
          const scaleX = img.width / cssWidth
          const scaleY = img.height / cssHeight
          const countMatching = (
            x0Css: number,
            x1Css: number,
            y0Css: number,
            y1Css: number,
            matches: (rgb: [number, number, number]) => boolean,
          ) => {
            let count = 0
            const x0 = Math.floor(x0Css * scaleX)
            const x1 = Math.floor(x1Css * scaleX)
            const y0 = Math.floor(y0Css * scaleY)
            const y1 = Math.floor(y1Css * scaleY)
            for (let y = y0; y <= y1; y += 1) {
              for (let x = x0; x <= x1; x += 1) {
                const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
                if (matches([r, g, b])) count += 1
              }
            }
            return count
          }
          const dark = ([r, g, b]: [number, number, number]) => r < 95 && g < 95 && b < 95
          const teal = ([r, g, b]: [number, number, number]) => Math.abs(r - 60) + Math.abs(g - 171) + Math.abs(b - 162) < 72
          const textInk = ([r, g, b]: [number, number, number]) => r < 150 && g < 150 && b < 150
          const textBounds = (x0Css: number, x1Css: number, y0Css: number, y1Css: number) => {
            let count = 0
            let minX = Number.POSITIVE_INFINITY
            let maxX = Number.NEGATIVE_INFINITY
            let minY = Number.POSITIVE_INFINITY
            let maxY = Number.NEGATIVE_INFINITY
            const x0 = Math.floor(x0Css * scaleX)
            const x1 = Math.floor(x1Css * scaleX)
            const y0 = Math.floor(y0Css * scaleY)
            const y1 = Math.floor(y1Css * scaleY)
            for (let y = y0; y <= y1; y += 1) {
              for (let x = x0; x <= x1; x += 1) {
                const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
                if (!textInk([r, g, b])) continue
                count += 1
                minX = Math.min(minX, x / scaleX)
                maxX = Math.max(maxX, x / scaleX)
                minY = Math.min(minY, y / scaleY)
                maxY = Math.max(maxY, y / scaleY)
              }
            }
            return { count, minX, maxX, minY, maxY }
          }
          const hasBounds = (b: ReturnType<typeof textBounds>) => b.count > 4
          const centerY = (b: ReturnType<typeof textBounds>) => (b.minY + b.maxY) / 2
          const paletteTealThroughPopup = countMatching(270, 430, 150, 196, teal)
          const centeredKet = countMatching(320, 380, 155, 180, dark)
          const leftKet = countMatching(270, 315, 155, 180, dark)
          const rawLabel = textBounds(270, 306, 220, 242)
          const rawValue = textBounds(318, 430, 220, 242)
          const logLabel = textBounds(270, 306, 240, 264)
          const logValue = textBounds(318, 430, 240, 264)
          return {
            popupAbovePalette: paletteTealThroughPopup < 8,
            popupValueText: rawValue.count + logValue.count > 24,
            ketCentered: centeredKet > leftKet + 8,
            valuesRightAligned: hasBounds(rawValue) && hasBounds(logValue) && Math.abs(rawValue.maxX - logValue.maxX) <= 4,
            rowsAligned: hasBounds(rawLabel) && hasBounds(rawValue) && hasBounds(logLabel) && hasBounds(logValue)
              && Math.abs(centerY(rawLabel) - centerY(rawValue)) <= 4
              && Math.abs(centerY(logLabel) - centerY(logValue)) <= 4,
          }
        },
        { base64: screenshot.toString('base64'), cssWidth: box.width, cssHeight: box.height },
      )
    },
    (last) => last.popupAbovePalette && last.popupValueText && last.ketCentered && last.valuesRightAligned && last.rowsAligned
  )
}

test('Probability display renders GPU probabilities and serializes the Quirk token', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H'], ['Probability']] })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  const probs = await waitForProbabilityDistributions(page)
  const pixelResult = await waitForProbabilityBarPixels(page, canvas)

  expect({
    hashCols: readCircuitColsFromHash(page.url()),
    p0: Math.round(probs[0] * 1000) / 1000,
    p1: Math.round(probs[1] * 1000) / 1000,
    ...pixelResult,
  }).toEqual({
    hashCols: [['H'], ['Probability']],
    p0: 0.5,
    p1: 0.5,
    barIsBlue: true,
    edgeIsBlue400: true,
    emptyIsPaper: true,
  })
})

test('Probability display uses same-column control as a conditional readout', async ({ page }) => {
  await page.goto(
    '/#' +
      encodeURIComponent(
        JSON.stringify({ cols: [['H', 1], ['•', 'X'], ['•', 'Probability']] }),
      ),
  )

  await waitForStartupReady(page, { waitForStateVector: true })

  const probs = await waitForProbabilityDistributions(page)
  expect(probs.slice(0, 2).map((value) => Math.round(value * 1000) / 1000)).toEqual([0, 1])
})

test('Probability display uses same-column anti-control as a conditional readout', async ({ page }) => {
  await page.goto(
    '/#' +
      encodeURIComponent(
        JSON.stringify({ cols: [['H', 1], ['•', 'X'], ['◦', 'Probability']] }),
      ),
  )

  await waitForStartupReady(page, { waitForStateVector: true })

  const probs = await waitForProbabilityDistributions(page)
  expect(probs.slice(0, 2).map((value) => Math.round(value * 1000) / 1000)).toEqual([1, 0])
})

test('Probability4 displays GPU-rendered percentage labels', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H', 'H', 'H', 'H'], ['Probability4']] })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForProbabilityDistributions(page)

  const canvas = page.locator('#egui-canvas')
  const evidence = await waitForProbabilityPercentLabelEvidence(page, canvas, 4)

  expect(evidence.bboxHeight).toBeGreaterThanOrEqual(11)
})

test('Probability labels render decimal points for integer percentages', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H'], ['Probability']] })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForProbabilityDistributions(page)

  const canvas = page.locator('#egui-canvas')
  const evidence = await waitForProbabilityDecimalPointEvidence(page, canvas)

  expect(evidence.decimalPixels).toBeGreaterThan(0)
})

test('Probability5 keeps the Quirk-style bar-only display', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [[1, 1, 1, 1, 'H'], ['Probability5']] })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForProbabilityDistributions(page)

  const canvas = page.locator('#egui-canvas')
  const evidence = await waitForProbabilityPercentLabelEvidence(page, canvas, 5)

  expect(evidence.textPixels < 8).toBe(true)
})

// Regression guard for the triangle-seam "nub": `raw_row = floor(local.y / row_h)`
// used the interpolated `local.y`, which is not bit-exact across the unit quad's
// diagonal, so a `row_h` boundary landing on a pixel centre flipped the row on the
// lower-left triangle and bled bar fill one pixel below the bar. For Probability5
// (span 5) `row_h = 264 / 32 = 8.25px`, and the row-6 boundary `6 * 8.25 = 49.5px`
// is a DPR-1 pixel centre — the exact trigger. Value 5 (full bar in row 5 only)
// means every row below the spike must be empty, so any bar-blue pixel there is a nub.
const waitForRowsBelowProbabilitySpike = async (
  page: Parameters<typeof sampleCanvasPixels>[0],
  canvas: Parameters<typeof sampleCanvasPixels>[1],
): Promise<{ belowSpikeBarPixels: number }> => {
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const gateHeight = (5 - 1) * LINE_GAP + GATE_SIZE
  const rowH = gateHeight / 32
  try {
    const evidence = await waitForValue(
      async () => {
        const screenshot = await canvas.screenshot({ type: 'png' })
        const box = await canvas.boundingBox()
        if (!box) throw new Error('expected egui canvas to be measurable')
        return await page.evaluate(
          async ({ base64, cssWidth, cssHeight, gateLeft, gateTop, rowH, gateHeight, gateSize }) => {
            const img = new Image()
            img.src = `data:image/png;base64,${base64}`
            await new Promise((resolve, reject) => {
              img.onload = () => resolve(null)
              img.onerror = () => reject(new Error('Failed to decode screenshot'))
            })
            const c = document.createElement('canvas')
            c.width = img.width
            c.height = img.height
            const ctx = c.getContext('2d', { willReadFrequently: true })
            if (!ctx) return { spikeBarPixels: 0, belowSpikeBarPixels: 0 }
            ctx.drawImage(img, 0, 0)
            const scaleX = img.width / cssWidth
            const scaleY = img.height / cssHeight
            const isBarBlue = (x: number, y: number): boolean => {
              const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
              return Math.abs(r - 146) + Math.abs(g - 191) + Math.abs(b - 219) < 24
            }
            const xLo = Math.floor((gateLeft + 1) * scaleX)
            const xHi = Math.floor((gateLeft + gateSize - 1) * scaleX)
            let spikeBarPixels = 0
            const spikeYLo = Math.floor((gateTop + 5 * rowH + 1) * scaleY)
            const spikeYHi = Math.floor((gateTop + 6 * rowH - 1) * scaleY)
            for (let y = spikeYLo; y <= spikeYHi; y += 1) for (let x = xLo; x <= xHi; x += 1) if (isBarBlue(x, y)) spikeBarPixels += 1
            let belowSpikeBarPixels = 0
            const belowYLo = Math.floor((gateTop + 6 * rowH) * scaleY)
            const belowYHi = Math.floor((gateTop + gateHeight - 1) * scaleY)
            for (let y = belowYLo; y <= belowYHi; y += 1) for (let x = xLo; x <= xHi; x += 1) if (isBarBlue(x, y)) belowSpikeBarPixels += 1
            return { spikeBarPixels, belowSpikeBarPixels }
          },
          { base64: screenshot.toString('base64'), cssWidth: box.width, cssHeight: box.height, gateLeft, gateTop, rowH, gateHeight, gateSize: GATE_SIZE },
        )
      },
      (evidence) => evidence.spikeBarPixels > 40,
      'Probability5 value-5 bar never rendered; cannot evaluate rows below the spike',
    )
    return { belowSpikeBarPixels: evidence.belowSpikeBarPixels }
  } catch (err) {
    throw new Error('Probability5 value-5 bar never rendered; cannot evaluate rows below the spike')
  }
}

test('Probability5 bar leaves no seam nub in the rows below the spike', async ({ page }) => {
  // q0 = LSB: X on q0 and q2 → outcome 5, probability 1 → one full-width bar in row 5.
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['X', 1, 'X'], ['Probability5']] })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForProbabilityDistributions(page)

  const canvas = page.locator('#egui-canvas')
  const evidence = await waitForRowsBelowProbabilitySpike(page, canvas)

  expect(evidence.belowSpikeBarPixels).toBe(0)
})

test('Probability5 draws logarithm hints for bar-only rows', async ({ page }) => {
  // q0 = LSB: H on q0 splits probability equally across outcomes 0 and 1 (rows 0
  // and 1), each 0.5. Row 1 carries a non-zero probability, so its log-scale tick
  // is drawn at x = gateLeft + width·(1 + ln(0.5)·s), s = 1/12 for span 5.
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H', 1, 1, 1, 1], ['Probability5']] })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForProbabilityDistributions(page)

  const canvas = page.locator('#egui-canvas')
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const rowH = ((5 - 1) * LINE_GAP + GATE_SIZE) / 32
  const hintX = gateLeft + GATE_SIZE * (1 + Math.log(0.5) / 12)
  const pixels = await sampleCanvasPixels(page, canvas, [{ name: 'halfProbabilityHint', x: hintX, y: gateTop + rowH * 1.5 }])

  expect(pixelRgbDistance(pixels.halfProbabilityHint, FLEXOKI_TX_3)).toBeLessThan(64)
})

// Regression guard: an impossible outcome (prob 0) has no log-scale position
// (log(0) is undefined), so it must carry no log hint. Previously prob 0 clamped
// to the left edge, so the staircase connector ran full-width from a 100% bar
// down to the empty rows below — a stray gray line right under the bar.
const waitForLogHintBelowFullBar = async (
  page: Parameters<typeof sampleCanvasPixels>[0],
  canvas: Parameters<typeof sampleCanvasPixels>[1],
): Promise<{ logHintPixelsBelowBar: number }> => {
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const rowH = ((5 - 1) * LINE_GAP + GATE_SIZE) / 32
  const gateHeight = (5 - 1) * LINE_GAP + GATE_SIZE
  try {
    const evidence = await waitForValue(
      async () => {
        const screenshot = await canvas.screenshot({ type: 'png' })
        const box = await canvas.boundingBox()
        if (!box) throw new Error('expected egui canvas to be measurable')
        return await page.evaluate(
          async ({ base64, cssWidth, cssHeight, gateLeft, gateTop, rowH, gateHeight, gateSize, logHint }) => {
            const img = new Image()
            img.src = `data:image/png;base64,${base64}`
            await new Promise((resolve, reject) => {
              img.onload = () => resolve(null)
              img.onerror = () => reject(new Error('Failed to decode screenshot'))
            })
            const c = document.createElement('canvas')
            c.width = img.width
            c.height = img.height
            const ctx = c.getContext('2d', { willReadFrequently: true })
            if (!ctx) return { barPixels: 0, logHintPixelsBelowBar: 0 }
            ctx.drawImage(img, 0, 0)
            const scaleX = img.width / cssWidth
            const scaleY = img.height / cssHeight
            const px = (x: number, y: number): [number, number, number] => {
              const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
              return [r, g, b]
            }
            const isBar = (x: number, y: number): boolean => {
              const [r, g, b] = px(x, y)
              return Math.abs(r - 146) + Math.abs(g - 191) + Math.abs(b - 219) < 24
            }
            const isLogHint = (x: number, y: number): boolean => {
              const [r, g, b] = px(x, y)
              return Math.abs(r - logHint[0]) + Math.abs(g - logHint[1]) + Math.abs(b - logHint[2]) < 24
            }
            const xLo = Math.floor((gateLeft + 1) * scaleX)
            const xHi = Math.floor((gateLeft + gateSize - 1) * scaleX)
            let barPixels = 0
            const spikeYLo = Math.floor((gateTop + 5 * rowH + 1) * scaleY)
            const spikeYHi = Math.floor((gateTop + 6 * rowH - 1) * scaleY)
            for (let y = spikeYLo; y <= spikeYHi; y += 1) for (let x = xLo; x <= xHi; x += 1) if (isBar(x, y)) barPixels += 1
            let logHintPixelsBelowBar = 0
            const belowYLo = Math.floor((gateTop + 6 * rowH) * scaleY)
            const belowYHi = Math.floor((gateTop + gateHeight - 1) * scaleY)
            for (let y = belowYLo; y <= belowYHi; y += 1) for (let x = xLo; x <= xHi; x += 1) if (isLogHint(x, y)) logHintPixelsBelowBar += 1
            return { barPixels, logHintPixelsBelowBar }
          },
          { base64: screenshot.toString('base64'), cssWidth: box.width, cssHeight: box.height, gateLeft, gateTop, rowH, gateHeight, gateSize: GATE_SIZE, logHint: FLEXOKI_TX_3 },
        )
      },
      (evidence) => evidence.barPixels > 40,
      'Probability5 value-5 bar never rendered; cannot evaluate log hints below the bar',
    )
    return { logHintPixelsBelowBar: evidence.logHintPixelsBelowBar }
  } catch (err) {
    throw new Error('Probability5 value-5 bar never rendered; cannot evaluate log hints below the bar')
  }
}

test('Probability5 draws no log hint for the zero-probability rows below a full bar', async ({ page }) => {
  // q0 = LSB: X on q0 and q2 → outcome 5, probability 1. Every row below is an
  // impossible outcome, so no log-hint pixel (tick or connector) may appear there.
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['X', 1, 'X'], ['Probability5']] })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForProbabilityDistributions(page)

  const canvas = page.locator('#egui-canvas')
  const evidence = await waitForLogHintBelowFullBar(page, canvas)

  expect(evidence.logHintPixelsBelowBar).toBe(0)
})

// Complements the absence test above: when a zero-probability row sits BETWEEN two
// non-zero rows, the log-hint curve must break there (no tick, no connector running
// across it). The helper's positive control requires the two non-zero rows' ticks to
// render first, so the assertion cannot vacuously pass on a blank display.
const waitForSeveredZeroRowLogHint = async (
  page: Parameters<typeof sampleCanvasPixels>[0],
  canvas: Parameters<typeof sampleCanvasPixels>[1],
): Promise<{ zeroRowLogHintPixels: number }> => {
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const rowH = ((5 - 1) * LINE_GAP + GATE_SIZE) / 32
  try {
    const evidence = await waitForValue(
      async () => {
        const screenshot = await canvas.screenshot({ type: 'png' })
        const box = await canvas.boundingBox()
        if (!box) throw new Error('expected egui canvas to be measurable')
        return await page.evaluate(
          async ({ base64, cssWidth, cssHeight, gateLeft, gateTop, rowH, gateSize, logHint }) => {
            const img = new Image()
            img.src = `data:image/png;base64,${base64}`
            await new Promise((resolve, reject) => {
              img.onload = () => resolve(null)
              img.onerror = () => reject(new Error('Failed to decode screenshot'))
            })
            const c = document.createElement('canvas')
            c.width = img.width
            c.height = img.height
            const ctx = c.getContext('2d', { willReadFrequently: true })
            if (!ctx) return { tickPixels: 0, zeroRowLogHintPixels: 0 }
            ctx.drawImage(img, 0, 0)
            const scaleX = img.width / cssWidth
            const scaleY = img.height / cssHeight
            const isLogHint = (x: number, y: number): boolean => {
              const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
              return Math.abs(r - logHint[0]) + Math.abs(g - logHint[1]) + Math.abs(b - logHint[2]) < 24
            }
            const xLo = Math.floor((gateLeft + 1) * scaleX)
            const xHi = Math.floor((gateLeft + gateSize - 1) * scaleX)
            const countRow = (row: number, includeTop: boolean): number => {
              const yLo = Math.floor((gateTop + row * rowH + (includeTop ? 0 : 1)) * scaleY)
              const yHi = Math.floor((gateTop + (row + 1) * rowH - 1) * scaleY)
              let n = 0
              for (let y = yLo; y <= yHi; y += 1) for (let x = xLo; x <= xHi; x += 1) if (isLogHint(x, y)) n += 1
              return n
            }
            return { tickPixels: countRow(0, false) + countRow(2, false), zeroRowLogHintPixels: countRow(1, true) }
          },
          { base64: screenshot.toString('base64'), cssWidth: box.width, cssHeight: box.height, gateLeft, gateTop, rowH, gateSize: GATE_SIZE, logHint: FLEXOKI_TX_3 },
        )
      },
      (evidence) => evidence.tickPixels > 0,
      'Probability5 log-hint ticks for the non-zero rows never rendered',
    )
    return { zeroRowLogHintPixels: evidence.zeroRowLogHintPixels }
  } catch (err) {
    throw new Error('Probability5 log-hint ticks for the non-zero rows never rendered')
  }
}

test('Probability5 severs the log-hint curve at a zero-probability row between non-zero rows', async ({ page }) => {
  // q1 = LSB bit 1: H on q1 → outcomes 0 and 2 (rows 0 and 2) each 0.5, row 1 empty between them.
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [[1, 'H'], ['Probability5']] })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForProbabilityDistributions(page)

  const canvas = page.locator('#egui-canvas')
  const evidence = await waitForSeveredZeroRowLogHint(page, canvas)

  expect(evidence.zeroRowLogHintPixels).toBe(0)
})

test('Probability hover highlights an outcome row and opens the popup', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H'], ['Probability']] })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.move(box.x + EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + SLOT_SPACING + GATE_SIZE, box.y + EGUI_PANEL_MARGIN + LINE_Y + 8)
  const evidence = await waitForProbabilityHoverEvidence(page, canvas)

  expect(evidence).toEqual({ rowBorder: true, popupText: true, popupDivider: true })
})

test('Probability5 hover outline keeps the right edge inside the pixel-aligned row', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 800 })
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: GROVER_COLS })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForProbabilityDistributions(page)

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const probabilityColumns = GROVER_COLS.flatMap((col, index) => col[0] === 'Probability5' ? [index] : [])
  const probabilityColumn = probabilityColumns[probabilityColumns.length - 2]
  const hoveredOutcome = 27
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING * probabilityColumn - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const gateHeight = (5 - 1) * LINE_GAP + GATE_SIZE
  const rowH = gateHeight / 32
  await page.mouse.move(box.x + gateLeft + GATE_SIZE / 2, box.y + gateTop + (hoveredOutcome + 0.5) * rowH)
  await page.waitForTimeout(80)

  const screenshot = await canvas.screenshot({ type: 'png' })
  const evidence = await page.evaluate(
    async ({ base64, cssWidth, cssHeight, gateLeft, gateTop, gateHeight, row, gateSize }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${base64}`
      await new Promise((resolve, reject) => {
        img.onload = () => resolve(null)
        img.onerror = () => reject(new Error('Failed to decode screenshot'))
      })
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { topEdgeContinuous: false, rightEdgeDoesNotProtrude: false }
      ctx.drawImage(img, 0, 0)
      const scaleX = img.width / cssWidth
      const scaleY = img.height / cssHeight
      const rowH = gateHeight / 32
      const topCss = Math.round(gateTop + row * rowH)
      const isPurple = (x: number, y: number): boolean => {
        const [r, g, b] = ctx.getImageData(Math.floor(x * scaleX), Math.floor(y * scaleY), 1, 1).data
        return Math.abs(r - 139) + Math.abs(g - 126) + Math.abs(b - 200) < 64
      }
      let topEdgePixels = 0
      for (let x = gateLeft + 2; x <= gateLeft + gateSize - 3; x += 1) {
        if (isPurple(x, topCss)) topEdgePixels += 1
      }
      let protrudingRightPixels = 0
      for (let x = gateLeft + gateSize - 2; x <= gateLeft + gateSize - 1; x += 1) {
        if (isPurple(x, topCss - 1)) protrudingRightPixels += 1
      }
      return {
        topEdgeContinuous: topEdgePixels >= gateSize - 5,
        rightEdgeDoesNotProtrude: protrudingRightPixels === 0,
      }
    },
    {
      base64: screenshot.toString('base64'),
      cssWidth: box.width,
      cssHeight: box.height,
      gateLeft,
      gateTop,
      gateHeight,
      row: hoveredOutcome,
      gateSize: GATE_SIZE,
    },
  )

  expect(evidence).toEqual({ topEdgeContinuous: true, rightEdgeDoesNotProtrude: true })
})

test('Probability5 logarithm hints do not thicken row separators', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 800 })
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: GROVER_COLS })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForProbabilityDistributions(page)

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const probabilityColumns = GROVER_COLS.flatMap((col, index) => col[0] === 'Probability5' ? [index] : [])
  const probabilityColumn = probabilityColumns[probabilityColumns.length - 2]
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING * probabilityColumn - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const gateHeight = (5 - 1) * LINE_GAP + GATE_SIZE
  const screenshot = await canvas.screenshot({ type: 'png' })
  const maxAboveSeparatorRightPixels = await page.evaluate(
    async ({ base64, cssWidth, cssHeight, gateLeft, gateTop, gateHeight, gateSize }) => {
      const img = new Image()
      img.src = `data:image/png;base64,${base64}`
      await new Promise((resolve, reject) => {
        img.onload = () => resolve(null)
        img.onerror = () => reject(new Error('Failed to decode screenshot'))
      })
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d', { willReadFrequently: true })
      if (!ctx) return 0
      ctx.drawImage(img, 0, 0)
      const scaleX = img.width / cssWidth
      const scaleY = img.height / cssHeight
      const rowH = gateHeight / 32
      const isUi2 = (x: number, y: number): boolean => {
        const [r, g, b] = ctx.getImageData(Math.floor(x * scaleX), Math.floor(y * scaleY), 1, 1).data
        return Math.abs(r - 218) + Math.abs(g - 216) + Math.abs(b - 206) < 48
      }
      let maxPixels = 0
      for (let row = 1; row < 32; row += 1) {
        const separatorY = Math.round(gateTop + row * rowH)
        let abovePixels = 0
        for (let x = gateLeft + gateSize * 0.60; x <= gateLeft + gateSize - 3; x += 1) {
          if (isUi2(x, separatorY - 1)) abovePixels += 1
        }
        maxPixels = Math.max(maxPixels, abovePixels)
      }
      return maxPixels
    },
    {
      base64: screenshot.toString('base64'),
      cssWidth: box.width,
      cssHeight: box.height,
      gateLeft,
      gateTop,
      gateHeight,
      gateSize: GATE_SIZE,
    },
  )

  expect(maxAboveSeparatorRightPixels).toBeLessThanOrEqual(2)
})

test('Probability16 hover keeps the Quirk-style row line visible', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['Probability16']] })))
  await waitForStartupReady(page)

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const hoverLocalY = 280
  await page.mouse.move(box.x + gateLeft + GATE_SIZE / 2, box.y + gateTop + hoverLocalY)
  const hoverLinePixels = await waitForDenseProbabilityHoverLinePixels(page, canvas, hoverLocalY)

  expect(hoverLinePixels).toBeGreaterThan(DENSE_PROBABILITY_HOVER_LINE_MIN_PIXELS)
})

test('Probability popup uses the shared popover tail outline', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H'], ['Probability']] })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForProbabilityDistributions(page)

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const rowCenterY = gateTop + 10
  const tailApexX = gateLeft + GATE_SIZE + 4
  await page.mouse.move(box.x + gateLeft + GATE_SIZE / 2, box.y + rowCenterY)
  await page.waitForTimeout(150)

  const points = []
  for (let x = 0; x <= 8; x += 1) {
    for (let y = -8; y <= 8; y += 1) {
      points.push({ name: `tail${x}_${y}`, x: tailApexX + x, y: rowCenterY + y })
    }
  }
  const pixels = await sampleCanvasPixels(page, canvas, points)
  const outlinePixels = Object.values(pixels).filter((pixel) => pixelRgbDistance(pixel, FLEXOKI_TX_3) <= 70).length

  expect(outlinePixels).toBeGreaterThanOrEqual(12)
})

test('Probability popup stays above the palette and keeps GPU values while scrolled', async ({ page }) => {
  const lowerQubitPadding = Array(15).fill(1)
  const lowerQubitPaddingAfterPair = Array(14).fill(1)
  await page.goto('/#' + encodeURIComponent(JSON.stringify({
    cols: [['H', 'H', ...lowerQubitPaddingAfterPair], ['Probability4', ...lowerQubitPadding], [...lowerQubitPadding, 'H']],
  })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const scrollY = 44
  await page.mouse.move(box.x + 400, box.y + 300)
  await page.mouse.wheel(0, scrollY)
  await page.waitForTimeout(300)
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2 - scrollY
  const rowH = ((4 - 1) * LINE_GAP + GATE_SIZE) / 16
  await page.mouse.move(box.x + gateLeft + 20, box.y + gateTop + rowH * 0.5)
  const evidence = await waitForScrolledProbabilityPopupEvidence(page, canvas)

  expect(evidence).toEqual({
    popupAbovePalette: true,
    popupValueText: true,
    ketCentered: true,
    valuesRightAligned: true,
    rowsAligned: true,
  })
})

test('Probability popup flips left near the browser right edge', async ({ page }) => {
  const filler = Array.from({ length: 11 }, () => ['H', 1, 1, 1, 1])
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [...filler, ['Probability5']] })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForProbabilityDistributions(page)

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const probabilityColumn = filler.length
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING * probabilityColumn - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  await page.mouse.move(box.x + gateLeft + GATE_SIZE / 2, box.y + gateTop + 132)

  let leftPopupText = await waitForValue(
    async () => {
      const screenshot = await canvas.screenshot({ type: 'png' })
      const canvasBox = await canvas.boundingBox()
      if (!canvasBox) throw new Error('expected egui canvas to be measurable')
      return await page.evaluate(
        async ({ base64, cssWidth, cssHeight, gateLeft, gateTop }) => {
          const img = new Image()
          img.src = `data:image/png;base64,${base64}`
          await new Promise((resolve, reject) => {
            img.onload = () => resolve(null)
            img.onerror = () => reject(new Error('Failed to decode screenshot'))
          })
          const c = document.createElement('canvas')
          c.width = img.width
          c.height = img.height
          const ctx = c.getContext('2d', { willReadFrequently: true })
          if (!ctx) return false
          ctx.drawImage(img, 0, 0)
          const scaleX = img.width / cssWidth
          const scaleY = img.height / cssHeight
          let darkTextPixels = 0
          const x0 = Math.floor((gateLeft - 260) * scaleX)
          const x1 = Math.floor((gateLeft - 16) * scaleX)
          const y0 = Math.floor((gateTop + 70) * scaleY)
          const y1 = Math.floor((gateTop + 190) * scaleY)
          for (let y = y0; y <= y1; y += 1) {
            for (let x = x0; x <= x1; x += 1) {
              const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
              if (r < 100 && g < 100 && b < 100) darkTextPixels += 1
            }
          }
          return darkTextPixels > 40
        },
        { base64: screenshot.toString('base64'), cssWidth: canvasBox.width, cssHeight: canvasBox.height, gateLeft, gateTop },
      )
    },
    (result) => result,
    'Probability popup text did not appear on the left',
  )

  expect(leftPopupText).toBe(true)
})

test('hovering columns does not flash readouts back to default bodies', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [[1, 1, 1, 1, 'X'], ['Probability5'], [1, 1, 1, 1, 'Measure']] })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForProbabilityDistributions(page)

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const evidence = await readoutVisualStabilityEvidence(page, canvas, box)

  expect(evidence).toEqual({ probabilityDefaultFrames: 0, missingMeasurementDigitFrames: 0 })
})

test('selected earlier column keeps later readouts populated', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H'], ['Probability'], ['Measure']] })))
  await waitForStartupReady(page, { waitForStateVector: true, timeout: 60_000 })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.move(box.x + LINE_LEFT_OFFSET + GATE_SIZE, box.y + LINE_Y)

  await expect
    .poll(() => selectedColumnReadoutEvidence(page))
    .toEqual(EXPECTED_SELECTED_COLUMN_READOUT)
})

test('Probability9 keeps tiny-row bars visible', async ({ page }) => {
  // q0 = LSB: H on q7 (bit 7) splits probability across outcomes 0 and 128, so the
  // deep row 128 carries 0.5 — a tiny (sub-pixel) row whose bar must stay visible.
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [[1, 1, 1, 1, 1, 1, 1, 'H'], ['Probability9']] })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  const probs = await waitForProbabilityDistributions(page)
  const gateTop = LINE_Y - GATE_SIZE / 2 + 8
  const pixels = await sampleCanvasPixels(page, canvas, [{
    name: 'outcome128Bar',
    x: LINE_LEFT_OFFSET + SLOT_SPACING + GATE_SIZE - 2,
    y: gateTop + ((9 - 1) * LINE_GAP + GATE_SIZE) / 4,
  }])

  expect({
    p128: Math.round(probs[128] * 1000) / 1000,
    barVisible: pixelRgbDistance(pixels.outcome128Bar, [146, 191, 219, 255]) < 64,
  }).toEqual({ p128: 0.5, barVisible: true })
})

const setupProbability4ResizeHandleProbe = async (page: Parameters<typeof sampleCanvasPixels>[0]) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['Probability4']] })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const gateHeight = (4 - 1) * LINE_GAP + GATE_SIZE
  const centerX = gateLeft + GATE_SIZE / 2
  await page.mouse.move(box.x + centerX, box.y + gateTop + GATE_SIZE / 2)
  await page.waitForTimeout(350)
  return { canvas, box, gateTop, gateHeight, centerX }
}

const setupQft4ResizeHandleProbe = async (page: Parameters<typeof sampleCanvasPixels>[0], token: 'QFT4' | 'QFT†4') => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [[token]] })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const gateHeight = (4 - 1) * LINE_GAP + GATE_SIZE
  const centerX = gateLeft + GATE_SIZE / 2
  await page.mouse.move(box.x + centerX, box.y + gateTop + GATE_SIZE / 2)
  await page.waitForTimeout(350)
  return { canvas, gateTop, gateHeight, centerX }
}

test('Probability resize handles stay visible while crossing the top gap', async ({ page }) => {
  const { canvas, box, gateTop, centerX } = await setupProbability4ResizeHandleProbe(page)
  await page.mouse.move(box.x + centerX, box.y + gateTop - 5)
  await page.waitForTimeout(350)
  const pixels = await sampleCanvasPixels(page, canvas, [{ name: 'topHandle', x: centerX, y: gateTop - 9 }])

  expect(pixelRgbDistance(pixels.topHandle, [36, 131, 123, 255])).toBeLessThan(64)
})

test('Probability resize handles stay visible while crossing the bottom gap', async ({ page }) => {
  const { canvas, box, gateTop, gateHeight, centerX } = await setupProbability4ResizeHandleProbe(page)
  await page.mouse.move(box.x + centerX, box.y + gateTop + gateHeight + 5)
  await page.waitForTimeout(350)
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'bottomHandle', x: centerX, y: gateTop + gateHeight + 9 },
  ])

  expect(pixelRgbDistance(pixels.bottomHandle, [36, 131, 123, 255])).toBeLessThan(64)
})

test('Probability resize handles show two visible pills', async ({ page }) => {
  const { canvas, gateTop, gateHeight, centerX } = await setupProbability4ResizeHandleProbe(page)
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'topHandle', x: centerX, y: gateTop - 9 },
    { name: 'bottomHandle', x: centerX, y: gateTop + gateHeight + 9 },
  ])
  const visibleCount = [pixels.topHandle, pixels.bottomHandle]
    .filter((pixel) => pixelRgbDistance(pixel, [58, 169, 159, 255]) < 56)
    .length

  expect(visibleCount).toBe(2)
})

test('QFT and QFT† resize handles show two shared span-resize pills', async ({ page }) => {
  const qft = await setupQft4ResizeHandleProbe(page, 'QFT4')
  const qftPixels = await sampleCanvasPixels(page, qft.canvas, [
    { name: 'topHandle', x: qft.centerX, y: qft.gateTop - 9 },
    { name: 'bottomHandle', x: qft.centerX, y: qft.gateTop + qft.gateHeight + 9 },
  ])
  const qftDagger = await setupQft4ResizeHandleProbe(page, 'QFT†4')
  const qftDaggerPixels = await sampleCanvasPixels(page, qftDagger.canvas, [
    { name: 'topHandle', x: qftDagger.centerX, y: qftDagger.gateTop - 9 },
    { name: 'bottomHandle', x: qftDagger.centerX, y: qftDagger.gateTop + qftDagger.gateHeight + 9 },
  ])
  const visibleCounts = [qftPixels, qftDaggerPixels].map((pixels) =>
    [pixels.topHandle, pixels.bottomHandle]
      .filter((pixel) => pixelRgbDistance(pixel, [58, 169, 159, 255]) < 56)
      .length,
  )

  expect(visibleCounts).toEqual([2, 2])
})

test('Probability resize handles stay separated from the hover ring', async ({ page }) => {
  const { canvas, gateTop, gateHeight, centerX } = await setupProbability4ResizeHandleProbe(page)
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'topGap', x: centerX, y: gateTop - 5 },
    { name: 'bottomGap', x: centerX, y: gateTop + gateHeight + 5 },
  ])
  const separatedGapCount = [pixels.topGap, pixels.bottomGap]
    .filter((pixel) => pixelRgbDistance(pixel, [242, 240, 229, 255]) < 24)
    .length

  expect(separatedGapCount).toBe(2)
})

test('Probability resize handle hover uses cyan-600 on the hovered pill', async ({ page }) => {
  const { canvas, box, gateTop, centerX } = await setupProbability4ResizeHandleProbe(page)
  await page.mouse.move(box.x + centerX, box.y + gateTop - 9)
  await page.waitForTimeout(100)
  const pixels = await sampleCanvasPixels(page, canvas, [{ name: 'topHandle', x: centerX, y: gateTop - 9 }])

  expect(pixelRgbDistance(pixels.topHandle, [36, 131, 123, 255])).toBeLessThan(64)
})

test('Probability resize handle hover leaves the opposite pill visible', async ({ page }) => {
  const { canvas, box, gateTop, gateHeight, centerX } = await setupProbability4ResizeHandleProbe(page)
  await page.mouse.move(box.x + centerX, box.y + gateTop - 9)
  await page.waitForTimeout(100)
  const pixels = await sampleCanvasPixels(page, canvas, [
    { name: 'bottomHandle', x: centerX, y: gateTop + gateHeight + 9 },
  ])

  expect(pixelRgbDistance(pixels.bottomHandle, [58, 169, 159, 255])).toBeLessThan(56)
})

test('Probability top resize handle expands the span upward', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [[1, 'Probability3']] })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y + LINE_GAP - GATE_SIZE / 2
  const handle = { x: gateLeft + GATE_SIZE / 2, y: gateTop - 9 }
  await page.mouse.move(box.x + handle.x, box.y + handle.y)
  await page.mouse.down()
  await page.mouse.move(box.x + handle.x, box.y + handle.y - LINE_GAP, { steps: 8 })
  await page.mouse.up()
  await waitForHashCols(page, [['Probability4']])

  expect(readCircuitColsFromHash(page.url())).toEqual([['Probability4']])
})

test('QFT top resize handle expands the span upward', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [[1, 'QFT3']] })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE - GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y + LINE_GAP - GATE_SIZE / 2
  const handle = { x: gateLeft + GATE_SIZE / 2, y: gateTop - 9 }
  await page.mouse.move(box.x + handle.x, box.y + handle.y)
  await page.mouse.down()
  await page.mouse.move(box.x + handle.x, box.y + handle.y - LINE_GAP, { steps: 8 })
  await page.mouse.up()
  await waitForHashCols(page, [['QFT4']])

  expect(readCircuitColsFromHash(page.url())).toEqual([['QFT4']])
})

test('Probability palette drop can resize to Probability3', async ({ page }) => {
  await page.goto('/')
  await waitForStartupReady(page, { waitForStateVector: true })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const cssWidth = box.width
  const source = getPaletteGateCenter(cssWidth, PROBABILITY_PALETTE_INDEX)
  const target = { x: LINE_LEFT_OFFSET + GATE_SIZE, y: LINE_Y }
  await dragPointer(page, source, target)
  await waitForHashCols(page, [['Probability']])

  const handle = {
    x: EGUI_PANEL_MARGIN + target.x,
    y: EGUI_PANEL_MARGIN + LINE_Y + GATE_SIZE / 2 + 9,
  }
  await page.mouse.move(box.x + handle.x, box.y + handle.y)
  await page.mouse.down()
  await page.mouse.move(box.x + handle.x, box.y + handle.y + 2 * LINE_GAP, { steps: 8 })
  await page.mouse.up()
  await waitForHashCols(page, [['Probability3']])

  expect(readCircuitColsFromHash(page.url())).toEqual([['Probability3']])
})
