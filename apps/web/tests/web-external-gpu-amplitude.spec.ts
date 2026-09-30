import { expect, test, type Page } from '@playwright/test'
import {
  pixelRgbDistance,
  readAmplitudeCell,
  readBlochVectors,
  readDensityMatrixCell,
  readProbabilityDistributions,
  sampleCanvasPixels,
  type CanvasPixel,
  type PixelSamplePoint,
  type Point,
  UI_CONSTANTS,
  waitForStartupReady,
} from './support/web-spec-helpers'

const EXEC_MODE_GPU_FILL: CanvasPixel = [32, 94, 166, 255] // Flexoki blue-600 #205EA6
const DISPLAY_PLACEHOLDER_FILL: CanvasPixel = [236, 225, 243, 255] // Flexoki purple-100 #ECE1F3
const DISPLAY_PLACEHOLDER_GUIDE: CanvasPixel = [218, 216, 206, 255] // Flexoki ui-2 #DAD8CE
const RUN_GPU_BUTTON_POINT: Point = { x: 334, y: 22 }
const circuitHash = (cols: unknown[]): string => encodeURIComponent(JSON.stringify({ cols }))

const amplitudeFirstCellCenterX = (column: number): number =>
  UI_CONSTANTS.LINE_LEFT_OFFSET +
  UI_CONSTANTS.GATE_SIZE +
  UI_CONSTANTS.SLOT_SPACING * column +
  (UI_CONSTANTS.SLOT_SPACING - UI_CONSTANTS.GATE_SIZE) / 2
const amplitudeCellCenterX = (column: number, cell: number): number =>
  amplitudeFirstCellCenterX(column) + UI_CONSTANTS.GATE_SIZE * cell
const probabilityRowCenterY = (span: number, outcome: number): number => {
  const gateHeight = (span - 1) * UI_CONSTANTS.LINE_GAP + UI_CONSTANTS.GATE_SIZE
  const rowHeight = gateHeight / (1 << span)
  return UI_CONSTANTS.LINE_Y - UI_CONSTANTS.GATE_SIZE / 2 + rowHeight * (outcome + 0.5)
}

const execModeProbePoints = (cssWidth: number): PixelSamplePoint[] => [
  { name: 'local', x: cssWidth - 100, y: 23 },
  { name: 'gpu', x: cssWidth - 30, y: 23 },
]

const switchToGpuMode = async (page: Page): Promise<void> => {
  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  const points = execModeProbePoints(box.width)
  await page.mouse.click(box.x + points[1].x, box.y + points[1].y)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pixels = await sampleCanvasPixels(page, canvas, points)
    if (pixelRgbDistance(pixels.gpu, EXEC_MODE_GPU_FILL) < 36) return
    await page.waitForTimeout(50)
  }
  throw new Error('GPU mode did not reach expected fill')
}

const waitForExternalAmplitudeCell = async (
  page: Page,
  gateId: number,
  outcome: number,
  expectedRe = 0.75,
) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const cell = await readAmplitudeCell(page, gateId, outcome)
    if (cell && Math.round(cell.re * 100) / 100 === expectedRe) return cell
    await page.waitForTimeout(50)
  }
  throw new Error(`External Amplitude cell ${gateId}:${outcome} did not become available`)
}

const waitForExternalBlochVector = async (page: Page, gateId: number, expectedX = 0.5) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const vector = (await readBlochVectors(page)).find((entry) => entry.gateId === gateId)
    if (vector && Math.round(vector.x * 100) / 100 === expectedX) return vector
    await page.waitForTimeout(50)
  }
  throw new Error(`External Bloch vector ${gateId} did not become available`)
}

const waitForExternalProbability = async (
  page: Page,
  gateId: number,
  outcome: number,
  expectedProbability: number,
) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const entry = (await readProbabilityDistributions(page)).find((item) => item.gateId === gateId)
    const value = entry?.probabilities[outcome]
    if (value !== undefined && Math.round(value * 100) / 100 === expectedProbability) return value
    await page.waitForTimeout(50)
  }
  throw new Error(`External Probability value ${gateId}:${outcome} did not become available`)
}

