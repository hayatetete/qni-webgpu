
const MAX_OUTCOMES: u32 = 65536u;
const VALUES_PER_SLOT: u32 = MAX_OUTCOMES * 3u;

struct Params {
    base_bit: u32,
    span: u32,
    output_slot: u32,
    state_count: u32,
    control_mask: u32,
    control_value: u32,
    phase_lock_enabled: u32,
    total_qubits: u32,
};

@group(0) @binding(0) var<storage, read> state: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> amplitude_data: array<f32>;
@group(0) @binding(2) var<storage, read_write> amplitude_meta: array<vec4<f32>>;
@group(0) @binding(3) var<uniform> params: Params;

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

fn cmul_conj_raw(raw: vec2<f32>, value: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(raw.x * value.x + raw.y * value.y,
                     raw.x * value.y - raw.y * value.x);
}

fn rotate_minus_theta(v: vec2<f32>, theta: f32) -> vec2<f32> {
    let c = cos(theta);
    let s = sin(theta);
    return vec2<f32>(v.x * c + v.y * s, v.y * c - v.x * s);
}

@compute @workgroup_size(1)
fn main() {
    let outcomes = 1u << params.span;
    let rest_count = params.state_count >> params.span;
    let base = params.output_slot * VALUES_PER_SLOT;
    let ket_base = base;
    let incoherent_base = base + 2u * MAX_OUTCOMES;

    var best_rest = 0u;
    var best_mag = -1.0f;
    var incoherent_unity = 0.0f;

    for (var k = 0u; k < outcomes; k = k + 1u) {
        amplitude_data[ket_base + 2u * k] = 0.0;
        amplitude_data[ket_base + 2u * k + 1u] = 0.0;
        amplitude_data[incoherent_base + k] = 0.0;
    }

    for (var rest = 0u; rest < rest_count; rest = rest + 1u) {
        var slice_mag = 0.0f;
        for (var outcome = 0u; outcome < outcomes; outcome = outcome + 1u) {
            let amp = state_amp(rest, outcome);
            let p = mag2(amp);
            slice_mag = slice_mag + p;
            amplitude_data[incoherent_base + outcome] = amplitude_data[incoherent_base + outcome] + p;
        }
        incoherent_unity = incoherent_unity + slice_mag;
        if (slice_mag > best_mag) {
            best_mag = slice_mag;
            best_rest = rest;
        }
    }

    var unity = 0.0f;
    for (var outcome = 0u; outcome < outcomes; outcome = outcome + 1u) {
        let amp = state_amp(best_rest, outcome);
        amplitude_data[ket_base + 2u * outcome] = amp.x;
        amplitude_data[ket_base + 2u * outcome + 1u] = amp.y;
        unity = unity + mag2(amp);
    }

    var denormalized_quality = 0.0f;
    for (var rest = 0u; rest < rest_count; rest = rest + 1u) {
        var dot_value = vec2<f32>(0.0, 0.0);
        for (var outcome = 0u; outcome < outcomes; outcome = outcome + 1u) {
            let raw = vec2<f32>(
                amplitude_data[ket_base + 2u * outcome],
                amplitude_data[ket_base + 2u * outcome + 1u]
            );
            let amp = state_amp(rest, outcome);
            dot_value = dot_value + cmul_conj_raw(raw, amp);
        }
        denormalized_quality = denormalized_quality + mag2(dot_value);
    }

    var phase_index = -1.0f;
    var theta = 0.0f;
    if (unity > 0.000000000001 && params.phase_lock_enabled == 1u) {
        var strongest = 0.0f;
        var strongest_index = 0u;
        for (var outcome = 0u; outcome < outcomes; outcome = outcome + 1u) {
            let raw = vec2<f32>(
                amplitude_data[ket_base + 2u * outcome],
                amplitude_data[ket_base + 2u * outcome + 1u]
            );
            let p = mag2(raw);
            if (p > strongest * 10000.0) {
                strongest = p;
                strongest_index = outcome;
            }
        }
        if (strongest > 0.00000001) {
            let lock = vec2<f32>(
                amplitude_data[ket_base + 2u * strongest_index],
                amplitude_data[ket_base + 2u * strongest_index + 1u]
            );
            theta = atan2(lock.y, lock.x);
            phase_index = f32(strongest_index);
        }
    }

    let unity_norm = inverseSqrt(max(unity, 0.000000000001));
    let incoherent_norm = inverseSqrt(max(incoherent_unity, 0.000000000001));
    for (var outcome = 0u; outcome < outcomes; outcome = outcome + 1u) {
        var raw = vec2<f32>(
            amplitude_data[ket_base + 2u * outcome],
            amplitude_data[ket_base + 2u * outcome + 1u]
        );
        raw = rotate_minus_theta(raw * unity_norm, theta);
        amplitude_data[ket_base + 2u * outcome] = raw.x;
        amplitude_data[ket_base + 2u * outcome + 1u] = raw.y;
        let incoherent_prob = amplitude_data[incoherent_base + outcome];
        amplitude_data[incoherent_base + outcome] = sqrt(max(incoherent_prob, 0.0)) * incoherent_norm;
    }

    var quality = 0.0f;
    if (unity > 0.000000000001 && incoherent_unity > 0.000000000001) {
        quality = denormalized_quality / (unity * incoherent_unity);
    }
    amplitude_meta[params.output_slot] = vec4<f32>(clamp(quality, 0.0, 1.0), phase_index, f32(params.span), 0.0);
}
