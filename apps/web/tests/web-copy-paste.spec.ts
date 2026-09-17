import { expect, test, type Page } from '@playwright/test'
import {
  pixelRgbDistance,
  sampleCanvasPixels,
  UI_CONSTANTS,
  waitForStartupReady,
} from './support/web-spec-helpers'

const EGUI_PANEL_MARGIN = 8
const CIRCUIT_PICKER_TOOLBAR_SHIFT = 98
const SELECTION_BORDER: [number, number, number, number] = [32, 94, 166, 255]
const HOVER_BORDER: [number, number, number, number] = [139, 126, 200, 255]

// These interaction tests share a software WebGPU adapter. Running them in one
// worker avoids frame starvation changing the ordering of pointer/key events.
test.describe.configure({ mode: 'serial' })

const circuitJsonFromUrl = (url: string): string => decodeURIComponent(new URL(url).hash.slice(1))

const openCircuit = async (page: Page, circuitJson: string): Promise<void> => {
  await page.goto(`/#${encodeURIComponent(circuitJson)}`)
  await waitForStartupReady(page)
}

const clickGate = async (page: Page, column: number, wire: number): Promise<void> => {
  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(
    box.x + EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE + UI_CONSTANTS.SLOT_SPACING * column,
    box.y + EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_Y + UI_CONSTANTS.LINE_GAP * wire,
  )
  // egui consumes pointer and keyboard input on separate animation frames. Wait
  // for the selection frame before sending a clipboard shortcut, especially
  // when several WebGPU workers are sharing the software adapter.
  await page.waitForTimeout(50)
}

const circuitCellPoint = async (page: Page, column: number, wire: number) => {
  const box = await page.locator('#egui-canvas').boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  return {
    x: box.x + EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_LEFT_OFFSET + UI_CONSTANTS.GATE_SIZE
      + UI_CONSTANTS.SLOT_SPACING * column,
    y: box.y + EGUI_PANEL_MARGIN + UI_CONSTANTS.LINE_Y + UI_CONSTANTS.LINE_GAP * wire,
  }
}

const clickUndo = async (page: Page): Promise<void> => {
  const box = await page.locator('#egui-canvas').boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + 26 + CIRCUIT_PICKER_TOOLBAR_SHIFT, box.y + 18)
}

const pressShortcut = async (page: Page, shortcut: string): Promise<void> => {
  await page.keyboard.press(shortcut)
  await page.waitForTimeout(100)
}

const waitForCircuitJson = async (page: Page, expected: string): Promise<string> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const actual = circuitJsonFromUrl(page.url())
    if (actual === expected) return actual
    await page.waitForTimeout(50)
  }
  return circuitJsonFromUrl(page.url())
}

test('Ctrl+C and Ctrl+V insert the selected gate before trailing columns', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["H"],["X"]]}')).toBe(
    '{"cols":[["H"],["H"],["X"]]}',
  )
})

test('repeated Ctrl+V keeps the original paste anchor', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')
  await waitForCircuitJson(page, '{"cols":[["H"],["H"],["X"]]}')
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["H"],["H"],["X"]]}')).toBe(
    '{"cols":[["H"],["H"],["H"],["X"]]}',
  )
})

test('copying either side of a CNOT preserves the controlled structure', async ({ page }) => {
  await openCircuit(page, '{"cols":[["•",1,"X"]]}')
  await clickGate(page, 0, 2)
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["•",1,"X"],["•",1,"X"]]}')).toBe(
    '{"cols":[["•",1,"X"],["•",1,"X"]]}',
  )
})

test('a controlled operation uses one selection frame', async ({ page }) => {
  await openCircuit(page, '{"cols":[["•",1,"X"]]}')
  const control = await circuitCellPoint(page, 0, 0)
  const center = await circuitCellPoint(page, 0, 1)
  const probe = {
    name: 'groupFrame',
    x: center.x + UI_CONSTANTS.GATE_SIZE / 2 + 3,
    y: center.y,
  }

  await page.mouse.move(control.x, control.y)
  const hovered = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [probe])
  expect(pixelRgbDistance(hovered.groupFrame, HOVER_BORDER)).toBeLessThan(48)

  await page.mouse.click(control.x, control.y)
  const selected = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [probe])

  expect(pixelRgbDistance(selected.groupFrame, SELECTION_BORDER)).toBeLessThan(48)

  await page.waitForTimeout(400)
  await page.mouse.dblclick(control.x, control.y)
  await expect.poll(async () => {
    const individual = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [probe])
    return Math.min(
      pixelRgbDistance(individual.groupFrame, HOVER_BORDER),
      pixelRgbDistance(individual.groupFrame, SELECTION_BORDER),
    )
  }).toBeGreaterThan(48)
})

