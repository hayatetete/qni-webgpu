import type { C } from './reference'
export type Control = { mask: number; value: number }
export type Op =
  | { kind: 'gate'; bit: number; m: C[]; mode?: 0 | 1 | 2; controls?: Control }
  | { kind: 'measure'; bit: number; gateId: number; slot: number }
  | { kind: 'collapse'; bit: number; auxSlot: number }
  | { kind: 'bloch'; bit: number; slot: number; controls?: Control }
  | {
      kind: 'probability' | 'amplitude' | 'density'
      baseBit: number
      span: number
      slot: number
      controls?: Control
    }
export type RecomputeCase = { name: string; qubits: number; init: 'ground' | C[]; ops: Op[] }
const s = Math.SQRT1_2
export const matrices: Record<string, C[]> = {
  H: [
    [s, 0],
    [s, 0],
    [s, 0],
    [-s, 0],
  ],
  X: [
    [0, 0],
    [1, 0],
    [1, 0],
    [0, 0],
  ],
  Y: [
    [0, 0],
    [0, -1],
    [0, 1],
    [0, 0],
  ],
  Z: [
    [1, 0],
    [0, 0],
    [0, 0],
    [-1, 0],
  ],
  S: [
    [1, 0],
    [0, 0],
    [0, 0],
    [0, 1],
  ],
  T: [
    [1, 0],
    [0, 0],
    [0, 0],
    [s, s],
  ],
  SqrtX: [
    [0.5, 0.5],
    [0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
  ],
}
export function rotation(axis: 'x' | 'y' | 'z' | 'phase', angle: number): C[] {
  const c = Math.cos(angle / 2),
    s = Math.sin(angle / 2)
  if (axis === 'x')
    return [
      [c, 0],
      [0, -s],
      [0, -s],
      [c, 0],
    ]
  if (axis === 'y')
    return [
      [c, 0],
      [-s, 0],
      [s, 0],
      [c, 0],
    ]
  if (axis === 'z')
    return [
      [c, -s],
      [0, 0],
      [0, 0],
      [c, s],
    ]
  return [
    [1, 0],
    [0, 0],
    [0, 0],
    [Math.cos(angle), Math.sin(angle)],
  ]
}
export function randomState(qubits: number, seed: number): C[] {
  let x = seed >>> 0
  const next = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 4294967296 - 0.5
  }
  const state: C[] = Array.from({ length: 1 << qubits }, () => [next(), next()])
  const norm = Math.sqrt(state.reduce((sum, [a, b]) => sum + a * a + b * b, 0))
  return state.map(([a, b]) => [Math.fround(a / norm), Math.fround(b / norm)])
}
export const gate = (bit: number, m: C[], controls?: Control): Op => ({ kind: 'gate', bit, m, controls })
export const capture = (
  kind: 'probability' | 'amplitude' | 'density',
  baseBit: number,
  span: number,
  slot = 1,
  controls?: Control,
): Op => ({ kind, baseBit, span, slot, controls })
export type AggregateInstance = {
  rect_min: number[]
  rect_size: number[]
  slot: number
  span: number
  hovered_outcome: number
  render_mode: number
}

export const aggregateInstances: AggregateInstance[] = [
  { rect_min: [0, 0], rect_size: [20, 99.5], slot: 2, span: 13, hovered_outcome: -1, render_mode: 0 },
  { rect_min: [0, 0], rect_size: [20, 512], slot: 4, span: 12, hovered_outcome: -1, render_mode: 0 },
  { rect_min: [0, 0], rect_size: [20, 880], slot: 6, span: 16, hovered_outcome: -1, render_mode: 1 },
  { rect_min: [0, 0], rect_size: [20, 512], slot: 8, span: 16, hovered_outcome: -1, render_mode: 0 },
  // 879.5 puts the end of pixel row 298 (y=299) within 1e-3 of a probability-row boundary; 879.512 avoids that ambiguity.
  { rect_min: [0, 0], rect_size: [20, 879.512], slot: 10, span: 13, hovered_outcome: -1, render_mode: 0 },
  { rect_min: [0, 0], rect_size: [20, 1024], slot: 12, span: 16, hovered_outcome: -1, render_mode: 0 },
  { rect_min: [0, 0], rect_size: [20, 0.5], slot: 14, span: 13, hovered_outcome: -1, render_mode: 0 },
]

