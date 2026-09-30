import assert = require('node:assert/strict')
import { Given, Then, When } from '@cucumber/cucumber'
import type { Page } from 'playwright'
import type { BrowserSupport, EguiHelpers, EguiWorld, WindowWithEguiError } from '../support/support-types'

const { PLAIN_BROWSER_MODE, openPageForMode } = require('../support/browser.ts') as BrowserSupport
const { openEguiApp, waitForAppReady, readEguiError } = require('../support/egui-helpers.ts') as EguiHelpers

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
  'the web app is open in plain chromium',
  { timeout: CUCUMBER_STEP_TIMEOUT_MS },
  async function (this: EguiWorld) {
    const page = await openPageForMode(this, PLAIN_BROWSER_MODE)
    await openEguiApp(page, this.baseUrl)
  }
)

When('the plain chromium session finishes loading', { timeout: CUCUMBER_STEP_TIMEOUT_MS }, async function (this: EguiWorld) {
  await waitForAppReady(requirePage(this))
})

Then('a visible WebGPU error is shown', async function (this: EguiWorld) {
  const page = requirePage(this)

  await page.waitForFunction(() => Boolean((window as WindowWithEguiError).__eguiError), null, {
    timeout: CUCUMBER_STEP_TIMEOUT_MS,
  })

  const errorLocator = page.locator('[data-testid="webgpu-error"]')
  await errorLocator.waitFor({ state: 'visible' })
  const message = await readEguiError(page)
  const visibleText = await errorLocator.innerText()
  assert.match(`${message}\n${visibleText}`, /WebGPU/i)
})
