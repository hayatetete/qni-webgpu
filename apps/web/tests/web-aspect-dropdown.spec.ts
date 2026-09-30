import { expect, test, type Page } from '@playwright/test'
import {
  pixelRgbDistance,
  sampleCanvasPixels,
  waitForStartupReady,
  waitForValue,
  type CanvasPixel,
} from './support/web-spec-helpers'

type RectJson = { left: number; right: number; top: number; bottom: number }
type AspectGeometry = {
  panel_left: number
  panel_right: number
  panel_top: number
  trigger_top: number
  trigger_bottom: number
  popover_left: number
  popover_right: number
  popover_top: number
  popover_bottom: number
  padding: number
  item_height: number
  current_aspect: number
  rows: RectJson[]
}

const FLEXOKI_BG: CanvasPixel = [255, 252, 240, 255]
const FLEXOKI_BG_2: CanvasPixel = [242, 240, 229, 255]
const FLEXOKI_UI_2: CanvasPixel = [218, 216, 206, 255]
const ASPECT_TRIGGER = { x: 705, y: 552 }

const readAspectGeometry = async (page: Page): Promise<AspectGeometry | null> =>
  page.evaluate(() => {
    const raw = (window as any).__qniAspectPopoverGeometryJson
    return typeof raw === 'string' ? JSON.parse(raw) as AspectGeometry : null
  })

const canvasBox = async (page: Page) => {
  const box = await page.locator('#egui-canvas').boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  return box!
}
const openAspectDropdown = async (page: Page): Promise<AspectGeometry> => {
  const box = await canvasBox(page)
  // Default state panel is bottom-centred in the 1000×800 Playwright viewport;
  // this point lands on the right-aligned "2 × 1 = 2 states ▾" trigger text.
  await page.mouse.click(box.x + ASPECT_TRIGGER.x, box.y + ASPECT_TRIGGER.y)
  const geometry = await waitForValue(
    () => readAspectGeometry(page),
    (value) => value !== null,
    'aspect dropdown geometry was not published',
  )
  if (!geometry) throw new Error('aspect dropdown geometry missing')
  return geometry
}

const centerY = (rect: RectJson): number => (rect.top + rect.bottom) / 2

test('state panel aspect dropdown stays inside the viewport for 8-qubit circuits', async ({ page }) => {
  const col0: Array<string | number> = Array(8).fill(1)
  col0[7] = 'H'
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [col0] })))
  await waitForStartupReady(page, { waitForStateVector: true })

  const geometry = await openAspectDropdown(page)
  const box = await canvasBox(page)

  expect(geometry.popover_top >= 0 && geometry.popover_bottom <= box.height).toBe(true)
})

test('state panel aspect dropdown matches picker chrome and row semantics', async ({ page }) => {
  await page.goto('/')
  await waitForStartupReady(page, { waitForStateVector: true })

  const geometry = await openAspectDropdown(page)
  const activeRow = geometry.rows[geometry.current_aspect]
  if (!activeRow) throw new Error('active aspect row missing')
  const canvas = page.locator('#egui-canvas')
  const resting = await sampleCanvasPixels(page, canvas, [
    { name: 'panel-fill', x: geometry.popover_left + 24, y: geometry.popover_top + 3 },
    { name: 'panel-border', x: geometry.popover_left + 36, y: geometry.popover_top },
    { name: 'active-bg', x: activeRow.right - 96, y: centerY(activeRow) },
    { name: 'active-thumbnail', x: activeRow.left + 35, y: centerY(activeRow) },
  ])
  const hoverIndex = geometry.rows.findIndex((_, index) => index !== geometry.current_aspect)
  const hoverRow = geometry.rows[hoverIndex]
  if (!hoverRow) throw new Error('hover aspect row missing')
  const box = await canvasBox(page)
  await page.mouse.move(box.x + hoverRow.right - 20, box.y + centerY(hoverRow))
  await page.waitForTimeout(120)
  const hovered = await sampleCanvasPixels(page, canvas, [
    { name: 'hover-bg', x: hoverRow.right - 20, y: centerY(hoverRow) },
  ])
  await page.mouse.click(box.x + hoverRow.right - 20, box.y + centerY(hoverRow))
  await page.waitForTimeout(120)
  await page.mouse.click(box.x + ASPECT_TRIGGER.x, box.y + ASPECT_TRIGGER.y)
  let selectedAspect: number | undefined
  for (let attempt = 0; attempt < 50; attempt += 1) {
    selectedAspect = (await readAspectGeometry(page))?.current_aspect
    if (selectedAspect === hoverIndex) break
    await page.waitForTimeout(50)
  }

  expect({
    rightAligned: Math.abs(geometry.popover_right - geometry.panel_right) <= 0.5,
    belowTrigger: geometry.popover_top > geometry.trigger_bottom,
    belowPanelTop: geometry.popover_top > geometry.panel_top,
    padding: geometry.padding,
    itemHeight: geometry.item_height,
    activeHeightAligned: Math.abs((activeRow.bottom - activeRow.top) - 36) <= 0.5,
    panelFill: pixelRgbDistance(resting['panel-fill'], FLEXOKI_BG) < 25,
    panelBorder: pixelRgbDistance(resting['panel-border'], FLEXOKI_UI_2) < 40,
    activeBg: pixelRgbDistance(resting['active-bg'], FLEXOKI_BG) < 25,
    activeThumbnailVisible: pixelRgbDistance(resting['active-thumbnail'], FLEXOKI_BG) > 80,
    hoverBg: pixelRgbDistance(hovered['hover-bg'], FLEXOKI_BG_2) < 25,
    selectedAspect,
  }).toEqual({
    rightAligned: true,
    belowTrigger: true,
    belowPanelTop: true,
    padding: 6,
    itemHeight: 36,
    activeHeightAligned: true,
    panelFill: true,
    panelBorder: true,
    activeBg: true,
    activeThumbnailVisible: true,
    hoverBg: true,
    selectedAspect: hoverIndex,
  })
})
