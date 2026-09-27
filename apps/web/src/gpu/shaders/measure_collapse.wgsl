
struct MeasureCollapseParams {
  qubit_bit: u32,
  state_count: u32,
  aux_slot: u32,
  _pad: u32,
};

@group(0) @binding(0) var<storage, read> state_in: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> state_out: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> aux: array<vec4<f32>>;
@group(0) @binding(3) var<uniform> params: MeasureCollapseParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pair: u32 = gid.x;
  let total_pairs: u32 = params.state_count / 2u;
  if (pair >= total_pairs) { return; }
  let bit: u32 = params.qubit_bit;
  let mask: u32 = (1u << bit) - 1u;
  let low: u32 = pair & mask;
  let high: u32 = pair >> bit;
  let i0: u32 = (high << (bit + 1u)) | low;
  let i1: u32 = i0 | (1u << bit);

  let aux_v = aux[params.aux_slot];
  let outcome: f32 = aux_v.z;
  let inv_norm: f32 = 1.0 / aux_v.w;
  let a0 = state_in[i0];
  let a1 = state_in[i1];
  if (outcome < 0.5) {
    state_out[i0] = a0 * inv_norm;
    state_out[i1] = vec2<f32>(0.0, 0.0);
  } else {
    state_out[i0] = vec2<f32>(0.0, 0.0);
    state_out[i1] = a1 * inv_norm;
  }
}
