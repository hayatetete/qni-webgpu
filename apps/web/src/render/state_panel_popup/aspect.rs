use eframe::egui;

use crate::colors::{with_alpha, Colors};

const PANEL_RADIUS: u8 = 12; // rounded-xl = 12px.
const PANEL_PADDING: f32 = 6.0; // p-1.5 = 6px.
const ITEM_HEIGHT: f32 = 36.0; // h-9 = 36px.
const ITEM_RADIUS: u8 = 6; // rounded-md = 6px.
const ITEM_PAD_X: f32 = 10.0; // px-2.5 = 10px.
const THUMB_SLOT_W: f32 = 50.0;
const THUMB_SLOT_H: f32 = 16.0;
const THUMB_TEXT_GAP: f32 = 12.0; // spacing-3 = 12px.
const TEXT_SM: f32 = 14.0; // text-sm = 14px.

/// Draw the aspect popover (background + rows). Chrome and row rhythm mirror
/// the Circuit picker dropdown: paper bg, ui-2 1px border, rounded-xl,
/// p-1.5, shadow-popover, and 36px proportional rows.
pub(crate) fn draw_aspect_popover(
    painter: &egui::Painter,
    colors: &Colors,
    panel_rect: egui::Rect,
    dims_rect: egui::Rect,
    rect: egui::Rect,
    rows: &[egui::Rect],
    qubits: usize,
    current_aspect: usize,
) {
    let corner = egui::CornerRadius::same(PANEL_RADIUS);
    let shadow = egui::epaint::Shadow {
        offset: [0, 12],
        blur: 32,
        spread: 0,
        color: with_alpha(colors.text_strong, 25), // Flexoki tx alpha, shadow-popover.
    };
    painter.add(egui::Shape::Rect(shadow.as_shape(rect, corner)));
    painter.rect_filled(rect, corner, colors.surface); // Flexoki bg / paper.
    painter.rect_stroke(
        rect,
        corner,
        egui::Stroke::new(1.0_f32, colors.line), // Flexoki ui-2.
        egui::StrokeKind::Inside,
    );

    let pointer_pos = painter.ctx().input(|input| input.pointer.hover_pos());
    for (i, row_rect) in rows.iter().enumerate() {
        let is_current = i == current_aspect;
        let hovered = pointer_pos.is_some_and(|pos| row_rect.contains(pos));
        let cols = 1usize << i;
        let layout_rows = 1usize << (qubits - i);
        if hovered {
            painter.rect_filled(
                *row_rect,
                egui::CornerRadius::same(ITEM_RADIUS),
                colors.background, // Flexoki bg-2.
            );
        }

        paint_aspect_thumbnail(painter, colors, *row_rect, cols, layout_rows);
        paint_aspect_row_text(painter, colors, *row_rect, cols, layout_rows, is_current);
    }

    publish_aspect_popover_geometry_json(panel_rect, dims_rect, rect, rows, current_aspect);
}

fn paint_aspect_thumbnail(
    painter: &egui::Painter,
    colors: &Colors,
    row_rect: egui::Rect,
    cols: usize,
    layout_rows: usize,
) {
    let slot_min = egui::pos2(
        row_rect.min.x + ITEM_PAD_X,
        row_rect.center().y - THUMB_SLOT_H / 2.0,
    );
    let slot_rect = egui::Rect::from_min_size(slot_min, egui::vec2(THUMB_SLOT_W, THUMB_SLOT_H));
    let aspect_scale = (THUMB_SLOT_W / cols as f32).min(THUMB_SLOT_H / layout_rows as f32);
    let thumb_w = (cols as f32 * aspect_scale).max(1.0);
    let thumb_h = (layout_rows as f32 * aspect_scale).max(1.0);
    let thumb_min = egui::pos2(
        slot_rect.center().x - thumb_w / 2.0,
        slot_rect.center().y - thumb_h / 2.0,
    );
    painter.rect_filled(
        egui::Rect::from_min_size(thumb_min, egui::vec2(thumb_w, thumb_h)),
        egui::CornerRadius::ZERO,
        colors.aspect_thumb_idle, // Flexoki tx-2 alpha; unchanged gray thumbnail.
    );
}

fn paint_aspect_row_text(
    painter: &egui::Painter,
    colors: &Colors,
    row_rect: egui::Rect,
    cols: usize,
    layout_rows: usize,
    is_current: bool,
) {
    let regular_font = egui::FontId::new(TEXT_SM, egui::FontFamily::Proportional);
    let medium_font = egui::FontId::new(TEXT_SM, egui::FontFamily::Name("geist-medium".into()));
    let font = if is_current {
        medium_font.clone() // Geist Medium 500 for active / "(now)" identifier.
    } else {
        regular_font
    };
    let label = format!("{} × {}", cols, layout_rows);
    let label_pos = egui::pos2(
        row_rect.left() + ITEM_PAD_X + THUMB_SLOT_W + THUMB_TEXT_GAP,
        row_rect.center().y,
    );
    let color = colors.text_strong; // Flexoki tx; no blue active text.
    let galley = painter.layout_no_wrap(label, font.clone(), color);
    painter.galley(
        egui::pos2(label_pos.x, label_pos.y - galley.size().y / 2.0),
        galley,
        color,
    );

    if is_current {
        let now = painter.layout_no_wrap("(now)".to_owned(), font, color);
        painter.galley(
            egui::pos2(
                row_rect.right() - ITEM_PAD_X - now.size().x,
                row_rect.center().y - now.size().y / 2.0,
            ),
            now,
            color,
        );
    }
}

#[cfg(all(target_arch = "wasm32", debug_assertions))]
fn publish_aspect_popover_geometry_json(
    panel_rect: egui::Rect,
    dims_rect: egui::Rect,
    popover_rect: egui::Rect,
    rows: &[egui::Rect],
    current_aspect: usize,
) {
    let rows_json = rows
        .iter()
        .map(|row| {
            format!(
                "{{\"left\":{:.3},\"right\":{:.3},\"top\":{:.3},\"bottom\":{:.3}}}",
                row.left(),
                row.right(),
                row.top(),
                row.bottom(),
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let json = format!(
        "{{\"panel_left\":{:.3},\"panel_right\":{:.3},\"panel_top\":{:.3},\"trigger_top\":{:.3},\"trigger_bottom\":{:.3},\"popover_left\":{:.3},\"popover_right\":{:.3},\"popover_top\":{:.3},\"popover_bottom\":{:.3},\"padding\":{:.3},\"item_height\":{:.3},\"current_aspect\":{},\"rows\":[{}]}}",
        panel_rect.left(),
        panel_rect.right(),
        panel_rect.top(),
        dims_rect.top(),
        dims_rect.bottom(),
        popover_rect.left(),
        popover_rect.right(),
        popover_rect.top(),
        popover_rect.bottom(),
        PANEL_PADDING,
        ITEM_HEIGHT,
        current_aspect,
        rows_json,
    );
    crate::test_hooks::set_window_value(
        crate::test_hooks::QNI_ASPECT_POPOVER_GEOMETRY_JSON,
        &wasm_bindgen::JsValue::from_str(&json),
    );
}

#[cfg(any(not(target_arch = "wasm32"), not(debug_assertions)))]
fn publish_aspect_popover_geometry_json(
    _panel_rect: egui::Rect,
    _dims_rect: egui::Rect,
    _popover_rect: egui::Rect,
    _rows: &[egui::Rect],
    _current_aspect: usize,
) {
}
