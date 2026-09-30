import assert = require('node:assert/strict')
import { Given, Then, When } from '@cucumber/cucumber'
import type { Page } from 'playwright'
import type { BrowserSupport, EguiHelpers, EguiWorld } from '../support/support-types'

const { STANDARD_BROWSER_MODE, openPageForMode } = require('../support/browser.ts') as BrowserSupport
const {
  openEguiApp,
  waitForStartupReady,
  readEguiError,
  readStateVector,
  waitForCanvasContent,
  waitForStateVectorReady,
} = require('../support/egui-helpers.ts') as EguiHelpers

// 起動が固まると `bootstrap.ts` の監視が 15 秒後に一度だけ自動で読み込み直す。
// その分の余裕を含めた待ち時間にする。
const CUCUMBER_STEP_TIMEOUT_MS = 30_000

const requirePage = (world: EguiWorld): Page => {
  if (!world.page) {
    throw new Error('expected web page to be open')
  }
  return world.page
}

Given(
  'the web app is open in the standard WebGPU browser',
  { timeout: CUCUMBER_STEP_TIMEOUT_MS },
  async function (this: EguiWorld) {
    const page = await openPageForMode(this, STANDARD_BROWSER_MODE)
    await openEguiApp(page, this.baseUrl)
  }
)

When('the app finishes initializing', { timeout: CUCUMBER_STEP_TIMEOUT_MS }, async function (this: EguiWorld) {
  await waitForStartupReady(requirePage(this), { waitForStateVector: true })
})

Then('the WebGPU error is absent', async function (this: EguiWorld) {
  assert.equal(await readEguiError(requirePage(this)), null)
})

Then('the canvas is visible', async function (this: EguiWorld) {
  await requirePage(this).locator('#egui-canvas').waitFor({ state: 'visible' })
})

Then('the canvas renders non-background content', async function (this: EguiWorld) {
  const page = requirePage(this)
  const canvas = page.locator('#egui-canvas')
  await canvas.waitFor({ state: 'visible' })
  await waitForCanvasContent(page, canvas)
})

Then('the initial state vector is {string}', async function (this: EguiWorld, expectedJson: string) {
  const page = requirePage(this)
  await waitForStateVectorReady(page)
  assert.deepEqual(await readStateVector(page), JSON.parse(expectedJson) as unknown)
})
