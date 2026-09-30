const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { loadConfiguration } = require('@cucumber/cucumber/api')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.join(__dirname, '..')
const supportDir = path.join(rootDir, 'features', 'support')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const CUCUMBER_SMOKE_TIMEOUT_MS = 20_000
type MutableRecord = Record<string, any>
type HookOptionsStub = { timeout: number }
type ScenarioHookCallback = (
  this: MutableRecord,
  argument: { pickle?: { name?: string }; result?: { status: string } },
) => Promise<void> | void

const readPackageJson = async () => {
  const packageJsonPath = path.join(rootDir, 'package.json')
  return JSON.parse(await fs.readFile(packageJsonPath, 'utf8'))
}

const readTsConfig = async () => {
  const tsconfigPath = path.join(rootDir, 'tsconfig.json')
  return JSON.parse(await fs.readFile(tsconfigPath, 'utf8'))
}

const readDocs = () => fs.readFile(path.join(rootDir, '..', '..', 'docs', 'web.md'), 'utf8')

const readSupportSource = async (fileName: string) => fs.readFile(path.join(supportDir, fileName), 'utf8')

const parseMessageOutput = async (messagePath: string): Promise<MutableRecord[]> => {
  const lines = (await fs.readFile(messagePath, 'utf8'))
    .split('\n')
    .map((line: string) => line.trim())
    .filter(Boolean)

  return lines.map((line: string) => JSON.parse(line))
}

const loadCucumberConfig = (env: NodeJS.ProcessEnv = process.env) => {
  const configPath = require.resolve('../cucumber.ts')
  delete require.cache[configPath]

  const previousCi = process.env.CI
  if (env.CI === undefined) {
    delete process.env.CI
  } else {
    process.env.CI = env.CI
  }

  try {
    const configModule = require('../cucumber.ts')
    return configModule.default || configModule
  } finally {
    if (previousCi === undefined) {
      delete process.env.CI
    } else {
      process.env.CI = previousCi
    }
    delete require.cache[configPath]
  }
}

const writeTempSmokeFixture = async (featureText: string) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-cucumber-smoke-'))
  const featurePath = path.join(tempDir, 'smoke.feature.md')
  const stepsPath = path.join(tempDir, 'smoke.steps.ts')
  const messagePath = path.join(tempDir, 'messages.ndjson')

  await fs.writeFile(featurePath, featureText)
  await fs.writeFile(
    stepsPath,
    [
      `const { Given } = require(${JSON.stringify(require.resolve('@cucumber/cucumber'))})`,
      "enum SmokeKind { Noop = 'noop' }",
      "Given('a smoke noop step', function () { void SmokeKind.Noop })",
      '',
    ].join('\n')
  )

  return { tempDir, featurePath, stepsPath, messagePath }
}

test('package scripts add bdd and keep legacy Playwright as the primary test command', async () => {
  const pkg = await readPackageJson()

  assert.deepEqual({
    test: pkg.scripts.test,
    pwLegacy: pkg.scripts['test:pw-legacy'],
    bdd: pkg.scripts['test:bdd'],
    buildBootstrapUsesTs: /tsc bootstrap\.ts/.test(pkg.scripts['build:bootstrap']),
    typecheck: pkg.scripts.typecheck,
    preflight: pkg.scripts['test:preflight'],
    cucumberVersionPinned: /^\^\d+/.test(pkg.devDependencies['@cucumber/cucumber']),
    nodeTypesVersionPinned: /^\^\d+/.test(pkg.devDependencies['@types/node']),
    tsNodeVersionPinned: /^\^\d+/.test(pkg.devDependencies['ts-node']),
    typescriptVersionPinned: /^\^\d+/.test(pkg.devDependencies.typescript),
  }, {
    test: 'playwright test',
    pwLegacy: 'playwright test',
    bdd: 'cucumber-js --config cucumber.ts',
    buildBootstrapUsesTs: true,
    typecheck: 'tsc --noEmit',
    preflight: 'pnpm run check:ui-constants && pnpm run typecheck && node -r ts-node/register/transpile-only --test test-node/*.test.ts',
    cucumberVersionPinned: true,
    nodeTypesVersionPinned: true,
    tsNodeVersionPinned: true,
    typescriptVersionPinned: true,
  })
})

