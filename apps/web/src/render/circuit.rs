//! Circuit area drawing — qubit lines, placed gates, palette, drag
//! preview. Independent of the state-vector panel.

use eframe::egui;

use crate::app::{GateId, PlacedGate, QniApp};
use crate::colors::{with_alpha, Colors};
use crate::constants::{CIRCUIT_PADDING, GATE_SIZE, LINE_GAP, LINE_Y, REM};
use crate::layout::{nearest_slot_index, LayoutMetrics};

const SLOT_CENTER_EPSILON: f32 = 0.5;
const PASTE_GHOST_PADDING: f32 = 8.0; // Tailwind spacing-2.

pub(super) fn gate_slot_index_for_render(
    gate: &PlacedGate,
    metrics: &LayoutMetrics,
    dragging_gate_id: Option<GateId>,
) -> Option<usize> {
    if dragging_gate_id == Some(gate.id) {
        // A dragged gate can snap to an insert preview halfway between real
        // slots. Do not coerce that preview back to the nearest slot for
        // connector drawing; otherwise a vertical connector is pulled away
        // from the gate center until drop shifts the grid.
        let center_x = gate.pos.x + GATE_SIZE / 2.0;
        let (slot_index, distance) = nearest_slot_index(center_x, &metrics.slot_centers)?;
        return (distance <= SLOT_CENTER_EPSILON).then_some(slot_index);
    }
    (gate.column.as_usize() < metrics.slot_centers.len()).then_some(gate.column.as_usize())
}

