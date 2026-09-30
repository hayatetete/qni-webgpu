//! Gate body fill, special bodies, and fallback label drawing.

use eframe::egui;

use crate::colors::Colors;
use crate::constants::GATE_SIZE;
use crate::gates::GateKind;

use super::gate_glyphs::draw_gate_icon;

const PROBABILITY_PREVIEW_BAR_WIDTHS: [f32; 4] = [0.30, 0.75, 0.55, 0.20];

pub(crate) fn draw_gate_body(
    painter: &egui::Painter,
    gate_rect: egui::Rect,
    kind: GateKind,
    colors: &Colors,
) {
    draw_gate_body_with_fill(painter, gate_rect, kind, colors, colors.box_fill, false);
}

pub(crate) fn draw_drag_gate_body(
    painter: &egui::Painter,
    gate_rect: egui::Rect,
    kind: GateKind,
    colors: &Colors,
) {
    draw_gate_body_with_fill(painter, gate_rect, kind, colors, colors.drag_fill, true);
}

fn draw_gate_body_with_fill(
    painter: &egui::Painter,
    gate_rect: egui::Rect,
    kind: GateKind,
    colors: &Colors,
    fill: egui::Color32,
    dragging: bool,
) {
    if kind == GateKind::X {
        let radius = gate_rect.width().min(gate_rect.height()) / 2.0;
        painter.circle_filled(gate_rect.center(), radius, fill);
    } else if kind == GateKind::ProbabilityDisplay {
        draw_probability_preview_body(painter, gate_rect, colors);
        return;
    } else if kind == GateKind::AmplitudeDisplay {
        let background = if dragging { fill } else { colors.surface };
        draw_amplitude_preview_body(painter, gate_rect, colors, background);
        return;
    } else if kind == GateKind::DensityMatrixDisplay {
        let background = if dragging { fill } else { colors.surface };
        draw_density_preview_body(painter, gate_rect, colors, background);
        return;
    } else if kind == GateKind::Phase {
        // qni renders the parametric Phase as a circular body (the
        // SDF-backed `Φ` glyph centred inside) so the angle label has
        // somewhere clean to sit above / below the gate without colliding with
        // the gate body's square corners.
        let radius = gate_rect.width().min(gate_rect.height()) / 2.0;
        painter.circle_filled(gate_rect.center(), radius, fill);
    } else if matches!(kind, GateKind::QftGate | GateKind::QftDaggerGate) {
        // QFT family — same green body as the other unitary gates. The
        // letter rendering is delegated to `draw_gate_icon` along with
        // every other SVG/SDF-backed typographic gate. For multi-qubit
        // spans the icon is anchored to a GATE_SIZE square at the vertical
        // centre so the lettering stays put even when the body is taller.
        painter.rect_filled(gate_rect, egui::CornerRadius::same(6), fill);
        let cx = gate_rect.center().x;
        let cy = gate_rect.center().y;
        let half = GATE_SIZE * 0.5;
        let icon_rect = egui::Rect::from_min_max(
            egui::pos2(cx - half, cy - half),
            egui::pos2(cx + half, cy + half),
        );
        draw_gate_icon(painter, icon_rect, kind, colors.label, colors);
        return;
    } else if kind == GateKind::BlochDisplay {
        // qni renders the bloch display as a stand-alone sphere — bg-green-50
        // background with a gray-400 border (`packages/elements/css/bloch_display.css`).
        let radius = gate_rect.width().min(gate_rect.height()) * 0.5 - 1.0;
        painter.circle_filled(gate_rect.center(), radius, colors.bloch_sphere_bg);
        painter.circle_stroke(
            gate_rect.center(),
            radius,
            egui::Stroke::new(1.5_f32, colors.bloch_sphere_lines),
        );
    } else if kind != GateKind::Control
        && kind != GateKind::AntiControl
        && kind != GateKind::Swap
        && kind != GateKind::Measurement
        && kind != GateKind::Spacer
        && kind != GateKind::Write0
        && kind != GateKind::Write1
    {
        painter.rect_filled(gate_rect, egui::CornerRadius::same(6), fill);
    }
    let icon_color =
        if kind == GateKind::Control || kind == GateKind::AntiControl || kind == GateKind::Swap {
            fill
        } else if kind == GateKind::BlochDisplay {
            colors.bloch_sphere_lines
        } else if kind == GateKind::Measurement {
            // qni `measurement_gate.css`: icon color is semantic-color-intermediate (purple).
            colors.semantic_intermediate
        } else if kind == GateKind::Spacer {
            // qni `spacer_gate.css`: text-neutral-900 (#171717).
            colors.spacer_dots
        } else if kind == GateKind::Write0 || kind == GateKind::Write1 {
            // qni `write_gate.css`: ::part(icon) (the brackets) is
            // semantic-fill-color-disabled (zinc-500). Only the digit itself
            // is red/blue — handled inside draw_gate_icon.
            colors.semantic_disabled
        } else {
            colors.label
        };
    if !draw_gate_icon(painter, gate_rect, kind, icon_color, colors) {
        painter.text(
            gate_rect.center(),
            egui::Align2::CENTER_CENTER,
            kind.label(),
            egui::FontId::proportional(18.0),
            colors.label,
        );
    }
}

