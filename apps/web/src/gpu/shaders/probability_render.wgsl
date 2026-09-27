
struct ProbabilityRenderParams {
  viewport_min: vec2<f32>,
  viewport_size: vec2<f32>,
  pixels_per_point: f32,
  background: vec4<f32>,
  placeholder_background: vec4<f32>,
  border: vec4<f32>,
  log_hint: vec4<f32>,
  bar: vec4<f32>,
  bar_edge: vec4<f32>,
  hover_border: vec4<f32>,
  text_color: vec4<f32>,
};

@group(0) @binding(0) var<storage, read> probability_data: array<f32>;
@group(0) @binding(1) var<uniform> params: ProbabilityRenderParams;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var atlas_sampler: sampler;
@group(0) @binding(4) var<storage, read> probability_aggregate_data: array<f32>;

const MAX_PROBABILITY_OUTCOMES: u32 = 65536u;
const MAX_PROBABILITY_AGGREGATE_ROWS: u32 = 1024u;
const PROBABILITY_AGGREGATE_MIN_SPAN: u32 = 13u;
const PROBABILITY_RENDER_MODE_SAMPLE: u32 = 0u;
const PROBABILITY_RENDER_MODE_PLACEHOLDER: u32 = 1u;
const GLYPH_COUNT: u32 = 20u;
const GLYPH_DOT: u32 = 10u;
const GLYPH_PERCENT: u32 = 14u;
const GLYPH_BLANK: u32 = 0xFFFFu;
const PROBABILITY_TEXT_CHARS: u32 = 6u;
const PROBABILITY_TEXT_DIGIT_W: f32 = 7.0;
// docs/design-system/probability-display.html §06: Geist Mono dot uses the normal 9px cell
// squeezed by −3px side margins, so it still gets a centre sample column.
const PROBABILITY_TEXT_DOT_W: f32 = 3.0;
const PROBABILITY_TEXT_CHAR_H: f32 = 16.0;

struct VsIn {
  @location(0) corner: vec2<f32>,
  @location(1) rect_min: vec2<f32>,
  @location(2) rect_size: vec2<f32>,
  @location(3) slot: u32,
  @location(4) span: u32,
  @location(5) hovered_outcome: i32,
  @location(6) render_mode: u32,
};

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) rect_size: vec2<f32>,
  @location(2) @interpolate(flat) slot: u32,
  @location(3) @interpolate(flat) span: u32,
  @location(4) @interpolate(flat) hovered_outcome: i32,
  @location(5) @interpolate(flat) render_mode: u32,
  @location(6) @interpolate(flat) rect_min: vec2<f32>,
};

@vertex
fn vs_main(input: VsIn) -> VsOut {
  let local = (input.corner * 0.5 + vec2<f32>(0.5)) * input.rect_size;
  let world = input.rect_min + local;
  let viewport_pos = world - params.viewport_min;
  let ndc = vec2<f32>(
    (viewport_pos.x / params.viewport_size.x) * 2.0 - 1.0,
    1.0 - (viewport_pos.y / params.viewport_size.y) * 2.0,
  );
  var out: VsOut;
  out.clip = vec4<f32>(ndc, 0.0, 1.0);
  out.local = local;
  out.rect_size = input.rect_size;
  out.slot = input.slot;
  out.span = input.span;
  out.hovered_outcome = input.hovered_outcome;
  out.render_mode = input.render_mode;
  out.rect_min = input.rect_min;
  return out;
}

fn over(top: vec4<f32>, bottom: vec4<f32>) -> vec4<f32> {
  return top + bottom * (1.0 - top.a);
}

fn rounded_percent_tenths(prob_01: f32) -> u32 {
  return min(u32(floor(clamp(prob_01, 0.0, 1.0) * 1000.0 + 0.5001)), 1000u);
}

fn glyph_probability_percent(idx: u32, prob_01: f32) -> u32 {
  let tenths = rounded_percent_tenths(prob_01);
  if (idx == 0u) {
    if (tenths < 1000u) { return GLYPH_BLANK; }
    return tenths / 1000u;
  }
  if (idx == 1u) {
    if (tenths < 100u) { return GLYPH_BLANK; }
    return (tenths / 100u) % 10u;
  }
  if (idx == 2u) { return (tenths / 10u) % 10u; }
  if (idx == 3u) { return GLYPH_DOT; }
  if (idx == 4u) { return tenths % 10u; }
  if (idx == 5u) { return GLYPH_PERCENT; }
  return GLYPH_BLANK;
}

