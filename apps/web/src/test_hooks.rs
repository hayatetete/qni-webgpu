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
pub(crate) const QNI_CIRCUIT_SCROLL_X: &str = "__qniCircuitScrollX";
pub(crate) const QNI_GPU_PLAN_CAPACITY_ERROR: &str = "__qniGpuPlanCapacityError";
pub(crate) const QNI_HOVER_SNAPSHOT_JSON: &str = "__qniHoverSnapshotJson";
pub(crate) const QNI_ANGLE_INPUT_GEOMETRY_JSON: &str = "__qniAngleInputGeometryJson";
pub(crate) const QNI_SEED_CIRCUITS: &str = "__seedCircuits";
pub(crate) const QNI_SET_EXTERNAL_GPU_STATUS: &str = "__setExternalGpuStatus";
pub(crate) const QNI_TOOLBAR_DUPLICATE_GEOMETRY_JSON: &str = "__qniToolbarDuplicateGeometryJson";
pub(crate) const QNI_TOOLBAR_LOCK_GEOMETRY_JSON: &str = "__qniToolbarLockGeometryJson";
pub(crate) const QNI_TOOLBAR_SHORTCUT_GEOMETRY_JSON: &str = "__qniToolbarShortcutGeometryJson";
pub(crate) const QNI_TOOLBAR_TOOLTIP_TEXT: &str = "__qniToolbarTooltipText";

/// 起動完了フラグ。最初のフレームを描画した時点で立てる。
/// `bootstrap.ts` の `start()` 呼び出し直後に立てると、eframe が canvas の
/// イベントリスナを張る前にテストがクリックしてしまい入力が失われる。
pub(crate) const QNI_EGUI_READY: &str = "__eguiReady";

/// 起動の進行段階。起動が固まったときに、どこで止まったかを切り分けるために publish する。
pub(crate) const QNI_STARTUP_STAGE: &str = "__qniStartupStage";

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

/// 最初のフレーム描画後に一度だけ起動完了フラグを立てる。
#[cfg(target_arch = "wasm32")]
pub(crate) fn mark_egui_ready() {
    use std::sync::atomic::{AtomicBool, Ordering};

    static PUBLISHED: AtomicBool = AtomicBool::new(false);
    if PUBLISHED.swap(true, Ordering::Relaxed) {
        return;
    }
    set_window_value(QNI_EGUI_READY, &JsValue::TRUE);
    set_startup_stage("first-frame");
}

/// 起動の進行段階を publish する。値は `runner-start` / `app-new` / `first-frame`。
#[cfg(target_arch = "wasm32")]
pub(crate) fn set_startup_stage(stage: &str) {
    set_window_value(QNI_STARTUP_STAGE, &JsValue::from_str(stage));
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn set_startup_stage(_stage: &str) {}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn mark_egui_ready() {}
