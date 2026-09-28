// Shader/layout harness, not recompute emulation: per-op uniforms, no pack.rs staging/copy ordering.
// Ground init matches clear.rs; explicit initial states are f32 uploads into A. Rust usages gain COPY_SRC|COPY_DST for canaries/readback.
import { kernels, type Kernel } from './kernels'
import { pack, rustConst, rustStruct, wgsl } from './app-source'
import { scoped } from './gpu'
import type { RecomputeCase } from './cases'
import { globals } from 'webgpu'
const U = (globals as typeof globalThis).GPUBufferUsage
const ShaderStage = (globals as typeof globalThis).GPUShaderStage
const MapMode = (globals as typeof globalThis).GPUMapMode
const CANARY = 0x7fbadbad
const words = (n: number) => {
  const a = new Uint32Array(n)
  a.fill(CANARY)
  return a
}
export type Output = {
  name: string
  slot: number
  offset: number
  expected: number
  values: Float32Array
  bits: Uint32Array
  context?: string
}
type Task = { name: Kernel; params?: ArrayBuffer; groups: number[]; snapshot?: { slot: number; expected: number } }
function slotStride(name: string) {
  return name === 'probability'
    ? rustConst('MAX_PROBABILITY_OUTCOMES') * 4
    : name === 'amplitude'
      ? rustConst('AMPLITUDE_VALUES_PER_SLOT') * 4
      : name === 'density'
        ? rustConst('DENSITY_VALUES_PER_SLOT') * 8
        : name === 'aggregate'
          ? rustConst('MAX_PROBABILITY_AGGREGATE_ROWS') * 4
          : 16
}
export function createRig(device: GPUDevice) {
  const sizes = {
    stateA: rustConst('MAX_STATE_COUNT') * 8,
    stateB: rustConst('MAX_STATE_COUNT') * 8,
    measurement: rustConst('MAX_MEASUREMENT_SLOTS') * 16,
    probability: rustConst('MAX_PROBABILITY_SLOTS') * rustConst('MAX_PROBABILITY_OUTCOMES') * 4,
    aggregate: rustConst('MAX_PROBABILITY_SLOTS') * rustConst('MAX_PROBABILITY_AGGREGATE_ROWS') * 4,
    bloch: rustConst('MAX_BLOCH_SLOTS') * 16,
    amplitude: rustConst('MAX_AMPLITUDE_SLOTS') * rustConst('AMPLITUDE_VALUES_PER_SLOT') * 4,
    amplitudeMeta: rustConst('MAX_AMPLITUDE_SLOTS') * 16,
    density: rustConst('MAX_DENSITY_SLOTS') * rustConst('DENSITY_VALUES_PER_SLOT') * 8,
    densityMeta: rustConst('MAX_DENSITY_SLOTS') * 16,
    instances: rustStruct('ProbabilityInstance').size * rustConst('MAX_PROBABILITY_SLOTS'),
  }
  type BufferName = keyof typeof sizes
  const buffers = Object.fromEntries(
    Object.entries(sizes).map(([key, size]) => [
      key,
      device.createBuffer({ size, usage: U.STORAGE | U.COPY_SRC | U.COPY_DST }),
    ]),
  ) as Record<BufferName, GPUBuffer>
  const canaryBuffer = device.createBuffer({
    size: Math.max(...Object.values(sizes)),
    usage: U.COPY_SRC | U.COPY_DST,
  })
  device.queue.writeBuffer(canaryBuffer, 0, words(canaryBuffer.size / 4))
  const pipelines = new Map<Kernel, { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout }>()
  async function pipeline(name: Kernel) {
    if (pipelines.has(name)) return pipelines.get(name)!
    const spec = kernels[name]
    const shader = wgsl(name)
    const result = await scoped(device, async () => {
      const module = device.createShaderModule({ code: shader.code, label: shader.path })
      const info = await module.getCompilationInfo()
      const messages = info.messages.filter((m) => m.type !== 'info')
      if (messages.length)
        throw Error(messages.map((m) => `${shader.path}:${m.lineNum}:${m.linePos}: ${m.message}`).join('\n'))
      const layout = device.createBindGroupLayout({
        entries: spec.bindings.map((entry, i) => ({
          binding: i,
          visibility: ShaderStage.COMPUTE,
          buffer: {
            type: entry.endsWith(':u') ? 'uniform' : entry.endsWith(':r') ? 'read-only-storage' : 'storage',
          },
        })),
      })
      const pipeline = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: 'main' },
      })
      return { layout, pipeline }
    })
    pipelines.set(name, result)
    return result
  }
  const stride = slotStride
  async function read(name: BufferName, slot: number, expected: number): Promise<Output> {
    const step = stride(name),
      startSlot = Math.max(0, slot - 1),
      endSlot = Math.min(sizes[name] / step, slot + 2)
    const size = (endSlot - startSlot) * step
    const staging = device.createBuffer({ size, usage: U.COPY_DST | U.MAP_READ })
    const enc = device.createCommandEncoder()
    enc.copyBufferToBuffer(buffers[name], startSlot * step, staging, 0, size)
    device.queue.submit([enc.finish()])
    await staging.mapAsync(MapMode.READ)
    const bytes = staging.getMappedRange().slice(0)
    staging.unmap()
    staging.destroy()
    return {
      name,
      slot,
      offset: ((slot - startSlot) * step) / 4,
      expected,
      values: new Float32Array(bytes),
      bits: new Uint32Array(bytes),
    }
  }
  async function execute(
    tasks: Task[],
  ): Promise<Output[]> {
    return scoped(device, async () => {
      const encoder = device.createCommandEncoder()
      const live: GPUBuffer[] = []
      const snapshots: { slot: number; expected: number; buffer: GPUBuffer }[] = []
      for (const task of tasks) {
        if (task.name === 'state_compute' || task.name === 'measure_collapse')
          encoder.copyBufferToBuffer(canaryBuffer, 0, buffers[currentState === 0 ? 'stateB' : 'stateA'], 0, activeStateBytes)
        const { layout, pipeline: compiled } = await pipeline(task.name)
        const spec = kernels[task.name]
        const uniform =
          task.params &&
          device.createBuffer({ size: Math.max(task.params.byteLength, 16), usage: U.UNIFORM | U.COPY_DST })
        if (uniform) device.queue.writeBuffer(uniform, 0, task.params!)
        const entries = spec.bindings.map((binding, i) => ({
          binding: i,
          resource: {
            buffer: binding.endsWith(':u')
              ? uniform!
              : buffers[
                  (binding.split(':')[0] === 'stateA'
                    ? currentState === 0
                      ? 'stateA'
                      : 'stateB'
                    : binding.split(':')[0] === 'stateB'
                      ? currentState === 0
                        ? 'stateB'
                        : 'stateA'
                      : binding.split(':')[0]) as BufferName
                ],
          },
        }))
        const group = device.createBindGroup({ layout, entries })
        if (uniform) live.push(uniform)
        const pass = encoder.beginComputePass()
        pass.setPipeline(compiled)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(task.groups[0], task.groups[1] ?? 1, 1)
        pass.end()
        if (task.snapshot) {
          const buffer = device.createBuffer({ size: stride('probability'), usage: U.COPY_DST | U.MAP_READ })
          encoder.copyBufferToBuffer(
            buffers.probability,
            task.snapshot.slot * stride('probability'),
            buffer,
            0,
            stride('probability'),
          )
          snapshots.push({ ...task.snapshot, buffer })
        }
        if (task.name === 'state_compute' || task.name === 'measure_collapse') currentState = 1 - currentState
      }
      device.queue.submit([encoder.finish()])
      await device.queue.onSubmittedWorkDone()
      for (const resource of live) resource.destroy()
      const results: Output[] = []
      for (const { buffer, slot, expected } of snapshots) {
        await buffer.mapAsync(MapMode.READ)
        const bytes = buffer.getMappedRange().slice(0)
        buffer.unmap()
        buffer.destroy()
        results.push({
          name: 'probabilityRaw',
          slot,
          expected,
          offset: 0,
          values: new Float32Array(bytes),
          bits: new Uint32Array(bytes),
        })
      }
      return results
    })
  }
  let currentState = 0
  let activeStateBytes = 0
  const canary = (names: BufferName[]) => {
    const encoder = device.createCommandEncoder()
    names.forEach((name) => encoder.copyBufferToBuffer(canaryBuffer, 0, buffers[name], 0, sizes[name]))
    device.queue.submit([encoder.finish()])
  }
  async function recompute(c: RecomputeCase) {
    const touched = new Set<BufferName>(['stateB'])
    for (const op of c.ops) {
      if (op.kind === 'measure') touched.add('measurement')
      if (op.kind === 'bloch') touched.add('bloch')
      if (op.kind === 'probability') touched.add('probability')
      if (op.kind === 'amplitude') {
        touched.add('amplitude')
        touched.add('amplitudeMeta')
      }
      if (op.kind === 'density') {
        touched.add('density')
        touched.add('densityMeta')
      }
    }
    canary([...touched])
    currentState = 0
    const n = 1 << c.qubits
    activeStateBytes = n * 8
    const init = new Float32Array(n * 2)
    if (c.init === 'ground') init[0] = 1
    else
      c.init.forEach(([re, im], i) => {
        init[2 * i] = re
        init[2 * i + 1] = im
      })
    device.queue.writeBuffer(buffers.stateA, 0, init)
    const out: Output[] = []
    const allTasks: Task[] = []
    const trace: string[] = []
    for (const op of c.ops) {
      const control = ('controls' in op && op.controls) || { mask: 0, value: 0 }
      let name: Kernel, values: Record<string, number | number[]>
      let groups: number[] = [1]
      switch (op.kind) {
        case 'gate':
          name = 'state_compute'
          values = {
            m00: op.m[0],
            m01: op.m[1],
            m10: op.m[2],
            m11: op.m[3],
            bit: op.bit,
            state_count: n,
            control_mask: control.mask,
            control_value: control.value,
            mode: op.mode ?? 0,
          }
          groups = [Math.ceil(n / 2 / rustConst('STATE_WORKGROUP_SIZE'))]
          break
        case 'measure':
          name = 'measure_reduce'
          values = { qubit_bit: op.bit, state_count: n, output_slot: op.slot, seed: op.gateId }
          break
        case 'collapse':
          name = 'measure_collapse'
          values = { qubit_bit: op.bit, state_count: n, aux_slot: op.auxSlot }
          groups = [Math.ceil(n / 2 / rustConst('STATE_WORKGROUP_SIZE'))]
          break
        case 'bloch':
          name = 'bloch_reduce'
          values = {
            qubit_bit: op.bit,
            state_count: n,
            output_slot: op.slot,
            control_mask: control.mask,
            control_value: control.value,
          }
          break
        case 'probability':
          name = 'probability_reduce'
          values = {
            base_bit: op.baseBit,
            span: op.span,
            rest_count: n >> op.span,
            output_slot: op.slot,
            control_mask: control.mask,
            control_value: control.value,
          }
          groups = [Math.min(1 << op.span, 256), Math.ceil((1 << op.span) / Math.min(1 << op.span, 256))]
          break
        case 'amplitude':
          name = 'amplitude_capture'
          values = {
            base_bit: op.baseBit,
            span: op.span,
            output_slot: op.slot,
            state_count: n,
            control_mask: control.mask,
            control_value: control.value,
            phase_lock_enabled: Number(op.span !== c.qubits),
            total_qubits: c.qubits,
          }
          break
        case 'density':
          name = 'density_capture'
          values = {
            base_bit: op.baseBit,
            span: op.span,
            output_slot: op.slot,
            state_count: n,
            control_mask: control.mask,
            control_value: control.value,
          }
          groups = [Math.ceil((1 << (2 * op.span)) / 64)]
          break
      }
      const params = pack(kernels[name].uniform!, values)
      const tasks: Task[] = [{ name, params, groups }]
      if (op.kind === 'probability') tasks[0].snapshot = { slot: op.slot, expected: 1 << op.span }
      if (name === 'probability_reduce') tasks.push({ name: 'probability_normalize', params, groups: [1] })
      trace.push(`${name} dispatch=${JSON.stringify(groups)} uniform=${Buffer.from(params).toString('hex')}`)
      allTasks.push(...tasks)
    }
    const raw = await execute(allTasks)
    for (const [index, op] of c.ops.entries()) {
      const start = out.length
      if (op.kind === 'measure') out.push(await read('measurement', op.slot, 4))
      if (op.kind === 'bloch') out.push(await read('bloch', op.slot, 4))
      if (op.kind === 'probability') {
        out.push(raw.shift()!)
        out.push(await read('probability', op.slot, 1 << op.span))
      }
      if (op.kind === 'amplitude') {
        out.push(await read('amplitude', op.slot, 1 << op.span))
        out.push(await read('amplitudeMeta', op.slot, 4))
      }
      if (op.kind === 'density') {
        out.push(await read('density', op.slot, 2 * (1 << (2 * op.span))))
        out.push(await read('densityMeta', op.slot, 4))
      }
      for (const output of out.slice(start)) output.context = `op ${index} ${trace[index]}`
    }
    const stateBuffer = currentState === 0 ? buffers.stateA : buffers.stateB
    const stage = device.createBuffer({ size: n * 8, usage: U.COPY_DST | U.MAP_READ })
    const enc = device.createCommandEncoder()
    enc.copyBufferToBuffer(stateBuffer, 0, stage, 0, n * 8)
    device.queue.submit([enc.finish()])
    await stage.mapAsync(MapMode.READ)
    const state = new Float32Array(stage.getMappedRange().slice(0))
    stage.unmap()
    stage.destroy()
    return { state, outputs: out, trace: trace.join('; ') }
  }
  async function aggregate(
    instances: Record<string, number | number[]>[],
    probabilities: { slot: number; data: number[] }[],
  ) {
    canary(['probability', 'aggregate'])
    for (const p of probabilities)
      device.queue.writeBuffer(buffers.probability, p.slot * stride('probability'), new Float32Array(p.data))
    const packed = new Uint8Array(sizes.instances)
    instances.forEach((v, i) =>
      packed.set(new Uint8Array(pack('ProbabilityInstance', v)), i * rustStruct('ProbabilityInstance').size),
    )
    device.queue.writeBuffer(buffers.instances, 0, packed)
    await execute([
      {
        name: 'probability_aggregate',
        groups: [Math.ceil(rustConst('MAX_PROBABILITY_AGGREGATE_ROWS') / 64), instances.length],
      },
    ])
    return Promise.all(
      instances.map((v) => read('aggregate', v.slot as number, rustConst('MAX_PROBABILITY_AGGREGATE_ROWS'))),
    )
  }
  return { recompute, aggregate }
}
export function canaryViolations(o: Output): string[] {
  const strideWords = slotStride(o.name) / 4
  const violations: string[] = []
  const incoherentStart = o.offset + 2 * rustConst('MAX_AMPLITUDE_OUTCOMES')
  for (let i = 0; i < o.bits.length; i++) {
    const valid =
      o.name === 'amplitude'
        ? (i >= o.offset && i < o.offset + 2 * o.expected) ||
          (i >= incoherentStart && i < incoherentStart + o.expected)
        : i >= o.offset && i < o.offset + o.expected
    if (valid ? !Number.isFinite(o.values[i]) : o.bits[i] !== CANARY) {
      if (violations.length < 8)
        violations.push(
          `${o.name} byte ${i * 4} slot ${o.slot + Math.floor((i - o.offset) / strideWords)}: ${valid ? 'nonfinite' : 'canary overwritten'}`,
        )
    }
  }
  return violations
}
