use std::sync::Arc;

use crate::app::CircuitColumnIndex;
use crate::gates::{ColumnControls, GateKind};
use crate::gpu::{ExternalDensityUpload, ExternalDensityUploadBatch};
use crate::qubit_bit::QubitBit;
use crate::qubit_count::QubitCount;
use crate::simulation_plan::SimulationColumnAnalysis;

pub(super) struct ExternalDensityRequest {
    pub(super) gate_id: u32,
    pub(super) column: CircuitColumnIndex,
    pub(super) span: usize,
    pub(super) base_bit: QubitBit,
    pub(super) controls: ColumnControls,
}

pub(super) fn collect_density_requests(
    analysis: &SimulationColumnAnalysis<'_>,
    qubits: QubitCount,
) -> Vec<ExternalDensityRequest> {
    let n = qubits.get();
    let mut requests = Vec::new();
    for column in analysis.columns() {
        for display in column.displays(GateKind::DensityMatrixDisplay) {
            let span = display
                .span
                .clamped_for(display.kind, n - display.wire.as_usize());
            // span 内の最下位ビット = 上端ワイヤ（q0=LSB なので wire がそのままビット位置）。
            // outcome の bit j は base_bit + j = 上端から j 本目のワイヤに対応する。
            let base_bit = display
                .wire
                .to_qubit_bit(qubits)
                .expect("display wire is within the register");
            requests.push(ExternalDensityRequest {
                gate_id: display.id.as_u32(),
                column: CircuitColumnIndex::new(column.slot),
                span: span.get(),
                base_bit,
                controls: column.controls(),
            });
        }
    }
    requests
}

pub(super) fn density_requests_json(requests: &[ExternalDensityRequest]) -> String {
    let entries: Vec<String> = requests
        .iter()
        .map(|request| {
            format!(
                concat!(
                    "{{\"gate_id\":{},\"column\":{},\"span\":{}",
                    ",\"base_bit\":{},\"control_mask\":{}",
                    ",\"control_value\":{}}}"
                ),
                request.gate_id,
                request.column.as_usize(),
                request.span,
                request.base_bit.as_u32(),
                request.controls.mask(),
                request.controls.value()
            )
        })
        .collect();
    format!("[{}]", entries.join(","))
}

pub(super) fn density_slot_to_gate_id(requests: &[ExternalDensityRequest]) -> Vec<u32> {
    requests.iter().map(|request| request.gate_id).collect()
}

pub(super) fn parse_density_upload_batch(
    message: &str,
    generation: u64,
    slot_to_gate_id: &[u32],
) -> Option<ExternalDensityUploadBatch> {
    if slot_to_gate_id.is_empty() {
        return None;
    }
    parse_density_upload_batch_impl(message, generation, slot_to_gate_id)
}

