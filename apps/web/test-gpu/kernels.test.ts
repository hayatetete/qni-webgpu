import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openGpu } from './gpu'
import { createRig } from './rig'
import { aggregateInput, aggregateInstances, cases, type RecomputeCase } from './cases'
import * as ref from './reference'
import { compare } from './check'
import { rustConst, wgsl } from './app-source'
const kernels = [
  'state_compute',
  'measure_reduce',
  'measure_collapse',
  'probability_reduce',
  'probability_normalize',
  'probability_aggregate',
  'bloch_reduce',
  'amplitude_capture',
  'density_capture',
] as const
function expected(c: RecomputeCase) {
  let state: ref.C[] =
    c.init === 'ground'
      ? Array.from({ length: 1 << c.qubits }, (_, i) => (i === 0 ? [1, 0] : [0, 0]))
      : c.init.map(([a, b]) => [a, b])
  const outputs: { name: string; slot: number; data: number[]; categorical?: number[] }[] = []
  for (const op of c.ops) {
    const mask = 'controls' in op ? (op.controls?.mask ?? 0) : 0
    const value = 'controls' in op ? (op.controls?.value ?? 0) : 0
    if (mask) {
      const trace = state.reduce((p, a, i) => p + ((i & mask) === value ? ref.mag(a) : 0), 0)
      if (trace > 0 && trace < 1e-2)
        throw Error(`case error ${c.name}: ill-conditioned control trace ${trace}`)
    }
    switch (op.kind) {
      case 'gate': {
        if (op.mode)
          for (let pair = 0; pair < state.length / 2; pair++) {
            const i0 = ((pair >> op.bit) << (op.bit + 1)) | (pair & ((1 << op.bit) - 1))
            if ((i0 & mask) !== value) continue
            const difference = Math.abs(ref.mag(state[i0 | (1 << op.bit)]) - ref.mag(state[i0]))
            if (Math.abs(difference - 1e-6) <= 5e-7)
              throw Error(`case error ${c.name}: Write decision near epsilon at pair ${pair}`)
          }
        state = ref.gate(state, op.bit, op.m, mask, value, op.mode)
        break
      }
      case 'measure': {
        const result = ref.measure(state, op.bit, op.gateId)
        if (Math.abs(result.aux[1] - result.aux[0]) <= 1e-4)
          throw Error(`case error ${c.name}: sample near p0`)
        outputs.push({ name: 'measurement', slot: op.slot, data: result.aux, categorical: [2] })
        break
      }
      case 'collapse': {
        const aux = [...outputs]
          .reverse()
          .find((x) => x.name === 'measurement' && x.slot === op.auxSlot)!.data
        state = state.map((a, i) =>
          ((i >> op.bit) & 1) === aux[2] ? [a[0] / aux[3], a[1] / aux[3]] : [0, 0],
        )
        break
      }
      case 'bloch':
        outputs.push({ name: 'bloch', slot: op.slot, data: [...ref.bloch(state, op.bit, mask, value), 0] })
        break
      case 'probability': {
        const raw = ref.probability(state, op.baseBit, op.span, mask, value)
        outputs.push({ name: 'probabilityRaw', slot: op.slot, data: raw })
        outputs.push({ name: 'probability', slot: op.slot, data: ref.normalize(raw) })
        break
      }
      case 'amplitude': {
        const slices = Array.from({ length: state.length >> op.span }, (_, rest) => ({
          rest,
          mag: Array.from({ length: 1 << op.span }, (_, outcome) => {
            const index = ref.insert(rest, outcome, op.baseBit, op.span)
            return (index & mask) === value ? ref.mag(state[index]) : 0
          }).reduce((a, b) => a + b, 0),
        })).sort((a, b) => b.mag - a.mag)
        if (
          slices.length > 1 &&
          slices[0].mag > 1e-12 &&
          (slices[0].mag - slices[1].mag) / slices[0].mag < 1e-4
        )
          throw Error(`case error ${c.name}: ambiguous amplitude slice`)
        if (op.span !== c.qubits) {
          const best = slices[0].rest
          let strongest = 0
          for (let k = 0; k < 1 << op.span; k++) {
            const i = ref.insert(best, k, op.baseBit, op.span),
              p = (i & mask) === value ? ref.mag(state[i]) : 0
            if (strongest && Math.abs(p - strongest * 10000) < Math.max(p, strongest * 10000) * 1e-3)
              throw Error(`case error ${c.name}: ambiguous phase-lock threshold`)
            if (p > strongest * 10000) strongest = p
          }
          if (strongest && Math.abs(strongest - 1e-8) <= 1e-11)
            throw Error(`case error ${c.name}: phase-lock enable threshold`)
        }
        const a = ref.amplitude(state, op.baseBit, op.span, mask, value, Number(op.span !== c.qubits))
        const data = Array(2 * rustConst('MAX_AMPLITUDE_OUTCOMES') + (1 << op.span)).fill(NaN)
        a.ket.forEach(([re, im], i) => {
          data[2 * i] = re
          data[2 * i + 1] = im
        })
        a.incoherent.forEach((v, i) => {
          data[2 * rustConst('MAX_AMPLITUDE_OUTCOMES') + i] = v
        })
        outputs.push({ name: 'amplitude', slot: op.slot, data })
        outputs.push({ name: 'amplitudeMeta', slot: op.slot, data: a.meta, categorical: [1, 2, 3] })
        break
      }
      case 'density': {
        const d = ref.density(state, op.baseBit, op.span, mask, value)
        outputs.push({ name: 'density', slot: op.slot, data: d.data.flat() })
        outputs.push({
          name: 'densityMeta',
          slot: op.slot,
          data: [d.meta, op.span, 0, 0],
          categorical: [1, 2, 3],
        })
        break
      }
    }
  }
  return { state: state.flat(), outputs }
}
test('real WGSL numeric kernels', async (t) => {
  const { device, assertHealthy } = await openGpu()
  const maxima = Object.fromEntries(kernels.map((key) => [key, 0])) as Record<
    (typeof kernels)[number],
    number
  >
  const counts = Object.fromEntries(kernels.map((key) => [key, 0])) as Record<
    (typeof kernels)[number],
    number
  >
  try {
    const rig = createRig(device)
    const record = (
      key: (typeof kernels)[number],
      name: string,
      output: Parameters<typeof compare>[2],
      values: number[],
      categorical?: number[],
    ) => {
      maxima[key] = Math.max(maxima[key], compare(wgsl(key).path, name, output, values, categorical))
      counts[key]++
    }

    for (const c of cases) {
      await t.test(c.name, async () => {
        const cpu = expected(c)
        const gpu = await rig.recompute(c)
        if (c.ops.some((op) => op.kind === 'gate' || op.kind === 'collapse')) {
          const key = c.ops.some((op) => op.kind === 'collapse') ? 'measure_collapse' : 'state_compute'
          const state = {
            name: 'state',
            slot: 0,
            offset: 0,
            expected: gpu.state.length,
            values: gpu.state,
            bits: new Uint32Array(gpu.state.buffer),
            context: gpu.trace,
          }
          record(key, c.name, state, cpu.state)
        }
        gpu.outputs.forEach((output, index) => {
          const reference = cpu.outputs[index]
          assert.equal(output.name, reference.name)
          const key =
            output.name === 'measurement'
              ? 'measure_reduce'
              : output.name === 'probabilityRaw'
                ? 'probability_reduce'
                : output.name === 'probability'
                  ? 'probability_normalize'
                  : output.name === 'amplitude' || output.name === 'amplitudeMeta'
                    ? 'amplitude_capture'
                    : output.name === 'density' || output.name === 'densityMeta'
                      ? 'density_capture'
                      : output.name === 'bloch'
                        ? 'bloch_reduce'
                        : (output.name as (typeof kernels)[number])
          record(key, c.name, output, reference.data, reference.categorical)
        })
        assertHealthy()
      })
    }

    // Validate every sampled fixture before submitting any aggregate GPU work.
    const references = aggregateInstances.map((instance) =>
      ref.aggregateExpectedRows(instance, aggregateInput),
    )
    const probabilities = [2, 8, 10, 12].map((slot) => ({ slot, data: aggregateInput }))
    const aggregated = await rig.aggregate(aggregateInstances, probabilities)
    for (const [index, instance] of aggregateInstances.entries()) {
      await t.test(`aggregate slot ${instance.slot}`, () => {
        const rows = references[index]
        record(
          'probability_aggregate',
          `instance ${index}`,
          aggregated[index],
          rows,
          rows.map((_, i) => i),
        )
        assertHealthy()
      })
    }
  } finally {
    for (const key of kernels) console.log(`${key}: ${counts[key]} comparisons, max |error| = ${maxima[key]}`)
    device.destroy()
  }
})
