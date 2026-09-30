use std::time::Duration;

use eframe::egui;

use crate::app::{AngleAffordance, AngleEditor, GateId, QniApp};
use crate::colors::{with_alpha, Colors};
use crate::constants::GATE_SIZE;
use crate::gates::{GateKind, ParametricAngle};
use crate::layout::LayoutMetrics;
use crate::simulation_plan::ColumnAnalysis;

use super::circuit::gate_slot_index_for_render;
use super::circuit_connectors::phase::{
    angle_label_interaction_rect, angle_underline_segment, paint_reserved_angle_label_outline,
    parametric_angle_label_info, reserve_angle_label_outline, AngleLabelInfo,
    ANGLE_LABEL_FONT_SIZE,
};

const ANGLE_AFFORDANCE_DELAY_SECS: f64 = 0.680;
const ANGLE_UNDERLINE_FADE_SECS: f64 = 0.120;
#[derive(Clone, Debug)]
struct OwnedAngleLabel {
    gate_id: GateId,
    text: String,
    pos: egui::Pos2,
    align: egui::Align2,
    above_gate: bool,
    outline_with_background: bool,
}

impl OwnedAngleLabel {
    fn as_info(&self) -> AngleLabelInfo {
        AngleLabelInfo {
            gate_id: self.gate_id,
            text: self.text.clone(),
            pos: self.pos,
            align: self.align,
            above_gate: self.above_gate,
            outline_with_background: self.outline_with_background,
        }
    }
}

impl QniApp {
    pub(crate) fn angle_label_at_local_pos(
        &self,
        local_pos: Option<egui::Pos2>,
        metrics: &LayoutMetrics,
        dragging_gate_id: Option<GateId>,
    ) -> Option<GateId> {
        let local_pos = local_pos?;
        self.collect_angle_labels(metrics, egui::Pos2::ZERO, dragging_gate_id)
            .iter()
            .rev()
            .find(|label| angle_label_interaction_rect(&label.as_info()).contains(local_pos))
            .map(|label| label.gate_id)
    }

    pub(crate) fn show_angle_input_overlay(
        &mut self,
        ui: &mut egui::Ui,
        rect: egui::Rect,
        metrics: &LayoutMetrics,
        colors: &Colors,
        dragging_gate_id: Option<GateId>,
        scroll_x: f32,
        angle_interaction_blocked: bool,
    ) {
        let circuit_origin = rect.min - egui::vec2(scroll_x, 0.0);
        let labels = self.collect_angle_labels(metrics, circuit_origin, dragging_gate_id);
        let now = crate::shared::now_seconds();
        if self.dragging.is_some() || self.span_resize_drag.is_some() {
            self.angle_affordance = None;
        } else {
            self.open_due_angle_editor(now, ui.ctx());
        }
        if self.library.active_locked() {
            self.angle_affordance = None;
            self.angle_editor = None;
        }
        if angle_interaction_blocked {
            self.angle_affordance = None;
            let should_commit = self
                .angle_editor
                .as_ref()
                .is_some_and(|editor| editor.commit_after_frame);
            if !should_commit {
                publish_angle_input_geometry_json(&labels, self.angle_affordance, None);
                return;
            }
        }
        publish_angle_input_geometry_json(
            &labels,
            self.angle_affordance,
            self.angle_editor.as_ref(),
        );

        if let Some(editor_gate_id) = self.angle_editor.as_ref().map(|editor| editor.gate_id) {
            if let Some(label) = labels.iter().find(|label| label.gate_id == editor_gate_id) {
                self.show_active_angle_editor(ui, label, colors, now);
            } else {
                self.angle_editor = None;
            }
            return;
        }

        if self.library.active_locked() {
            self.angle_affordance = None;
            return;
        }

        let mut hovered_gate_id = None;
        for label in &labels {
            let info = label.as_info();
            let response = ui.interact(
                angle_label_interaction_rect(&info),
                ui.make_persistent_id(("angle-label", label.gate_id)),
                egui::Sense::click(),
            );
            if response.hovered() {
                hovered_gate_id = Some(label.gate_id);
                self.ensure_angle_hover_affordance(label.gate_id, now, ui.ctx());
            }
            if response.clicked() {
                self.handle_angle_label_click(label.gate_id, now, ui.ctx());
            }
            self.paint_angle_affordance(ui.painter(), &info, colors, now, ui.ctx());
        }

        self.clear_stale_angle_hover(hovered_gate_id);
    }

