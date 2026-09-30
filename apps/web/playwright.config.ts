import { defineConfig } from '@playwright/test'
import { chromium } from 'playwright'
import { getStandardWebGpuLaunchOptions } from './test-support/browser-launch'
import {
  getPlaywrightBaseUrl,
  getPlaywrightWebServerConfig,
} from './test-support/web-server'

const webServer = getPlaywrightWebServerConfig({ env: process.env })
const standardBrowser = getStandardWebGpuLaunchOptions({
  env: process.env,
  defaultPath: chromium.executablePath(),
})
// Chrome を並列に多数起動すると、WebGPU のデバイス取得が応答しないまま止まる
// ページが混ざる (実測: 6 並列で 1〜2 回の実行に 1 件)。起動が固まった場合は
// `bootstrap.ts` の監視が一度だけ自動で読み込み直すが、発生自体を減らすため
// 並列数を抑える。GitHub Actions は 4 vCPU で描画も SwiftShader (CPU) のため、
// CPU を 4 個に制限した再現環境に合わせて CI ではさらに下げる。
const workers = process.env.CI ? 2 : 3

// 起動固まりは Chrome / Dawn 側の待ちで、こちらから解消できない。描画やドラッグの
// 待ちも CPU が飽和すると期限に間に合わないことがある。CI (4 vCPU、SwiftShader) は
// 発生率が高いので 2 回、手元では 1 回まで再試行する。上限まで落ちるものは本当の
// 退行として扱う (再試行で通ったものは flaky として報告される)。
const retries = process.env.CI ? 2 : 1

// CPU が飽和するとアニメーションの完了待ちが既定の 30 秒に収まらないことがある。
// 待ち側は「進んでいる間は待つ」形にしているので、テストの上限はその倍を確保する。
const timeout = 60_000

export default defineConfig({
  testDir: './tests',
  timeout,
  fullyParallel: true,
  workers,
  retries,
  use: {
    baseURL: getPlaywrightBaseUrl({ env: process.env }),
    viewport: { width: 1000, height: 800 },
    browserName: 'chromium',
    headless: standardBrowser.headless,
    launchOptions: {
      executablePath: standardBrowser.executablePath,
      args: standardBrowser.args,
    },
  },
  webServer,
})
