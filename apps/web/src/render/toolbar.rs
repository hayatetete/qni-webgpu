use eframe::egui;

use crate::app::{ExecMode, ExternalGpuStatus, QniApp};
use crate::colors::{with_alpha, Colors};
use crate::constants::SECTION_DIVIDER_WIDTH;

use super::circuit_picker::{paint_chevron, paint_section_header, popover_frame};
use super::gpu_status_pill::gpu_status_pill;

const TOOL_SIZE: egui::Vec2 = egui::vec2(32.0, 32.0); // w-8 / h-8 = 32×32 square.
const ICON_SIZE: egui::Vec2 = egui::vec2(18.0, 18.0); // Lucide 24×24 viewBox scaled to 18px.
const KEYBOARD_SHORTCUTS_TOOLTIP: &str = "Keyboard shortcuts";
const SHORTCUT_ROWS: [(&str, &str, &str); 8] = [
    ("Select all", "Ctrl+A", "Cmd+A"),
    ("Cut", "Ctrl+X", "Cmd+X"),
    ("Copy", "Ctrl+C", "Cmd+C"),
    ("Paste", "Ctrl+V", "Cmd+V"),
    ("Undo", "Ctrl+Z", "Cmd+Z"),
    ("Redo", "Ctrl+Y / Ctrl+Shift+Z", "Shift+Cmd+Z"),
    ("Delete", "Delete", "Delete"),
    ("Clear selection / marker", "Esc", "Esc"),
];

#[derive(Clone, Copy)]
enum ToolbarIcon {
    Undo,
    Redo,
    Trash,
    Copy,
    Lock,
    LockOpen,
    Play,
    Keyboard,
}