test('copying one Swap symbol preserves its pair', async ({ page }) => {
  await openCircuit(page, '{"cols":[["Swap",1,"Swap"]]}')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["Swap",1,"Swap"],["Swap",1,"Swap"]]}')).toBe(
    '{"cols":[["Swap",1,"Swap"],["Swap",1,"Swap"]]}',
  )
})

test('one paste creates one undoable history entry', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')
  await waitForCircuitJson(page, '{"cols":[["H"],["H"],["X"]]}')
  await clickUndo(page)

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["X"]]}')).toBe(
    '{"cols":[["H"],["X"]]}',
  )
})

test('clicking another gate moves the paste anchor without replacing the clipboard', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Control+C')
  await clickGate(page, 1, 0)
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["X"],["H"]]}')).toBe(
    '{"cols":[["H"],["X"],["H"]]}',
  )
})

test('clicking an empty cell moves the paste anchor without replacing the clipboard', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Control+C')
  await clickGate(page, 2, 0)
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["X"],[1],["H"]]}')).toBe(
    '{"cols":[["H"],["X"],[1],["H"]]}',
  )
})

test('clicking an empty cell keeps the selected gate available to copy', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 1, 0)
  await pressShortcut(page, 'Control+C')
  await clickGate(page, 0, 0)
  await clickGate(page, 2, 0)
  await pressShortcut(page, 'Control+C')
  await clickGate(page, 2, 0)
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["X"],[1],["H"]]}')).toBe(
    '{"cols":[["H"],["X"],[1],["H"]]}',
  )
})

test('copying separated selected columns removes unselected columns', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"],["Z"]]}')
  await clickGate(page, 0, 0)
  await page.keyboard.down('Shift')
  await clickGate(page, 2, 0)
  await page.keyboard.up('Shift')
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["X"],["Z"],["H"],["Z"]]}')).toBe(
    '{"cols":[["H"],["X"],["Z"],["H"],["Z"]]}',
  )
})

test('Delete removes the selected gate as one edit', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Delete')

  expect(await waitForCircuitJson(page, '{"cols":[["X"]]}')).toBe('{"cols":[["X"]]}')
})

test('Ctrl+X copies and removes the selected gate', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Control+X')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["X"],["H"]]}')).toBe(
    '{"cols":[["X"],["H"]]}',
  )
})

test('Ctrl+Z and Ctrl+Y undo and redo one paste', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')
  await waitForCircuitJson(page, '{"cols":[["H"],["H"],["X"]]}')
  await pressShortcut(page, 'Control+Z')
  await waitForCircuitJson(page, '{"cols":[["H"],["X"]]}')
  await pressShortcut(page, 'Control+Y')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["H"],["X"]]}')).toBe(
    '{"cols":[["H"],["H"],["X"]]}',
  )
})

test('dragging from an empty cell selects every touched gate before release', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"],["Z"]]}')
  const start = await circuitCellPoint(page, 0, 1)
  const end = await circuitCellPoint(page, 2, 0)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 8 })
  await pressShortcut(page, 'Control+C')
  await page.mouse.up()
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["X"],["Z"],["H"],["X"],["Z"]]}')).toBe(
    '{"cols":[["H"],["X"],["Z"],["H"],["X"],["Z"]]}',
  )
})

test('Ctrl+A selects every gate for copying', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await pressShortcut(page, 'Control+A')
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["X"],["H"],["X"]]}')).toBe(
    '{"cols":[["H"],["X"],["H"],["X"]]}',
  )
})

test('clicking circuit background clears the gate selection', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  const gate = await circuitCellPoint(page, 0, 0)
  await page.mouse.click(gate.x, gate.y + UI_CONSTANTS.LINE_GAP * 2)
  await pressShortcut(page, 'Delete')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["X"]]}')).toBe(
    '{"cols":[["H"],["X"]]}',
  )
})

test('Escape clears the gate selection', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Escape')
  await pressShortcut(page, 'Delete')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["X"]]}')).toBe(
    '{"cols":[["H"],["X"]]}',
  )
})

test('double-clicking a CNOT part copies only that part', async ({ page }) => {
  await openCircuit(page, '{"cols":[["•",1,"X"]]}')
  const target = await circuitCellPoint(page, 0, 2)
  await page.mouse.dblclick(target.x, target.y)
  await page.waitForTimeout(100)
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["•",1,"X"],[1,1,"X"]]}')).toBe(
    '{"cols":[["•",1,"X"],[1,1,"X"]]}',
  )
})
