
const MAX_DENSITY_CELLS: u32 = 65536u;

struct DensityCaptureParams {
    base_bit: u32,
    span: u32,
    output_slot: u32,
    state_count: u32,
    control_mask: u32,
    control_value: u32,
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<storage, read> state: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> density_data: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> density_meta: array<vec4<f32>>;
@group(0) @binding(3) var<uniform> params: DensityCaptureParams;

fn mag2(v: vec2<f32>) -> f32 {
    return dot(v, v);
}

fn insert_outcome(rest: u32, outcome: u32) -> u32 {
    let span_mask = (1u << params.span) - 1u;
    let low_mask = (1u << params.base_bit) - 1u;
    let low = rest & low_mask;
    let high = rest & ~low_mask;
    return (high << params.span) | ((outcome & span_mask) << params.base_bit) | low;
}

fn state_amp(rest: u32, outcome: u32) -> vec2<f32> {
    let idx = insert_outcome(rest, outcome);
    if (idx >= params.state_count) {
        return vec2<f32>(0.0, 0.0);
    }
    if ((idx & params.control_mask) != params.control_value) {
        return vec2<f32>(0.0, 0.0);
    }
    return state[idx];
}

fn amp_times_conj(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dim = 1u << params.span;
    let cell_count = dim * dim;
    let cell = gid.x;
    if (cell >= cell_count) { return; }

    let rest_count = params.state_count >> params.span;
    let row = cell / dim;
    let col = cell - row * dim;
    var sum = vec2<f32>(0.0, 0.0);
    for (var rest = 0u; rest < rest_count; rest = rest + 1u) {
        let amp_row = state_amp(rest, row);
        let amp_col = state_amp(rest, col);
        sum = sum + amp_times_conj(amp_row, amp_col);
    }

    density_data[params.output_slot * MAX_DENSITY_CELLS + cell] = sum;

    // The trace is needed for conditional displays. Store it once per slot;
    // render shaders normalize every cell by this value after the dispatch
    // completes, so there is no intra-dispatch read-after-write dependency.
    if (cell == 0u) {
        var unity = 0.0;
        for (var idx = 0u; idx < params.state_count; idx = idx + 1u) {
            if ((idx & params.control_mask) == params.control_value) {
                let amp = state[idx];
                unity = unity + mag2(amp);
            }
        }
        density_meta[params.output_slot] = vec4<f32>(unity, f32(params.span), 0.0, 0.0);
    }
}
