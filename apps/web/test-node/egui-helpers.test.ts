const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const {
  dragPointer,
  evaluateWithRetry,
  getDragPreviewAboveStatePanelProbe,
  releasePointer,
  sampleCanvasPixels,
  waitForAppReady,
  waitForCanvasContent,
  waitForStartupReady,
  waitForStateVectorReady,
} = require('../features/support/egui-helpers.ts')

type MockEvaluateCall = {
  source: string
  arg: any
}

type MockPageCalls = {
  evaluate: MockEvaluateCall[]
  waitForLoadState: string[]
  waitForFunction: Array<{ source: string; arg: any; options: any }>
}

type MockPageOptions = {
  evaluateImpl?: (fn: Function, arg: any, index: number) => any | Promise<any>
}

type BoundingBox = {
  x?: number
  y?: number
  width: number
  height: number
}

type MockLocatorOptions = {
  screenshotImpl?: (options: any, index: number) => Buffer | Promise<Buffer>
  boundingBoxImpl?: (index: number) => BoundingBox | Promise<BoundingBox>
}

type MockCanvasPageOptions = {
  box?: { x: number; y: number; width: number; height: number }
}

const makePage = ({ evaluateImpl = async () => null }: MockPageOptions = {}) => {
  const calls = {
    evaluate: [],
    waitForLoadState: [],
    waitForFunction: [],
  } as MockPageCalls
  const events = new EventEmitter()

  return {
    calls,
    on: events.on.bind(events),
    off: events.off.bind(events),
    emit: events.emit.bind(events),
    async evaluate(fn: Function, arg?: any) {
      calls.evaluate.push({ source: fn.toString(), arg })
      return evaluateImpl(fn, arg, calls.evaluate.length - 1)
    },
    async waitForLoadState(state: string) {
      calls.waitForLoadState.push(state)
    },
    async waitForFunction(fn: Function, arg?: any, options?: any) {
      calls.waitForFunction.push({ source: fn.toString(), arg, options })
    },
  }
}

const makeLocator = ({ screenshotImpl, boundingBoxImpl }: MockLocatorOptions = {}) => {
  const calls = {
    screenshot: [],
    boundingBox: 0,
  } as { screenshot: any[]; boundingBox: number }

  return {
    calls,
    async screenshot(options?: any) {
      calls.screenshot.push(options)
      return screenshotImpl ? screenshotImpl(options, calls.screenshot.length - 1) : Buffer.from('png')
    },
    async boundingBox() {
      calls.boundingBox += 1
      return boundingBoxImpl ? boundingBoxImpl(calls.boundingBox - 1) : { x: 10, y: 20, width: 1000, height: 800 }
    },
  }
}

const makeCanvasPage = ({ box = { x: 10, y: 20, width: 1000, height: 800 } }: MockCanvasPageOptions = {}) => {
  const calls = {
    locator: [],
    move: [],
    down: 0,
    up: 0,
    waitForTimeout: [],
  } as {
    locator: string[]
    move: Array<{ x: number; y: number; options: any }>
    down: number
    up: number
    waitForTimeout: number[]
  }

  return {
    calls,
    locator(selector: string) {
      calls.locator.push(selector)
      return {
        async boundingBox() {
          return box
        },
      }
    },
    mouse: {
      async move(x: number, y: number, options?: any) {
        calls.move.push({ x, y, options })
      },
      async down() {
        calls.down += 1
      },
      async up() {
        calls.up += 1
      },
    },
    async waitForTimeout(ms: number) {
      calls.waitForTimeout.push(ms)
    },
  }
}

test('waitForAppReady rejects on a pageerror before readiness', async () => {
  const page = makePage()
  page.waitForFunction = async () => new Promise<void>(() => {})
  const waiting = waitForAppReady(page, 1_000)
  page.emit('pageerror', new Error('Load failed'))
  await assert.rejects(waiting, /Load failed/)
})

test('evaluateWithRetry retries execution-context-destroyed failures after waiting for app readiness', async () => {
  const page = makePage({
    evaluateImpl: async (_fn, _arg, index) => {
      if (index === 0) {
        throw new Error('Execution context was destroyed, most likely because of a navigation')
      }
      return 'ok'
    },
  })

  const result = await evaluateWithRetry(page, () => 'ok')

  assert.deepEqual({
    result,
    evaluateCount: page.calls.evaluate.length,
    waitForLoadState: page.calls.waitForLoadState,
    waitForFunctionCount: page.calls.waitForFunction.length,
  }, { result: 'ok', evaluateCount: 2, waitForLoadState: ['load'], waitForFunctionCount: 1 })
})

