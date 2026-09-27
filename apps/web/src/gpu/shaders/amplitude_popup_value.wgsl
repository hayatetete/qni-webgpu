
const MAX_OUTCOMES: u32 = 65536u;
const VALUES_PER_SLOT: u32 = MAX_OUTCOMES * 3u;
const GLYPH_COUNT: u32 = 20u;
const GLYPH_CELL_W: u32 = 9u;
const GLYPH_CELL_H: u32 = 16u;
const GLYPH_BLANK: u32 = 0xFFFFu;
const ROW_AMP_CHARS: u32 = 17u;
const ROW_PROB_CHARS: u32 = 10u;
const ROW_PHASE_CHARS: u32 = 8u;

struct PopupParams {
    viewport_min: vec2<f32>,
    viewport_size: vec2<f32>,
    value_anchor: vec2<f32>,
    row_pitch: f32,
    _pad_row: f32,
    char_size: vec2<f32>,
    _pad_char: vec2<f32>,
    text_color: vec4<f32>,
    muted_text_color: vec4<f32>,
    slot: u32,
    outcome: u32,
    _pad0: u32,
    _pad1: u32,
};

struct VertexOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) cell_uv: vec2<f32>,
    @location(1) @interpolate(flat) row: u32,
};

@group(0) @binding(0) var<storage, read> amplitude_data: array<f32>;
@group(0) @binding(1) var<storage, read> amplitude_meta: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: PopupParams;
@group(0) @binding(3) var glyph_tex: texture_2d<f32>;
@group(0) @binding(4) var glyph_sampler: sampler;

fn glyph_digit(value: u32) -> u32 { return min(value, 9u); }
fn glyph_dot() -> u32 { return 10u; }
fn glyph_plus() -> u32 { return 11u; }
fn glyph_minus() -> u32 { return 12u; }
fn glyph_i() -> u32 { return 13u; }
fn glyph_percent() -> u32 { return 14u; }
fn glyph_degree() -> u32 { return 15u; }
fn glyph_dash() -> u32 { return 19u; }

fn row_char_count(row: u32) -> u32 {
    if (row == 0u) { return ROW_AMP_CHARS; }
    if (row == 1u) { return ROW_PROB_CHARS; }
    return ROW_PHASE_CHARS;
}

fn digit_from_scaled(value: u32, divisor: u32) -> u32 {
    return (value / divisor) % 10u;
}

fn leading_blanks_3int(int_part: u32) -> u32 {
    if (int_part >= 100u) { return 0u; }
    if (int_part >= 10u) { return 1u; }
    return 2u;
}

fn glyph_amplitude(idx: u32, re: f32, im: f32) -> u32 {
    let re_neg = re < 0.0;
    let im_neg = im < 0.0;
    let re_scaled = u32(round(clamp(abs(re), 0.0, 9.99999) * 100000.0));
    let im_scaled = u32(round(clamp(abs(im), 0.0, 9.99999) * 100000.0));
    switch idx {
        case 0u: { return select(glyph_plus(), glyph_minus(), re_neg); }
        case 1u: { return digit_from_scaled(re_scaled, 100000u); }
        case 2u: { return glyph_dot(); }
        case 3u: { return digit_from_scaled(re_scaled, 10000u); }
        case 4u: { return digit_from_scaled(re_scaled, 1000u); }
        case 5u: { return digit_from_scaled(re_scaled, 100u); }
        case 6u: { return digit_from_scaled(re_scaled, 10u); }
        case 7u: { return digit_from_scaled(re_scaled, 1u); }
        case 8u: { return select(glyph_plus(), glyph_minus(), im_neg); }
        case 9u: { return digit_from_scaled(im_scaled, 100000u); }
        case 10u: { return glyph_dot(); }
        case 11u: { return digit_from_scaled(im_scaled, 10000u); }
        case 12u: { return digit_from_scaled(im_scaled, 1000u); }
        case 13u: { return digit_from_scaled(im_scaled, 100u); }
        case 14u: { return digit_from_scaled(im_scaled, 10u); }
        case 15u: { return digit_from_scaled(im_scaled, 1u); }
        case 16u: { return glyph_i(); }
        default: { return GLYPH_BLANK; }
    }
}

fn glyph_probability(idx: u32, prob_01: f32) -> u32 {
    let scaled = u32(round(clamp(prob_01 * 100.0, 0.0, 999.9999) * 10000.0));
    let blanks = leading_blanks_3int(scaled / 10000u);
    let orig_idx = select(idx + blanks, 0u, idx == 0u);
    switch orig_idx {
        case 0u: { return glyph_plus(); }
        case 1u: { return digit_from_scaled(scaled, 1000000u); }
        case 2u: { return digit_from_scaled(scaled, 100000u); }
        case 3u: { return digit_from_scaled(scaled, 10000u); }
        case 4u: { return glyph_dot(); }
        case 5u: { return digit_from_scaled(scaled, 1000u); }
        case 6u: { return digit_from_scaled(scaled, 100u); }
        case 7u: { return digit_from_scaled(scaled, 10u); }
        case 8u: { return digit_from_scaled(scaled, 1u); }
        case 9u: { return glyph_percent(); }
        default: { return GLYPH_BLANK; }
    }
}