const waitForExternalDensityCell = async (
  page: Page,
  gateId: number,
  row: number,
  col: number,
  expectedRe: number,
) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const cell = await readDensityMatrixCell(page, gateId, row, col)
    if (cell && Math.round(cell.re * 100) / 100 === expectedRe) return cell
    await page.waitForTimeout(50)
  }
  throw new Error(`External Density cell ${gateId}:${row},${col} did not become available`)
}

test('GPU mode shows pre-run Amplitude placeholder before Qiskit results', async ({ page }) => {
  await page.goto(`/#${circuitHash([['H'], ['Amps1']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)

  const canvas = page.locator('#egui-canvas')
  const pixel = await sampleCanvasPixels(page, canvas, [
    {
      name: 'placeholder',
      x: amplitudeFirstCellCenterX(1),
      y: UI_CONSTANTS.LINE_Y,
    },
  ])

  expect(pixelRgbDistance(pixel.placeholder, DISPLAY_PLACEHOLDER_FILL)).toBeLessThan(32)
})

test('GPU mode cold-start shows Amplitude placeholder without local state resources', async ({ page }) => {
  const farQubitColumn = Array.from({ length: 17 }, (_, index) => (index === 16 ? 'H' : 1))
  await page.goto(`/#${circuitHash([farQubitColumn, ['Amps1']])}`)
  await waitForStartupReady(page)

  const pixel = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
    { name: 'placeholder', x: amplitudeFirstCellCenterX(1), y: UI_CONSTANTS.LINE_Y },
  ])

  expect(pixelRgbDistance(pixel.placeholder, DISPLAY_PLACEHOLDER_FILL)).toBeLessThan(32)
})

test('GPU mode shows pre-run Probability placeholder before Qiskit results', async ({ page }) => {
  await page.goto(`/#${circuitHash([['H'], ['Probability']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)

  const pixel = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
    { name: 'placeholder', x: amplitudeFirstCellCenterX(1), y: probabilityRowCenterY(1, 0) },
  ])

  expect(pixelRgbDistance(pixel.placeholder, DISPLAY_PLACEHOLDER_FILL)).toBeLessThan(32)
})

test('GPU mode Probability placeholder shows row guide lines', async ({ page }) => {
  await page.goto(`/#${circuitHash([['H'], ['Probability']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)

  const pixel = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
    { name: 'guide', x: amplitudeFirstCellCenterX(1), y: UI_CONSTANTS.LINE_Y + 8 },
  ])

  expect(pixelRgbDistance(pixel.guide, DISPLAY_PLACEHOLDER_GUIDE)).toBeLessThan(36)
})

test('GPU mode cold-start shows Probability placeholder without local state resources', async ({ page }) => {
  const farQubitColumn = Array.from({ length: 17 }, (_, index) => (index === 16 ? 'H' : 1))
  await page.goto(`/#${circuitHash([farQubitColumn, ['Probability']])}`)
  await waitForStartupReady(page)

  const pixel = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
    { name: 'placeholder', x: amplitudeFirstCellCenterX(1), y: probabilityRowCenterY(1, 0) },
  ])

  expect(pixelRgbDistance(pixel.placeholder, DISPLAY_PLACEHOLDER_FILL)).toBeLessThan(32)
})