impl QniApp {
    pub(crate) fn circuit_content_height(&self, qubit_count: usize, screen_height: f32) -> f32 {
        let line_count = qubit_count.max(1);
        let last_line_y = LINE_Y + LINE_GAP * (line_count.saturating_sub(1)) as f32;
        let content_height = last_line_y + GATE_SIZE + 4.0 * REM;
        content_height.max(screen_height)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn draw_circuit(
        &self,
        painter: &egui::Painter,
        rect: egui::Rect,
        metrics: &LayoutMetrics,
        colors: &Colors,
        fast_drag: bool,
        dragging_gate_id: Option<GateId>,
        scroll_x: f32,
    ) {
        // `circuit_origin` is `rect.min` shifted left by the current
        // horizontal scroll offset. Anything pinned to the circuit's
        // coordinate system (wires, slot grid, gate bodies, step
        // indicators, connectors) is drawn relative to it; the qubit
        // label strip on the left and the GPU callback viewports stay
        // on `rect.min` so they don't track the scroll.
        let circuit_origin = rect.min - egui::vec2(scroll_x, 0.0);
        let placed_wire_count = self.required_visible_wire_count();
        let preview_wire_count = self
            .paste_preview()
            .filter(|_| !self.library.active_locked())
            .map(|(anchor, (_, height))| anchor.wire.as_usize().saturating_add(height))
            .unwrap_or(placed_wire_count);
        for (index, &line_y) in metrics.line_ys.iter().enumerate() {
            let start = circuit_origin + egui::vec2(metrics.line_left, line_y);
            let end = circuit_origin + egui::vec2(metrics.line_right, line_y);
            let line_color = if index >= placed_wire_count && index < preview_wire_count {
                with_alpha(colors.line, 80)
            } else {
                colors.line
            };
            painter.line_segment([start, end], egui::Stroke::new(2.0_f32, line_color));
        }

        // Step-preview vertical bars at the right edge of the
        // hovered / breakpoint column. Hovered = 30% alpha (live
        // preview), breakpoint = full opacity (locked-in step). Mirrors
        // qni's `circuit-step::after` data-active / data-breakpoint
        // styling.
        let edit_feedback_visible = !self.library.active_locked();
        let paste_preview = self.paste_preview().filter(|_| edit_feedback_visible);
        if !metrics.line_ys.is_empty() && !metrics.slot_centers.is_empty() {
            let top = metrics.line_ys[0] - crate::constants::LINE_GAP * 0.5;
            let bot = metrics.line_ys[metrics.line_ys.len() - 1] + crate::constants::LINE_GAP * 0.5;
            let step_line = |painter: &egui::Painter, slot: usize, alpha: u8| {
                if slot >= metrics.slot_centers.len() {
                    return;
                }
                let x = metrics.slot_centers[slot]
                    + crate::constants::SLOT_SPACING * 0.5
                    + circuit_origin.x;
                let color = with_alpha(colors.step_preview, alpha);
                painter.line_segment(
                    [
                        egui::pos2(x, rect.min.y + top),
                        egui::pos2(x, rect.min.y + bot),
                    ],
                    egui::Stroke::new(3.0_f32, color),
                );
            };
            if let Some(step) = self.breakpoint_step {
                step_line(painter, step.as_usize(), 255);
            }
            if let Some(step) = self.hovered_step {
                if Some(step) != self.breakpoint_step {
                    step_line(painter, step.as_usize(), 80);
                }
            }
        }

        if let Some((anchor, (width, height))) = paste_preview {
            let insert_column = anchor.column.as_usize().saturating_add(1);
            if let Some(&anchor_y) = metrics.line_ys.get(anchor.wire.as_usize()) {
                if let Some(&insert_x) = metrics.slot_centers.get(insert_column) {
                    let preview = egui::Rect::from_min_size(
                        circuit_origin
                            + egui::vec2(insert_x - GATE_SIZE * 0.5, anchor_y - GATE_SIZE * 0.5),
                        egui::vec2(
                            GATE_SIZE
                                + crate::constants::SLOT_SPACING * width.saturating_sub(1) as f32,
                            GATE_SIZE
                                + crate::constants::LINE_GAP * height.saturating_sub(1) as f32,
                        ),
                    )
                    .expand(PASTE_GHOST_PADDING);
                    painter.rect_filled(
                        preview,
                        egui::CornerRadius::same(4),
                        with_alpha(colors.semantic_on, 31),
                    );
                }
            }
        }

        self.draw_circuit_connectors(painter, metrics, colors, circuit_origin, dragging_gate_id);

        self.draw_placed_circuit_gates(
            painter,
            circuit_origin,
            colors,
            fast_drag,
            dragging_gate_id,
        );

        // Flash the display body before its GPU content is painted. Drawing
        // this after the callbacks washes out the display and leaves only
        // its frame visibly intact during paste feedback.
        self.draw_circuit_gpu_overlays(painter, rect, circuit_origin, dragging_gate_id, colors);

        // Selection rubber-band is interaction chrome, so it must stay above
        // opaque and GPU-backed gate bodies alike.
        if let Some(selection_rect) = self.selection_drag_rect().filter(|_| edit_feedback_visible) {
            let selection_rect = selection_rect.translate(circuit_origin.to_vec2());
            painter.rect_filled(
                selection_rect,
                egui::CornerRadius::ZERO,
                with_alpha(colors.semantic_on, 31),
            );
            painter.rect_stroke(
                selection_rect,
                egui::CornerRadius::ZERO,
                egui::Stroke::new(1.0_f32, colors.semantic_on),
                egui::StrokeKind::Inside,
            );
        }

        for (index, &line_y) in metrics.line_ys.iter().enumerate() {
            // Labels live in circuit space (anchored to the wire's
            // start) so they scroll with the rest of the circuit —
            // otherwise the leftmost gates would slide under fixed
            // "q0:" / "q1:" labels and visually collide.
            let label_pos = circuit_origin + egui::vec2(CIRCUIT_PADDING, line_y - 7.0);
            let label_color = if index >= placed_wire_count && index < preview_wire_count {
                with_alpha(colors.text, 80)
            } else {
                colors.text
            };
            painter.text(
                label_pos,
                egui::Align2::LEFT_TOP,
                format!("q{index}:"),
                // text-sm (14 px) — Tailwind. Monospace keeps q0:/q1: wire
                // labels aligned with angle labels and state-panel numerals.
                egui::FontId::monospace(14.0),
                label_color,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::app::PlacedGate;
    use crate::constants::SLOT_SPACING;
    use crate::gates::GateKind;
    use crate::layout::layout_metrics;

    #[test]
    fn dragged_insert_preview_does_not_join_slot_connector() {
        let metrics = layout_metrics(600.0, 2, 3);
        let mut gate = PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Control,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        );
        gate.pos.x =
            metrics.slot_centers[0] + SLOT_SPACING * 0.5 - crate::constants::GATE_SIZE * 0.5;

        let slot = super::gate_slot_index_for_render(&gate, &metrics, Some(gate.id));

        assert_eq!(slot, None);
    }

    #[test]
    fn dragged_slot_preview_joins_that_slot_connector() {
        let metrics = layout_metrics(600.0, 2, 3);
        let gate = PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Control,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        );

        let slot = super::gate_slot_index_for_render(&gate, &metrics, Some(gate.id));

        assert_eq!(slot, Some(0));
    }
}
