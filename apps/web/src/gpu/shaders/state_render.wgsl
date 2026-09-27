
struct RenderParams {
  // Egui callback viewport in CSS pixels. NDC -1..1 maps to this rect, NOT
  // the full canvas — see BLOCH_OVERLAY_SHADER for the explanation.
  viewport_min: vec2<f32>,
  viewport_size: vec2<f32>,
  // Top-left of the state-circle grid (egui pixels).
  panel_origin: vec2<f32>,
  // Total grid extent (cols * cell_pitch, rows * cell_pitch).
  panel_size: vec2<f32>,
  cell_pitch: f32,
  radius: f32,
  inner_radius: f32,
  stroke: f32,
  cols: u32,
  rows: u32,
  qubits: u32,
  hovered_cell: i32,
  surface: vec4<f32>,
  fill: vec4<f32>,
  disk_border: vec4<f32>,
  outline: vec4<f32>,
  outline_zero: vec4<f32>,
  needle: vec4<f32>,
};

@group(0) @binding(0) var<storage, read> state: array<vec2<f32>>;
@group(0) @binding(1) var<uniform> params: RenderParams;

struct VsIn {
  @location(0) position: vec2<f32>,  // unit quad in -1..1
};

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) panel_local: vec2<f32>,  // 0..panel_size in egui pixels
};

// Single quad covering the entire grid. The fragment shader figures out
// which (col, row) cell each pixel belongs to and draws the corresponding
// state circle. This replaces an N-instance instanced draw (one quad per
// cell) — N == 2^qubits, up to 65 536 — and avoids the per-instance
// dispatch overhead that dominates frame time on contended GPUs.
@vertex
fn vs_main(input: VsIn) -> VsOut {
  // Expand the quad outward by `pad` so the edge cells' stroke + 1 px AA
  // fringe (which sits half_stroke past the cell box, plus an fwidth-worth
  // of edge fade) has somewhere to render. Without this the top / left
  // pixels of the (col=0, row=0) cell get clipped at panel_origin.
  let pad = params.stroke * 0.5 + 1.0;
  let pad_v = vec2<f32>(pad);
  let panel_local =
    (input.position * 0.5 + 0.5) * (params.panel_size + 2.0 * pad_v) - pad_v;
  let world = params.panel_origin + panel_local;
  let viewport_pos = world - params.viewport_min;
  let ndc = vec2<f32>(
    (viewport_pos.x / params.viewport_size.x) * 2.0 - 1.0,
    1.0 - (viewport_pos.y / params.viewport_size.y) * 2.0
  );
  var out: VsOut;
  out.clip = vec4<f32>(ndc, 0.0, 1.0);
  out.panel_local = panel_local;
  return out;
}

