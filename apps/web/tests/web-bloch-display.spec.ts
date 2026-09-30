import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  UI_CONSTANTS,
  waitForBlochVectorsApprox,
  waitForStartupReady,
  pollForValue,
  waitForValue,
} from './support/web-spec-helpers'

const EGUI_PANEL_MARGIN = 8
const GATE_SIZE = UI_CONSTANTS.GATE_SIZE
const LINE_LEFT_OFFSET = UI_CONSTANTS.LINE_LEFT_OFFSET
const LINE_Y = UI_CONSTANTS.LINE_Y
const SLOT_SPACING = UI_CONSTANTS.SLOT_SPACING

type BlochPopoverEvidence = {
  popupText: boolean
  popupDivider: boolean
  valueMasks: string[]
  hStateLeadingDigits: boolean
}

const EXPECTED_H_STATE_VALUE_MASKS = [
  '11111110',
  '11111100',
  '11111110',
  '11111110',
  '11111110',
  '11111110',
]

const waitForBlochPopoverEvidence = async (
  page: Page,
  canvas: Locator,
): Promise<BlochPopoverEvidence> => {
  const gateLeft = EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + SLOT_SPACING + GATE_SIZE / 2
  const gateTop = EGUI_PANEL_MARGIN + LINE_Y - GATE_SIZE / 2
  const popupLeft = gateLeft + GATE_SIZE + 12
  const popupTop = gateTop
  const dividerY = popupTop + 12 + 20 + 12
  const valueAnchorX = popupLeft + 16 + 12 + 8
  const valueAnchorY = dividerY + 1 + 12 + 2
  const valueColPitch = 104
  const valueRowPitch = 20
  const valueCharWidth = 9
  const valueCharHeight = 16
  return await pollForValue(
    async () => {
      const screenshot = await canvas.screenshot({ type: 'png' })
      const box = await canvas.boundingBox()
      if (!box) throw new Error('expected egui canvas to be measurable')
      return await page.evaluate(
        async ({
          base64,
          cssWidth,
          cssHeight,
          popupLeft,
          popupTop,
          dividerY,
          valueAnchorX,
          valueAnchorY,
          valueColPitch,
          valueRowPitch,
          valueCharWidth,
          valueCharHeight,
        }) => {
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
              popupText: false,
              popupDivider: false,
              valueMasks: [] as string[],
              hStateLeadingDigits: false,
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
          let dividerRowMax = 0
          for (let y = Math.floor((dividerY - 1) * scaleY); y <= Math.floor((dividerY + 1) * scaleY); y += 1) {
            let row = 0
            for (let x = Math.floor((popupLeft + 16) * scaleX); x <= Math.floor((popupLeft + 300) * scaleX); x += 1) {
              const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
              if (Math.abs(r - 206) + Math.abs(g - 205) + Math.abs(b - 195) < 42) row += 1
            }
            dividerRowMax = Math.max(dividerRowMax, row)
          }
          const dark = ([r, g, b]: [number, number, number]) => r < 90 && g < 90 && b < 90
          const valueInkCounts = Array.from({ length: 6 }, (_, cell) => {
            const row = Math.floor(cell / 3)
            const col = cell % 3
            const originX = valueAnchorX + col * valueColPitch
            const originY = valueAnchorY + row * valueRowPitch
            return Array.from({ length: 8 }, (_, charIndex) => countMatching(
              originX + charIndex * valueCharWidth,
              originX + (charIndex + 1) * valueCharWidth,
              originY,
              originY + valueCharHeight,
              dark,
            ))
          })
          const valueMasks = valueInkCounts.map((counts) => counts.map((count) => count > 0 ? '1' : '0').join(''))
          const hStateLeadingDigits =
            valueInkCounts[0][1] + 2 < valueInkCounts[1][1] &&
            valueInkCounts[3][1] + 2 < valueInkCounts[4][1] &&
            valueInkCounts[3][1] + 2 < valueInkCounts[5][1]
          return {
            popupText: countMatching(popupLeft + 16, popupLeft + 300, popupTop + 12, popupTop + 34, dark) > 40,
            popupDivider: dividerRowMax > 96,
            valueMasks,
            hStateLeadingDigits,
          }
        },
        {
          base64: screenshot.toString('base64'),
          cssWidth: box.width,
          cssHeight: box.height,
          popupLeft,
          popupTop,
          dividerY,
          valueAnchorX,
          valueAnchorY,
          valueColPitch,
          valueRowPitch,
          valueCharWidth,
          valueCharHeight,
        },
      )
    },
    (last) => last.popupText && last.popupDivider && JSON.stringify(last.valueMasks) === JSON.stringify(EXPECTED_H_STATE_VALUE_MASKS) && last.hStateLeadingDigits
  )
}

test('Bloch display uses same-column control as a conditional readout', async ({ page }) => {
  await page.goto(
    '/#' +
      encodeURIComponent(
        JSON.stringify({ cols: [['H', 1], ['•', 'X'], ['•', 'Bloch']] }),
      ),
  )

  await waitForStartupReady(page, { waitForStateVector: true })

  await waitForBlochVectorsApprox(page, [[0, 0, -1]])
})

test('Bloch display uses same-column anti-control as a conditional readout', async ({ page }) => {
  await page.goto(
    '/#' +
      encodeURIComponent(
        JSON.stringify({ cols: [['H', 1], ['•', 'X'], ['◦', 'Bloch']] }),
      ),
  )

  await waitForStartupReady(page, { waitForStateVector: true })

  await waitForBlochVectorsApprox(page, [[0, 0, 1]])
})

test('Bloch hover opens a GPU-valued popover', async ({ page }) => {
  await page.goto('/#' + encodeURIComponent(JSON.stringify({ cols: [['H'], ['Bloch']] })))
  await waitForStartupReady(page, { waitForStateVector: true })
  await waitForBlochVectorsApprox(page, [[1, 0, 0]])

  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('expected egui canvas to be measurable')
  await page.mouse.move(
    box.x + EGUI_PANEL_MARGIN + LINE_LEFT_OFFSET + SLOT_SPACING + GATE_SIZE,
    box.y + EGUI_PANEL_MARGIN + LINE_Y,
  )
  const evidence = await waitForBlochPopoverEvidence(page, canvas)

  expect(evidence).toEqual({
    popupText: true,
    popupDivider: true,
    valueMasks: EXPECTED_H_STATE_VALUE_MASKS,
    hStateLeadingDigits: true,
  })
})
