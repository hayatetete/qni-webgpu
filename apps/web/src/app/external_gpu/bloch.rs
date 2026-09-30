use std::sync::Arc;

use crate::app::{CircuitColumnIndex, WireIndex};
use crate::gates::{ColumnControls, GateKind};
use crate::gpu::{ExternalBlochUpload, ExternalBlochUploadBatch};
use crate::simulation_plan::SimulationColumnAnalysis;

pub(super) struct ExternalBlochRequest {
    pub(super) gate_id: u32,
    pub(super) column: CircuitColumnIndex,
    pub(super) wire: WireIndex,
    pub(super) controls: ColumnControls,
}

pub(super) fn collect_bloch_requests(
    analysis: &SimulationColumnAnalysis<'_>,
) -> Vec<ExternalBlochRequest> {
    let mut requests = Vec::new();
    for column in analysis.columns() {
        for display in column.displays(GateKind::BlochDisplay) {
            requests.push(ExternalBlochRequest {
                gate_id: display.id.as_u32(),
                column: CircuitColumnIndex::new(column.slot),
                wire: display.wire,
                controls: column.controls(),
            });
        }
    }
    requests
}

pub(super) fn bloch_requests_json(requests: &[ExternalBlochRequest]) -> String {
    let entries: Vec<String> = requests
        .iter()
        .map(|request| {
            format!(
                concat!(
                    "{{\"gate_id\":{},\"column\":{},\"wire\":{}",
                    ",\"control_mask\":{},\"control_value\":{}}}"
                ),
                request.gate_id,
                request.column.as_usize(),
                request.wire.as_usize(),
                request.controls.mask(),
                request.controls.value()
            )
        })
        .collect();
    format!("[{}]", entries.join(","))
}

pub(super) fn bloch_slot_to_gate_id(requests: &[ExternalBlochRequest]) -> Vec<u32> {
    requests.iter().map(|request| request.gate_id).collect()
}

pub(super) fn parse_bloch_upload_batch(
    message: &str,
    generation: u64,
    slot_to_gate_id: &[u32],
) -> Option<ExternalBlochUploadBatch> {
    if slot_to_gate_id.is_empty() {
        return None;
    }
    parse_bloch_upload_batch_impl(message, generation, slot_to_gate_id)
}

