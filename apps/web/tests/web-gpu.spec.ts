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
  readAmplitudeCell,
  readBlochVectors,
  readDensityMatrixCell,
  readEguiError,
  readMeasurementOutcomes,
  readProbabilityDistributions,
  readStateVector,
  releasePointer,
  sampleCanvasPixels,
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
  UI_CONSTANTS,
} from './support/web-spec-helpers'

// Bloch tip dot colors follow the z gradient defined in src/colors.rs:
// z = +1 (|0⟩) = red-300 #E8705F = rgb(232, 112, 95);
// z =  0 (|+⟩) = purple-400 #8B7EC8 = rgb(139, 126, 200);
// z = -1 (|1⟩) = blue-300 #66A0C8 = rgb(102, 160, 200).
// Thresholds are calibrated to the antialias-free tip-dot center pixels measured
// under SwiftShader; the three are mutually exclusive and all reject the circuit
// background #F2F0E5. These probes confirm the polarity-correct tip color is
// painted at a sampled on-sphere pixel and is absent just outside it.
const isBlochTipRed = ([r, g, b]: CanvasPixel): boolean => r > 200 && g > 90 && g < 135 && b < 120
const isBlochTipBlue = ([r, g, b]: CanvasPixel): boolean => b > 170 && r < 140 && g > 130 && g < 190
const isBlochTipPurple = ([r, g, b]: CanvasPixel): boolean =>
  r > 110 && r < 170 && g > 100 && g < 155 && b > 165
// Measurement outcome digits are painted in a darker blue with no green floor,
// distinct from the brighter blue-300 Bloch south-pole tip above.
const isOutcomeBlue = ([r, g, b]: CanvasPixel): boolean => b > 130 && r < 140 && g < 190

const waitForSeedHook = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => typeof (window as any).__seedCircuits === 'function')
}

const seedActiveCircuit = async (page: Page, circuitJson: string): Promise<void> => {
  await waitForSeedHook(page)
  await page.evaluate((json) => {
    const seed = (window as any).__seedCircuits
    seed(JSON.stringify({
      entries: [{ id: 'overflow', name: 'Overflow', circuit_json: json, updated_at: 1 }],
      active_id: 'overflow',
    }))
  }, circuitJson)
  await page.waitForFunction((json) => {
    const snapshot = (window as any).__qniCircuitPickerSnapshot
    if (typeof snapshot !== 'function') return false
    return JSON.parse(snapshot()).entries[0]?.circuit_json === json
  }, circuitJson)
}

const readGpuPlanCapacityError = async (page: Page): Promise<string | null> =>
  page.evaluate(() => (window as any).__qniGpuPlanCapacityError ?? null)

