//! Per-frame update coordinator for `QniApp`.
//!
//! The app root owns state; this module owns the order of each frame:
//! circuit input/draw, state-panel interactions, GPU plan refresh, overlay
//! drawing, and repaint / debug-HUD tail work.

mod circuit_frame;
mod frame_tail;
mod gpu_frame;
mod overlay;
mod state_panel_frame;

use eframe::{egui, egui_wgpu};

use super::{GateId, QniApp};
use crate::gpu::StateVectorResourceBootstrapCallback;
use crate::render::StatePanelLayout;
use crate::shared::now_seconds;

struct CircuitFrameState {
    content_rect: Option<egui::Rect>,
    dragging_gate_id: Option<GateId>,
    live_drag_gpu_overlay_ready: bool,
}

struct StatePanelFrameState {
    state_count: usize,
    recompute: bool,
    layout: StatePanelLayout,
}

impl QniApp {
    fn show_update_central_panel(
        &mut self,
        ctx: &egui::Context,
        frame: &mut eframe::Frame,
        ui: &mut egui::Ui,
    ) {
        let screen_rect = ui.max_rect();
        let colors = self.colors();
        let content_height =
            self.circuit_content_height(self.layout_qubits(), screen_rect.height());

        // Decide whether wheel-over-the-panel should suppress the surrounding
        // ScrollArea's page-scroll. If pointer is on the state panel (or its
        // popover), route wheel to our aspect / zoom handlers instead.
        let pointer_over_state_panel = self.compute_state_panel_input_gate(ctx, screen_rect);

        if let Some(target_format) = frame.wgpu_render_state().map(|state| state.target_format) {
            if self.external_gpu_display_resources_needed() {
                let callback = StateVectorResourceBootstrapCallback { target_format };
                let paint_callback = egui_wgpu::Callback::new_paint_callback(screen_rect, callback);
                ui.painter().add(egui::Shape::Callback(paint_callback));
            }
        }

        let circuit_frame = self.show_circuit_scroll_area(
            ctx,
            ui,
            screen_rect,
            content_height,
            pointer_over_state_panel,
            &colors,
        );
        let mut state_frame = self.prepare_state_panel_frame(screen_rect);
        self.process_state_panel_interactions(ctx, ui, screen_rect, &state_frame);
        // State-panel interactions can change zoom, aspect, viewport size, or
        // panel offset. Draw with a fresh layout in the same frame; otherwise
        // the pan/anchor math is one frame ahead of radius/cell_pitch and the
        // GPU-rendered circles visibly wobble during wheel zoom.
        state_frame = self.prepare_state_panel_frame(screen_rect);
        self.draw_frame_overlay(
            ctx,
            frame,
            screen_rect,
            &colors,
            &circuit_frame,
            &state_frame,
        );
    }
}

impl eframe::App for QniApp {
    fn update(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        crate::icons::set_sdf_target_format(
            frame.wgpu_render_state().map(|state| state.target_format),
        );
        let frame_start = now_seconds();
        self.apply_pending_circuit_library_seed(ctx);
        self.apply_external_circuit_library_update(ctx);
        self.apply_pending_url_payload(ctx);
        self.handle_circuit_edit_shortcuts(ctx);
        let colors = self.colors();
        let mut panel_frame = egui::Frame::central_panel(&ctx.style());
        panel_frame.fill = colors.background;
        egui::CentralPanel::default()
            .frame(panel_frame)
            .show(ctx, |ui| {
                self.show_update_central_panel(ctx, frame, ui);
            });
        self.show_exec_mode_toolbar(ctx, &colors);
        self.finish_update_frame(ctx, frame_start);
    }
}