// Pre-multiplied colour contribution from a single (col, row) cell at this
// pixel. Returns zero outside everything the cell renders (i.e. outside
// the outline, outside the fill, off the needle). The egui `rect_filled`
// panel surface is drawn underneath in a separate pass, so the cell does
// NOT need to fill its interior with `params.surface`; doing so produced a
// halo of alpha-1 white that occluded neighbouring cells' strokes through
// the 2x2 "over" composite.
//
// `edge` is the pixel-sized fwidth value pre-computed by the caller in
// uniform control flow — must not be re-derived inside this function
// because the 2x2 neighbourhood loop in fs_main already breaks uniform
// flow before reaching here.
fn cell_contribution(col: u32, row: u32, panel_local: vec2<f32>, edge: f32) -> vec4<f32> {
  let cell_origin = vec2<f32>(f32(col), f32(row)) * params.cell_pitch;
  let cell_center = cell_origin + vec2<f32>(params.radius);
  let local = panel_local - cell_center;
  let dist = length(local);
  let half_stroke = params.stroke * 0.5;
  let outer = params.radius + half_stroke;
  if (dist > outer + edge) {
    return vec4<f32>(0.0);
  }
  let display_index = row * params.cols + col;
  // q0=LSB（リトルエンディアン）なので、表示セル |b_{n-1}..b_0⟩ の整数値 display_index が
  // そのまま state バッファの添字になる。内部 state index も q0=bit0 で格納するため reverseBits は不要。
  let amp = state[display_index];
  let prob = clamp(amp.x * amp.x + amp.y * amp.y, 0.0, 1.0);

  // Hover darken — qni's `:host(:hover) #border { filter: brightness(0.9) }`
  // extended to fill + needle + outline in one go. -1 = no hovered cell.
  let hover_mult = select(1.0, 0.9, i32(display_index) == params.hovered_cell);

  // Layer 1: probability fill — solid disc whose radius is √prob × inner_radius.
  let fill_radius = params.inner_radius * sqrt(prob);
  let fill_alpha = 1.0 - smoothstep(fill_radius - edge, fill_radius + edge, dist);
  var color = vec4<f32>(params.fill.rgb * hover_mult * fill_alpha, fill_alpha);
  if (fill_radius >= 1.5) {
    // Match Amplitude / Density Display: blue-400 1px inset rim whose
    // outer edge is clamped to the fill radius, so the probability area
    // does not grow when the darker rim is added.
    let disk_border_radius = fill_radius - 0.5;
    let disk_border_inner = 1.0 - smoothstep(
      disk_border_radius - 0.5 - edge,
      disk_border_radius - 0.5 + edge,
      dist
    );
    let disk_border_outer = 1.0 - smoothstep(
      disk_border_radius + 0.5 - edge,
      disk_border_radius + 0.5 + edge,
      dist
    );
    let disk_border_alpha = min(max(0.0, disk_border_outer - disk_border_inner), fill_alpha);
    let disk_border_pre = vec4<f32>(params.disk_border.rgb * hover_mult * disk_border_alpha, disk_border_alpha);
    color = disk_border_pre + color * (1.0 - disk_border_pre.a);
  }

  // Layer 2: phase needle (only when prob > 0).
  if (prob > 0.0) {
    let phase = atan2(amp.y, amp.x);
    let dir = vec2<f32>(-sin(phase), -cos(phase));
    let t = clamp(dot(local, dir), 0.0, params.inner_radius);
    let closest = dir * t;
    let d = length(local - closest);
    let needle_alpha = 1.0 - smoothstep(half_stroke - edge, half_stroke + edge, d);
    let needle_pre = vec4<f32>(params.needle.rgb * hover_mult * needle_alpha, needle_alpha);
    color = needle_pre + color * (1.0 - needle_pre.a);
  }

  // Layer 3: outline ring at radius=params.radius, width=stroke. AA is
  // symmetric on inner / outer edges (both straddle their nominal radii
  // with `edge` half-width); rounder/cleaner than a one-sided fringe. To
  // avoid the cell-cell gap boundary going to ~50 % alpha, fs_main samples
  // a 2x2 neighbourhood and composes the contributions.
  let outline_rgba = select(params.outline_zero, params.outline, prob > 0.0);
  let outline_inner =
    1.0 - smoothstep(params.radius - half_stroke - edge, params.radius - half_stroke + edge, dist);
  let outline_outer =
    1.0 - smoothstep(params.radius + half_stroke - edge, params.radius + half_stroke + edge, dist);
  let outline_alpha = max(0.0, outline_outer - outline_inner);
  let outline_pre = vec4<f32>(outline_rgba.rgb * hover_mult * outline_alpha, outline_alpha);
  color = outline_pre + color * (1.0 - outline_pre.a);

  return color;
}

@fragment
fn fs_main(input: VsOut) -> @location(0) vec4<f32> {
  // Single-cell sampling: each pixel maps to exactly one (col, row) and
  // evaluates that cell only. The (col, row) lookup is shifted by half a
  // gap so the cell-cell boundary falls at the *centre* of the panel
  // surface seam, not at the start of the next cell's slot. Without the
  // shift, the right-hand cell's left-edge AA fringe would fall inside
  // the left-hand cell's slot and never get drawn; the result is an
  // asymmetric outline with a fading right side and a sharp left side,
  // visible as a "halo" between adjacent circles. With the shift each
  // cell renders its own outer AA on its own side of the gap, producing
  // a symmetric 0.5 / 0.5 pair that reads as a continuous gradient.
  //
  // `edge` is computed once here in uniform control flow and passed down
  // to `cell_contribution`; the per-cell function must not call fwidth
  // itself because the bounds-check below would break uniform flow. Match
  // Amplitude / Density Display's tightened SDF AA width so the state panel
  // circles read with the same sharpness.
  let edge = max(0.5, length(fwidth(input.panel_local)) * 0.65);
  let half_gap = (params.cell_pitch - 2.0 * params.radius) * 0.5;
  let col_f = floor((input.panel_local.x + half_gap) / params.cell_pitch);
  let row_f = floor((input.panel_local.y + half_gap) / params.cell_pitch);
  let col = u32(clamp(col_f, 0.0, f32(params.cols - 1u)));
  let row = u32(clamp(row_f, 0.0, f32(params.rows - 1u)));
  let pre = cell_contribution(col, row, input.panel_local, edge);
  if (pre.a < 0.001) {
    discard;
  }
  return pre;
}
