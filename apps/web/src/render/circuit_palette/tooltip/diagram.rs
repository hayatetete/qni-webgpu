use eframe::egui;

use super::amplitude_display::{draw_tooltip_amps, CIRCLE, CIRCLE_GAP};
use super::text::{DIAGRAM_GAP, PARA_GAP};
use crate::colors::Colors;
use crate::gates::{GateInfo, GateKind};
use crate::icons::draw_gate_body;

const SECTION_GAP: f32 = 8.0;
const WIRE: f32 = 12.0;
const ARROWHEAD: f32 = 6.0;
const GATE_BODY: f32 = 24.0;
const ROW_GAP: f32 = 8.0;
const ROW_LABEL_ROOM: f32 = 4.0;

#[derive(Clone, Copy)]
pub(super) struct DiagramMetrics {
    amps_width: f32,
    width: f32,
    row_height: f32,
    height: f32,
}

impl DiagramMetrics {
    pub(super) fn for_transition_count(transition_count: usize) -> Self {
        // Diagram geometry. Sizes match qni's `QubitTransitionComponent`:
        // * QubitCircle = `h-8 w-8`     → 32 × 32 px
        // * qpu-operation-sm = `1.5rem` → 24 × 24 px gate body
        // * arrow_start / arrow_end SVG → 12 × 24 px each side
        // * space-x-2 between groups    → 8 px
        let amps_width = CIRCLE * 2.0 + CIRCLE_GAP;
        // The arrowhead chevron is drawn over the last 6 px of the right wire
        // (matches qni's arrow_end SVG where the chevron tip ends at x=11.6
        // within a 12 px wire). So the connector width is simply 12 + 24 + 12
        // — ARROWHEAD is the chevron length used during drawing, not a
        // separate horizontal slot.
        let conn_w = WIRE + GATE_BODY + WIRE;
        let width = amps_width + SECTION_GAP + conn_w + SECTION_GAP + amps_width;
        let row_height = CIRCLE + ROW_LABEL_ROOM;
        let height = if transition_count == 0 {
            0.0
        } else {
            let n = transition_count as f32;
            n * row_height + (n - 1.0).max(0.0) * ROW_GAP
        };

        Self {
            amps_width,
            width,
            row_height,
            height,
        }
    }

    pub(super) fn size(self) -> egui::Vec2 {
        egui::vec2(self.width, self.height)
    }
}

pub(super) fn paint_tooltip_diagram(
    painter: &egui::Painter,
    card_rect: egui::Rect,
    text_end_y: f32,
    info: &GateInfo,
    gate: GateKind,
    colors: &Colors,
    metrics: DiagramMetrics,
) {
    if info.transitions.is_empty() {
        return;
    }

    // Trim trailing para_gap before the diagram block.
    let diagram_top = text_end_y
        - if info.paragraphs.is_empty() {
            0.0
        } else {
            PARA_GAP
        }
        + DIAGRAM_GAP;
    let diagram_left = card_rect.center().x - metrics.width / 2.0;
    for (row_idx, trans) in info.transitions.iter().enumerate() {
        let row_top = diagram_top + row_idx as f32 * (metrics.row_height + ROW_GAP);
        let row_center_y = row_top + CIRCLE / 2.0;

        // Left amplitudes (input).
        draw_tooltip_amps(painter, diagram_left, row_top, &trans.from, colors);
        let mut x = diagram_left + metrics.amps_width + SECTION_GAP;

        draw_connector_and_gate(painter, x, row_center_y, gate, colors);
        x += WIRE + GATE_BODY + WIRE + SECTION_GAP;

        // Right amplitudes (output).
        draw_tooltip_amps(painter, x, row_top, &trans.to, colors);
    }
}

fn draw_connector_and_gate(
    painter: &egui::Painter,
    x: f32,
    row_center_y: f32,
    gate: GateKind,
    colors: &Colors,
) {
    // Connector: 12 px wire → 24 px gate body → 12 px wire whose last 6 px
    // hold the arrowhead chevron (matches qni's arrow_start / arrow_end SVG
    // geometry). Both wires are pulled 2 px short of the gate edges so the gate
    // sits with a small breathing-room gap on either side instead of being
    // visually fused to the line.
    const WIRE_GATE_PAD: f32 = 2.0;
    let wire_color = colors.text_strong;
    painter.line_segment(
        [
            egui::pos2(x, row_center_y),
            egui::pos2(x + WIRE - WIRE_GATE_PAD, row_center_y),
        ],
        egui::Stroke::new(2.0_f32, wire_color),
    );

    let gate_x = x + WIRE;
    let gate_rect_mini = egui::Rect::from_min_size(
        egui::pos2(gate_x, row_center_y - GATE_BODY / 2.0),
        egui::vec2(GATE_BODY, GATE_BODY),
    );
    draw_tooltip_mini_gate(painter, gate_rect_mini, gate, colors);

    let wire2_x = gate_x + GATE_BODY;
    let arrow_tip = egui::pos2(wire2_x + WIRE, row_center_y);
    // Line ending where the chevron starts (arrow tip −6 px), starting
    // WIRE_GATE_PAD after the gate's right edge.
    painter.line_segment(
        [
            egui::pos2(wire2_x + WIRE_GATE_PAD, row_center_y),
            egui::pos2(arrow_tip.x - ARROWHEAD + 1.0, row_center_y),
        ],
        egui::Stroke::new(2.0_f32, wire_color),
    );
    let arrow_base_x = arrow_tip.x - ARROWHEAD;
    painter.add(egui::Shape::convex_polygon(
        vec![
            arrow_tip,
            egui::pos2(arrow_base_x, row_center_y - 4.0),
            egui::pos2(arrow_base_x, row_center_y + 4.0),
        ],
        wire_color,
        egui::Stroke::NONE,
    ));
}

/// Mini gate body (24 px) for the tooltip diagram — matches qni's
/// `qpu-operation-sm` (1.5rem). Delegates to the shared `draw_gate_body` so
/// the icon glyph is identical to what the palette renders (Phase = `Φ`
/// circle, X = filled disk, …), just scaled down.
fn draw_tooltip_mini_gate(
    painter: &egui::Painter,
    gate_rect: egui::Rect,
    kind: GateKind,
    colors: &Colors,
) {
    draw_gate_body(painter, gate_rect, kind, colors);
}
