//! Column-by-column lowering from editor gates into GPU dispatch ops.
//!
//! qni references for the per-column semantics:
//! - `packages/simulator/src/simulator.ts:runStep` — controls + targets in
//!   each step, then any measurement / display readouts on the post-step
//!   state.
//! - `packages/simulator/src/state-vector.ts` and `matrix.ts` — the math each
//!   shader implements (kept in `gpu/*`).

use super::{SimulationColumnAnalysis, SimulationOp};
use crate::app::PlacedGate;
use crate::gates::{
    gate_params, gate_params_controlled, phase_params, rx_params, ry_params, rz_params,
    ColumnControls, GateKind,
};
use crate::gpu::{Amplitude, Bloch, Density, Measurement, Probability, SlotAllocator, SlotIndex};
use crate::qubit_bit::QubitBit;
use crate::qubit_count::QubitCount;

/// Walks placed gates column by column and emits ops in the exact order the
/// GPU should run them. Non-mutating decoration (Spacer / Swap) is dropped.
/// Within each column the order is: column unitaries / writes → measurements
/// (reduce-sample then collapse) → bloch captures, mirroring qni's
/// `simulator.ts:runStep` semantics — bloch reads the post-collapse state.
/// `snapshot_slot_count`: number of semantic step snapshots to cache for the
/// state panel. Slot `k` stores the state after circuit step `k`; empty steps
/// copy the previous state. Hovering later switches to the cached slot via GPU
/// copy only, matching qni's worker-side per-step result cache.
pub(crate) fn linearize_ops(
    placed_gates: &[PlacedGate],
    qubits: QubitCount,
    snapshot_slot_count: usize,
) -> Vec<SimulationOp> {
    let n = qubits.get();
    let state_count = qubits
        .local_state_count_u32()
        .expect("linearize runs only on the local dispatch path within local capacity");

    let analysis = SimulationColumnAnalysis::from_gates(placed_gates, qubits);

    let mut ops: Vec<SimulationOp> = Vec::new();
    let mut next_snapshot_slot = 0usize;
    let mut bloch_slots = SlotAllocator::<Bloch>::new();
    let mut measurement_slots = SlotAllocator::<Measurement>::new();
    let mut probability_slots = SlotAllocator::<Probability>::new();
    let mut amplitude_slots = SlotAllocator::<Amplitude>::new();
    let mut density_slots = SlotAllocator::<Density>::new();
    for column in analysis.columns() {
        while next_snapshot_slot < column.slot && next_snapshot_slot < snapshot_slot_count {
            ops.push(SimulationOp::SnapshotState {
                output_slot: SlotIndex::new(next_snapshot_slot as u32),
            });
            next_snapshot_slot += 1;
        }
        let column_gates = column.gates();
        let controls = column.controls();
        let mut targets: Vec<&PlacedGate> = Vec::new();
        let mut bloch_targets: Vec<&PlacedGate> = Vec::new();
        let mut measurement_targets: Vec<&PlacedGate> = Vec::new();
        let mut probability_targets: Vec<&PlacedGate> = Vec::new();
        let mut amplitude_targets: Vec<&PlacedGate> = Vec::new();
        let mut density_targets: Vec<&PlacedGate> = Vec::new();
        let mut swap_targets: Vec<&PlacedGate> = Vec::new();

        let mut qft_gates: Vec<&PlacedGate> = Vec::new();
        for gate in column_gates {
            match gate.kind {
                GateKind::Control | GateKind::AntiControl => {}
                GateKind::Swap => swap_targets.push(gate),
                GateKind::Spacer => {
                    // Non-mutating decoration.
                }
                GateKind::Measurement => measurement_targets.push(gate),
                GateKind::BlochDisplay => bloch_targets.push(gate),
                GateKind::ProbabilityDisplay => probability_targets.push(gate),
                GateKind::AmplitudeDisplay => amplitude_targets.push(gate),
                GateKind::DensityMatrixDisplay => density_targets.push(gate),
                GateKind::QftGate | GateKind::QftDaggerGate => qft_gates.push(gate),
                _ => targets.push(gate),
            }
        }

        // Swap step → `push_swap_3cnot` (the 3-CNOT decomposition qni uses,
        // mirroring `simulator.ts::swap`). Column-level controls (Fredkin /
        // controlled-SWAP) ride along through `controls`.
        //
        // Two-target swap only; if the user dropped a single Swap with
        // no partner, or three+ Swaps in one column, the column is
        // skipped (qni dispatches only the first two `targets` and
        // disables stray swaps via `updateSwapConnections`).
        swap_targets.sort_by_key(|a| a.id);
        if swap_targets.len() == 2 {
            let bit_a = swap_targets[0]
                .wire
                .to_qubit_bit(qubits)
                .expect("column gates are within the register");
            let bit_b = swap_targets[1]
                .wire
                .to_qubit_bit(qubits)
                .expect("column gates are within the register");
            push_swap_3cnot(&mut ops, bit_a, bit_b, controls, state_count);
        }

        targets.sort_by_key(|a| a.id);
        for target in &targets {
            let bit = target
                .wire
                .to_qubit_bit(qubits)
                .expect("column gates are within the register");
            // Parametric gates carry an optional normalized angle. When
            // present we route through the matching `*_params(θ, …)` builder
            // so the matrix carries that angle; when absent we fall back to
            // the editor's pre-parametric π/2 default (the gate's hard-coded
            // matrix in `gate_matrix`). qni would instead error out at
            // simulate time for a bare `P` / `Rx` / `Ry` / `Rz`.
            type ParametricBuilder =
                fn(f32, QubitBit, ColumnControls, u32) -> crate::gates::GateParams;
            let parametric_builder: Option<ParametricBuilder> = match target.kind {
                GateKind::Phase => Some(phase_params),
                GateKind::Rx => Some(rx_params),
                GateKind::Ry => Some(ry_params),
                GateKind::Rz => Some(rz_params),
                _ => None,
            };
            let params = if let Some(build) = parametric_builder {
                if let Some(angle) = target.angle {
                    build(angle.radians_f32(), bit, controls, state_count)
                } else if controls.is_uncontrolled() {
                    gate_params(target.kind, bit, state_count)
                } else {
                    gate_params_controlled(target.kind, bit, controls, state_count)
                }
            } else if controls.is_uncontrolled() {
                gate_params(target.kind, bit, state_count)
            } else {
                gate_params_controlled(target.kind, bit, controls, state_count)
            };
            ops.push(SimulationOp::ApplyGate(params));
        }

        // Controls-only step ⇒ multi-controlled-Z (CZ / CCZ / …).
        // Mirrors qni's `circuit-step-element.ts:1303-1310`: a step with
        // ≥ 2 `ControlGateElement`s and no controllable target emits a
        // single `'•'` operation whose first wire becomes the Z target
        // and whose remaining wires become the controls. AntiControls
        // and lone single controls stay no-ops (qni :1312-1316 and the
        // `< 2` guard at :1306).
        //
        // `control_value` bits = Controls only (AntiControls live in
        // `control_mask & !control_value`). We pick the highest set bit of
        // `control_value` (now the bottommost wire, since our bit numbering
        // runs 0..qubits-1 top→bottom with q0=LSB) as the Z target. CZ is
        // physically symmetric so the choice only affects the GateParams
        // shape, not the resulting state.
        if targets.is_empty()
            && qft_gates.is_empty()
            && measurement_targets.is_empty()
            && bloch_targets.is_empty()
            && probability_targets.is_empty()
            && amplitude_targets.is_empty()
            && density_targets.is_empty()
            && swap_targets.is_empty()
            && controls.control_count() >= 2
        {
            let target_bit = controls
                .highest_control()
                .expect("control_count >= 2 guarantees a value bit");
            // Match qni and drop anti-control bits entirely: only the
            // remaining `Control` wires gate the Z. `controls_only` keeps
            // just the value (Control) bits, then `without` removes the Z
            // target. (Mixing anti-control bits into the mask would change
            // the semantics from qni's `{type:'•', targets:[control bits]}` form.)
            let cz_controls = controls.controls_only().without(target_bit);
            let params = gate_params_controlled(GateKind::Z, target_bit, cz_controls, state_count);
            ops.push(SimulationOp::ApplyGate(params));
        }

        // QFT-family gates expand to their textbook decomposition (H +
        // controlled-phase rotations). Column controls are threaded through
        // every decomposed operation, making the whole QFT conditional while
        // preserving the usual internal QFT controlled-phase gates.
        qft_gates.sort_by_key(|a| a.id);
        for qft in &qft_gates {
            let dagger = qft.kind == GateKind::QftDaggerGate;
            let qft_controls = qft_external_controls(qft, qubits, controls);
            ops.extend(linearize_qft(
                qft,
                qubits,
                state_count,
                dagger,
                qft_controls,
            ));
        }

        // Measurements run after the column's unitaries: reduce + sample,
        // then collapse. Each consumes one aux slot.
        measurement_targets.sort_by_key(|a| a.id);
        for measurement in &measurement_targets {
            let qubit_bit = measurement
                .wire
                .to_qubit_bit(qubits)
                .expect("column gates are within the register");
            let slot = measurement_slots.allocate();
            ops.push(SimulationOp::MeasureReduceSample {
                gate_id: measurement.id,
                qubit_bit,
                output_slot: slot,
            });
            ops.push(SimulationOp::MeasureCollapse {
                qubit_bit,
                aux_slot: slot,
            });
        }

        // Bloch captures see the post-measurement state.
        bloch_targets.sort_by_key(|a| a.id);
        for display in &bloch_targets {
            let qubit_bit = display
                .wire
                .to_qubit_bit(qubits)
                .expect("column gates are within the register");
            ops.push(SimulationOp::CaptureBloch {
                gate_id: display.id,
                qubit_bit,
                output_slot: bloch_slots.allocate(),
                controls,
            });
        }

        // Probability displays are also read-only displays. They capture the
        // current GPU state into a per-display probability buffer; rendering
        // samples that buffer directly, no CPU-side probabilities.
        probability_targets.sort_by_key(|a| a.id);
        for display in &probability_targets {
            if !display.wire.is_within(qubits) {
                continue;
            }
            let span = display
                .span
                .clamped_for(display.kind, n - display.wire.as_usize());
            // span 内の最下位ビット = 上端ワイヤ（q0=LSB なので wire がそのままビット位置）。
            // outcome の bit j は上端から j 本目のワイヤに対応し、ケットでは q0=上端が右端になる。
            let base_bit = display
                .wire
                .to_qubit_bit(qubits)
                .expect("display wire is within the register");
            ops.push(SimulationOp::CaptureProbability {
                gate_id: display.id,
                base_bit,
                span: span.get() as u32,
                output_slot: probability_slots.allocate(),
                controls,
            });
        }

        amplitude_targets.sort_by_key(|a| a.id);
        for display in &amplitude_targets {
            if !display.wire.is_within(qubits) {
                continue;
            }
            let span = display
                .span
                .clamped_for(display.kind, n - display.wire.as_usize());
            // span 内の最下位ビット = 上端ワイヤ（q0=LSB なので wire がそのままビット位置）。
            // outcome の bit j は上端から j 本目のワイヤに対応し、ケットでは q0=上端が右端になる。
            let base_bit = display
                .wire
                .to_qubit_bit(qubits)
                .expect("display wire is within the register");
            ops.push(SimulationOp::CaptureAmplitude {
                gate_id: display.id,
                base_bit,
                span: span.get() as u32,
                output_slot: amplitude_slots.allocate(),
                controls,
            });
        }

        density_targets.sort_by_key(|a| a.id);
        for display in &density_targets {
            if !display.wire.is_within(qubits) {
                continue;
            }
            let span = display
                .span
                .clamped_for(display.kind, n - display.wire.as_usize());
            // span 内の最下位ビット = 上端ワイヤ（q0=LSB なので wire がそのままビット位置）。
            // outcome の bit j は上端から j 本目のワイヤに対応し、ケットでは q0=上端が右端になる。
            let base_bit = display
                .wire
                .to_qubit_bit(qubits)
                .expect("display wire is within the register");
            ops.push(SimulationOp::CaptureDensity {
                gate_id: display.id,
                base_bit,
                span: span.get() as u32,
                output_slot: density_slots.allocate(),
                controls,
            });
        }

        if next_snapshot_slot == column.slot && next_snapshot_slot < snapshot_slot_count {
            ops.push(SimulationOp::SnapshotState {
                output_slot: SlotIndex::new(next_snapshot_slot as u32),
            });
            next_snapshot_slot += 1;
        }
    }
    while next_snapshot_slot < snapshot_slot_count {
        ops.push(SimulationOp::SnapshotState {
            output_slot: SlotIndex::new(next_snapshot_slot as u32),
        });
        next_snapshot_slot += 1;
    }
    ops
}