impl QniApp {
    pub(crate) fn show_exec_mode_toolbar(&mut self, ctx: &egui::Context, colors: &Colors) {
        self.poll_external_gpu_run(ctx);
        let viewport = ctx.content_rect();
        let mut shortcut_trigger_rect = None;
        egui::Area::new(egui::Id::new("exec_mode_toolbar"))
            .order(egui::Order::Foreground)
            .fixed_pos(viewport.min)
            .show(ctx, |ui| {
                ui.set_min_width(viewport.width());
                toolbar_frame(colors).show(ui, |ui| {
                    ui.set_min_width((viewport.width() - 24.0).max(0.0)); // px-3 x both sides.
                    ui.set_min_height(32.0); // h-8 = 32px content row.
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing = egui::vec2(8.0, 0.0); // gap-2 = 8px.
                        self.show_circuit_picker(ui, colors, ctx);
                        self.show_edit_utilities(ui, colors, ctx);
                        if self.exec_mode == ExecMode::Gpu {
                            paint_toolbar_divider(ui, colors);
                            self.show_gpu_execute_cluster(ui, colors, ctx);
                        }
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            self.show_exec_mode_toggle(ui, colors);
                            let trigger =
                                shortcut_help_trigger(ui, colors, self.shortcut_help_open);
                            shortcut_trigger_rect = Some(trigger.rect);
                            if trigger.clicked() {
                                self.shortcut_help_open = !self.shortcut_help_open;
                                if self.shortcut_help_open {
                                    self.picker.close();
                                }
                            }
                        });
                    });
                });
            });
        if let Some(trigger_rect) = shortcut_trigger_rect {
            self.show_shortcut_help_popover(ctx, colors, trigger_rect);
        }
    }

    fn show_shortcut_help_popover(
        &mut self,
        ctx: &egui::Context,
        colors: &Colors,
        trigger_rect: egui::Rect,
    ) {
        if !self.shortcut_help_open {
            return;
        }
        if ctx.input(|input| input.key_pressed(egui::Key::Escape)) {
            self.shortcut_help_open = false;
            ctx.request_repaint();
            return;
        }

        let viewport = ctx.content_rect();
        let width = 496.0_f32.min((viewport.width() - 32.0).max(0.0));
        let mut shortcut_column_lefts = None;
        let area = egui::Area::new(egui::Id::new("shortcut_help_popover"))
            .order(egui::Order::Tooltip)
            .pivot(egui::Align2::RIGHT_TOP)
            .fixed_pos(egui::pos2(
                trigger_rect.right(),
                trigger_rect.bottom() + 6.0,
            ))
            .show(ctx, |ui| {
                popover_frame(colors).show(ui, |ui| {
                    ui.set_width(width - 20.0);
                    egui::Frame::new()
                        .inner_margin(egui::Margin::same(16)) // p-4 = 16px.
                        .show(ui, |ui| {
                            ui.spacing_mut().item_spacing.y = 8.0; // gap-2 = 8px.
                            paint_section_header(ui, colors, "KEYBOARD SHORTCUTS", false);
                            ui.add_space(8.0); // spacing-2 between heading and table.
                            let mut divider_x = [0.0_f32; 2];
                            let grid = egui::Grid::new("shortcut_help_grid")
                                .num_columns(3)
                                .spacing(egui::vec2(16.0, 8.0)) // gap-x-4 / gap-y-2.
                                .show(ui, |ui| {
                                    ui.label("");
                                    let windows = ui.label(
                                        egui::RichText::new("Windows / Linux")
                                            .size(12.0)
                                            .color(colors.text_strong),
                                    );
                                    let macos = ui.label(
                                        egui::RichText::new("macOS")
                                            .size(12.0)
                                            .color(colors.text_strong),
                                    );
                                    divider_x =
                                        [windows.rect.left() - 8.0, macos.rect.left() - 8.0];
                                    ui.end_row();
                                    for (row, (label, control, command)) in
                                        SHORTCUT_ROWS.iter().enumerate()
                                    {
                                        ui.label(
                                            egui::RichText::new(*label)
                                                .size(14.0)
                                                .color(colors.text),
                                        );
                                        let control = ui.label(
                                            egui::RichText::new(*control)
                                                .monospace()
                                                .size(14.0)
                                                .color(colors.text),
                                        );
                                        let command = ui.label(
                                            egui::RichText::new(*command)
                                                .monospace()
                                                .size(14.0)
                                                .color(colors.text),
                                        );
                                        if row == 0 {
                                            shortcut_column_lefts = Some([
                                                windows.rect.left(),
                                                control.rect.left(),
                                                macos.rect.left(),
                                                command.rect.left(),
                                            ]);
                                        }
                                        ui.end_row();
                                    }
                                });
                            for x in divider_x {
                                ui.painter().line_segment(
                                    [
                                        egui::pos2(x, grid.response.rect.top()),
                                        egui::pos2(x, grid.response.rect.bottom()),
                                    ],
                                    egui::Stroke::new(1.0_f32, colors.line),
                                );
                            }
                        });
                });
            });
        publish_shortcut_help_debug_json(
            trigger_rect,
            ctx.input(|input| {
                input
                    .pointer
                    .hover_pos()
                    .is_some_and(|pos| trigger_rect.contains(pos))
            }),
            true,
            Some(area.response.rect.right()),
            shortcut_column_lefts,
        );
        self.picker_overlay_rect = Some(area.response.rect);
        if ctx.input(|input| input.pointer.any_pressed())
            && ctx
                .input(|input| input.pointer.interact_pos())
                .is_some_and(|pos| !trigger_rect.contains(pos) && !area.response.rect.contains(pos))
        {
            self.shortcut_help_open = false;
            ctx.request_repaint();
        }
    }

    fn show_edit_utilities(&mut self, ui: &mut egui::Ui, colors: &Colors, ctx: &egui::Context) {
        let edit_allowed = !self.library.active_locked();
        if icon_button(
            ui,
            colors,
            ToolbarIcon::Undo,
            ButtonState {
                enabled: edit_allowed && self.can_undo_circuit(),
                toggle_on: false,
            },
            "Undo",
        )
        .clicked()
        {
            self.undo_circuit(ctx);
        }
        if icon_button(
            ui,
            colors,
            ToolbarIcon::Redo,
            ButtonState {
                enabled: edit_allowed && self.can_redo_circuit(),
                toggle_on: false,
            },
            "Redo",
        )
        .clicked()
        {
            self.redo_circuit(ctx);
        }
        if icon_button(
            ui,
            colors,
            ToolbarIcon::Trash,
            ButtonState {
                enabled: edit_allowed,
                toggle_on: false,
            },
            "Clear circuit",
        )
        .clicked()
        {
            self.placed_gates.clear();
            self.update_qubit_count();
            self.gpu_plan.mark_dirty();
            self.external_gpu_status = ExternalGpuStatus::Idle;
            self.commit_current_circuit(ctx);
        }
        if icon_button(
            ui,
            colors,
            ToolbarIcon::Copy,
            ButtonState {
                enabled: true,
                toggle_on: false,
            },
            "Duplicate circuit",
        )
        .clicked()
        {
            self.duplicate_active_circuit(ctx);
        }
        let locked = self.library.active_locked();
        let example = matches!(
            self.library.active_kind(),
            qni_web_circuit_library_model::CircuitKind::Example
        );
        let (icon, tooltip) = if example {
            (ToolbarIcon::Lock, "Locked (sample) — duplicate to edit")
        } else if locked {
            (ToolbarIcon::Lock, "Unlock circuit")
        } else {
            (ToolbarIcon::LockOpen, "Lock circuit")
        };
        if icon_button(
            ui,
            colors,
            icon,
            ButtonState {
                enabled: !example,
                toggle_on: locked,
            },
            tooltip,
        )
        .clicked()
        {
            self.toggle_circuit_lock();
        }
    }

    fn show_gpu_execute_cluster(
        &mut self,
        ui: &mut egui::Ui,
        colors: &Colors,
        ctx: &egui::Context,
    ) {
        let running = self.external_gpu_status().is_running();
        let run = icon_button(
            ui,
            colors,
            ToolbarIcon::Play,
            ButtonState {
                enabled: !running,
                toggle_on: false,
            },
            "Run on GPU",
        );
        if running && run.hovered() {
            ui.output_mut(|output| output.cursor_icon = egui::CursorIcon::NotAllowed);
        }
        if run.clicked() {
            self.start_external_gpu_run(ctx);
        }
        let _ = gpu_status_pill(ui, self.external_gpu_status());
    }
}

