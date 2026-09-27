
struct ProbabilityReduceParams {
  base_bit: u32,
  span: u32,
  rest_count: u32,
  output_slot: u32,
  control_mask: u32,
  control_value: u32,
};

@group(0) @binding(0) var<storage, read> state: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> probability_out: array<f32>;
@group(0) @binding(2) var<uniform> params: ProbabilityReduceParams;

const MAX_PROBABILITY_OUTCOMES: u32 = 65536u;

var<workgroup> shared_sum: array<f32, 64>;

fn insert_outcome(rest: u32, outcome: u32) -> u32 {
  let low_mask = (1u << params.base_bit) - 1u;
  let low = rest & low_mask;
  let high = rest >> params.base_bit;
  return low | (outcome << params.base_bit) | (high << (params.base_bit + params.span));
}

@compute @workgroup_size(64)
fn main(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
) {
  let outcome = wid.x + wid.y * 256u;
  if (outcome >= (1u << params.span)) { return; }
  let tid = lid.x;
  var sum = 0.0;
  var rest = tid;
  loop {
    if (rest >= params.rest_count) { break; }
    let state_index = insert_outcome(rest, outcome);
    if ((state_index & params.control_mask) == params.control_value) {
      let amp = state[state_index];
      sum = sum + amp.x * amp.x + amp.y * amp.y;
    }
    rest = rest + 64u;
  }
  shared_sum[tid] = sum;
  workgroupBarrier();

  for (var step: u32 = 32u; step > 0u; step = step >> 1u) {
    if (tid < step) {
      shared_sum[tid] = shared_sum[tid] + shared_sum[tid + step];
    }
    workgroupBarrier();
  }

  if (tid == 0u) {
    probability_out[params.output_slot * MAX_PROBABILITY_OUTCOMES + outcome] = shared_sum[0];
  }
}
