//! Central names and helpers for wasm debug/test hooks.
//!
//! Browser globals are intentionally limited to Playwright/Cucumber support and
//! debug geometry probes. Keep hook names here so Rust publishers and TS tests
//! do not grow independent string literals.

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::JsValue;

pub(crate) const QNI_ASPECT_POPOVER_GEOMETRY_JSON: &str = "__qniAspectPopoverGeometryJson";
pub(crate) const QNI_APPLY_URL_PAYLOAD: &str = "__qniApplyUrlPayload";
pub(crate) const QNI_CIRCUIT_LIBRARY_DELETE: &str = "__qniCircuitLibraryDelete";
pub(crate) const QNI_CIRCUIT_LIBRARY_LOAD: &str = "__qniCircuitLibraryLoad";
pub(crate) const QNI_CIRCUIT_LIBRARY_RENAME: &str = "__qniCircuitLibraryRename";
pub(crate) const QNI_CIRCUIT_LIBRARY_SAVE: &str = "__qniCircuitLibrarySave";
pub(crate) const QNI_CIRCUIT_PICKER_DROPDOWN_GEOMETRY_JSON: &str =
    "__qniCircuitPickerDropdownGeometryJson";
pub(crate) const QNI_CIRCUIT_PICKER_GEOMETRY_JSON: &str = "__qniCircuitPickerGeometryJson";
pub(crate) const QNI_CIRCUIT_PICKER_RESIZE_GEOMETRY_JSON: &str =
    "__qniCircuitPickerResizeGeometryJson";
pub(crate) const QNI_CIRCUIT_PICKER_RENAME_GEOMETRY_JSON: &str =
    "__qniCircuitPickerRenameGeometryJson";
pub(crate) const QNI_CIRCUIT_PICKER_SNAPSHOT: &str = "__qniCircuitPickerSnapshot";
pub(crate) const QNI_GPU_PLAN_CAPACITY_ERROR: &str = "__qniGpuPlanCapacityError";
pub(crate) const QNI_HOVER_SNAPSHOT_JSON: &str = "__qniHoverSnapshotJson";
pub(crate) const QNI_ANGLE_INPUT_GEOMETRY_JSON: &str = "__qniAngleInputGeometryJson";
pub(crate) const QNI_SEED_CIRCUITS: &str = "__seedCircuits";
pub(crate) const QNI_SET_EXTERNAL_GPU_STATUS: &str = "__setExternalGpuStatus";
pub(crate) const QNI_TOOLBAR_DUPLICATE_GEOMETRY_JSON: &str = "__qniToolbarDuplicateGeometryJson";
pub(crate) const QNI_TOOLBAR_LOCK_GEOMETRY_JSON: &str = "__qniToolbarLockGeometryJson";
pub(crate) const QNI_TOOLBAR_SHORTCUT_GEOMETRY_JSON: &str = "__qniToolbarShortcutGeometryJson";
pub(crate) const QNI_TOOLBAR_TOOLTIP_TEXT: &str = "__qniToolbarTooltipText";

#[cfg(target_arch = "wasm32")]
pub(crate) fn set_property(target: &JsValue, name: &str, value: &JsValue) {
    let _ = js_sys::Reflect::set(target, &JsValue::from_str(name), value);
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn set_window_value(name: &str, value: &JsValue) {
    let Some(window) = web_sys::window() else {
        return;
    };
    set_property(window.as_ref(), name, value);
}
