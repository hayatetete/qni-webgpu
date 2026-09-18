//! Gate input — egui pointer adapter for `DragController` plus the
//! drag-time repaint throttle. Independent of the state panel.

use eframe::egui;
use std::time::Duration;

use super::drag_controller::{CircuitInputGeometry, DragController, DragPointer};
use super::{GateClickSelection, QniApp};
use crate::constants::{
    DRAG_REPAINT_BASE_SECS, DRAG_REPAINT_MAX_SECS, DRAG_REPAINT_MIN_SECS, DRAG_REPAINT_PUMP_FACTOR,
};
use crate::layout::gate_visible_rect;
use crate::shared::now_seconds;

const DOUBLE_CLICK_SELECTION_WINDOW_SECS: f64 = 0.5;

impl QniApp {
    pub(crate) fn handle_input(
        &mut self,
        content_rect: egui::Rect,
        ctx: &egui::Context,
        screen_rect: egui::Rect,
        pointer_over_state_panel: bool,
    ) {
        let pointer = ctx.input(|input| input.pointer.clone());
        let pos = pointer.latest_pos();
        let pointer_down = pointer.primary_down();
        let pointer_pressed = pointer.primary_pressed();
        let pointer_released = pointer.primary_released();
        let double_clicked = pointer.button_double_clicked(egui::PointerButton::Primary);

        let pointer_start = pointer_pressed || (pointer_down && !self.pointer_was_down);
        self.pointer_was_down = pointer_down;
        // `local_pos` is the cursor in *circuit space* — the same
        // coordinate frame `gate.pos` lives in. We undo the horizontal
        // scroll here once so every downstream hit-test (gate body,
        // slot snap, step preview, palette drop on circuit) gets a
        // cursor it can compare directly against `gate.pos.x`.
        // Palette pickup itself uses `pos` (screen) so it isn't
        // affected by the offset.
        let local_pos = pos.map(|p| {
            egui::pos2(
                p.x - content_rect.min.x + self.circuit_scroll_x,
                p.y - content_rect.min.y,
            )
        });
        let geometry = CircuitInputGeometry::new(
            content_rect,
            screen_rect,
            self.layout_qubits(),
            self.min_circuit_slots(),
        );
        let now = now_seconds();
        let pointer_gate_id = local_pos.and_then(|cursor| {
            self.placed_gates
                .iter()
                .rev()
                .find(|gate| {
                    let motion_x = self
                        .circuit_motion_offset_x(gate.id, now)
                        .unwrap_or_default();
                    gate_visible_rect(gate, gate.pos + egui::vec2(motion_x, 0.0)).contains(cursor)
                })
                .map(|gate| gate.id)
        });
        if pointer_start {
            if let Some(gate_id) = pointer_gate_id {
                if let Some(click) = self.gate_click_selection.as_mut().filter(|click| {
                    click.gate_id == gate_id
                        && now - click.pressed_at <= DOUBLE_CLICK_SELECTION_WINDOW_SECS
                }) {
                    click.repeated_same_gate = true;
                } else {
                    self.gate_click_selection = Some(GateClickSelection {
                        gate_id,
                        pressed_at: now,
                        selected_gate_ids: self.selected_gate_ids.clone(),
                        repeated_same_gate: false,
                    });
                }
            }
        }
        let drag_pointer = DragPointer {
            screen_pos: pos,
            local_pos,
            down: pointer_down,
            start: pointer_start,
            released: pointer_released,
        };

        let angle_label_gate_id = (!self.library.active_locked())
            .then(|| {
                self.angle_label_at_local_pos(
                    local_pos,
                    &geometry.metrics,
                    self.dragging.map(|drag| drag.id),
                )
            })
            .flatten();
        if let Some(affordance) = self.angle_affordance {
            if drag_pointer.start
                && affordance.open_editor_after_delay
                && angle_label_gate_id != Some(affordance.gate_id)
            {
                self.angle_affordance = None;
            }
        }
        if drag_pointer.start && self.angle_editor.is_some() {
            let active_editor_gate = self.angle_editor.as_ref().map(|editor| editor.gate_id);
            if angle_label_gate_id != active_editor_gate {
                if let Some(editor) = self.angle_editor.as_mut() {
                    editor.commit_after_frame = true;
                }
            }
        }

        let pointer_over_picker = self
            .picker_overlay_rect
            .is_some_and(|rect| pos.is_some_and(|pos| rect.contains(pos)));
        if (pointer_over_picker || pointer_over_state_panel)
            && self.dragging.is_none()
            && self.span_resize_drag.is_none()
        {
            DragController::clear_idle_hover(self, ctx);
            return;
        }

        DragController::update_circuit_scroll(
            self,
            ctx,
            content_rect,
            drag_pointer.screen_pos,
            &geometry.metrics,
        );
        if self.angle_editor.is_some() && self.dragging.is_none() && self.span_resize_drag.is_none()
        {
            if drag_pointer.start {
                let active_editor_gate = self.angle_editor.as_ref().map(|editor| editor.gate_id);
                if angle_label_gate_id != active_editor_gate {
                    if let Some(editor) = self.angle_editor.as_mut() {
                        editor.commit_after_frame = true;
                    }
                }
            }
            DragController::clear_idle_hover(self, ctx);
            if angle_label_gate_id.is_some() {
                ctx.set_cursor_icon(egui::CursorIcon::Text);
            }
            return;
        }
        if angle_label_gate_id.is_some()
            && self.dragging.is_none()
            && self.span_resize_drag.is_none()
        {
            DragController::clear_idle_hover(self, ctx);
            ctx.set_cursor_icon(egui::CursorIcon::Text);
            return;
        }

        if drag_pointer.start
            && DragController::handle_pointer_start(self, drag_pointer, &geometry, ctx)
            && !drag_pointer.released
        {
            return;
        }

        if DragController::update_selection_drag(self, drag_pointer, ctx) {
            return;
        }

        // Active resizable-span drag → update span from total Δy and skip
        // the rest of the input pipeline (gate drag, hover) for this frame.
        if DragController::update_active_span_resize(self, drag_pointer, ctx) {
            return;
        }

        if self.dragging.is_some() {
            DragController::update_gate_drag_preview(self, drag_pointer, &geometry.metrics);
        } else {
            DragController::update_idle_hover(self, drag_pointer, &geometry, ctx);
        }

        DragController::commit_gate_drop(self, drag_pointer, &geometry.metrics, ctx);
        if let Some(gate_id) = double_clicked.then_some(pointer_gate_id).flatten() {
            let selection = self
                .gate_click_selection
                .take()
                .filter(|click| click.gate_id == gate_id && click.repeated_same_gate)
                .map(|click| click.selected_gate_ids);
            if let Some(selection) = selection {
                self.select_gate_individually(gate_id, selection);
                ctx.request_repaint();
            }
        }
        DragController::set_cursor_icon(self, drag_pointer, ctx);
    }

    pub(crate) fn schedule_drag_repaint(&mut self, ctx: &egui::Context, frame_secs: f64) {
        let now = now_seconds();
        let deadline = self.drag_repaint_deadline.unwrap_or(now);
        if now >= deadline {
            let delay = (DRAG_REPAINT_BASE_SECS + frame_secs * DRAG_REPAINT_PUMP_FACTOR)
                .clamp(DRAG_REPAINT_MIN_SECS, DRAG_REPAINT_MAX_SECS);
            self.drag_repaint_deadline = Some(now + delay);
            self.drag_repaint_pending = false;
            ctx.request_repaint();
        } else if !self.drag_repaint_pending {
            self.drag_repaint_pending = true;
            let remaining = (deadline - now).max(0.0);
            ctx.request_repaint_after(Duration::from_secs_f64(remaining));
        }
    }
}
