
const MAX_DENSITY_CELLS: u32 = 65536u;
const DENSITY_RENDER_MODE_SAMPLE: u32 = 0u;
const DENSITY_RENDER_MODE_PLACEHOLDER: u32 = 1u;

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
    @location(0) local: vec2<f32>,
    @location(1) rect_size: vec2<f32>,
    @location(2) @interpolate(flat) slot: u32,
    @location(3) @interpolate(flat) span: u32,
    @location(4) @interpolate(flat) hovered_cell: i32,
    @location(5) @interpolate(flat) use_drag_background: u32,
    @location(6) @interpolate(flat) render_mode: u32,
};

@group(0) @binding(0) var<storage, read> density_data: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> density_meta: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: RenderParams;

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
    @location(5) hovered_cell: i32,
    @location(6) use_drag_background: u32,
    @location(7) render_mode: u32,
) -> VertexOut {
    let pixel = rect_min + (unit * 0.5 + vec2<f32>(0.5)) * rect_size;
    let ndc = ((pixel - params.viewport_min) / params.viewport_size) * 2.0 - vec2<f32>(1.0, 1.0);
    var out: VertexOut;
    out.pos = vec4<f32>(ndc.x, -ndc.y, 0.0, 1.0);
    out.local = pixel - rect_min;
    out.rect_size = rect_size;
    out.slot = slot;
    out.span = span;
    out.hovered_cell = hovered_cell;
    out.use_drag_background = use_drag_background;
    out.render_mode = render_mode;
    return out;
}

fn on_rect_border(local: vec2<f32>, rect_size: vec2<f32>, width: f32) -> bool {
    return local.x < width || local.y < width ||
        local.x >= rect_size.x - width || local.y >= rect_size.y - width;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    let placeholder = in.render_mode == DENSITY_RENDER_MODE_PLACEHOLDER;
    var color = select(params.background, params.placeholder_background, placeholder);
    if (!placeholder && in.use_drag_background == 1u) {
        color = params.drag_background;
    }
    let aa_edge = max(0.5, length(fwidth(in.local)) * 0.65);

    let outer_p = in.local - in.rect_size * 0.5;
    let outer_d = sd_rect(outer_p, in.rect_size * 0.5 - vec2<f32>(0.5));
    if (outer_d > 0.0) { discard; }

    if (placeholder) {
        if (on_rect_border(in.local, in.rect_size, 1.0)) {
            color = params.border;
        }
        return color;
    }

    let dim = 1u << in.span;
    let cell = min(in.rect_size.x, in.rect_size.y) / f32(dim);
    let grid_size = vec2<f32>(f32(dim) * cell, f32(dim) * cell);
    let grid_origin = (in.rect_size - grid_size) * 0.5;
    let grid_local = in.local - grid_origin;
    if (grid_local.x >= 0.0 && grid_local.y >= 0.0 && grid_local.x < grid_size.x && grid_local.y < grid_size.y) {
        let col = u32(clamp(floor(grid_local.x / cell), 0.0, f32(dim - 1u)));
        let row = u32(clamp(floor(grid_local.y / cell), 0.0, f32(dim - 1u)));
        let cell_index = row * dim + col;
        let cell_local = grid_local - vec2<f32>(f32(col), f32(row)) * cell;
        let centered = cell_local - vec2<f32>(cell * 0.5);
        let slot_meta = density_meta[in.slot];
        let unity = max(slot_meta.x, 0.000000000001);
        let raw = density_data[in.slot * MAX_DENSITY_CELLS + cell_index] / unity;
        let mag = select(length(raw), abs(raw.x), row == col);

        if (cell < 3.0) {
            var heat = params.disk;
            heat.a = heat.a * sqrt(clamp(mag, 0.0, 1.0));
            color = blend_over(color, heat);
        } else {
            let stroke = select(1.0, 2.0, cell >= 24.0);
            let half_stroke = stroke * 0.5;
            let outline_clearance = 1.5;
            let outline_radius = max(0.0, cell * 0.5 - half_stroke - outline_clearance);
            let inner_radius = max(0.0, outline_radius - half_stroke);
            let centered_len = length(centered);

            let circle_inner = 1.0 - smoothstep(
                outline_radius - half_stroke - aa_edge,
                outline_radius - half_stroke + aa_edge,
                centered_len
            );
            if (in.use_drag_background == 1u && circle_inner > 0.001) {
                var circle_background = params.background;
                circle_background.a = circle_background.a * circle_inner;
                color = blend_over(color, circle_background);
            }

            let outline_outer = 1.0 - smoothstep(
                outline_radius + half_stroke - aa_edge,
                outline_radius + half_stroke + aa_edge,
                centered_len
            );
            let outline_alpha = max(0.0, outline_outer - circle_inner);
            if (outline_alpha > 0.001) {
                var outline = select(params.outline_zero, params.outline, mag > 0.000001);
                outline.a = outline.a * outline_alpha;
                color = blend_over(color, outline);
            }

            let radius = inner_radius * mag;
            if (radius > 0.3) {
                let disk_alpha = 1.0 - smoothstep(radius - aa_edge, radius + aa_edge, centered_len);
                if (disk_alpha > 0.001) {
                    var disk = params.disk;
                    disk.a = disk.a * disk_alpha;
                    color = blend_over(color, disk);
                }
                if (radius >= 1.5) {
                    let disk_border_radius = radius - 0.5;
                    let disk_border_inner = 1.0 - smoothstep(
                        disk_border_radius - 0.5 - aa_edge,
                        disk_border_radius - 0.5 + aa_edge,
                        centered_len
                    );
                    let disk_border_outer = 1.0 - smoothstep(
                        disk_border_radius + 0.5 - aa_edge,
                        disk_border_radius + 0.5 + aa_edge,
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

            if (row != col && cell >= 12.0 && mag > 0.001) {
                let angle = atan2(raw.y, raw.x);
                let dir = vec2<f32>(-sin(angle), -cos(angle));
                let along = clamp(dot(centered, dir), 0.0, inner_radius);
                let closest = dir * along;
                let needle_dist = length(centered - closest);
                let needle_alpha = 1.0 - smoothstep(half_stroke - aa_edge, half_stroke + aa_edge, needle_dist);
                if (needle_alpha > 0.001) {
                    var needle = params.needle;
                    needle.a = needle.a * needle_alpha;
                    color = blend_over(color, needle);
                }
            }

            if (in.hovered_cell == i32(cell_index)) {
                let hover_inner = 1.0 - smoothstep(
                    outline_radius - half_stroke - aa_edge,
                    outline_radius - half_stroke + aa_edge,
                    centered_len
                );
                let hover_outer = 1.0 - smoothstep(
                    outline_radius + half_stroke - aa_edge,
                    outline_radius + half_stroke + aa_edge,
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

        if (cell < 3.0 && in.hovered_cell == i32(cell_index)) {
            let hover_w = 2.0;
            if (cell_local.x < hover_w || cell_local.y < hover_w || cell_local.x >= cell - hover_w || cell_local.y >= cell - hover_w) {
                color = params.hover_border;
            }
        }
    }

    if (on_rect_border(in.local, in.rect_size, 1.0)) {
        color = params.border;
    }
    return color;
}