fn probability_glyph_width(glyph: u32) -> f32 {
  if (glyph == GLYPH_BLANK) { return 0.0; }
  if (glyph == GLYPH_DOT) { return PROBABILITY_TEXT_DOT_W; }
  return PROBABILITY_TEXT_DIGIT_W;
}

fn probability_text_width(prob_01: f32) -> f32 {
  var width = 0.0;
  for (var idx = 0u; idx < PROBABILITY_TEXT_CHARS; idx = idx + 1u) {
    width = width + probability_glyph_width(glyph_probability_percent(idx, prob_01));
  }
  return width;
}

fn probability_text_color(local: vec2<f32>, rect_size: vec2<f32>, row: u32, row_count: u32, row_h: f32, prob: f32, base: vec4<f32>) -> vec4<f32> {
  // qni-webgpu policy: Probability1..4 only. Probability5 has >8px rows after the
  // 40px migration, but the 12px label is still too dense for 32 outcomes.
  if (row_count > 16u || row_h <= 8.0) { return base; }
  let text_w = probability_text_width(prob);
  let text_left = rect_size.x - 2.0 - text_w;
  let text_top = f32(row) * row_h + (row_h - PROBABILITY_TEXT_CHAR_H) * 0.5;
  let p = local - vec2<f32>(text_left, text_top);
  if (p.x < 0.0 || p.y < 0.0 || p.x >= text_w || p.y >= PROBABILITY_TEXT_CHAR_H) {
    return base;
  }

  var cursor = 0.0;
  for (var idx = 0u; idx < PROBABILITY_TEXT_CHARS; idx = idx + 1u) {
    let glyph = glyph_probability_percent(idx, prob);
    let char_w = probability_glyph_width(glyph);
    if (char_w > 0.0 && p.x >= cursor && p.x < cursor + char_w) {
      let cell_uv = vec2<f32>((p.x - cursor) / char_w, p.y / PROBABILITY_TEXT_CHAR_H);
      let atlas_u = (f32(glyph) + cell_uv.x) / f32(GLYPH_COUNT);
      let alpha = textureSampleLevel(atlas, atlas_sampler, vec2<f32>(atlas_u, cell_uv.y), 0.0).r;
      if (alpha < 0.001) { return base; }
      return over(vec4<f32>(params.text_color.rgb * alpha, alpha), base);
    }
    cursor = cursor + char_w;
  }
  return base;
}

fn probability_prob(slot: u32, row: u32) -> f32 {
  return clamp(probability_data[slot * MAX_PROBABILITY_OUTCOMES + row], 0.0, 1.0);
}

fn probability_log_hint_x(prob: f32, span: u32, width: f32) -> f32 {
  if (prob <= 0.0) { return 0.0; }
  let s = 1.0 / (4.0 + max(8.0, f32(span)));
  return clamp(1.0 + log(prob) * s, 0.0, 1.0) * width;
}

fn probability_aggregate_prob_at_y(slot: u32, y: u32) -> f32 {
  return clamp(probability_aggregate_data[slot * MAX_PROBABILITY_AGGREGATE_ROWS + y], 0.0, 1.0);
}

fn probability_aggregate_y(local_y: f32) -> u32 {
  return u32(clamp(floor(local_y), 0.0, f32(MAX_PROBABILITY_AGGREGATE_ROWS - 1u)));
}

fn probability_aggregate_prob_for_pixel(slot: u32, span: u32, local_y: f32, fallback_prob: f32) -> f32 {
  if (span < PROBABILITY_AGGREGATE_MIN_SPAN) { return fallback_prob; }
  return probability_aggregate_prob_at_y(slot, probability_aggregate_y(local_y));
}

fn pixel_row_top(row: u32, row_h: f32, height: f32) -> f32 {
  return clamp(floor(f32(row) * row_h + 0.5), 0.0, height);
}

