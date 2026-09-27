import { rustConst } from './app-source'
import type { AggregateInstance } from './cases'

export function aggregateExpectedRows(instance: AggregateInstance, input: number[]): number[] {
  const rows = rustConst('MAX_PROBABILITY_AGGREGATE_ROWS')
  const sample = rustConst('PROBABILITY_RENDER_MODE_SAMPLE')
  const minSpan = rustConst('PROBABILITY_AGGREGATE_MIN_SPAN')
  const body = Math.fround(instance.rect_size[1])
  const rowH = Math.fround(body / (1 << instance.span))

  if (instance.render_mode === sample && instance.span >= minSpan) {
    for (let y = 0; y < rows && y < body; y++) {
      for (const position of [y, Math.min(y + 1, body)]) {
        const ratio = position / rowH
        const gap = Math.abs(ratio - Math.round(ratio))
        // Exact boundaries are safe (and unavoidable for aligned integer-height fixtures).
        if (gap > 0 && gap < 1e-3) {
          throw Error(`case error aggregate slot ${instance.slot}: row ${y} near boundary (${ratio})`)
        }
      }
    }
  }

  return Array.from({ length: rows }, (_, y) => {
    if (instance.render_mode !== sample || instance.span < minSpan || y >= body) return 0
    const end = (1 << instance.span) - 1
    const lo = Math.min(end, Math.max(0, Math.floor(Math.fround(y / rowH))))
    const hi = Math.min(end, Math.max(0, Math.floor(Math.fround(Math.fround(Math.min(y + 1, body)) / rowH))))
    let value = 0
    for (let row = lo; row <= hi; row++) {
      value = Math.max(value, Math.min(1, Math.max(0, Math.fround(input[row]))))
    }
    return value
  })
}