fn toolbar_frame(colors: &Colors) -> egui::Frame {
    egui::Frame {
        inner_margin: egui::Margin::symmetric(12, 6), // px-3 / py-1.5 = 12px / 6px.
        fill: colors.surface,                         // Flexoki bg / paper.
        stroke: egui::Stroke::NONE,
        corner_radius: egui::CornerRadius::ZERO, // Full-width header strip: all 4 corners square.
        outer_margin: egui::Margin::ZERO,
        shadow: egui::epaint::Shadow {
            offset: [0, 4],
            blur: 24,
            spread: 0,
            color: colors.toolbar_shadow, // Flexoki tx alpha 15.
        },
    }
}

fn shortcut_help_trigger(ui: &mut egui::Ui, colors: &Colors, open: bool) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(egui::vec2(48.0, 32.0), egui::Sense::click());
    let response = response.on_hover_text(KEYBOARD_SHORTCUTS_TOOLTIP);
    let hovered = response.hovered() || open;
    let hover_t = ui
        .ctx()
        .animate_bool_with_time(response.id.with("hover"), hovered, 0.12);
    if hover_t > 0.0 {
        ui.painter().rect_filled(
            rect,
            egui::CornerRadius::same(6),
            with_alpha(colors.toolbar_hover_bg, (255.0 * hover_t) as u8),
        );
    }
    let color = if response.hovered() {
        colors.toolbar_icon_hover
    } else {
        colors.toolbar_icon
    };
    paint_icon(
        ui.painter(),
        egui::Rect::from_min_size(rect.min, TOOL_SIZE),
        ToolbarIcon::Keyboard,
        color,
    );
    let open_t = ui
        .ctx()
        .animate_bool_with_time(response.id.with("chevron"), open, 0.16);
    paint_chevron(
        ui.painter(),
        egui::pos2(rect.right() - 8.0, rect.center().y),
        open_t,
        color,
    );
    response.widget_info(|| {
        egui::WidgetInfo::selected(
            egui::WidgetType::Button,
            true,
            open,
            KEYBOARD_SHORTCUTS_TOOLTIP,
        )
    });
    publish_shortcut_help_debug_json(rect, response.hovered(), open, None, None);
    response
}

#[cfg(all(target_arch = "wasm32", debug_assertions))]
fn publish_shortcut_help_debug_json(
    rect: egui::Rect,
    hovered: bool,
    open: bool,
    popover_right: Option<f32>,
    column_lefts: Option<[f32; 4]>,
) {
    let popover_right = popover_right
        .map(|right| format!("{right:.3}"))
        .unwrap_or_else(|| "null".to_owned());
    let column_lefts = column_lefts
        .map(|[windows, control, macos, command]| {
            format!("[{windows:.3},{control:.3},{macos:.3},{command:.3}]")
        })
        .unwrap_or_else(|| "null".to_owned());
    let json = format!(
        "{{\"left\":{:.3},\"right\":{:.3},\"top\":{:.3},\"bottom\":{:.3},\"hovered\":{hovered},\"open\":{open},\"popoverRight\":{popover_right},\"columnLefts\":{column_lefts}}}",
        rect.left(),
        rect.right(),
        rect.top(),
        rect.bottom(),
    );
    crate::test_hooks::set_window_value(
        crate::test_hooks::QNI_TOOLBAR_SHORTCUT_GEOMETRY_JSON,
        &wasm_bindgen::JsValue::from_str(&json),
    );
    if hovered {
        crate::test_hooks::set_window_value(
            crate::test_hooks::QNI_TOOLBAR_TOOLTIP_TEXT,
            &wasm_bindgen::JsValue::from_str(KEYBOARD_SHORTCUTS_TOOLTIP),
        );
    }
}

