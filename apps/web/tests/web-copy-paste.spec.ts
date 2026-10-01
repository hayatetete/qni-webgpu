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

const controlledFrameProbe = async (page: Page) => {
  await openCircuit(page, '{"cols":[["•",1,"X"]]}')
  const control = await circuitCellPoint(page, 0, 0)
  const center = await circuitCellPoint(page, 0, 1)
  return {
    control,
    probe: {
      name: 'groupFrame',
      x: center.x + UI_CONSTANTS.GATE_SIZE / 2 + 3,
      y: center.y,
    },
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

test('paste scrolls smoothly to reveal an insertion beyond the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 720 })
  await openCircuit(page, '{"cols":[[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],["H"]]}')
  await pressShortcut(page, 'Control+A')
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')
  await waitForCircuitJson(page, '{"cols":[[1],[1],[1],[1],[1],[1],[1],[1],[1],[1],["H"],["H"]]}')
  await expect.poll(() => page.evaluate(() => (window as any).__qniCircuitScrollX ?? 0)).toBeGreaterThan(0)
})

test('paste preview draws a ghost wire for a future qubit', async ({ page }) => {
  await openCircuit(page, '{"cols":[["•","X"]]}')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Control+C')
  const anchor = await circuitCellPoint(page, 1, 1)
  await page.mouse.click(anchor.x, anchor.y)
  await page.waitForTimeout(600)

  await expect(page.locator('#egui-canvas')).toHaveScreenshot('paste-future-wire.png')
})

const capacityErrorCircuit = '{"cols":[[1,1,1,1,1,1,1,1,1,1,1,1,1,1,"•","X"]]}'

const triggerPasteCapacityError = async (page: Page): Promise<string> => {
  await page.setViewportSize({ width: 1000, height: 1400 })
  await openCircuit(page, capacityErrorCircuit)
  await clickGate(page, 0, 14)
  await pressShortcut(page, 'Control+C')
  const anchor = await circuitCellPoint(page, 1, 15)
  await page.mouse.click(anchor.x, anchor.y)
  await pressShortcut(page, 'Control+V')
  return circuitJsonFromUrl(page.url())
}

test('paste beyond the local qubit capacity shows an error notification', async ({ page }) => {
  await triggerPasteCapacityError(page)

  await expect(page.locator('#egui-canvas')).toHaveScreenshot('paste-capacity-error.png')
})

test('paste beyond the local qubit capacity leaves the circuit unchanged', async ({ page }) => {
  const circuitJson = await triggerPasteCapacityError(page)

  expect(circuitJson).toBe(capacityErrorCircuit)
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

test('a controlled operation uses one hover frame', async ({ page }) => {
  const { control, probe } = await controlledFrameProbe(page)
  await page.mouse.move(control.x, control.y)
  const hovered = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [probe])

  expect(pixelRgbDistance(hovered.groupFrame, HOVER_BORDER)).toBeLessThan(48)
})

test('a controlled operation uses one selection frame', async ({ page }) => {
  const { control, probe } = await controlledFrameProbe(page)
  await page.mouse.click(control.x, control.y)
  const selected = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [probe])

  expect(pixelRgbDistance(selected.groupFrame, SELECTION_BORDER)).toBeLessThan(48)
})

test('double-clicking a controlled gate removes its group frame', async ({ page }) => {
  const { control, probe } = await controlledFrameProbe(page)
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

test('undo after deletion restores only the deletion and keeps the paste', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')
  await waitForCircuitJson(page, '{"cols":[["H"],["H"],["X"]]}')
  await clickGate(page, 2, 0)
  await pressShortcut(page, 'Delete')
  await waitForCircuitJson(page, '{"cols":[["H"],["H"]]}')
  await pressShortcut(page, 'Control+Z')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["H"],["X"]]}')).toBe(
    '{"cols":[["H"],["H"],["X"]]}',
  )
})

test('undo after dragging restores only the drag and keeps the paste', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')
  await waitForCircuitJson(page, '{"cols":[["H"],["H"],["X"]]}')
  const from = await circuitCellPoint(page, 2, 0)
  const to = await circuitCellPoint(page, 2, 1)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
  await waitForCircuitJson(page, '{"cols":[["H"],["H"],[1,"X"]]}')
  await pressShortcut(page, 'Control+Z')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["H"],["X"]]}')).toBe(
    '{"cols":[["H"],["H"],["X"]]}',
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

test('quick clicks on different gates do not create an additive selection', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await clickGate(page, 1, 0)
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["X"],["X"]]}')).toBe(
    '{"cols":[["H"],["X"],["X"]]}',
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

test('rectangle selection without Shift replaces the previous selection', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"],["Z"]]}')
  await clickGate(page, 0, 0)
  const start = await circuitCellPoint(page, 1, 1)
  const target = await circuitCellPoint(page, 2, 0)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 4 })
  await page.mouse.up()
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["X"],["Z"],["X"],["Z"]]}')).toBe(
    '{"cols":[["H"],["X"],["Z"],["X"],["Z"]]}',
  )
})

test('rectangle selection with Shift adds to the previous selection', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"],["Z"]]}')
  await clickGate(page, 0, 0)
  const start = await circuitCellPoint(page, 1, 1)
  const target = await circuitCellPoint(page, 2, 0)
  await page.keyboard.down('Shift')
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 4 })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')

  expect(
    await waitForCircuitJson(page, '{"cols":[["H"],["X"],["Z"],["H"],["X"],["Z"]]}'),
  ).toBe('{"cols":[["H"],["X"],["Z"],["H"],["X"],["Z"]]}')
})

test('rectangle selection expands a touched CNOT part to its operation', async ({ page }) => {
  await openCircuit(page, '{"cols":[["•",1,"X"]]}')
  const start = await circuitCellPoint(page, 0, 3)
  const target = await circuitCellPoint(page, 0, 2)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 4 })
  await pressShortcut(page, 'Control+C')
  await page.mouse.up()
  await pressShortcut(page, 'Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["•",1,"X"],["•",1,"X"]]}')).toBe(
    '{"cols":[["•",1,"X"],["•",1,"X"]]}',
  )
})

test('Escape cancels an active rectangle selection', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  const start = await circuitCellPoint(page, 0, 1)
  const gate = await circuitCellPoint(page, 1, 0)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(gate.x, gate.y, { steps: 4 })
  await pressShortcut(page, 'Escape')
  await page.mouse.up()
  await pressShortcut(page, 'Delete')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["X"]]}')).toBe(
    '{"cols":[["H"],["X"]]}',
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

test('double-clicking a CNOT part preserves unrelated selected gates', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["•",1,"X"]]}')
  await clickGate(page, 0, 0)
  const target = await circuitCellPoint(page, 1, 2)
  await page.keyboard.down('Shift')
  await page.mouse.click(target.x, target.y)
  await page.keyboard.up('Shift')
  await page.waitForTimeout(600)
  await page.mouse.dblclick(target.x, target.y)
  await pressShortcut(page, 'Control+C')
  await pressShortcut(page, 'Control+V')

  expect(
    await waitForCircuitJson(
      page,
      '{"cols":[["H"],["•",1,"X"],["H"],[1,1,"X"]]}',
    ),
  ).toBe('{"cols":[["H"],["•",1,"X"],["H"],[1,1,"X"]]}')
})
