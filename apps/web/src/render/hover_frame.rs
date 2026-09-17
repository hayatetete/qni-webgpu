//! Shared hover-frame corner policy for circuit and palette gate hosts.

use eframe::egui;

use crate::gates::GateKind;

const ROUNDED_GATE_HOVER_FRAME_RADIUS: u8 = 10;
const ROUNDED_GATE_HOVER_GAP_RADIUS: u8 = 8;

fn display_block_has_square_body(kind: GateKind) -> bool {
    matches!(
        kind,
        GateKind::ProbabilityDisplay | GateKind::AmplitudeDisplay | GateKind::DensityMatrixDisplay
    )
}

/// Outer hover frame around a gate host.
///
/// Probability / Amplitude / Density Matrix displays have square bodies, so
/// their host hover frames keep 90° corners instead of inheriting the 10 px
/// rounded-gate frame.
pub(crate) fn hover_frame_corner_radius(kind: GateKind) -> egui::CornerRadius {
    if display_block_has_square_body(kind) {
        egui::CornerRadius::ZERO
    } else {
        egui::CornerRadius::same(ROUNDED_GATE_HOVER_FRAME_RADIUS)
    }
}

pub(crate) fn connected_gate_frame_corner_radius() -> egui::CornerRadius {
    egui::CornerRadius::same(ROUNDED_GATE_HOVER_FRAME_RADIUS)
}

/// Palette-only inner cutout corner. It must stay square for square display
/// blocks; otherwise the filled gap would reintroduce rounded corners.
pub(crate) fn hover_frame_inner_corner_radius(kind: GateKind) -> egui::CornerRadius {
    if display_block_has_square_body(kind) {
        egui::CornerRadius::ZERO
    } else {
        egui::CornerRadius::same(ROUNDED_GATE_HOVER_GAP_RADIUS)
    }
}
