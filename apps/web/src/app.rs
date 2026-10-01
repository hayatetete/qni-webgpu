//! App root — `QniApp` state, initialization, and small accessors.
//! Per-frame update order lives in `update_flow`.

mod circuit_clipboard;
mod circuit_history;
pub(crate) mod circuit_library;
mod circuit_model;
pub(crate) mod circuit_picker_state;
mod drag_controller;
mod exec_mode;
mod external_gpu;
mod fps_hud;
mod gate_input;
mod gpu_plan_state;
mod state_panel;
mod state_panel_state;
mod update_flow;

use crate::colors::{Colors, Theme, ThemeKind};
use crate::constants::{LOCAL_MAX_QUBITS, MIN_QUBITS};
use crate::gates::GateKind;
use crate::gpu::{
    ExternalAmplitudeUploadBatch, ExternalBlochUploadBatch, ExternalDensityUploadBatch,
    ExternalProbabilityUploadBatch,
};
use crate::qubit_count::{QubitCapacity, QubitCount};
use crate::shared::now_seconds;
use circuit_history::CircuitRevision;
use circuit_library::CircuitLibrary;
use circuit_picker_state::PickerState;
use eframe::egui;
use std::collections::{BTreeSet, VecDeque};

pub(crate) use circuit_clipboard::{gate_frame_group, selection_frame_groups};
#[allow(unused_imports)]
pub(crate) use circuit_model::{
    AngleAffordance, AngleEditor, CircuitColumnIndex, CircuitColumnIndexError, DragState, GateId,
    GateIdAllocator, LiveDragSnap, PlacedGate, SpanResizeDrag, SpanResizeEdge, SpanResizeHandle,
    WireIndex, WireIndexError,
};
pub(crate) use exec_mode::ExecMode;
pub(crate) use external_gpu::{format_gpu_duration, ExternalGpuStatus};
pub(crate) use gpu_plan_state::GpuPlanState;
pub(crate) use state_panel_state::{ResizeCorner, ResizeDrag, StatePanelState};

