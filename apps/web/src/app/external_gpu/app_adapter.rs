use std::time::Duration;

use eframe::egui;

use super::amplitude::{
    amplitude_requests_json, amplitude_slot_to_gate_id, collect_amplitude_requests,
    parse_amplitude_upload_batch,
};
use super::bloch::{
    bloch_requests_json, bloch_slot_to_gate_id, collect_bloch_requests, parse_bloch_upload_batch,
};
use super::client::{start_qiskit_run, take_qiskit_run_result};
use super::density::{
    collect_density_requests, density_requests_json, density_slot_to_gate_id,
    parse_density_upload_batch,
};
use super::probability::{
    collect_probability_requests, parse_probability_upload_batch, probability_requests_json,
    probability_slot_to_gate_id,
};
use super::test_hooks::{take_external_gpu_status_override, wire_external_gpu_test_hooks};
use super::{qiskit_run_payload_with_display_outputs, ExternalGpuStatus, GpuFailure, Shots};
use super::{ExecMode, QniApp};
use crate::app::{circuit_library, PlacedGate};
use crate::gates::GateKind;
use crate::gpu::{MAX_AMPLITUDE_SLOTS, MAX_BLOCH_SLOTS, MAX_DENSITY_SLOTS, MAX_PROBABILITY_SLOTS};
use crate::shared::now_seconds;

struct ExternalGpuRunRequest {
    payload: String,
    amplitude_slot_to_gate_id: Vec<u32>,
    bloch_slot_to_gate_id: Vec<u32>,
    probability_slot_to_gate_id: Vec<u32>,
    density_slot_to_gate_id: Vec<u32>,
}

fn supported_external_controlled_target(kind: GateKind) -> bool {
    matches!(
        kind,
        GateKind::H
            | GateKind::X
            | GateKind::Y
            | GateKind::Z
            | GateKind::SqrtX
            | GateKind::S
            | GateKind::SDagger
            | GateKind::T
            | GateKind::TDagger
            | GateKind::Phase
            | GateKind::Rx
            | GateKind::Ry
            | GateKind::Rz
            | GateKind::Write0
            | GateKind::Write1
    )
}

fn unsupported_external_gpu_gate_for_gates(placed_gates: &[PlacedGate]) -> Option<&'static str> {
    for gate in placed_gates {
        let name = match gate.kind {
            GateKind::AntiControl => None,
            GateKind::BlochDisplay => None,
            GateKind::Measurement => None,
            GateKind::ProbabilityDisplay => None,
            GateKind::AmplitudeDisplay => None,
            GateKind::DensityMatrixDisplay => None,
            GateKind::Spacer => None,
            GateKind::Write0 => None,
            GateKind::Write1 => None,
            GateKind::Swap => None,
            GateKind::QftGate | GateKind::QftDaggerGate => None,
            _ => None,
        };
        if let Some(name) = name {
            return Some(name);
        }
    }

    let max_column = placed_gates
        .iter()
        .map(|gate| gate.column.as_usize())
        .max()?;
    for column in 0..=max_column {
        let mut has_control = false;
        let mut unsupported_controlled_target = None;
        for gate in placed_gates
            .iter()
            .filter(|gate| gate.column.as_usize() == column)
        {
            if matches!(gate.kind, GateKind::Control | GateKind::AntiControl) {
                has_control = true;
            } else if supported_external_controlled_target(gate.kind)
                || matches!(
                    gate.kind,
                    GateKind::Measurement
                        | GateKind::QftGate
                        | GateKind::QftDaggerGate
                        | GateKind::Swap
                        | GateKind::AmplitudeDisplay
                        | GateKind::BlochDisplay
                        | GateKind::ProbabilityDisplay
                        | GateKind::DensityMatrixDisplay
                )
            {
            } else if !matches!(gate.kind, GateKind::Spacer) {
                unsupported_controlled_target = Some(gate.kind.label());
            }
        }
        if has_control {
            if let Some(label) = unsupported_controlled_target {
                return Some(label);
            }
        }
    }
    None
}

impl QniApp {
    pub(crate) fn external_gpu_status(&self) -> &ExternalGpuStatus {
        &self.external_gpu_status
    }

    pub(crate) fn poll_external_gpu_run(&mut self, ctx: &egui::Context) {
        if let Some(status) = take_external_gpu_status_override() {
            self.apply_external_gpu_status(status, ctx);
        }
        if let Some((run_id, result)) = take_qiskit_run_result() {
            if self.pending_external_gpu_run_id != Some(run_id) {
                return;
            }
            self.pending_external_gpu_run_id = None;
            let status = match result {
                Ok(message) => self.complete_external_gpu_run(&message),
                Err(failure) => {
                    self.external_gpu_started_at = None;
                    self.pending_external_amplitude_slots.clear();
                    self.pending_external_bloch_slots.clear();
                    self.pending_external_probability_slots.clear();
                    self.pending_external_density_slots.clear();
                    ExternalGpuStatus::Failed(failure)
                }
            };
            self.apply_external_gpu_status(status, ctx);
        }
    }

