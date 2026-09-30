//! Bloch sphere and vector icon drawing.

use eframe::egui;

use crate::colors::{lerp_color, Colors};

/// Projects a Bloch vector (x, y, z) ∈ [-1, 1] to a 2D screen offset in units
/// of sphere radius. Mirrors qni's `bloch-display-element.ts` rendering pipeline:
///   - The DOM applies `rotateY(phi) rotateX(-theta)` to a vector that initially
///     points up, which in CSS coords maps Bloch (x,y,z) → CSS (y, -z, x).
///   - A `perspective: 4rem` with `perspective-origin: top right` then projects
///     the rotated 3D position onto the screen plane through a pinhole at the
///     top-right corner of the sphere bounding box.
///
/// We replicate that pinhole projection with `p = 4` (in radius units) and
/// origin (px, py) = (1, -1).
fn bloch_project(x: f32, y: f32, z: f32) -> (f32, f32) {
    let p = 4.0_f32; // perspective: 4rem on a 32px (= 2 radius) sphere
    let px = 1.0_f32; // perspective-origin: top right
    let py = -1.0_f32;
    // Bloch → CSS axis swap (qni's rotateY · rotateX cumulative effect on the
    // initial up-vector): bloch +x → CSS +z (out of screen toward viewer);
    //                      bloch +y → CSS +x (right);
    //                      bloch +z → CSS -y (up).
    let x_3d = y;
    let y_3d = -z;
    let z_3d = x;
    let factor = p / (p - z_3d);
    let sx = px + factor * (x_3d - px);
    let sy = py + factor * (y_3d - py);
    (sx, sy)
}

pub(super) fn draw_bloch_sphere(painter: &egui::Painter, rect: egui::Rect, color: egui::Color32) {
    let center = rect.center();
    let radius = rect.width().min(rect.height()) * 0.5 - 1.0;
    let stroke = egui::Stroke::new(1.0_f32, color);
    // Decorative wireframe matches the static SVG in
    // `packages/elements/src/bloch-display-element.ts`:
    //   horizontal x-axis line, vertical z-axis line, NE/SW diagonal y-axis,
    //   then a vertical thin ellipse and a horizontal thin ellipse.
    painter.line_segment(
        [
            egui::pos2(center.x - radius, center.y),
            egui::pos2(center.x + radius, center.y),
        ],
        stroke,
    );
    painter.line_segment(
        [
            egui::pos2(center.x, center.y - radius),
            egui::pos2(center.x, center.y + radius),
        ],
        stroke,
    );
    let diag = radius * 0.30; // matches qni's 35%/65% endpoints (offset 15%)
    painter.line_segment(
        [
            egui::pos2(center.x - diag, center.y + diag),
            egui::pos2(center.x + diag, center.y - diag),
        ],
        stroke,
    );
    let thin = radius * 0.36; // matches qni's rx=18%, ry=18% (radius from cx/cy)
    let ellipse = |rx: f32, ry: f32| -> Vec<egui::Pos2> {
        (0..=48)
            .map(|i| {
                let t = i as f32 / 48.0 * std::f32::consts::TAU;
                egui::pos2(center.x + rx * t.cos(), center.y + ry * t.sin())
            })
            .collect()
    };
    painter.add(egui::Shape::Path(egui::epaint::PathShape::line(
        ellipse(thin, radius),
        stroke,
    )));
    painter.add(egui::Shape::Path(egui::epaint::PathShape::line(
        ellipse(radius, thin),
        stroke,
    )));
}

pub(crate) fn draw_bloch_vector(
    painter: &egui::Painter,
    rect: egui::Rect,
    vector: [f32; 3],
    colors: &Colors,
) {
    let center = rect.center();
    let radius = rect.width().min(rect.height()) * 0.5 - 1.0;
    let length = (vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]).sqrt();
    let (sx, sy) = bloch_project(vector[0], vector[1], vector[2]);
    let tip = egui::pos2(center.x + sx * radius, center.y + sy * radius);
    if length > 1.0e-3 {
        painter.line_segment(
            [center, tip],
            egui::Stroke::new(1.5_f32, colors.bloch_vector_line),
        );
        let tip_color = bloch_tip_color(vector[2], colors);
        // 8px diameter at base size; add a 1px Flexoki tx outline for the
        // brighter saturated tip trial.
        painter.circle_filled(tip, 4.0, tip_color);
        painter.circle_stroke(
            tip,
            4.0,
            egui::Stroke::new(1.0_f32, colors.bloch_vector_tip_outline),
        );
    } else {
        painter.circle_filled(tip, 4.0, colors.bloch_vector_zero);
        painter.circle_stroke(
            tip,
            4.0,
            egui::Stroke::new(1.0_f32, colors.bloch_vector_tip_outline),
        );
    }
}

fn bloch_tip_color(z: f32, colors: &Colors) -> egui::Color32 {
    if z >= 0.0 {
        lerp_color(
            colors.bloch_vector_tip_mid,
            colors.bloch_vector_tip_0,
            z.clamp(0.0, 1.0),
        )
    } else {
        lerp_color(
            colors.bloch_vector_tip_mid,
            colors.bloch_vector_tip_1,
            (-z).clamp(0.0, 1.0),
        )
    }
}