export const aggregateInput = Array.from({ length: 1 << 16 }, (_, i) =>
  i % 257 === 0 ? 1.3 : i % 131 === 0 ? -0.2 : (i % 100) / 100,
)

export const cases: RecomputeCase[] = [
  ...[
    [1, 'H'],
    [7, 'X'],
    [8, 'Y'],
    [12, 'S'],
    [16, 'T'],
    [4, 'Z'],
    [3, 'SqrtX'],
  ].map(([n, name]) => ({
    name: `${name} n${n}`,
    qubits: Number(n),
    init: 'ground' as const,
    ops: [gate(Number(n) - 1, matrices[String(name)])],
  })),
  ...(['S', 'T', 'Z'] as const).map((name) => ({
    name: `${name} on plus`, qubits: 1,
    init: [[Math.SQRT1_2, 0], [Math.SQRT1_2, 0]] as C[],
    ops: [gate(0, matrices[name])],
  })),
  { name: 'T middle n16 random', qubits: 16, init: randomState(16, 113), ops: [gate(7, matrices.T)] },
  { name: 'multi-workgroup controlled middle', qubits: 12, init: randomState(12, 71),
    ops: [gate(5, matrices.T), gate(9, matrices.H, { mask: 3, value: 1 })] },
  { name: 'write random', qubits: 5, init: randomState(5, 121),
    ops: [{ kind: 'gate', bit: 2, m: matrices.X, mode: 1 }] },
  ...(['x', 'y', 'z', 'phase'] as const).map((axis) => ({
    name: `R${axis}`,
    qubits: 4,
    init: randomState(4, 23),
    ops: [gate(1, rotation(axis, 0.7))],
  })),
  {
    name: 'controlled chain',
    qubits: 4,
    init: randomState(4, 4),
    ops: [
      gate(0, matrices.H, { mask: 2, value: 2 }),
      gate(2, matrices.X, { mask: 1, value: 0 }),
      gate(3, matrices.Y),
    ],
  },
  {
    name: 'Grover diffusion q3',
    qubits: 3,
    init: 'ground',
    ops: [
      ...[0, 1, 2].map((bit) => gate(bit, matrices.H)),
      ...[0, 1, 2].map((bit) => gate(bit, matrices.X)),
      gate(2, matrices.Z, { mask: 3, value: 3 }),
      ...[0, 1, 2].map((bit) => gate(bit, matrices.X)),
      ...[0, 1, 2].map((bit) => gate(bit, matrices.H)),
    ],
  },
  {
    name: 'write0',
    qubits: 4,
    init: 'ground',
    ops: [gate(2, matrices.X), { kind: 'gate', bit: 2, m: matrices.X, mode: 1 }],
  },
  { name: 'write1', qubits: 4, init: 'ground', ops: [{ kind: 'gate', bit: 1, m: matrices.X, mode: 2 }] },
  { name: 'write0 no swap', qubits: 1, init: 'ground', ops: [{ kind: 'gate', bit: 0, m: matrices.X, mode: 1 }] },
  { name: 'write1 no swap', qubits: 1, init: [[0, 0], [1, 0]],
    ops: [{ kind: 'gate', bit: 0, m: matrices.X, mode: 2 }] },
  ...[1, 5, 6, 10].map((qubits) => ({
    name: `measure n${qubits}`,
    qubits,
    init: randomState(qubits, 17),
    ops: [
      { kind: 'measure' as const, bit: 0, gateId: 42, slot: 1 },
      { kind: 'collapse' as const, bit: 0, auxSlot: 1 },
    ],
  })),
  {
    name: 'two measurement slots GHZ',
    qubits: 3,
    init: 'ground',
    ops: [
      gate(0, matrices.H),
      gate(1, matrices.X, { mask: 1, value: 1 }),
      gate(2, matrices.X, { mask: 1, value: 1 }),
      { kind: 'measure', bit: 0, gateId: 9, slot: 1 },
      { kind: 'collapse', bit: 0, auxSlot: 1 },
      { kind: 'measure', bit: 2, gateId: 17, slot: 3 },
      { kind: 'collapse', bit: 2, auxSlot: 3 },
    ],
  },
  {
    name: 'measure p0 zero',
    qubits: 1,
    init: [
      [0, 0],
      [1, 0],
    ],
    ops: [
      { kind: 'measure', bit: 0, gateId: 5, slot: 2 },
      { kind: 'collapse', bit: 0, auxSlot: 2 },
    ],
  },
  {
    name: 'measure p0 one',
    qubits: 1,
    init: 'ground',
    ops: [
      { kind: 'measure', bit: 0, gateId: 5, slot: 2 },
      { kind: 'collapse', bit: 0, auxSlot: 2 },
    ],
  },
  {
    name: 'probability no matching control',
    qubits: 3,
    init: 'ground',
    ops: [capture('probability', 0, 1, 5, { mask: 2, value: 2 })],
  },
  {
    name: 'probability conditional',
    qubits: 4,
    init: randomState(4, 41),
    ops: [capture('probability', 1, 3, 5, { mask: 1, value: 1 })],
  },
  ...[1, 3, 8, 9].map((span) => ({
    name: `probability span${span}`,
    qubits: Math.max(span, 9),
    init: randomState(Math.max(span, 9), 29),
    ops: [capture('probability', 0, span, 2)],
  })),
  ...[0, 1, 3].map((bit) => ({
    name: `bloch bit${bit}`,
    qubits: 4,
    init: randomState(4, 35),
    ops: [{ kind: 'bloch' as const, bit, slot: 3 }],
  })),
  { name: 'bloch stride high slot', qubits: 10, init: randomState(10, 123),
    ops: [{ kind: 'bloch', bit: 5, slot: 63 }] },
  {
    name: 'bloch plus i',
    qubits: 1,
    init: [
      [Math.SQRT1_2, 0],
      [0, Math.SQRT1_2],
    ],
    ops: [{ kind: 'bloch', bit: 0, slot: 5 }],
  },
  {
    name: 'bloch conditional',
    qubits: 4,
    init: randomState(4, 35),
    ops: [{ kind: 'bloch', bit: 2, slot: 5, controls: { mask: 1, value: 0 } }],
  },
  {
    name: 'bloch Bell half',
    qubits: 2,
    init: [
      [Math.SQRT1_2, 0],
      [0, 0],
      [0, 0],
      [Math.SQRT1_2, 0],
    ],
    ops: [{ kind: 'bloch', bit: 0, slot: 7 }],
  },
  {
    name: 'bloch empty slice',
    qubits: 2,
    init: 'ground',
    ops: [{ kind: 'bloch', bit: 0, slot: 7, controls: { mask: 2, value: 2 } }],
  },
  ...[1, 3, 4, 8].map((span) => ({
    name: `density span${span}`,
    qubits: 10,
    init: randomState(10, 53),
    ops: [capture('density', 0, span, 2)],
  })),
  ...[1, 3, 6].map((span) => ({
    name: `amplitude span${span}`,
    qubits: 6,
    init: randomState(6, 67),
    ops: [capture('amplitude', 0, span, 2)],
  })),
  {
    name: 'amplitude conditional',
    qubits: 4,
    init: randomState(4, 91),
    ops: [capture('amplitude', 1, 3, 5, { mask: 1, value: 1 })],
  },
  {
    name: 'density conditional',
    qubits: 5,
    init: randomState(5, 91),
    ops: [capture('density', 1, 3, 5, { mask: 1, value: 1 })],
  },
  {
    name: 'amplitude empty slice',
    qubits: 3,
    init: 'ground',
    ops: [capture('amplitude', 0, 2, 5, { mask: 4, value: 4 })],
  },
  {
    name: 'density empty slice',
    qubits: 4,
    init: 'ground',
    ops: [capture('density', 1, 3, 5, { mask: 1, value: 1 })],
  },
]