    fn apply_external_gpu_status(&mut self, status: ExternalGpuStatus, ctx: &egui::Context) {
        match &status {
            ExternalGpuStatus::Idle | ExternalGpuStatus::Failed(_) => {
                self.external_gpu_started_at = None;
            }
            ExternalGpuStatus::Running => {
                if self.external_gpu_started_at.is_none() {
                    self.external_gpu_started_at = Some(now_seconds());
                }
            }
            ExternalGpuStatus::Completed { .. } => {
                self.external_gpu_started_at = None;
                if self.external_gpu_amplitude_uploads.is_none()
                    && self.external_gpu_bloch_uploads.is_none()
                    && self.external_gpu_probability_uploads.is_none()
                    && self.external_gpu_density_uploads.is_none()
                {
                    self.request_external_gpu_state_panel_refresh();
                }
            }
        }
        self.external_gpu_status = status;
        ctx.request_repaint();
    }

    fn take_external_gpu_duration(&mut self) -> Duration {
        let started_at = self
            .external_gpu_started_at
            .take()
            .unwrap_or_else(now_seconds);
        Duration::from_secs_f64((now_seconds() - started_at).max(0.0))
    }

    fn request_external_gpu_state_panel_refresh(&mut self) {
        if !self.local_exec_mode_available() {
            return;
        }
        if self.exec_mode == ExecMode::Gpu {
            self.external_gpu_state_refresh_pending = true;
        }
        self.gpu_plan.mark_dirty();
    }

    pub(crate) fn start_external_gpu_run(&mut self, ctx: &egui::Context) {
        if self.external_gpu_status.is_running() {
            return;
        }
        if let Some(gate_name) = self.unsupported_external_gpu_gate() {
            self.pending_external_gpu_run_id = None;
            self.pending_external_amplitude_slots.clear();
            self.pending_external_bloch_slots.clear();
            self.pending_external_probability_slots.clear();
            self.pending_external_density_slots.clear();
            self.external_gpu_status =
                ExternalGpuStatus::Failed(GpuFailure::UnsupportedGate(gate_name.to_owned()));
            ctx.request_repaint();
            return;
        }

        let request = match self.external_gpu_run_request() {
            Ok(request) => request,
            Err(message) => {
                self.pending_external_gpu_run_id = None;
                self.pending_external_amplitude_slots.clear();
                self.pending_external_bloch_slots.clear();
                self.pending_external_probability_slots.clear();
                self.pending_external_density_slots.clear();
                self.external_gpu_status = ExternalGpuStatus::Failed(GpuFailure::Other(message));
                ctx.request_repaint();
                return;
            }
        };
        if request.amplitude_slot_to_gate_id.len() > MAX_AMPLITUDE_SLOTS {
            self.pending_external_gpu_run_id = None;
            self.pending_external_amplitude_slots.clear();
            self.pending_external_bloch_slots.clear();
            self.pending_external_probability_slots.clear();
            self.pending_external_density_slots.clear();
            self.external_gpu_status = ExternalGpuStatus::Failed(GpuFailure::Other(format!(
                "at most {MAX_AMPLITUDE_SLOTS} Amplitude displays"
            )));
            ctx.request_repaint();
            return;
        }
        if request.bloch_slot_to_gate_id.len() > MAX_BLOCH_SLOTS {
            self.pending_external_gpu_run_id = None;
            self.pending_external_amplitude_slots.clear();
            self.pending_external_bloch_slots.clear();
            self.pending_external_probability_slots.clear();
            self.pending_external_density_slots.clear();
            self.external_gpu_status = ExternalGpuStatus::Failed(GpuFailure::Other(format!(
                "at most {MAX_BLOCH_SLOTS} Bloch displays"
            )));
            ctx.request_repaint();
            return;
        }
        if request.probability_slot_to_gate_id.len() > MAX_PROBABILITY_SLOTS {
            self.pending_external_gpu_run_id = None;
            self.pending_external_amplitude_slots.clear();
            self.pending_external_bloch_slots.clear();
            self.pending_external_probability_slots.clear();
            self.pending_external_density_slots.clear();
            self.external_gpu_status = ExternalGpuStatus::Failed(GpuFailure::Other(format!(
                "at most {MAX_PROBABILITY_SLOTS} Probability displays"
            )));
            ctx.request_repaint();
            return;
        }
        if request.density_slot_to_gate_id.len() > MAX_DENSITY_SLOTS {
            self.pending_external_gpu_run_id = None;
            self.pending_external_amplitude_slots.clear();
            self.pending_external_bloch_slots.clear();
            self.pending_external_probability_slots.clear();
            self.pending_external_density_slots.clear();
            self.external_gpu_status = ExternalGpuStatus::Failed(GpuFailure::Other(format!(
                "at most {MAX_DENSITY_SLOTS} Density Matrix displays"
            )));
            ctx.request_repaint();
            return;
        }
        self.pending_external_amplitude_slots = request.amplitude_slot_to_gate_id;
        self.pending_external_bloch_slots = request.bloch_slot_to_gate_id;
        self.pending_external_probability_slots = request.probability_slot_to_gate_id;
        self.pending_external_density_slots = request.density_slot_to_gate_id;
        self.external_gpu_amplitude_uploads = None;
        self.external_gpu_bloch_uploads = None;
        self.external_gpu_probability_uploads = None;
        self.external_gpu_density_uploads = None;
        self.external_gpu_started_at = Some(now_seconds());
        match start_qiskit_run(request.payload, ctx.clone()) {
            Ok(run_id) => {
                self.pending_external_gpu_run_id = Some(run_id);
                self.external_gpu_status = ExternalGpuStatus::Running;
            }
            Err(failure) => {
                self.external_gpu_started_at = None;
                self.pending_external_amplitude_slots.clear();
                self.pending_external_bloch_slots.clear();
                self.pending_external_probability_slots.clear();
                self.pending_external_density_slots.clear();
                self.pending_external_gpu_run_id = None;
                self.external_gpu_status = ExternalGpuStatus::Failed(failure);
            }
        }
        ctx.request_repaint();
    }