test('cucumber config is TypeScript without a compatibility wrapper', async () => {
  const accessOk = async (filePath: string): Promise<boolean> => fs.access(filePath).then(() => true, () => false)
  const docs = await readDocs()
  assert.deepEqual({
    hasTsConfig: await accessOk(path.join(rootDir, 'cucumber.ts')),
    hasCjsConfig: await accessOk(path.join(rootDir, 'cucumber.cjs')),
    docsUseTs: /cucumber\.ts/.test(docs),
    docsAvoidCjs: !/cucumber\.cjs/.test(docs),
  }, { hasTsConfig: true, hasCjsConfig: false, docsUseTs: true, docsAvoidCjs: true })
})

test('typescript config type-checks cucumber glue without emitting files', async () => {
  const tsconfig = await readTsConfig()

  assert.deepEqual({
    noEmit: tsconfig.compilerOptions.noEmit,
    rootDir: tsconfig.compilerOptions.rootDir,
    module: tsconfig.compilerOptions.module,
    strict: tsconfig.compilerOptions.strict,
    hasNodeTypes: tsconfig.compilerOptions.types.includes('node'),
    includeFlags: [
      'bootstrap.ts',
      'features/**/*.ts',
      'features/**/*.d.ts',
      'cucumber.ts',
      'playwright.config.ts',
      'scripts/**/*.ts',
      'test-node/**/*.ts',
      'tests/**/*.ts',
      'test-support/**/*.ts',
    ].map((entry) => tsconfig.include.includes(entry)),
  }, {
    noEmit: true,
    rootDir: '.',
    module: 'CommonJS',
    strict: true,
    hasNodeTypes: true,
    includeFlags: [true, true, true, true, true, true, true, true, true],
  })
})

test('cucumber CLI resolves the default profile with TypeScript support', async () => {
  const { useConfiguration, runConfiguration } = await loadConfiguration({ file: 'cucumber.ts' })

  assert.deepEqual({
    paths: useConfiguration.paths,
    requireModules: runConfiguration.support.requireModules,
    requirePaths: [...runConfiguration.support.requirePaths].sort(),
    publish: useConfiguration.publish,
    failFast: useConfiguration.failFast,
  }, {
    paths: ['features/**/*.feature.md'],
    requireModules: ['ts-node/register'],
    requirePaths: ['features/step_definitions/**/*.ts', 'features/support/bootstrap.ts'].sort(),
    publish: false,
    failFast: true,
  })
})

test('cucumber config only targets markdown feature files and uses explicit support bootstrap', () => {
  const config = loadCucumberConfig()

  assert.deepEqual({
    paths: config.paths,
    requireModule: config.requireModule,
    require: [...config.require].sort(),
    publishQuiet: config.publishQuiet,
    failFast: config.failFast,
  }, {
    paths: ['features/**/*.feature.md'],
    requireModule: ['ts-node/register'],
    require: ['features/step_definitions/**/*.ts', 'features/support/bootstrap.ts'].sort(),
    publishQuiet: true,
    failFast: true,
  })
})

test('cucumber config uses bounded scenario parallelism on CI', () => {
  const config = loadCucumberConfig({ ...process.env, CI: '1' })

  assert.equal(config.parallel, 2)
})

// 起動固まりは Chrome / Dawn 側の待ちで解消できないため 1 回だけ再試行する。
test('cucumber config retries a failing scenario exactly once', () => {
  const config = loadCucumberConfig()

  assert.equal(config.retry, 1)
})

