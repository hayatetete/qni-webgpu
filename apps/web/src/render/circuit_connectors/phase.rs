use eframe::egui;
use std::collections::HashMap;

use crate::app::{GateId, PlacedGate, QniApp, WireIndex};
use crate::colors::Colors;
use crate::constants::GATE_SIZE;
use crate::gates::{GateKind, ParametricAngle};
use crate::layout::LayoutMetrics;
use crate::shared::now_seconds;
use crate::simulation_plan::{AnalyzedColumn, ColumnAnalysis};

use super::super::circuit::gate_slot_index_for_render;
use super::draw_vertical_connector;

pub(in crate::render) const ANGLE_LABEL_FONT_SIZE: f32 = 12.0; // text-xs = 12px.
pub(in crate::render) const ANGLE_LABEL_ROW_HEIGHT: f32 = 16.0; // text-xs line-height = 16px.
pub(in crate::render) const ANGLE_UNDERLINE_BOTTOM_INSET: f32 = 2.5; // Prototype ::after bottom: 1px + 0.5px optical lift.
                                                                     // The 16px label sits centered in a 17px row; lift the stroke center slightly while keeping it below text.
                                                                     // spacing-0 = 0px. Anchor top labels at the target gate's top edge; this is
                                                                     // the midpoint between the previous too-low +2px inset and too-high -2px gap.
