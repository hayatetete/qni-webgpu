use eframe::egui;

use crate::app::circuit_library::CircuitEntry;
use crate::colors::{with_alpha, Colors};

use super::constants::{
    ITEMS_SCROLLBAR_HOVER_ALPHA, ITEMS_SCROLLBAR_IDLE_ALPHA, ITEMS_SCROLLBAR_OUTER_MARGIN,
    ITEMS_SCROLLBAR_THUMB_RADIUS, ITEMS_SCROLLBAR_W, ITEM_HEIGHT, ITEM_PAD_X, ITEM_RADIUS,
    RESIZE_HANDLE_ACTIVE_STROKE, RESIZE_HANDLE_IDLE_STROKE, RESIZE_HANDLE_LINE_INSET_X,
    ROW_ICON_SIZE, ROW_TEXT_OFFSET, SECTION_HEADER_HEIGHT, SECTION_HEADER_TOP_MARGIN,
};

pub(crate) fn popover_frame(colors: &Colors) -> egui::Frame {
    egui::Frame {
        inner_margin: egui::Margin::same(6),             // p-1.5 = 6px.
        fill: colors.surface,                            // Flexoki bg / paper.
        stroke: egui::Stroke::new(1.0_f32, colors.line), // Flexoki ui-2.
        corner_radius: egui::CornerRadius::same(12),     // rounded-xl = 12px.
        outer_margin: egui::Margin::ZERO,
        shadow: egui::epaint::Shadow {
            offset: [0, 12],
            blur: 32,
            spread: 0,
            color: with_alpha(colors.text_strong, 25),
        },
    }
}

#[cfg(all(target_arch = "wasm32", debug_assertions))]
pub(super) fn publish_picker_dropdown_geometry_json(
    trigger_rect: egui::Rect,
    dropdown_rect: egui::Rect,
    topbar_bottom_offset: f32,
) {
    let json = format!(
        "{{\"trigger_top\":{:.3},\"trigger_bottom\":{:.3},\"topbar_bottom\":{:.3},\"dropdown_top\":{:.3},\"dropdown_bottom\":{:.3}}}",
        trigger_rect.top(),
        trigger_rect.bottom(),
        trigger_rect.bottom() + topbar_bottom_offset,
        dropdown_rect.top(),
        dropdown_rect.bottom(),
    );
    crate::test_hooks::set_window_value(
        crate::test_hooks::QNI_CIRCUIT_PICKER_DROPDOWN_GEOMETRY_JSON,
        &wasm_bindgen::JsValue::from_str(&json),
    );
}

#[cfg(any(not(target_arch = "wasm32"), not(debug_assertions)))]
pub(super) fn publish_picker_dropdown_geometry_json(
    _trigger_rect: egui::Rect,
    _dropdown_rect: egui::Rect,
    _topbar_bottom_offset: f32,
) {
}

#[cfg(all(target_arch = "wasm32", debug_assertions))]
#[allow(clippy::too_many_arguments)]
pub(super) fn publish_picker_resize_geometry_json(
    items_height: f32,
    max_items_height: f32,
    items_rect: egui::Rect,
    handle_rect: egui::Rect,
    footer_rect: egui::Rect,
    first_row_rect: Option<egui::Rect>,
    last_row_rect: Option<egui::Rect>,
    scroll_offset_y: f32,
    hovered: bool,
    dragging: bool,
    item_dragging: bool,
) {
    let first_row_top = first_row_rect
        .map(|rect| rect.top())
        .unwrap_or_else(|| items_rect.top());
    let last_row_bottom = last_row_rect
        .map(|rect| rect.bottom())
        .unwrap_or_else(|| items_rect.bottom());
    let json = format!(
        "{{\"items_height\":{items_height:.3},\"max_items_height\":{max_items_height:.3},\"items_top\":{:.3},\"items_bottom\":{:.3},\"handle_left\":{:.3},\"handle_right\":{:.3},\"handle_top\":{:.3},\"handle_bottom\":{:.3},\"footer_top\":{:.3},\"footer_bottom\":{:.3},\"first_row_top\":{first_row_top:.3},\"last_row_bottom\":{last_row_bottom:.3},\"scroll_offset_y\":{scroll_offset_y:.3},\"hovered\":{hovered},\"dragging\":{dragging},\"item_dragging\":{item_dragging}}}",
        items_rect.top(),
        items_rect.bottom(),
        handle_rect.left(),
        handle_rect.right(),
        handle_rect.top(),
        handle_rect.bottom(),
        footer_rect.top(),
        footer_rect.bottom(),
    );
    crate::test_hooks::set_window_value(
        crate::test_hooks::QNI_CIRCUIT_PICKER_RESIZE_GEOMETRY_JSON,
        &wasm_bindgen::JsValue::from_str(&json),
    );
}