#[cfg(any(not(target_arch = "wasm32"), not(debug_assertions)))]
fn publish_shortcut_help_debug_json(
    _rect: egui::Rect,
    _hovered: bool,
    _open: bool,
    _popover_right: Option<f32>,
    _column_lefts: Option<[f32; 4]>,
) {
}

#[derive(Clone, Copy)]
struct ButtonState {
    enabled: bool,
    toggle_on: bool,
}

fn icon_button(
    ui: &mut egui::Ui,
    colors: &Colors,
    icon: ToolbarIcon,
    state: ButtonState,
    tooltip: &'static str,
) -> egui::Response {
    let sense = if state.enabled {
        egui::Sense::click()
    } else {
        egui::Sense::hover()
    };
    let (rect, response) = ui.allocate_exact_size(TOOL_SIZE, sense);
    let response = response.on_hover_text(tooltip);
    let hovered = response.hovered() && state.enabled;
    publish_toolbar_button_debug_json(tooltip, rect, hovered);
    let hover_t = ui
        .ctx()
        .animate_bool_with_time(response.id.with("hover"), hovered, 0.12);
    if state.toggle_on && state.enabled {
        ui.painter().rect_filled(
            rect,
            egui::CornerRadius::same(6), // rounded-md = 6px.
            if hovered {
                colors.line // Flexoki ui-2.
            } else {
                colors.toolbar_hover_bg // Flexoki ui.
            },
        );
    } else if hover_t > 0.0 {
        ui.painter().rect_filled(
            rect,
            egui::CornerRadius::same(6), // rounded-md = 6px.
            with_alpha(colors.toolbar_hover_bg, (255.0 * hover_t) as u8), // Flexoki ui.
        );
    }

    let color = if state.enabled {
        if hovered {
            colors.toolbar_icon_hover // Flexoki tx.
        } else {
            colors.toolbar_icon // Flexoki tx-2.
        }
    } else {
        colors.toolbar_icon_disabled // Flexoki tx-3.
    };
    response.widget_info(|| {
        if matches!(icon, ToolbarIcon::Lock | ToolbarIcon::LockOpen) {
            egui::WidgetInfo::selected(
                egui::WidgetType::Checkbox,
                state.enabled,
                state.toggle_on,
                tooltip,
            )
        } else {
            egui::WidgetInfo::labeled(egui::WidgetType::Button, state.enabled, tooltip)
        }
    });
    paint_icon(ui.painter(), rect, icon, color);
    response
}

#[cfg(all(target_arch = "wasm32", debug_assertions))]
fn publish_toolbar_button_debug_json(tooltip: &str, rect: egui::Rect, hovered: bool) {
    let target = match tooltip {
        "Duplicate circuit" => Some(crate::test_hooks::QNI_TOOLBAR_DUPLICATE_GEOMETRY_JSON),
        "Lock circuit" | "Unlock circuit" | "Locked (sample) — duplicate to edit" => {
            Some(crate::test_hooks::QNI_TOOLBAR_LOCK_GEOMETRY_JSON)
        }
        _ => None,
    };
    let Some(target) = target else {
        return;
    };
    let json = format!(
        "{{\"left\":{:.3},\"right\":{:.3},\"top\":{:.3},\"bottom\":{:.3},\"hovered\":{},\"tooltip\":\"{}\"}}",
        rect.left(),
        rect.right(),
        rect.top(),
        rect.bottom(),
        hovered,
        tooltip.replace('"', "\\\""),
    );
    crate::test_hooks::set_window_value(target, &wasm_bindgen::JsValue::from_str(&json));
    if hovered {
        crate::test_hooks::set_window_value(
            crate::test_hooks::QNI_TOOLBAR_TOOLTIP_TEXT,
            &wasm_bindgen::JsValue::from_str(tooltip),
        );
    }
}

#[cfg(any(not(target_arch = "wasm32"), not(debug_assertions)))]
fn publish_toolbar_button_debug_json(_tooltip: &str, _rect: egui::Rect, _hovered: bool) {}

