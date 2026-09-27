
struct ProbabilityInstance {
  rect_min: vec2<f32>,
  rect_size: vec2<f32>,
  slot: u32,
  span: u32,
  hovered_outcome: i32,
  render_mode: u32,
};

@group(0) @binding(0) var<storage, read> probability_data: array<f32>;
@group(0) @binding(1) var<storage, read_write> aggregate_out: array<f32>;
@group(0) @binding(2) var<storage, read> instances: array<ProbabilityInstance>;

const MAX_PROBABILITY_OUTCOMES: u32 = 65536u;
const MAX_PROBABILITY_AGGREGATE_ROWS: u32 = 1024u;
const PROBABILITY_AGGREGATE_MIN_SPAN: u32 = 13u;
const PROBABILITY_RENDER_MODE_SAMPLE: u32 = 0u;
const PROBABILITY_RENDER_MODE_PLACEHOLDER: u32 = 1u;

fn probability_prob(slot: u32, row: u32) -> f32 {
  return clamp(probability_data[slot * MAX_PROBABILITY_OUTCOMES + row], 0.0, 1.0);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let y = gid.x;
  if (y >= MAX_PROBABILITY_AGGREGATE_ROWS) { return; }
  let instance = instances[gid.y];
  let out_index = instance.slot * MAX_PROBABILITY_AGGREGATE_ROWS + y;
  let body_h = max(instance.rect_size.y, 1.0);
  if (instance.render_mode == PROBABILITY_RENDER_MODE_PLACEHOLDER) {
    aggregate_out[out_index] = 0.0;
    return;
  }
  if (f32(y) >= body_h) {
    aggregate_out[out_index] = 0.0;
    return;
  }
  if (instance.span < PROBABILITY_AGGREGATE_MIN_SPAN) {
    aggregate_out[out_index] = 0.0;
    return;
  }

  let row_count = 1u << instance.span;
  let row_h = body_h / f32(row_count);
  let y0 = f32(y);
  let y1 = min(y0 + 1.0, body_h);
  let row_lo = u32(clamp(floor(y0 / row_h), 0.0, f32(row_count - 1u)));
  let row_hi = u32(clamp(floor(y1 / row_h), 0.0, f32(row_count - 1u)));
  var p_max = 0.0;
  var row = row_lo;
  loop {
    p_max = max(p_max, probability_prob(instance.slot, row));
    if (row >= row_hi) { break; }
    row = row + 1u;
  }
  aggregate_out[out_index] = p_max;
}