#[cfg(any(not(target_arch = "wasm32"), not(debug_assertions)))]
#[allow(clippy::too_many_arguments)]
pub(super) fn publish_picker_resize_geometry_json(
    _items_height: f32,
    _max_items_height: f32,
    _items_rect: egui::Rect,
    _handle_rect: egui::Rect,
    _footer_rect: egui::Rect,
    _first_row_rect: Option<egui::Rect>,
    _last_row_rect: Option<egui::Rect>,
    _scroll_offset_y: f32,
    _hovered: bool,
    _dragging: bool,
    _item_dragging: bool,
) {
}

#[cfg(all(target_arch = "wasm32", debug_assertions))]
pub(super) fn publish_picker_submenu_geometry_json(
    index: usize,
    parent_row_rect: egui::Rect,
    kebab_rect: egui::Rect,
    submenu_rect: egui::Rect,
) {
    let json = format!(
        "{{\"index\":{index},\"parent_row_top\":{:.3},\"kebab_left\":{:.3},\"kebab_right\":{:.3},\"submenu_left\":{:.3},\"submenu_right\":{:.3},\"submenu_top\":{:.3}}}",
        parent_row_rect.top(),
        kebab_rect.left(),
        kebab_rect.right(),
        submenu_rect.left(),
        submenu_rect.right(),
        submenu_rect.top(),
    );
    crate::test_hooks::set_window_value(
        crate::test_hooks::QNI_CIRCUIT_PICKER_GEOMETRY_JSON,
        &wasm_bindgen::JsValue::from_str(&json),
    );
}

#[cfg(any(not(target_arch = "wasm32"), not(debug_assertions)))]
pub(super) fn publish_picker_submenu_geometry_json(
    _index: usize,
    _parent_row_rect: egui::Rect,
    _kebab_rect: egui::Rect,
    _submenu_rect: egui::Rect,
) {
}

pub(super) fn apply_items_scrollbar_style(ui: &mut egui::Ui, colors: &Colors) {
    let style = ui.style_mut();
    style.spacing.scroll.floating = true;
    style.spacing.scroll.bar_width = ITEMS_SCROLLBAR_W;
    style.spacing.scroll.floating_width = ITEMS_SCROLLBAR_W;
    style.spacing.scroll.floating_allocated_width = 0.0;
    style.spacing.scroll.bar_inner_margin = 0.0;
    style.spacing.scroll.bar_outer_margin = ITEMS_SCROLLBAR_OUTER_MARGIN;
    style.spacing.scroll.foreground_color = false;
    style.spacing.scroll.dormant_background_opacity = 0.0;
    style.spacing.scroll.active_background_opacity = 0.0;
    style.spacing.scroll.interact_background_opacity = 0.0;
    style.spacing.scroll.dormant_handle_opacity = 0.0;
    style.spacing.scroll.active_handle_opacity = 1.0;
    style.spacing.scroll.interact_handle_opacity = 1.0;

    let idle_thumb = with_alpha(
        colors.toolbar_icon_disabled, // Flexoki tx-3 #B7B5AC @ 60%.
        ITEMS_SCROLLBAR_IDLE_ALPHA,
    );
    let hover_thumb = with_alpha(
        colors.toolbar_icon, // Flexoki tx-2 #6F6E69 @ 70%.
        ITEMS_SCROLLBAR_HOVER_ALPHA,
    );
    let radius = egui::CornerRadius::same(ITEMS_SCROLLBAR_THUMB_RADIUS);
    style.visuals.widgets.inactive.bg_fill = idle_thumb;
    style.visuals.widgets.inactive.corner_radius = radius;
    style.visuals.widgets.hovered.bg_fill = hover_thumb;
    style.visuals.widgets.hovered.corner_radius = radius;
    style.visuals.widgets.active.bg_fill = hover_thumb;
    style.visuals.widgets.active.corner_radius = radius;
}

pub(super) fn paint_dragged_row_background(
    painter: &egui::Painter,
    colors: &Colors,
    rect: egui::Rect,
) {
    painter.rect_filled(
        rect,
        egui::CornerRadius::same(ITEM_RADIUS),
        colors.toolbar_hover_bg, // Flexoki ui.
    );
}

