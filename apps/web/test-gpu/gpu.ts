import { create, globals } from 'webgpu'
export async function openGpu() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 12)) throw Error('webgpu requires Node >= 22.12 (require(esm))')
  Object.assign(globalThis, globals)
  const selector = `adapter=${process.env.QNI_GPU_ADAPTER ?? 'AMD Radeon 8060S Graphics (RADV STRIX_HALO)'}`
  const gpu = create(['backend=vulkan', selector])
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw Error(`No Vulkan GPU adapter for ${selector}`)
  const { vendor, architecture, device: deviceName, description, isFallbackAdapter } = adapter.info
  if (
    isFallbackAdapter !== false ||
    !vendor ||
    /llvmpipe|lavapipe|swiftshader|software/i.test([vendor, deviceName, description].join(' '))
  )
    throw Error(`Not a hardware adapter: ${selector} ${vendor} ${deviceName} ${description}`)
  console.log(
    `GPU adapter: ${selector} | vendor=${vendor} arch=${architecture} device=${deviceName} description=${description}`,
  )
  const device = await adapter.requestDevice()
  let fatal: Error | undefined
  device.addEventListener('uncapturederror', (event: any) => {
    fatal = Error(event.error.message)
  })
  void device.lost.then((info) => {
    fatal = Error(`GPU lost: ${info.message}`)
  })
  // Dawn's ProcessEvents callback requires the instance and adapter to outlive the device.
  const assertHealthy = () => {
    void gpu
    void adapter
    if (fatal) throw fatal
  }
  return { device, assertHealthy }
}
export async function scoped<T>(device: GPUDevice, work: () => Promise<T>): Promise<T> {
  for (const kind of ['validation', 'out-of-memory', 'internal'] as GPUErrorFilter[])
    device.pushErrorScope(kind)
  let value: T | undefined, failure: unknown
  try {
    value = await work()
  } catch (e) {
    failure = e
  }
  const errors = await Promise.all([device.popErrorScope(), device.popErrorScope(), device.popErrorScope()])
  if (failure) throw failure
  for (const error of errors) if (error) throw Error(`GPU ${error.constructor.name}: ${error.message}`)
  return value!
}
