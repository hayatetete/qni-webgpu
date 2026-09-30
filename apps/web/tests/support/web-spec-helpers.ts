import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { dragPreviewAboveOverlayIssue } from '../../features/support/assertions'
import {
  dragPointer,
  getDragPreviewAboveStatePanelProbe,
  getPaletteGateCenter,
  readAmplitudeCell,
  readBlochVectors,
  readDensityMatrixCell,
  readProbabilityDistributions,
  readEguiError,
  readMeasurementOutcomes,
  readStateVector,
  releasePointer,
  sampleCanvasPixels,
  waitForAppReady,
  waitForCanvasContent,
  waitForStartupReady,
} from '../../features/support/egui-helpers'
import type { AmplitudeCell, BlochEntry, DensityMatrixCell, ProbabilityDistributions } from '../../features/support/egui-helpers'
import type { CanvasPixel, PixelSamplePoint, Point } from '../../features/support/support-types'
import { getPlainChromiumLaunchOptions } from '../../test-support/browser-launch'
import { UI_CONSTANTS } from '../../test-support/generated-ui-constants'
import { getWebServerConfig } from '../../test-support/web-server'

export {
  dragPreviewAboveOverlayIssue,
  chromium,
  dragPointer,
  getDragPreviewAboveStatePanelProbe,
  getPaletteGateCenter,
  getPlainChromiumLaunchOptions,
  getWebServerConfig,
  readAmplitudeCell,
  readBlochVectors,
  readDensityMatrixCell,
  readProbabilityDistributions,
  readEguiError,
  readMeasurementOutcomes,
  readStateVector,
  releasePointer,
  sampleCanvasPixels,
  waitForAppReady,
  waitForCanvasContent,
  waitForStartupReady,
  UI_CONSTANTS,
}
export type {
  AmplitudeCell,
  CanvasPixel,
  DensityMatrixCell,
  ProbabilityDistributions,
  PixelSamplePoint,
  Point,
}

export type CircularBodySignature = {
  count: number
  width: number
  height: number
  samples: Record<string, CanvasPixel>
}

// Flexoki purple-600 — drag preview / semantic-intermediate fill.
export const DRAG_PREVIEW_FILL: CanvasPixel = [94, 64, 157, 255]

export const pixelRgbDistance = (left: CanvasPixel, right: CanvasPixel): number =>
  [0, 1, 2].reduce((total, channel) => total + Math.abs(left[channel] - right[channel]), 0)

export const isDragPreviewFill = (pixel: CanvasPixel): boolean =>
  pixelRgbDistance(pixel, DRAG_PREVIEW_FILL) <= 80

export const isRegularGateFill = ([r, g, b]: CanvasPixel): boolean =>
  r >= 35 && r <= 130 && g >= 120 && g <= 210 && b >= 100 && b <= 190

export const isGateBodyFill = (pixel: CanvasPixel): boolean =>
  isRegularGateFill(pixel) || isDragPreviewFill(pixel)

const waitUntil = async (
  predicate: () => Promise<boolean>,
  timeout: number,
  failureMessage: string,
): Promise<void> => {
  const deadline = Date.now() + timeout
  while (Date.now() <= deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(failureMessage)
}

// 描画やアニメーションの完了待ちに使う。回数を数える待ち方 (50 回 x 50 ms など) は
// CPU が飽和すると「進んでいるのに時間切れ」になるため、時間で区切る。
// 既定は 15 秒。Playwright のテスト上限 (60 秒) より十分短くしてある。
export const waitForValue = async <Value>(
  read: () => Promise<Value>,
  done: (value: Value) => boolean,
  failureMessage: string,
  { timeout = 15_000 }: { timeout?: number } = {},
): Promise<Value> => {
  const deadline = Date.now() + timeout
  let last = await read()
  while (Date.now() <= deadline) {
    if (done(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 50))
    last = await read()
  }
  if (done(last)) return last
  throw new Error(`${failureMessage} (timeout ${timeout} ms)`)
}

// 「出ないこと」を確かめるテストもあるため、時間切れでも最後に観測した値を返す版。
// 例: 確率表示のパーセント表記が出ない spec は、待ってから画素数の少なさを見る。
export const pollForValue = async <Value>(
  read: () => Promise<Value>,
  done: (value: Value) => boolean,
  { timeout = 15_000 }: { timeout?: number } = {},
): Promise<Value> => {
  const deadline = Date.now() + timeout
  let last = await read()
  while (Date.now() <= deadline) {
    if (done(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 50))
    last = await read()
  }
  return last
}

export const waitForStateVectorLength = async (
  page: Page,
  length: number,
  timeout = 5000
): Promise<void> => {
  await waitUntil(
    async () => (await readStateVector(page)).length === length,
    timeout,
    `state vector length did not become ${length}`,
  )
}

export const waitForStateVectorApprox = async (
  page: Page,
  expected: number[],
  timeout = 5000,
  tolerance = 1e-3
): Promise<void> => {
  await waitUntil(
    async () => {
      const actual = await readStateVector(page) as number[]
      if (actual.length !== expected.length) {
        return false
      }
      return expected.every((value, index) => Math.abs(actual[index] - value) < tolerance)
    },
    timeout,
    `state vector did not match expected amplitudes (${expected.join(',')})`,
  )
}

export const waitForBlochVectorsApprox = async (
  page: Page,
  expected: Array<[number, number, number]>,
  timeout = 5000,
  tolerance = 1e-3
): Promise<void> => {
  await waitUntil(
    async () => {
      const entries = await readBlochVectors(page)
      if (entries.length !== expected.length) {
        return false
      }
      const sortedEntries = [...entries].sort((a: BlochEntry, b: BlochEntry) => a.gateId - b.gateId)
      return expected.every(([x, y, z], index) => {
        const e = sortedEntries[index]
        return (
          Math.abs(e.x - x) < tolerance &&
          Math.abs(e.y - y) < tolerance &&
          Math.abs(e.z - z) < tolerance
        )
      })
    },
    timeout,
    'Bloch vectors did not match expected values',
  )
}