pub(super) fn paint_picker_item_text(
    ui: &egui::Ui,
    colors: &Colors,
    rect: egui::Rect,
    kebab_rect: egui::Rect,
    entry: &CircuitEntry,
    active: bool,
    alpha: u8,
) {
    let font = egui::FontId::new(14.0, egui::FontFamily::Proportional); // text-sm = 14px.
    let name_rect = egui::Rect::from_min_max(
        egui::pos2(rect.left() + ROW_TEXT_OFFSET, rect.top()), // px-2.5 + 14px icon + gap-2.
        egui::pos2(kebab_rect.left() - 8.0, rect.bottom()),    // spacing-2.
    );
    let color = with_alpha(colors.text_strong, alpha);
    if entry.locked() {
        paint_row_lock(
            ui.painter(),
            egui::pos2(
                rect.left() + ITEM_PAD_X + ROW_ICON_SIZE / 2.0,
                rect.center().y,
            ),
            with_alpha(colors.text_strong, alpha),
        );
    }
    let mut text = egui::RichText::new(entry.name.clone())
        .font(font.clone())
        .color(color);
    if active {
        text = text.strong();
    }
    let galley = egui::WidgetText::from(text).into_galley(
        ui,
        Some(egui::TextWrapMode::Truncate),
        name_rect.width(),
        font,
    );
    ui.painter().galley(
        egui::pos2(
            name_rect.left(),
            name_rect.center().y - galley.size().y / 2.0,
        ),
        galley,
        color,
    );
}

pub(crate) fn paint_section_header(
    ui: &mut egui::Ui,
    colors: &Colors,
    label: &'static str,
    top_margin: bool,
) -> egui::Rect {
    if top_margin {
        ui.add_space(SECTION_HEADER_TOP_MARGIN); // mt-1.5 = 6px.
    }
    let (rect, _) = ui.allocate_exact_size(
        egui::vec2(ui.available_width(), SECTION_HEADER_HEIGHT),
        egui::Sense::hover(),
    );
    let color = colors.toolbar_icon_disabled; // Flexoki tx-3.
    let galley = ui.painter().layout_no_wrap(
        label.to_owned(),
        egui::FontId::new(12.0, egui::FontFamily::Proportional), // text-xs = 12px.
        color,
    );
    let text_pos = egui::pos2(
        rect.left() + ROW_TEXT_OFFSET,
        rect.center().y - galley.size().y / 2.0,
    );
    let line_y = rect.center().y;
    ui.painter().line_segment(
        [
            egui::pos2(rect.left() + ITEM_PAD_X, line_y),
            egui::pos2(rect.left() + ITEM_PAD_X + ROW_ICON_SIZE, line_y),
        ],
        egui::Stroke::new(1.0_f32, colors.line), // Flexoki ui-2.
    );
    ui.painter().galley(text_pos, galley.clone(), color);
    ui.painter().line_segment(
        [
            egui::pos2(text_pos.x + galley.size().x + 6.0, line_y),
            egui::pos2(rect.right() - 4.0, line_y),
        ],
        egui::Stroke::new(1.0_f32, colors.line), // Flexoki ui-2.
    );
    rect
}

pub(super) fn footer(ui: &mut egui::Ui, colors: &Colors) -> (egui::Response, egui::Rect) {
    let (rect, response) = ui.allocate_exact_size(
        egui::vec2(ui.available_width(), ITEM_HEIGHT),
        egui::Sense::click(),
    );
    if response.hovered() {
        ui.painter().rect_filled(
            rect,
            egui::CornerRadius::same(ITEM_RADIUS),
            colors.background, // Flexoki bg-2.
        );
    }
    let color = colors.text_strong; // Flexoki tx, matching circuit item labels.
    let galley = ui.painter().layout_no_wrap(
        "Create new circuit".to_owned(),
        egui::FontId::new(14.0, egui::FontFamily::Proportional), // text-sm = 14px.
        color,
    );
    ui.painter().galley(
        egui::pos2(
            rect.left() + ROW_TEXT_OFFSET,
            rect.center().y - galley.size().y / 2.0,
        ),
        galley,
        color,
    );
    paint_plus(
        ui.painter(),
        egui::pos2(
            rect.left() + ITEM_PAD_X + ROW_ICON_SIZE / 2.0,
            rect.center().y,
        ),
        color,
    );
    (response, rect)
}

pub(super) fn paint_resize_separator(
    ui: &mut egui::Ui,
    colors: &Colors,
    rect: egui::Rect,
    active: bool,
) {
    let stroke_width = if active {
        RESIZE_HANDLE_ACTIVE_STROKE
    } else {
        RESIZE_HANDLE_IDLE_STROKE
    };
    let color = if active {
        colors.semantic_on // Flexoki blue-600.
    } else {
        colors.line // Flexoki ui-2.
    };
    let y = rect.center().y;
    ui.painter().line_segment(
        [
            egui::pos2(rect.left() + RESIZE_HANDLE_LINE_INSET_X, y), // spacing-1 = 4px.
            egui::pos2(rect.right() - RESIZE_HANDLE_LINE_INSET_X, y), // spacing-1 = 4px.
        ],
        egui::Stroke::new(stroke_width, color),
    );
}