test('support modules expose explicit registration hooks without runtime message sniffing', async () => {
  const hooks = require('../features/support/hooks.ts')
  const world = require('../features/support/world.ts')
  const accessOk = async (filePath: string): Promise<boolean> => fs.access(filePath).then(() => true, () => false)

  const [hooksSource, worldSource] = await Promise.all([
    readSupportSource('hooks.ts'),
    readSupportSource('world.ts'),
  ])

  assert.deepEqual({
    registerHooks: typeof hooks.registerHooks,
    registerWorld: typeof world.registerWorld,
    hasBootstrapTs: await accessOk(path.join(supportDir, 'bootstrap.ts')),
    hasBootstrapCjs: await accessOk(path.join(supportDir, 'bootstrap.cjs')),
    hooksAvoidRuntimeSniffing: !/isn['’]?t running/.test(hooksSource),
    worldAvoidRuntimeSniffing: !/isn['’]?t running/.test(worldSource),
  }, {
    registerHooks: 'function',
    registerWorld: 'function',
    hasBootstrapTs: true,
    hasBootstrapCjs: false,
    hooksAvoidRuntimeSniffing: true,
    worldAvoidRuntimeSniffing: true,
  })
})

test('support hooks verify the shared server per scenario while resetting browser state', async () => {
  const hooks = require('../features/support/hooks.ts')
  const registrations: MutableRecord = {}
  const calls: string[] = []

  hooks.registerHooks({
    BeforeAll: (options: any, callback: any) => {
      registrations.beforeAllOptions = options
      registrations.beforeAll = callback
    },
    Before: (options: HookOptionsStub, callback: ScenarioHookCallback) => {
      registrations.beforeOptions = options
      registrations.before = callback
    },
    After: (callback: any) => {
      registrations.after = callback
    },
    AfterAll: (options: any, callback: any) => {
      registrations.afterAllOptions = options
      registrations.afterAll = callback
    },
    Status: { FAILED: 'FAILED' },
    ensureSharedWebServer: async () => {
      calls.push('ensure-server')
      return { url: 'http://127.0.0.1:4174', managed: true }
    },
    shutdownSharedWebServer: async () => {
      calls.push('shutdown-server')
    },
    closeWorldBrowser: async () => {
      calls.push('close-browser')
    },
    readEguiError: async () => null,
    getScenarioArtifactPath: async () => '/tmp/failure.png',
    getSharedWebServerConfig: () => ({ url: 'http://127.0.0.1:4174', timeout: 123_456 }),
  })

  const registeredCallbacks = {
    beforeAll: typeof registrations.beforeAll,
    before: typeof registrations.before,
    after: typeof registrations.after,
    afterAll: typeof registrations.afterAll,
    beforeAllOptions: registrations.beforeAllOptions,
    beforeOptions: registrations.beforeOptions,
    afterAllOptions: registrations.afterAllOptions,
  }

  const world: MutableRecord = {
    page: null,
    consoleErrors: [],
    pageErrors: [],
    async attach() {},
    startScenario(name: string) {
      calls.push(`start:${name}`)
    },
    resetRuntimeState() {
      calls.push('reset-world')
    },
  }

  await registrations.beforeAll.call({})
  await registrations.before.call(world, { pickle: { name: 'smoke scenario' } })
  await registrations.after.call(world, {
    pickle: { name: 'smoke scenario' },
    result: { status: 'PASSED' },
  })
  await registrations.afterAll.call({})

  assert.deepEqual({ registeredCallbacks, baseUrl: world.baseUrl, calls }, {
    registeredCallbacks: {
      beforeAll: 'function',
      before: 'function',
      after: 'function',
      afterAll: 'function',
      beforeAllOptions: { timeout: 123_456 },
      beforeOptions: { timeout: 123_456 },
      afterAllOptions: { timeout: 123_456 },
    },
    baseUrl: 'http://127.0.0.1:4174',
    calls: [
      'ensure-server',
      'ensure-server',
      'start:smoke scenario',
      'close-browser',
      'reset-world',
      'shutdown-server',
    ],
  })
})

test('cucumber dry-run smoke plans exactly one selected markdown scenario without relying on formatter text', async (t: import('node:test').TestContext) => {
  const fixture = await writeTempSmokeFixture([
    '# Feature: cucumber config smoke',
    '## Scenario: runner loads config and support',
    '- Given a smoke noop step',
    '',
  ].join('\n'))

  t.after(async () => {
    await fs.rm(fixture.tempDir, { recursive: true, force: true })
  })

  const result = spawnSync(
    pnpmCommand,
    [
      'exec',
      'cucumber-js',
      '--config',
      'cucumber.ts',
      '--dry-run',
      '--format',
      `message:${fixture.messagePath}`,
      '--require',
      fixture.stepsPath,
      '--name',
      '^runner loads config and support$',
      fixture.featurePath,
    ],
    {
      cwd: rootDir,
      encoding: 'utf8',
      timeout: CUCUMBER_SMOKE_TIMEOUT_MS,
    }
  )

  const messages = await parseMessageOutput(fixture.messagePath)
  const testCaseStartedCount = messages.filter((message: MutableRecord) => message.testCaseStarted).length

  assert.deepEqual({
    error: result.error ?? null,
    signal: result.signal,
    status: result.status,
    testCaseStartedCount,
  }, { error: null, signal: null, status: 0, testCaseStartedCount: 1 })
})

test('support scaffolding loads and reuses the shared Task 1 browser and server policies', () => {
  const sharedBrowser = require('../test-support/browser-launch.ts')
  const sharedServer = require('../test-support/web-server.ts')
  const browser = require('../features/support/browser.ts')
  const server = require('../features/support/server.ts')
  const world = require('../features/support/world.ts')
  const helpers = require('../features/support/egui-helpers.ts')

  assert.deepEqual({
    standardLaunchShared: browser.getStandardWebGpuLaunchOptions === sharedBrowser.getStandardWebGpuLaunchOptions,
    plainLaunchShared: browser.getPlainChromiumLaunchOptions === sharedBrowser.getPlainChromiumLaunchOptions,
    serverConfigShared: server.getSharedWebServerConfig === sharedServer.getWebServerConfig,
    launchBrowserForMode: typeof browser.launchBrowserForMode,
    ensureSharedWebServer: typeof server.ensureSharedWebServer,
    shutdownSharedWebServer: typeof server.shutdownSharedWebServer,
    worldClass: typeof world.EguiWorld,
    waitForAppReady: typeof helpers.waitForAppReady,
    waitForStartupReady: typeof helpers.waitForStartupReady,
    readEguiError: typeof helpers.readEguiError,
  }, {
    standardLaunchShared: true,
    plainLaunchShared: true,
    serverConfigShared: true,
    launchBrowserForMode: 'function',
    ensureSharedWebServer: 'function',
    shutdownSharedWebServer: 'function',
    worldClass: 'function',
    waitForAppReady: 'function',
    waitForStartupReady: 'function',
    readEguiError: 'function',
  })
})

test('cucumber world uses an externally managed base URL when configured', () => {
  const worldModulePath = require.resolve('../features/support/world.ts')
  delete require.cache[worldModulePath]

  const previousExternal = process.env.QNI_WEB_EXTERNAL_SERVER
  const previousBaseUrl = process.env.QNI_WEB_BASE_URL
  process.env.QNI_WEB_EXTERNAL_SERVER = '1'
  process.env.QNI_WEB_BASE_URL = 'http://127.0.0.1:5999'

  try {
    const { EguiWorld } = require('../features/support/world.ts')
    const world = new EguiWorld({
      attach: async () => {},
      log: () => {},
      link: () => {},
      parameters: {},
    })

    assert.equal(world.baseUrl, 'http://127.0.0.1:5999')
  } finally {
    if (previousExternal === undefined) {
      delete process.env.QNI_WEB_EXTERNAL_SERVER
    } else {
      process.env.QNI_WEB_EXTERNAL_SERVER = previousExternal
    }

    if (previousBaseUrl === undefined) {
      delete process.env.QNI_WEB_BASE_URL
    } else {
      process.env.QNI_WEB_BASE_URL = previousBaseUrl
    }

    delete require.cache[worldModulePath]
  }
})

export {}
