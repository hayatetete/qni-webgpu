//! Shared popover chrome: paper card, tx-3 outline, soft shadow, and an
//! optional triangular tail whose base seam is hidden under the card fill.

use eframe::egui;

use crate::colors::Colors;

pub(crate) const RADIUS: u8 = 10;
pub(crate) const TAIL_H: f32 = 8.0;
pub(crate) const TAIL_HALF_W: f32 = 8.0;
pub(crate) const ANCHOR_GAP: f32 = 4.0;
pub(crate) const VIEWPORT_PAD: f32 = 4.0;

const TAIL_SEAM_CARD_OVERLAP: f32 = 2.0;
const TAIL_SEAM_TAIL_OVERLAP: f32 = 0.5;
const TAIL_SEAM_PAD: f32 = 0.75;
const TAIL_OUTLINE_WIDTH: f32 = 1.5;

#[derive(Clone, Copy, Debug)]
pub(crate) struct PopoverTail {
    base_l: egui::Pos2,
    base_r: egui::Pos2,
    apex: egui::Pos2,
}

impl PopoverTail {
    pub(crate) fn from_points(base_l: egui::Pos2, base_r: egui::Pos2, apex: egui::Pos2) -> Self {
        Self {
            base_l,
            base_r,
            apex,
        }
    }

    pub(crate) fn on_top_edge(rect: egui::Rect, anchor_x: f32) -> Self {
        let x = clamp_tail_anchor(anchor_x, rect.left(), rect.right());
        Self::from_points(
            egui::pos2(x - TAIL_HALF_W, rect.top()),
            egui::pos2(x + TAIL_HALF_W, rect.top()),
            egui::pos2(x, rect.top() - TAIL_H),
        )
    }

    pub(crate) fn on_bottom_edge(rect: egui::Rect, anchor_x: f32) -> Self {
        let x = clamp_tail_anchor(anchor_x, rect.left(), rect.right());
        Self::from_points(
            egui::pos2(x - TAIL_HALF_W, rect.bottom()),
            egui::pos2(x + TAIL_HALF_W, rect.bottom()),
            egui::pos2(x, rect.bottom() + TAIL_H),
        )
    }

    pub(crate) fn on_left_edge(rect: egui::Rect, anchor_y: f32) -> Self {
        let y = clamp_tail_anchor(anchor_y, rect.top(), rect.bottom());
        Self::from_points(
            egui::pos2(rect.left(), y - TAIL_HALF_W),
            egui::pos2(rect.left(), y + TAIL_HALF_W),
            egui::pos2(rect.left() - TAIL_H, y),
        )
    }

    pub(crate) fn on_right_edge(rect: egui::Rect, anchor_y: f32) -> Self {
        let y = clamp_tail_anchor(anchor_y, rect.top(), rect.bottom());
        Self::from_points(
            egui::pos2(rect.right(), y - TAIL_HALF_W),
            egui::pos2(rect.right(), y + TAIL_HALF_W),
            egui::pos2(rect.right() + TAIL_H, y),
        )
    }

    #[cfg(test)]
    pub(crate) fn apex_y(&self) -> f32 {
        self.apex.y
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct PopoverPlacement {
    pub(crate) rect: egui::Rect,
    pub(crate) tail: PopoverTail,
}

pub(crate) fn paint_popover(painter: &egui::Painter, colors: &Colors, placement: PopoverPlacement) {
    paint_card(painter, colors, placement.rect);
    paint_tail(painter, colors, placement.tail);
}

pub(crate) fn paint_card(painter: &egui::Painter, colors: &Colors, rect: egui::Rect) {
    // Drop shadow → paper fill → tx-3 hairline border so a paper tail remains readable.
    let corner = egui::CornerRadius::same(RADIUS);
    let shadow = egui::epaint::Shadow {
        offset: [0, 10],
        blur: 28,
        spread: 0,
        color: colors.state_cell_popup_shadow,
    };
    painter.add(egui::Shape::Rect(shadow.as_shape(rect, corner)));
    painter.rect_filled(rect, corner, colors.surface);
    painter.rect_stroke(
        rect,
        corner,
        egui::Stroke::new(1.0_f32, colors.popover_outline),
        egui::StrokeKind::Inside,
    );
}

pub(crate) fn paint_tail(painter: &egui::Painter, colors: &Colors, tail: PopoverTail) {
    painter.add(egui::Shape::convex_polygon(
        vec![tail.apex, tail.base_l, tail.base_r],
        colors.surface,
        egui::Stroke::NONE,
    ));

    cover_tail_base_seam(painter, colors, tail);

    let border_stroke = egui::Stroke::new(TAIL_OUTLINE_WIDTH, colors.popover_outline);
    painter.line_segment([tail.base_l, tail.apex], border_stroke);
    painter.line_segment([tail.apex, tail.base_r], border_stroke);
}

fn cover_tail_base_seam(painter: &egui::Painter, colors: &Colors, tail: PopoverTail) {
    // The card border is painted before the tail. Cover the hidden border segment
    // with a tiny surface patch that overlaps both the card and the tail; a 1 px
    // line at the exact base can miss the anti-aliased inside stroke and leave a seam.
    let horizontal_base = (tail.base_l.y - tail.base_r.y).abs() <= f32::EPSILON;
    if horizontal_base {
        let base_y = tail.base_l.y;
        let cover_y = if tail.apex.y > base_y {
            (base_y - TAIL_SEAM_CARD_OVERLAP)..=(base_y + TAIL_SEAM_TAIL_OVERLAP)
        } else {
            (base_y - TAIL_SEAM_TAIL_OVERLAP)..=(base_y + TAIL_SEAM_CARD_OVERLAP)
        };
        painter.rect_filled(
            egui::Rect::from_min_max(
                egui::pos2(
                    tail.base_l.x.min(tail.base_r.x) - TAIL_SEAM_PAD,
                    *cover_y.start(),
                ),
                egui::pos2(
                    tail.base_l.x.max(tail.base_r.x) + TAIL_SEAM_PAD,
                    *cover_y.end(),
                ),
            ),
            egui::CornerRadius::ZERO,
            colors.surface,
        );
    } else {
        let base_x = tail.base_l.x;
        let cover_x = if tail.apex.x > base_x {
            (base_x - TAIL_SEAM_CARD_OVERLAP)..=(base_x + TAIL_SEAM_TAIL_OVERLAP)
        } else {
            (base_x - TAIL_SEAM_TAIL_OVERLAP)..=(base_x + TAIL_SEAM_CARD_OVERLAP)
        };
        painter.rect_filled(
            egui::Rect::from_min_max(
                egui::pos2(
                    *cover_x.start(),
                    tail.base_l.y.min(tail.base_r.y) - TAIL_SEAM_PAD,
                ),
                egui::pos2(
                    *cover_x.end(),
                    tail.base_l.y.max(tail.base_r.y) + TAIL_SEAM_PAD,
                ),
            ),
            egui::CornerRadius::ZERO,
            colors.surface,
        );
    }
}

fn clamp_tail_anchor(anchor: f32, min: f32, max: f32) -> f32 {
    anchor.clamp(min + TAIL_HALF_W, max - TAIL_HALF_W)
}
