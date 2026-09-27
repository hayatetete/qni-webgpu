export const kernels = {
  state_compute: {
    uniform: 'GateParams',
    wgsl: 'GateParams',
    bindings: ['stateA:r', 'stateB:rw', 'uniform:u'],
    workgroup: 64,
  },
  measure_reduce: {
    uniform: 'MeasureReduceParams',
    wgsl: 'MeasureReduceParams',
    bindings: ['stateA:r', 'measurement:rw', 'uniform:u'],
    workgroup: 64,
  },
  measure_collapse: {
    uniform: 'MeasureCollapseParams',
    wgsl: 'MeasureCollapseParams',
    bindings: ['stateA:r', 'stateB:rw', 'measurement:r', 'uniform:u'],
    workgroup: 64,
  },
  probability_reduce: {
    uniform: 'ProbabilityReduceParams',
    wgsl: 'ProbabilityReduceParams',
    bindings: ['stateA:r', 'probability:rw', 'uniform:u'],
    workgroup: 64,
  },
  probability_normalize: {
    uniform: 'ProbabilityReduceParams',
    wgsl: 'ProbabilityReduceParams',
    bindings: ['probability:rw', 'uniform:u'],
    workgroup: 64,
  },
  probability_aggregate: {
    uniform: null,
    wgsl: null,
    bindings: ['probability:r', 'aggregate:rw', 'instances:r'],
    workgroup: 64,
  },
  bloch_reduce: {
    uniform: 'BlochParams',
    wgsl: 'BlochParams',
    bindings: ['stateA:r', 'bloch:rw', 'uniform:u'],
    workgroup: 64,
  },
  amplitude_capture: {
    uniform: 'AmplitudeCaptureParams',
    wgsl: 'Params',
    bindings: ['stateA:r', 'amplitude:rw', 'amplitudeMeta:rw', 'uniform:u'],
    workgroup: 1,
  },
  density_capture: {
    uniform: 'DensityCaptureParams',
    wgsl: 'DensityCaptureParams',
    bindings: ['stateA:r', 'density:rw', 'densityMeta:rw', 'uniform:u'],
    workgroup: 64,
  },
} as const
export type Kernel = keyof typeof kernels
export const constants = {
  probability_reduce: { MAX_PROBABILITY_OUTCOMES: 'MAX_PROBABILITY_OUTCOMES' },
  probability_normalize: { MAX_PROBABILITY_OUTCOMES: 'MAX_PROBABILITY_OUTCOMES' },
  probability_aggregate: {
    MAX_PROBABILITY_OUTCOMES: 'MAX_PROBABILITY_OUTCOMES',
    MAX_PROBABILITY_AGGREGATE_ROWS: 'MAX_PROBABILITY_AGGREGATE_ROWS',
    PROBABILITY_AGGREGATE_MIN_SPAN: 'PROBABILITY_AGGREGATE_MIN_SPAN',
    PROBABILITY_RENDER_MODE_SAMPLE: 'PROBABILITY_RENDER_MODE_SAMPLE',
    PROBABILITY_RENDER_MODE_PLACEHOLDER: 'PROBABILITY_RENDER_MODE_PLACEHOLDER',
  },
  amplitude_capture: { MAX_OUTCOMES: 'MAX_AMPLITUDE_OUTCOMES', VALUES_PER_SLOT: 'AMPLITUDE_VALUES_PER_SLOT' },
  density_capture: { MAX_DENSITY_CELLS: 'DENSITY_VALUES_PER_SLOT' },
} as const
export const fingerprints: [string, string][] = [
  ['gpu/recompute/pack.rs', 'let rest_count = (state_count as u32) >> *span;'],
  ['gpu/recompute/pack.rs', 'seed: gate_id.as_u32(),'],
  ['gpu/recompute/pack.rs', 'let total_qubits = usize::BITS - state_count.leading_zeros() - 1;'],
  ['gpu/recompute/pack.rs', 'phase_lock_enabled: u32::from(*span != total_qubits),'],
  ['gpu/recompute/dispatch.rs', 'let dispatch_x = outcomes.min(256);'],
  ['gpu/recompute/dispatch.rs', 'let dispatch_y = outcomes.div_ceil(dispatch_x);'],
  ['gpu/recompute/dispatch.rs', 'pass.dispatch_workgroups(cells.div_ceil(64), 1, 1);'],
  ['gpu/recompute/dispatch.rs', 'self.in_index = 1 - self.in_index;'],
  ['gpu/recompute.rs', 'let dispatch_x = pair_count.div_ceil(STATE_WORKGROUP_SIZE);'],
  ['gpu/recompute/clear.rs', 'Some(state_active_bytes),'],
  ['gpu/recompute/pack.rs', 'packed.measure_collapse.push(MeasureCollapseParams {'],
  ['gpu/recompute/dispatch.rs', 'pass.dispatch_workgroups(self.dispatch_x, 1, 1);'],
  ['gates/params.rs', 'pub(crate) const GATE_MODE_WRITE0: u32 = 1;'],
  ['gates/params.rs', 'pub(crate) const GATE_MODE_WRITE1: u32 = 2;'],
  ['gpu/callbacks/probability_display.rs', '&& instance.span >= PROBABILITY_AGGREGATE_MIN_SPAN'],
  ['gpu/callbacks/probability_display.rs', '(MAX_PROBABILITY_AGGREGATE_ROWS as u32).div_ceil(64),'],
]
