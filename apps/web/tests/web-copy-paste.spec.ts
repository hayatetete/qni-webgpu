import { expect, test, type Page } from '@playwright/test'
import {
  UI_CONSTANTS,
  waitForStartupReady,
} from './support/web-spec-helpers'

const EGUI_PANEL_MARGIN = 8
const CIRCUIT_PICKER_TOOLBAR_SHIFT = 98

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
}

const clickUndo = async (page: Page): Promise<void> => {
  const box = await page.locator('#egui-canvas').boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.click(box.x + 26 + CIRCUIT_PICKER_TOOLBAR_SHIFT, box.y + 18)
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
  await page.keyboard.press('Control+C')
  await page.keyboard.press('Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["H"],["X"]]}')).toBe(
    '{"cols":[["H"],["H"],["X"]]}',
  )
})

test('repeated Ctrl+V keeps the original paste anchor', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await page.keyboard.press('Control+C')
  await page.keyboard.press('Control+V')
  await waitForCircuitJson(page, '{"cols":[["H"],["H"],["X"]]}')
  await page.keyboard.press('Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["H"],["H"],["X"]]}')).toBe(
    '{"cols":[["H"],["H"],["H"],["X"]]}',
  )
})

test('a connected operation is left for the follow-up PR', async ({ page }) => {
  const circuit = '{"cols":[["H"],["•",1,"X"]]}'
  await openCircuit(page, circuit)
  await clickGate(page, 0, 0)
  await page.keyboard.press('Control+C')
  await clickGate(page, 1, 2)
  await page.keyboard.press('Control+V')

  expect(circuitJsonFromUrl(page.url())).toBe(circuit)
})

test('one paste creates one undoable history entry', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await page.keyboard.press('Control+C')
  await page.keyboard.press('Control+V')
  await waitForCircuitJson(page, '{"cols":[["H"],["H"],["X"]]}')
  await clickUndo(page)

  expect(await waitForCircuitJson(page, '{"cols":[["H"],["X"]]}')).toBe(
    '{"cols":[["H"],["X"]]}',
  )
})

test('Ctrl+X copies and removes the selected gate', async ({ page }) => {
  await openCircuit(page, '{"cols":[["H"],["X"]]}')
  await clickGate(page, 0, 0)
  await page.keyboard.press('Control+X')
  await clickGate(page, 0, 0)
  await page.keyboard.press('Control+V')

  expect(await waitForCircuitJson(page, '{"cols":[["X"],["H"]]}')).toBe(
    '{"cols":[["X"],["H"]]}',
  )
})