const hasCapacityErrorCardPixels = async (page: Page): Promise<boolean> => {
  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) return false
  const screenshot = await canvas.screenshot({ type: 'png' })
  return page.evaluate(async ({ base64, cssWidth, cssHeight, stateBottomMargin, stateViewportHeight }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${base64}`
    await new Promise((resolve, reject) => {
      img.onload = () => resolve(null)
      img.onerror = () => reject(new Error('Failed to decode screenshot'))
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return false
    context.drawImage(img, 0, 0)
    const scaleX = img.width / cssWidth
    const scaleY = img.height / cssHeight
    const centerX = cssWidth / 2
    const centerY = cssHeight - stateBottomMargin - stateViewportHeight / 2
    let redPixels = 0
    for (let y = centerY - 40; y <= centerY + 40; y += 2) {
      for (let x = centerX - 220; x <= centerX + 220; x += 2) {
        const [r, g, b, a] = context.getImageData(Math.floor(x * scaleX), Math.floor(y * scaleY), 1, 1).data
        if (a > 200 && r > 130 && r > g + 40 && r > b + 40 && g < 130 && b < 130) {
          redPixels += 1
        }
      }
    }
    return redPixels > 30
  }, {
    base64: screenshot.toString('base64'),
    cssWidth: box.width,
    cssHeight: box.height,
    stateBottomMargin: UI_CONSTANTS.STATE_CIRCLE_BOTTOM_MARGIN,
    stateViewportHeight: UI_CONSTANTS.STATE_VIEWPORT_DEFAULT_HEIGHT,
  })
}

const waitForCapacityErrorCardVisible = async (page: Page): Promise<boolean> => {
  const deadline = Date.now() + 5000
  while (Date.now() <= deadline) {
    if (await hasCapacityErrorCardPixels(page)) return true
    await page.waitForTimeout(50)
  }
  return false
}

test('GPU capacity overflow shows a visible error card instead of recomputing empty ops', async ({ page }) => {
  await page.goto('/')
  await waitForStartupReady(page)
  const columns = Array.from({ length: 257 }, () => ['H'])
  await seedActiveCircuit(page, JSON.stringify({ cols: columns }))
  await page.waitForFunction(() => String((window as any).__qniGpuPlanCapacityError ?? '').includes('MAX_OPS_PER_RECOMPUTE'))

  await expect(await waitForCapacityErrorCardVisible(page)).toBe(true)
})

test('GPU capacity rejects sparse step snapshot caches before allocation', async ({ page }) => {
  await page.goto('/')
  await waitForStartupReady(page)
  const columns: unknown[][] = Array.from({ length: 258 }, () => [])
  columns[257] = ['H']
  await seedActiveCircuit(page, JSON.stringify({ cols: columns }))
  await page.waitForFunction(() => String((window as any).__qniGpuPlanCapacityError ?? '').includes('MAX_STEP_SNAPSHOT_SLOTS'))

  await expect(await waitForCapacityErrorCardVisible(page)).toBe(true)
})

test('GPU capacity error hook clears after a valid recompute', async ({ page }) => {
  await page.goto('/')
  await waitForStartupReady(page)
  const columns = Array.from({ length: 257 }, () => ['H'])
  await seedActiveCircuit(page, JSON.stringify({ cols: columns }))
  await page.waitForFunction(() => typeof (window as any).__qniGpuPlanCapacityError === 'string')
  await seedActiveCircuit(page, JSON.stringify({ cols: [['H']] }))

  await expect.poll(async () => readGpuPlanCapacityError(page)).toBeNull()
})

test('GPU compute pipeline applies a unitary chain end-to-end', async ({ page }) => {
  // Specifically targets the GPU per-gate compute path: a circuit with no
  // measurements should be simulated entirely by the WGSL `STATE_COMPUTE_SHADER`
  // dispatched once per linearised GateParams. We assert against the textbook
  // amplitudes for H q0 → CNOT(q0, q1) → Z q0 → H q0 (Bell-like prep with a
  // phase flip), which exercises matrix multiply + control mask + sign flip in
  // a single dispatch chain.
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
  const LINE_LEFT_OFFSET = CIRCUIT_PADDING + QUBIT_LABEL_WIDTH + QUBIT_LABEL_GAP
  const LINE_Y = UI_CONSTANTS.LINE_Y
  const LINE_GAP = UI_CONSTANTS.LINE_GAP

  const hSource = getPaletteGateCenter(cssWidth, 0)
  const xSource = getPaletteGateCenter(cssWidth, 1)
  const zSource = getPaletteGateCenter(cssWidth, 3)
  const controlSource = getPaletteGateCenter(cssWidth, 14)
  const targetX = LINE_LEFT_OFFSET + GATE_SIZE
  const targetX2 = targetX + SLOT_SPACING
  const targetX3 = targetX2 + SLOT_SPACING
  const targetX4 = targetX3 + SLOT_SPACING
  const targetY0 = LINE_Y
  const targetY1 = LINE_Y + LINE_GAP

  // H q0
  await dragPointer(page, hSource, { x: targetX, y: targetY0 })
  // CNOT(q0, q1) — control q0 + X q1 in slot 1
  await dragPointer(page, controlSource, { x: targetX2, y: targetY0 })
  await dragPointer(page, xSource, { x: targetX2, y: targetY1 })
  // Z q0 in slot 2
  await dragPointer(page, zSource, { x: targetX3, y: targetY0 })
  // H q0 in slot 3
  await dragPointer(page, hSource, { x: targetX4, y: targetY0 })

  // After H q0: (|00⟩+|10⟩)/√2 → CNOT: (|00⟩+|11⟩)/√2 → Z q0: (|00⟩-|11⟩)/√2
  // → H q0: (|00⟩+|01⟩-|10⟩+|11⟩)/2 in |q1 q0⟩ order, i.e. amplitudes
  // (+,+,-,+)/2 on state indices 0..3 (index n = q0 + 2·q1; q0 is LSB).
  const half = 0.5
  await waitForStateVectorApprox(page, [half, 0, half, 0, -half, 0, half, 0])
})

test('GPU bloch reduction captures the textbook vectors per qubit', async ({ page }) => {
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
  const LINE_LEFT_OFFSET = CIRCUIT_PADDING + QUBIT_LABEL_WIDTH + QUBIT_LABEL_GAP
  const LINE_Y = UI_CONSTANTS.LINE_Y
  const LINE_GAP = UI_CONSTANTS.LINE_GAP

  const hSource = getPaletteGateCenter(cssWidth, 0)
  const xSource = getPaletteGateCenter(cssWidth, 1)
  const blochSource = getPaletteGateCenter(cssWidth, 16)
  const targetX = LINE_LEFT_OFFSET + GATE_SIZE
  const targetX2 = targetX + SLOT_SPACING
  const targetY0 = LINE_Y
  const targetY1 = LINE_Y + LINE_GAP

  // q0: H placed first → |+⟩ → bloch should report +x.
  await dragPointer(page, hSource, { x: targetX, y: targetY0 })
  await dragPointer(page, blochSource, { x: targetX2, y: targetY0 })
  // q1: X placed first → |1⟩ → bloch should report -z.
  await dragPointer(page, xSource, { x: targetX, y: targetY1 })
  await dragPointer(page, blochSource, { x: targetX2, y: targetY1 })

  await waitForBlochVectorsApprox(page, [
    [1, 0, 0],
    [0, 0, -1],
  ])
})

test('GPU bloch reduction follows snapped drag placement before drop', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H'], ['Bloch']] })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForBlochVectorsApprox(page, [[1, 0, 0]])

  const source = {
    x: UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE + UI_CONSTANTS.SLOT_SPACING,
    y: UI_CONSTANTS.LINE_Y,
  }
  await dragPointer(
    page,
    source,
    { x: source.x, y: UI_CONSTANTS.LINE_Y + UI_CONSTANTS.LINE_GAP },
    6,
    false,
  )
  let vector: { x: number; y: number; z: number } | undefined
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [entry] = await readBlochVectors(page)
    if (entry && Math.abs(entry.z - 1) < 1e-3) {
      vector = entry
      break
    }
    await page.waitForTimeout(50)
  }
  if (!vector) throw new Error('dragged Bloch vector did not update before drop')
  const canvas = page.locator('#egui-canvas')
  const eguiPanelMargin = 8
  const liveX = eguiPanelMargin + source.x
  const liveY = eguiPanelMargin + UI_CONSTANTS.LINE_Y + UI_CONSTANTS.LINE_GAP - 21
  const samples = await sampleCanvasPixels(page, canvas, [{ name: 'liveTip', x: liveX, y: liveY }])
  await page.mouse.up()

  const rounded = (value: number): number => {
    const v = Math.round(value * 1000) / 1000
    return Math.abs(v) < 0.001 ? 0 : v
  }
  expect({
    x: rounded(vector.x),
    y: rounded(vector.y),
    z: rounded(vector.z),
    // z = +1 (|0⟩) → the snapped live tip is painted red-300.
    liveTipRed: isBlochTipRed(samples.liveTip),
  }).toEqual({ x: 0, y: 0, z: 1, liveTipRed: true })
})

test('GPU measurement digit follows snapped drag placement before drop', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [[1, 'X'], ['Measure']] })))
  await waitForStartupReady(page, { waitForStateVector: true })

  let initialOutcomeReady = false
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [entry] = await readMeasurementOutcomes(page)
    if (entry?.outcome === 0) {
      initialOutcomeReady = true
      break
    }
    await page.waitForTimeout(50)
  }
  if (!initialOutcomeReady) throw new Error('measurement outcome did not initialize before drag')
  const source = {
    x: UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE + UI_CONSTANTS.SLOT_SPACING,
    y: UI_CONSTANTS.LINE_Y,
  }
  await dragPointer(page, source, { x: source.x, y: UI_CONSTANTS.LINE_Y + UI_CONSTANTS.LINE_GAP }, 6, false)
  let outcome: number | undefined
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [entry] = await readMeasurementOutcomes(page)
    if (entry?.outcome === 1) {
      outcome = entry.outcome
      break
    }
    await page.waitForTimeout(50)
  }
  if (outcome !== 1) throw new Error('dragged measurement outcome did not update before drop')
  const canvas = page.locator('#egui-canvas')
  const eguiPanelMargin = 8
  const liveX = eguiPanelMargin + source.x
  const liveY = eguiPanelMargin + UI_CONSTANTS.LINE_Y + UI_CONSTANTS.LINE_GAP
  const samples = await sampleCanvasPixels(page, canvas, [{ name: 'liveDigit', x: liveX, y: liveY }])
  await page.mouse.up()

  expect({ outcome, liveDigitBlue: isOutcomeBlue(samples.liveDigit) }).toEqual({
    outcome: 1,
    liveDigitBlue: true,
  })
})

test('GPU display readouts and state vector follow snapped palette gate before drop', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({
    cols: [[], ['Bloch'], ['Probability'], ['Amps1'], ['Density']],
  })))
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
  const target = {
    x: UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE,
    y: UI_CONSTANTS.LINE_Y,
  }

  await dragPointer(page, hSource, target, 6, false)

  const round = (value: number | undefined): number | null => {
    if (value === undefined || !Number.isFinite(value)) return null
    const rounded = Math.round(value * 1000) / 1000
    return Math.abs(rounded) < 0.001 ? 0 : rounded
  }
  const expected = {
    state: [0.707, 0, 0.707, 0],
    bloch: [1, 0, 0],
    probability: [0.5, 0.5],
    amplitude: [0.707, 0, 0.707, 0],
    density: [0.5, 0, 0.5, 0],
  }
  let observed: typeof expected | undefined
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await readStateVector(page) as number[]
    const [bloch] = await readBlochVectors(page)
    const [probability] = await readProbabilityDistributions(page)
    const amplitude0 = await readAmplitudeCell(page, 3, 0)
    const amplitude1 = await readAmplitudeCell(page, 3, 1)
    const density00 = await readDensityMatrixCell(page, 4, 0, 0)
    const density01 = await readDensityMatrixCell(page, 4, 0, 1)
    const candidate = {
      state: state.slice(0, 4).map(round),
      bloch: [round(bloch?.x), round(bloch?.y), round(bloch?.z)],
      probability: probability?.gateId === 2
        ? probability.probabilities.slice(0, 2).map(round)
        : [],
      amplitude: [round(amplitude0?.re), round(amplitude0?.im), round(amplitude1?.re), round(amplitude1?.im)],
      density: [round(density00?.re), round(density00?.im), round(density01?.re), round(density01?.im)],
    }
    observed = candidate as typeof expected
    if (JSON.stringify(candidate) === JSON.stringify(expected)) {
      break
    }
    await page.waitForTimeout(50)
  }
  await page.mouse.up()

  expect(observed).toEqual(expected)
})

test('GPU state vector follows insert-snap ordering before drop', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H'], ['Bloch']] })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForBlochVectorsApprox(page, [[1, 0, 0]])

  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  const viewport = page.viewportSize()
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  const cssWidth = box?.width ?? (viewport?.width ?? 1000)
  const xSource = getPaletteGateCenter(cssWidth, 1)
  const insertBeforeFirstColumn = {
    x: UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE - UI_CONSTANTS.SLOT_SPACING / 2,
    y: UI_CONSTANTS.LINE_Y,
  }

  await dragPointer(page, xSource, insertBeforeFirstColumn, 6, false)

  const round = (value: number | undefined): number | null => {
    if (value === undefined || !Number.isFinite(value)) return null
    const rounded = Math.round(value * 1000) / 1000
    return Math.abs(rounded) < 0.001 ? 0 : rounded
  }
  const expected = {
    state: [0.707, 0, -0.707, 0],
    bloch: [-1, 0, 0],
  }
  let observed: typeof expected | undefined
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await readStateVector(page) as number[]
    const [bloch] = await readBlochVectors(page)
    const candidate = {
      state: state.slice(0, 4).map(round),
      bloch: [round(bloch?.x), round(bloch?.y), round(bloch?.z)],
    }
    observed = candidate as typeof expected
    if (JSON.stringify(candidate) === JSON.stringify(expected)) {
      break
    }
    await page.waitForTimeout(50)
  }
  await page.mouse.up()

  expect(observed).toEqual(expected)
})

test('GPU circuit overlays stay optically anchored to measurement and Bloch bodies', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['X'], ['Measure'], ['Bloch']] })))

  await waitForStartupReady(page, { waitForStateVector: true })
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const REM = 32
  const GATE_SIZE = UI_CONSTANTS.GATE_SIZE
  const SLOT_SPACING = UI_CONSTANTS.SLOT_SPACING
  const CIRCUIT_PADDING = 2 * REM
  const QUBIT_LABEL_WIDTH = 3 * 14
  const QUBIT_LABEL_GAP = 0.5 * REM
  const LINE_LEFT_OFFSET = CIRCUIT_PADDING + QUBIT_LABEL_WIDTH + QUBIT_LABEL_GAP
  const LINE_Y = UI_CONSTANTS.LINE_Y
  // Egui keeps an 8px panel margin inside the canvas; the interaction helpers
  // can be fuzzy because snap distance absorbs it, but visual pixel probes need
  // the actual painted position.
  const EGUI_PANEL_MARGIN = 8
  const slotCenter = (column: number) =>
    EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING * column
  const wireCenterY = EGUI_PANEL_MARGIN + LINE_Y

  const measureX = slotCenter(1)
  const blochX = slotCenter(2)
  const samples = await sampleCanvasPixels(page, canvas, [
    { name: 'circuit_background', x: blochX + 80, y: wireCenterY - 20 },
    { name: 'measurement_gap_left', x: measureX - UI_CONSTANTS.GATE_SIZE / 2, y: wireCenterY },
    { name: 'measurement_wire_left', x: measureX - UI_CONSTANTS.GATE_SIZE / 2 - 8, y: wireCenterY },
    { name: 'measurement_digit_centered', x: measureX, y: wireCenterY },
    { name: 'bloch_tip_on_sphere', x: blochX, y: wireCenterY + 21 },
    { name: 'bloch_tip_outside_sphere', x: blochX, y: wireCenterY + 26 },
  ])

  const isCircuitBackground = ([r, g, b]: CanvasPixel): boolean =>
    Math.abs(r - 242) + Math.abs(g - 240) + Math.abs(b - 229) < 40
  const isWireLine = ([r, g, b]: CanvasPixel): boolean =>
    Math.abs(r - 218) + Math.abs(g - 216) + Math.abs(b - 206) < 40

  const restingProbe = {
    circuitBackground: isCircuitBackground(samples.circuit_background),
    measurementGapLeft: isCircuitBackground(samples.measurement_gap_left),
    measurementWireLeft: isWireLine(samples.measurement_wire_left),
    measurementDigitCentered: isOutcomeBlue(samples.measurement_digit_centered),
    // X then Measure leaves q0 in |1⟩ → z = -1, so the south-pole tip is blue-300.
    blochTipOnSphere: isBlochTipBlue(samples.bloch_tip_on_sphere),
    blochTipOutsideSphere: isBlochTipBlue(samples.bloch_tip_outside_sphere),
  }

  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  await page.mouse.move((box?.x ?? 0) + measureX, (box?.y ?? 0) + wireCenterY)
  await page.waitForTimeout(100)
  const hoverSamples = await sampleCanvasPixels(page, canvas, [
    { name: 'measurement_hover_left_side', x: measureX - UI_CONSTANTS.GATE_SIZE / 2 - 5, y: wireCenterY },
    { name: 'measurement_hover_right_side', x: measureX + UI_CONSTANTS.GATE_SIZE / 2 + 5, y: wireCenterY },
  ])
  const isHoverBorder = ([r, g, b]: CanvasPixel): boolean =>
    (r >= 210 && r <= 245 && g >= 208 && g <= 245 && b >= 200 && b <= 235) ||
    pixelRgbDistance([r, g, b, 255], [139, 126, 200, 255]) < 48
  expect({
    ...restingProbe,
    hoverLeftSide: isHoverBorder(hoverSamples.measurement_hover_left_side),
    hoverRightSide: isHoverBorder(hoverSamples.measurement_hover_right_side),
  }).toEqual({
    circuitBackground: true,
    measurementGapLeft: true,
    measurementWireLeft: true,
    measurementDigitCentered: true,
    blochTipOnSphere: true,
    blochTipOutsideSphere: false,
    hoverLeftSide: true,
    hoverRightSide: true,
  })
})

test('GPU circuit overlays stay anchored in tall scroll-area viewports', async ({ page }) => {
  const col0 = Array(16).fill(1)
  col0[0] = 'X'
  col0[15] = 'H'
  const col1 = Array(16).fill(1)
  col1[1] = 'Measure'
  const col2 = Array(16).fill(1)
  col2[0] = 'Measure'
  col2[2] = 'Bloch'
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [col0, col1, col2] })))

  await waitForStartupReady(page, { waitForStateVector: true })
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const REM = 32
  const GATE_SIZE = UI_CONSTANTS.GATE_SIZE
  const SLOT_SPACING = UI_CONSTANTS.SLOT_SPACING
  const CIRCUIT_PADDING = 2 * REM
  const QUBIT_LABEL_WIDTH = 3 * 14
  const QUBIT_LABEL_GAP = 0.5 * REM
  const LINE_LEFT_OFFSET = CIRCUIT_PADDING + QUBIT_LABEL_WIDTH + QUBIT_LABEL_GAP
  const LINE_Y = UI_CONSTANTS.LINE_Y
  const LINE_GAP = UI_CONSTANTS.LINE_GAP
  const EGUI_PANEL_MARGIN = 8
  const slotCenter = (column: number) =>
    EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING * column
  const wireCenterY = (wire: number) => EGUI_PANEL_MARGIN + LINE_Y + LINE_GAP * wire

  const overlayX = slotCenter(2)
  const samples = await sampleCanvasPixels(page, canvas, [
    { name: 'measurement_digit_too_high', x: overlayX, y: wireCenterY(0) - 12 },
    { name: 'measurement_digit_on_wire', x: overlayX, y: wireCenterY(0) },
    { name: 'bloch_tip_on_sphere', x: overlayX, y: wireCenterY(2) - 21 },
    { name: 'bloch_tip_too_high', x: overlayX, y: wireCenterY(2) - 26 },
  ])

  expect({
    measurementDigitTooHigh: isOutcomeBlue(samples.measurement_digit_too_high),
    measurementDigitOnWire: isOutcomeBlue(samples.measurement_digit_on_wire),
    // The Bloch on wire 2 has no gate → |0⟩ → z = +1, so the north-pole tip is red-300.
    blochTipOnSphere: isBlochTipRed(samples.bloch_tip_on_sphere),
    blochTipTooHigh: isBlochTipRed(samples.bloch_tip_too_high),
  }).toEqual({
    measurementDigitTooHigh: false,
    measurementDigitOnWire: true,
    blochTipOnSphere: true,
    blochTipTooHigh: false,
  })
})

test('GPU bloch tip is purple at the equator for |+⟩', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H'], ['Bloch']] })))

  await waitForStartupReady(page, { waitForStateVector: true })
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })

  const REM = 32
  const GATE_SIZE = UI_CONSTANTS.GATE_SIZE
  const SLOT_SPACING = UI_CONSTANTS.SLOT_SPACING
  const CIRCUIT_PADDING = 2 * REM
  const QUBIT_LABEL_WIDTH = 3 * 14
  const QUBIT_LABEL_GAP = 0.5 * REM
  const LINE_LEFT_OFFSET = CIRCUIT_PADDING + QUBIT_LABEL_WIDTH + QUBIT_LABEL_GAP
  const LINE_Y = UI_CONSTANTS.LINE_Y
  const EGUI_PANEL_MARGIN = 8
  const blochX = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING * 1
  const wireCenterY = EGUI_PANEL_MARGIN + LINE_Y

  // H|0⟩ = |+⟩ → bloch (1, 0, 0), z = 0. The perspective projection in
  // bloch_project (src/gpu/shaders/bloch_overlay.wgsl) puts the equator tip at
  // local (-6.33, +6.33) from the sphere center, i.e. down-left of center, where
  // the gradient midpoint is painted purple-400.
  const samples = await sampleCanvasPixels(page, canvas, [
    { name: 'equator_tip', x: blochX - 6, y: wireCenterY + 6 },
    { name: 'off_tip', x: blochX + 80, y: wireCenterY - 20 },
  ])

  expect({
    // The equator tip is the gradient midpoint: purple, neither pole color.
    equatorTipPurple: isBlochTipPurple(samples.equator_tip),
    equatorTipRed: isBlochTipRed(samples.equator_tip),
    equatorTipBlue: isBlochTipBlue(samples.equator_tip),
    offTipPurple: isBlochTipPurple(samples.off_tip),
  }).toEqual({ equatorTipPurple: true, equatorTipRed: false, equatorTipBlue: false, offTipPurple: false })
})

test('Write and measurement digits share the same SDF size', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['|0>', '|1>'], ['Measure', 'Measure']] })))

  await waitForStartupReady(page, { waitForStateVector: true })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await readMeasurementOutcomes(page)).length === 2) break
    await page.waitForTimeout(50)
  }
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
  const LINE_Y = UI_CONSTANTS.LINE_Y
  const LINE_GAP = UI_CONSTANTS.LINE_GAP
  const EGUI_PANEL_MARGIN = 8
  const slotCenter = (column: number) =>
    EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + GATE_SIZE + SLOT_SPACING * column
  const wireCenterY = (wire: number) => EGUI_PANEL_MARGIN + LINE_Y + LINE_GAP * wire
  const centers = {
    write0: { x: slotCenter(0), y: wireCenterY(0) },
    write1: { x: slotCenter(0), y: wireCenterY(1) },
    measure0: { x: slotCenter(1), y: wireCenterY(0) + 1 },
    measure1: { x: slotCenter(1), y: wireCenterY(1) + 1 },
  }
  const screenshot = await canvas.screenshot({ type: 'png' })
  const digitMetrics = await page.evaluate<
    Record<keyof typeof centers, { width: number; height: number }>,
    { base64: string; cssWidth: number; cssHeight: number; centers: typeof centers }
  >(async ({ base64, cssWidth, cssHeight, centers }) => {
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
      throw new Error('expected 2d context')
    }
    ctx.drawImage(img, 0, 0)
    const scaleX = img.width / cssWidth
    const scaleY = img.height / cssHeight
    const distance = (rgb: [number, number, number], target: [number, number, number]) =>
      Math.abs(rgb[0] - target[0]) + Math.abs(rgb[1] - target[1]) + Math.abs(rgb[2] - target[2])
    const measure = (center: { x: number; y: number }, target: [number, number, number]) => {
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      for (let y = 2; y < 30; y += 1) {
        for (let x = 2; x < 30; x += 1) {
          const [r, g, b, a] = ctx.getImageData(
            Math.floor((center.x - 16 + x) * scaleX),
            Math.floor((center.y - 16 + y) * scaleY),
            1,
            1,
          ).data
          if (a > 128 && distance([r, g, b], target) < 70) {
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
          }
        }
      }
      return { width: maxX - minX + 1, height: maxY - minY + 1 }
    }
    return {
      write0: measure(centers.write0, [175, 48, 41]),
      write1: measure(centers.write1, [32, 94, 166]),
      measure0: measure(centers.measure0, [175, 48, 41]),
      measure1: measure(centers.measure1, [32, 94, 166]),
    }
  }, { base64: screenshot.toString('base64'), cssWidth: box.width, cssHeight: box.height, centers })

  expect(digitMetrics).toEqual({
    write0: { width: 10, height: 16 },
    write1: { width: 10, height: 16 },
    measure0: { width: 10, height: 16 },
    measure1: { width: 10, height: 16 },
  })
})

test('GPU measurement collapses |1> deterministically with outcome 1', async ({ page }) => {
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
  const LINE_LEFT_OFFSET = CIRCUIT_PADDING + QUBIT_LABEL_WIDTH + QUBIT_LABEL_GAP
  const LINE_Y = UI_CONSTANTS.LINE_Y

  const xSource = getPaletteGateCenter(cssWidth, 1)
  const measureSource = getPaletteGateCenter(cssWidth, 19)
  const targetX = LINE_LEFT_OFFSET + GATE_SIZE
  const targetX2 = targetX + SLOT_SPACING
  const targetY = LINE_Y

  await dragPointer(page, xSource, { x: targetX, y: targetY })
  await waitForStateVectorApprox(page, [0, 0, 1, 0])
  await dragPointer(page, measureSource, { x: targetX2, y: targetY })

  // pZero is exactly 0 because q0 = |1⟩, so the GPU sample and collapse must
  // converge on outcome=1 and a state of |1⟩ (the same amplitude as before
  // collapse, just normalized).
  await expect
    .poll(async () => {
      const outcomes = await readMeasurementOutcomes(page)
      if (outcomes.length !== 1) {
        return false
      }
      return outcomes[0].outcome === 1
    }, { timeout: 5000 })
    .toBe(true)
  await waitForStateVectorApprox(page, [0, 0, 1, 0])
})
