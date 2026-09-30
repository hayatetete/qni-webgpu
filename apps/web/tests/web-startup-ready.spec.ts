import { expect, test } from '@playwright/test'
import { waitForStartupReady } from './support/web-spec-helpers'

// 起動完了フラグは「最初のフレームを描画し、入力を受け付けられる状態」を意味する。
// フラグが立った直後に widget をクリックするテストが多いため、描画前にフラグが
// 立つと eframe がイベントリスナを張る前のクリックになり、入力が捨てられて
// テストが不定期に失敗する。ツールバーの geometry はフレーム描画時に publish
// されるので、クリック対象の widget が存在するかどうかの指標になる。
test('startup ready flag waits for the first painted frame', async ({ page }) => {
  await page.goto('/')
  await waitForStartupReady(page)

  const toolbarPainted = await page.evaluate(() => {
    const globalScope: unknown = window
    if (typeof globalScope !== 'object' || globalScope === null) return false
    if (!('__qniToolbarDuplicateGeometryJson' in globalScope)) return false
    return typeof globalScope.__qniToolbarDuplicateGeometryJson === 'string'
  })

  expect(toolbarPainted).toBe(true)
})