fn paint_toolbar_divider(ui: &mut egui::Ui, colors: &Colors) {
    let (rect, _) = ui.allocate_exact_size(
        egui::vec2(SECTION_DIVIDER_WIDTH + 4.0, 24.0), // 2px divider + mx-0.5 = 2px each side.
        egui::Sense::hover(),
    );
    let divider_rect = egui::Rect::from_center_size(
        rect.center(),
        egui::vec2(SECTION_DIVIDER_WIDTH, rect.height()),
    );
    // Match the gate-palette section separator: 2px Flexoki ui-2 solid rect.
    ui.painter()
        .rect_filled(divider_rect, egui::CornerRadius::ZERO, colors.line);
}

fn paint_icon(painter: &egui::Painter, rect: egui::Rect, icon: ToolbarIcon, color: egui::Color32) {
    let icon_rect = egui::Rect::from_center_size(rect.center(), ICON_SIZE);
    let stroke = egui::Stroke::new(2.0_f32, color); // Lucide stroke-2 at 18px scale.
    match icon {
        ToolbarIcon::Undo => {
            paint_path(
                painter,
                icon_rect,
                &[(9.0, 14.0), (4.0, 9.0), (9.0, 4.0)],
                false,
                stroke,
            );
            paint_path(
                painter,
                icon_rect,
                &[
                    (4.0, 9.0),
                    (15.0, 9.0),
                    (19.0, 11.0),
                    (19.0, 15.0),
                    (17.0, 18.0),
                    (14.0, 19.0),
                ],
                false,
                stroke,
            );
        }
        ToolbarIcon::Redo => {
            paint_path(
                painter,
                icon_rect,
                &[(15.0, 14.0), (20.0, 9.0), (15.0, 4.0)],
                false,
                stroke,
            );
            paint_path(
                painter,
                icon_rect,
                &[
                    (20.0, 9.0),
                    (9.0, 9.0),
                    (5.0, 11.0),
                    (5.0, 15.0),
                    (7.0, 18.0),
                    (10.0, 19.0),
                ],
                false,
                stroke,
            );
        }
        ToolbarIcon::Trash => {
            paint_path(
                painter,
                icon_rect,
                &[(3.0, 6.0), (21.0, 6.0)],
                false,
                stroke,
            );
            paint_path(
                painter,
                icon_rect,
                &[
                    (8.0, 6.0),
                    (8.0, 4.0),
                    (10.0, 2.0),
                    (14.0, 2.0),
                    (16.0, 4.0),
                    (16.0, 6.0),
                ],
                false,
                stroke,
            );
            paint_path(
                painter,
                icon_rect,
                &[
                    (5.0, 6.0),
                    (5.0, 20.0),
                    (7.0, 22.0),
                    (17.0, 22.0),
                    (19.0, 20.0),
                    (19.0, 6.0),
                ],
                false,
                stroke,
            );
        }
        ToolbarIcon::Copy => {
            paint_icon_rect_outline(painter, icon_rect, 9.0, 9.0, 13.0, 13.0, 2.0, stroke);
            paint_copy_back_path(painter, icon_rect, stroke);
        }
        ToolbarIcon::Lock => {
            paint_icon_rect_outline(painter, icon_rect, 3.0, 11.0, 18.0, 11.0, 2.0, stroke);
            paint_shackle_closed(painter, icon_rect, stroke);
        }
        ToolbarIcon::LockOpen => {
            paint_icon_rect_outline(painter, icon_rect, 3.0, 11.0, 18.0, 11.0, 2.0, stroke);
            paint_shackle_open(painter, icon_rect, stroke);
        }
        ToolbarIcon::Play => {
            paint_path(
                painter,
                icon_rect,
                &[(6.0, 4.0), (20.0, 12.0), (6.0, 20.0)],
                true,
                stroke,
            );
        }
        ToolbarIcon::Keyboard => {
            paint_icon_rect_outline(painter, icon_rect, 2.0, 5.0, 20.0, 14.0, 2.0, stroke);
            let scale = icon_rect.width() / 24.0;
            for y in [9.0, 13.0] {
                for x in [6.0, 10.0, 14.0, 18.0] {
                    painter.rect_filled(
                        egui::Rect::from_center_size(
                            icon_point(icon_rect, x, y),
                            egui::vec2(2.5 * scale, 2.0 * scale),
                        ),
                        egui::CornerRadius::ZERO,
                        color,
                    );
                }
            }
            painter.rect_filled(
                egui::Rect::from_center_size(
                    icon_point(icon_rect, 12.0, 17.0),
                    egui::vec2(10.0 * scale, 2.0 * scale),
                ),
                egui::CornerRadius::ZERO,
                color,
            );
        }
    }
}

