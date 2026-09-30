mod app;
mod circuit_library;
mod colors;
mod constants;
mod gates;
mod gpu;
mod grid_cell;
mod icons;
mod layout;
mod qubit_bit;
mod qubit_count;
mod render;
mod shared;
mod simulation_plan;
mod span_resize;
mod test_hooks;
mod url_circuit;

use crate::app::QniApp;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::JsCast;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn start(canvas_id: &str) -> Result<(), wasm_bindgen::JsValue> {
    let window =
        web_sys::window().ok_or_else(|| wasm_bindgen::JsValue::from_str("window not found"))?;
    let document = window
        .document()
        .ok_or_else(|| wasm_bindgen::JsValue::from_str("document not found"))?;
    let canvas = document
        .get_element_by_id(canvas_id)
        .ok_or_else(|| wasm_bindgen::JsValue::from_str("canvas not found"))?
        .dyn_into::<web_sys::HtmlCanvasElement>()?;

    crate::test_hooks::set_startup_stage("runner-start");
    let web_options = eframe::WebOptions::default();
    eframe::WebRunner::new()
        .start(
            canvas,
            web_options,
            Box::new(|cc| {
                crate::test_hooks::set_startup_stage("app-new");
                Ok(Box::new(QniApp::new(cc)))
            }),
        )
        .await
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn read_state_vector() -> Result<js_sys::Float32Array, wasm_bindgen::JsValue> {
    gpu::read_state_vector_impl().await
}

/// Test-only on-demand readback for Bloch vectors. Triggers a fresh
/// staging-buffer copy + `map_async` against `bloch_output_buffer` and
/// returns `[gate_id, x, y, z, …]` once the GPU finishes. Production code
/// never calls this — the rendering shaders read the same buffer directly.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn read_bloch_vectors() -> Result<js_sys::Float32Array, wasm_bindgen::JsValue> {
    gpu::read_bloch_vectors_impl().await
}

/// Test-only on-demand readback for measurement outcomes. Returns
/// `[gate_id, outcome, …]` (outcome is `0.0` or `1.0`).
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn read_measurement_outcomes() -> Result<js_sys::Float32Array, wasm_bindgen::JsValue> {
    gpu::read_measurement_outcomes_impl().await
}

/// Test-only on-demand readback for Probability display probabilities. Returns
/// `[gate_id, p0, p1, ..., p65535, ...]` for each live Probability slot.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn read_probability_distributions() -> Result<js_sys::Float32Array, wasm_bindgen::JsValue>
{
    gpu::read_probability_distributions_impl().await
}

/// Test-only on-demand readback for one Amplitude display cell. Returns
/// `[gate_id, outcome, re, im, incoherent, quality, phaseLockIndex, span]`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn read_amplitude_cell(
    gate_id: u32,
    outcome: u32,
) -> Result<js_sys::Float64Array, wasm_bindgen::JsValue> {
    gpu::read_amplitude_cell_impl(gate_id, outcome).await
}

/// Test-only on-demand readback for one Density Matrix display cell. Returns
/// `[gate_id, row, col, re, im, unity, span]` with `re`/`im` normalized by trace.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn read_density_matrix_cell(
    gate_id: u32,
    row: u32,
    col: u32,
) -> Result<js_sys::Float64Array, wasm_bindgen::JsValue> {
    gpu::read_density_matrix_cell_impl(gate_id, row, col).await
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn circuit_library_list() -> Result<String, wasm_bindgen::JsValue> {
    circuit_library::list()
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn circuit_library_save(
    name: &str,
    circuit_json: &str,
) -> Result<String, wasm_bindgen::JsValue> {
    circuit_library::save(name, circuit_json)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn circuit_library_load(id: &str) -> Result<String, wasm_bindgen::JsValue> {
    circuit_library::load(id)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn circuit_library_rename(id: &str, name: &str) -> Result<(), wasm_bindgen::JsValue> {
    circuit_library::rename(id, name)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn circuit_library_delete(id: &str) -> Result<(), wasm_bindgen::JsValue> {
    circuit_library::delete(id)
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn circuit_library_clear() -> Result<(), wasm_bindgen::JsValue> {
    circuit_library::clear()
}
