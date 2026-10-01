use eframe::egui;

use super::{CircuitFrameState, StatePanelFrameState};
use crate::app::QniApp;
use crate::colors::Colors;
use crate::shared::now_seconds;

impl QniApp {
    pub(super) fn draw_frame_overlay(
        &mut self,
        ctx: &egui::Context,
        frame: &mut eframe::Frame,
        screen_rect: egui::Rect,
        colors: &Colors,
        circuit_frame: &CircuitFrameState,
        state_frame: &StatePanelFrameState,
    ) {
        let overlay_painter = ctx.layer_painter(egui::LayerId::new(
            egui::Order::Foreground,
            egui::Id::new("overlay"),
        ));
        let target_format = frame.wgpu_render_state().map(|state| state.target_format);
        let recompute = self.process_gpu_recompute(
            target_format,
            state_frame.recompute,
            state_frame.state_count,
            ctx,
        );

        self.draw_palette(&overlay_painter, screen_rect, colors);
        if self.state_panel_visible() {
            let svp_t0 = now_seconds();
            self.draw_state_vector(
                &overlay_painter,
                colors,
                &state_frame.layout,
                self.state_panel.offset,
                state_frame.layout.handle_height,
                screen_rect,
                recompute,
                target_format,
            );
            if self.fps_hud_visible {
                let svp_secs = (now_seconds() - svp_t0).max(0.0) as f32;
                self.fps_hud_svp_history.push_back(svp_secs);
                while self.fps_hud_svp_history.len() > 120 {
                    self.fps_hud_svp_history.pop_front();
                }
            }
        }
        if let (Some(content_rect), Some(dragging_gate_id)) =
            (circuit_frame.content_rect, circuit_frame.dragging_gate_id)
        {
            self.draw_drag_preview(
                &overlay_painter,
                content_rect,
                colors,
                dragging_gate_id,
                self.circuit_scroll_x,
                circuit_frame.live_drag_gpu_overlay_ready,
            );
        }
        if let Some(content_rect) = circuit_frame.content_rect {
            let circuit_origin = content_rect.min - egui::vec2(self.circuit_scroll_x, 0.0);
            // Paint display popovers in the foreground overlay so they sit above
            // the palette. Use the full screen rect as the GPU value viewport:
            // scrolled circuit content can have a negative rect origin, while
            // egui clamps callback viewports to the visible screen.
            self.draw_bloch_hover_popup(
                &overlay_painter,
                screen_rect,
                circuit_origin,
                circuit_frame.dragging_gate_id,
                colors,
            );
            self.draw_probability_hover_popup(
                &overlay_painter,
                screen_rect,
                circuit_origin,
                circuit_frame.dragging_gate_id,
                colors,
            );
            self.draw_amplitude_hover_popup(
                &overlay_painter,
                screen_rect,
                circuit_origin,
                circuit_frame.dragging_gate_id,
                colors,
            );
        }

        // Foreground feedback is drawn after circuit and state-panel overlays.
        self.draw_palette_tooltip(&overlay_painter, screen_rect, colors);
        self.draw_paste_error_notice(ctx, screen_rect, colors);
    }

    fn draw_paste_error_notice(
        &mut self,
        ctx: &egui::Context,
        screen_rect: egui::Rect,
        colors: &Colors,
    ) {
        let now = now_seconds();
        let Some(notice) = self.paste_error_notice.as_ref() else {
            return;
        };
        let opacity = notice.opacity(now);
        if opacity <= 0.0 {
            self.paste_error_notice = None;
            return;
        }

        if let Some(delay) = notice.remaining_hold(now) {
            ctx.request_repaint_after(delay);
        } else {
            ctx.request_repaint();
        }

        let painter = ctx.layer_painter(egui::LayerId::new(
            egui::Order::Tooltip,
            egui::Id::new("paste-error-notice"),
        ));
        let text_color = colors.error_notice_text.gamma_multiply(opacity);
        let galley = painter.layout_no_wrap(
            notice.message().to_owned(),
            egui::FontId::proportional(14.0), // text-sm = 14px.
            text_color,
        );
        let size = galley.size() + egui::vec2(32.0, 16.0); // px-4 / py-2.
        let rect = egui::Rect::from_center_size(
            egui::pos2(
                screen_rect.center().x,
                screen_rect.bottom() - 24.0 - size.y / 2.0, // bottom-6 = 24px.
            ),
            size,
        );
        painter.rect(
            rect,
            egui::CornerRadius::same(8), // rounded-lg = 8px.
            colors.error_notice_bg.gamma_multiply(opacity),
            egui::Stroke::new(1.0_f32, colors.error_notice_border.gamma_multiply(opacity)),
            egui::StrokeKind::Inside,
        );
        painter.galley(rect.center() - galley.size() / 2.0, galley, text_color);
    }
}