export type C = [number, number]
export const mag = (a: C) => a[0] * a[0] + a[1] * a[1]
export const mul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
export function gate(state: C[], bit: number, m: C[], mask = 0, value = 0, mode = 0): C[] {
  const out = state.map((a) => [...a] as C)
  for (let p = 0; p < state.length / 2; p++) {
    const i0 = ((p >> bit) << (bit + 1)) | (p & ((1 << bit) - 1)),
      i1 = i0 | (1 << bit)
    if ((i0 & mask) !== value) continue
    const a = state[i0],
      b = state[i1]
    if (mode) {
      const swap = mode === 1 ? mag(b) > mag(a) + 1e-6 : mag(a) > mag(b) + 1e-6
      if (swap) {
        out[i0] = b
        out[i1] = a
      }
      continue
    }
    const x = mul(m[0], a),
      y = mul(m[1], b),
      z = mul(m[2], a),
      w = mul(m[3], b)
    out[i0] = [x[0] + y[0], x[1] + y[1]]
    out[i1] = [z[0] + w[0], z[1] + w[1]]
  }
  return out
}
export function rand(seed: number) {
  let s = (Math.imul(seed, 0x9e3779b9) + 0x85ebca6b) >>> 0
  s = (s ^ (s >>> 13)) >>> 0
  s = Math.imul(s, 0xc2b2ae35) >>> 0
  s = (s ^ (s >>> 16)) >>> 0
  return Math.fround(Math.fround(s) / Math.fround(4294967295))
}
export function measure(state: C[], bit: number, seed: number) {
  let p = 0
  for (let i = 0; i < state.length; i++) if ((i & (1 << bit)) === 0) p += mag(state[i])
  const r = rand(seed),
    outcome = +(r > p),
    norm = Math.sqrt(Math.max(outcome ? 1 - p : p, 1e-30))
  return { aux: [p, r, outcome, norm] }
}
export function insert(rest: number, k: number, base: number, span: number) {
  const lowmask = (1 << base) - 1
  return ((rest & ~lowmask) << span) | (k << base) | (rest & lowmask)
}
export function probability(state: C[], base: number, span: number, mask = 0, value = 0) {
  const out = Array(1 << span).fill(0)
  for (let k = 0; k < out.length; k++)
    for (let rest = 0; rest < state.length >> span; rest++) {
      const idx = insert(rest, k, base, span)
      if ((idx & mask) === value) out[k] += mag(state[idx])
    }
  return out
}
export function normalize(p: number[]) {
  const sum = p.reduce((a, b) => a + b, 0)
  return p.map((x) => (sum > 1e-12 ? x / sum : 0))
}
export function density(state: C[], base: number, span: number, mask = 0, value = 0) {
  const dim = 1 << span
  const out: C[] = []
  for (let row = 0; row < dim; row++)
    for (let col = 0; col < dim; col++) {
      let re = 0,
        im = 0
      for (let rest = 0; rest < state.length >> span; rest++) {
        const ri = insert(rest, row, base, span),
          ci = insert(rest, col, base, span)
        const a = (ri & mask) === value ? state[ri] : [0, 0],
          b = (ci & mask) === value ? state[ci] : [0, 0]
        re += a[0] * b[0] + a[1] * b[1]
        im += a[1] * b[0] - a[0] * b[1]
      }
      out.push([re, im])
    }
  return {
    data: out,
    meta: state.reduce((v, a, i) => v + ((i & mask) === value ? mag(a) : 0), 0),
  }
}
export function bloch(state: C[], bit: number, mask = 0, value = 0) {
  let p0 = 0,
    p1 = 0,
    re = 0,
    im = 0
  for (let i = 0; i < state.length; i++)
    if ((i & mask) === value) {
      const a = state[i]
      if ((i & (1 << bit)) === 0) {
        p0 += mag(a)
        const j = i | (1 << bit)
        if ((j & mask) === value) {
          const b = state[j]
          re += a[0] * b[0] + a[1] * b[1]
          im += a[1] * b[0] - a[0] * b[1]
        }
      } else p1 += mag(a)
    }
  const u = p0 + p1
  return u > 1e-12 ? [(2 * re) / u, (-2 * im) / u, (p0 - p1) / u] : [0, 0, 0]
}
export function amplitude(state: C[], base: number, span: number, mask = 0, value = 0, phaseLock = 1) {
  const dim = 1 << span,
    restCount = state.length >> span,
    inc = Array(dim).fill(0)
  const at = (r: number, k: number): C => {
    const i = insert(r, k, base, span)
    return (i & mask) === value ? state[i] : [0, 0]
  }
  let best = 0,
    bestMag = -1,
    incUnity = 0
  for (let r = 0; r < restCount; r++) {
    let slice = 0
    for (let k = 0; k < dim; k++) {
      const p = mag(at(r, k))
      slice += p
      inc[k] += p
    }
    incUnity += slice
    if (slice > bestMag) {
      bestMag = slice
      best = r
    }
  }
  const raw = Array.from({ length: dim }, (_, k) => at(best, k))
  const unity = raw.reduce((s, a) => s + mag(a), 0)
  let qr = 0
  for (let r = 0; r < restCount; r++) {
    let re = 0,
      im = 0
    for (let k = 0; k < dim; k++) {
      const a = raw[k],
        b = at(r, k)
      re += a[0] * b[0] + a[1] * b[1]
      im += a[0] * b[1] - a[1] * b[0]
    }
    qr += re * re + im * im
  }
  let phase = -1,
    theta = 0
  if (unity > 1e-12 && phaseLock) {
    let strongest = 0,
      index = 0
    for (let k = 0; k < dim; k++) {
      const p = mag(raw[k])
      if (p > strongest * 10000) {
        strongest = p
        index = k
      }
    }
    if (strongest > 1e-8) {
      phase = index
      theta = Math.atan2(raw[index][1], raw[index][0])
    }
  }
  const n = 1 / Math.sqrt(Math.max(unity, 1e-12))
  return {
    ket: raw.map(([x, y]) => [
      (x * Math.cos(theta) + y * Math.sin(theta)) * n,
      (y * Math.cos(theta) - x * Math.sin(theta)) * n,
    ]),
    incoherent: inc.map((x) => Math.sqrt(Math.max(x, 0)) / Math.sqrt(Math.max(incUnity, 1e-12))),
    meta: [
      Math.max(0, Math.min(unity > 1e-12 && incUnity > 1e-12 ? qr / (unity * incUnity) : 0, 1)),
      phase,
      span,
      0,
    ],
  }
}