fn paint_icon_rect_outline(
    painter: &egui::Painter,
    icon_rect: egui::Rect,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    radius: f32,
    stroke: egui::Stroke,
) {
    let rect = egui::Rect::from_min_size(
        icon_point(icon_rect, x, y),
        egui::vec2(
            icon_rect.width() * width / 24.0,
            icon_rect.height() * height / 24.0,
        ),
    );
    let radius = (icon_rect.width() * radius / 24.0).round().max(0.0) as u8;
    painter.rect_stroke(
        rect,
        egui::CornerRadius::same(radius),
        stroke,
        egui::StrokeKind::Middle,
    );
}

fn paint_copy_back_path(painter: &egui::Painter, icon_rect: egui::Rect, stroke: egui::Stroke) {
    let mut points = Vec::with_capacity(20);
    points.push(icon_point(icon_rect, 5.0, 15.0));
    points.push(icon_point(icon_rect, 4.0, 15.0));
    append_icon_arc(&mut points, icon_rect, (4.0, 13.0), 2.0, 90.0, 180.0);
    points.push(icon_point(icon_rect, 2.0, 4.0));
    append_icon_arc(&mut points, icon_rect, (4.0, 4.0), 2.0, 180.0, 270.0);
    points.push(icon_point(icon_rect, 13.0, 2.0));
    append_icon_arc(&mut points, icon_rect, (13.0, 4.0), 2.0, -90.0, 0.0);
    points.push(icon_point(icon_rect, 15.0, 5.0));
    painter.add(egui::Shape::Path(egui::epaint::PathShape::line(
        points, stroke,
    )));
}

fn paint_shackle_closed(painter: &egui::Painter, icon_rect: egui::Rect, stroke: egui::Stroke) {
    let mut points = Vec::with_capacity(10);
    points.push(icon_point(icon_rect, 7.0, 11.0));
    points.push(icon_point(icon_rect, 7.0, 7.0));
    append_icon_arc(&mut points, icon_rect, (12.0, 7.0), 5.0, 180.0, 360.0);
    points.push(icon_point(icon_rect, 17.0, 11.0));
    painter.add(egui::Shape::Path(egui::epaint::PathShape::line(
        points, stroke,
    )));
}

fn paint_shackle_open(painter: &egui::Painter, icon_rect: egui::Rect, stroke: egui::Stroke) {
    let mut points = Vec::with_capacity(9);
    points.push(icon_point(icon_rect, 7.0, 11.0));
    points.push(icon_point(icon_rect, 7.0, 7.0));
    append_icon_arc(&mut points, icon_rect, (12.0, 7.0), 5.0, 180.0, 348.0);
    painter.add(egui::Shape::Path(egui::epaint::PathShape::line(
        points, stroke,
    )));
}

fn append_icon_arc(
    points: &mut Vec<egui::Pos2>,
    icon_rect: egui::Rect,
    center: (f32, f32),
    radius: f32,
    start_degrees: f32,
    end_degrees: f32,
) {
    const STEPS: usize = 6;
    for step in 1..=STEPS {
        let t = step as f32 / STEPS as f32;
        let degrees = start_degrees + (end_degrees - start_degrees) * t;
        let radians = degrees.to_radians();
        points.push(icon_point(
            icon_rect,
            center.0 + radius * radians.cos(),
            center.1 + radius * radians.sin(),
        ));
    }
}

fn paint_path(
    painter: &egui::Painter,
    icon_rect: egui::Rect,
    points: &[(f32, f32)],
    closed: bool,
    stroke: egui::Stroke,
) {
    let points = points
        .iter()
        .map(|(x, y)| icon_point(icon_rect, *x, *y))
        .collect::<Vec<_>>();
    let shape = if closed {
        egui::epaint::PathShape::closed_line(points, stroke)
    } else {
        egui::epaint::PathShape::line(points, stroke)
    };
    painter.add(egui::Shape::Path(shape));
}

fn icon_point(icon_rect: egui::Rect, x: f32, y: f32) -> egui::Pos2 {
    egui::pos2(
        icon_rect.left() + icon_rect.width() * x / 24.0,
        icon_rect.top() + icon_rect.height() * y / 24.0,
    )
}