    fn unsupported_external_gpu_gate(&self) -> Option<&'static str> {
        unsupported_external_gpu_gate_for_gates(&self.placed_gates)
    }

    fn complete_external_gpu_run(&mut self, message: &str) -> ExternalGpuStatus {
        let duration = self.take_external_gpu_duration();
        let has_display_outputs = !self.pending_external_amplitude_slots.is_empty()
            || !self.pending_external_bloch_slots.is_empty()
            || !self.pending_external_probability_slots.is_empty()
            || !self.pending_external_density_slots.is_empty();
        if has_display_outputs {
            self.external_gpu_display_generation += 1;
        }
        let amplitude_batch = if self.pending_external_amplitude_slots.is_empty() {
            None
        } else {
            let Some(batch) = parse_amplitude_upload_batch(
                message,
                self.external_gpu_display_generation,
                &self.pending_external_amplitude_slots,
            ) else {
                self.pending_external_amplitude_slots.clear();
                self.pending_external_bloch_slots.clear();
                self.pending_external_probability_slots.clear();
                self.pending_external_density_slots.clear();
                return ExternalGpuStatus::Failed(GpuFailure::Other(
                    "Amplitude result missing".to_owned(),
                ));
            };
            Some(batch)
        };
        let bloch_batch = if self.pending_external_bloch_slots.is_empty() {
            None
        } else {
            let Some(batch) = parse_bloch_upload_batch(
                message,
                self.external_gpu_display_generation,
                &self.pending_external_bloch_slots,
            ) else {
                self.pending_external_amplitude_slots.clear();
                self.pending_external_bloch_slots.clear();
                self.pending_external_probability_slots.clear();
                self.pending_external_density_slots.clear();
                return ExternalGpuStatus::Failed(GpuFailure::Other(
                    "Bloch result missing".to_owned(),
                ));
            };
            Some(batch)
        };
        let probability_batch = if self.pending_external_probability_slots.is_empty() {
            None
        } else {
            let Some(batch) = parse_probability_upload_batch(
                message,
                self.external_gpu_display_generation,
                &self.pending_external_probability_slots,
            ) else {
                self.pending_external_amplitude_slots.clear();
                self.pending_external_bloch_slots.clear();
                self.pending_external_probability_slots.clear();
                self.pending_external_density_slots.clear();
                return ExternalGpuStatus::Failed(GpuFailure::Other(
                    "Probability result missing".to_owned(),
                ));
            };
            Some(batch)
        };
        let density_batch = if self.pending_external_density_slots.is_empty() {
            None
        } else {
            let Some(batch) = parse_density_upload_batch(
                message,
                self.external_gpu_display_generation,
                &self.pending_external_density_slots,
            ) else {
                self.pending_external_amplitude_slots.clear();
                self.pending_external_bloch_slots.clear();
                self.pending_external_probability_slots.clear();
                self.pending_external_density_slots.clear();
                return ExternalGpuStatus::Failed(GpuFailure::Other(
                    "Density result missing".to_owned(),
                ));
            };
            Some(batch)
        };
        self.external_gpu_amplitude_uploads = amplitude_batch;
        self.external_gpu_bloch_uploads = bloch_batch;
        self.external_gpu_probability_uploads = probability_batch;
        self.external_gpu_density_uploads = density_batch;
        if has_display_outputs {
            self.gpu_plan.replace_external_display_slots(
                &self.pending_external_amplitude_slots,
                &self.pending_external_bloch_slots,
                &self.pending_external_probability_slots,
                &self.pending_external_density_slots,
                self.state_count(),
            );
        }
        self.pending_external_amplitude_slots.clear();
        self.pending_external_bloch_slots.clear();
        self.pending_external_probability_slots.clear();
        self.pending_external_density_slots.clear();
        ExternalGpuStatus::Completed { duration }
    }

    fn external_gpu_run_request(&self) -> Result<ExternalGpuRunRequest, String> {
        let qubits = self
            .external_execution_qubits()
            .map_err(|_| "qubit count exceeds external GPU capacity (32)".to_owned())?;
        let columns_json = crate::url_circuit::circuit_columns_to_json(&self.placed_gates, qubits);
        let columns = crate::simulation_plan::SimulationColumnAnalysis::from_gates(
            &self.placed_gates,
            qubits,
        );
        let amplitude_requests = collect_amplitude_requests(&columns, qubits);
        let bloch_requests = collect_bloch_requests(&columns);
        let probability_requests = collect_probability_requests(&columns, qubits);
        let density_requests = collect_density_requests(&columns, qubits);
        let amplitudes_json = amplitude_requests_json(&amplitude_requests);
        let bloch_json = bloch_requests_json(&bloch_requests);
        let probability_json = probability_requests_json(&probability_requests);
        let densities_json = density_requests_json(&density_requests);
        Ok(ExternalGpuRunRequest {
            payload: qiskit_run_payload_with_display_outputs(
                qubits.get(),
                &columns_json,
                Shots::DEFAULT,
                &amplitudes_json,
                &bloch_json,
                &probability_json,
                &densities_json,
            ),
            amplitude_slot_to_gate_id: amplitude_slot_to_gate_id(&amplitude_requests),
            bloch_slot_to_gate_id: bloch_slot_to_gate_id(&bloch_requests),
            probability_slot_to_gate_id: probability_slot_to_gate_id(&probability_requests),
            density_slot_to_gate_id: density_slot_to_gate_id(&density_requests),
        })
    }

    pub(crate) fn wire_test_hooks(ctx: &egui::Context) {
        wire_external_gpu_test_hooks(ctx);
        circuit_library::wire_test_hooks(ctx);
    }
}