    fn collect_angle_labels(
        &self,
        metrics: &LayoutMetrics,
        circuit_origin: egui::Pos2,
        dragging_gate_id: Option<GateId>,
    ) -> Vec<OwnedAngleLabel> {
        let render_columns = ColumnAnalysis::from_gates(&self.placed_gates, |gate| {
            gate_slot_index_for_render(gate, metrics, dragging_gate_id)
        });
        let now = crate::shared::now_seconds();
        self.placed_gates
            .iter()
            .filter(|gate| !self.paste_gate_hidden(gate.id, now))
            .filter_map(|gate| {
                parametric_angle_label_info(
                    gate,
                    &render_columns,
                    metrics,
                    circuit_origin,
                    dragging_gate_id,
                    self.circuit_motion_offset_x(gate.id, now)
                        .unwrap_or_default(),
                )
            })
            .map(|label| OwnedAngleLabel {
                gate_id: label.gate_id,
                text: label.text,
                pos: label.pos,
                align: label.align,
                above_gate: label.above_gate,
                outline_with_background: label.outline_with_background,
            })
            .collect()
    }

    fn ensure_angle_hover_affordance(&mut self, gate_id: GateId, now: f64, ctx: &egui::Context) {
        if self
            .angle_affordance
            .as_ref()
            .is_some_and(|affordance| affordance.gate_id == gate_id)
        {
            return;
        }
        self.angle_affordance = Some(AngleAffordance {
            gate_id,
            started_at: now,
            open_editor_after_delay: false,
        });
        ctx.request_repaint_after(Duration::from_secs_f64(ANGLE_AFFORDANCE_DELAY_SECS));
    }

    fn handle_angle_label_click(&mut self, gate_id: GateId, now: f64, ctx: &egui::Context) {
        if self.library.active_locked() {
            return;
        }
        let visible_affordance = self
            .angle_affordance
            .as_ref()
            .filter(|affordance| affordance.gate_id == gate_id)
            .is_some_and(|affordance| angle_affordance_alpha(affordance, now) > 0.0);
        if visible_affordance {
            let reveal_started_at = self
                .angle_affordance
                .as_ref()
                .map(|affordance| affordance.started_at + ANGLE_AFFORDANCE_DELAY_SECS)
                .unwrap_or(now - ANGLE_UNDERLINE_FADE_SECS);
            self.open_angle_editor(gate_id, reveal_started_at, ctx);
            return;
        }
        self.angle_affordance = Some(AngleAffordance {
            gate_id,
            started_at: now,
            open_editor_after_delay: true,
        });
        ctx.request_repaint_after(Duration::from_secs_f64(ANGLE_AFFORDANCE_DELAY_SECS));
    }

    fn open_due_angle_editor(&mut self, now: f64, ctx: &egui::Context) {
        let Some(affordance) = self.angle_affordance else {
            return;
        };
        if !affordance.open_editor_after_delay {
            return;
        }
        let elapsed = now - affordance.started_at;
        if elapsed < ANGLE_AFFORDANCE_DELAY_SECS {
            ctx.request_repaint_after(Duration::from_secs_f64(
                ANGLE_AFFORDANCE_DELAY_SECS - elapsed,
            ));
            return;
        }
        self.open_angle_editor(
            affordance.gate_id,
            affordance.started_at + ANGLE_AFFORDANCE_DELAY_SECS,
            ctx,
        );
    }

    fn open_angle_editor(&mut self, gate_id: GateId, reveal_started_at: f64, ctx: &egui::Context) {
        if self.library.active_locked() {
            return;
        }
        let Some(gate) = self.placed_gates.iter().find(|gate| gate.id == gate_id) else {
            self.angle_affordance = None;
            return;
        };
        if !matches!(
            gate.kind,
            GateKind::Phase | GateKind::Rx | GateKind::Ry | GateKind::Rz
        ) {
            self.angle_affordance = None;
            return;
        }
        let draft = gate
            .angle
            .map(|angle| angle.label())
            .unwrap_or_else(|| ParametricAngle::default().label());
        self.angle_editor = Some(AngleEditor {
            gate_id,
            draft,
            reveal_started_at,
            select_all_pending: true,
            commit_after_frame: false,
        });
        self.angle_affordance = None;
        self.picker.close();
        ctx.request_repaint();
    }

