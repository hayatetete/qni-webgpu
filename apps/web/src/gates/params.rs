//! Gate matrix packing.

use super::ColumnControls;
use super::GateKind;
use crate::qubit_bit::QubitBit;

#[derive(Clone, Copy, Debug)]
struct GateMatrix {
    m00: [f32; 2],
    m01: [f32; 2],
    m10: [f32; 2],
    m11: [f32; 2],
}

fn gate_matrix(kind: GateKind) -> GateMatrix {
    let inv_sqrt2 = std::f32::consts::FRAC_1_SQRT_2;
    let default_angle = std::f32::consts::FRAC_PI_2;
    let half_angle = default_angle * 0.5;
    let cos_half = half_angle.cos();
    let sin_half = half_angle.sin();
    let exp_i = |angle: f32| [angle.cos(), angle.sin()];
    match kind {
        GateKind::H => GateMatrix {
            m00: [inv_sqrt2, 0.0],
            m01: [inv_sqrt2, 0.0],
            m10: [inv_sqrt2, 0.0],
            m11: [-inv_sqrt2, 0.0],
        },
        GateKind::Control | GateKind::AntiControl => GateMatrix {
            m00: [1.0, 0.0],
            m01: [0.0, 0.0],
            m10: [0.0, 0.0],
            m11: [1.0, 0.0],
        },
        GateKind::Write0
        | GateKind::Write1
        | GateKind::BlochDisplay
        | GateKind::Measurement
        | GateKind::ProbabilityDisplay
        | GateKind::AmplitudeDisplay
        | GateKind::DensityMatrixDisplay
        | GateKind::Spacer
        | GateKind::QftGate
        | GateKind::QftDaggerGate => GateMatrix {
            // BlochDisplay / Measurement / Probability / Amplitude / Density / QFT are handled by dedicated GPU
            // orchestration paths instead of this 2x2 matrix helper. Write0 /
            // Write1 are mode-driven on the GPU. Matrix is unused for these
            // variants but filled with identity for safety.
            m00: [1.0, 0.0],
            m01: [0.0, 0.0],
            m10: [0.0, 0.0],
            m11: [1.0, 0.0],
        },
        GateKind::X => GateMatrix {
            m00: [0.0, 0.0],
            m01: [1.0, 0.0],
            m10: [1.0, 0.0],
            m11: [0.0, 0.0],
        },
        GateKind::Y => GateMatrix {
            m00: [0.0, 0.0],
            m01: [0.0, -1.0],
            m10: [0.0, 1.0],
            m11: [0.0, 0.0],
        },
        GateKind::Z => GateMatrix {
            m00: [1.0, 0.0],
            m01: [0.0, 0.0],
            m10: [0.0, 0.0],
            m11: [-1.0, 0.0],
        },
        GateKind::SqrtX => GateMatrix {
            m00: [0.5, 0.5],
            m01: [0.5, -0.5],
            m10: [0.5, -0.5],
            m11: [0.5, 0.5],
        },
        GateKind::S => GateMatrix {
            m00: [1.0, 0.0],
            m01: [0.0, 0.0],
            m10: [0.0, 0.0],
            m11: [0.0, 1.0],
        },
        GateKind::SDagger => GateMatrix {
            m00: [1.0, 0.0],
            m01: [0.0, 0.0],
            m10: [0.0, 0.0],
            m11: [0.0, -1.0],
        },
        GateKind::T => GateMatrix {
            m00: [1.0, 0.0],
            m01: [0.0, 0.0],
            m10: [0.0, 0.0],
            m11: [inv_sqrt2, inv_sqrt2],
        },
        GateKind::TDagger => GateMatrix {
            m00: [1.0, 0.0],
            m01: [0.0, 0.0],
            m10: [0.0, 0.0],
            m11: [inv_sqrt2, -inv_sqrt2],
        },
        GateKind::Phase => GateMatrix {
            m00: [1.0, 0.0],
            m01: [0.0, 0.0],
            m10: [0.0, 0.0],
            m11: exp_i(default_angle),
        },
        GateKind::Rx => GateMatrix {
            m00: [cos_half, 0.0],
            m01: [0.0, -sin_half],
            m10: [0.0, -sin_half],
            m11: [cos_half, 0.0],
        },
        GateKind::Ry => GateMatrix {
            m00: [cos_half, 0.0],
            m01: [-sin_half, 0.0],
            m10: [sin_half, 0.0],
            m11: [cos_half, 0.0],
        },
        GateKind::Rz => GateMatrix {
            m00: [cos_half, -sin_half],
            m01: [0.0, 0.0],
            m10: [0.0, 0.0],
            m11: [cos_half, sin_half],
        },
        GateKind::Swap => GateMatrix {
            m00: [1.0, 0.0],
            m01: [0.0, 0.0],
            m10: [0.0, 0.0],
            m11: [1.0, 0.0],
        },
    }
}

// `GateParams` is the on-wire layout of a single gate operation handed to the
// WGSL compute shader (`STATE_COMPUTE_SHADER` in
// `gpu/shaders/state_compute.wgsl`). Each placed gate is linearised into one
// of these so the GPU can apply it via per-pair matrix multiply or, for
// Write0/Write1, a per-pair conditional swap.
pub(crate) const GATE_MODE_MATRIX: u32 = 0;
pub(crate) const GATE_MODE_WRITE0: u32 = 1;
pub(crate) const GATE_MODE_WRITE1: u32 = 2;

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct GateParams {
    m00: [f32; 2],
    m01: [f32; 2],
    m10: [f32; 2],
    m11: [f32; 2],
    bit: u32,
    state_count: u32,
    control_mask: u32,
    control_value: u32,
    mode: u32,
    _pad: [u32; 3],
}