#[cfg(test)]
mod tests {
    use super::unsupported_external_gpu_gate_for_gates;
    use crate::app::PlacedGate;
    use crate::gates::GateKind;

    #[test]
    fn external_gpu_accepts_write0_gate() {
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Write0,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        )];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_write1_gate() {
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Write1,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        )];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_controlled_write0_gate() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::Write0,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_anti_controlled_write1_gate() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::AntiControl,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::Write1,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_swap_gate() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Swap,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::Swap,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_spacer_gate() {
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Spacer,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        )];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_measurement_gate() {
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Measurement,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        )];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_anti_controlled_x_gate() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::AntiControl,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::X,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_lone_control_column() {
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Control,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        )];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_control_only_column() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_anti_control_only_column() {
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::AntiControl,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        )];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_anti_controlled_h_gate() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::AntiControl,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::H,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_controlled_sqrt_x_gate() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::SqrtX,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_controlled_measurement_gate() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::Measurement,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_anti_controlled_measurement_gate() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::AntiControl,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::Measurement,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_qft_gate() {
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::QftGate,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::try_new(2).unwrap(),
            None,
        )];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_qft_dagger_gate() {
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::QftDaggerGate,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::try_new(2).unwrap(),
            None,
        )];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_controlled_qft_gate() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::QftGate,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::try_new(2).unwrap(),
                None,
            ),
        ];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_controlled_qft_dagger_gate() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::AntiControl,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::QftDaggerGate,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::try_new(2).unwrap(),
                None,
            ),
        ];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_controlled_swap_gate() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::Swap,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(3),
                GateKind::Swap,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(2),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }

    #[test]
    fn external_gpu_accepts_controlled_density_display() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::DensityMatrixDisplay,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        assert_eq!(unsupported_external_gpu_gate_for_gates(&gates), None);
    }
}
