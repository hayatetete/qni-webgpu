
struct BlochPopupParams {
  // Egui callback viewport in CSS pixels.
  viewport_min: vec2<f32>,
  viewport_size: vec2<f32>,
  // Top-left of the first value cell (`r`), in egui pixels.
  value_anchor: vec2<f32>,
  col_pitch: f32,
  row_pitch: f32,
  char_size: vec2<f32>,
  _pad_char: vec2<f32>,
  text_color: vec4<f32>,
  slot: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<storage, read> bloch_data: array<vec4<f32>>;
@group(0) @binding(1) var<uniform> params: BlochPopupParams;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var atlas_sampler: sampler;

const GLYPH_COUNT: u32 = 20u;
const GLYPH_DOT: u32 = 10u;
const GLYPH_PLUS: u32 = 11u;
const GLYPH_MINUS: u32 = 12u;
const GLYPH_DEGREE: u32 = 15u;
const GLYPH_EM_DASH: u32 = 19u;
const GLYPH_BLANK: u32 = 0xFFFFu;

const VALUE_CHARS: u32 = 8u;
const RAD_TO_DEG: f32 = 57.29577951308232;

fn pow10_u(exp: u32) -> u32 {
  switch (exp) {
    case 4u: { return 10000u; }
    case 3u: { return 1000u; }
    case 2u: { return 100u; }
    case 1u: { return 10u; }
    default: { return 1u; }
  }
}

fn rounded_abs_scaled(value: f32, scale: f32) -> u32 {
  return u32(round(abs(value) * scale));
}

fn sign_glyph(value: f32) -> u32 {
  if (value < 0.0) { return GLYPH_MINUS; }
  return GLYPH_PLUS;
}

fn glyph_signed_fixed4(idx: u32, value: f32) -> u32 {
  // forceSign · toFixed(4): +0.0000 through +1.0000 / −1.0000.
  let scaled = rounded_abs_scaled(value, 10000.0);
  if (idx == 0u) { return sign_glyph(value); }
  if (idx == 1u) { return (scaled / 10000u) % 10u; }
  if (idx == 2u) { return GLYPH_DOT; }
  if (idx >= 3u && idx <= 6u) {
    let divisor = pow10_u(6u - idx);
    return (scaled / divisor) % 10u;
  }
  return GLYPH_BLANK;
}

fn angle_digit_count(whole_degrees: u32) -> u32 {
  if (whole_degrees >= 100u) { return 3u; }
  if (whole_degrees >= 10u) { return 2u; }
  return 1u;
}

fn glyph_signed_degrees(idx: u32, degrees: f32) -> u32 {
  // forceSign · toFixed(2) + "°". Left-aligned inside an 8-cell value box.
  let scaled = rounded_abs_scaled(degrees, 100.0);
  let whole = scaled / 100u;
  let frac = scaled - whole * 100u;
  let digits = angle_digit_count(whole);
  if (idx == 0u) { return sign_glyph(degrees); }
  if (idx >= 1u && idx < 1u + digits) {
    let pos = idx - 1u;
    let divisor = pow10_u(digits - 1u - pos);
    return (whole / divisor) % 10u;
  }
  let dot_idx = 1u + digits;
  if (idx == dot_idx) { return GLYPH_DOT; }
  if (idx == dot_idx + 1u) { return (frac / 10u) % 10u; }
  if (idx == dot_idx + 2u) { return frac % 10u; }
  if (idx == dot_idx + 3u) { return GLYPH_DEGREE; }
  return GLYPH_BLANK;
}

fn glyph_dash(idx: u32) -> u32 {
  if (idx == 0u) { return GLYPH_EM_DASH; }
  return GLYPH_BLANK;
}

fn azimuth_degrees(x: f32, y: f32) -> f32 {
  // Manual atan2 equivalent keeps the +X axis at +0.00° across WebGPU
  // backends while staying entirely inside the GPU shader.
  let eps = 1.0e-6;
  if (abs(x) <= eps) {
    if (y > eps) { return 90.0; }
    if (y < -eps) { return -90.0; }
    return 0.0;
  }
  let base = atan(y / x) * RAD_TO_DEG;
  if (x < 0.0) {
    if (y >= 0.0) { return base + 180.0; }
    return base - 180.0;
  }
  return base;
}

fn glyph_for_cell(cell: u32, idx: u32, bloch: vec3<f32>) -> u32 {
  let r = sqrt(dot(bloch, bloch));
  if (cell == 0u) { return glyph_signed_fixed4(idx, r); }
  if (cell == 1u) {
    if (r <= 1.0e-6) { return glyph_dash(idx); }
    return glyph_signed_degrees(idx, azimuth_degrees(bloch.x, bloch.y));
  }
  if (cell == 2u) {
    if (r <= 1.0e-6) { return glyph_dash(idx); }
    let theta = acos(clamp(bloch.z / max(r, 1.0e-6), -1.0, 1.0)) * RAD_TO_DEG;
    return glyph_signed_degrees(idx, theta);
  }
  if (cell == 3u) { return glyph_signed_fixed4(idx, bloch.x); }
  if (cell == 4u) { return glyph_signed_fixed4(idx, bloch.y); }
  if (cell == 5u) { return glyph_signed_fixed4(idx, bloch.z); }
  return GLYPH_BLANK;
}

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) cell_uv: vec2<f32>,
  @location(1) @interpolate(flat) cell: u32,
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
  let row = ii / 3u;
  let col = ii - row * 3u;
  let origin = params.value_anchor + vec2<f32>(
    f32(col) * params.col_pitch,
    f32(row) * params.row_pitch,
  );
  let size = vec2<f32>(f32(VALUE_CHARS) * params.char_size.x, params.char_size.y);
  let world = origin + corner * size;
  let vp = world - params.viewport_min;
  let ndc = vec2<f32>(
    vp.x / params.viewport_size.x * 2.0 - 1.0,
    1.0 - vp.y / params.viewport_size.y * 2.0,
  );
  var out: VsOut;
  out.clip = vec4<f32>(ndc, 0.0, 1.0);
  out.cell_uv = corner * vec2<f32>(f32(VALUE_CHARS), 1.0);
  out.cell = ii;
  return out;
}

@fragment
fn fs_main(input: VsOut) -> @location(0) vec4<f32> {
  let char_index = u32(floor(input.cell_uv.x));
  let cell_local = vec2<f32>(fract(input.cell_uv.x), input.cell_uv.y);
  let bloch = bloch_data[params.slot].xyz;
  let glyph = glyph_for_cell(input.cell, char_index, bloch);
  if (glyph == GLYPH_BLANK) { discard; }

  let atlas_u = (f32(glyph) + cell_local.x) / f32(GLYPH_COUNT);
  let alpha = textureSampleLevel(atlas, atlas_sampler, vec2<f32>(atlas_u, cell_local.y), 0.0).r;
  if (alpha < 0.001) { discard; }
  return vec4<f32>(params.text_color.rgb * alpha, alpha);
}