pub(crate) struct QniApp {
    theme: ThemeKind,
    circuit_revision: CircuitRevision,
    pub(crate) library: CircuitLibrary,
    pub(crate) picker: PickerState,
    picker_hover_suppressed_at: Option<egui::Pos2>,
    pub(crate) picker_drag_suppressed_until_release: bool,
    pub(crate) picker_submenu_toggle_suppressed_until_release: bool,
    pub(crate) picker_drag_animation_epoch: u64,
    pub(crate) picker_overlay_rect: Option<egui::Rect>,
    gate_ids: GateIdAllocator,
    pub(crate) placed_gates: Vec<PlacedGate>,
    pub(crate) selected_gate_ids: BTreeSet<GateId>,
    circuit_clipboard: Option<circuit_clipboard::CircuitFragment>,
    pub(crate) copy_flash: Option<circuit_clipboard::CopyFlash>,
    pub(crate) paste_flashes: Vec<circuit_clipboard::PasteFlash>,
    pub(crate) paste_error_notice: Option<circuit_clipboard::PasteErrorNotice>,
    pub(crate) circuit_motion: Option<circuit_clipboard::CircuitMotion>,
    circuit_scroll_motion: Option<circuit_clipboard::CircuitScrollMotion>,
    active_cell: Option<circuit_clipboard::CircuitCell>,
    selection_drag: Option<drag_controller::SelectionDrag>,
    /// Horizontal scroll offset for the circuit area, in egui pixels.
    /// When circuit content exceeds the canvas width, this pushes the
    /// rendered circuit left by that many pixels so the user can see
    /// the trailing gates. Always clamped to
    /// `[0, max(0, line_right - canvas_width)]` post-update.
    pub(crate) circuit_scroll_x: f32,
    pub(crate) dragging: Option<DragState>,
    pub(crate) dragging_live_snap: Option<LiveDragSnap>,
    pub(crate) dragging_live_display_snap: bool,
    pub(crate) dragging_live_gpu_plan_touched: bool,
    drag_state_count: Option<usize>,
    pub(crate) state_panel: StatePanelState,
    /// Resizable-span handle currently hovered (drives idle → hover color).
    /// `None` when no hand is on a resizable-span handle.
    pub(crate) hovered_span_resize_handle: Option<SpanResizeHandle>,
    /// In-flight resizable-span drag (only one at a time).
    pub(crate) span_resize_drag: Option<SpanResizeDrag>,
    /// Column index the pointer is currently hovering over for the
    /// step-preview interaction. Drives the live "state-vector at step
    /// k" preview without committing — drops back to `breakpoint_step`
    /// when the pointer leaves the slot row.
    pub(crate) hovered_step: Option<CircuitColumnIndex>,
    /// Delayed angle-label underline affordance for parametric gates. UI-only.
    pub(crate) angle_affordance: Option<AngleAffordance>,
    /// Inline angle editor for Phase / Rx / Ry / Rz gates. UI-only.
    pub(crate) angle_editor: Option<AngleEditor>,
    /// Column index the user clicked to "lock in" as the step shown.
    /// `None` means: show the final-state (all columns applied), which
    /// is the default.
    pub(crate) breakpoint_step: Option<CircuitColumnIndex>,
    pub(crate) hovered_gate_id: Option<GateId>,
    /// `(gate_id, outcome)` for the Probability row under the pointer. The
    /// outcome index is geometry-only; probability values remain GPU-only.
    pub(crate) hovered_probability_outcome: Option<(GateId, u32)>,
    /// `(gate_id, outcome)` for the Amplitude cell under the pointer. The
    /// cell index is geometry-only; complex values remain GPU-only.
    pub(crate) hovered_amplitude_outcome: Option<(GateId, u32)>,
    /// `(gate_id, cell)` for the Density Matrix cell under the pointer. The
    /// cell index is row-major; density values remain GPU-only.
    pub(crate) hovered_density_cell: Option<(GateId, u32)>,
    pub(crate) hovered_palette_index: Option<usize>,
    qubit_count: usize,
    pub(crate) exec_mode: ExecMode,
    pub(crate) exec_mode_keyboard_focus: bool,
    pub(crate) shortcut_help_open: bool,
    pub(crate) external_gpu_status: ExternalGpuStatus,
    pub(crate) external_gpu_started_at: Option<f64>,
    /// One-shot local WebGPU refresh for the state-vector panel after an
    /// explicit external GPU run completes. Keeps GPU mode from live-
    /// recomputing on every edit while still making <=16-qubit runs visible.
    pub(crate) external_gpu_state_refresh_pending: bool,
    pub(crate) external_gpu_amplitude_uploads: Option<ExternalAmplitudeUploadBatch>,
    pub(crate) external_gpu_bloch_uploads: Option<ExternalBlochUploadBatch>,
    pub(crate) external_gpu_probability_uploads: Option<ExternalProbabilityUploadBatch>,
    pub(crate) external_gpu_density_uploads: Option<ExternalDensityUploadBatch>,
    pub(crate) external_gpu_display_generation: u64,
    pub(crate) pending_external_amplitude_slots: Vec<u32>,
    pub(crate) pending_external_bloch_slots: Vec<u32>,
    pub(crate) pending_external_probability_slots: Vec<u32>,
    pub(crate) pending_external_density_slots: Vec<u32>,
    pub(crate) pending_external_gpu_run_id: Option<u64>,
    pub(crate) gpu_plan: GpuPlanState,
    last_content_rect: Option<egui::Rect>,
    drag_cursor_pos: Option<egui::Pos2>,
    drag_repaint_deadline: Option<f64>,
    drag_repaint_pending: bool,
    startup_repaint_until: f64,
    pointer_was_down: bool,
    gate_click_selection: Option<GateClickSelection>,
    /// Debug HUD: backtick (`) toggles a small bottom-right overlay showing
    /// smoothed FPS + frame ms. Off by default — when on, forces continuous
    /// repaint so the reading stays responsive (which itself costs perf,
    /// hence the toggle). F12 is avoided because Chrome reserves it for
    /// DevTools.
    fps_hud_visible: bool,
    fps_hud_history: VecDeque<f32>,
    /// Per-frame CPU time spent inside `update()` (seconds). Lets the HUD
    /// split total frame ms (= stable_dt) into CPU vs GPU/sync.
    fps_hud_cpu_history: VecDeque<f32>,
    /// CPU time spent specifically inside `draw_state_vector` (seconds).
    /// Isolates the state-panel cost so the HUD can show it next to the
    /// total CPU time — useful for "is the state panel scaling badly?"
    /// diagnostics.
    fps_hud_svp_history: VecDeque<f32>,
}

struct GateClickSelection {
    gate_id: GateId,
    pressed_at: f64,
    selected_gate_ids: BTreeSet<GateId>,
    repeated_same_gate: bool,
}

