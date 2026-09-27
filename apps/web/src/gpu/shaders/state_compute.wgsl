
struct GateParams {
  m00: vec2<f32>,
  m01: vec2<f32>,
  m10: vec2<f32>,
  m11: vec2<f32>,
  bit: u32,
  state_count: u32,
  control_mask: u32,
  control_value: u32,
  mode: u32,
};

@group(0) @binding(0) var<storage, read> state_in: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> state_out: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> params: GateParams;

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pair = gid.x;
  let total_pairs = params.state_count / 2u;
  if (pair >= total_pairs) {
    return;
  }
  let bit = params.bit;
  let mask = (1u << bit) - 1u;
  let low = pair & mask;
  let high = pair >> bit;
  let i0 = (high << (bit + 1u)) | low;
  let i1 = i0 | (1u << bit);
  let a0 = state_in[i0];
  let a1 = state_in[i1];
  if (params.control_mask != 0u) {
    if ((i0 & params.control_mask) != params.control_value) {
      state_out[i0] = a0;
      state_out[i1] = a1;
      return;
    }
  }
  // Write |0> / |1>: per-pair conditional X. Matches qni's CPU semantics —
  // X iff the qubit sits in the opposite basis state, no-op otherwise. For
  // unentangled product states each pair's |a0|/|a1| ratio is consistent,
  // so the local decision agrees with the global one.
  if (params.mode == 1u || params.mode == 2u) {
    let mag0 = a0.x * a0.x + a0.y * a0.y;
    let mag1 = a1.x * a1.x + a1.y * a1.y;
    let eps = 1.0e-6;
    var swap = false;
    if (params.mode == 1u) {
      swap = mag1 > mag0 + eps;
    } else {
      swap = mag0 > mag1 + eps;
    }
    if (swap) {
      state_out[i0] = a1;
      state_out[i1] = a0;
    } else {
      state_out[i0] = a0;
      state_out[i1] = a1;
    }
    return;
  }
  state_out[i0] = cmul(params.m00, a0) + cmul(params.m01, a1);
  state_out[i1] = cmul(params.m10, a0) + cmul(params.m11, a1);
}
