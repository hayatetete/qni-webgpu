
struct ProbabilityPopupParams {
  // Egui callback viewport in CSS pixels.
  viewport_min: vec2<f32>,
  viewport_size: vec2<f32>,
  // Top-left of the row-0 (`raw`) value text, in egui pixels.
  value_anchor: vec2<f32>,
  row_pitch: f32,
  _pad_row: f32,
  char_size: vec2<f32>,
  _pad_char: vec2<f32>,
  text_color: vec4<f32>,
  slot: u32,
  outcome: u32,
  _pad: vec2<u32>,
};

@group(0) @binding(0) var<storage, read> probability_data: array<f32>;
@group(0) @binding(1) var<uniform> params: ProbabilityPopupParams;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var atlas_sampler: sampler;

const MAX_PROBABILITY_OUTCOMES: u32 = 65536u;
const GLYPH_COUNT: u32 = 20u;
const GLYPH_DOT: u32 = 10u;
const GLYPH_MINUS: u32 = 12u;
const GLYPH_PERCENT: u32 = 14u;
const GLYPH_D: u32 = 16u;
const GLYPH_B: u32 = 17u;
const GLYPH_INFINITY: u32 = 18u;
const GLYPH_BLANK: u32 = 0xFFFFu;

const VALUE_CHARS: u32 = 12u;  // fixed value column width; raw/log strings are right-aligned

fn row_char_count(_row: u32) -> u32 {
  return VALUE_CHARS;
}

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

fn digit_at(value: f32, exp: i32) -> u32 {
  var scaled: f32;
  if (exp >= 0) {
    scaled = value / pow10_table(exp);
  } else {
    scaled = value * pow10_table(-exp);
  }
  return u32(floor(scaled)) % 10u;
}

fn round_to(value: f32, frac_digits: u32) -> f32 {
  let m = pow10_table(i32(frac_digits));
  return round(value * m) / m;
}

fn int_digit_count_3(value_abs: f32) -> u32 {
  if (value_abs >= 100.0) { return 3u; }
  if (value_abs >= 10.0) { return 2u; }
  return 1u;
}

fn glyph_raw(idx: u32, prob_01: f32) -> u32 {
  // Quirk: 'raw: ' + (p * 100).toFixed(4) + '%'. CSS spec uses
  // margin-left:auto for the value span, so align the formatted text to the
  // right edge of the fixed value column instead of padding after it.
  let pct = round_to(clamp(prob_01, 0.0, 1.0) * 100.0, 4u);
  let int_digits = int_digit_count_3(pct);
  let text_len = int_digits + 6u; // integer + '.' + four decimals + '%'
  let start = VALUE_CHARS - text_len;
  if (idx < start) { return GLYPH_BLANK; }
  let local = idx - start;
  if (local < int_digits) { return digit_at(pct, i32(int_digits - 1u - local)); }
  if (local == int_digits) { return GLYPH_DOT; }
  if (local <= int_digits + 4u) { return digit_at(pct, -i32(local - int_digits)); }
  if (local == int_digits + 5u) { return GLYPH_PERCENT; }
  return GLYPH_BLANK;
}

fn glyph_negative_infinity(idx: u32) -> u32 {
  // Quirk's Math.log10(0).toFixed(1) yields '-Infinity'. In qni-webgpu,
  // render the same mathematical value in compact human-readable form: '-∞ dB'.
  let start = VALUE_CHARS - 5u;
  if (idx < start) { return GLYPH_BLANK; }
  let local = idx - start;
  if (local == 0u) { return GLYPH_MINUS; }
  if (local == 1u) { return GLYPH_INFINITY; }
  if (local == 3u) { return GLYPH_D; }
  if (local == 4u) { return GLYPH_B; }
  return GLYPH_BLANK;
}

fn glyph_log(idx: u32, prob_01: f32) -> u32 {
  // Quirk: 'log: ' + (Math.log10(p) * 10).toFixed(1) + ' dB'. Keep the
  // visible text right-aligned in the same value column as RAW.
  if (prob_01 <= 0.0) { return glyph_negative_infinity(idx); }

  let db = round_to(log(prob_01) * 4.342944819, 1u); // 10 / ln(10)
  let db_abs = abs(db);
  let int_digits = int_digit_count_3(db_abs);
  let sign_chars = select(0u, 1u, db < 0.0);
  let text_len = sign_chars + int_digits + 5u; // sign + integer + '.' + tenth + ' dB'
  let start = VALUE_CHARS - text_len;
  if (idx < start) { return GLYPH_BLANK; }
  var local = idx - start;

  if (db < 0.0) {
    if (local == 0u) { return GLYPH_MINUS; }
    local = local - 1u;
  }
  if (local < int_digits) { return digit_at(db_abs, i32(int_digits - 1u - local)); }
  if (local == int_digits) { return GLYPH_DOT; }
  if (local == int_digits + 1u) { return digit_at(db_abs, -1); }
  if (local == int_digits + 3u) { return GLYPH_D; }
  if (local == int_digits + 4u) { return GLYPH_B; }
  return GLYPH_BLANK;
}

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) cell_uv: vec2<f32>,
  @location(1) @interpolate(flat) row: u32,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> VsOut {
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
  let prob = clamp(probability_data[params.slot * MAX_PROBABILITY_OUTCOMES + params.outcome], 0.0, 1.0);

  var glyph: u32 = GLYPH_BLANK;
  if (input.row == 0u) {
    glyph = glyph_raw(char_index, prob);
  } else {
    glyph = glyph_log(char_index, prob);
  }
  if (glyph == GLYPH_BLANK) { discard; }

  let atlas_u = (f32(glyph) + cell_local.x) / f32(GLYPH_COUNT);
  let alpha = textureSampleLevel(atlas, atlas_sampler, vec2<f32>(atlas_u, cell_local.y), 0.0).r;
  if (alpha < 0.001) { discard; }
  return vec4<f32>(params.text_color.rgb * alpha, alpha);
}
