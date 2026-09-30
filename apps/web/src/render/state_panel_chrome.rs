//! State panel chrome helpers: resize handles and grid minimap.

use eframe::egui;

use super::state_panel_layout::StatePanelLayout;
use crate::app::ResizeCorner;
use crate::colors::Colors;
use crate::constants::{
    STATE_PANEL_CORNER_RADIUS, STATE_RESIZE_HANDLE_PAD, STATE_RESIZE_HANDLE_STROKE,
};

/// Draw a single resize-handle arc. The arc is concentric with the
/// panel's rounded corner: same centre as the panel's corner-radius
/// circle, radius = `STATE_PANEL_CORNER_RADIUS − STATE_RESIZE_HANDLE_PAD`.
/// This means the handle literally traces the panel's rounded inner
/// edge offset inward by `PAD`, so the handle's curvature matches the
/// panel's R exactly.
pub(super) fn draw_resize_handle_arc(
    painter: &egui::Painter,
    corner: ResizeCorner,
    state_rect: egui::Rect,
    color: egui::Color32,
) {
    use std::f32::consts::PI;
    let r = STATE_PANEL_CORNER_RADIUS;
    let inner_r = (r - STATE_RESIZE_HANDLE_PAD).max(0.0);
    if inner_r <= 0.0 {
        return;
    }
    // `center` is the centre of the panel's rounded-corner circle for
    // this corner (located `r` px inside the corner along both axes).
    // `start_angle` is the angle on the circle at which the arc begins;
    // we always sweep +π/2 (90°) counterclockwise (in math y-up terms;
    // visually that's "along the corner curve").
    let (center, start_angle) = match corner {
        ResizeCorner::TopLeft => (state_rect.min + egui::vec2(r, r), PI),
        ResizeCorner::TopRight => (
            egui::pos2(state_rect.max.x - r, state_rect.min.y + r),
            -PI / 2.0,
        ),
        ResizeCorner::BottomRight => (state_rect.max - egui::vec2(r, r), 0.0),
        ResizeCorner::BottomLeft => (
            egui::pos2(state_rect.min.x + r, state_rect.max.y - r),
            PI / 2.0,
        ),
    };
    const ARC_SEGMENTS: usize = 16;
    let mut points: Vec<egui::Pos2> = Vec::with_capacity(ARC_SEGMENTS + 1);
    for i in 0..=ARC_SEGMENTS {
        let t = i as f32 / ARC_SEGMENTS as f32;
        let a = start_angle + t * (PI / 2.0);
        points.push(center + egui::vec2(inner_r * a.cos(), inner_r * a.sin()));
    }
    painter.add(egui::Shape::line(
        points,
        egui::Stroke::new(STATE_RESIZE_HANDLE_STROKE, color),
    ));
}

/// Bottom-right minimap that shows where the viewport is sitting on the
/// (potentially much larger) grid. The outer rectangle matches the grid
/// aspect (so a 32×32 grid produces a square minimap, a 32×8 grid a
/// wide one), and the lighter inset rectangle inside marks the visible
/// region. Only painted when the grid actually exceeds the viewport on
/// at least one axis — otherwise the whole grid is on screen and the
/// minimap is just chrome.
pub(super) fn draw_state_minimap(
    painter: &egui::Painter,
    colors: &Colors,
    layout: &StatePanelLayout,
    viewport_rect: egui::Rect,
    grid_origin: egui::Pos2,
) {
    let grid = layout.grid_size;
    if grid.x <= viewport_rect.width() && grid.y <= viewport_rect.height() {
        return;
    }
    // Grid aspect drives the minimap's outer dimensions, capped at a
    // bounding box. No letterboxing inside — the inset rect IS the grid.
    const MAX_W: f32 = 80.0;
    const MAX_H: f32 = 50.0;
    const INSET: f32 = 3.0;
    let aspect = grid.x / grid.y;
    let (inner_w, inner_h) = if aspect >= MAX_W / MAX_H {
        (MAX_W, MAX_W / aspect)
    } else {
        (MAX_H * aspect, MAX_H)
    };
    let mm_size = egui::vec2(inner_w + INSET * 2.0, inner_h + INSET * 2.0);
    // Small inset past the BR resize-handle arc (~14 px from the
    // corner) — just enough to break the visual "stuck together"
    // but not so far it floats in space.
    let pad = 12.0;
    let mm_rect = egui::Rect::from_min_max(
        viewport_rect.max - mm_size - egui::vec2(pad, pad),
        viewport_rect.max - egui::vec2(pad, pad),
    );
    painter.rect_filled(mm_rect, egui::CornerRadius::same(4), colors.minimap_bg);

    let mm_grid_min = mm_rect.min + egui::vec2(INSET, INSET);
    let mm_grid_size = egui::vec2(inner_w, inner_h);
    let scale = inner_w / grid.x;
    // Visible region inside the grid, in grid-space pixels.
    let visible_offset = viewport_rect.min - grid_origin;
    let mm_vp_min = mm_grid_min + visible_offset * scale;
    let mm_vp_size = egui::vec2(viewport_rect.width(), viewport_rect.height()) * scale;
    let mm_vp_rect = egui::Rect::from_min_size(mm_vp_min, mm_vp_size)
        .intersect(egui::Rect::from_min_size(mm_grid_min, mm_grid_size));
    let vp_fill = colors.minimap_viewport_fill;
    let vp_stroke = egui::Stroke::new(1.0_f32, colors.minimap_viewport_stroke);
    painter.rect_filled(mm_vp_rect, egui::CornerRadius::ZERO, vp_fill);
    painter.rect_stroke(
        mm_vp_rect,
        egui::CornerRadius::ZERO,
        vp_stroke,
        egui::StrokeKind::Inside,
    );
}
