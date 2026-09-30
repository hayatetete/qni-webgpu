
struct ProbabilityReduceParams {
  base_bit: u32,
  span: u32,
  rest_count: u32,
  output_slot: u32,
  control_mask: u32,
  control_value: u32,
};

@group(0) @binding(0) var<storage, read_write> probability_data: array<f32>;
@group(0) @binding(1) var<uniform> params: ProbabilityReduceParams;

const MAX_PROBABILITY_OUTCOMES: u32 = 65536u;

var<workgroup> shared_sum: array<f32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  let tid = lid.x;
  let outcomes = 1u << params.span;
  let base = params.output_slot * MAX_PROBABILITY_OUTCOMES;
  var unity = 0.0;
  var outcome = tid;
  loop {
    if (outcome >= outcomes) { break; }
    unity = unity + probability_data[base + outcome];
    outcome = outcome + 64u;
  }
  shared_sum[tid] = unity;
  workgroupBarrier();

  for (var step: u32 = 32u; step > 0u; step = step >> 1u) {
    if (tid < step) {
      shared_sum[tid] = shared_sum[tid] + shared_sum[tid + step];
    }
    workgroupBarrier();
  }

  let total = shared_sum[0];
  outcome = tid;
  loop {
    if (outcome >= outcomes) { break; }
    let index = base + outcome;
    probability_data[index] = select(0.0, probability_data[index] / total, total > 0.000000000001);
    outcome = outcome + 64u;
  }
}