test('evaluateWithRetry does not retry unexpected errors', async () => {
  const page = makePage({
    evaluateImpl: async () => {
      throw new Error('Unexpected evaluate failure')
    },
  })

  let message = ''
  try {
    await evaluateWithRetry(page, () => 'nope')
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.deepEqual({
    message,
    evaluateCount: page.calls.evaluate.length,
    waitForLoadState: page.calls.waitForLoadState,
    waitForFunctionCount: page.calls.waitForFunction.length,
  }, { message: 'Unexpected evaluate failure', evaluateCount: 1, waitForLoadState: [], waitForFunctionCount: 0 })
})

test('waitForStartupReady waits for app readiness and optional state vector readiness', async () => {
  const page = makePage({
    evaluateImpl: async (fn) => {
      const source = fn.toString()
      if (source.includes('__eguiError')) {
        return null
      }
      if (source.includes('__eguiReadStateVector')) {
        return [1, 0, 0, 0]
      }
      return null
    },
  })

  const stateVector = await waitForStartupReady(page, {
    timeout: 1_000,
    waitForStateVector: true,
  })

  assert.deepEqual({
    stateVector,
    waitForFunctionCount: page.calls.waitForFunction.length,
    waitForFunctionOptions: page.calls.waitForFunction[0].options,
    evaluateCount: page.calls.evaluate.length,
  }, {
    stateVector: [1, 0, 0, 0],
    waitForFunctionCount: 1,
    waitForFunctionOptions: { timeout: 1_000 },
    evaluateCount: 3,
  })
})

test('waitForStartupReady fails fast when egui reports an app error after startup', async () => {
  const page = makePage({
    evaluateImpl: async (fn) => {
      const source = fn.toString()
      if (source.includes('__eguiError')) {
        return 'WebGPU adapter unavailable'
      }
      if (source.includes('__eguiReadStateVector')) {
        return []
      }
      return null
    },
  })

  let message = ''
  try {
    await waitForStartupReady(page, { timeout: 1_000, waitForStateVector: true })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.deepEqual({
    message,
    waitForFunctionCount: page.calls.waitForFunction.length,
    evaluateCount: page.calls.evaluate.length,
  }, { message: 'egui app error while waiting for app startup: WebGPU adapter unavailable', waitForFunctionCount: 1, evaluateCount: 1 })
})

test('waitForStateVectorReady fails fast when egui reports an app error', async () => {
  const page = makePage({
    evaluateImpl: async (fn) => {
      const source = fn.toString()
      if (source.includes('__eguiError')) {
        return 'WebGPU adapter unavailable'
      }
      if (source.includes('__eguiReadStateVector')) {
        return []
      }
      return null
    },
  })

  let message = ''
  try {
    await waitForStateVectorReady(page, 1_000)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.deepEqual({ message, evaluateCount: page.calls.evaluate.length }, {
    message: 'egui app error while waiting for state vector: WebGPU adapter unavailable',
    evaluateCount: 1,
  })
})

test('waitForCanvasContent fails fast when egui reports an app error', async () => {
  const page = makePage({
    evaluateImpl: async (fn) => {
      const source = fn.toString()
      if (source.includes('__eguiError')) {
        return 'WebGPU adapter unavailable'
      }
      if (source.includes('nonBackground')) {
        return { nonBackground: 0, sampledPixels: 25 }
      }
      return null
    },
  })
  const locator = makeLocator()

  let message = ''
  try {
    await waitForCanvasContent(page, locator, { timeout: 1_000, minNonBackground: 40 })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.deepEqual({ message, screenshotCount: locator.calls.screenshot.length, evaluateCount: page.calls.evaluate.length }, {
    message: 'egui app error while waiting for canvas content: WebGPU adapter unavailable',
    screenshotCount: 0,
    evaluateCount: 1,
  })
})

test('waitForCanvasContent reports the last sampled non-background count on timeout', async () => {
  const page = makePage({
    evaluateImpl: async (fn) => {
      const source = fn.toString()
      if (source.includes('__eguiError')) {
        return null
      }
      if (source.includes('nonBackground')) {
        return { nonBackground: 7, sampledPixels: 25 }
      }
      return null
    },
  })
  const locator = makeLocator()

  let message = ''
  try {
    await waitForCanvasContent(page, locator, { timeout: 1, minNonBackground: 40 })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.deepEqual({
    timedOutWithCount: /Timed out waiting for egui canvas to render non-background content \(nonBackground=7, expected >= 40\)/.test(message),
    screenshotCount: locator.calls.screenshot.length,
    evaluateCount: page.calls.evaluate.length,
  }, { timedOutWithCount: true, screenshotCount: 1, evaluateCount: 2 })
})

test('dragPointer moves relative to the egui canvas and can keep the pointer pressed', async () => {
  const page = makeCanvasPage()

  await dragPointer(page, { x: 12, y: 34 }, { x: 56, y: 78 }, 8, false)

  assert.deepEqual(page.calls, {
    locator: ['#egui-canvas'],
    move: [
      { x: 22, y: 54, options: undefined },
      { x: 66, y: 98, options: { steps: 8 } },
    ],
    down: 1,
    up: 0,
    waitForTimeout: [16, 16],
  })
})

test('releasePointer releases relative to the egui canvas', async () => {
  const page = makeCanvasPage()

  await releasePointer(page, { x: 90, y: 45 })

  assert.deepEqual({ locator: page.calls.locator, move: page.calls.move, up: page.calls.up }, {
    locator: ['#egui-canvas'],
    move: [{ x: 100, y: 65, options: undefined }],
    up: 1,
  })
})

test('sampleCanvasPixels passes screenshot bytes and css size into page evaluation', async () => {
  const page = makePage({
    evaluateImpl: async (_fn, arg) => arg,
  })
  const locator = makeLocator({
    screenshotImpl: async () => Buffer.from('png'),
    boundingBoxImpl: async () => ({ width: 320, height: 180 }),
  })
  const samples = [{ name: 'probe', x: 12, y: 34 }]

  const result = await sampleCanvasPixels(page, locator, samples)

  assert.deepEqual({
    samples: result.samples,
    cssWidth: result.cssWidth,
    cssHeight: result.cssHeight,
    base64IsEncoded: /^[A-Za-z0-9+/=]+$/.test(result.base64),
    screenshot: locator.calls.screenshot,
    boundingBox: locator.calls.boundingBox,
  }, {
    samples,
    cssWidth: 320,
    cssHeight: 180,
    base64IsEncoded: true,
    screenshot: [{ type: 'png' }],
    boundingBox: 1,
  })
})

test('sampleCanvasPixels waits for state-vector readiness before retrying a destroyed screenshot context', async () => {
  const page = makePage({
    evaluateImpl: async (fn, arg) => {
      const source = fn.toString()
      if (source.includes('__eguiError')) {
        return null
      }
      if (source.includes('__eguiReadStateVector')) {
        return [1, 0, 0, 0]
      }
      return arg
    },
  })
  const locator = makeLocator({
    screenshotImpl: async (_options, index) => {
      if (index === 0) {
        throw new Error('Execution context was destroyed, most likely because of a navigation')
      }
      return Buffer.from('png')
    },
    boundingBoxImpl: async () => ({ width: 320, height: 180 }),
  })

  const result = await sampleCanvasPixels(page, locator, [{ name: 'probe', x: 12, y: 34 }])

  assert.deepEqual({
    cssWidth: result.cssWidth,
    waitForLoadState: page.calls.waitForLoadState,
    waitForFunctionCount: page.calls.waitForFunction.length,
    firstEvaluateReadsError: /__eguiError/.test(page.calls.evaluate[0].source),
    secondEvaluateReadsState: /__eguiReadStateVector/.test(page.calls.evaluate[1].source),
    screenshotCount: locator.calls.screenshot.length,
  }, {
    cssWidth: 320,
    waitForLoadState: ['load'],
    waitForFunctionCount: 1,
    firstEvaluateReadsError: true,
    secondEvaluateReadsState: true,
    screenshotCount: 2,
  })
})

test('getDragPreviewAboveStatePanelProbe preserves the current drag target contract', () => {
  const probe = getDragPreviewAboveStatePanelProbe(1000, 800)

  assert.deepEqual({
    source: probe.source,
    handleBelowSource: probe.handleCenter.y > probe.source.y,
    dragFillPoint: probe.dragFillPoint,
    sourceFillPoint: probe.sourceFillPoint,
  }, {
    source: { x: 159, y: 100 },
    handleBelowSource: true,
    dragFillPoint: { name: 'fill', x: probe.handleCenter.x + 14, y: probe.handleCenter.y + 14 },
    sourceFillPoint: { name: 'sourceFill', x: probe.source.x + 14, y: probe.source.y + 14 },
  })
})

export {}
