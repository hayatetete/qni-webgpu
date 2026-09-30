const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const { chromium } = require('playwright')
const {
  getStandardWebGpuLaunchOptions,
} = require('../test-support/browser-launch.ts')
const {
  getWebServerConfig,
  getPlaywrightBaseUrl,
  PLAYWRIGHT_EXTERNAL_SERVER_ENV,
  PLAYWRIGHT_BASE_URL_ENV,
} = require('../test-support/web-server.ts')

const rootDir = path.join(__dirname, '..')
const repoRoot = path.join(rootDir, '..', '..')

const loadConfig = (env = process.env) => {
  const configPath = require.resolve('../playwright.config.ts')
  delete require.cache[configPath]

  const previousExternal = process.env[PLAYWRIGHT_EXTERNAL_SERVER_ENV]
  const previousBaseUrl = process.env[PLAYWRIGHT_BASE_URL_ENV]
  const previousCi = process.env.CI

  if (env[PLAYWRIGHT_EXTERNAL_SERVER_ENV] === undefined) {
    delete process.env[PLAYWRIGHT_EXTERNAL_SERVER_ENV]
  } else {
    process.env[PLAYWRIGHT_EXTERNAL_SERVER_ENV] = env[PLAYWRIGHT_EXTERNAL_SERVER_ENV]
  }

  if (env[PLAYWRIGHT_BASE_URL_ENV] === undefined) {
    delete process.env[PLAYWRIGHT_BASE_URL_ENV]
  } else {
    process.env[PLAYWRIGHT_BASE_URL_ENV] = env[PLAYWRIGHT_BASE_URL_ENV]
  }

  if (env.CI === undefined) {
    delete process.env.CI
  } else {
    process.env.CI = env.CI
  }

  try {
    const configModule = require('../playwright.config.ts')
    return configModule.default || configModule
  } finally {
    if (previousExternal === undefined) {
      delete process.env[PLAYWRIGHT_EXTERNAL_SERVER_ENV]
    } else {
      process.env[PLAYWRIGHT_EXTERNAL_SERVER_ENV] = previousExternal
    }

    if (previousBaseUrl === undefined) {
      delete process.env[PLAYWRIGHT_BASE_URL_ENV]
    } else {
      process.env[PLAYWRIGHT_BASE_URL_ENV] = previousBaseUrl
    }

    if (previousCi === undefined) {
      delete process.env.CI
    } else {
      process.env.CI = previousCi
    }

    delete require.cache[configPath]
  }
}

test('playwright config is TypeScript without a compatibility wrapper', async () => {
  const accessOk = (filePath: string): Promise<boolean> => fs.access(filePath).then(() => true, () => false)
  const docs = await fs.readFile(path.join(repoRoot, 'docs', 'web.md'), 'utf8')
  assert.deepEqual({
    hasTsConfig: await accessOk(path.join(rootDir, 'playwright.config.ts')),
    hasCjsConfig: await accessOk(path.join(rootDir, 'playwright.config.cjs')),
    docsUseTs: /playwright\.config\.ts/.test(docs),
    docsAvoidCjs: !/playwright\.config\.cjs/.test(docs),
  }, { hasTsConfig: true, hasCjsConfig: false, docsUseTs: true, docsAvoidCjs: true })
})

test('playwright config uses the shared browser and web server policies', () => {
  const config = loadConfig()
  const expectedBrowser = getStandardWebGpuLaunchOptions({
    env: process.env,
    defaultPath: chromium.executablePath(),
  })

  const expectedWebServer = getWebServerConfig()

  assert.deepEqual({
    fullyParallel: config.fullyParallel,
    baseURL: config.use.baseURL,
    headless: config.use.headless,
    launchOptions: config.use.launchOptions,
    webServer: config.webServer,
  }, {
    fullyParallel: true,
    baseURL: expectedWebServer.url,
    headless: expectedBrowser.headless,
    launchOptions: { executablePath: expectedBrowser.executablePath, args: expectedBrowser.args },
    webServer: expectedWebServer,
  })
})

test('playwright config uses a bounded multi-worker count on CI', () => {
  const env = {
    ...process.env,
    CI: '1',
  }
  const config = loadConfig(env)

  assert.equal(config.workers, 2)
})

test('playwright config allows one more worker outside CI', () => {
  const config = loadConfig({ ...process.env, CI: undefined })

  assert.equal(config.workers, 3)
})

// 固まりや描画待ちの取りこぼしは環境の性能で頻度が変わる。上限まで落ちるものは
// 本当の退行として扱いたいので、再試行の回数を環境ごとに固定する。
test('playwright config retries a failing test once outside CI', () => {
  const config = loadConfig({ ...process.env, CI: undefined })

  assert.equal(config.retries, 1)
})

test('playwright config retries a failing test twice on CI', () => {
  const config = loadConfig({ ...process.env, CI: '1' })

  assert.equal(config.retries, 2)
})

// アニメーション待ちは CPU 飽和時に既定の 30 秒を超えることがある。
test('playwright config raises the per-test timeout above the default', () => {
  const config = loadConfig({ ...process.env, CI: undefined })

  assert.equal(config.timeout, 60_000)
})

test('playwright config can reuse an externally managed web server', () => {
  const env = {
    ...process.env,
    [PLAYWRIGHT_EXTERNAL_SERVER_ENV]: '1',
    [PLAYWRIGHT_BASE_URL_ENV]: 'http://127.0.0.1:5999',
  }
  const config = loadConfig(env)

  assert.deepEqual({ baseURL: config.use.baseURL, webServer: config.webServer }, {
    baseURL: getPlaywrightBaseUrl({ env }),
    webServer: undefined,
  })
})

export {}