/// Return only controls outside the QFT span. A decoded URL can contain a
/// control token on a row covered by the QFT body; treating it as an external
/// control would create self-controlled H / duplicate controlled-phase ops.
fn qft_external_controls(
    gate: &PlacedGate,
    qubits: QubitCount,
    controls: ColumnControls,
) -> ColumnControls {
    if !gate.wire.is_within(qubits) {
        return controls;
    }
    let span = gate
        .span
        .clamped_for(gate.kind, qubits.get() - gate.wire.as_usize())
        .get();
    let mut qft_span_mask = 0u32;
    for offset in 0..span {
        qft_span_mask |= gate
            .wire
            .offset(offset)
            .to_qubit_bit(qubits)
            .expect("offset is within the clamped span")
            .mask();
    }
    controls.restricted_outside(qft_span_mask)
}

/// Expand a placed QFT (or QFT†) gate into the textbook decomposition:
/// a bit-reversal SWAP network plus `span` Hadamards interleaved with
/// controlled-phase rotations `R_k = diag(1, exp(iπ/2^j))`.
///
/// The bare H/phase ladder (H on the top wire first, controlled phases
/// running downward) realizes the DFT acting on bit-reversed input
/// (`F·BR`). Putting the bit-reversal swaps *before* the ladder feeds it the
/// reversed input, so the net transform is the true (symmetric) discrete
/// Fourier transform `F[r,c] = (1/√N)·exp(+i2πrc/N)` — matching Quirk's
/// `FourierTransformGates`, which likewise reverses first. A Quirk QFT circuit
/// ports 1:1: e.g. a which-path mark on the QFT register's bit-2 wire yields
/// 4 interference fringes, as in Quirk.
///
/// `QFT` = swaps then ladder; `QFT†` is its adjoint = inverse ladder then
/// swaps, so the swap network comes *after* the (inverse) ladder.
///
/// Wire-to-bit mapping: `gate.wire + idx` (wire index of the i-th
/// qubit in the QFT register) → `bit = wire` (the simulator convention
/// where the top wire q0 is the LSB; identity map).
fn linearize_qft(
    gate: &PlacedGate,
    qubits: QubitCount,
    state_count: u32,
    dagger: bool,
    controls: ColumnControls,
) -> Vec<SimulationOp> {
    if !gate.wire.is_within(qubits) {
        return Vec::new();
    }
    // Clamp the span so the QFT never reaches past the qubit register;
    // a user-resized QFT can momentarily extend beyond the placed
    // bottom wire before `update_qubit_count` catches up.
    let span = gate
        .span
        .clamped_for(gate.kind, qubits.get() - gate.wire.as_usize())
        .get();
    if span == 0 {
        return Vec::new();
    }
    let bit_of = |idx: usize| {
        gate.wire
            .offset(idx)
            .to_qubit_bit(qubits)
            .expect("idx is within the clamped span")
    };
    let mut ops = Vec::new();
    let reversal = qft_reversal_swap_ops(gate, qubits, span, state_count, controls);

    if !dagger {
        // QFT: bit-reversal swaps FIRST, then the H/phase ladder — for i in
        // 0..span: H(i), then controlled-Phase π/2^j with control=(i+j) for
        // j in 1..span-i. The bare ladder realizes F·BR (the DFT acting on
        // bit-reversed input), so feeding it the reversed input lands the
        // true symmetric DFT (Quirk's FourierTransformGates reverses first too).
        ops.extend(reversal);
        for i in 0..span {
            ops.push(SimulationOp::ApplyGate(qft_h_params(
                bit_of(i),
                state_count,
                controls,
            )));
            for j in 1..(span - i) {
                let phase = std::f32::consts::PI / (1u32 << j) as f32;
                ops.push(SimulationOp::ApplyGate(qft_phase_params(
                    bit_of(i),
                    bit_of(i + j),
                    phase,
                    state_count,
                    controls,
                )));
            }
        }
    } else {
        // QFT† is the adjoint of "swaps then ladder", i.e. "inverse ladder
        // then swaps": the inverse ladder (reverse loop, negated phases, H
        // after the phases) comes first, then the trailing bit-reversal swaps.
        for i in (0..span).rev() {
            for j in (1..(span - i)).rev() {
                let phase = -std::f32::consts::PI / (1u32 << j) as f32;
                ops.push(SimulationOp::ApplyGate(qft_phase_params(
                    bit_of(i),
                    bit_of(i + j),
                    phase,
                    state_count,
                    controls,
                )));
            }
            ops.push(SimulationOp::ApplyGate(qft_h_params(
                bit_of(i),
                state_count,
                controls,
            )));
        }
        ops.extend(reversal);
    }
    ops
}

