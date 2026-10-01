use eframe::egui;

/// Currently shipped visual theme. Additional themes should add another
/// `ThemeKind` variant and a sibling constructor next to `flexoki_light`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ThemeKind {
    FlexokiLight,
}

pub(crate) const DEFAULT_THEME: ThemeKind = ThemeKind::FlexokiLight;

/// Resolved application colours. Call sites consume semantic roles only; raw
/// palette tones live in the theme definition below so future theme switching
/// stays a data change instead of a render-code hunt.
#[derive(Clone, Copy)]
pub(crate) struct Colors {
    pub(crate) background: egui::Color32,
    pub(crate) surface: egui::Color32,
    pub(crate) line: egui::Color32,
    pub(crate) box_fill: egui::Color32,
    pub(crate) drag_fill: egui::Color32,
    pub(crate) gate_hover_border: egui::Color32,
    pub(crate) label: egui::Color32,
    pub(crate) text: egui::Color32,
    pub(crate) text_strong: egui::Color32,
    pub(crate) state_fill: egui::Color32,
    pub(crate) amplitude_disk_border: egui::Color32,
    pub(crate) display_placeholder_fill: egui::Color32,
    pub(crate) state_outline: egui::Color32,
    pub(crate) state_outline_zero: egui::Color32,
    pub(crate) state_needle: egui::Color32,
    pub(crate) probability_log_hint: egui::Color32,
    pub(crate) semantic_off: egui::Color32,
    pub(crate) semantic_on: egui::Color32,
    pub(crate) semantic_intermediate: egui::Color32,
    pub(crate) semantic_disabled: egui::Color32,
    pub(crate) state_handle_bg: egui::Color32,
    pub(crate) state_resize_handle_top_idle: egui::Color32,
    pub(crate) state_resize_handle_top_drag: egui::Color32,
    pub(crate) state_resize_handle_bottom_idle: egui::Color32,
    pub(crate) state_resize_handle_bottom_drag: egui::Color32,
    pub(crate) span_resize_handle_bg: egui::Color32,
    pub(crate) span_resize_handle_bg_hover: egui::Color32,
    pub(crate) popup_icon: egui::Color32,
    pub(crate) popup_icon_chrome: egui::Color32,
    pub(crate) popover_outline: egui::Color32,
    pub(crate) bloch_sphere_bg: egui::Color32,
    pub(crate) bloch_sphere_lines: egui::Color32,
    pub(crate) bloch_vector_line: egui::Color32,
    pub(crate) bloch_vector_tip_0: egui::Color32,
    pub(crate) bloch_vector_tip_mid: egui::Color32,
    pub(crate) bloch_vector_tip_1: egui::Color32,
    pub(crate) bloch_vector_tip_outline: egui::Color32,
    pub(crate) bloch_vector_zero: egui::Color32,
    pub(crate) measurement_fired_icon: egui::Color32,
    pub(crate) spacer_dots: egui::Color32,
    pub(crate) step_preview: egui::Color32,
    pub(crate) palette_shadow: egui::Color32,
    pub(crate) state_panel_shadow: egui::Color32,
    pub(crate) state_cell_popup_shadow: egui::Color32,
    pub(crate) minimap_bg: egui::Color32,
    pub(crate) minimap_viewport_fill: egui::Color32,
    pub(crate) minimap_viewport_stroke: egui::Color32,
    pub(crate) aspect_thumb_idle: egui::Color32,
    pub(crate) aspect_text_current: egui::Color32,
    pub(crate) fps_hud_bg: egui::Color32,
    pub(crate) fps_hud_border: egui::Color32,
    pub(crate) fps_hud_text: egui::Color32,
    pub(crate) fps_graph_bg: egui::Color32,
    pub(crate) fps_axis: egui::Color32,
    pub(crate) fps_plot: egui::Color32,
    pub(crate) fps_axis_label: egui::Color32,
    pub(crate) fps_total: egui::Color32,
    pub(crate) fps_cpu: egui::Color32,
    pub(crate) fps_svp: egui::Color32,
    pub(crate) toolbar_hover_bg: egui::Color32,
    pub(crate) toolbar_icon: egui::Color32,
    pub(crate) toolbar_icon_hover: egui::Color32,
    pub(crate) toolbar_icon_disabled: egui::Color32,
    pub(crate) toolbar_shadow: egui::Color32,
    pub(crate) gpu_status_running: egui::Color32,
    pub(crate) gpu_status_completed: egui::Color32,
    pub(crate) gpu_status_failed: egui::Color32,
    pub(crate) gpu_status_separator: egui::Color32,
    pub(crate) error_notice_bg: egui::Color32,
    pub(crate) error_notice_border: egui::Color32,
    pub(crate) error_notice_text: egui::Color32,
}

