//! Debug FPS / frame-ms / svp-ms overlay window. Backtick toggles
//! `fps_hud_visible`; while visible it tracks rolling 120-frame
//! averages and renders a small FPS plot at the bottom-right.

use eframe::egui;

use super::QniApp;

impl QniApp {
    pub(crate) fn draw_fps_hud(&mut self, ctx: &egui::Context, frame_secs: f64) {
        let dt = ctx.input(|i| i.stable_dt);
        self.fps_hud_history.push_back(dt);
        while self.fps_hud_history.len() > 120 {
            self.fps_hud_history.pop_front();
        }
        self.fps_hud_cpu_history.push_back(frame_secs as f32);
        while self.fps_hud_cpu_history.len() > 120 {
            self.fps_hud_cpu_history.pop_front();
        }
        let avg_dt =
            self.fps_hud_history.iter().sum::<f32>() / self.fps_hud_history.len().max(1) as f32;
        let avg_cpu = self.fps_hud_cpu_history.iter().sum::<f32>()
            / self.fps_hud_cpu_history.len().max(1) as f32;
        let avg_svp = if self.fps_hud_svp_history.is_empty() {
            0.0
        } else {
            self.fps_hud_svp_history.iter().sum::<f32>() / self.fps_hud_svp_history.len() as f32
        };
        let fps = if avg_dt > 1e-6 { 1.0 / avg_dt } else { 0.0 };
        let colors = self.colors();
        egui::Window::new("perf_hud")
            .anchor(egui::Align2::RIGHT_BOTTOM, [-8.0, -8.0])
            .interactable(false)
            .resizable(false)
            .title_bar(false)
            // Above the foreground-layer state panel; otherwise the
            // panel header strip occludes the cpu/svp lines on big
            // viewports.
            .order(egui::Order::Tooltip)
            .frame(
                egui::Frame::popup(&ctx.style())
                    .inner_margin(egui::Margin::symmetric(8, 6))
                    .fill(colors.fps_hud_bg)
                    .stroke(egui::Stroke::new(1.0_f32, colors.fps_hud_border)),
            )
            .show(ctx, |ui| {
                ui.spacing_mut().item_spacing.y = 4.0;
                ui.colored_label(
                    colors.fps_hud_text,
                    egui::RichText::new(format!("{:5.1} FPS", fps))
                        .monospace()
                        .size(13.0),
                );
                let (graph_rect, _) = ui.allocate_exact_size(
                    egui::vec2(150.0, 50.0),
                    egui::Sense::hover(),
                );
                let painter = ui.painter_at(graph_rect);
                // Graph background.
                painter.rect_filled(
                    graph_rect,
                    0.0,
                    colors.fps_graph_bg,
                );
                // Axes.
                let axis_color = colors.fps_axis;
                painter.line_segment(
                    [graph_rect.left_top(), graph_rect.left_bottom()],
                    egui::Stroke::new(1.0_f32, axis_color),
                );
                painter.line_segment(
                    [graph_rect.left_bottom(), graph_rect.right_bottom()],
                    egui::Stroke::new(1.0_f32, axis_color),
                );
                // Y-axis ceiling: round up to next 30 fps step, clamped
                // to [60, 150] so a single startup spike (sub-ms first
                // frame → 600+ fps) doesn't wreck the scale.
                let history_max = self
                    .fps_hud_history
                    .iter()
                    .map(|dt| if *dt > 1e-6 { 1.0 / *dt } else { 0.0 })
                    .fold(0.0f32, f32::max)
                    .min(150.0);
                let y_max = ((history_max / 30.0).ceil() * 30.0).clamp(60.0, 150.0);
                // Plot line.
                let n = self.fps_hud_history.len();
                if n >= 2 {
                    let denom = (n - 1) as f32;
                    let points: Vec<egui::Pos2> = self
                        .fps_hud_history
                        .iter()
                        .enumerate()
                        .map(|(i, dt)| {
                            let inst_fps = if *dt > 1e-6 { 1.0 / *dt } else { 0.0 };
                            let x = graph_rect.left()
                                + (i as f32 / denom) * graph_rect.width();
                            let y = graph_rect.bottom()
                                - (inst_fps / y_max).clamp(0.0, 1.0) * graph_rect.height();
                            egui::pos2(x, y)
                        })
                        .collect();
                    painter.add(egui::Shape::line(
                        points,
                        egui::Stroke::new(1.5_f32, colors.fps_plot),
                    ));
                }
                // Y-axis labels.
                let label_color = colors.fps_axis_label;
                painter.text(
                    egui::pos2(graph_rect.left() + 3.0, graph_rect.top() + 1.0),
                    egui::Align2::LEFT_TOP,
                    format!("{:.0}", y_max),
                    // text-xs (12px) — Tailwind's smallest size step.
                    egui::FontId::monospace(12.0),
                    label_color,
                );
                painter.text(
                    egui::pos2(graph_rect.left() + 3.0, graph_rect.bottom() - 1.0),
                    egui::Align2::LEFT_BOTTOM,
                    "0",
                    // text-xs (12px) — Tailwind's smallest size step.
                    egui::FontId::monospace(12.0),
                    label_color,
                );
                let ms_color = colors.fps_total;
                let svp_color = colors.fps_svp;
                let cpu_color = colors.fps_cpu;
                ui.colored_label(
                    ms_color,
                    egui::RichText::new(format!("{:5.2} ms total", avg_dt * 1000.0))
                        .monospace()
                        .size(11.0),
                );
                ui.colored_label(
                    cpu_color,
                    egui::RichText::new(format!("{:5.2} ms cpu", avg_cpu * 1000.0))
                        .monospace()
                        .size(11.0),
                );
                ui.colored_label(
                    svp_color,
                    egui::RichText::new(format!("{:5.2} ms svp", avg_svp * 1000.0))
                        .monospace()
                        .size(11.0),
                );
            });
        // Force continuous repaint so the reading stays live.
        ctx.request_repaint();
    }
}