const ANGLE_LABEL_TOP_OFFSET: f32 = 0.0;
const ANGLE_LABEL_BOTTOM_GAP: f32 = 2.0;
const ANGLE_LABEL_OUTLINE_OFFSETS: [(f32, f32); 8] = [
    (1.0, 1.0),
    (-1.0, -1.0),
    (-1.0, 1.0),
    (1.0, -1.0),
    (0.0, 1.0),
    (0.0, -1.0),
    (-1.0, 0.0),
    (1.0, 0.0),
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ConnectionSides {
    top: bool,
    bottom: bool,
}

impl ConnectionSides {
    fn include_wire(&mut self, gate_wire: WireIndex, other_wire: WireIndex) {
        if other_wire < gate_wire {
            self.top = true;
        } else if other_wire > gate_wire {
            self.bottom = true;
        }
    }

    fn include(&mut self, other: Self) {
        self.top |= other.top;
        self.bottom |= other.bottom;
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::render) struct AngleLabelInfo {
    pub(in crate::render) gate_id: GateId,
    pub(in crate::render) text: String,
    pub(in crate::render) pos: egui::Pos2,
    pub(in crate::render) align: egui::Align2,
    pub(in crate::render) above_gate: bool,
    pub(in crate::render) outline_with_background: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AngleLabelLayout {
    above_gate: bool,
    outline_with_background: bool,
}

pub(super) fn draw_phase_connectors_and_labels(
    app: &QniApp,
    painter: &egui::Painter,
    metrics: &LayoutMetrics,
    colors: &Colors,
    circuit_origin: egui::Pos2,
    dragging_gate_id: Option<GateId>,
) {
    let render_columns = ColumnAnalysis::from_gates(&app.placed_gates, |gate| {
        gate_slot_index_for_render(gate, metrics, dragging_gate_id)
    });
    draw_phase_phase_connectors(app, &render_columns, painter, colors, circuit_origin);
    draw_parametric_angle_labels(
        app,
        &render_columns,
        painter,
        metrics,
        colors,
        circuit_origin,
        dragging_gate_id,
    );
}

fn draw_phase_phase_connectors(
    app: &QniApp,
    render_columns: &ColumnAnalysis<'_>,
    painter: &egui::Painter,
    colors: &Colors,
    circuit_origin: egui::Pos2,
) {
    let now = now_seconds();
    // Phase-Phase connector. qni's
    // `circuit-step-element.ts::updatePhasePhaseConnections` (:566-602)
    // draws a connector between same-angle Phase gates in the same column.
    // Semantically it's a *visual* pairing only — qni's simulator still runs
    // each Phase independently (`simulator.ts::cu` :413-417 loops over
    // targets and applies the same 2x2 to each in turn), so we mirror just the
    // line rendering. Bare legacy `P` uses the parametric default π/2.
    for column in render_columns.columns() {
        let mut angle_buckets: HashMap<ParametricAngle, Vec<(GateId, egui::Pos2)>> = HashMap::new();
        for gate in column.gates() {
            if gate.kind != GateKind::Phase || app.paste_gate_hidden(gate.id, now) {
                continue;
            }
            let Some(angle) = phase_angle(gate) else {
                continue;
            };
            let motion_x = app
                .circuit_motion_offset_x(gate.id, now)
                .unwrap_or_default();
            let center = circuit_origin
                + gate.pos.to_vec2()
                + egui::vec2(motion_x + GATE_SIZE / 2.0, GATE_SIZE / 2.0);
            angle_buckets
                .entry(angle)
                .or_default()
                .push((gate.id, center));
        }
        for points in angle_buckets.values() {
            if points.len() < 2 {
                continue;
            }
            let mut min_y = f32::INFINITY;
            let mut max_y = f32::NEG_INFINITY;
            for (_, point) in points {
                min_y = min_y.min(point.y);
                max_y = max_y.max(point.y);
            }
            // Follow the rendered gate centers while an insertion pushes the
            // column horizontally, matching the control and swap connectors.
            let x = points.iter().map(|(_, point)| point.x).sum::<f32>() / points.len() as f32;
            let color = app.connector_color(points.iter().map(|(gate_id, _)| *gate_id), colors);
            draw_vertical_connector(painter, x, min_y, max_y, color);
        }
    }
}

fn draw_parametric_angle_labels(
    app: &QniApp,
    render_columns: &ColumnAnalysis<'_>,
    painter: &egui::Painter,
    metrics: &LayoutMetrics,
    colors: &Colors,
    circuit_origin: egui::Pos2,
    dragging_gate_id: Option<GateId>,
) {
    // Angle labels for parametric gates. qni puts the angle text near the gate
    // body and draws a white text-shadow when the dropzone has both
    // `data-connect-top` and `data-connect-bottom`
    // (`packages/elements/css/qni.css`, `.operation-angleable`). We mirror that
    // with the circuit background (Flexoki bg-2 via `colors.background`) so
    // labels stay legible over vertical connectors.
    let now = now_seconds();
    for gate in &app.placed_gates {
        if app.paste_gate_hidden(gate.id, now) {
            continue;
        }
        if app
            .angle_editor
            .as_ref()
            .is_some_and(|editor| editor.gate_id == gate.id)
        {
            continue;
        }
        let Some(label) = parametric_angle_label_info(
            gate,
            render_columns,
            metrics,
            circuit_origin,
            dragging_gate_id,
            app.circuit_motion_offset_x(gate.id, now)
                .unwrap_or_default(),
        ) else {
            continue;
        };
        draw_angle_label(
            painter,
            label.pos,
            label.align,
            &label.text,
            colors,
            label.outline_with_background,
        );
    }
}

pub(in crate::render) fn parametric_angle_label_info(
    gate: &PlacedGate,
    render_columns: &ColumnAnalysis<'_>,
    metrics: &LayoutMetrics,
    circuit_origin: egui::Pos2,
    dragging_gate_id: Option<GateId>,
    motion_x: f32,
) -> Option<AngleLabelInfo> {
    let angle = parametric_angle(gate)?;
    let text = angle.label();
    let center = circuit_origin
        + gate.pos.to_vec2()
        + egui::vec2(motion_x + GATE_SIZE / 2.0, GATE_SIZE / 2.0);
    let connection_sides = phase_render_column(render_columns, gate, metrics, dragging_gate_id)
        .map(|column| angle_label_connection_sides(column, gate, angle))
        .unwrap_or_default();
    let layout = angle_label_layout(connection_sides);
    let (pos, align) = angle_label_position(center, layout);
    Some(AngleLabelInfo {
        gate_id: gate.id,
        text,
        pos,
        align,
        above_gate: layout.above_gate,
        outline_with_background: layout.outline_with_background,
    })
}

pub(in crate::render) fn angle_label_interaction_rect(label: &AngleLabelInfo) -> egui::Rect {
    let top = if label.above_gate {
        label.pos.y - ANGLE_LABEL_ROW_HEIGHT
    } else {
        label.pos.y
    };
    egui::Rect::from_min_size(
        egui::pos2(label.pos.x - GATE_SIZE * 0.5, top),
        egui::vec2(GATE_SIZE, ANGLE_LABEL_ROW_HEIGHT),
    )
}

pub(in crate::render) fn angle_underline_segment(label: &AngleLabelInfo) -> [egui::Pos2; 2] {
    let y = angle_underline_y(label);
    [
        egui::pos2(label.pos.x - GATE_SIZE * 0.5, y),
        egui::pos2(label.pos.x + GATE_SIZE * 0.5, y),
    ]
}

pub(in crate::render) fn reserve_angle_label_outline(
    painter: &egui::Painter,
    label: &AngleLabelInfo,
) -> Option<[egui::layers::ShapeIdx; ANGLE_LABEL_OUTLINE_OFFSETS.len()]> {
    label
        .outline_with_background
        .then(|| ANGLE_LABEL_OUTLINE_OFFSETS.map(|_| painter.add(egui::Shape::Noop)))
}

pub(in crate::render) fn paint_reserved_angle_label_outline(
    painter: &egui::Painter,
    colors: &Colors,
    text: &str,
    galley_pos: egui::Pos2,
    text_clip_rect: egui::Rect,
    outline_slots: Option<[egui::layers::ShapeIdx; ANGLE_LABEL_OUTLINE_OFFSETS.len()]>,
) {
    let Some(outline_slots) = outline_slots else {
        return;
    };
    let font_id = egui::FontId::monospace(ANGLE_LABEL_FONT_SIZE);
    let galley = painter.layout_no_wrap(text.to_owned(), font_id, colors.background);
    let clipped_painter = painter.with_clip_rect(text_clip_rect);
    for (slot, (dx, dy)) in outline_slots.into_iter().zip(ANGLE_LABEL_OUTLINE_OFFSETS) {
        clipped_painter.set(
            slot,
            egui::Shape::galley(
                galley_pos + egui::vec2(dx, dy),
                galley.clone(),
                colors.background,
            ),
        );
    }
}

fn angle_underline_y(label: &AngleLabelInfo) -> f32 {
    angle_label_interaction_rect(label).bottom() - ANGLE_UNDERLINE_BOTTOM_INSET
}

fn angle_label_layout(connection_sides: ConnectionSides) -> AngleLabelLayout {
    // Mirrors qni's `.operation-angleable` placement rules:
    //   no top connection        → top label
    //   top + bottom connection  → top label with background outline
    //   top-only connection      → bottom label
    AngleLabelLayout {
        above_gate: !connection_sides.top || connection_sides.bottom,
        outline_with_background: connection_sides.top && connection_sides.bottom,
    }
}

fn angle_label_position(
    gate_center: egui::Pos2,
    layout: AngleLabelLayout,
) -> (egui::Pos2, egui::Align2) {
    if layout.above_gate {
        (
            egui::pos2(
                gate_center.x,
                gate_center.y - GATE_SIZE / 2.0 + ANGLE_LABEL_TOP_OFFSET,
            ),
            egui::Align2::CENTER_BOTTOM,
        )
    } else {
        (
            egui::pos2(
                gate_center.x,
                gate_center.y + GATE_SIZE / 2.0 + ANGLE_LABEL_BOTTOM_GAP,
            ),
            egui::Align2::CENTER_TOP,
        )
    }
}

fn draw_angle_label(
    painter: &egui::Painter,
    pos: egui::Pos2,
    align: egui::Align2,
    text: &str,
    colors: &Colors,
    outline_with_background: bool,
) {
    // text-xs (12 px) — Tailwind. Matches the popup body font so labels
    // feel like they belong to the same typographic system.
    let font_id = egui::FontId::monospace(ANGLE_LABEL_FONT_SIZE);
    if outline_with_background {
        for (dx, dy) in ANGLE_LABEL_OUTLINE_OFFSETS {
            painter.text(
                pos + egui::vec2(dx, dy),
                align,
                text,
                font_id.clone(),
                colors.background,
            );
        }
    }
    painter.text(pos, align, text, font_id, colors.text_strong);
}

fn phase_angle(gate: &PlacedGate) -> Option<ParametricAngle> {
    if gate.kind != GateKind::Phase {
        return None;
    }
    parametric_angle(gate)
}

#[cfg(test)]
fn phase_angle_label_text(gate: &PlacedGate) -> Option<String> {
    phase_angle(gate).map(|angle| angle.label())
}

fn phase_render_column<'columns, 'gates>(
    render_columns: &'columns ColumnAnalysis<'gates>,
    gate: &PlacedGate,
    metrics: &LayoutMetrics,
    dragging_gate_id: Option<GateId>,
) -> Option<&'columns AnalyzedColumn<'gates>> {
    let slot = gate_slot_index_for_render(gate, metrics, dragging_gate_id)?;
    render_columns
        .columns()
        .iter()
        .find(|column| column.slot == slot)
}

fn parametric_angle(gate: &PlacedGate) -> Option<ParametricAngle> {
    if !matches!(
        gate.kind,
        GateKind::Phase | GateKind::Rx | GateKind::Ry | GateKind::Rz
    ) {
        return None;
    }
    Some(gate.angle.unwrap_or_default())
}

#[cfg(test)]
fn parametric_angle_label_text(gate: &PlacedGate) -> Option<String> {
    parametric_angle(gate).map(|angle| angle.label())
}

fn angle_label_connection_sides(
    column: &AnalyzedColumn<'_>,
    gate: &PlacedGate,
    angle: ParametricAngle,
) -> ConnectionSides {
    let mut sides = phase_phase_connection_sides(column, gate, angle);
    sides.include(control_connection_sides(column, gate));
    sides
}

fn phase_phase_connection_sides(
    column: &AnalyzedColumn<'_>,
    gate: &PlacedGate,
    angle: ParametricAngle,
) -> ConnectionSides {
    if gate.kind != GateKind::Phase {
        return ConnectionSides::default();
    }
    let mut sides = ConnectionSides::default();
    for other in column.gates() {
        if other.id == gate.id || other.kind != GateKind::Phase {
            continue;
        }
        if phase_angle(other) != Some(angle) {
            continue;
        }
        sides.include_wire(gate.wire, other.wire);
    }
    sides
}

fn control_connection_sides(column: &AnalyzedColumn<'_>, gate: &PlacedGate) -> ConnectionSides {
    let controls = column
        .gates()
        .iter()
        .filter(|other| matches!(other.kind, GateKind::Control | GateKind::AntiControl))
        .count();
    if controls == 0 {
        return ConnectionSides::default();
    }
    let targets = column
        .gates()
        .iter()
        .filter(|other| {
            !matches!(
                other.kind,
                GateKind::Control | GateKind::AntiControl | GateKind::Swap
            )
        })
        .count();
    if targets == 0 && controls < 2 {
        return ConnectionSides::default();
    }

    let mut sides = ConnectionSides::default();
    for other in column.gates() {
        if other.id == gate.id || other.kind == GateKind::Swap {
            continue;
        }
        sides.include_wire(gate.wire, other.wire);
    }
    sides
}

#[cfg(test)]
mod tests {
    use super::*;

    fn angle(value: &str) -> ParametricAngle {
        ParametricAngle::parse_qni(value).expect("angle should parse")
    }

    #[test]
    fn phase_label_uses_default_for_missing_angle() {
        let gate = PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Phase,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        );

        assert_eq!(phase_angle_label_text(&gate), Some("π/2".to_owned()));
    }

    #[test]
    fn phase_label_keeps_explicit_angle() {
        let gate = PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Phase,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            Some(angle("2π/3")),
        );

        assert_eq!(phase_angle_label_text(&gate), Some("2π/3".to_owned()));
    }

    #[test]
    fn rx_label_uses_default_for_missing_angle() {
        let gate = PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Rx,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        );

        assert_eq!(parametric_angle_label_text(&gate), Some("π/2".to_owned()));
    }

    #[test]
    fn ry_label_uses_default_for_missing_angle() {
        let gate = PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Ry,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        );

        assert_eq!(parametric_angle_label_text(&gate), Some("π/2".to_owned()));
    }

    #[test]
    fn ry_label_keeps_explicit_angle() {
        let gate = PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Ry,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            Some(angle("π/4")),
        );

        assert_eq!(parametric_angle_label_text(&gate), Some("π/4".to_owned()));
    }

    #[test]
    fn rz_label_uses_default_for_missing_angle() {
        let gate = PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Rz,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        );

        assert_eq!(parametric_angle_label_text(&gate), Some("π/2".to_owned()));
    }

    #[test]
    fn middle_phase_label_gets_background_outline() {
        let layout = angle_label_layout(ConnectionSides {
            top: true,
            bottom: true,
        });

        assert!(layout.outline_with_background);
    }

    #[test]
    fn topmost_phase_label_does_not_get_background_outline() {
        let layout = angle_label_layout(ConnectionSides {
            top: false,
            bottom: true,
        });

        assert!(!layout.outline_with_background);
    }

    #[test]
    fn bottommost_phase_label_uses_bottom_placement() {
        let layout = angle_label_layout(ConnectionSides {
            top: true,
            bottom: false,
        });

        assert!(!layout.above_gate);
    }

    #[test]
    fn phase_with_phase_above_and_control_below_gets_both_connection_sides() {
        let gates = vec![
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Phase,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                Some(angle("π/2")),
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::Phase,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                Some(angle("4π/8")),
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(3),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(2),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];
        let analysis = ColumnAnalysis::from_gates(&gates, |gate| Some(gate.column.as_usize()));

        assert_eq!(
            angle_label_connection_sides(&analysis.columns()[0], &gates[1], angle("π/2")),
            ConnectionSides {
                top: true,
                bottom: true,
            }
        );
    }

    #[test]
    fn underline_matches_prototype_row_inset() {
        let label = AngleLabelInfo {
            gate_id: crate::app::GateId::from_u32(1),
            text: "π/2".to_owned(),
            pos: egui::pos2(80.0, 60.0),
            align: egui::Align2::CENTER_BOTTOM,
            above_gate: true,
            outline_with_background: false,
        };

        assert_eq!(angle_underline_y(&label), 57.5);
    }

    #[test]
    fn top_label_uses_lower_gate_biased_anchor() {
        let gate_center = egui::pos2(10.0, 80.0);
        let layout = angle_label_layout(ConnectionSides {
            top: true,
            bottom: true,
        });

        assert_eq!(angle_label_position(gate_center, layout).0.y, 60.0);
    }
}
