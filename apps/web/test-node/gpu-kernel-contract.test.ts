import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDrift, pack, rustConst } from '../test-gpu/app-source'
import { aggregateInput, aggregateInstances, matrices } from '../test-gpu/cases'
import {
  aggregateExpectedRows,
  amplitude,
  bloch,
  density,
  gate,
  probability,
  rand,
} from '../test-gpu/reference'
test('Rust/WGSL host contract', () => {
  assert.doesNotThrow(checkDrift)
  assert.equal(rustConst('MAX_STATE_COUNT'), 65536)
  assert.equal(
    pack('GateParams', {
      m00: [1, 0],
      m01: [0, 0],
      m10: [0, 0],
      m11: [1, 0],
      bit: 0,
      state_count: 2,
      control_mask: 0,
      control_value: 0,
      mode: 0,
    }).byteLength,
    64,
  )
})
test('aggregate fixtures avoid near-integer sampled row boundaries', () => {
  for (const instance of aggregateInstances) {
    assert.doesNotThrow(() => aggregateExpectedRows(instance, aggregateInput))
  }
  assert.throws(
    () => aggregateExpectedRows({ ...aggregateInstances[4], rect_size: [20, 879.5] }, aggregateInput),
    /case error aggregate slot 10: row 298 near boundary/,
  )
})

test('fixed CPU reference values', () => {
  const plusI: [number, number][] = [
    [Math.SQRT1_2, 0],
    [0, Math.SQRT1_2],
  ]
  for (const [a, b] of bloch(plusI, 0).map((x, i) => [x, [0, 1, 0][i]])) assert.ok(Math.abs(a - b) < 1e-14)
  const h = gate(
    [
      [1, 0],
      [0, 0],
    ],
    0,
    matrices.H,
  )
  probability(h, 0, 1).forEach((p) => assert.ok(Math.abs(p - 0.5) < 1e-14))
  const ghz: [number, number][] = [
    [Math.SQRT1_2, 0],
    [0, 0],
    [0, 0],
    [Math.SQRT1_2, 0],
  ]
  const d = density(ghz, 0, 2)
  assert.ok(Math.abs(d.data[0][0] - 0.5) < 1e-14)
  assert.ok(Math.abs(d.data[3][0] - 0.5) < 1e-14)
  assert.ok(Math.abs(d.data[12][0] - 0.5) < 1e-14)
  assert.ok(Math.abs(d.data[15][0] - 0.5) < 1e-14)
  assert.ok(Math.abs(d.meta - 1) < 1e-14)
  assert.equal(
    amplitude(
      [
        [1, 0],
        [0, 0],
      ],
      0,
      1,
    ).meta[2],
    1,
  )
  const hand = amplitude(
    [[0, Math.SQRT1_2], [Math.SQRT1_2, 0], [0, 0], [0, 0]], 0, 1,
  )
  const expectedKet = [[Math.SQRT1_2, 0], [0, -Math.SQRT1_2]]
  hand.ket.forEach((value, i) => value.forEach((component, j) =>
    assert.ok(Math.abs(component - expectedKet[i][j]) < 1e-14)))
  hand.meta.forEach((value, i) => assert.ok(Math.abs(value - [1, 0, 1, 0][i]) < 1e-14))
  assert.equal(rand(0), 0.3175988495349884)
  assert.equal(rand(1), 0.238451287150383)
  assert.equal(rand(42), 0.42170950770378113)
})