/// Bit-reversal SWAP network for a QFT register: `swap(wire i, wire span−1−i)`
/// for the first half of the span. Each swap expands to the same 3-CNOT
/// sequence as a column `Swap` (`X b ctrl a`, `X a ctrl b`, `X b ctrl a`),
/// and any external `controls` ride along so a controlled-QFT gates the
/// swaps too.
fn qft_reversal_swap_ops(
    gate: &PlacedGate,
    qubits: QubitCount,
    span: usize,
    state_count: u32,
    controls: ColumnControls,
) -> Vec<SimulationOp> {
    let bit_of = |idx: usize| {
        gate.wire
            .offset(idx)
            .to_qubit_bit(qubits)
            .expect("idx is within the clamped span")
    };
    let mut ops = Vec::new();
    for i in 0..(span / 2) {
        push_swap_3cnot(
            &mut ops,
            bit_of(i),
            bit_of(span - 1 - i),
            controls,
            state_count,
        );
    }
    ops
}

/// Expand one `SWAP(bit_a, bit_b)` into the 3-CNOT sequence qni uses
/// (mirroring `simulator.ts::swap`): `X b ctrl a`, `X a ctrl b`, `X b ctrl a`.
/// Any column-level `controls` (Fredkin / controlled-SWAP) ride along on each
/// CX. Shared by the column `Swap` step and the QFT bit-reversal network.
fn push_swap_3cnot(
    ops: &mut Vec<SimulationOp>,
    bit_a: QubitBit,
    bit_b: QubitBit,
    controls: ColumnControls,
    state_count: u32,
) {
    let cx_a_to_b = gate_params_controlled(
        GateKind::X,
        bit_b,
        controls.with_control(bit_a),
        state_count,
    );
    let cx_b_to_a = gate_params_controlled(
        GateKind::X,
        bit_a,
        controls.with_control(bit_b),
        state_count,
    );
    ops.push(SimulationOp::ApplyGate(cx_a_to_b));
    ops.push(SimulationOp::ApplyGate(cx_b_to_a));
    ops.push(SimulationOp::ApplyGate(cx_a_to_b));
}