#[cfg(target_arch = "wasm32")]
fn parse_bloch_upload_batch_impl(
    message: &str,
    generation: u64,
    slot_to_gate_id: &[u32],
) -> Option<ExternalBlochUploadBatch> {
    use wasm_bindgen::JsCast;

    if slot_to_gate_id.len() > crate::gpu::MAX_BLOCH_SLOTS {
        return None;
    }
    let root = js_sys::JSON::parse(message).ok()?;
    let bloch = js_sys::Reflect::get(&root, &wasm_bindgen::JsValue::from_str("bloch"))
        .ok()?
        .dyn_into::<js_sys::Array>()
        .ok()?;
    let mut uploads = Vec::new();
    let mut seen_slots = vec![false; slot_to_gate_id.len()];
    for value in bloch.iter() {
        let gate_id = js_u32_prop(&value, "gate_id")?;
        let slot_index = slot_to_gate_id.iter().position(|id| *id == gate_id)?;
        if slot_index >= crate::gpu::MAX_BLOCH_SLOTS || seen_slots[slot_index] {
            return None;
        }
        seen_slots[slot_index] = true;
        let vector = js_array_prop(&value, "vector")?;
        if vector.length() < 3 {
            return None;
        }
        uploads.push(ExternalBlochUpload {
            slot: slot_index as u32,
            vector: [
                vector.get(0).as_f64()? as f32,
                vector.get(1).as_f64()? as f32,
                vector.get(2).as_f64()? as f32,
                0.0,
            ],
        });
    }
    if uploads.len() != slot_to_gate_id.len() || seen_slots.iter().any(|seen| !*seen) {
        return None;
    }
    Some(ExternalBlochUploadBatch {
        generation,
        slot_to_gate_id: Arc::from(slot_to_gate_id.to_vec().into_boxed_slice()),
        uploads: Arc::from(uploads.into_boxed_slice()),
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn parse_bloch_upload_batch_impl(
    _message: &str,
    _generation: u64,
    _slot_to_gate_id: &[u32],
) -> Option<ExternalBlochUploadBatch> {
    None
}

#[cfg(target_arch = "wasm32")]
fn js_array_prop(value: &wasm_bindgen::JsValue, name: &str) -> Option<js_sys::Array> {
    use wasm_bindgen::JsCast;

    js_sys::Reflect::get(value, &wasm_bindgen::JsValue::from_str(name))
        .ok()?
        .dyn_into::<js_sys::Array>()
        .ok()
}

#[cfg(target_arch = "wasm32")]
fn js_u32_prop(value: &wasm_bindgen::JsValue, name: &str) -> Option<u32> {
    let raw = js_sys::Reflect::get(value, &wasm_bindgen::JsValue::from_str(name))
        .ok()?
        .as_f64()?;
    if raw < 0.0 || raw > u32::MAX as f64 {
        return None;
    }
    Some(raw as u32)
}

#[cfg(test)]
mod tests {
    use super::{bloch_requests_json, bloch_slot_to_gate_id, collect_bloch_requests};
    use crate::app::PlacedGate;
    use crate::gates::GateKind;
    use crate::qubit_count::QubitCount;

    fn qubit_count(value: usize) -> QubitCount {
        QubitCount::try_new(value).expect("test qubit count must be non-zero")
    }

    fn requests(gates: &[PlacedGate], qubits: QubitCount) -> Vec<super::ExternalBlochRequest> {
        let columns = crate::simulation_plan::SimulationColumnAnalysis::from_gates(gates, qubits);
        collect_bloch_requests(&columns)
    }

    #[test]
    fn serializes_bloch_output_request() {
        let requests = requests(
            &[PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::BlochDisplay,
                crate::app::CircuitColumnIndex::new(1),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            )],
            qubit_count(1),
        );

        assert_eq!(
            bloch_requests_json(&requests),
            r#"[{"gate_id":2,"column":1,"wire":0,"control_mask":0,"control_value":0}]"#,
        );
    }

    #[test]
    fn serializes_bloch_controls() {
        let requests = requests(
            &[
                PlacedGate::new(
                    crate::app::GateId::from_u32(1),
                    GateKind::Control,
                    crate::app::CircuitColumnIndex::new(2),
                    crate::app::WireIndex::new(0),
                    crate::gates::GateSpan::SINGLE,
                    None,
                ),
                PlacedGate::new(
                    crate::app::GateId::from_u32(2),
                    GateKind::AntiControl,
                    crate::app::CircuitColumnIndex::new(2),
                    crate::app::WireIndex::new(1),
                    crate::gates::GateSpan::SINGLE,
                    None,
                ),
                PlacedGate::new(
                    crate::app::GateId::from_u32(3),
                    GateKind::BlochDisplay,
                    crate::app::CircuitColumnIndex::new(2),
                    crate::app::WireIndex::new(2),
                    crate::gates::GateSpan::SINGLE,
                    None,
                ),
            ],
            qubit_count(3),
        );

        assert_eq!(
            bloch_requests_json(&requests),
            r#"[{"gate_id":3,"column":2,"wire":2,"control_mask":3,"control_value":1}]"#,
        );
    }

    #[test]
    fn external_bloch_slot_matches_collection_order() {
        let requests = requests(
            &[
                PlacedGate::new(
                    crate::app::GateId::from_u32(4),
                    GateKind::BlochDisplay,
                    crate::app::CircuitColumnIndex::new(1),
                    crate::app::WireIndex::new(0),
                    crate::gates::GateSpan::SINGLE,
                    None,
                ),
                PlacedGate::new(
                    crate::app::GateId::from_u32(3),
                    GateKind::BlochDisplay,
                    crate::app::CircuitColumnIndex::new(1),
                    crate::app::WireIndex::new(1),
                    crate::gates::GateSpan::SINGLE,
                    None,
                ),
            ],
            qubit_count(2),
        );

        assert_eq!(bloch_slot_to_gate_id(&requests), vec![3, 4]);
    }
}
