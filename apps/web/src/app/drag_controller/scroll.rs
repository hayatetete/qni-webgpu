use eframe::egui;

use super::DragController;
use crate::app::QniApp;
use crate::constants::CIRCUIT_PADDING;
use crate::layout::LayoutMetrics;

impl DragController {
    pub(in crate::app) fn update_circuit_scroll(
        app: &mut QniApp,
        ctx: &egui::Context,
        content_rect: egui::Rect,
        screen_pos: Option<egui::Pos2>,
        metrics: &LayoutMetrics,
    ) {
        // Horizontal scroll: trackpad horizontal swipes come through
        // as `smooth_scroll_delta.x`; desktop mice typically only
        // produce a `delta.y`, so we treat shift+wheel-y as wheel-x
        // when the cursor is inside the circuit area. Scroll right
        // (positive delta) → reveal trailing gates → `scroll_x`
        // grows. Always clamp to `[0, max(0, line_right -
        // canvas_width + CIRCUIT_PADDING)]` so the rightmost slot
        // stops just past the canvas edge.
        let cursor_in_circuit = screen_pos.is_some_and(|p| content_rect.contains(p));
        if cursor_in_circuit {
            let (raw_dx, raw_dy, shift) = ctx.input(|i| {
                (
                    i.smooth_scroll_delta.x,
                    i.smooth_scroll_delta.y,
                    i.modifiers.shift,
                )
            });
            let dx = if raw_dx.abs() > raw_dy.abs() || !shift {
                raw_dx
            } else {
                raw_dy
            };
            if dx != 0.0 {
                app.circuit_scroll_motion = None;
                let max_scroll = max_circuit_scroll(metrics, content_rect.width());
                app.circuit_scroll_x = (app.circuit_scroll_x - dx).clamp(0.0, max_scroll);
                ctx.request_repaint();
            }
        }
        // After the scroll update, force a clamp so newly-loaded
        // circuits or window resizes never leave us scrolled past the
        // current content extent.
        let max_scroll = max_circuit_scroll(metrics, content_rect.width());
        if app.circuit_scroll_x > max_scroll {
            app.circuit_scroll_x = max_scroll;
        }
    }
}

fn max_circuit_scroll(metrics: &LayoutMetrics, content_width: f32) -> f32 {
    (metrics.line_right + CIRCUIT_PADDING - content_width).max(0.0)
}