fn on_log_hint(local_x: f32, local_y: f32, slot: u32, span: u32, row: u32, row_h: f32, prob: f32, width: f32, height: f32) -> bool {
  // log(0) is undefined: an impossible outcome (prob 0) has no log-scale
  // position, so draw neither its vertical tick nor any connector that touches
  // it. The hint only marks rows that actually carry probability — its purpose
  // is to reveal tiny non-zero differences a linear bar cannot show. Without
  // this guard a full bar (px = width) joined to the empty rows below (px = 0)
  // paints a full-width connector right under the bar.
  if (prob <= 0.0) { return false; }
  let hint_x = probability_log_hint_x(prob, span, width);
  if (abs(local_x - hint_x) < 0.5) { return true; }
  if (span >= PROBABILITY_AGGREGATE_MIN_SPAN) {
    let y = probability_aggregate_y(local_y);
    if (y == 0u) { return false; }
    let prev_prob = probability_aggregate_prob_at_y(slot, y - 1u);
    if (prev_prob <= 0.0) { return false; }
    let prev_x = probability_log_hint_x(prev_prob, span, width);
    return local_x >= min(prev_x, hint_x) && local_x <= max(prev_x, hint_x);
  }
  if (row == 0u) { return false; }
  let row_top = pixel_row_top(row, row_h, height);
  if (local_y < row_top || local_y >= row_top + 1.0) { return false; }
  let prev_prob = probability_prob(slot, row - 1u);
  if (prev_prob <= 0.0) { return false; }
  let prev_x = probability_log_hint_x(prev_prob, span, width);
  return local_x >= min(prev_x, hint_x) && local_x <= max(prev_x, hint_x);
}

fn on_hover_highlight(local: vec2<f32>, rect_size: vec2<f32>, row_h: f32, hovered_outcome: i32) -> bool {
  if (hovered_outcome < 0) { return false; }

  let hover_border_px = 2.0;
  let hovered_row = u32(hovered_outcome);
  let raw_row_top = f32(hovered_row) * row_h;
  let raw_row_bottom = min(raw_row_top + row_h, rect_size.y);
  if (row_h >= hover_border_px * 2.0) {
    // Probability5 rows are 8.25px tall: if the row membership is decided from
    // the interpolated raw row per fragment, one side of the vertical border
    // can claim the row a pixel earlier than the horizontal border. Snap the
    // hover chrome to a single pixel-aligned row box so the purple outline is
    // rectangular even when the probability rows themselves are fractional.
    let row_top = pixel_row_top(hovered_row, row_h, rect_size.y);
    let row_bottom = clamp(floor(raw_row_bottom + 0.5), row_top + 1.0, rect_size.y);
    if (local.y < row_top || local.y >= row_bottom) { return false; }
    let row_y = local.y - row_top;
    let pixel_row_h = row_bottom - row_top;
    return local.x < hover_border_px ||
      local.x >= rect_size.x - hover_border_px ||
      row_y < hover_border_px ||
      row_y >= pixel_row_h - hover_border_px;
  }

  // Quirk uses strokeRect(..., lineWidth=2) for the hovered row. In dense
  // displays the top/bottom strokes merge into one visible band; draw that
  // band explicitly so the selected outcome cannot fall between fragments.
  let half_stroke = hover_border_px * 0.5;
  return local.y >= raw_row_top - half_stroke && local.y <= raw_row_bottom + half_stroke;
}

