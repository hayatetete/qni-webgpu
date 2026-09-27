import assert from 'node:assert/strict'
import { canaryViolations, type Output } from './rig'
export function compare(
  path: string,
  caseName: string,
  actual: Output,
  expected: number[],
  categorical: number[] = [],
): number {
  const violations = canaryViolations(actual)
  assert.deepEqual(
    violations,
    [],
    `${path} ${caseName} ${actual.context ?? ''} canary: ${violations.join(', ')}`,
  )
  const offset = actual.offset
  assert.ok(
    actual.name === 'amplitude' || expected.length <= actual.expected,
    `${caseName}: expected length exceeds written range`,
  )
  const scale = expected.reduce((m, x) => (Number.isFinite(x) ? Math.max(m, Math.abs(x)) : m), 0)
  const ceiling = actual.name === 'measurement' ? 2e-5 : 1e-5
  const tol = Math.min(ceiling, Math.max(1e-7, 1e-3 * scale))
  let max = 0
  const failures: { i: number; gpu: number; cpu: number; delta: number }[] = []
  expected.forEach((cpu, i) => {
    if (Number.isNaN(cpu)) return
    const gpu = actual.values[offset + i]
    const delta = Math.abs(gpu - cpu)
    max = Math.max(max, delta)
    if (delta > (categorical.includes(i) ? 0 : tol)) failures.push({ i, gpu, cpu, delta })
  })
  assert.equal(
    failures.length,
    0,
    `${path} ${caseName} ${actual.context ?? ''}: max |d|=${max}, tol=${tol}, ${failures.length} over tol; ${JSON.stringify(
      failures
        .sort((a, b) => b.delta - a.delta)
        .slice(0, 8)
        .map((f) => ({ ...f, basis: f.i.toString(2) })),
    )}`,
  )
  return max
}