fn draw_amplitude_preview_body(
    painter: &egui::Painter,
    rect: egui::Rect,
    colors: &Colors,
    background: egui::Color32,
) {
    // Static placeholder only. Live complex amplitudes are captured and
    // rendered by WebGPU; the CPU draws no amplitude values.
    painter.rect_filled(rect, egui::CornerRadius::ZERO, background);

    if rect.width() <= GATE_SIZE + 1.0 && rect.height() <= GATE_SIZE + 1.0 {
        draw_amplitude_palette_icon(painter, rect, colors);
        return;
    }

    painter.rect_stroke(
        rect,
        egui::CornerRadius::ZERO,
        egui::Stroke::new(1.0_f32, colors.line),
        egui::StrokeKind::Inside,
    );
}

fn draw_amplitude_palette_icon(painter: &egui::Painter, rect: egui::Rect, colors: &Colors) {
    // docs/design-system/amplitude-display.html §02: 40×40 mini preview, one cell with
    // mag²≈50% and phase=5π/4, producing a Q-like lower-right tail.
    let center = rect.center();
    let stroke_width = 2.0;
    let half_stroke = stroke_width * 0.5;
    let outline_clearance = 1.5;
    let outline_radius =
        (rect.width().min(rect.height()) * 0.5 - half_stroke - outline_clearance).max(0.0);
    let inner_radius = (outline_radius - half_stroke).max(0.0);
    let disk_radius = inner_radius * std::f32::consts::FRAC_1_SQRT_2;

    painter.circle_filled(center, outline_radius - half_stroke, colors.surface);
    painter.circle_stroke(
        center,
        outline_radius,
        egui::Stroke::new(stroke_width, colors.state_outline),
    );
    painter.circle_filled(center, disk_radius, colors.state_fill);
    // Flexoki blue-400: state_fill disk inset border, matching the spec mock.
    painter.circle_stroke(
        center,
        (disk_radius - 0.5).max(0.0),
        egui::Stroke::new(1.0_f32, colors.popup_icon),
    );
    let tail = egui::vec2(inner_radius, inner_radius) * std::f32::consts::FRAC_1_SQRT_2;
    painter.line_segment(
        [center, center + tail],
        egui::Stroke::new(stroke_width, colors.state_needle),
    );
}

fn draw_density_preview_body(
    painter: &egui::Painter,
    rect: egui::Rect,
    colors: &Colors,
    background: egui::Color32,
) {
    // Static placeholder only. Live density values are captured and rendered
    // by WebGPU; the CPU draws no density matrix entries. Unlike the palette
    // icon, placed/dragged placeholders keep the matrix outer frame.
    painter.rect_filled(rect, egui::CornerRadius::ZERO, background);
    painter.rect_stroke(
        rect,
        egui::CornerRadius::ZERO,
        egui::Stroke::new(1.0_f32, colors.line),
        egui::StrokeKind::Inside,
    );
}

