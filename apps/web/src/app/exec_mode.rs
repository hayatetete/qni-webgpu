use eframe::egui;

use super::QniApp;
use crate::colors::{with_alpha, Colors};
use crate::qubit_count::QubitCapacity;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum ExecMode {
    #[default]
    Local,
    Gpu,
}

impl ExecMode {
    fn is_gpu(self) -> bool {
        matches!(self, Self::Gpu)
    }

    pub(crate) fn qubit_capacity(self) -> QubitCapacity {
        match self {
            Self::Local => QubitCapacity::local(),
            Self::Gpu => QubitCapacity::external_gpu(),
        }
    }

    fn toggle(self, local_available: bool) -> Self {
        match self {
            Self::Local => Self::Gpu,
            Self::Gpu if local_available => Self::Local,
            Self::Gpu => Self::Gpu,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ExecModeKey {
    ArrowLeft,
    ArrowRight,
    Enter,
    Space,
}

pub(crate) fn exec_mode_after_key(
    current: ExecMode,
    key: ExecModeKey,
    local_available: bool,
) -> ExecMode {
    match key {
        ExecModeKey::ArrowLeft if local_available => ExecMode::Local,
        ExecModeKey::ArrowLeft => current,
        ExecModeKey::ArrowRight => ExecMode::Gpu,
        ExecModeKey::Enter | ExecModeKey::Space => current.toggle(local_available),
    }
}

impl QniApp {
    pub(crate) fn show_exec_mode_toggle(&mut self, ui: &mut egui::Ui, colors: &Colors) {
        let previous_mode = self.exec_mode;
        let local_available = self.local_exec_mode_available();
        ui.add(ExecModeToggle {
            mode: &mut self.exec_mode,
            keyboard_focus: &mut self.exec_mode_keyboard_focus,
            local_available,
            colors,
        });
        if self.exec_mode != previous_mode {
            crate::url_circuit::write_exec_mode_to_url(self.exec_mode);
            self.update_qubit_count();
            if self.exec_mode == ExecMode::Local {
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
            }
            self.gpu_plan.mark_dirty();
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn take_exec_mode_focus_request() -> bool {
    let Some(window) = web_sys::window() else {
        return false;
    };
    let key = wasm_bindgen::JsValue::from_str("__qniExecModeFocusRequested");
    let requested = js_sys::Reflect::get(window.as_ref(), &key)
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if requested {
        let _ = js_sys::Reflect::set(window.as_ref(), &key, &wasm_bindgen::JsValue::FALSE);
    }
    requested
}

#[cfg(not(target_arch = "wasm32"))]
fn take_exec_mode_focus_request() -> bool {
    false
}

struct ExecModeToggle<'a> {
    mode: &'a mut ExecMode,
    keyboard_focus: &'a mut bool,
    local_available: bool,
    colors: &'a Colors,
}

impl egui::Widget for ExecModeToggle<'_> {
    fn ui(self, ui: &mut egui::Ui) -> egui::Response {
        let id = ui.make_persistent_id("exec_mode_toggle");
        let font = egui::FontId::monospace(14.0); // text-sm = 14px.
        let local = ui
            .painter()
            .layout_no_wrap("Local".to_owned(), font.clone(), self.colors.text);
        let gpu = ui
            .painter()
            .layout_no_wrap("GPU".to_owned(), font.clone(), self.colors.text);
        let segment_padding = egui::vec2(12.0, 4.0); // px-3 / py-1 per side — match mock.
        let local_size = local.size() + segment_padding * 2.0;
        let gpu_size = gpu.size() + segment_padding * 2.0;
        let segment_height = local_size.y.max(gpu_size.y);
        let track_padding = 2.0; // mock .seg padding = 2px.
        let track_size = egui::vec2(
            local_size.x + gpu_size.x + track_padding * 2.0,
            segment_height + track_padding * 2.0,
        );
        let (track_rect, mut response) = ui.allocate_exact_size(track_size, egui::Sense::hover());
        let local_rect = egui::Rect::from_min_size(
            track_rect.min + egui::vec2(track_padding, track_padding),
            egui::vec2(local_size.x, segment_height),
        );
        let gpu_rect = egui::Rect::from_min_size(
            egui::pos2(local_rect.right(), local_rect.top()),
            egui::vec2(gpu_size.x, segment_height),
        );
        let mut local_response = ui.interact(
            local_rect,
            id.with("local_opt"),
            if self.local_available {
                egui::Sense::click()
            } else {
                egui::Sense::hover()
            },
        );
        let mut gpu_response = ui.interact(gpu_rect, id.with("gpu_opt"), egui::Sense::click());
        let tab_focus_requested = take_exec_mode_focus_request();
        if tab_focus_requested {
            *self.keyboard_focus = true;
        }
        if local_response.clicked() && self.local_available {
            *self.keyboard_focus = true;
            if *self.mode != ExecMode::Local {
                *self.mode = ExecMode::Local;
                local_response.mark_changed();
            }
        }
        if gpu_response.clicked() {
            *self.keyboard_focus = true;
            if *self.mode != ExecMode::Gpu {
                *self.mode = ExecMode::Gpu;
                gpu_response.mark_changed();
            }
        }

        let clicked_toggle = local_response.clicked() || gpu_response.clicked();
        if ui.input(|input| input.pointer.any_click())
            && !clicked_toggle
            && !track_rect.contains(
                ui.input(|input| input.pointer.hover_pos())
                    .unwrap_or_default(),
            )
        {
            *self.keyboard_focus = false;
        }

        let has_keyboard_focus = *self.keyboard_focus;
        if has_keyboard_focus {
            let key = ui.input(|input| {
                if input.key_pressed(egui::Key::ArrowLeft) {
                    Some(ExecModeKey::ArrowLeft)
                } else if input.key_pressed(egui::Key::ArrowRight) {
                    Some(ExecModeKey::ArrowRight)
                } else if input.key_pressed(egui::Key::Enter) {
                    Some(ExecModeKey::Enter)
                } else if input.key_pressed(egui::Key::Space) {
                    Some(ExecModeKey::Space)
                } else {
                    None
                }
            });
            if let Some(key) = key {
                let next = exec_mode_after_key(*self.mode, key, self.local_available);
                if *self.mode != next {
                    *self.mode = next;
                    if next.is_gpu() {
                        gpu_response.mark_changed();
                    } else {
                        local_response.mark_changed();
                    }
                }
            }
        }
        let motion_t = ui.ctx().animate_bool_with_time_and_easing(
            id.with("thumb_motion"),
            self.mode.is_gpu(),
            0.38,
            ease_out_back,
        );
        let color_t =
            ui.ctx()
                .animate_bool_with_time(id.with("thumb_color"), self.mode.is_gpu(), 0.26);
        paint_exec_mode_toggle(
            ui,
            track_rect,
            local_rect,
            gpu_rect,
            local,
            gpu,
            motion_t,
            color_t,
            self.mode.is_gpu(),
            self.local_available,
            self.colors,
        );
        response = response.union(local_response).union(gpu_response);
        if !self.local_available
            && ui
                .input(|input| input.pointer.hover_pos())
                .is_some_and(|pos| local_rect.contains(pos))
        {
            response = response.on_hover_text_at_pointer(
                "Local is available up to 16 qubits. Remove qubits to switch back.",
            );
        }
        response
    }
}

fn ease_out_back(t: f32) -> f32 {
    const C1: f32 = 1.20;
    const C3: f32 = C1 + 1.0;
    let u = t - 1.0;
    1.0 + C3 * u * u * u + C1 * u * u
}

#[allow(clippy::too_many_arguments)]
fn paint_exec_mode_toggle(
    ui: &egui::Ui,
    track_rect: egui::Rect,
    local_rect: egui::Rect,
    gpu_rect: egui::Rect,
    local: std::sync::Arc<egui::Galley>,
    gpu: std::sync::Arc<egui::Galley>,
    motion_t: f32,
    color_t: f32,
    is_gpu: bool,
    local_available: bool,
    colors: &Colors,
) {
    let painter = ui.painter();
    painter.rect_filled(track_rect, egui::CornerRadius::same(8), colors.surface);
    painter.rect_stroke(
        track_rect,
        egui::CornerRadius::same(8),
        egui::Stroke::new(1.0_f32, colors.line),
        egui::StrokeKind::Inside,
    );

    let thumb_left = lerp(local_rect.left(), gpu_rect.left(), motion_t);
    let thumb_width = lerp(local_rect.width(), gpu_rect.width(), motion_t).max(1.0);
    let thumb_rect = egui::Rect::from_min_size(
        egui::pos2(thumb_left, local_rect.top()),
        egui::vec2(thumb_width, local_rect.height()),
    );
    let thumb_color = colors
        .text // Flexoki tx-2, Local active fill.
        .lerp_to_gamma(colors.semantic_on, color_t.clamp(0.0, 1.0)); // Flexoki blue-600.
    painter.rect_filled(thumb_rect, egui::CornerRadius::same(4), thumb_color);

    let pointer = ui.input(|input| input.pointer.hover_pos());
    let inactive_hover = |rect: egui::Rect| pointer.is_some_and(|pos| rect.contains(pos));
    let local_color = if local_available {
        inactive_label_color(inactive_hover(local_rect), colors)
    } else {
        with_alpha(colors.text, 96) // Flexoki tx-2, disabled.
    };
    paint_exec_mode_label(
        painter,
        local_rect,
        local,
        if is_gpu { local_color } else { colors.surface },
    );
    paint_exec_mode_label(
        painter,
        gpu_rect,
        gpu,
        if is_gpu {
            colors.surface
        } else {
            inactive_label_color(inactive_hover(gpu_rect), colors)
        },
    );
}

fn inactive_label_color(hovered: bool, colors: &Colors) -> egui::Color32 {
    if hovered {
        colors.text_strong
    } else {
        colors.text
    }
}

fn paint_exec_mode_label(
    painter: &egui::Painter,
    rect: egui::Rect,
    galley: std::sync::Arc<egui::Galley>,
    color: egui::Color32,
) {
    let pos = egui::pos2(
        rect.center().x - galley.size().x / 2.0,
        rect.center().y - galley.size().y / 2.0,
    );
    painter.galley_with_override_text_color(pos, galley, color);
}

fn lerp(start: f32, end: f32, t: f32) -> f32 {
    start + (end - start) * t
}

#[cfg(test)]
mod tests {
    use super::{exec_mode_after_key, ExecMode, ExecModeKey};
    use crate::qubit_count::QubitCapacity;

    #[test]
    fn arrow_keys_select_sibling_modes() {
        assert_eq!(
            (
                exec_mode_after_key(ExecMode::Local, ExecModeKey::ArrowRight, true),
                exec_mode_after_key(ExecMode::Gpu, ExecModeKey::ArrowLeft, true),
            ),
            (ExecMode::Gpu, ExecMode::Local)
        );
    }

    #[test]
    fn enter_and_space_toggle_modes() {
        assert_eq!(
            (
                exec_mode_after_key(ExecMode::Local, ExecModeKey::Enter, true),
                exec_mode_after_key(ExecMode::Gpu, ExecModeKey::Enter, true),
                exec_mode_after_key(ExecMode::Local, ExecModeKey::Space, true),
                exec_mode_after_key(ExecMode::Gpu, ExecModeKey::Space, true),
            ),
            (
                ExecMode::Gpu,
                ExecMode::Local,
                ExecMode::Gpu,
                ExecMode::Local
            )
        );
    }

    #[test]
    fn local_unavailable_keeps_gpu_selected() {
        assert_eq!(
            (
                exec_mode_after_key(ExecMode::Gpu, ExecModeKey::ArrowLeft, false),
                exec_mode_after_key(ExecMode::Gpu, ExecModeKey::Enter, false),
                exec_mode_after_key(ExecMode::Gpu, ExecModeKey::Space, false),
            ),
            (ExecMode::Gpu, ExecMode::Gpu, ExecMode::Gpu)
        );
    }

    #[test]
    fn local_mode_exposes_local_qubit_capacity() {
        assert_eq!(ExecMode::Local.qubit_capacity(), QubitCapacity::local());
    }

    #[test]
    fn gpu_mode_exposes_external_gpu_qubit_capacity() {
        assert_eq!(
            ExecMode::Gpu.qubit_capacity(),
            QubitCapacity::external_gpu()
        );
    }
}