pub(super) fn submenu_item(
    ui: &mut egui::Ui,
    colors: &Colors,
    label: &'static str,
    enabled: bool,
    destructive: bool,
) -> egui::Response {
    let sense = if enabled {
        egui::Sense::click()
    } else {
        egui::Sense::hover()
    };
    let (rect, response) =
        ui.allocate_exact_size(egui::vec2(ui.available_width(), ITEM_HEIGHT), sense);
    if response.hovered() && enabled {
        ui.painter().rect_filled(
            rect,
            egui::CornerRadius::same(ITEM_RADIUS),
            if destructive {
                with_alpha(colors.semantic_off, 20)
            } else {
                colors.background
            },
        );
    }
    let color = if !enabled {
        colors.toolbar_icon_disabled
    } else if destructive {
        colors.semantic_off
    } else {
        colors.text_strong
    };
    let galley = ui.painter().layout_no_wrap(
        label.to_owned(),
        egui::FontId::new(14.0, egui::FontFamily::Proportional), // text-sm = 14px.
        color,
    );
    ui.painter().galley(
        egui::pos2(rect.left() + 12.0, rect.center().y - galley.size().y / 2.0), // px-3 = 12px.
        galley,
        color,
    );
    if !enabled && response.hovered() {
        ui.output_mut(|output| output.cursor_icon = egui::CursorIcon::NotAllowed);
    }
    response
}

pub(super) fn paint_divider(ui: &mut egui::Ui, colors: &Colors) {
    let (rect, _) =
        ui.allocate_exact_size(egui::vec2(ui.available_width(), 13.0), egui::Sense::hover());
    ui.painter().line_segment(
        [
            egui::pos2(rect.left() + 4.0, rect.center().y),
            egui::pos2(rect.right() - 4.0, rect.center().y),
        ],
        egui::Stroke::new(1.0_f32, colors.line),
    );
}

pub(crate) fn paint_chevron(
    painter: &egui::Painter,
    center: egui::Pos2,
    open_t: f32,
    color: egui::Color32,
) {
    let angle = std::f32::consts::PI * open_t;
    let p0 = center + rotate(egui::vec2(-4.0, -2.0), angle);
    let p1 = center + rotate(egui::vec2(0.0, 2.0), angle);
    let p2 = center + rotate(egui::vec2(4.0, -2.0), angle);
    painter.line_segment([p0, p1], egui::Stroke::new(1.8_f32, color));
    painter.line_segment([p1, p2], egui::Stroke::new(1.8_f32, color));
}

pub(super) fn paint_kebab(painter: &egui::Painter, center: egui::Pos2, color: egui::Color32) {
    for y in [-4.0, 0.0, 4.0] {
        painter.circle_filled(center + egui::vec2(0.0, y), 1.2, color);
    }
}

fn paint_plus(painter: &egui::Painter, center: egui::Pos2, color: egui::Color32) {
    let stroke = egui::Stroke::new(1.8_f32, color);
    painter.line_segment(
        [
            center + egui::vec2(-4.5, 0.0),
            center + egui::vec2(4.5, 0.0),
        ],
        stroke,
    );
    painter.line_segment(
        [
            center + egui::vec2(0.0, -4.5),
            center + egui::vec2(0.0, 4.5),
        ],
        stroke,
    );
}

fn paint_row_lock(painter: &egui::Painter, center: egui::Pos2, color: egui::Color32) {
    let stroke = egui::Stroke::new(1.2_f32, color);
    let body = egui::Rect::from_center_size(center + egui::vec2(0.0, 2.0), egui::vec2(10.0, 8.0));
    painter.rect_stroke(
        body,
        egui::CornerRadius::same(2),
        stroke,
        egui::StrokeKind::Middle,
    );
    let shackle = vec![
        center + egui::vec2(-3.0, -1.0),
        center + egui::vec2(-3.0, -4.0),
        center + egui::vec2(0.0, -6.0),
        center + egui::vec2(3.0, -4.0),
        center + egui::vec2(3.0, -1.0),
    ];
    painter.add(egui::Shape::Path(egui::epaint::PathShape::line(
        shackle, stroke,
    )));
}

fn rotate(point: egui::Vec2, angle: f32) -> egui::Vec2 {
    let (sin, cos) = angle.sin_cos();
    egui::vec2(point.x * cos - point.y * sin, point.x * sin + point.y * cos)
}
