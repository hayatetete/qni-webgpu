const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const rootDir = path.join(__dirname, '..')

test('Docker deployment keeps GPU-only runner, auth, same-origin API, and Open OnDemand paths wired', async () => {
  const dockerfile = await fs.readFile(path.join(rootDir, 'Dockerfile'), 'utf8')
  const entrypoint = await fs.readFile(path.join(rootDir, 'deploy', 'docker', 'docker-entrypoint.sh'), 'utf8')
  const nginx = await fs.readFile(path.join(rootDir, 'deploy', 'docker', 'nginx.conf.template'), 'utf8')

  assert.deepEqual({
    dockerBuildsRelativeAssets: /trunk build --release --public-url \.\//.test(dockerfile),
    dockerPinsQiskitAerTag: /git clone --depth 1 -b 0\.17\.2/.test(dockerfile),
    entrypointRejectsNonGpuRunner: /QNI_QISKIT_RUNNER[^\n]+!= "qiskit-gpu"/.test(entrypoint),
    entrypointRejectsNonGpuAllowedRunners: /QNI_QISKIT_ALLOWED_RUNNERS[^\n]+!= "qiskit-gpu"/.test(entrypoint),
    entrypointStartsServerWithAllowedGpuRunner: /--allowed-runners qiskit-gpu/.test(entrypoint),
    entrypointProtectsBackendWithProxyTokenFile: /QNI_BACKEND_PROXY_TOKEN_FILE="\$\{BACKEND_TOKEN_FILE\}"/.test(entrypoint),
    entrypointUsesPrivateRuntimeDir: /mktemp -d "\$\{TMPDIR:-\/tmp\}\/qni-webgpu-runtime\.XXXXXX"/.test(entrypoint),
    entrypointKeepsTokenOutOfBackendArgv: !/--proxy-token/.test(entrypoint),
    entrypointCreatesHtpasswdFromStdin: /htpasswd -Bci "\$\{HTPASSWD_FILE\}"/.test(entrypoint),
    entrypointUsesWritableNginxConfig: /NGINX_CONF="\$\{QNI_RUNTIME_DIR\}\/nginx\.conf"/.test(entrypoint),
    nginxProxiesRootRun: /location = \/run/.test(nginx),
    nginxForwardsBackendProxyToken: /proxy_set_header X-QNI-Backend-Token \$\{QNI_BACKEND_PROXY_TOKEN\};/.test(nginx),
    nginxProtectsRunWithAuthSnippet: /location = \/run \{[\s\S]*include \$\{QNI_AUTH_SNIPPET\};/.test(nginx),
    nginxSupportsOpenOnDemandRun: /\^\/node\/\[\^\/\]\+\/\[0-9\]\+\/run\$/.test(nginx),
    nginxRewritesOpenOnDemandRun: /rewrite \^\/node\/\[\^\/\]\+\/\[0-9\]\+\/run\$ \/run break;/.test(nginx),
    nginxUsesBareProxyPassInOpenOnDemandRun: /rewrite \^\/node\/\[\^\/\]\+\/\[0-9\]\+\/run\$ \/run break;[\s\S]*proxy_pass http:\/\/\$\{QNI_QISKIT_BACKEND_HOST\}:\$\{QNI_QISKIT_BACKEND_PORT\};/.test(nginx),
    nginxRewritesOpenOnDemandAssets: /try_files \/\$qni_path \/\$qni_path\/ \/index\.html;/.test(nginx),
  }, {
    dockerBuildsRelativeAssets: true,
    dockerPinsQiskitAerTag: true,
    entrypointRejectsNonGpuRunner: true,
    entrypointRejectsNonGpuAllowedRunners: true,
    entrypointStartsServerWithAllowedGpuRunner: true,
    entrypointProtectsBackendWithProxyTokenFile: true,
    entrypointUsesPrivateRuntimeDir: true,
    entrypointKeepsTokenOutOfBackendArgv: true,
    entrypointCreatesHtpasswdFromStdin: true,
    entrypointUsesWritableNginxConfig: true,
    nginxProxiesRootRun: true,
    nginxForwardsBackendProxyToken: true,
    nginxProtectsRunWithAuthSnippet: true,
    nginxSupportsOpenOnDemandRun: true,
    nginxRewritesOpenOnDemandRun: true,
    nginxUsesBareProxyPassInOpenOnDemandRun: true,
    nginxRewritesOpenOnDemandAssets: true,
  })
})
