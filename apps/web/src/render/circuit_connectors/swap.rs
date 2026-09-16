use eframe::egui;
use std::cmp::Ordering;

use crate::app::{GateId, QniApp};
use crate::colors::Colors;
use crate::constants::GATE_SIZE;
use crate::gates::GateKind;
use crate::layout::LayoutMetrics;
use crate::simulation_plan::ColumnAnalysis;

use super::super::circuit::gate_slot_index_for_render;
use super::draw_vertical_connector;
use crate::shared::now_seconds;

pub(super) fn draw_swap_connectors(
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
        let gates = column
            .gates()
            .iter()
            .copied()
            .filter(|gate| gate.kind == GateKind::Swap)
            .collect::<Vec<_>>();
        if gates.len() < 2 {
            continue;
        }
        if gates.iter().all(|gate| app.paste_gate_hidden(gate.id, now)) {
            continue;
        }
        let mut ys = gates
            .iter()
            .map(|gate| circuit_origin.y + gate.pos.y + GATE_SIZE / 2.0)
            .collect::<Vec<_>>();
        ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
        let top_y = *ys.first().unwrap();
        let bottom_y = *ys.last().unwrap();
        // Swap connectors visually join the swap symbols themselves. Use the
        // actual rendered gate centres instead of the slot centre so the line
        // stays centred in the transparent Swap body during hover / drag.
        let x = gates
            .iter()
            .map(|gate| {
                circuit_origin.x
                    + gate.pos.x
                    + app
                        .circuit_motion_offset_x(gate.id, now)
                        .unwrap_or_default()
                    + GATE_SIZE / 2.0
            })
            .sum::<f32>()
            / gates.len() as f32;
        let color = app.connector_color(gates.iter().map(|gate| gate.id), colors);
        draw_vertical_connector(painter, x, top_y, bottom_y, color);
    }
}
