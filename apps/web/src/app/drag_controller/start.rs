use eframe::egui;

use super::{
    circuit_cell_at_cursor, step_at_cursor, CircuitInputGeometry, DragController, DragPointer,
};
use crate::app::{
    CircuitColumnIndex, DragState, LiveDragSnap, PlacedGate, QniApp, SpanResizeDrag, WireIndex,
};
use crate::constants::GATE_SIZE;
use crate::gates::{default_palette_angle, palette_gate_kind, GateSpan};
use crate::layout::{gate_visible_rect, palette_hit_test};
use crate::span_resize::SpanResizeHandles;

#[derive(Clone, Copy, Debug)]
enum DragStartIntent {
    SpanResize(SpanResizeDrag),
    ExistingGate {
        drag: DragState,
        starts_live_display_snap: bool,
    },
    PaletteGate {
        index: usize,
        preview_pos: egui::Pos2,
    },
    BreakpointStep(CircuitColumnIndex),
    EmptyCell(super::CircuitCell),
    Background,
    None,
}

impl DragController {
    pub(in crate::app) fn handle_pointer_start(
        app: &mut QniApp,
        pointer: DragPointer,
        geometry: &CircuitInputGeometry,
        ctx: &egui::Context,
    ) -> bool {
        match start_intent(app, pointer, geometry) {
            DragStartIntent::SpanResize(resize) => {
                if app.library.active_locked() {
                    return false;
                }
                app.begin_circuit_commit();
                app.span_resize_drag = Some(resize);
                app.hovered_gate_id = None;
                app.hovered_probability_outcome = None;
                app.hovered_amplitude_outcome = None;
                app.hovered_density_cell = None;
                app.hovered_palette_index = None;
                ctx.request_repaint();
                true
            }
            DragStartIntent::ExistingGate {
                drag,
                starts_live_display_snap,
            } => {
                if app.library.active_locked() {
                    return false;
                }
                let shift = ctx.input(|input| input.modifiers.shift);
                if shift {
                    app.add_gate_to_copy_selection(drag.id);
                    ctx.request_repaint();
                    return true;
                }
                app.select_gate_for_copy(drag.id);
                app.begin_circuit_commit();
                app.dragging_live_snap = app.placed_gates.iter().find_map(|gate| {
                    (gate.id == drag.id).then_some(LiveDragSnap::Slot {
                        column: gate.column,
                        wire: gate.wire,
                    })
                });
                app.dragging = Some(drag);
                app.dragging_live_display_snap = starts_live_display_snap;
                app.dragging_live_gpu_plan_touched = false;
                app.drag_state_count = Some(app.state_count());
                app.drag_cursor_pos = pointer.local_pos;
                app.hovered_gate_id = None;
                app.hovered_probability_outcome = None;
                app.hovered_amplitude_outcome = None;
                app.hovered_density_cell = None;
                app.hovered_palette_index = None;
                ctx.request_repaint();
                true
            }
            DragStartIntent::PaletteGate { index, preview_pos } => {
                if app.library.active_locked() {
                    return false;
                }
                app.begin_circuit_commit();
                let Some(kind) = palette_gate_kind(index) else {
                    return false;
                };
                let new_id = app.gate_ids.allocate();
                let mut new_gate = PlacedGate::new(
                    new_id,
                    kind,
                    CircuitColumnIndex::ZERO,
                    WireIndex::ZERO,
                    GateSpan::SINGLE,
                    // Palette drop: parametric gates start with their explicit
                    // π/2 default so the circuit shows the same angle label Qni shows.
                    default_palette_angle(kind),
                );
                new_gate.pos = preview_pos;
                app.placed_gates.push(new_gate);
                app.dragging = Some(DragState {
                    id: new_id,
                    offset: egui::vec2(GATE_SIZE / 2.0, GATE_SIZE / 2.0),
                    original_column: None,
                });
                app.dragging_live_snap = None;
                app.dragging_live_display_snap = false;
                app.dragging_live_gpu_plan_touched = false;
                app.drag_state_count = Some(app.state_count());
                app.drag_cursor_pos = pointer.local_pos;
                app.hovered_palette_index = None;
                app.hovered_gate_id = None;
                app.hovered_probability_outcome = None;
                app.hovered_amplitude_outcome = None;
                app.hovered_density_cell = None;
                ctx.request_repaint();
                true
            }
            DragStartIntent::BreakpointStep(step) => {
                if app.breakpoint_step != Some(step) {
                    app.breakpoint_step = Some(step);
                    app.gpu_plan.mark_step_preview_dirty();
                    ctx.request_repaint();
                }
                true
            }
            DragStartIntent::EmptyCell(cell) => {
                if app.library.active_locked() {
                    return false;
                }
                let Some(start) = pointer.local_pos else {
                    return false;
                };
                let additive = ctx.input(|input| input.modifiers.shift);
                DragController::begin_selection_drag(app, start, Some(cell), additive);
                ctx.request_repaint();
                true
            }
            DragStartIntent::Background => {
                if app.library.active_locked() {
                    return false;
                }
                let Some(start) = pointer.local_pos else {
                    return false;
                };
                let additive = ctx.input(|input| input.modifiers.shift);
                DragController::begin_selection_drag(app, start, None, additive);
                ctx.request_repaint();
                true
            }
            DragStartIntent::None => false,
        }
    }
}

