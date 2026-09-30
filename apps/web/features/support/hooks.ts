import type { Page } from 'playwright'

type HookOptions = {
  timeout: number
}

type ScenarioHookArgument = {
  pickle?: {
    name?: string
  }
  result?: {
    status?: string
  }
}

type HookWorld = {
  page: Page | null
  browserMode: string
  consoleErrors: string[]
  pageErrors: string[]
  server: SharedWebServer | null
  baseUrl: string
  attach: (data: Buffer | string, mediaType?: string) => Promise<void> | void
  startScenario: (name?: string | null) => void
  resetRuntimeState: () => void
}

type SharedWebServerConfig = {
  url: string
  timeout: number
}

type SharedWebServer = SharedWebServerConfig & {
  managed: boolean
}

type BeforeAllHook = (options: HookOptions, callback: () => Promise<void> | void) => void
type BeforeHook = (
  options: HookOptions,
  callback: (this: HookWorld, argument: ScenarioHookArgument) => Promise<void> | void,
) => void
type AfterHook = (callback: (this: HookWorld, argument: ScenarioHookArgument) => Promise<void> | void) => void
type AfterAllHook = (options: HookOptions, callback: () => Promise<void> | void) => void

type CucumberRuntime = {
  BeforeAll: BeforeAllHook
  Before: BeforeHook
  After: AfterHook
  AfterAll: AfterAllHook
  Status: {
    FAILED: string
  }
}

type BrowserSupport = {
  closeWorldBrowser: (world: HookWorld) => Promise<void>
}

type EguiHelpersSupport = {
  readEguiError: (page: Page) => Promise<string | null>
  getScenarioArtifactPath: (world: HookWorld, scenarioName?: string, fileName?: string) => Promise<string>
}

type ServerSupport = {
  ensureSharedWebServer: () => Promise<SharedWebServer>
  getSharedWebServerConfig: () => SharedWebServerConfig
  shutdownSharedWebServer: () => Promise<void>
}

type RegisterHooksDependencies = {
  BeforeAll?: BeforeAllHook
  Before?: BeforeHook
  After?: AfterHook
  AfterAll?: AfterAllHook
  Status?: {
    FAILED: string
  }
  ensureSharedWebServer?: () => Promise<SharedWebServer>
  shutdownSharedWebServer?: () => Promise<void>
  closeWorldBrowser?: (world: HookWorld) => Promise<void>
  readEguiError?: (page: Page) => Promise<string | null>
  getScenarioArtifactPath?: (world: HookWorld, scenarioName?: string, fileName?: string) => Promise<string>
  getSharedWebServerConfig?: () => SharedWebServerConfig
}

const {
  After: defaultAfter,
  AfterAll: defaultAfterAll,
  Before: defaultBefore,
  BeforeAll: defaultBeforeAll,
  Status,
} = require('@cucumber/cucumber') as CucumberRuntime

const { closeWorldBrowser } = require('./browser.ts') as BrowserSupport
const { readEguiError, getScenarioArtifactPath } = require('./egui-helpers.ts') as EguiHelpersSupport
const {
  ensureSharedWebServer,
  getSharedWebServerConfig,
  shutdownSharedWebServer,
} = require('./server.ts') as ServerSupport

export const registerHooks = ({
  BeforeAll = defaultBeforeAll,
  Before = defaultBefore,
  After = defaultAfter,
  AfterAll = defaultAfterAll,
  Status: statusEnum = Status,
  ensureSharedWebServer: ensureServer = ensureSharedWebServer,
  shutdownSharedWebServer: shutdownServer = shutdownSharedWebServer,
  closeWorldBrowser: closeBrowser = closeWorldBrowser,
  readEguiError: readError = readEguiError,
  getScenarioArtifactPath: getArtifactPath = getScenarioArtifactPath,
  getSharedWebServerConfig: getServerConfig = getSharedWebServerConfig,
}: RegisterHooksDependencies = {}): void => {
  let sharedServer: SharedWebServer | null = null

  BeforeAll({ timeout: getServerConfig().timeout }, async function () {
    sharedServer = await ensureServer()
  })

  // 共有サーバは run 単位で 1 つだが、途中で落ちることがある (直前の実行の
  // 後始末と重なった場合など)。健全なら probe 1 回で戻るだけなので、
  // シナリオごとに生存を確認して必要なら再起動する。
  Before({ timeout: getServerConfig().timeout }, async function ({ pickle }) {
    sharedServer = await ensureServer()
    this.startScenario(pickle?.name)
    this.server = sharedServer
    this.baseUrl = sharedServer?.url || getServerConfig().url
  })

  After(async function ({ pickle, result }) {
    try {
      const failed = result?.status === statusEnum.FAILED || result?.status === 'FAILED'

      if (failed && this.page) {
        const screenshotPath = await getArtifactPath(this, pickle?.name, 'failure.png')
        const screenshot = await this.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null)
        if (screenshot) {
          await this.attach(screenshot, 'image/png')
        }
      }

      if (this.page && (failed || this.consoleErrors.length > 0 || this.pageErrors.length > 0)) {
        const diagnostics = {
          browserMode: this.browserMode,
          eguiError: await readError(this.page).catch(() => null),
          consoleErrors: this.consoleErrors,
          pageErrors: this.pageErrors,
        }
        await this.attach(JSON.stringify(diagnostics, null, 2), 'application/json')
      }
    } finally {
      await closeBrowser(this)
      this.resetRuntimeState()
      this.baseUrl = sharedServer?.url || getServerConfig().url
    }
  })

  AfterAll({ timeout: getServerConfig().timeout }, async function () {
    try {
      await shutdownServer()
    } finally {
      sharedServer = null
    }
  })
}
