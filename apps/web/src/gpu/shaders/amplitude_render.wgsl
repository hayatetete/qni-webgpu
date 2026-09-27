
const MAX_OUTCOMES: u32 = 65536u;
const VALUES_PER_SLOT: u32 = MAX_OUTCOMES * 3u;
const AMPLITUDE_MODE_SAMPLE: u32 = 0u;
const AMPLITUDE_MODE_ZERO: u32 = 1u;
const AMPLITUDE_MODE_PLACEHOLDER: u32 = 2u;

struct RenderParams {
    viewport_min: vec2<f32>,
    viewport_size: vec2<f32>,
    background: vec4<f32>,
    drag_background: vec4<f32>,
    border: vec4<f32>,
    disk: vec4<f32>,
    disk_border: vec4<f32>,
    outline: vec4<f32>,
    outline_zero: vec4<f32>,
    needle: vec4<f32>,
    hover_border: vec4<f32>,
    placeholder_background: vec4<f32>,
};

struct VertexOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) rect_min: vec2<f32>,
    @location(1) rect_size: vec2<f32>,
    @location(2) local: vec2<f32>,
    @location(3) @interpolate(flat) slot: u32,
    @location(4) @interpolate(flat) span: u32,
    @location(5) @interpolate(flat) hovered_outcome: i32,
    @location(6) @interpolate(flat) use_drag_background: u32,
    @location(7) @interpolate(flat) force_zero_amplitude: u32,
};

@group(0) @binding(0) var<storage, read> amplitude_data: array<f32>;
@group(0) @binding(1) var<storage, read> amplitude_meta: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: RenderParams;

fn grid_cols(span: u32) -> u32 {
    let outcomes = 1u << span;
    if (outcomes == 2u) {
        return 2u;
    }
    return 1u << (span / 2u);
}

fn sd_rect(p: vec2<f32>, half_size: vec2<f32>) -> f32 {
    let d = abs(p) - half_size;
    return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0);
}

fn blend_over(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
    let src_pre = vec4<f32>(src.rgb * src.a, src.a);
    return src_pre + dst * (1.0 - src_pre.a);
}