pub(crate) struct Theme {
    pub(crate) kind: ThemeKind,
    pub(crate) colors: Colors,
}

impl Theme {
    pub(crate) fn default() -> Self {
        Self::new(DEFAULT_THEME)
    }

    pub(crate) fn new(kind: ThemeKind) -> Self {
        Self {
            kind,
            colors: Colors::for_theme(kind),
        }
    }

    pub(crate) fn apply_to_context(&self, ctx: &egui::Context) {
        let mut visuals = egui::Visuals::light();
        visuals.panel_fill = self.colors.background;
        visuals.window_fill = self.colors.surface;
        visuals.faint_bg_color = self.colors.surface;
        visuals.extreme_bg_color = self.colors.background;
        visuals.hyperlink_color = self.colors.semantic_on;
        // Text selection: Flexoki blue-100 (#C6DDE8) — pale enough to
        // keep the underlying glyph readable in near-black tx. The
        // previous `with_alpha(blue-600, 80)` came out mid-saturation
        // and the dark text disappeared into it.
        visuals.selection.bg_fill = egui::Color32::from_rgb(0xC6, 0xDD, 0xE8);
        visuals.selection.stroke = egui::Stroke::NONE;
        ctx.set_visuals(visuals);
    }
}

impl Colors {
    /// Brightens gate chrome toward Flexoki `bg` for transient copy/paste
    /// feedback. Rendering code remains expressed in semantic theme roles.
    pub(crate) fn gate_highlighted(self, strength: f32) -> Self {
        let paper = self.surface;
        let brighten = |color: egui::Color32| color.lerp_to_gamma(paper, strength);
        Self {
            box_fill: brighten(self.box_fill),
            label: brighten(self.label),
            line: brighten(self.line),
            state_fill: brighten(self.state_fill),
            amplitude_disk_border: brighten(self.amplitude_disk_border),
            display_placeholder_fill: brighten(self.display_placeholder_fill),
            state_outline: brighten(self.state_outline),
            state_outline_zero: brighten(self.state_outline_zero),
            state_needle: brighten(self.state_needle),
            semantic_off: brighten(self.semantic_off),
            semantic_on: brighten(self.semantic_on),
            semantic_intermediate: brighten(self.semantic_intermediate),
            semantic_disabled: brighten(self.semantic_disabled),
            bloch_sphere_bg: brighten(self.bloch_sphere_bg),
            bloch_sphere_lines: brighten(self.bloch_sphere_lines),
            measurement_fired_icon: brighten(self.measurement_fired_icon),
            spacer_dots: brighten(self.spacer_dots),
            popup_icon: brighten(self.popup_icon),
            ..self
        }
    }

    pub(crate) fn new() -> Self {
        Self::for_theme(DEFAULT_THEME)
    }

    pub(crate) fn for_theme(theme: ThemeKind) -> Self {
        match theme {
            ThemeKind::FlexokiLight => flexoki_light(),
        }
    }
}

pub(crate) fn with_alpha(color: egui::Color32, alpha: u8) -> egui::Color32 {
    egui::Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), alpha)
}