    fn show_active_angle_editor(
        &mut self,
        ui: &mut egui::Ui,
        label: &OwnedAngleLabel,
        colors: &Colors,
        now: f64,
    ) {
        let info = label.as_info();
        let edit_rect = angle_label_interaction_rect(&info);
        let Some(mut editor) = self.angle_editor.take() else {
            return;
        };
        let mut draft = editor.draft.clone();
        let select_all = editor.select_all_pending;
        let commit_after_frame = editor.commit_after_frame;
        editor.select_all_pending = false;
        editor.commit_after_frame = false;

        let outline_slots = reserve_angle_label_outline(ui.painter(), &info);
        let text_id = ui.make_persistent_id(("angle-editor", editor.gate_id));
        let mut edit_ui = ui.new_child(
            egui::UiBuilder::new()
                .id_salt(("angle-editor-child", editor.gate_id))
                .max_rect(edit_rect)
                .layout(egui::Layout::left_to_right(egui::Align::Center)),
        );
        edit_ui.set_min_size(edit_rect.size());
        edit_ui.visuals_mut().selection.stroke = egui::Stroke::new(0.0_f32, colors.text_strong);
        let output = egui::TextEdit::singleline(&mut draft)
            .id(text_id)
            .font(egui::FontId::monospace(ANGLE_LABEL_FONT_SIZE)) // text-xs = 12px.
            .text_color(colors.text_strong) // Flexoki tx.
            .horizontal_align(egui::Align::Center)
            .frame(false)
            .margin(egui::Margin::ZERO)
            .desired_width(GATE_SIZE) // spacing-10 = 40px.
            .show(&mut edit_ui);
        paint_reserved_angle_label_outline(
            ui.painter(),
            colors,
            &draft,
            output.galley_pos,
            output.text_clip_rect,
            outline_slots,
        );
        if select_all {
            output.response.request_focus();
        }
        if select_all {
            let mut state = output.state;
            state
                .cursor
                .set_char_range(Some(egui::text::CCursorRange::two(
                    egui::text::CCursor::default(),
                    egui::text::CCursor::new(draft.chars().count()),
                )));
            state.store(ui.ctx(), output.response.id);
        }

        let alpha = editor_underline_alpha(editor.reveal_started_at, now);
        self.paint_underline(ui.painter(), &info, colors, alpha);

        let (enter, escape) = ui.input(|input| {
            input
                .events
                .iter()
                .fold((false, false), |(enter, escape), event| {
                    if let egui::Event::Key {
                        key, pressed: true, ..
                    } = event
                    {
                        (
                            enter || *key == egui::Key::Enter,
                            escape || *key == egui::Key::Escape,
                        )
                    } else {
                        (enter, escape)
                    }
                })
        });
        editor.draft = draft;
        if escape {
            self.angle_editor = None;
            ui.ctx().request_repaint();
        } else if enter || commit_after_frame || output.response.lost_focus() {
            self.angle_editor = Some(editor);
            self.commit_angle_editor(ui.ctx());
        } else {
            self.angle_editor = Some(editor);
            if alpha < 1.0 {
                ui.ctx().request_repaint();
            }
        }
    }

    pub(crate) fn commit_angle_editor(&mut self, ctx: &egui::Context) -> bool {
        if self.library.active_locked() {
            self.angle_editor = None;
            self.angle_affordance = None;
            ctx.request_repaint();
            return false;
        }
        let Some(editor) = self.angle_editor.take() else {
            return true;
        };
        let Ok(angle) = ParametricAngle::parse_user_input(&editor.draft) else {
            ctx.request_repaint();
            return false;
        };
        let Some(index) = self
            .placed_gates
            .iter()
            .position(|gate| gate.id == editor.gate_id)
        else {
            ctx.request_repaint();
            return true;
        };
        if self.placed_gates[index].angle == Some(angle) {
            ctx.request_repaint();
            return true;
        }
        self.begin_circuit_commit();
        self.placed_gates[index].angle = Some(angle);
        if self.commit_current_circuit(ctx) {
            self.gpu_plan.mark_dirty();
        }
        true
    }

