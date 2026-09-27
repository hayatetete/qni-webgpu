
struct OverlayParams {
  viewport_min: vec2<f32>,
  viewport_size: vec2<f32>,
  line_color: vec4<f32>,
  tip_0_color: vec4<f32>,
  tip_mid_color: vec4<f32>,
  tip_1_color: vec4<f32>,
  tip_outline_color: vec4<f32>,
  zero_color: vec4<f32>,
};

@group(0) @binding(0) var<storage, read> bloch_data: array<vec4<f32>>;
@group(0) @binding(1) var<uniform> params: OverlayParams;

struct VsIn {
  @location(0) corner: vec2<f32>,
  @location(1) center: vec2<f32>,
  @location(2) radius: f32,
  @location(3) outer: f32,
  @location(4) slot: u32,
};

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) radius: f32,
  @location(2) outer: f32,
  @location(3) @interpolate(flat) slot: u32,
};

@vertex
fn vs_main(input: VsIn) -> VsOut {
  let local = input.corner * input.outer;
  let world = input.center + local;
  // egui_wgpu sets the GL viewport to the rect we passed to
  // `Callback::new_paint_callback`, so NDC -1..1 maps to that rect (not the
  // full canvas). World coords already include `rect.min`, so subtract it.
  let viewport_pos = world - params.viewport_min;
  let ndc = vec2<f32>(
    (viewport_pos.x / params.viewport_size.x) * 2.0 - 1.0,
    1.0 - (viewport_pos.y / params.viewport_size.y) * 2.0,
  );
  var out: VsOut;
  out.clip = vec4<f32>(ndc, 0.0, 1.0);
  out.local = local;
  out.radius = input.radius;
  out.outer = input.outer;
  out.slot = input.slot;
  return out;
}

fn bloch_project(b: vec3<f32>) -> vec2<f32> {
  let p = 4.0;
  let px = 1.0;
  let py = -1.0;
  let x_3d: f32 = b.y;
  let y_3d: f32 = -b.z;
  let z_3d: f32 = b.x;
  let factor: f32 = p / (p - z_3d);
  let sx: f32 = px + factor * (x_3d - px);
  let sy: f32 = py + factor * (y_3d - py);
  return vec2<f32>(sx, sy);
}

fn line_distance(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let denom = max(dot(ba, ba), 1.0e-12);
  let t = clamp(dot(pa, ba) / denom, 0.0, 1.0);
  return length(pa - ba * t);
}

@fragment
fn fs_main(input: VsOut) -> @location(0) vec4<f32> {
  let bloch = bloch_data[input.slot].xyz;
  let mag2 = dot(bloch, bloch);
  let mag = sqrt(mag2);
  let proj = bloch_project(bloch);
  let raw_tip = proj * input.radius;
  let raw_tip_len = length(raw_tip);
  let tip = select(
    raw_tip,
    raw_tip * (input.radius / max(raw_tip_len, 1.0e-6)),
    raw_tip_len > input.radius && input.radius > 0.0,
  );

  let line_half: f32 = 0.75;
  let tip_radius: f32 = 4.0;
  let edge: f32 = 0.75;

  let dist_line = line_distance(input.local, vec2<f32>(0.0, 0.0), tip);
  let dist_tip = length(input.local - tip);

  var color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (mag > 1.0e-3) {
    let line_alpha = 1.0 - smoothstep(line_half - edge, line_half + edge, dist_line);
    let line_rgb = params.line_color.rgb;
    color = vec4<f32>(line_rgb * line_alpha, line_alpha);
  }
  if (mag > 1.0e-3) {
    let positive_t = clamp(bloch.z, 0.0, 1.0);
    let negative_t = clamp(-bloch.z, 0.0, 1.0);
    let positive_rgb = mix(params.tip_mid_color.rgb, params.tip_0_color.rgb, positive_t);
    let active_rgb = mix(positive_rgb, params.tip_1_color.rgb, negative_t);

    let tip_alpha = 1.0 - smoothstep(tip_radius - edge, tip_radius + edge, dist_tip);
    color = vec4<f32>(
      color.rgb * (1.0 - tip_alpha) + active_rgb * tip_alpha,
      color.a * (1.0 - tip_alpha) + tip_alpha,
    );

    let outline_half: f32 = 0.5;
    let outline_outer = 1.0 - smoothstep(
      tip_radius + outline_half - edge,
      tip_radius + outline_half + edge,
      dist_tip,
    );
    let outline_inner = 1.0 - smoothstep(
      tip_radius - outline_half - edge,
      tip_radius - outline_half + edge,
      dist_tip,
    );
    let outline_alpha = clamp(outline_outer - outline_inner, 0.0, 1.0);
    color = vec4<f32>(
      color.rgb * (1.0 - outline_alpha) + params.tip_outline_color.rgb * outline_alpha,
      color.a * (1.0 - outline_alpha) + outline_alpha,
    );
  } else {
    let tip_alpha = 1.0 - smoothstep(tip_radius - edge, tip_radius + edge, dist_tip);
    color = vec4<f32>(
      color.rgb * (1.0 - tip_alpha) + params.zero_color.rgb * tip_alpha,
      color.a * (1.0 - tip_alpha) + tip_alpha,
    );

    let outline_half: f32 = 0.5;
    let outline_outer = 1.0 - smoothstep(
      tip_radius + outline_half - edge,
      tip_radius + outline_half + edge,
      dist_tip,
    );
    let outline_inner = 1.0 - smoothstep(
      tip_radius - outline_half - edge,
      tip_radius - outline_half + edge,
      dist_tip,
    );
    let outline_alpha = clamp(outline_outer - outline_inner, 0.0, 1.0);
    color = vec4<f32>(
      color.rgb * (1.0 - outline_alpha) + params.tip_outline_color.rgb * outline_alpha,
      color.a * (1.0 - outline_alpha) + outline_alpha,
    );
  }

  if (color.a < 1.0e-3) {
    discard;
  }
  return color;
}
