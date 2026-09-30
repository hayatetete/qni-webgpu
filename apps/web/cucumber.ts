type CucumberProfile = {
  paths: string[]
  requireModule: string[]
  require: string[]
  publishQuiet: boolean
  failFast: boolean
  retry: number
  parallel?: number
}

const defaultProfile: CucumberProfile = {
  paths: ['features/**/*.feature.md'],
  requireModule: ['ts-node/register'],
  require: [
    'features/support/bootstrap.ts',
    'features/step_definitions/**/*.ts',
  ],
  publishQuiet: true,
  failFast: true,
  // WebGPU の初期化が応答しないまま止まるページが Chrome 側の事情でまれに出る
  // (`bootstrap.ts` の監視が 15 秒で明示的なエラーへ切り替える)。1 回だけ
  // 再試行し、2 回続けて落ちるものは本当の退行として扱う。
  retry: 1,
  parallel: process.env.CI ? 2 : undefined,
}

module.exports = defaultProfile
