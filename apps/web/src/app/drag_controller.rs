//! Gate drag controller facade.
//!
//! The submodules keep qni's SNAP / DROP / RESIZE style event boundaries
//! explicit while `gate_input` stays a thin egui adapter.

mod drop;
mod hover;
mod preview;
mod resize;
mod scroll;
mod start;

use eframe::egui;

use super::{circuit_clipboard::CircuitCell, CircuitColumnIndex, QniApp, WireIndex};
use crate::constants::{GATE_SIZE, LINE_GAP, PALETTE_ROW_Y, SLOT_SPACING};
use crate::layout::{
    layout_metrics, nearest_line, nearest_slot_index, palette_layout, palette_start_x,
    LayoutMetrics, PaletteLayout,
};

#[derive(Clone, Copy, Debug)]
pub(super) struct DragPointer {
    pub(super) screen_pos: Option<egui::Pos2>,
    pub(super) local_pos: Option<egui::Pos2>,
    pub(super) down: bool,
    pub(super) start: bool,
    pub(super) released: bool,
}

#[derive(Clone, Debug)]
pub(super) struct CircuitInputGeometry {
    pub(super) metrics: LayoutMetrics,
    palette_origin: egui::Pos2,
    palette_rect: egui::Rect,
    palette_layout: PaletteLayout,
}

impl CircuitInputGeometry {
    pub(super) fn new(
        content_rect: egui::Rect,
        screen_rect: egui::Rect,
        layout_qubits: usize,
        min_slots: usize,
    ) -> Self {
        let palette_layout = palette_layout();
        let palette_start_x = palette_start_x(screen_rect.width(), &palette_layout);
        let palette_origin = egui::pos2(
            screen_rect.min.x + palette_start_x,
            screen_rect.min.y + PALETTE_ROW_Y,
        );
        let palette_rect = egui::Rect::from_min_size(
            palette_origin,
            egui::vec2(palette_layout.total_width, palette_layout.total_height),
        );
        let metrics = layout_metrics(content_rect.width(), layout_qubits, min_slots);
        Self {
            metrics,
            palette_origin,
            palette_rect,
            palette_layout,
        }
    }
}

pub(super) struct DragController;

/// Column index the pointer is hovering over for step-preview.
/// Returns `None` when outside the slot row / range.
fn step_at_cursor(cursor: egui::Pos2, metrics: &LayoutMetrics) -> Option<CircuitColumnIndex> {
    if metrics.slot_centers.is_empty() || metrics.line_ys.is_empty() {
        return None;
    }
    let top = metrics.line_ys[0] - LINE_GAP * 0.5;
    let bottom = metrics.line_ys[metrics.line_ys.len() - 1] + LINE_GAP * 0.5;
    if cursor.y < top || cursor.y > bottom {
        return None;
    }
    if cursor.x < metrics.slot_left - SLOT_SPACING * 0.5
        || cursor.x > metrics.slot_right + SLOT_SPACING * 0.5
    {
        return None;
    }
    let (slot, dist) = nearest_slot_index(cursor.x, &metrics.slot_centers)?;
    if dist <= SLOT_SPACING * 0.5 {
        Some(CircuitColumnIndex::new(slot))
    } else {
        None
    }
}

fn circuit_cell_at_cursor(cursor: egui::Pos2, metrics: &LayoutMetrics) -> Option<CircuitCell> {
    let (column, column_distance) = nearest_slot_index(cursor.x, &metrics.slot_centers)?;
    let (_, wire_distance, wire) = nearest_line(cursor.y, &metrics.line_ys);
    if column_distance > GATE_SIZE * 0.5 || wire_distance > GATE_SIZE * 0.5 {
        return None;
    }

    Some(CircuitCell {
        column: CircuitColumnIndex::new(column),
        wire: WireIndex::new(wire),
    })
}

fn reset_drag_frame_state(app: &mut QniApp) {
    app.drag_repaint_deadline = None;
    app.drag_repaint_pending = false;
}
