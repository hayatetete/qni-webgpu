const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const rootDir = path.join(__dirname, '..')

test('ABCI Open OnDemand app launches the GPU-only Singularity image through the node proxy', async () => {
  const required = [
    'manifest.yml',
    'form.yml',
    'submit.yml.erb',
    'template/before.sh.erb',
    'template/script.sh.erb',
    'template/after.sh',
    'view.html.erb',
  ]
  const files = await Promise.all(required.map(async (name) => {
    const filePath = path.join(rootDir, 'deploy', 'abci_ood', name)
    return [name, await fs.readFile(filePath, 'utf8')]
  }))
  const content = Object.fromEntries(files)

  assert.deepEqual({
    declaresBatchConnectRole: /role: batch_connect/.test(content['manifest.yml']),
    exposesImagePath: /singularity_image:/.test(content['form.yml']),
    exposesAuthMode: /auth_mode:/.test(content['form.yml']),
    usesAbciGroup: /<%= abci_group %>/.test(content['submit.yml.erb']),
    shellEscapesErbValues: /Shellwords\.escape\(context\.singularity_image\.to_s\)/.test(content['template/script.sh.erb']),
    avoidsRubyInspectShellQuoting: !/\.inspect/.test(content['template/script.sh.erb']),
    findsRuntimePort: /port=\$\(find_port\)/.test(content['template/before.sh.erb']),
    findsBackendPort: /backend_port=\$\(find_port\)/.test(content['template/before.sh.erb']),
    avoidsFrontendBackendPortCollision: /candidate != frontend_port/.test(content['template/before.sh.erb']),
    forcesGpuRunner: /SINGULARITYENV_QNI_QISKIT_RUNNER="qiskit-gpu"/.test(content['template/script.sh.erb']),
    passesRuntimePortToSingularity: /SINGULARITYENV_QNI_HTTP_PORT="\$\{port\}"/.test(content['template/script.sh.erb']),
    passesBackendPortToSingularity: /SINGULARITYENV_QNI_QISKIT_BACKEND_PORT="\$\{backend_port\}"/.test(content['template/script.sh.erb']),
    usesWritableRuntimeDir: /SINGULARITYENV_QNI_RUNTIME_DIR="\$\{runtime_dir\}"/.test(content['template/script.sh.erb']),
    passesAuthPasswordByFile: /SINGULARITYENV_QNI_AUTH_PASSWORD_FILE="\$\{auth_password_file\}"/.test(content['template/script.sh.erb']),
    copiesHtpasswdIntoBoundRuntimeDir: /cp "\$\{QNI_HTPASSWD_SOURCE\}" "\$\{QNI_HTPASSWD\}"/.test(content['template/script.sh.erb']),
    bindsRuntimeDir: /--bind "\$\{runtime_dir\}:\$\{runtime_dir\}"/.test(content['template/script.sh.erb']),
    launchesWithNvidiaGpu: /singularity run --nv/.test(content['template/script.sh.erb']),
    waitsForPort: /wait_until_port_used "\$\{host\}:\$\{port\}"/.test(content['template/after.sh']),
    linksThroughNodeProxy: /href="\/node\/<%= host %>\/<%= port %>\/"/.test(content['view.html.erb']),
  }, {
    declaresBatchConnectRole: true,
    exposesImagePath: true,
    exposesAuthMode: true,
    usesAbciGroup: true,
    shellEscapesErbValues: true,
    avoidsRubyInspectShellQuoting: true,
    findsRuntimePort: true,
    findsBackendPort: true,
    avoidsFrontendBackendPortCollision: true,
    forcesGpuRunner: true,
    passesRuntimePortToSingularity: true,
    passesBackendPortToSingularity: true,
    usesWritableRuntimeDir: true,
    passesAuthPasswordByFile: true,
    copiesHtpasswdIntoBoundRuntimeDir: true,
    bindsRuntimeDir: true,
    launchesWithNvidiaGpu: true,
    waitsForPort: true,
    linksThroughNodeProxy: true,
  })
})

test('Apptainer definition builds the same production service contract', async () => {
  const def = await fs.readFile(path.join(rootDir, 'deploy', 'apptainer', 'qni-webgpu.def'), 'utf8')

  assert.deepEqual({
    usesCudaBase: /From: nvidia\/cuda:12\.6\.1-devel-ubuntu22\.04/.test(def),
    usesBashPostSection: /%post -c \/bin\/bash/.test(def),
    pinsQiskitAerTag: /git clone --depth 1 -b 0\.17\.2/.test(def),
    buildsRelativeWebAssets: /trunk build --release --public-url \.\//.test(def),
    installsEntrypoint: /cp deploy\/docker\/docker-entrypoint\.sh \/usr\/local\/bin\/qni-webgpu-entrypoint/.test(def),
    runscriptUsesEntrypoint: /%runscript[\s\S]*exec \/usr\/local\/bin\/qni-webgpu-entrypoint/.test(def),
    locksGpuRunnerInEnvironment: /export QNI_QISKIT_ALLOWED_RUNNERS=qiskit-gpu/.test(def),
  }, {
    usesCudaBase: true,
    usesBashPostSection: true,
    pinsQiskitAerTag: true,
    buildsRelativeWebAssets: true,
    installsEntrypoint: true,
    runscriptUsesEntrypoint: true,
    locksGpuRunnerInEnvironment: true,
  })
})