#[cfg(test)]
impl GateParams {
    pub(crate) fn matrix(self) -> [[f32; 2]; 4] {
        [self.m00, self.m01, self.m10, self.m11]
    }

    pub(crate) fn bit(self) -> u32 {
        self.bit
    }

    pub(crate) fn control_mask(self) -> u32 {
        self.control_mask
    }

    pub(crate) fn control_value(self) -> u32 {
        self.control_value
    }
}

fn gate_mode(kind: GateKind) -> u32 {
    match kind {
        GateKind::Write0 => GATE_MODE_WRITE0,
        GateKind::Write1 => GATE_MODE_WRITE1,
        _ => GATE_MODE_MATRIX,
    }
}

pub(crate) fn gate_params(kind: GateKind, bit: QubitBit, state_count: u32) -> GateParams {
    let matrix = gate_matrix(kind);
    GateParams {
        m00: matrix.m00,
        m01: matrix.m01,
        m10: matrix.m10,
        m11: matrix.m11,
        bit: bit.as_u32(),
        state_count,
        control_mask: 0,
        control_value: 0,
        mode: gate_mode(kind),
        _pad: [0; 3],
    }
}

pub(crate) fn gate_params_controlled(
    kind: GateKind,
    bit: QubitBit,
    controls: ColumnControls,
    state_count: u32,
) -> GateParams {
    let matrix = gate_matrix(kind);
    GateParams {
        m00: matrix.m00,
        m01: matrix.m01,
        m10: matrix.m10,
        m11: matrix.m11,
        bit: bit.as_u32(),
        state_count,
        control_mask: controls.mask(),
        control_value: controls.value(),
        mode: gate_mode(kind),
        _pad: [0; 3],
    }
}

/// Parametric `P(φ)` phase gate: `diag(1, e^{iφ})`. Mirrors qni's
/// `gate-matrices.ts::PHASE` (`/packages/simulator/src/gate-matrices.ts:116`).
/// `control_mask` / `control_value` follow the standard control-mask
/// convention — pass `0`/`0` for an uncontrolled phase, or a bit mask
/// for a controlled-phase as part of a CZ-style column.
pub(crate) fn phase_params(
    phase: f32,
    bit: QubitBit,
    controls: ColumnControls,
    state_count: u32,
) -> GateParams {
    GateParams {
        m00: [1.0, 0.0],
        m01: [0.0, 0.0],
        m10: [0.0, 0.0],
        m11: [phase.cos(), phase.sin()],
        bit: bit.as_u32(),
        state_count,
        control_mask: controls.mask(),
        control_value: controls.value(),
        mode: gate_mode(GateKind::Phase),
        _pad: [0; 3],
    }
}

/// Parametric `Rx(θ)` rotation gate: `[[cos(θ/2), -i sin(θ/2)],
/// [-i sin(θ/2), cos(θ/2)]]`. Mirrors qni's
/// `gate-matrices.ts::RX` family. `control_mask` / `control_value`
/// follow the standard convention (pass `0`/`0` for uncontrolled).
pub(crate) fn rx_params(
    theta: f32,
    bit: QubitBit,
    controls: ColumnControls,
    state_count: u32,
) -> GateParams {
    let half = theta * 0.5;
    let c = half.cos();
    let s = half.sin();
    GateParams {
        m00: [c, 0.0],
        m01: [0.0, -s],
        m10: [0.0, -s],
        m11: [c, 0.0],
        bit: bit.as_u32(),
        state_count,
        control_mask: controls.mask(),
        control_value: controls.value(),
        mode: gate_mode(GateKind::Rx),
        _pad: [0; 3],
    }
}

/// Parametric `Ry(θ)` rotation gate: `[[cos(θ/2), -sin(θ/2)],
/// [sin(θ/2), cos(θ/2)]]`.
pub(crate) fn ry_params(
    theta: f32,
    bit: QubitBit,
    controls: ColumnControls,
    state_count: u32,
) -> GateParams {
    let half = theta * 0.5;
    let c = half.cos();
    let s = half.sin();
    GateParams {
        m00: [c, 0.0],
        m01: [-s, 0.0],
        m10: [s, 0.0],
        m11: [c, 0.0],
        bit: bit.as_u32(),
        state_count,
        control_mask: controls.mask(),
        control_value: controls.value(),
        mode: gate_mode(GateKind::Ry),
        _pad: [0; 3],
    }
}

/// Parametric `Rz(θ)` rotation gate: `diag(e^{-iθ/2}, e^{iθ/2})`.
pub(crate) fn rz_params(
    theta: f32,
    bit: QubitBit,
    controls: ColumnControls,
    state_count: u32,
) -> GateParams {
    let half = theta * 0.5;
    let c = half.cos();
    let s = half.sin();
    GateParams {
        m00: [c, -s],
        m01: [0.0, 0.0],
        m10: [0.0, 0.0],
        m11: [c, s],
        bit: bit.as_u32(),
        state_count,
        control_mask: controls.mask(),
        control_value: controls.value(),
        mode: gate_mode(GateKind::Rz),
        _pad: [0; 3],
    }
}