fn start_intent(
    app: &QniApp,
    pointer: DragPointer,
    geometry: &CircuitInputGeometry,
) -> DragStartIntent {
    let Some(cursor) = pointer.local_pos else {
        return DragStartIntent::None;
    };

    // Resizable-span handles take priority over gate bodies for press events,
    // so dragging the affordance resizes the span instead of picking up the
    // whole gate.
    if let Some(resize) = app
        .placed_gates
        .iter()
        .rev()
        .filter_map(|gate| {
            SpanResizeHandles::for_gate_with_availability(
                gate,
                &app.placed_gates,
                app.exec_mode.qubit_capacity().get(),
            )?
            .drag_at(gate, cursor)
        })
        .next()
    {
        return DragStartIntent::SpanResize(resize);
    }

    let now = crate::shared::now_seconds();
    if let Some(drag) = app
        .placed_gates
        .iter()
        .rev()
        .find_map(|gate| {
            let motion_x = app
                .circuit_motion_offset_x(gate.id, now)
                .unwrap_or_default();
            let gate_rect = gate_visible_rect(gate, gate.pos + egui::vec2(motion_x, 0.0));
            gate_rect.contains(cursor).then_some((gate, motion_x))
        })
        .map(|(gate, motion_x)| DragStartIntent::ExistingGate {
            drag: DragState {
                id: gate.id,
                offset: cursor - gate.pos - egui::vec2(motion_x, 0.0),
                original_column: Some(gate.column),
            },
            starts_live_display_snap: matches!(
                gate.kind,
                crate::gates::GateKind::AmplitudeDisplay
                    | crate::gates::GateKind::DensityMatrixDisplay
                    | crate::gates::GateKind::BlochDisplay
                    | crate::gates::GateKind::Measurement
            ),
        })
    {
        return drag;
    }

    if let Some(cursor_screen) = pointer.screen_pos {
        let local = egui::pos2(
            cursor_screen.x - geometry.palette_origin.x,
            cursor_screen.y - geometry.palette_origin.y,
        );
        if let Some(index) = palette_hit_test(local, &geometry.palette_layout) {
            return DragStartIntent::PaletteGate {
                index,
                preview_pos: egui::pos2(cursor.x - GATE_SIZE / 2.0, cursor.y - GATE_SIZE / 2.0),
            };
        }
    }

    if let Some(cell) = circuit_cell_at_cursor(cursor, &geometry.metrics) {
        return DragStartIntent::EmptyCell(cell);
    }

    // No gate / palette / empty dropzone under the cursor. If we're inside a
    // step slot, lock the breakpoint to that column without moving the paste marker.
    if let Some(step) = step_at_cursor(cursor, &geometry.metrics) {
        return DragStartIntent::BreakpointStep(step);
    }

    if pointer
        .screen_pos
        .is_some_and(|screen_pos| geometry.content_rect.contains(screen_pos))
    {
        DragStartIntent::Background
    } else {
        DragStartIntent::None
    }
}
