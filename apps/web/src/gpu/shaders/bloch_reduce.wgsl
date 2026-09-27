
struct BlochParams {
  qubit_bit: u32,
  state_count: u32,
  output_slot: u32,
  control_mask: u32,
  control_value: u32,
};

@group(0) @binding(0) var<storage, read> state: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> bloch_out: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: BlochParams;

var<workgroup> shared_rho00: array<f32, 64>;
var<workgroup> shared_rho11: array<f32, 64>;
var<workgroup> shared_rho01_re: array<f32, 64>;
var<workgroup> shared_rho01_im: array<f32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  let tid = lid.x;
  let qubit_mask: u32 = 1u << params.qubit_bit;
  let total: u32 = params.state_count;

  var rho_00: f32 = 0.0;
  var rho_11: f32 = 0.0;
  var rho_01_re: f32 = 0.0;
  var rho_01_im: f32 = 0.0;

  // Each thread handles state indices striding by workgroup size. Only loop
  // over indices whose `qubit_bit` is 0 — the matching index_with_one is
  // looked up directly so we accumulate ρ_01 in the same iteration.
  var i: u32 = tid;
  loop {
    if (i >= total) { break; }
    let bit_is_zero: bool = (i & qubit_mask) == 0u;
    if ((i & params.control_mask) == params.control_value) {
      let amp = state[i];
      let mag2 = amp.x * amp.x + amp.y * amp.y;
      if (bit_is_zero) {
        rho_00 = rho_00 + mag2;
        let j: u32 = i | qubit_mask;
        if ((j & params.control_mask) == params.control_value) {
          let amp_j = state[j];
          // ρ_01 = Σ_rest amp_i · conj(amp_j)
          //   amp_i · conj(amp_j) = (a + bi)(c - di) = (ac + bd) + (bc - ad)i.
          rho_01_re = rho_01_re + (amp.x * amp_j.x + amp.y * amp_j.y);
          rho_01_im = rho_01_im + (amp.y * amp_j.x - amp.x * amp_j.y);
        }
      } else {
        rho_11 = rho_11 + mag2;
      }
    }
    i = i + 64u;
  }

  shared_rho00[tid] = rho_00;
  shared_rho11[tid] = rho_11;
  shared_rho01_re[tid] = rho_01_re;
  shared_rho01_im[tid] = rho_01_im;
  workgroupBarrier();

  // Tree reduction: 64 → 32 → 16 → 8 → 4 → 2 → 1.
  for (var step: u32 = 32u; step > 0u; step = step >> 1u) {
    if (tid < step) {
      shared_rho00[tid] = shared_rho00[tid] + shared_rho00[tid + step];
      shared_rho11[tid] = shared_rho11[tid] + shared_rho11[tid + step];
      shared_rho01_re[tid] = shared_rho01_re[tid] + shared_rho01_re[tid + step];
      shared_rho01_im[tid] = shared_rho01_im[tid] + shared_rho01_im[tid + step];
    }
    workgroupBarrier();
  }

  if (tid == 0u) {
    // qni convention (`packages/simulator/src/matrix.ts`):
    //   x = 2·Re(ρ_01), y = -2·Im(ρ_01), z = ρ_00 - ρ_11.
    // Quirk-style controlled displays first project onto the control slice,
    // then normalize that conditional density matrix.
    let unity = shared_rho00[0] + shared_rho11[0];
    var x: f32 = 0.0;
    var y: f32 = 0.0;
    var z: f32 = 0.0;
    if (unity > 0.000000000001) {
      x =  2.0 * shared_rho01_re[0] / unity;
      y = -2.0 * shared_rho01_im[0] / unity;
      z = (shared_rho00[0] - shared_rho11[0]) / unity;
    }
    bloch_out[params.output_slot] = vec4<f32>(x, y, z, 0.0);
  }
}