#[cfg(target_arch = "wasm32")]
fn parse_density_upload_batch_impl(
    message: &str,
    generation: u64,
    slot_to_gate_id: &[u32],
) -> Option<ExternalDensityUploadBatch> {
    use wasm_bindgen::JsCast;

    if slot_to_gate_id.len() > crate::gpu::MAX_DENSITY_SLOTS {
        return None;
    }
    let root = js_sys::JSON::parse(message).ok()?;
    let densities = js_sys::Reflect::get(&root, &wasm_bindgen::JsValue::from_str("densities"))
        .ok()?
        .dyn_into::<js_sys::Array>()
        .ok()?;
    let mut uploads = Vec::new();
    let mut seen_slots = vec![false; slot_to_gate_id.len()];
    for value in densities.iter() {
        let gate_id = js_u32_prop(&value, "gate_id")?;
        let slot_index = slot_to_gate_id.iter().position(|id| *id == gate_id)?;
        if slot_index >= crate::gpu::MAX_DENSITY_SLOTS || seen_slots[slot_index] {
            return None;
        }
        seen_slots[slot_index] = true;
        let span = js_u32_prop(&value, "span")?;
        if span == 0 || span > 8 {
            return None;
        }
        let dim = 1usize << span;
        let cell_count = dim * dim;
        let cells = js_array_prop(&value, "cells")?;
        if cells.length() < cell_count as u32 {
            return None;
        }
        let mut values = Vec::with_capacity(cell_count * 2);
        for index in 0..cell_count as u32 {
            let pair = cells.get(index).dyn_into::<js_sys::Array>().ok()?;
            values.push(pair.get(0).as_f64()? as f32);
            values.push(pair.get(1).as_f64()? as f32);
        }
        let unity = js_optional_f32_prop(&value, "unity").unwrap_or(1.0);
        uploads.push(ExternalDensityUpload {
            slot: slot_index as u32,
            cells: Arc::from(values.into_boxed_slice()),
            meta: [unity, span as f32, 0.0, 0.0],
        });
    }
    if uploads.len() != slot_to_gate_id.len() || seen_slots.iter().any(|seen| !*seen) {
        return None;
    }
    Some(ExternalDensityUploadBatch {
        generation,
        slot_to_gate_id: Arc::from(slot_to_gate_id.to_vec().into_boxed_slice()),
        uploads: Arc::from(uploads.into_boxed_slice()),
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn parse_density_upload_batch_impl(
    _message: &str,
    _generation: u64,
    _slot_to_gate_id: &[u32],
) -> Option<ExternalDensityUploadBatch> {
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

#[cfg(target_arch = "wasm32")]
fn js_optional_f32_prop(value: &wasm_bindgen::JsValue, name: &str) -> Option<f32> {
    js_sys::Reflect::get(value, &wasm_bindgen::JsValue::from_str(name))
        .ok()?
        .as_f64()
        .map(|raw| raw as f32)
}

#[cfg(test)]
mod tests {
    use super::{collect_density_requests, density_requests_json, density_slot_to_gate_id};
    use crate::app::PlacedGate;
    use crate::gates::GateKind;
    use crate::qubit_count::QubitCount;

    fn qubit_count(value: usize) -> QubitCount {
        QubitCount::try_new(value).expect("test qubit count must be non-zero")
    }

    fn requests(gates: &[PlacedGate], qubits: QubitCount) -> Vec<super::ExternalDensityRequest> {
        let columns = crate::simulation_plan::SimulationColumnAnalysis::from_gates(gates, qubits);
        collect_density_requests(&columns, qubits)
    }

    #[test]
    fn serializes_density_output_request() {
        let requests = requests(
            &[PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::DensityMatrixDisplay,
                crate::app::CircuitColumnIndex::new(1),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            )],
            qubit_count(1),
        );

        assert_eq!(
            density_requests_json(&requests),
            r#"[{"gate_id":2,"column":1,"span":1,"base_bit":0,"control_mask":0,"control_value":0}]"#,
        );
    }

    #[test]
    fn serializes_density_span_base_bit() {
        let requests = requests(
            &[PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::DensityMatrixDisplay,
                crate::app::CircuitColumnIndex::new(1),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::try_new(2).unwrap(),
                None,
            )],
            qubit_count(3),
        );

        assert_eq!(
            density_requests_json(&requests),
            r#"[{"gate_id":2,"column":1,"span":2,"base_bit":0,"control_mask":0,"control_value":0}]"#,
        );
    }

    #[test]
    fn serializes_density_controls() {
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
                    GateKind::DensityMatrixDisplay,
                    crate::app::CircuitColumnIndex::new(2),
                    crate::app::WireIndex::new(2),
                    crate::gates::GateSpan::SINGLE,
                    None,
                ),
            ],
            qubit_count(3),
        );

        assert_eq!(
            density_requests_json(&requests),
            r#"[{"gate_id":3,"column":2,"span":1,"base_bit":2,"control_mask":3,"control_value":1}]"#,
        );
    }

    #[test]
    fn external_density_slot_matches_collection_order() {
        let requests = requests(
            &[
                PlacedGate::new(
                    crate::app::GateId::from_u32(4),
                    GateKind::DensityMatrixDisplay,
                    crate::app::CircuitColumnIndex::new(1),
                    crate::app::WireIndex::new(0),
                    crate::gates::GateSpan::SINGLE,
                    None,
                ),
                PlacedGate::new(
                    crate::app::GateId::from_u32(3),
                    GateKind::DensityMatrixDisplay,
                    crate::app::CircuitColumnIndex::new(1),
                    crate::app::WireIndex::new(1),
                    crate::gates::GateSpan::SINGLE,
                    None,
                ),
            ],
            qubit_count(2),
        );

        assert_eq!(density_slot_to_gate_id(&requests), vec![3, 4]);
    }
}