    fn paint_angle_affordance(
        &self,
        painter: &egui::Painter,
        label: &AngleLabelInfo,
        colors: &Colors,
        now: f64,
        ctx: &egui::Context,
    ) {
        let Some(affordance) = self.angle_affordance.as_ref() else {
            return;
        };
        if affordance.gate_id != label.gate_id {
            return;
        }
        let alpha = angle_affordance_alpha(affordance, now);
        self.paint_underline(painter, label, colors, alpha);
        if alpha == 0.0 {
            let remaining = ANGLE_AFFORDANCE_DELAY_SECS - (now - affordance.started_at);
            ctx.request_repaint_after(Duration::from_secs_f64(remaining.max(0.0)));
        } else if alpha < 1.0 {
            ctx.request_repaint();
        }
    }

    fn paint_underline(
        &self,
        painter: &egui::Painter,
        label: &AngleLabelInfo,
        colors: &Colors,
        alpha: f32,
    ) {
        if alpha <= 0.0 {
            return;
        }
        let alpha = (255.0 * alpha.clamp(0.0, 1.0)).round() as u8;
        painter.line_segment(
            angle_underline_segment(label),
            egui::Stroke::new(1.0_f32, with_alpha(colors.text, alpha)), // Flexoki tx-2.
        );
    }

    fn clear_stale_angle_hover(&mut self, hovered_gate_id: Option<GateId>) {
        let Some(affordance) = self.angle_affordance else {
            return;
        };
        if affordance.open_editor_after_delay {
            return;
        }
        if Some(affordance.gate_id) != hovered_gate_id {
            self.angle_affordance = None;
        }
    }
}

fn angle_affordance_alpha(affordance: &AngleAffordance, now: f64) -> f32 {
    let fade_elapsed = now - affordance.started_at - ANGLE_AFFORDANCE_DELAY_SECS;
    (fade_elapsed / ANGLE_UNDERLINE_FADE_SECS).clamp(0.0, 1.0) as f32
}

fn editor_underline_alpha(reveal_started_at: f64, now: f64) -> f32 {
    ((now - reveal_started_at) / ANGLE_UNDERLINE_FADE_SECS).clamp(0.0, 1.0) as f32
}

#[cfg(all(target_arch = "wasm32", debug_assertions))]
fn publish_angle_input_geometry_json(
    labels: &[OwnedAngleLabel],
    affordance: Option<AngleAffordance>,
    editor: Option<&AngleEditor>,
) {
    let labels_json = labels
        .iter()
        .map(|label| {
            let info = label.as_info();
            let rect = angle_label_interaction_rect(&info);
            format!(
                "{{\"gate_id\":{},\"text\":\"{}\",\"left\":{:.3},\"top\":{:.3},\"right\":{:.3},\"bottom\":{:.3}}}",
                label.gate_id.as_u32(),
                label.text.replace('\\', "\\\\").replace('\"', "\\\""),
                rect.left(),
                rect.top(),
                rect.right(),
                rect.bottom(),
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let affordance_gate_id = affordance
        .map(|affordance| affordance.gate_id.as_u32().to_string())
        .unwrap_or_else(|| "null".to_owned());
    let editor_gate_id = editor
        .map(|editor| editor.gate_id.as_u32().to_string())
        .unwrap_or_else(|| "null".to_owned());
    let json = format!(
        "{{\"labels\":[{labels_json}],\"affordance_gate_id\":{affordance_gate_id},\"editor_gate_id\":{editor_gate_id}}}"
    );
    crate::test_hooks::set_window_value(
        crate::test_hooks::QNI_ANGLE_INPUT_GEOMETRY_JSON,
        &wasm_bindgen::JsValue::from_str(&json),
    );
}

#[cfg(any(not(target_arch = "wasm32"), not(debug_assertions)))]
fn publish_angle_input_geometry_json(
    _labels: &[OwnedAngleLabel],
    _affordance: Option<AngleAffordance>,
    _editor: Option<&AngleEditor>,
) {
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn angle_hover_affordance_is_hidden_before_delay() {
        let affordance = AngleAffordance {
            gate_id: crate::app::GateId::from_u32(1),
            started_at: 10.0,
            open_editor_after_delay: false,
        };

        assert_eq!(angle_affordance_alpha(&affordance, 10.650), 0.0);
    }

    #[test]
    fn angle_hover_affordance_is_done_at_total_duration() {
        let affordance = AngleAffordance {
            gate_id: crate::app::GateId::from_u32(1),
            started_at: 10.0,
            open_editor_after_delay: false,
        };

        assert_eq!(angle_affordance_alpha(&affordance, 10.801), 1.0);
    }
}
