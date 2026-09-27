
struct DigitParams {
  viewport_min: vec2<f32>,
  viewport_size: vec2<f32>,
  zero_color: vec4<f32>,
  one_color: vec4<f32>,
};

@group(0) @binding(0) var<storage, read> aux_data: array<vec4<f32>>;
@group(0) @binding(1) var<uniform> params: DigitParams;
@group(0) @binding(2) var digit_atlas: texture_2d<f32>;
@group(0) @binding(3) var digit_sampler: sampler;

const DIGIT_SDF_PX_RANGE: f32 = DIGIT_SDF_PX_RANGE_PLACEHOLDER;

struct VsIn {
  @location(0) corner: vec2<f32>,
  @location(1) center: vec2<f32>,
  @location(2) half_extent: f32,
  @location(3) slot: u32,
};

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) half_extent: f32,
  @location(2) @interpolate(flat) slot: u32,
};

@vertex
fn vs_main(input: VsIn) -> VsOut {
  let local = input.corner * input.half_extent;
  let world = input.center + local;
  // See BLOCH_OVERLAY_SHADER — NDC maps to the egui callback viewport.
  let viewport_pos = world - params.viewport_min;
  let ndc = vec2<f32>(
    (viewport_pos.x / params.viewport_size.x) * 2.0 - 1.0,
    1.0 - (viewport_pos.y / params.viewport_size.y) * 2.0,
  );
  var out: VsOut;
  out.clip = vec4<f32>(ndc, 0.0, 1.0);
  out.local = local;
  out.half_extent = input.half_extent;
  out.slot = input.slot;
  return out;
}

@fragment
fn fs_main(input: VsOut) -> @location(0) vec4<f32> {
  let aux = aux_data[input.slot];
  let outcome: f32 = aux.z;
  // Map local coords ([-half_extent, +half_extent]^2) into the right cell
  // of a 1x2 atlas (top half = "0", bottom half = "1"). UV.y picks the row.
  let cell_u = (input.local.x / input.half_extent) * 0.5 + 0.5;
  let cell_v = (input.local.y / input.half_extent) * 0.5 + 0.5;
  let row = select(0.0, 1.0, outcome >= 0.5);
  let cell_uv = vec2<f32>(cell_u, cell_v);
  let uv = vec2<f32>(cell_uv.x, (cell_uv.y + row) * 0.5);
  let distance = textureSample(digit_atlas, digit_sampler, uv).r;
  let dims_u = textureDimensions(digit_atlas);
  let dims = vec2<f32>(f32(dims_u.x), f32(dims_u.x));
  let uv_delta = max(fwidth(cell_uv), vec2<f32>(1.0e-6));
  let screen_tex_size = vec2<f32>(1.0) / uv_delta;
  let unit_range = vec2<f32>(DIGIT_SDF_PX_RANGE) / dims;
  let screen_px_range = max(0.5 * dot(unit_range, screen_tex_size), 1.0);
  let screen_px_distance = screen_px_range * (distance - 0.5);
  let alpha = clamp(screen_px_distance + 0.5, 0.0, 1.0);
  if (alpha < 1.0e-3) {
    discard;
  }
  let color = select(params.zero_color.rgb, params.one_color.rgb, outcome >= 0.5);
  return vec4<f32>(color * alpha, alpha);
}
