const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const rootDir = path.join(__dirname, '..')
const repoRoot = path.join(rootDir, '..', '..')

const sha256 = async (filePath: string): Promise<string | null> => {
  try {
    return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

test('browser bootstrap source is TypeScript without a checked-in JavaScript wrapper', async () => {
  const accessOk = async (filePath: string): Promise<boolean> => fs.access(filePath).then(() => true, () => false)
  const pkg = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'))
  const trunkConfig = await fs.readFile(path.join(rootDir, 'Trunk.toml'), 'utf8')
  const index = await fs.readFile(path.join(rootDir, 'index.html'), 'utf8')
  const gitignore = await fs.readFile(path.join(repoRoot, '.gitignore'), 'utf8')

  assert.deepEqual({
    hasBootstrapTs: await accessOk(path.join(rootDir, 'bootstrap.ts')),
    hasBootstrapJs: await accessOk(path.join(rootDir, 'bootstrap.js')),
    buildScriptUsesTs: /tsc bootstrap\.ts/.test(pkg.scripts['build:bootstrap']),
    trunkHasHook: /\[\[hooks\]\]/.test(trunkConfig),
    trunkPreBuild: /stage = "pre_build"/.test(trunkConfig),
    trunkUsesPnpm: /command = "pnpm"/.test(trunkConfig),
    trunkBuildBootstrap: /"build:bootstrap"/.test(trunkConfig),
    trunkWatchesBootstrapTs: /watch = \["bootstrap\.ts"\]/.test(trunkConfig),
    bootstrapImportsWasmNextToBootstrapScript: /new URL\('qni-web\.js', bootstrapScriptUrl\(\)\)/.test(
      await fs.readFile(path.join(rootDir, 'bootstrap.ts'), 'utf8'),
    ),
    indexLoadsGeneratedBootstrap: /href="\.trunk-generated\/bootstrap\.js"/.test(index),
    indexAvoidsCheckedInBootstrapTarget: !/data-target-path="bootstrap\.js"/.test(index),
    indexUsesModuleScript: /<script type="module" src="bootstrap\.js"(?:\s[^>]*)?><\/script>/.test(index),
    gitignoreIgnoresGeneratedBootstrap: /apps\/web\/\.trunk-generated\//.test(gitignore),
  }, {
    hasBootstrapTs: true,
    hasBootstrapJs: false,
    buildScriptUsesTs: true,
    trunkHasHook: true,
    trunkPreBuild: true,
    trunkUsesPnpm: true,
    trunkBuildBootstrap: true,
    trunkWatchesBootstrapTs: true,
    bootstrapImportsWasmNextToBootstrapScript: true,
    indexLoadsGeneratedBootstrap: true,
    indexAvoidsCheckedInBootstrapTarget: true,
    indexUsesModuleScript: true,
    gitignoreIgnoresGeneratedBootstrap: true,
  })
})

test('browser document advertises Qni favicon assets', async () => {
  const index = await fs.readFile(path.join(rootDir, 'index.html'), 'utf8')

  assert.deepEqual({
    copiesFaviconIco: /data-trunk rel="copy-file" href="favicon\.ico"/.test(index),
    copiesSvgIcon: /data-trunk rel="copy-file" href="icon\.svg"/.test(index),
    copiesAppleTouchIcon: /data-trunk rel="copy-file" href="apple-touch-icon\.png"/.test(index),
    linksFaviconIco: /<link rel="icon" href="favicon\.ico" type="image\/x-icon" \/>/.test(index),
    linksSvgIcon: /<link rel="icon" href="icon\.svg" type="image\/svg\+xml" \/>/.test(index),
    linksAppleTouchIcon: /<link rel="apple-touch-icon" href="apple-touch-icon\.png" \/>/.test(index),
    faviconIcoSha256: await sha256(path.join(rootDir, 'favicon.ico')),
    svgIconSha256: await sha256(path.join(rootDir, 'icon.svg')),
    appleTouchIconSha256: await sha256(path.join(rootDir, 'apple-touch-icon.png')),
  }, {
    copiesFaviconIco: true,
    copiesSvgIcon: true,
    copiesAppleTouchIcon: true,
    linksFaviconIco: true,
    linksSvgIcon: true,
    linksAppleTouchIcon: true,
    faviconIcoSha256: 'f2c4bad949b0ec8860fd84b540c014d8745479889f42f67ecdd8e09b4c114ef9',
    svgIconSha256: '3bfb62e31079261982c60dc4e7cfde47d96ab5ae5e10112379f60635ca028099',
    appleTouchIconSha256: '411c6cee28330a09497f6d842d3ba774188439fb9ee9c66c5426fcc11800f095',
  })
})

test('browser bootstrap defaults Qiskit backend to same-origin outside local trunk dev', async () => {
  const source = await fs.readFile(path.join(rootDir, 'bootstrap.ts'), 'utf8')

  assert.deepEqual({
    keepsLocalTrunkBackend: /window\.location\.port === '4174'/.test(source),
    usesSameOriginRunPath: /new URL\('run', window\.location\.href\)/.test(source),
    fetchesThroughUrlHelper: /fetch\(qiskitBackendUrl\(\)/.test(source),
  }, {
    keepsLocalTrunkBackend: true,
    usesSameOriginRunPath: true,
    fetchesThroughUrlHelper: true,
  })
})

export {}
