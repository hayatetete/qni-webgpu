//! Quirk-style linear circuit revision history.
//!
//! Quirk keeps the mutable drag/display state out of the undo stack: drag start
//! calls `startedWorkingOnCommit`, live drag mutates the displayed circuit, and
//! drop commits exactly one serialised circuit checkpoint. Pressing undo while a
//! commit is in progress cancels back to the active checkpoint instead of
//! skipping over it. This module mirrors that model with qni-compatible circuit
//! JSON snapshots (`{"cols":[...]}`), so the URL and undo stack share one
//! canonical representation.

use eframe::egui;

use super::circuit_library::persist_library;
use super::{ExecMode, ExternalGpuStatus, QniApp};
use crate::qubit_count::QubitCount;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CircuitRevision {
    history: Vec<String>,
    index: usize,
    is_working_on_commit: bool,
}

impl CircuitRevision {
    pub(crate) fn starting_at(state: String) -> Self {
        Self {
            history: vec![state],
            index: 0,
            is_working_on_commit: false,
        }
    }

    pub(crate) fn is_at_beginning_of_history(&self) -> bool {
        self.index == 0 && !self.is_working_on_commit
    }

    pub(crate) fn is_at_end_of_history(&self) -> bool {
        self.index + 1 == self.history.len()
    }

    pub(crate) fn started_working_on_commit(&mut self) {
        self.is_working_on_commit = true;
    }

    pub(crate) fn commit(&mut self, new_checkpoint: String) -> bool {
        if new_checkpoint == self.history[self.index] {
            self.is_working_on_commit = false;
            return false;
        }
        self.is_working_on_commit = false;
        self.index += 1;
        self.history.truncate(self.index);
        self.history.push(new_checkpoint);
        true
    }

    pub(crate) fn undo(&mut self) -> Option<String> {
        if !self.is_working_on_commit {
            if self.index == 0 {
                return None;
            }
            self.index -= 1;
        }
        self.is_working_on_commit = false;
        Some(self.history[self.index].clone())
    }

    pub(crate) fn redo(&mut self) -> Option<String> {
        if self.index + 1 == self.history.len() {
            return None;
        }
        self.index += 1;
        self.is_working_on_commit = false;
        Some(self.history[self.index].clone())
    }
}

impl QniApp {
    pub(crate) fn begin_circuit_commit(&mut self) {
        if !self.library.active_locked() {
            self.circuit_revision.started_working_on_commit();
        }
    }

    pub(crate) fn commit_current_circuit(&mut self, ctx: &egui::Context) -> bool {
        if self.library.active_locked() {
            return false;
        }
        self.commit_current_circuit_unchecked(ctx)
    }

    pub(crate) fn commit_current_circuit_unchecked(&mut self, ctx: &egui::Context) -> bool {
        let json = self.current_circuit_json();
        if !self.circuit_revision.commit(json.clone()) {
            ctx.request_repaint();
            return false;
        }
        self.library.update_active_unchecked(json.clone());
        persist_library(&self.library);
        crate::url_circuit::write_circuit_to_url(&json);
        self.external_gpu_status = ExternalGpuStatus::Idle;
        self.external_gpu_started_at = None;
        self.external_gpu_state_refresh_pending = false;
        self.external_gpu_amplitude_uploads = None;
        self.external_gpu_bloch_uploads = None;
        self.external_gpu_probability_uploads = None;
        self.external_gpu_density_uploads = None;
        self.pending_external_amplitude_slots.clear();
        self.pending_external_bloch_slots.clear();
        self.pending_external_probability_slots.clear();
        self.pending_external_density_slots.clear();
        self.pending_external_gpu_run_id = None;
        ctx.request_repaint();
        true
    }

    pub(crate) fn can_undo_circuit(&self) -> bool {
        !self.library.active_locked() && !self.circuit_revision.is_at_beginning_of_history()
    }

    pub(crate) fn can_redo_circuit(&self) -> bool {
        !self.library.active_locked() && !self.circuit_revision.is_at_end_of_history()
    }

    pub(crate) fn undo_circuit(&mut self, ctx: &egui::Context) {
        if self.library.active_locked() {
            return;
        }
        if let Some(json) = self.circuit_revision.undo() {
            self.replace_active_circuit_json_unchecked(&json, ctx);
        }
    }

    pub(crate) fn redo_circuit(&mut self, ctx: &egui::Context) {
        if self.library.active_locked() {
            return;
        }
        if let Some(json) = self.circuit_revision.redo() {
            self.replace_active_circuit_json_unchecked(&json, ctx);
        }
    }

    pub(crate) fn apply_url_payload(&mut self, json: String, ctx: &egui::Context) -> bool {
        if self.library.active_locked() {
            crate::url_circuit::write_circuit_to_url(&self.library.active().circuit_json);
            return false;
        }
        self.circuit_revision = CircuitRevision::starting_at(json.clone());
        self.replace_active_circuit_json_unchecked(&json, ctx);
        true
    }