@fragment
fn fs_main(input: VsOut) -> @location(0) vec4<f32> {
  let row_count = 1u << input.span;
  let row_h = input.rect_size.y / f32(row_count);
  // Decide the outcome row from the fragment's framebuffer pixel centre rather
  // than the interpolated `local.y`. `local.y` is interpolated across the unit
  // quad's two triangles and is not bit-exact at the shared diagonal, so a pixel
  // centre on a `row_h` boundary can floor to different rows on either side of
  // the seam — painting a partial-width bar "nub" one pixel below a full-width
  // bar (e.g. Probability5, row_h = 8.25px). `@builtin(position)` (`input.clip`
  // in the fragment) is the rasteriser's physical pixel centre, identical on
  // both triangles. Invert the world→ndc→framebuffer map to recover the logical
  // row: egui rounds the callback viewport top to whole physical pixels.
  //
  // Two assumptions bound the inversion's exactness (both hold for the reported
  // bug and every reachable circuit; documented so a refactor cannot silently
  // break them):
  //   * `params.viewport_min` is `callback_rect.min`, where `callback_rect` is
  //     the gate rect intersected with the on-screen clip (see circuit_gates.rs).
  //     So `viewport_min.y ∈ [0, screen]` and egui's viewport-top clamp to the
  //     framebuffer is always a no-op here — which is why this shader can omit it.
  //   * `viewport_top_px` reconstructs egui's top via `floor(x + 0.5)` (round half
  //     up). epaint uses Rust `f32::round` (half away from zero); for the
  //     non-negative `x = viewport_min.y * dpr` here the two agree everywhere
  //     except the single tie `x = n.5 − 1 ULP`, reachable only at a fractional
  //     device pixel ratio. There it shifts every row one physical pixel (a
  //     smooth, transient offset — never a seam nub) until the scroll moves off
  //     the tie. `floor(x + 0.5)` is the closest match WGSL offers: native
  //     `round` is half-to-even and disagrees with epaint at every odd half.
  //
  // `row_local_y` then stands in for `local.y` in EVERY vertical row/boundary
  // test below (outcome row, aggregate sample, separators, the outer border, the
  // log hint, and the hover band). Snapping a boundary to a whole pixel only
  // dodges the seam at device-pixel-ratio 1, where pixel centres sit at half
  // integers; at a fractional ratio a physical centre can land exactly on an
  // integer boundary (e.g. ratio 1.25 → logical y = 2.0), so the interpolated
  // `local.y` could still flip across the seam there. Horizontal tests keep the
  // interpolated `local.x` (a sub-ULP horizontal wobble never crosses a discrete
  // row index), and glyph rendering keeps `local` for continuous sampling.
  let dpr = max(params.pixels_per_point, 1.0e-6);
  let viewport_top_px = floor(params.viewport_min.y * dpr + 0.5);
  let row_local_y =
    params.viewport_min.y - input.rect_min.y + (input.clip.y - viewport_top_px) / dpr;
  let raw_row = u32(clamp(floor(row_local_y / max(row_h, 1.0e-6)), 0.0, f32(row_count - 1u)));
  let border_px = 1.0;
  if (input.render_mode == PROBABILITY_RENDER_MODE_PLACEHOLDER) {
    var placeholder_color = params.placeholder_background;
    let on_border =
      input.local.x < border_px ||
      row_local_y < border_px ||
      input.local.x >= input.rect_size.x - border_px ||
      row_local_y >= input.rect_size.y - border_px;
    let separator_y = pixel_row_top(raw_row, row_h, input.rect_size.y);
    let on_separator =
      row_h > border_px * 2.0 &&
      row_count > 1u &&
      raw_row > 0u &&
      row_local_y >= separator_y &&
      row_local_y < separator_y + border_px;
    if (on_border || on_separator) {
      placeholder_color = params.border;
    }
    return placeholder_color;
  }
  let prob = probability_prob(input.slot, raw_row);
  let draw_prob = probability_aggregate_prob_for_pixel(input.slot, input.span, row_local_y, prob);
  let bar_right = draw_prob * input.rect_size.x;
  let show_text = row_count <= 16u && row_h > 8.0;

  var color = params.background;
  if (!show_text && on_log_hint(input.local.x, row_local_y, input.slot, input.span, raw_row, row_h, draw_prob, input.rect_size.x, input.rect_size.y)) {
    color = params.log_hint;
  }
  if (input.local.x <= bar_right) {
    color = params.bar;
  }
  if (draw_prob > 0.0 && draw_prob < 1.0 && abs(input.local.x - bar_right) < 0.5) {
    color = params.bar_edge;
  }

  let on_border =
    input.local.x < border_px ||
    row_local_y < border_px ||
    input.local.x >= input.rect_size.x - border_px ||
    row_local_y >= input.rect_size.y - border_px;
  var on_separator = false;
  let separator_y = pixel_row_top(raw_row, row_h, input.rect_size.y);
  if (row_h > border_px * 2.0 && row_count > 1u && raw_row > 0u && row_local_y >= separator_y && row_local_y < separator_y + border_px) {
    let prev_prob = clamp(probability_data[input.slot * MAX_PROBABILITY_OUTCOMES + raw_row - 1u], 0.0, 1.0);
    let separator_x = max(prev_prob, prob) * input.rect_size.x;
    on_separator = input.local.x >= separator_x;
  }
  if (on_border || on_separator) {
    color = params.border;
  }

  if (on_hover_highlight(vec2<f32>(input.local.x, row_local_y), input.rect_size, row_h, input.hovered_outcome)) {
    color = params.hover_border;
  }

  return probability_text_color(input.local, input.rect_size, raw_row, row_count, row_h, prob, color);
}
