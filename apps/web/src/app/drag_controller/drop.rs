use eframe::egui;

use super::{reset_drag_frame_state, DragController, DragPointer};
use crate::app::{CircuitColumnIndex, QniApp, WireIndex};
use crate::constants::{GATE_SIZE, SNAP_DISTANCE};
use crate::layout::{nearest_circuit_snap, nearest_line, CircuitSnap, LayoutMetrics};

impl DragController {
    pub(in crate::app) fn commit_gate_drop(
        app: &mut QniApp,
        pointer: DragPointer,
        metrics: &LayoutMetrics,
        ctx: &egui::Context,
    ) {
        if !pointer.released {
            return;
        }
        let live_gpu_plan_touched = app.dragging_live_gpu_plan_touched;
        if let Some(drag) = app.dragging.take() {
            if let Some(index) = app.placed_gates.iter().position(|gate| gate.id == drag.id) {
                let gate_pos = app.placed_gates[index].pos;
                let gate_id = app.placed_gates[index].id;
                let center_x = gate_pos.x + GATE_SIZE / 2.0;
                let center_y = gate_pos.y + GATE_SIZE / 2.0;
                let (_line_y, distance, line_index) = nearest_line(center_y, &metrics.line_ys);
                let snapped = nearest_circuit_snap(
                    center_x,
                    line_index,
                    &app.placed_gates[index],
                    Some(gate_id),
                    &app.placed_gates,
                    &metrics.slot_centers,
                );
                let on_circuit = distance <= SNAP_DISTANCE
                    && snapped
                        .as_ref()
                        .map(|snap| snap.distance() <= SNAP_DISTANCE)
                        .unwrap_or(false);

                if !on_circuit {
                    app.placed_gates.remove(index);
                    app.selected_gate_ids.remove(&gate_id);
                } else if let Some(snap) = snapped {
                    match snap {
                        CircuitSnap::Slot(snap) => {
                            let capacity = app.exec_mode.qubit_capacity();
                            let gate = &mut app.placed_gates[index];
                            gate.column = CircuitColumnIndex::new(snap.index);
                            gate.wire = WireIndex::new(line_index);
                            gate.clamp_span_to_qubit_capacity(capacity);
                            gate.sync_pos_from_grid();
                        }
                        CircuitSnap::Insert(snap) => {
                            app.insert_gate_at_column(
                                gate_id,
                                WireIndex::new(line_index),
                                CircuitColumnIndex::new(snap.index),
                                drag.original_column,
                            );
                        }
                    }
                }
                // Mirror qni's post-drop `resize()`: remove empty
                // columns and shift trailing gates left for both branches.
                app.compact_empty_steps();
                app.update_qubit_count();
                // Mirror qni / Quirk: live drag state is transient;
                // drop creates one undoable JSON checkpoint and syncs it
                // to the URL hash.
                if app.commit_current_circuit(ctx) || live_gpu_plan_touched {
                    app.gpu_plan.mark_dirty();
                }
            }
        }
        app.dragging_live_snap = None;
        app.dragging_live_display_snap = false;
        app.dragging_live_gpu_plan_touched = false;
        app.drag_state_count = None;
        reset_drag_frame_state(app);
        app.drag_cursor_pos = None;
    }
}
