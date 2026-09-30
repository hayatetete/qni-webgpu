const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const rootDir = path.join(__dirname, '..')

// docker-entrypoint.sh を外部コマンドのスタブ付きで実際に走らせ、
// 生成された server.conf を返す。nginx / python3 / curl / htpasswd は
// スタブに差し替えるため、ホストに Docker イメージの依存物は不要。
function renderServerConf() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qni-entrypoint-'))
  const binDir = path.join(workDir, 'bin')
  const runtimeDir = path.join(workDir, 'runtime')
  fs.mkdirSync(binDir)
  for (const name of ['nginx', 'python3', 'curl', 'htpasswd']) {
    fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }

  execFileSync('bash', [path.join(rootDir, 'deploy', 'docker', 'docker-entrypoint.sh'), 'true'], {
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      QNI_RUNTIME_DIR: runtimeDir,
      QNI_NGINX_TEMPLATE: path.join(rootDir, 'deploy', 'docker', 'nginx.conf.template'),
      QNI_WEB_ROOT: path.join(workDir, 'dist'),
    },
    stdio: 'pipe',
  })

  return fs.readFileSync(path.join(runtimeDir, 'server.conf'), 'utf8')
}

test('generated nginx server config resolves the auth snippet include to a real file', () => {
  const includes = renderServerConf()
    .split('\n')
    .filter((line) => line.trim().startsWith('include '))
    .map((line) => line.trim().replace(/^include\s+/, '').replace(/;$/, ''))

  assert.deepEqual(
    includes.map((target) => target !== '' && fs.existsSync(target)),
    [true, true, true, true],
  )
})