test('GPU mode shows pre-run Density Matrix placeholder before Qiskit results', async ({ page }) => {
  await page.goto(`/#${circuitHash([['H'], ['Density']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)

  const pixel = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
    { name: 'placeholder', x: amplitudeFirstCellCenterX(1), y: UI_CONSTANTS.LINE_Y },
  ])

  expect(pixelRgbDistance(pixel.placeholder, DISPLAY_PLACEHOLDER_FILL)).toBeLessThan(32)
})

test('Run GPU sends |0> gates to the Qiskit backend', async ({ page }) => {
  await page.goto(`/#${circuitHash([['|0>']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      const payload = JSON.parse(payloadJson)
      ;(window as any).__qniLastQiskitRequest = payload
      const result = {
        status: 'completed',
        runner: 'test',
        qubits: payload.qubits,
        shots: payload.shots,
        histogram: { '0': payload.shots },
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const columns = await page.evaluate(() => (window as any).__qniLastQiskitRequest?.columns)

  expect(columns).toEqual([['|0>']])
})

test('Run GPU sends |1> gates to the Qiskit backend', async ({ page }) => {
  await page.goto(`/#${circuitHash([['|1>']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      const payload = JSON.parse(payloadJson)
      ;(window as any).__qniLastQiskitRequest = payload
      const result = {
        status: 'completed',
        runner: 'test',
        qubits: payload.qubits,
        shots: payload.shots,
        histogram: { '1': payload.shots },
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const columns = await page.evaluate(() => (window as any).__qniLastQiskitRequest?.columns)

  expect(columns).toEqual([['|1>']])
})

test('Run GPU sends QFT and QFT† gates to the Qiskit backend', async ({ page }) => {
  await page.goto(`/#${circuitHash([['QFT2'], ['QFT†2']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      const payload = JSON.parse(payloadJson)
      ;(window as any).__qniLastQiskitRequest = payload
      const result = {
        status: 'completed',
        runner: 'test',
        qubits: payload.qubits,
        shots: payload.shots,
        histogram: { '00': payload.shots },
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const request = await page.evaluate(() => (window as any).__qniLastQiskitRequest)

  expect({ columns: request?.columns, qubits: request?.qubits }).toEqual({
    columns: [['QFT2'], ['QFT†2']],
    qubits: 2,
  })
})

test('Run GPU sends Swap gates to the Qiskit backend', async ({ page }) => {
  await page.goto(`/#${circuitHash([['Swap', 'Swap']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      const payload = JSON.parse(payloadJson)
      ;(window as any).__qniLastQiskitRequest = payload
      const result = {
        status: 'completed',
        runner: 'test',
        qubits: payload.qubits,
        shots: payload.shots,
        histogram: { '00': payload.shots },
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const request = await page.evaluate(() => (window as any).__qniLastQiskitRequest)

  expect({ columns: request?.columns, qubits: request?.qubits }).toEqual({
    columns: [['Swap', 'Swap']],
    qubits: 2,
  })
})

test('Run GPU sends Spacer gates to the Qiskit backend', async ({ page }) => {
  await page.goto(`/#${circuitHash([['…']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      const payload = JSON.parse(payloadJson)
      ;(window as any).__qniLastQiskitRequest = payload
      const result = {
        status: 'completed',
        runner: 'test',
        qubits: payload.qubits,
        shots: payload.shots,
        histogram: { '0': payload.shots },
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const request = await page.evaluate(() => (window as any).__qniLastQiskitRequest)

  expect({ columns: request?.columns, qubits: request?.qubits }).toEqual({
    columns: [['…']],
    qubits: 1,
  })
})

test('Run GPU sends anti-controlled X gates to the Qiskit backend', async ({ page }) => {
  await page.goto(`/#${circuitHash([['◦', 'X']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      const payload = JSON.parse(payloadJson)
      ;(window as any).__qniLastQiskitRequest = payload
      const result = {
        status: 'completed',
        runner: 'test',
        qubits: payload.qubits,
        shots: payload.shots,
        histogram: { '01': payload.shots },
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const request = await page.evaluate(() => (window as any).__qniLastQiskitRequest)

  expect({ columns: request?.columns, qubits: request?.qubits }).toEqual({
    columns: [['◦', 'X']],
    qubits: 2,
  })
})

test('Run GPU sends Measurement gates to the Qiskit backend', async ({ page }) => {
  await page.goto(`/#${circuitHash([['Measure']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      const payload = JSON.parse(payloadJson)
      ;(window as any).__qniLastQiskitRequest = payload
      const result = {
        status: 'completed',
        runner: 'test',
        qubits: payload.qubits,
        shots: payload.shots,
        histogram: { '0': payload.shots },
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const request = await page.evaluate(() => (window as any).__qniLastQiskitRequest)

  expect({ columns: request?.columns, qubits: request?.qubits }).toEqual({
    columns: [['Measure']],
    qubits: 1,
  })
})

test('Run GPU uploads Qiskit Amplitude results into the display buffer', async ({ page }) => {
  await page.goto(`/#${circuitHash([['H'], ['Amps1']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
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
        amplitudes: [
          {
            gate_id: 2,
            span: 1,
            ket: [[0.25, 0], [0.75, 0]],
            incoherent: [0.25, 0.75],
            quality: 1,
            phase_lock_index: -1,
          },
        ],
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const cell = await waitForExternalAmplitudeCell(page, 2, 1)

  expect(Math.round(cell.re * 100) / 100).toBe(0.75)
})

test('Run GPU replaces the Amplitude placeholder with Qiskit-rendered data', async ({ page }) => {
  await page.goto(`/#${circuitHash([['H'], ['Amps1']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      const payload = JSON.parse(payloadJson)
      const result = {
        status: 'completed',
        runner: 'test',
        qubits: payload.qubits,
        shots: payload.shots,
        histogram: { '0': 512, '1': 512 },
        amplitudes: [
          {
            gate_id: 2,
            span: 1,
            ket: [[0.25, 0], [0.75, 0]],
            incoherent: [0.25, 0.75],
            quality: 1,
            phase_lock_index: -1,
          },
        ],
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  await waitForExternalAmplitudeCell(page, 2, 1)
  const pixel = await sampleCanvasPixels(page, canvas, [
    { name: 'result', x: amplitudeCellCenterX(1, 1), y: UI_CONSTANTS.LINE_Y },
  ])

  expect(pixelRgbDistance(pixel.result, DISPLAY_PLACEHOLDER_FILL)).toBeGreaterThan(64)
})

test('Run GPU uploads Qiskit Probability results into the display buffer', async ({ page }) => {
  await page.goto(`/#${circuitHash([['H'], ['Probability']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
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
        probability: [{ gate_id: 2, span: 1, probabilities: [0.25, 0.75] }],
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const probability = await waitForExternalProbability(page, 2, 1, 0.75)

  expect(Math.round(probability * 100) / 100).toBe(0.75)
})

test('Run GPU sends Probability display controls to the Qiskit backend', async ({ page }) => {
  await page.goto(`/#${circuitHash([['•', 'Probability']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      const payload = JSON.parse(payloadJson)
      ;(window as any).__qniLastQiskitRequest = payload
      const result = {
        status: 'completed',
        runner: 'test',
        qubits: payload.qubits,
        shots: payload.shots,
        histogram: { '00': 1024 },
        probability: [{ gate_id: 2, span: 1, probabilities: [1, 0] }],
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const request = await page.evaluate(() => (window as any).__qniLastQiskitRequest)

  expect(request?.outputs?.probability?.[0]).toMatchObject({
    control_mask: 1,
    control_value: 1,
  })
})

test('Run GPU replaces the Probability placeholder with Qiskit-rendered data', async ({ page }) => {
  await page.goto(`/#${circuitHash([['H'], ['Probability']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      const payload = JSON.parse(payloadJson)
      const result = {
        status: 'completed',
        runner: 'test',
        qubits: payload.qubits,
        shots: payload.shots,
        histogram: { '0': 512, '1': 512 },
        probability: [{ gate_id: 2, span: 1, probabilities: [0.25, 0.75] }],
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  await waitForExternalProbability(page, 2, 1, 0.75)
  const pixel = await sampleCanvasPixels(page, canvas, [
    { name: 'result', x: amplitudeFirstCellCenterX(1), y: probabilityRowCenterY(1, 1) },
  ])

  expect(pixelRgbDistance(pixel.result, DISPLAY_PLACEHOLDER_FILL)).toBeGreaterThan(64)
})

test('Run GPU uploads Qiskit Density Matrix results into the display buffer', async ({ page }) => {
  await page.goto(`/#${circuitHash([['H'], ['Density']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
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
        densities: [
          {
            gate_id: 2,
            span: 1,
            cells: [[0.5, 0], [0.25, -0.25], [0.25, 0.25], [0.5, 0]],
            unity: 1,
          },
        ],
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const cell = await waitForExternalDensityCell(page, 2, 0, 1, 0.25)

  expect(Math.round(cell.im * 100) / 100).toBe(-0.25)
})

test('Run GPU uploads combined Qiskit display results into GPU buffers', async ({ page }) => {
  await page.goto(`/#${circuitHash([['H', 1, 1], ['Amps1', 'Bloch', 'Probability']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      const payload = JSON.parse(payloadJson)
      ;(window as any).__qniLastQiskitRequest = payload
      const result = {
        status: 'completed',
        runner: 'test',
        qubits: payload.qubits,
        shots: payload.shots,
        histogram: { '000': 512, '100': 512 },
        amplitudes: [
          {
            gate_id: 2,
            span: 1,
            ket: [[0.4, 0], [0.6, 0]],
            incoherent: [0.4, 0.6],
            quality: 1,
            phase_lock_index: -1,
          },
        ],
        bloch: [{ gate_id: 3, vector: [0.4, 0.2, -0.4] }],
        probability: [{ gate_id: 4, span: 1, probabilities: [0.7, 0.3] }],
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const cell = await waitForExternalAmplitudeCell(page, 2, 1, 0.6)
  const vector = await waitForExternalBlochVector(page, 3, 0.4)
  const probability = await waitForExternalProbability(page, 4, 1, 0.3)

  expect({
    re: Math.round(cell.re * 100) / 100,
    x: Math.round(vector.x * 100) / 100,
    p: Math.round(probability * 100) / 100,
  }).toEqual({ re: 0.6, x: 0.4, p: 0.3 })
})

test('Run GPU preserves shared column controls across four display kinds', async ({ page }) => {
  await page.goto(`/#${circuitHash([['•', 'Bloch', 'Probability', 'Amps1', 'Density']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      ;(window as any).__qniLastQiskitRequest = JSON.parse(payloadJson)
      return { status: 'failed', error: 'request captured' }
    }
  })

  const box = await page.locator('#egui-canvas').boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitRequest !== undefined)
  const outputs = await page.evaluate(() => (window as any).__qniLastQiskitRequest.outputs)

  expect(Object.fromEntries(
    ['bloch', 'probability', 'amplitudes', 'densities'].map((kind) => [
      kind,
      outputs[kind]?.map(({ control_mask, control_value }: { control_mask: number; control_value: number }) => [control_mask, control_value]),
    ]),
  )).toEqual({
    bloch: [[1, 1]],
    probability: [[1, 1]],
    amplitudes: [[1, 1]],
    densities: [[1, 1]],
  })
})

test('Run GPU keeps display controls attached to their own columns', async ({ page }) => {
  await page.goto(`/#${circuitHash([['•', 'Probability'], ['◦', 'Probability']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      ;(window as any).__qniLastQiskitRequest = JSON.parse(payloadJson)
      return { status: 'failed', error: 'request captured' }
    }
  })

  const box = await page.locator('#egui-canvas').boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitRequest !== undefined)
  const requests = await page.evaluate(() => (window as any).__qniLastQiskitRequest.outputs.probability)

  expect(requests.map(({ column, control_mask, control_value }: { column: number; control_mask: number; control_value: number }) => [column, control_mask, control_value])).toEqual([
    [0, 1, 1],
    [1, 1, 0],
  ])
})

test('Run GPU sends Bloch display controls to the Qiskit backend', async ({ page }) => {
  await page.goto(`/#${circuitHash([['•', 'Bloch']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
  await page.evaluate(() => {
    ;(window as any).__qniRunQiskitBackend = async (payloadJson: string) => {
      const payload = JSON.parse(payloadJson)
      ;(window as any).__qniLastQiskitRequest = payload
      const result = {
        status: 'completed',
        runner: 'test',
        qubits: payload.qubits,
        shots: payload.shots,
        histogram: { '00': 1024 },
        bloch: [{ gate_id: 2, vector: [0, 0, 1] }],
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const request = await page.evaluate(() => (window as any).__qniLastQiskitRequest)

  expect(request?.outputs?.bloch?.[0]).toMatchObject({
    control_mask: 1,
    control_value: 1,
  })
})

test('Run GPU uploads Qiskit Bloch results into the display buffer', async ({ page }) => {
  await page.goto(`/#${circuitHash([['H'], ['Bloch']])}`)
  await waitForStartupReady(page, { waitForStateVector: true })
  await switchToGpuMode(page)
  await page.waitForTimeout(100)
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
        bloch: [{ gate_id: 2, vector: [0.5, 0.25, -0.5] }],
        truncated: false,
      }
      ;(window as any).__qniLastQiskitResult = result
      return result
    }
  })

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + RUN_GPU_BUTTON_POINT.x, box.y + RUN_GPU_BUTTON_POINT.y)
  await page.waitForFunction(() => (window as any).__qniLastQiskitResult?.status === 'completed')
  const vector = await waitForExternalBlochVector(page, 2)

  expect(Math.round(vector.x * 100) / 100).toBe(0.5)
})