fn qft_h_params(
    bit: QubitBit,
    state_count: u32,
    controls: ColumnControls,
) -> crate::gates::GateParams {
    if controls.is_uncontrolled() {
        gate_params(GateKind::H, bit, state_count)
    } else {
        gate_params_controlled(GateKind::H, bit, controls, state_count)
    }
}

fn qft_phase_params(
    target_bit: QubitBit,
    qft_control_bit: QubitBit,
    phase: f32,
    state_count: u32,
    controls: ColumnControls,
) -> crate::gates::GateParams {
    phase_params(
        phase,
        target_bit,
        controls.with_control(qft_control_bit),
        state_count,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qubit_count::QubitCount;

    const EPSILON: f32 = 0.000_001;

    fn qubit_count(value: usize) -> QubitCount {
        QubitCount::try_new(value).expect("test qubit count must be non-zero")
    }

    fn bare_parametric_matrix(kind: GateKind) -> [[f32; 2]; 4] {
        let gate = PlacedGate::new(
            crate::app::GateId::from_u32(1),
            kind,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        );
        let ops = linearize_ops(&[gate], qubit_count(1), 0);
        match ops.first().expect("expected an apply-gate op") {
            SimulationOp::ApplyGate(params) => params.matrix(),
            _ => panic!("expected apply-gate op"),
        }
    }

    fn apply_gate_params(ops: &[SimulationOp], index: usize) -> crate::gates::GateParams {
        match ops.get(index).expect("expected an apply-gate op") {
            SimulationOp::ApplyGate(params) => *params,
            _ => panic!("expected apply-gate op"),
        }
    }

    #[test]
    fn bare_phase_uses_pi_over_two_default() {
        assert!((bare_parametric_matrix(GateKind::Phase)[3][1] - 1.0).abs() < EPSILON);
    }

    #[test]
    fn bare_rx_uses_pi_over_two_default() {
        assert!(
            (bare_parametric_matrix(GateKind::Rx)[1][1] + std::f32::consts::FRAC_1_SQRT_2).abs()
                < EPSILON
        );
    }

    #[test]
    fn bare_ry_uses_pi_over_two_default() {
        assert!(
            (bare_parametric_matrix(GateKind::Ry)[2][0] - std::f32::consts::FRAC_1_SQRT_2).abs()
                < EPSILON
        );
    }

    #[test]
    fn bare_rz_uses_pi_over_two_default() {
        assert!(
            (bare_parametric_matrix(GateKind::Rz)[0][1] + std::f32::consts::FRAC_1_SQRT_2).abs()
                < EPSILON
        );
    }

    #[test]
    fn measurement_pair_shares_one_slot() {
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::Measurement,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        )];
        let ops = linearize_ops(&gates, qubit_count(1), 0);
        let reduce_slot = ops.iter().find_map(|op| match op {
            SimulationOp::MeasureReduceSample { output_slot, .. } => Some(*output_slot),
            _ => None,
        });
        let collapse_slot = ops.iter().find_map(|op| match op {
            SimulationOp::MeasureCollapse { aux_slot, .. } => Some(*aux_slot),
            _ => None,
        });

        assert_eq!(
            (reduce_slot, collapse_slot),
            (Some(SlotIndex::new(0)), Some(SlotIndex::new(0)))
        );
    }

    #[test]
    fn two_controls_emit_controlled_z() {
        // 3 qubits, Controls on the top two wires (no target gate) → CCZ.
        // wire 0 → bit 0; wire 1 → bit 1 (highest set bit = Z target). The
        // remaining Control (bit 0) gates the Z.
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        let params = apply_gate_params(&linearize_ops(&gates, qubit_count(3), 0), 0);

        assert_eq!(
            (params.bit(), params.control_mask(), params.control_value()),
            (1, 0b001, 0b001)
        );
    }

    #[test]
    fn controlled_z_drops_anti_control_bits() {
        // 3 qubits: Controls on wires 0, 1 (bits 0, 1) and an AntiControl on
        // wire 2 (bit 2). The Z target is the highest Control bit (bit 1) and
        // it keeps only the remaining Control (bit 0); the anti-control (bit 2)
        // must not leak into the Z's control mask.
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(3),
                GateKind::AntiControl,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(2),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        let params = apply_gate_params(&linearize_ops(&gates, qubit_count(3), 0), 0);

        assert_eq!(
            (params.bit(), params.control_mask(), params.control_value()),
            (1, 0b001, 0b001)
        );
    }

    #[test]
    fn controlled_qft_applies_external_control_to_hadamard() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::QftGate,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::try_new(2).unwrap(),
                None,
            ),
        ];

        // The forward QFT now leads with the bit-reversal swaps (op[0..3]);
        // the first Hadamard is op[3]. The external control rides along on it.
        let params = apply_gate_params(&linearize_ops(&gates, qubit_count(3), 0), 3);

        assert_eq!(
            (params.bit(), params.control_mask(), params.control_value()),
            (1, 0b001, 0b001)
        );
    }

    #[test]
    fn controlled_qft_combines_external_control_with_internal_phase_control() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::QftGate,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::try_new(2).unwrap(),
                None,
            ),
        ];

        // op[0..3] are the leading bit-reversal swaps, op[3] the first
        // Hadamard, op[4] the first controlled-phase. Its control mask combines
        // the external control (bit 0) with the internal phase control (bit 2).
        let params = apply_gate_params(&linearize_ops(&gates, qubit_count(3), 0), 4);

        assert_eq!(
            (params.bit(), params.control_mask(), params.control_value()),
            (1, 0b101, 0b101)
        );
    }

    #[test]
    fn anti_controlled_qft_keeps_zero_external_control_value() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::AntiControl,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::QftGate,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::try_new(2).unwrap(),
                None,
            ),
        ];

        // First Hadamard at op[3] (after the leading bit-reversal swaps); the
        // external anti-control (bit 0, value 0) rides along on it.
        let params = apply_gate_params(&linearize_ops(&gates, qubit_count(3), 0), 3);

        assert_eq!(
            (params.bit(), params.control_mask(), params.control_value()),
            (1, 0b001, 0)
        );
    }

    #[test]
    fn qft_ignores_control_tokens_inside_its_span() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::QftGate,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::try_new(2).unwrap(),
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        // First Hadamard at op[3] (after the leading bit-reversal swaps). The
        // control sits inside the QFT span, so it is ignored: no control mask.
        let params = apply_gate_params(&linearize_ops(&gates, qubit_count(2), 0), 3);

        assert_eq!(
            (params.bit(), params.control_mask(), params.control_value()),
            (0, 0, 0)
        );
    }

    #[test]
    fn qft_emits_leading_bit_reversal_swap() {
        // The forward QFT begins with a leading bit-reversal SWAP network,
        // then the H/phase ladder (true symmetric DFT = swaps + ladder).
        // For a span-2 QFT on wires 0,1 op[0] is the first CNOT of the leading
        // swap(bit0, bit1): X on bit 1 controlled by bit 0; the ladder H, P, H
        // follows at op[3..6].
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::QftGate,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::try_new(2).unwrap(),
            None,
        )];

        let params = apply_gate_params(&linearize_ops(&gates, qubit_count(2), 0), 0);

        assert_eq!(
            (params.bit(), params.control_mask(), params.control_value()),
            (1, 0b01, 0b01)
        );
    }

    #[test]
    fn qft_dagger_emits_trailing_bit_reversal_swap() {
        // QFT† is the adjoint of "swaps then ladder" = "inverse ladder then
        // swaps", so its bit-reversal SWAP network comes last. span-2 QFT† on
        // wires 0,1: the inverse ladder H, P, H is op[0..3]; op[3] is the first
        // CNOT of the trailing swap(bit0, bit1): X on bit 1 controlled by bit 0.
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::QftDaggerGate,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::try_new(2).unwrap(),
            None,
        )];

        let params = apply_gate_params(&linearize_ops(&gates, qubit_count(2), 0), 3);

        assert_eq!(
            (params.bit(), params.control_mask(), params.control_value()),
            (1, 0b01, 0b01)
        );
    }

    /// 各 `ApplyGate` を (対象ビット, 制御マスク, 制御値, 量子化した行列) に
    /// 要約する。行列は 1e-6 精度で整数化し、順序づき比較が浮動小数の微小誤差に
    /// 振り回されないようにする。`SnapshotState` 等の非ユニタリ演算は除外する。
    fn applied_gate_summary(json: &str) -> Vec<(u32, u32, u32, [i64; 8])> {
        let (gates, _) = crate::url_circuit::parse_circuit_json(json);
        linearize_ops(&gates, qubit_count(4), 0)
            .iter()
            .filter_map(|op| match op {
                SimulationOp::ApplyGate(params) => {
                    let m = params.matrix();
                    let q = |value: f32| (value * 1_000_000.0).round() as i64;
                    Some((
                        params.bit(),
                        params.control_mask(),
                        params.control_value(),
                        [
                            q(m[0][0]),
                            q(m[0][1]),
                            q(m[1][0]),
                            q(m[1][1]),
                            q(m[2][0]),
                            q(m[2][1]),
                            q(m[3][0]),
                            q(m[3][1]),
                        ],
                    ))
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn decomposed_qft4_matches_native_qft4_ops() {
        // 分解版 QFT4 サンプルは、ネイティブ `QFT4` ゲートと同一の ApplyGate 列
        // （同じ行列・対象ビット・制御）へ展開される = 数学的に等価。
        let native = applied_gate_summary(r#"{"cols":[["QFT4"]]}"#);
        let decomposed = applied_gate_summary(qni_web_circuit_library_model::QFT4_DECOMPOSED_JSON);

        assert_eq!(decomposed, native);
    }

    /// `ApplyGate` 列を `basis` 番目の基底状態へ CPU で適用し、結果の状態ベクトル
    /// （= ユニタリの `basis` 列目）を (re, im) で返す。各 `ApplyGate` は対象ビット
    /// 上の単一量子ビットゲートで、`(i0 & control_mask) == control_value` のペアだけ
    /// に作用する（GPU の STATE_COMPUTE_SHADER の GATE_MODE_MATRIX 経路と同じ意味論。
    /// QFT 展開は行列モードのゲートだけなので Write0/Write1 モードは扱わない）。
    /// テスト専用の検証用。
    fn qft_apply_to_basis(ops: &[SimulationOp], n: u32, basis: usize) -> Vec<(f64, f64)> {
        let dim = 1usize << n;
        let mut state = vec![(0.0f64, 0.0f64); dim];
        state[basis] = (1.0, 0.0);
        let mul = |a: (f64, f64), b: (f64, f64)| (a.0 * b.0 - a.1 * b.1, a.0 * b.1 + a.1 * b.0);
        let add = |a: (f64, f64), b: (f64, f64)| (a.0 + b.0, a.1 + b.1);
        for op in ops {
            let SimulationOp::ApplyGate(p) = op else {
                continue;
            };
            let bit = p.bit() as usize;
            let mask = p.control_mask();
            let val = p.control_value();
            let m = p.matrix();
            let cx = |k: usize| (m[k][0] as f64, m[k][1] as f64);
            let (m00, m01, m10, m11) = (cx(0), cx(1), cx(2), cx(3));
            let step = 1usize << bit;
            let mut next = state.clone();
            for i0 in 0..dim {
                if i0 & step != 0 || (i0 as u32 & mask) != val {
                    continue;
                }
                let i1 = i0 | step;
                let (a0, a1) = (state[i0], state[i1]);
                next[i0] = add(mul(m00, a0), mul(m01, a1));
                next[i1] = add(mul(m10, a0), mul(m11, a1));
            }
            state = next;
        }
        state
    }

    /// ネイティブ QFT<n> / QFT†<n> が対称離散フーリエ変換 F[r,c] =
    /// (1/√N)·exp(±i2πrc/N)（Quirk の FourierTransformGates。順方向 +、ダガー −）
    /// へ展開されることを、内部整合ではなく結果ユニタリで固定する。ビット反転 SWAP
    /// が逆側にあると落ちる回帰ガード。span は全レジスタ（wire0 から n 本）。
    fn assert_native_qft_matches_dft(n: u32, dagger: bool) {
        let dim = 1usize << n;
        let kind = if dagger {
            GateKind::QftDaggerGate
        } else {
            GateKind::QftGate
        };
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            kind,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::try_new(n as usize).unwrap(),
            None,
        )];
        let ops = linearize_ops(&gates, qubit_count(n as usize), 0);
        let q = |v: f64| (v * 100_000.0).round() as i64;
        let actual: Vec<(i64, i64)> = (0..dim)
            .flat_map(|c| {
                qft_apply_to_basis(&ops, n, c)
                    .into_iter()
                    .map(move |(re, im)| (q(re), q(im)))
            })
            .collect();
        let scale = (dim as f64).sqrt();
        let sign = if dagger { -1.0 } else { 1.0 };
        let expected: Vec<(i64, i64)> = (0..dim)
            .flat_map(|c| {
                (0..dim).map(move |r| {
                    let theta =
                        sign * 2.0 * std::f64::consts::PI * (r as f64) * (c as f64) / (dim as f64);
                    (q(theta.cos() / scale), q(theta.sin() / scale))
                })
            })
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn native_qft2_equals_symmetric_dft() {
        assert_native_qft_matches_dft(2, false);
    }

    #[test]
    fn native_qft3_equals_symmetric_dft() {
        assert_native_qft_matches_dft(3, false);
    }

    #[test]
    fn native_qft2_dagger_equals_inverse_dft() {
        assert_native_qft_matches_dft(2, true);
    }

    #[test]
    fn native_qft3_dagger_equals_inverse_dft() {
        assert_native_qft_matches_dft(3, true);
    }

    #[test]
    fn probability_display_captures_column_controls() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::ProbabilityDisplay,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        let ops = linearize_ops(&gates, qubit_count(2), 0);

        assert!(matches!(
            ops.first(),
            Some(SimulationOp::CaptureProbability { controls, .. })
                if controls.mask() == 0b1 && controls.value() == 0b1
        ));
    }

    #[test]
    fn probability_display_base_bit_is_span_top() {
        // 3 qubits, top wire, span 2 → base_bit = top wire = 0 (q0=LSB),
        // exercising `wire.to_qubit_bit(qubits)` (span's lowest bit).
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::ProbabilityDisplay,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::try_new(2).unwrap(),
            None,
        )];

        let ops = linearize_ops(&gates, qubit_count(3), 0);

        assert!(matches!(
            ops.first(),
            Some(SimulationOp::CaptureProbability { base_bit, .. }) if base_bit.as_u32() == 0
        ));
    }

    #[test]
    fn amplitude_display_captures_column_controls() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::Control,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::AmplitudeDisplay,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        let ops = linearize_ops(&gates, qubit_count(2), 0);

        assert!(matches!(
            ops.first(),
            Some(SimulationOp::CaptureAmplitude { controls, .. })
                if controls.mask() == 0b1 && controls.value() == 0b1
        ));
    }

    #[test]
    fn density_display_captures_column_controls() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::AntiControl,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::DensityMatrixDisplay,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        let ops = linearize_ops(&gates, qubit_count(2), 0);

        assert!(matches!(
            ops.first(),
            Some(SimulationOp::CaptureDensity { controls, .. })
                if controls.mask() == 0b1 && controls.value() == 0
        ));
    }

    #[test]
    fn density_display_caps_span_at_eight() {
        // A density display stored with span 10 lowers with span clamped to the
        // GateKind cap of 8 via `GateSpan::clamped_for`, even at 16 qubits.
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(1),
            GateKind::DensityMatrixDisplay,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::try_new(10).unwrap(),
            None,
        )];

        let ops = linearize_ops(&gates, qubit_count(16), 0);

        assert!(matches!(
            ops.first(),
            Some(SimulationOp::CaptureDensity { span: 8, .. })
        ));
    }

    #[test]
    fn bloch_display_captures_column_controls() {
        let gates = [
            PlacedGate::new(
                crate::app::GateId::from_u32(1),
                GateKind::AntiControl,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(0),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
            PlacedGate::new(
                crate::app::GateId::from_u32(2),
                GateKind::BlochDisplay,
                crate::app::CircuitColumnIndex::new(0),
                crate::app::WireIndex::new(1),
                crate::gates::GateSpan::SINGLE,
                None,
            ),
        ];

        let ops = linearize_ops(&gates, qubit_count(2), 0);

        assert!(matches!(
            ops.first(),
            Some(SimulationOp::CaptureBloch { controls, .. })
                if controls.mask() == 0b1 && controls.value() == 0
        ));
    }

    #[test]
    fn bloch_display_op_carries_gate_id() {
        // 線形化 op ストリームはゲートの同一性を GateId のまま運び、u32 へ落として
        // 採番し直す往復を作らない。
        let gates = [PlacedGate::new(
            crate::app::GateId::from_u32(5),
            GateKind::BlochDisplay,
            crate::app::CircuitColumnIndex::new(0),
            crate::app::WireIndex::new(0),
            crate::gates::GateSpan::SINGLE,
            None,
        )];

        let ops = linearize_ops(&gates, qubit_count(1), 0);

        assert!(matches!(
            ops.first(),
            Some(SimulationOp::CaptureBloch { gate_id, .. })
                if *gate_id == crate::app::GateId::from_u32(5)
        ));
    }
}
