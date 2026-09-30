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

use std::collections::BTreeSet;

use eframe::egui;

use super::{
    circuit_clipboard::CircuitCell, gate_frame_group, CircuitColumnIndex, GateId, QniApp, WireIndex,
};
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
    content_rect: egui::Rect,
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
            content_rect,
            palette_origin,
            palette_rect,
            palette_layout,
        }
    }
}

pub(super) struct DragController;

#[derive(Debug)]
pub(crate) struct SelectionDrag {
    start: egui::Pos2,
    current: egui::Pos2,
    click_cell: Option<CircuitCell>,
    initial_selection: BTreeSet<GateId>,
}

const SELECTION_DRAG_THRESHOLD: f32 = 4.0;

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

/// Resolve clicks inside a 40 px circuit dropzone to semantic grid state.
/// Inter-step bars and the exposed wire between dropzones are deliberately
/// excluded so their existing interactions do not move the paste marker.
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

impl DragController {
    pub(in crate::app) fn begin_selection_drag(
        app: &mut QniApp,
        start: egui::Pos2,
        click_cell: Option<CircuitCell>,
        additive: bool,
    ) {
        app.selection_drag = Some(SelectionDrag {
            start,
            current: start,
            click_cell,
            initial_selection: if additive {
                app.selected_gate_ids.clone()
            } else {
                Default::default()
            },
        });
    }

    pub(in crate::app) fn update_selection_drag(
        app: &mut QniApp,
        pointer: DragPointer,
        ctx: &egui::Context,
    ) -> bool {
        let Some(mut drag) = app.selection_drag.take() else {
            return false;
        };
        if let Some(pos) = pointer.local_pos {
            drag.current = pos;
        }
        if pointer.released {
            app.selection_drag = None;
            if drag.start.distance(drag.current) <= SELECTION_DRAG_THRESHOLD {
                if let Some(cell) = drag.click_cell {
                    app.select_empty_cell(cell);
                } else {
                    app.selected_gate_ids.clear();
                    app.active_cell = None;
                }
            } else {
                update_rect_selection(app, &drag);
            }
            ctx.request_repaint();
        } else {
            if drag.start.distance(drag.current) > SELECTION_DRAG_THRESHOLD {
                update_rect_selection(app, &drag);
            }
            app.selection_drag = Some(drag);
            ctx.request_repaint();
        }
        true
    }
}

fn update_rect_selection(app: &mut QniApp, drag: &SelectionDrag) {
    let selection_rect = egui::Rect::from_two_pos(drag.start, drag.current);
    let touched = app
        .placed_gates
        .iter()
        .filter(|gate| crate::layout::gate_visible_rect(gate, gate.pos).intersects(selection_rect))
        .flat_map(|gate| gate_frame_group(&app.placed_gates, gate.id))
        .collect::<BTreeSet<_>>();
    app.selected_gate_ids = drag.initial_selection.clone();
    app.selected_gate_ids.extend(touched);
}

impl QniApp {
    pub(crate) fn selection_drag_rect(&self) -> Option<egui::Rect> {
        self.selection_drag
            .as_ref()
            .filter(|drag| drag.start.distance(drag.current) > SELECTION_DRAG_THRESHOLD)
            .map(|drag| egui::Rect::from_two_pos(drag.start, drag.current))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circuit_dropzone_click_resolves_to_cell() {
        let metrics = layout_metrics(600.0, 3, 3);

        assert_eq!(
            circuit_cell_at_cursor(
                egui::pos2(metrics.slot_centers[1], metrics.line_ys[2]),
                &metrics,
            ),
            Some(CircuitCell {
                column: CircuitColumnIndex::new(1),
                wire: WireIndex::new(2),
            })
        );
    }

    #[test]
    fn exposed_wire_between_dropzones_is_not_a_cell() {
        let metrics = layout_metrics(600.0, 3, 3);
        let between_columns = (metrics.slot_centers[0] + metrics.slot_centers[1]) * 0.5;
        let cell =
            circuit_cell_at_cursor(egui::pos2(between_columns, metrics.line_ys[0]), &metrics);

        assert_eq!(cell, None);
    }
}
