
struct PopupParams {
  // Egui callback viewport in CSS pixels.
  viewport_min: vec2<f32>,
  viewport_size: vec2<f32>,
  // Top-left of the row-0 (amplitude) value text, in egui pixels.
  value_anchor: vec2<f32>,
  // Vertical pitch between rows (= ROW_H from state_panel_draw.rs).
  row_pitch: f32,
  // Pad to vec2 alignment.
  _pad_row: f32,
  // (POPUP_GLYPH_CELL_W, POPUP_GLYPH_CELL_H) in egui pixels — the size
  // of one character cell on screen. Same as the atlas cell.
  char_size: vec2<f32>,
  // RGB text colour (premultiplied at write time).
  text_color: vec4<f32>,
  hovered_display_index: u32,
  qubits: u32,
  _pad: vec2<u32>,
};

@group(0) @binding(0) var<storage, read> state: array<vec2<f32>>;
@group(0) @binding(1) var<uniform> params: PopupParams;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var atlas_sampler: sampler;

// --- Atlas / glyph constants (must mirror popup_glyph_atlas.rs) ---
const GLYPH_COUNT: u32 = 20u;
const GLYPH_DIGIT_0: u32 = 0u;
const GLYPH_DOT: u32 = 10u;
const GLYPH_PLUS: u32 = 11u;
const GLYPH_MINUS: u32 = 12u;
const GLYPH_I: u32 = 13u;
const GLYPH_PERCENT: u32 = 14u;
const GLYPH_DEGREE: u32 = 15u;
const GLYPH_BLANK: u32 = 0xFFFFu;

// --- Per-row character counts ---
//   row 0: amplitude   "+r.rrrrr+i.iiiiii" → 17 chars
//   row 1: probability "+ddd.dddd%"        → 10 chars
//   row 2: phase       "+ddd.dd°"          →  8 chars
const ROW_AMP_CHARS:   u32 = 17u;
const ROW_PROB_CHARS:  u32 = 10u;
const ROW_PHASE_CHARS: u32 =  8u;

fn row_char_count(row: u32) -> u32 {
  if (row == 0u) { return ROW_AMP_CHARS; }
  if (row == 1u) { return ROW_PROB_CHARS; }
  return ROW_PHASE_CHARS;
}

// Integer-exact power of 10 in the range exp ∈ [-5, 5]. Used instead
// of WGSL's `pow(10.0, x)` because the latter is implemented via
// log/exp and accumulates enough f32 error that e.g. `pow(10.0, 5.0)`
// rounds to 99999.999... — which then `floor()`s to 99999 and produces
// "+1.09999" instead of "+1.00000" for `digit_at(1.0, -5)`. The values
// 10^1 .. 10^5 are exact integers (representable in f32 ≤ 2²³), so the
// table picks them up precisely; 10^-1 .. 10^-5 still aren't binary
// fractions, but the residual error is below the round-to-half
// threshold for the digit ranges we display.
fn pow10_table(exp: i32) -> f32 {
  switch (exp) {
    case 5: { return 100000.0; }
    case 4: { return 10000.0; }
    case 3: { return 1000.0; }
    case 2: { return 100.0; }
    case 1: { return 10.0; }
    case 0: { return 1.0; }
    case -1: { return 0.1; }
    case -2: { return 0.01; }
    case -3: { return 0.001; }
    case -4: { return 0.0001; }
    case -5: { return 0.00001; }
    default: { return 1.0; }
  }
}

// Returns the decimal digit of `value` at place 10^exp.
//   digit_at(50.0, 0) → 0   (units)
//   digit_at(50.0, 1) → 5   (tens)
//   digit_at(50.0, -1) → 0  (tenths)
// Implemented as integer division / multiplication so that whole-number
// values like 1.0 yield exact digits (no `0.99999` underflow).
fn digit_at(value: f32, exp: i32) -> u32 {
  var scaled: f32;
  if (exp >= 0) {
    scaled = value / pow10_table(exp);
  } else {
    scaled = value * pow10_table(-exp);
  }
  return u32(floor(scaled)) % 10u;
}

// Round `value` to `frac_digits` decimal places. Used before digit
// extraction so the displayed text matches "round-to-nearest" instead
// of "truncate-toward-zero".
fn round_to(value: f32, frac_digits: u32) -> f32 {
  let m = pow10_table(i32(frac_digits));
  return round(value * m) / m;
}

// --- Per-row glyph selectors ---

// Amplitude: "+r.rrrrr+i.iiiii i" — fixed 17 chars, always shows the
// units digit and full 5-decimal mantissa. Sign of imag is always
// printed (matches qni's `+0.00000+0.00000i` style).
fn glyph_amplitude(idx: u32, re_raw: f32, im_raw: f32) -> u32 {
  let re = round_to(re_raw, 5u);
  let im = round_to(im_raw, 5u);
  let re_abs = abs(re);
  let im_abs = abs(im);
  if (idx == 0u) { return select(GLYPH_MINUS, GLYPH_PLUS, re >= 0.0); }
  if (idx == 1u) { return digit_at(re_abs, 0); }
  if (idx == 2u) { return GLYPH_DOT; }
  if (idx <= 7u) {
    let frac_pos = i32(idx) - 2;     // 1..5
    return digit_at(re_abs, -frac_pos);
  }
  if (idx == 8u) { return select(GLYPH_MINUS, GLYPH_PLUS, im >= 0.0); }
  if (idx == 9u) { return digit_at(im_abs, 0); }
  if (idx == 10u) { return GLYPH_DOT; }
  if (idx <= 15u) {
    let frac_pos = i32(idx) - 10;    // 1..5
    return digit_at(im_abs, -frac_pos);
  }
  if (idx == 16u) { return GLYPH_I; }
  return GLYPH_BLANK;
}

