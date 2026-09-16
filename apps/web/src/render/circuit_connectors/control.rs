use eframe::egui;

use crate::app::{GateId, QniApp};
use crate::colors::Colors;
use crate::constants::GATE_SIZE;
use crate::gates::GateKind;
use crate::layout::LayoutMetrics;
use crate::simulation_plan::ColumnAnalysis;

use super::super::circuit::gate_slot_index_for_render;
use super::draw_vertical_connector;
use crate::shared::now_seconds;

// The anti-control icon is a hollow 40px-gate glyph; split the vertical
// connector through its hollow center while leaving the line visible between
// the anti-control and its target.
const ANTI_CONTROL_CONNECTOR_CLEAR_RADIUS: f32 = 6.0;

pub(super) fn draw_control_connectors(
    app: &QniApp,
    painter: &egui::Painter,
    metrics: &LayoutMetrics,
    colors: &Colors,
    circuit_origin: egui::Pos2,
    dragging_gate_id: Option<GateId>,
) {
    let analysis = ColumnAnalysis::from_gates(&app.placed_gates, |gate| {
        gate_slot_index_for_render(gate, metrics, dragging_gate_id)
    });

    for column in analysis.columns() {
        let now = now_seconds();
        if column
            .gates()
            .iter()
            .all(|gate| app.paste_gate_hidden(gate.id, now))
        {
            continue;
        }
        let mut controls = Vec::new();
        let mut targets = Vec::new();
        let mut anti_control_gaps = Vec::new();
        for gate in column.gates() {
            let center =
                circuit_origin + gate.pos.to_vec2() + egui::vec2(GATE_SIZE / 2.0, GATE_SIZE / 2.0);
            if gate.kind == GateKind::Control || gate.kind == GateKind::AntiControl {
                controls.push(center);
                if gate.kind == GateKind::AntiControl {
                    anti_control_gaps.push(center.y);
                }
            } else {
                // Swap counts as a controllable target so a controlled-SWAP
                // (Fredkin) gets the control→swap connector line. A column's
                // controls apply to every gate in it, so the swap symbols sit
                // on the same vertical connector as the control dots. An
                // uncontrolled swap still skips this line via the
                // `controls.is_empty()` early-return below; its swap-to-swap
                // connector is drawn separately in `draw_swap_connectors`.
                targets.push(center);
            }
        }
        // Connector is a *control-only* affordance: it tells the reader "this
        // column is a multi-qubit controlled operation". Columns with no
        // controls (e.g. four parallel Hs, parallel Blochs, parallel writes)
        // are independent single-qubit gates and must NOT get a line —
        // matching qni's `circuit-step-element.ts:526` early-return when both
        // control lists are empty.
        if controls.is_empty() {
            continue;
        }
        // A lone control with no controllable target is a disabled no-op in qni
        // (`:513-524`); we likewise skip the line for it.
        if targets.is_empty() && controls.len() < 2 {
            continue;
        }
        let mut min_y = f32::INFINITY;
        let mut max_y = f32::NEG_INFINITY;
        for point in controls.iter().chain(targets.iter()) {
            min_y = min_y.min(point.y);
            max_y = max_y.max(point.y);
        }
        // Anchor the line at the shared slot center. Dragged gates only join
        // this render column after their preview center is on the real slot;
        // insert previews stay out so the connector never drifts away from a
        // transparent Control / AntiControl body.
        let motion_x = column
            .gates()
            .first()
            .and_then(|gate| app.circuit_motion_offset_x(gate.id, now))
            .unwrap_or_default();
        let x = circuit_origin.x + metrics.slot_centers[column.slot] + motion_x;
        let color = app.connector_color(column.gates().iter().map(|gate| gate.id), colors);
        for (start_y, end_y) in connector_segments(min_y, max_y, &anti_control_gaps) {
            draw_vertical_connector(painter, x, start_y, end_y, color);
        }
    }
}

fn connector_segments(min_y: f32, max_y: f32, anti_control_centers: &[f32]) -> Vec<(f32, f32)> {
    let mut gaps = anti_control_centers
        .iter()
        .map(|center| {
            (
                (center - ANTI_CONTROL_CONNECTOR_CLEAR_RADIUS).max(min_y),
                (center + ANTI_CONTROL_CONNECTOR_CLEAR_RADIUS).min(max_y),
            )
        })
        .collect::<Vec<_>>();
    gaps.sort_by(|left, right| left.0.total_cmp(&right.0));

    let mut segments = Vec::new();
    let mut cursor = min_y;
    for (gap_start, gap_end) in gaps {
        if gap_end <= cursor {
            continue;
        }
        if gap_start > cursor {
            segments.push((cursor, gap_start));
        }
        cursor = cursor.max(gap_end);
    }
    if cursor < max_y {
        segments.push((cursor, max_y));
    }
    segments
}
