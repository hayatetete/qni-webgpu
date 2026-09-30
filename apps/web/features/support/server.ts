import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'

type WebServerConfig = {
  url: string
  timeout: number
  reuseExistingServer: boolean
} & (
  | {
      command: string
      external?: false
    }
  | {
      external: true
      command?: never
    }
)

type WebServerSupport = {
  getWebServerConfig: (options?: { env?: NodeJS.ProcessEnv }) => WebServerConfig
}

type ManagedWebServer = WebServerConfig & {
  managed: boolean
}

const { getWebServerConfig } = require('../../test-support/web-server.ts') as WebServerSupport

const APP_ROOT = path.join(__dirname, '..', '..')
const POLL_INTERVAL_MS = 250
const PROCESS_TERM_TIMEOUT_MS = 5_000
const PROCESS_KILL_TIMEOUT_MS = 5_000

let managedServerProcess: ChildProcess | null = null

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const didProcessExit = (processToCheck?: ChildProcess | null): boolean => {
  if (!processToCheck) {
    return false
  }

  return processToCheck.exitCode !== null || processToCheck.signalCode !== null
}

const waitForProcessExit = async (
  processToWaitFor: ChildProcess | null | undefined,
  timeoutMs: number
): Promise<boolean> => {
  if (!processToWaitFor || didProcessExit(processToWaitFor)) {
    return true
  }

  let timeoutId: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<boolean>((resolve) => {
      timeoutId = setTimeout(() => resolve(false), timeoutMs)
    })

    const exited = await Promise.race([
      once(processToWaitFor, 'exit')
        .then(() => true)
        .catch(() => true),
      timeout,
    ])

    return exited || didProcessExit(processToWaitFor)
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

export const terminateProcess = async (
  processToStop: ChildProcess | null | undefined,
  {
    termTimeoutMs = PROCESS_TERM_TIMEOUT_MS,
    killTimeoutMs = PROCESS_KILL_TIMEOUT_MS,
  }: {
    termTimeoutMs?: number
    killTimeoutMs?: number
  } = {}
): Promise<void> => {
  if (!processToStop || didProcessExit(processToStop)) {
    return
  }

  processToStop.kill('SIGTERM')
  if (await waitForProcessExit(processToStop, termTimeoutMs)) {
    return
  }

  processToStop.kill('SIGKILL')
  await waitForProcessExit(processToStop, killTimeoutMs)
}

const probeServer = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { redirect: 'manual' })
    await response.arrayBuffer().catch(() => {})
    return true
  } catch {
    return false
  }
}

const waitForServer = async (url: string, timeout: number): Promise<void> => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await probeServer(url)) {
      return
    }
    await delay(POLL_INTERVAL_MS)
  }

  throw new Error(`Timed out waiting for web test server: ${url}`)
}

export const ensureSharedWebServer = async (): Promise<ManagedWebServer> => {
  const config = getWebServerConfig({ env: process.env })

  if (config.external) {
    await waitForServer(config.url, config.timeout)
    return { ...config, managed: false }
  }

  if (managedServerProcess && !didProcessExit(managedServerProcess)) {
    await waitForServer(config.url, config.timeout)
    return { ...config, managed: true }
  }

  // 終了しかけのサーバは 1 回目の probe にだけ応答することがある。直前まで
  // 開発サーバを動かしていた場合に起きやすく、そのまま「起動済み」と判定すると
  // 最初のシナリオだけが ERR_CONNECTION_REFUSED で落ちる。間隔を置いて
  // 2 回連続で応答したときだけ、既存のサーバを使う。
  if (await probeServer(config.url)) {
    await delay(POLL_INTERVAL_MS)
    if (await probeServer(config.url)) {
      return { ...config, managed: false }
    }
  }

  managedServerProcess = spawn('sh', ['-lc', `exec ${config.command}`], {
    cwd: APP_ROOT,
    stdio: 'ignore',
  })

  try {
    await waitForServer(config.url, config.timeout)
  } catch (error) {
    await shutdownSharedWebServer()
    throw error
  }

  return { ...config, managed: true }
}

export const shutdownSharedWebServer = async (): Promise<void> => {
  const processToStop = managedServerProcess
  managedServerProcess = null

  await terminateProcess(processToStop)
}

export { getWebServerConfig as getSharedWebServerConfig }