pub(crate) fn lerp_color(a: egui::Color32, b: egui::Color32, t: f32) -> egui::Color32 {
    fn channel(a: u8, b: u8, t: f32) -> u8 {
        (a as f32 + (b as f32 - a as f32) * t).round() as u8
    }
    egui::Color32::from_rgba_unmultiplied(
        channel(a.r(), b.r(), t),
        channel(a.g(), b.g(), t),
        channel(a.b(), b.b(), t),
        channel(a.a(), b.a(), t),
    )
}

fn tone(r: f32, g: f32, b: f32) -> egui::Color32 {
    crate::shared::color_rgba(r, g, b, 1.0)
}

/// Strict Flexoki Light (Steph Ango / kepano, <https://github.com/kepano/flexoki>).
/// Every role below maps to a named tone. Raw RGB appears only in this theme
/// definition; rendering code uses `Colors` roles.
fn flexoki_light() -> Colors {
    // Flexoki Light reference tones.
    let paper = tone(1.000, 0.988, 0.941); // bg / paper #FFFCF0
    let bg_2 = tone(0.949, 0.941, 0.898); // bg-2 / base-50 #F2F0E5
    let ui = tone(0.902, 0.894, 0.851); // ui / base-100 #E6E4D9
    let ui_2 = tone(0.855, 0.847, 0.808); // ui-2 / base-150 #DAD8CE
    let tx_3 = tone(0.718, 0.710, 0.675); // tx-3 / base-300 #B7B5AC
    let tx_2 = tone(0.435, 0.431, 0.412); // tx-2 / base-600 #6F6E69
    let tx = tone(0.063, 0.059, 0.059); // tx / black #100F0F
    let red_50 = tone(1.000, 0.882, 0.835); // red-50 #FFE1D5
    let red_100 = tone(1.000, 0.792, 0.733); // red-100 #FFCABB
    let red_300 = tone(0.910, 0.439, 0.373); // red-300 #E8705F
    let red_600 = tone(0.686, 0.188, 0.161); // red-600 #AF3029
    let green_600 = tone(0.400, 0.502, 0.043); // green-600 #66800B
    let cyan_400 = tone(0.227, 0.663, 0.624); // cyan-400 #3AA99F
    let cyan_600 = tone(0.141, 0.514, 0.482); // cyan-600 #24837B
    let blue_200 = tone(0.573, 0.749, 0.859); // blue-200 #92BFDB
    let blue_300 = tone(0.400, 0.627, 0.784); // blue-300 #66A0C8
    let blue_400 = tone(0.263, 0.522, 0.745); // blue-400 #4385BE
    let blue_600 = tone(0.125, 0.369, 0.651); // blue-600 #205EA6
    let purple_100 = tone(0.925, 0.882, 0.953); // purple-100 #ECE1F3
    let purple_400 = tone(0.545, 0.494, 0.784); // purple-400 #8B7EC8
    let purple_600 = tone(0.369, 0.251, 0.616); // purple-600 #5E409D

    Colors {
        background: bg_2,                     // page / circuit panel
        surface: paper,                       // palette / cards / state panel
        line: ui_2,                           // qubit wires
        box_fill: cyan_400,                   // unitary gate body
        drag_fill: purple_600,                // grabbed / preview body
        gate_hover_border: purple_400,        // gate hover outline (Flexoki purple-400)
        label: paper,                         // inverse label on filled gates
        text: tx_2,                           // body text
        text_strong: tx,                      // emphasized titles / data ink
        state_fill: blue_200,                 // amplitude disk / Probability bar (Flexoki blue-200)
        amplitude_disk_border: blue_400,      // amplitude disk inset border (Flexoki blue-400)
        display_placeholder_fill: purple_100, // Display pre-run placeholder (Flexoki purple-100)
        state_outline: tx_2,                  // non-zero amplitude outline
        state_outline_zero: ui_2,             // zero-amplitude outline
        state_needle: tx,                     // phase needle
        probability_log_hint: tx_3,           // Probability logarithm hints (Flexoki tx-3 #B7B5AC)
        semantic_off: red_600,                // |0⟩ digit / measurement 0
        semantic_on: blue_600,                // |1⟩ digit / measurement 1
        semantic_intermediate: purple_600,    // measurement idle
        semantic_disabled: tx_2,              // disabled / bracket chrome
        state_handle_bg: blue_600,            // state panel header
        state_resize_handle_top_idle: blue_400,
        state_resize_handle_top_drag: paper,
        state_resize_handle_bottom_idle: ui_2,
        state_resize_handle_bottom_drag: tx_2,
        span_resize_handle_bg: cyan_400, // Resize handle default (Flexoki cyan-400)
        span_resize_handle_bg_hover: cyan_600, // Resize handle hover / active (Flexoki cyan-600)
        popup_icon: blue_400,
        popup_icon_chrome: tx_3,
        popover_outline: tx_3, // Popover outline/tail stroke (Flexoki tx-3 #B7B5AC)
        bloch_sphere_bg: bg_2,
        bloch_sphere_lines: tx_3,
        bloch_vector_line: tx,
        bloch_vector_tip_0: red_300, // active Bloch tip z=+1 (Flexoki red-300, brighter saturated trial)
        bloch_vector_tip_mid: purple_400, // active Bloch tip z=0 (Flexoki purple-400, brighter saturated trial)
        bloch_vector_tip_1: blue_300, // active Bloch tip z=-1 (Flexoki blue-300, brighter saturated trial)
        bloch_vector_tip_outline: tx, // 1 px tip outline (Flexoki tx #100F0F)
        bloch_vector_zero: tx_3,
        measurement_fired_icon: ui_2,
        spacer_dots: tx,
        step_preview: blue_600,
        palette_shadow: with_alpha(tx, 25),
        state_panel_shadow: with_alpha(tx, 25),
        state_cell_popup_shadow: with_alpha(tx, 36),
        minimap_bg: with_alpha(tx, 140),
        minimap_viewport_fill: with_alpha(paper, 70),
        minimap_viewport_stroke: with_alpha(paper, 220),
        aspect_thumb_idle: with_alpha(tx_2, 180),
        aspect_text_current: with_alpha(paper, 255),
        fps_hud_bg: with_alpha(tx, 235),
        fps_hud_border: tx_2,
        fps_hud_text: paper,
        fps_graph_bg: with_alpha(tx, 180),
        fps_axis: tx_3,
        fps_plot: green_600,
        fps_axis_label: tx_3,
        fps_total: purple_400,
        fps_cpu: blue_300,
        fps_svp: cyan_400,
        toolbar_hover_bg: ui,               // Flexoki ui #E6E4D9
        toolbar_icon: tx_2,                 // Flexoki tx-2 #6F6E69
        toolbar_icon_hover: tx,             // Flexoki tx #100F0F
        toolbar_icon_disabled: tx_3,        // Flexoki tx-3 #B7B5AC
        toolbar_shadow: with_alpha(tx, 15), // Flexoki tx alpha for shadow-card
        gpu_status_running: blue_600,       // Flexoki blue-600 #205EA6
        gpu_status_completed: green_600,    // Flexoki green-600 #66800B
        gpu_status_failed: red_600,         // Flexoki red-600 #AF3029
        gpu_status_separator: tx_3,         // Flexoki tx-3 #B7B5AC
        error_notice_bg: red_50,            // Flexoki red-50 #FFE1D5
        error_notice_border: red_100,       // Flexoki red-100 #FFCABB
        error_notice_text: red_600,         // Flexoki red-600 #AF3029
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn span_resize_handle_default_uses_flexoki_cyan_400() {
        assert_eq!(
            Colors::new().span_resize_handle_bg,
            egui::Color32::from_rgb(0x3A, 0xA9, 0x9F)
        );
    }

    #[test]
    fn span_resize_handle_hover_uses_flexoki_cyan_600() {
        assert_eq!(
            Colors::new().span_resize_handle_bg_hover,
            egui::Color32::from_rgb(0x24, 0x83, 0x7B)
        );
    }

    #[test]
    fn popover_outline_uses_flexoki_tx_3() {
        assert_eq!(
            Colors::new().popover_outline,
            egui::Color32::from_rgb(0xB7, 0xB5, 0xAC)
        );
    }
}
