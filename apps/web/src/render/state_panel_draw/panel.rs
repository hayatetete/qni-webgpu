use eframe::egui;

use crate::colors::{with_alpha, Colors};

pub(super) fn paint_panel_background(
    painter: &egui::Painter,
    colors: &Colors,
    state_rect: egui::Rect,
) {
    let state_corner = egui::CornerRadius::same(14);
    let state_shadow = egui::epaint::Shadow {
        offset: [0, 6],
        blur: 16,
        spread: 0,
        color: colors.state_panel_shadow,
    };
    painter.add(egui::Shape::Rect(
        state_shadow.as_shape(state_rect, state_corner),
    ));
    painter.rect_filled(state_rect, state_corner, colors.surface);
}

pub(super) fn paint_capacity_error(
    painter: &egui::Painter,
    colors: &Colors,
    viewport_rect: egui::Rect,
    message: &str,
) {
    let center = viewport_rect.center();
    let card = egui::Rect::from_center_size(
        center,
        egui::vec2((viewport_rect.width() - 32.0).clamp(160.0, 420.0), 64.0), // px-8 total margin, h-16 = 64px.
    );
    painter.rect_filled(
        card,
        egui::CornerRadius::same(12),        // rounded-xl = 12px.
        with_alpha(colors.semantic_off, 18), // Flexoki red-600 alpha.
    );
    painter.rect_stroke(
        card,
        egui::CornerRadius::same(12), // rounded-xl = 12px.
        egui::Stroke::new(1.0_f32, colors.semantic_off), // Flexoki red-600.
        egui::StrokeKind::Outside,
    );
    painter.text(
        egui::pos2(center.x, center.y - 12.0), // spacing-3 = 12px.
        egui::Align2::CENTER_CENTER,
        "GPU capacity limit exceeded",
        egui::FontId::new(14.0, egui::FontFamily::Proportional), // text-sm = 14px.
        colors.semantic_off,                                     // Flexoki red-600.
    );
    painter.text(
        egui::pos2(center.x, center.y + 12.0), // spacing-3 = 12px.
        egui::Align2::CENTER_CENTER,
        truncate_capacity_message(message),
        egui::FontId::new(12.0, egui::FontFamily::Proportional), // text-xs = 12px.
        colors.text,                                             // Flexoki tx-2.
    );
}

fn truncate_capacity_message(message: &str) -> String {
    const MAX_CHARS: usize = 72;
    if message.chars().count() <= MAX_CHARS {
        return message.to_owned();
    }
    let mut truncated = message.chars().take(MAX_CHARS - 1).collect::<String>();
    truncated.push('…');
    truncated
}