    fn current_circuit_json(&self) -> String {
        crate::url_circuit::circuit_to_json(
            &self.placed_gates,
            QubitCount::try_new(self.required_visible_wire_count())
                .expect("visible wire count is at least one"),
        )
    }

    pub(crate) fn replace_active_circuit_json_unchecked(
        &mut self,
        json: &str,
        ctx: &egui::Context,
    ) {
        self.load_circuit_json_into_editor(json, ctx);
        self.library.update_active_unchecked(json.to_owned());
        persist_library(&self.library);
        crate::url_circuit::write_circuit_to_url(json);
        ctx.request_repaint();
    }

    pub(crate) fn load_circuit_json_into_editor(&mut self, json: &str, ctx: &egui::Context) {
        let previous_exec_mode = self.exec_mode;
        let (gates, gate_ids) = crate::url_circuit::parse_circuit_json(json);
        self.placed_gates = gates;
        self.gate_ids = gate_ids;
        self.selected_gate_ids.clear();
        self.copy_flash = None;
        self.paste_flashes.clear();
        self.circuit_motion = None;
        self.circuit_scroll_motion = None;
        self.active_cell = None;
        self.selection_drag = None;
        if !self
            .exec_mode
            .qubit_capacity()
            .contains(self.required_qubit_count())
        {
            self.exec_mode = ExecMode::Gpu;
        }
        if self.exec_mode != previous_exec_mode {
            crate::url_circuit::write_exec_mode_to_url(self.exec_mode);
        }
        self.update_qubit_count();
        self.dragging = None;
        self.dragging_live_snap = None;
        self.dragging_live_display_snap = false;
        self.dragging_live_gpu_plan_touched = false;
        self.drag_state_count = None;
        self.span_resize_drag = None;
        self.hovered_gate_id = None;
        self.hovered_probability_outcome = None;
        self.hovered_amplitude_outcome = None;
        self.hovered_density_cell = None;
        self.hovered_palette_index = None;
        self.hovered_span_resize_handle = None;
        self.hovered_step = None;
        self.angle_affordance = None;
        self.angle_editor = None;
        self.breakpoint_step = None;
        self.drag_cursor_pos = None;
        self.drag_repaint_deadline = None;
        self.drag_repaint_pending = false;
        self.external_gpu_status = ExternalGpuStatus::Idle;
        self.external_gpu_started_at = None;
        self.external_gpu_state_refresh_pending = false;
        self.external_gpu_amplitude_uploads = None;
        self.external_gpu_bloch_uploads = None;
        self.external_gpu_probability_uploads = None;
        self.external_gpu_density_uploads = None;
        self.pending_external_amplitude_slots.clear();
        self.pending_external_bloch_slots.clear();
        self.pending_external_probability_slots.clear();
        self.pending_external_density_slots.clear();
        self.pending_external_gpu_run_id = None;
        self.gpu_plan.mark_dirty();
        self.clear_gpu_plan_capacity_error();
        ctx.request_repaint();
    }
}

#[cfg(test)]
mod tests {
    use super::CircuitRevision;

    #[test]
    fn undo_while_working_cancels_in_progress_commit() {
        let mut revision = CircuitRevision::starting_at("a".to_owned());
        revision.commit("b".to_owned());
        revision.started_working_on_commit();

        let undo_result = revision.undo();
        assert_eq!(
            (undo_result, revision),
            (
                Some("b".to_owned()),
                CircuitRevision {
                    history: vec!["a".to_owned(), "b".to_owned()],
                    index: 1,
                    is_working_on_commit: false,
                }
            )
        );
    }

    #[test]
    fn committing_after_undo_discards_redo_tail() {
        let mut revision = CircuitRevision::starting_at("a".to_owned());
        revision.commit("b".to_owned());
        revision.commit("c".to_owned());
        let undo_result = revision.undo();

        revision.commit("d".to_owned());
        let redo_result = revision.redo();

        assert_eq!(
            (
                undo_result,
                revision.is_at_end_of_history(),
                redo_result,
                revision
            ),
            (
                Some("b".to_owned()),
                true,
                None,
                CircuitRevision {
                    history: vec!["a".to_owned(), "b".to_owned(), "d".to_owned()],
                    index: 2,
                    is_working_on_commit: false,
                }
            )
        );
    }

    #[test]
    fn redo_at_end_preserves_work_in_progress() {
        let mut revision = CircuitRevision::starting_at("a".to_owned());
        revision.commit("b".to_owned());
        revision.started_working_on_commit();

        let redo_result = revision.redo();
        assert_eq!(
            (redo_result, revision),
            (
                None,
                CircuitRevision {
                    history: vec!["a".to_owned(), "b".to_owned()],
                    index: 1,
                    is_working_on_commit: true,
                }
            )
        );
    }
}