impl QniApp {
    pub(crate) fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let theme = Theme::default();
        theme.apply_to_context(&cc.egui_ctx);
        cc.egui_ctx.style_mut(|style| {
            style.spacing.window_margin = egui::Margin::same(0);
        });
        // Font setup:
        // Start from `empty` so egui doesn't parse unused bundled fonts
        // (Ubuntu / Noto Emoji / default Hack) after we replace both
        // public font families.
        // 1. Register a CP932/JIS Japanese subset of Noto Sans CJK JP
        //    Regular as the UI fallback, so circuit names entered during
        //    Rename render Japanese text instead of tofu. Noto CJK is SIL
        //    OFL 1.1; the subset covers hiragana, katakana, common kanji,
        //    full-width forms, and Windows Japanese name variants.
        // 2. Register Hack only as the final fallback so mathematical
        //    angle brackets `⟨` `⟩` (U+27E8 / U+27E9) used in ket labels
        //    render instead of falling back to tofu if Geist lacks them.
        // 3. Register Geist Sans for proportional UI text and Geist Medium
        //    for the aspect-popup label. Gate glyphs use SVG/SDF assets
        //    generated from Geist, so no runtime gate-label font family is
        //    needed. Register Geist Mono for monospace UI text (state
        //    headers, popups, phase labels, FPS HUD, toggle). Geist is SIL
        //    OFL 1.1 (vercel/geist-font) and embedded via `include_bytes!`.
        let mut fonts = egui::FontDefinitions::empty();
        fonts.font_data.insert(
            "hack_fallback".to_owned(),
            std::sync::Arc::new(egui::FontData::from_static(
                epaint_default_fonts::HACK_REGULAR,
            )),
        );
        fonts.font_data.insert(
            "geist_regular".to_owned(),
            std::sync::Arc::new(egui::FontData::from_static(include_bytes!(
                "../assets/Geist-Regular.ttf"
            ))),
        );
        fonts.font_data.insert(
            "geist_medium".to_owned(),
            std::sync::Arc::new(egui::FontData::from_static(include_bytes!(
                "../assets/Geist-Medium.ttf"
            ))),
        );
        fonts.font_data.insert(
            "geist_mono".to_owned(),
            std::sync::Arc::new(egui::FontData::from_static(include_bytes!(
                "../assets/GeistMono-Regular.ttf"
            ))),
        );
        fonts.font_data.insert(
            "qni_japanese_fallback".to_owned(),
            std::sync::Arc::new(egui::FontData::from_static(include_bytes!(
                "../assets/QniJapaneseFallback-Regular.otf"
            ))),
        );
        fonts.families.insert(
            egui::FontFamily::Proportional,
            vec![
                "geist_regular".to_owned(),
                "qni_japanese_fallback".to_owned(),
                "hack_fallback".to_owned(),
            ],
        );
        fonts.families.insert(
            egui::FontFamily::Monospace,
            vec![
                "geist_mono".to_owned(),
                "qni_japanese_fallback".to_owned(),
                "hack_fallback".to_owned(),
            ],
        );
        fonts.families.insert(
            egui::FontFamily::Name("geist-medium".into()),
            vec!["geist_medium".to_owned()],
        );
        cc.egui_ctx.set_fonts(fonts);
        Self::wire_test_hooks(&cc.egui_ctx);
        cc.egui_ctx.request_repaint();
        // Restore a shared circuit from the URL (`#{"cols":[...]}` or
        // qni-style path) first. If no URL payload is present, use the
        // persisted active localStorage circuit; if no persisted library
        // exists, keep the seeded samples and a separate "Circuit 1" current
        // entry so examples are not overwritten by the empty editor.
        let (url_gates, url_gate_ids) = crate::url_circuit::parse_circuit_from_url();
        let requested_exec_mode = crate::url_circuit::parse_exec_mode_from_url();
        let url_required_qubits = crate::url_circuit::qubit_count_from_gates(&url_gates);
        let url_serialized_qubits = QubitCount::try_new(url_required_qubits.max(MIN_QUBITS))
            .expect("URL serialized qubit count is at least one");
        let url_json = crate::url_circuit::circuit_to_json(&url_gates, url_serialized_qubits);
        let (library, initial_json) = circuit_library::for_startup(
            url_json.clone(),
            crate::url_circuit::current_url_has_circuit_payload(),
        );
        let (initial_gates, gate_ids) = if initial_json == url_json {
            (url_gates, url_gate_ids)
        } else {
            crate::url_circuit::parse_circuit_json(&initial_json)
        };
        let initial_required_qubits = crate::url_circuit::qubit_count_from_gates(&initial_gates);
        let exec_mode = if initial_required_qubits > LOCAL_MAX_QUBITS {
            ExecMode::Gpu
        } else {
            requested_exec_mode.unwrap_or_default()
        };
        let initial_qubit_count =
            initial_required_qubits.clamp(MIN_QUBITS, exec_mode.qubit_capacity().get());
        let initial_serialized_qubits =
            QubitCount::try_new(initial_required_qubits.max(MIN_QUBITS))
                .expect("initial serialized qubit count is at least one");
        let initial_json =
            crate::url_circuit::circuit_to_json(&initial_gates, initial_serialized_qubits);
        crate::url_circuit::write_circuit_to_url(&initial_json);
        crate::url_circuit::write_exec_mode_to_url(exec_mode);
        Self {
            theme: theme.kind,
            circuit_revision: CircuitRevision::starting_at(initial_json),
            library,
            picker: PickerState::default(),
            picker_hover_suppressed_at: None,
            picker_drag_suppressed_until_release: false,
            picker_submenu_toggle_suppressed_until_release: false,
            picker_drag_animation_epoch: 0,
            picker_overlay_rect: None,
            gate_ids,
            placed_gates: initial_gates,
            selected_gate_ids: BTreeSet::new(),
            circuit_clipboard: None,
            copy_flash: None,
            paste_flashes: Vec::new(),
            paste_error_notice: None,
            circuit_motion: None,
            circuit_scroll_motion: None,
            active_cell: None,
            selection_drag: None,
            circuit_scroll_x: 0.0,
            dragging: None,
            dragging_live_snap: None,
            dragging_live_display_snap: false,
            dragging_live_gpu_plan_touched: false,
            drag_state_count: None,
            state_panel: StatePanelState::default(),
            hovered_span_resize_handle: None,
            span_resize_drag: None,
            hovered_step: None,
            angle_affordance: None,
            angle_editor: None,
            breakpoint_step: None,
            hovered_gate_id: None,
            hovered_probability_outcome: None,
            hovered_amplitude_outcome: None,
            hovered_density_cell: None,
            hovered_palette_index: None,
            qubit_count: initial_qubit_count,
            exec_mode,
            exec_mode_keyboard_focus: false,
            shortcut_help_open: false,
            external_gpu_status: ExternalGpuStatus::default(),
            external_gpu_started_at: None,
            external_gpu_state_refresh_pending: false,
            external_gpu_amplitude_uploads: None,
            external_gpu_bloch_uploads: None,
            external_gpu_probability_uploads: None,
            external_gpu_density_uploads: None,
            external_gpu_display_generation: 0,
            pending_external_amplitude_slots: Vec::new(),
            pending_external_bloch_slots: Vec::new(),
            pending_external_probability_slots: Vec::new(),
            pending_external_density_slots: Vec::new(),
            pending_external_gpu_run_id: None,
            gpu_plan: GpuPlanState::default(),
            last_content_rect: None,
            drag_cursor_pos: None,
            drag_repaint_deadline: None,
            drag_repaint_pending: false,
            startup_repaint_until: now_seconds() + 0.5,
            pointer_was_down: false,
            gate_click_selection: None,
            fps_hud_visible: false,
            fps_hud_history: VecDeque::with_capacity(120),
            fps_hud_cpu_history: VecDeque::with_capacity(120),
            fps_hud_svp_history: VecDeque::with_capacity(120),
        }
    }

    pub(crate) fn colors(&self) -> Colors {
        Colors::for_theme(self.theme)
    }

    fn layout_qubits(&self) -> usize {
        let capacity = self.exec_mode.qubit_capacity().get();
        let mut count = self.qubit_count.clamp(MIN_QUBITS, capacity);
        if let Some((anchor, (_, height))) = self
            .paste_preview()
            .filter(|_| !self.library.active_locked())
        {
            count = count.max(anchor.wire.as_usize().saturating_add(height));
        }
        if self.dragging.is_some() && count < capacity {
            count += 1;
        }
        count.min(capacity)
    }

    pub(crate) fn local_state_vector_active(&self) -> bool {
        self.exec_mode == ExecMode::Local
            && QubitCapacity::local().contains(self.required_qubit_count())
    }

    pub(crate) fn state_panel_visible(&self) -> bool {
        self.local_state_vector_active()
    }

    pub(crate) fn external_gpu_display_placeholders_active(&self) -> bool {
        self.exec_mode == ExecMode::Gpu
    }

    pub(crate) fn external_gpu_display_resources_needed(&self) -> bool {
        self.exec_mode == ExecMode::Gpu
            && self.placed_gates.iter().any(|gate| {
                matches!(
                    gate.kind,
                    GateKind::AmplitudeDisplay
                        | GateKind::BlochDisplay
                        | GateKind::ProbabilityDisplay
                        | GateKind::DensityMatrixDisplay
                )
            })
    }

    pub(crate) fn local_exec_mode_available(&self) -> bool {
        QubitCapacity::local().contains(self.required_qubit_count())
    }
}
