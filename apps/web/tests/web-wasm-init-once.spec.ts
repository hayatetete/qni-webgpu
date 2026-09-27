import { expect, test } from '@playwright/test'
import { waitForAppReady } from './support/web-spec-helpers'

test('wasm is instantiated only once on each page load', async ({ page }) => {
  await page.addInitScript(() => {
    const counts = { streaming: 0, bytes: 0 }
    Reflect.set(window, '__wasmInstantiationCounts', counts)
    const instantiateStreaming = WebAssembly.instantiateStreaming.bind(WebAssembly)
    const instantiate = WebAssembly.instantiate.bind(WebAssembly)
    WebAssembly.instantiateStreaming = ((...args: Parameters<typeof WebAssembly.instantiateStreaming>) => {
      counts.streaming += 1
      return instantiateStreaming(...args)
    }) as typeof WebAssembly.instantiateStreaming
    WebAssembly.instantiate = ((...args: Parameters<typeof WebAssembly.instantiate>) => {
      counts.bytes += 1
      return instantiate(...args)
    }) as typeof WebAssembly.instantiate
  })

  for (let load = 0; load < 2; load += 1) {
    if (load === 0) await page.goto('/')
    else await page.reload()
    await waitForAppReady(page)
    const snapshot = async () => page.evaluate(() => ({
      ready: window.__eguiReady === true,
      counts: Reflect.get(window, '__wasmInstantiationCounts'),
    }))
    const readyCounts = await snapshot()
    expect(readyCounts).toEqual({ ready: true, counts: { streaming: 1, bytes: 0 } })
    await page.waitForTimeout(500)
    expect(await snapshot()).toEqual(readyCounts)
  }
})