@vertex
fn vs_main(
    @location(0) unit: vec2<f32>,
    @location(1) rect_min: vec2<f32>,
    @location(2) rect_size: vec2<f32>,
    @location(3) slot: u32,
    @location(4) span: u32,
    @location(5) hovered_outcome: i32,
    @location(6) use_drag_background: u32,
    @location(7) force_zero_amplitude: u32,
) -> VertexOut {
    let pixel = rect_min + (unit * 0.5 + vec2<f32>(0.5)) * rect_size;
    let ndc = ((pixel - params.viewport_min) / params.viewport_size) * 2.0 - vec2<f32>(1.0, 1.0);
    var out: VertexOut;
    out.pos = vec4<f32>(ndc.x, -ndc.y, 0.0, 1.0);
    out.rect_min = rect_min;
    out.rect_size = rect_size;
    out.local = pixel - rect_min;
    out.slot = slot;
    out.span = span;
    out.hovered_outcome = hovered_outcome;
    out.use_drag_background = use_drag_background;
    out.force_zero_amplitude = force_zero_amplitude;
    return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    let body_border = 1.0;
    let placeholder = in.force_zero_amplitude == AMPLITUDE_MODE_PLACEHOLDER;
    var color = select(params.background, params.placeholder_background, placeholder);
    if (!placeholder && in.use_drag_background == 1u) {
        color = params.drag_background;
    }
    let aa_edge = length(fwidth(in.local));

    let outer_p = in.local - in.rect_size * 0.5;
    let outer_d = sd_rect(outer_p, in.rect_size * 0.5 - vec2<f32>(0.5));
    if (outer_d > 0.0) {
        discard;
    }
    if (outer_d > -body_border) {
        color = blend_over(color, params.border);
    }

    let cols = grid_cols(in.span);
    let outcomes = 1u << in.span;
    let rows = outcomes / cols;
    let cell = min(in.rect_size.x / f32(cols), in.rect_size.y / f32(rows));
    let grid_size = vec2<f32>(f32(cols) * cell, f32(rows) * cell);
    let grid_origin = (in.rect_size - grid_size) * 0.5;
    let grid_local = in.local - grid_origin;
    if (grid_local.x < 0.0 || grid_local.y < 0.0 || grid_local.x >= grid_size.x || grid_local.y >= grid_size.y) {
        return color;
    }

    let col = u32(clamp(floor(grid_local.x / cell), 0.0, f32(cols - 1u)));
    let row = u32(clamp(floor(grid_local.y / cell), 0.0, f32(rows - 1u)));
    let outcome = row * cols + col;
    let cell_local = grid_local - vec2<f32>(f32(col), f32(row)) * cell;
    let cell_centered = cell_local - vec2<f32>(cell * 0.5);
    let base = in.slot * VALUES_PER_SLOT;
    var incoherent = false;
    var re = 0.0;
    var im = 0.0;
    var mag = 0.0;
    let amp_meta = amplitude_meta[in.slot];
    if (in.force_zero_amplitude == AMPLITUDE_MODE_SAMPLE) {
        incoherent = amp_meta.x < 0.99;
        re = amplitude_data[base + 2u * outcome];
        im = amplitude_data[base + 2u * outcome + 1u];
        mag = sqrt(max(re * re + im * im, 0.0));
        if (incoherent) {
            mag = amplitude_data[base + 2u * MAX_OUTCOMES + outcome];
            re = mag;
            im = 0.0;
        }
    }

    if (placeholder) {
        let stroke = select(1.0, 2.0, cell >= 24.0);
        let half_stroke = stroke * 0.5;
        let outline_clearance = 1.5;
        let outline_radius = max(0.0, cell * 0.5 - half_stroke - outline_clearance);
        let centered_len = length(cell_centered);
        let edge = max(0.5, aa_edge * 0.65);
        let outline_inner = 1.0 - smoothstep(
            outline_radius - half_stroke - edge,
            outline_radius - half_stroke + edge,
            centered_len
        );
        let outline_outer = 1.0 - smoothstep(
            outline_radius + half_stroke - edge,
            outline_radius + half_stroke + edge,
            centered_len
        );
        let outline_alpha = max(0.0, outline_outer - outline_inner);
        if (outline_alpha > 0.001) {
            var outline = params.outline_zero;
            outline.a = outline.a * outline_alpha;
            color = blend_over(color, outline);
        }
        return color;
    }

    if (cell < 3.0) {
        let heat = params.disk * vec4<f32>(1.0, 1.0, 1.0, clamp(mag * mag, 0.0, 1.0));
        color = blend_over(color, heat);
    } else {
        let stroke = select(1.0, 2.0, cell >= 24.0);
        let half_stroke = stroke * 0.5;
        // docs/design-system/amplitude-display.html §05 pseudocode: r_outline =
        // cell_size / 2 - stroke / 2 - clearance. The clearance keeps the
        // circle stroke from touching the rectangular matrix frame.
        let outline_clearance = 1.5;
        let outline_radius = max(0.0, cell * 0.5 - half_stroke - outline_clearance);
        let inner_radius = max(0.0, outline_radius - half_stroke);
        let centered_len = length(cell_centered);
        // Keep derivative-based SDF AA, but tighten the transition for the
        // circuit body so placed Amplitude circles read sharper than the
        // palette icon while still avoiding hard jaggies.
        let edge = max(0.5, aa_edge * 0.65);

        let circle_inner_alpha = 1.0 - smoothstep(
            outline_radius - half_stroke - edge,
            outline_radius - half_stroke + edge,
            centered_len
        );
        if (in.use_drag_background == 1u && circle_inner_alpha > 0.001) {
            var circle_background = params.background;
            circle_background.a = circle_background.a * circle_inner_alpha;
            color = blend_over(color, circle_background);
        }

        if (cell >= 3.0) {
            let outline_inner = circle_inner_alpha;
            let outline_outer = 1.0 - smoothstep(
                outline_radius + half_stroke - edge,
                outline_radius + half_stroke + edge,
                centered_len
            );
            let outline_alpha = max(0.0, outline_outer - outline_inner);
            if (outline_alpha > 0.001) {
                var outline = select(params.outline_zero, params.outline, mag > 0.000001);
                outline.a = outline.a * outline_alpha;
                color = blend_over(color, outline);
            }
        }

        let radius = inner_radius * mag;
        if (radius > 0.3) {
            let disk_alpha = 1.0 - smoothstep(radius - edge, radius + edge, centered_len);
            if (disk_alpha > 0.001) {
                var disk = params.disk;
                disk.a = disk.a * disk_alpha * select(1.0, 0.45, incoherent);
                color = blend_over(color, disk);
            }
            if (radius >= 1.5) {
                // docs/design-system/amplitude-display.html §05: draw the blue-400 disk
                // border as an inset 1px stroke. Its outer edge is clamped to
                // the filled disk radius, so the probability area does not
                // grow when the darker rim is added.
                let disk_border_radius = radius - 0.5;
                let disk_border_inner = 1.0 - smoothstep(
                    disk_border_radius - 0.5 - edge,
                    disk_border_radius - 0.5 + edge,
                    centered_len
                );
                let disk_border_outer = 1.0 - smoothstep(
                    disk_border_radius + 0.5 - edge,
                    disk_border_radius + 0.5 + edge,
                    centered_len
                );
                let disk_border_alpha = min(max(0.0, disk_border_outer - disk_border_inner), disk_alpha);
                if (disk_border_alpha > 0.001) {
                    var disk_border = params.disk_border;
                    disk_border.a = disk_border.a * disk_border_alpha;
                    color = blend_over(color, disk_border);
                }
            }
        }

        if (!incoherent && cell >= 12.0 && mag > 0.001) {
            let angle = atan2(im, re);
            let dir = vec2<f32>(-sin(angle), -cos(angle));
            let along = clamp(dot(cell_centered, dir), 0.0, inner_radius);
            let closest = dir * along;
            let needle_dist = length(cell_centered - closest);
            let needle_alpha = 1.0 - smoothstep(half_stroke - edge, half_stroke + edge, needle_dist);
            if (needle_alpha > 0.001) {
                var needle = params.needle;
                needle.a = needle.a * needle_alpha;
                color = blend_over(color, needle);
            }
        }

        if (in.hovered_outcome == i32(outcome) && cell >= 3.0) {
            let hover_inner = 1.0 - smoothstep(
                outline_radius - half_stroke - edge,
                outline_radius - half_stroke + edge,
                centered_len
            );
            let hover_outer = 1.0 - smoothstep(
                outline_radius + half_stroke - edge,
                outline_radius + half_stroke + edge,
                centered_len
            );
            let hover_alpha = max(0.0, hover_outer - hover_inner);
            if (hover_alpha > 0.001) {
                var hover = params.hover_border;
                hover.a = hover.a * hover_alpha;
                color = blend_over(color, hover);
            }
        }
    }
    return color;
}