// Leading-blank count for a fixed-3-int-digit format: how many leading
// integer cells should be *visually skipped* instead of rendered as a
// padded "0". A value < 10 has 2 blanks (hundreds + tens hidden), 10
// ≤ v < 100 has 1, ≥ 100 has 0. We then shift the on-screen char
// index by this amount so the digits land flush against the sign
// glyph — "+50.0000%" instead of "+  50.0000%".
fn leading_blanks_3int(value_abs: f32) -> u32 {
  if (value_abs >= 100.0) { return 0u; }
  if (value_abs >= 10.0) { return 1u; }
  return 2u;
}

// Probability: "+ddd.dddd%" — value in 0..1 mapped to 0..100%. On-screen
// char `idx` is mapped to the format-string `orig_idx`: idx 0 always
// renders the sign; idx ≥ 1 is shifted past the leading-blank prefix
// so the digits read as left-justified after the sign. Falls through to
// BLANK once we walk past the '%' suffix.
fn glyph_probability(idx: u32, prob_01: f32) -> u32 {
  let prob_pct = round_to(prob_01 * 100.0, 4u);
  let blanks = leading_blanks_3int(prob_pct);
  let orig_idx = select(idx + blanks, 0u, idx == 0u);
  if (orig_idx == 0u) { return GLYPH_PLUS; }
  if (orig_idx <= 3u) { return digit_at(prob_pct, 3 - i32(orig_idx)); }
  if (orig_idx == 4u) { return GLYPH_DOT; }
  if (orig_idx <= 8u) { return digit_at(prob_pct, -(i32(orig_idx) - 4)); }
  if (orig_idx == 9u) { return GLYPH_PERCENT; }
  return GLYPH_BLANK;
}

// Phase: "+ddd.dd°" — degrees in [-180, +180]. Same leading-blank shift
// as probability, but the sign cell can be either '+' or '-'.
fn glyph_phase(idx: u32, phase_deg: f32) -> u32 {
  let phase = round_to(phase_deg, 2u);
  let phase_abs = abs(phase);
  let blanks = leading_blanks_3int(phase_abs);
  let orig_idx = select(idx + blanks, 0u, idx == 0u);
  if (orig_idx == 0u) { return select(GLYPH_MINUS, GLYPH_PLUS, phase >= 0.0); }
  if (orig_idx <= 3u) { return digit_at(phase_abs, 3 - i32(orig_idx)); }
  if (orig_idx == 4u) { return GLYPH_DOT; }
  if (orig_idx <= 6u) { return digit_at(phase_abs, -(i32(orig_idx) - 4)); }
  if (orig_idx == 7u) { return GLYPH_DEGREE; }
  return GLYPH_BLANK;
}

// --- Vertex / fragment ---

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  // Cell-local U in [0, row_char_count]; cell-local V in [0, 1].
  // floor(uv.x) → char index, fract(uv.x) → within-cell U.
  @location(0) cell_uv: vec2<f32>,
  @location(1) @interpolate(flat) row: u32,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> VsOut {
  // Two-triangle quad. Corners: (0,0), (1,0), (0,1), (1,0), (1,1), (0,1).
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 1.0),
  );
  let corner = corners[vi];
  let row = ii;
  let chars = row_char_count(row);
  let row_origin = vec2<f32>(
    params.value_anchor.x,
    params.value_anchor.y + f32(row) * params.row_pitch,
  );
  let row_size = vec2<f32>(
    f32(chars) * params.char_size.x,
    params.char_size.y,
  );
  let world = row_origin + corner * row_size;
  let vp = world - params.viewport_min;
  let ndc = vec2<f32>(
    vp.x / params.viewport_size.x * 2.0 - 1.0,
    1.0 - vp.y / params.viewport_size.y * 2.0,
  );
  var out: VsOut;
  out.clip = vec4<f32>(ndc, 0.0, 1.0);
  out.cell_uv = corner * vec2<f32>(f32(chars), 1.0);
  out.row = row;
  return out;
}

@fragment
fn fs_main(input: VsOut) -> @location(0) vec4<f32> {
  let char_index = u32(floor(input.cell_uv.x));
  let cell_local = vec2<f32>(fract(input.cell_uv.x), input.cell_uv.y);

  // q0=LSB なので hovered_display_index がそのまま state バッファの添字になる
  // （reverseBits 不要。STATE_RENDER_SHADER と同じ規約）。
  let amp = state[params.hovered_display_index];
  let re = amp.x;
  let im = amp.y;
  let prob = clamp(re * re + im * im, 0.0, 1.0);
  let phase_deg = atan2(im, re) * (180.0 / 3.14159265359);

  var glyph: u32 = GLYPH_BLANK;
  if (input.row == 0u) {
    glyph = glyph_amplitude(char_index, re, im);
  } else if (input.row == 1u) {
    glyph = glyph_probability(char_index, prob);
  } else {
    glyph = glyph_phase(char_index, phase_deg);
  }

  if (glyph == GLYPH_BLANK) { discard; }

  // Atlas UV — horizontal strip of GLYPH_COUNT cells, each `cell_local`
  // mapping 0..1 within its cell.
  let atlas_u = (f32(glyph) + cell_local.x) / f32(GLYPH_COUNT);
  let atlas_v = cell_local.y;
  let alpha = textureSample(atlas, atlas_sampler, vec2<f32>(atlas_u, atlas_v)).r;
  if (alpha < 0.001) { discard; }

  return vec4<f32>(params.text_color.rgb * alpha, alpha);
}