pub(crate) fn draw_density_palette_icon(
    painter: &egui::Painter,
    rect: egui::Rect,
    colors: &Colors,
) {
    // docs/design-system/density-matrix-display.html §02: compact 2×2
    // density preview. Diagonal cells omit the phase needle; off-diagonal
    // cells keep the same outline + disk grammar with a phase needle.
    let cell = rect.width().min(rect.height()) * 0.5;
    for row in 0..2 {
        for col in 0..2 {
            let center = egui::pos2(
                rect.left() + (col as f32 + 0.5) * cell,
                rect.top() + (row as f32 + 0.5) * cell,
            );
            let outline_stroke = 1.25;
            let outline_clearance = 1.5;
            let outline_radius = (cell * 0.5 - outline_stroke * 0.5 - outline_clearance).max(0.0);
            let disk_radius = outline_radius * 0.5;
            painter.circle_filled(center, outline_radius, colors.surface);
            painter.circle_stroke(
                center,
                outline_radius,
                egui::Stroke::new(outline_stroke, colors.state_outline),
            );
            painter.circle_filled(center, disk_radius, colors.state_fill);
            painter.circle_stroke(
                center,
                (disk_radius - 0.5).max(0.0),
                egui::Stroke::new(1.0_f32, colors.popup_icon),
            );
            if row != col {
                painter.line_segment(
                    [center, center + egui::vec2(0.0, -outline_radius)],
                    egui::Stroke::new(1.25_f32, colors.state_needle),
                );
            }
        }
    }
}

fn draw_probability_preview_body(painter: &egui::Painter, rect: egui::Rect, colors: &Colors) {
    // Static mini-preview only. Live probabilities are drawn later by the
    // GPU Probability render callback, directly from `probability_output`.
    painter.rect_filled(rect, egui::CornerRadius::ZERO, colors.surface);

    // docs/design-system/probability-display.html §02: 4 行のガウス風 mini preview。
    // 本体と同じく blue-200 bar + blue-400 右端マーカー、区切り線は
    // 隣接 2 行の広いバーの右端から右端までだけ引く。
    let row_h = rect.height() / PROBABILITY_PREVIEW_BAR_WIDTHS.len() as f32;
    for (row, &width_ratio) in PROBABILITY_PREVIEW_BAR_WIDTHS.iter().enumerate() {
        let bar_y = rect.top() + row_h * row as f32;
        let bar_w = rect.width() * width_ratio;
        let bar =
            egui::Rect::from_min_size(egui::pos2(rect.left(), bar_y), egui::vec2(bar_w, row_h));
        painter.rect_filled(bar, egui::CornerRadius::ZERO, colors.state_fill);
        if bar_w > 0.0 {
            let edge_x = rect.left() + bar_w;
            painter.line_segment(
                [egui::pos2(edge_x, bar_y), egui::pos2(edge_x, bar_y + row_h)],
                egui::Stroke::new(1.0_f32, colors.popup_icon),
            );
        }
    }
    for row in 1..PROBABILITY_PREVIEW_BAR_WIDTHS.len() {
        let y = rect.top() + row_h * row as f32;
        let start_ratio =
            PROBABILITY_PREVIEW_BAR_WIDTHS[row - 1].max(PROBABILITY_PREVIEW_BAR_WIDTHS[row]);
        painter.line_segment(
            [
                egui::pos2(rect.left() + rect.width() * start_ratio, y),
                egui::pos2(rect.right(), y),
            ],
            egui::Stroke::new(1.0_f32, colors.line),
        );
    }
    // 回路側の probability display 外周 (`circuit_gates.rs:180` で `colors.line` =
    // ui-2) と階調を合わせる。Quirk の `lightgray` (#D3D3D3) と同じ薄灰で
    // 「データ領域の輪郭」だけを示し、ゲート本体の強調はバー (blue-200)
    // に任せる。
    painter.rect_stroke(
        rect,
        egui::CornerRadius::ZERO,
        egui::Stroke::new(1.0_f32, colors.line),
        egui::StrokeKind::Inside,
    );
}
