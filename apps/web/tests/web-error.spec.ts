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
  readEguiError,
  readMeasurementOutcomes,
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
} from './support/web-spec-helpers'

const denyAdapter = async (page: Page, platform: string): Promise<void> => {
  await page.addInitScript((os) => {
    Object.defineProperty(Navigator.prototype, 'gpu', { get: () => ({ requestAdapter: async () => null }) })
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => ({ platform: os, brands: [{ brand: 'Chromium', version: '1' }] }),
    })
  }, platform)
}

test('default chromium shows a visible WebGPU error instead of a blank page', async () => {
  const plainChromium = getPlainChromiumLaunchOptions({
    env: process.env,
    defaultPath: chromium.executablePath(),
  })
  const { url } = getWebServerConfig()

  const browser = await chromium.launch(plainChromium)

  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
    await page.goto(new URL('/', url).toString(), { waitUntil: 'load' })
    await waitForAppReady(page)

    let error: string | null = null
    for (let attempt = 0; attempt < 200; attempt += 1) {
      error = await readEguiError(page)
      if (error) break
      await page.waitForTimeout(100)
    }
    const errorLocator = page.locator('[data-testid="webgpu-error"]')
    await errorLocator.waitFor({ state: 'visible' })
    expect({ errorPresent: error !== null, heading: await errorLocator.locator('h1').innerText(), copyOrReload: await errorLocator.getByRole('button', { name: /copy this url|reload/i }).count() }).toEqual({
      errorPresent: true,
      heading: 'No GPU access.',
      copyOrReload: 0,
    })
  } finally {
    await browser.close()
  }
})

test('bootstrap script loading failure shows a recovery hint', async ({ page }) => {
  await page.route('**/bootstrap.js', (route) => route.abort())
  await page.goto('/')
  await expect(page.locator('#asset-error')).toContainText('Qni could not load. Try a hard reload')
})

test('asset loading failure does not blame GPU access', async ({ page }) => {
  await page.route('**/qni-web.js', (route) => route.abort())
  await page.goto('/')
  await page.getByTestId('webgpu-error').waitFor({ state: 'visible', timeout: 10_000 })
  expect({
    message: await page.locator('#asset-error').innerText(),
    gpuScreenVisible: await page.getByTestId('webgpu-error').locator('h1').isVisible(),
  }).toEqual({
    message: expect.stringContaining('Asset load failed. Try a hard reload'),
    gpuScreenVisible: false,
  })
})

test('wasm loading failure shows the asset error instead of blaming GPU access', async ({ page }) => {
  await page.route('**/*_bg.wasm', (route) => route.abort())
  await page.goto('/')
  await page.getByTestId('webgpu-error').waitFor({ state: 'visible', timeout: 10_000 })
  expect({
    message: await page.locator('#asset-error').innerText(),
    gpuScreenVisible: await page.getByTestId('webgpu-error').locator('h1').isVisible(),
  }).toEqual({
    message: expect.stringContaining('Asset load failed. Try a hard reload'),
    gpuScreenVisible: false,
  })
})

test('GPU error text uses bundled fonts rather than operating-system fallbacks', async ({ page }) => {
  await denyAdapter(page, 'Linux')
  await page.goto('/')
  await page.getByTestId('webgpu-error').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Linux Chromium? Try these steps' }).click()
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready
    return {
      heading: getComputedStyle(document.querySelector('#app-status h1')!).fontFamily,
      dialog: getComputedStyle(document.querySelector('#linux-steps')!).fontFamily,
      command: getComputedStyle(document.querySelector('#cmd')!).fontFamily,
      loadedFaces: Array.from(document.fonts)
        .filter((face) => face.family.startsWith('Qni Geist'))
        .map((face) => `${face.family}:${face.weight}:${face.status}`),
    }
  })
  expect(fonts).toEqual({
    heading: '"Qni Geist", sans-serif',
    dialog: '"Qni Geist", sans-serif',
    command: '"Qni Geist Mono", monospace',
    loadedFaces: ['Qni Geist:400:loaded', 'Qni Geist:700 900:loaded', 'Qni Geist Mono:400:loaded'],
  })
})

test('GPU failure shows the crayon screen without Linux instructions on Windows', async ({ page }) => {
  await denyAdapter(page, 'Windows')
  await page.goto('/')
  await page.getByTestId('webgpu-error').waitFor({ state: 'visible' })
  await expect(page.getByTestId('webgpu-error')).toHaveScreenshot('gpu-error-windows.png', {
    animations: 'disabled',
  })
})

test('GPU failure offers local Linux Chromium troubleshooting', async ({ page }) => {
  await denyAdapter(page, 'Linux')
  await page.goto('/')
  await page.getByTestId('webgpu-error').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Linux Chromium? Try these steps' }).click()
  await expect(page.getByRole('dialog', { name: 'Try these steps on Linux Chromium' })).toBeVisible()
})

test('Linux troubleshooting dialog keeps its sections aligned on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await denyAdapter(page, 'Linux')
  await page.goto('/')
  await page.getByTestId('webgpu-error').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Linux Chromium? Try these steps' }).click()
  await expect(page.getByRole('dialog', { name: 'Try these steps on Linux Chromium' })).toHaveScreenshot('gpu-error-linux-dialog-mobile.png', {
    animations: 'disabled',
  })
})

test('Linux troubleshooting dialog allows keyboard navigation to copy command', async ({ page }) => {
  await denyAdapter(page, 'Linux')
  await page.goto('/')
  await page.getByTestId('webgpu-error').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Linux Chromium? Try these steps' }).click()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Copy command' })).toBeFocused()
})

test('GPU failure includes the actual error in details', async ({ page }) => {
  await denyAdapter(page, 'Windows')
  await page.goto('/')
  await page.getByTestId('webgpu-error').waitFor({ state: 'visible' })
  await page.getByText('Error details').click()
  await expect(page.locator('#app-status .raw')).toContainText('No suitable graphics adapter found')
})
