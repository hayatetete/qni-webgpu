import { expect, test, type Page } from '@playwright/test'
import { waitForStartupReady } from './support/web-spec-helpers'

type ShortcutGeometry = {
  left: number
  right: number
  top: number
  bottom: number
  hovered: boolean
  open: boolean
  popoverRight: number | null
  columnLefts: [number, number, number, number] | null
}

const geometry = async (page: Page): Promise<ShortcutGeometry> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const raw = await page.evaluate(() => (window as any).__qniToolbarShortcutGeometryJson)
    if (typeof raw === 'string') return JSON.parse(raw) as ShortcutGeometry
    await page.waitForTimeout(50)
  }
  throw new Error('toolbar shortcut geometry was not published')
}

const triggerCenter = async (page: Page) => {
  const rect = await geometry(page)
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await waitForStartupReady(page)
})

test('keyboard shortcut trigger opens and Escape closes its popover', async ({ page }) => {
  const point = await triggerCenter(page)
  await page.locator('#egui-canvas').click({ position: point })
  await page.waitForTimeout(100)
  const opened = (await geometry(page)).open
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)

  expect([opened, (await geometry(page)).open]).toEqual([true, false])
})

test('keyboard shortcut trigger exposes its English tooltip', async ({ page }) => {
  const point = await triggerCenter(page)
  await page.locator('#egui-canvas').hover({ position: point })
  await page.waitForTimeout(200)

  expect(await page.evaluate(() => (window as any).__qniToolbarTooltipText)).toBe(
    'Keyboard shortcuts',
  )
})

test('keyboard shortcut popover aligns with the trigger right edge', async ({ page }) => {
  const point = await triggerCenter(page)
  await page.locator('#egui-canvas').click({ position: point })
  await page.waitForTimeout(100)
  const rect = await geometry(page)

  expect(Math.abs((rect.popoverRight ?? 0) - rect.right)).toBeLessThan(0.25)
})

test('keyboard shortcut values align with their column headings', async ({ page }) => {
  const point = await triggerCenter(page)
  await page.locator('#egui-canvas').click({ position: point })
  await page.waitForTimeout(100)
  const lefts = (await geometry(page)).columnLefts
  if (!lefts) throw new Error('expected shortcut column geometry')
  const [windows, control, macos, command] = lefts

  expect([Math.abs(windows - control), Math.abs(macos - command)]).toEqual([0, 0])
})