fn glyph_phase(idx: u32, phase_deg: f32) -> u32 {
    let neg = phase_deg < 0.0;
    let scaled = u32(round(clamp(abs(phase_deg), 0.0, 999.99) * 100.0));
    let blanks = leading_blanks_3int(scaled / 100u);
    let orig_idx = select(idx + blanks, 0u, idx == 0u);
    switch orig_idx {
        case 0u: { return select(glyph_plus(), glyph_minus(), neg); }
        case 1u: { return digit_from_scaled(scaled, 10000u); }
        case 2u: { return digit_from_scaled(scaled, 1000u); }
        case 3u: { return digit_from_scaled(scaled, 100u); }
        case 4u: { return glyph_dot(); }
        case 5u: { return digit_from_scaled(scaled, 10u); }
        case 6u: { return digit_from_scaled(scaled, 1u); }
        case 7u: { return glyph_degree(); }
        default: { return GLYPH_BLANK; }
    }
}

fn glyph_dash_only(idx: u32) -> u32 {
    if (idx == 0u) { return glyph_dash(); }
    return GLYPH_BLANK;
}

@vertex
fn vs_main(
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32,
) -> VertexOut {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 1.0)
    );
    let row = instance_index;
    let chars = row_char_count(row);
    let corner = corners[vertex_index];
    let row_origin = vec2<f32>(
        params.value_anchor.x,
        params.value_anchor.y + f32(row) * params.row_pitch
    );
    let row_size = vec2<f32>(f32(chars) * params.char_size.x, params.char_size.y);
    let pixel = row_origin + corner * row_size;
    let ndc = ((pixel - params.viewport_min) / params.viewport_size) * 2.0 - vec2<f32>(1.0, 1.0);
    var out: VertexOut;
    out.pos = vec4<f32>(ndc.x, -ndc.y, 0.0, 1.0);
    out.cell_uv = corner * vec2<f32>(f32(chars), 1.0);
    out.row = row;
    return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    let char_index = u32(floor(in.cell_uv.x));
    let cell_local = vec2<f32>(fract(in.cell_uv.x), in.cell_uv.y);

    let base = params.slot * VALUES_PER_SLOT;
    let amp_meta = amplitude_meta[params.slot];
    let incoherent = amp_meta.x < 0.99;
    var re = amplitude_data[base + 2u * params.outcome];
    var im = amplitude_data[base + 2u * params.outcome + 1u];
    if (incoherent) {
        re = amplitude_data[base + 2u * MAX_OUTCOMES + params.outcome];
        im = 0.0;
    }
    let prob = clamp(re * re + im * im, 0.0, 1.0);
    var phase_deg = atan2(im, re) * 57.29577951308232;
    if (prob <= 0.00000001) {
        phase_deg = 0.0;
    }

    var glyph = GLYPH_BLANK;
    if (incoherent && (in.row == 0u || in.row == 2u)) {
        glyph = glyph_dash_only(char_index);
    } else if (in.row == 0u) {
        glyph = glyph_amplitude(char_index, re, im);
    } else if (in.row == 1u) {
        glyph = glyph_probability(char_index, prob);
    } else {
        glyph = glyph_phase(char_index, phase_deg);
    }
    if (glyph == GLYPH_BLANK) {
        discard;
    }

    let atlas_col = min(u32(floor(cell_local.x * f32(GLYPH_CELL_W))), GLYPH_CELL_W - 1u);
    let atlas_row = min(u32(floor(cell_local.y * f32(GLYPH_CELL_H))), GLYPH_CELL_H - 1u);
    let atlas_x = glyph * GLYPH_CELL_W + atlas_col;
    let sampled_alpha = textureLoad(glyph_tex, vec2<i32>(i32(atlas_x), i32(atlas_row)), 0).r;
    // The atlas already contains glyph-edge antialiasing. Tighten that alpha
    // ramp slightly so small popup numbers stay crisp without becoming jagged.
    let alpha = smoothstep(0.14, 0.86, sampled_alpha);
    if (alpha <= 0.001) {
        discard;
    }
    let color = select(params.text_color, params.muted_text_color, incoherent && (in.row == 0u || in.row == 2u));
    return vec4<f32>(color.rgb, color.a * alpha);
}
