//! Copy/paste domain model for circuit fragments.
//!
//! Clipboard data deliberately excludes entity identity and draw positions.
//! A paste allocates fresh gate ids and derives positions from semantic
//! column/wire coordinates, keeping this layer independent from egui and GPU
//! state.

use std::collections::BTreeSet;

use super::{CircuitColumnIndex, GateId, GateIdAllocator, PlacedGate, WireIndex};
use crate::gates::{GateKind, GateSpan, ParametricAngle};
use crate::layout::gate_width_cols;
use crate::qubit_count::QubitCapacity;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CircuitCell {
    pub(crate) column: CircuitColumnIndex,
    pub(crate) wire: WireIndex,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClipboardGate {
    pub(crate) kind: GateKind,
    pub(crate) column_offset: usize,
    pub(crate) wire_offset: usize,
    pub(crate) span: GateSpan,
    pub(crate) angle: Option<ParametricAngle>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CircuitFragment {
    pub(crate) gates: Vec<ClipboardGate>,
    pub(crate) width: usize,
    pub(crate) height: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PasteFragmentError {
    ColumnOverflow,
    InsertionSplitsGate,
    QubitCapacityExceeded,
}

impl CircuitFragment {
    pub(crate) fn from_selection(
        placed_gates: &[PlacedGate],
        selected_gate_ids: &BTreeSet<GateId>,
    ) -> Option<Self> {
        let selected: Vec<&PlacedGate> = placed_gates
            .iter()
            .filter(|gate| selected_gate_ids.contains(&gate.id))
            .collect();
        let min_column = selected.iter().map(|gate| gate.column.as_usize()).min()?;
        let min_wire = selected.iter().map(|gate| gate.wire.as_usize()).min()?;
        let max_column_end = selected
            .iter()
            .map(|gate| {
                gate.column
                    .as_usize()
                    .checked_add(gate_width_cols(gate.kind, gate.span.get()))
            })
            .collect::<Option<Vec<_>>>()?
            .into_iter()
            .max()?;
        let max_wire_end = selected
            .iter()
            .map(|gate| gate.wire.as_usize().checked_add(gate.span.get()))
            .collect::<Option<Vec<_>>>()?
            .into_iter()
            .max()?;
        let width = max_column_end.checked_sub(min_column)?;
        let height = max_wire_end.checked_sub(min_wire)?;
        let gates = selected
            .into_iter()
            .map(|gate| ClipboardGate {
                kind: gate.kind,
                column_offset: gate.column.as_usize() - min_column,
                wire_offset: gate.wire.as_usize() - min_wire,
                span: gate.span,
                angle: gate.angle,
            })
            .collect();

        Some(Self {
            gates,
            width,
            height,
        })
    }
}

/// Return the semantic operation represented by one clicked gate.
///
/// qni-gl stores control/swap connections on operation objects. This app
/// derives the same relationships from gates sharing a circuit column, so the
/// selection must use that column model too. Parallel gates remain independent
/// unless controls are present, and a Swap is connected only when it has
/// exactly one partner.
fn connected_selection(
    placed_gates: &[PlacedGate],
    selected_gate: &PlacedGate,
) -> BTreeSet<GateId> {
    let column = placed_gates
        .iter()
        .filter(|gate| gate.column == selected_gate.column)
        .collect::<Vec<_>>();
    let controls = column
        .iter()
        .copied()
        .filter(|gate| matches!(gate.kind, GateKind::Control | GateKind::AntiControl))
        .collect::<Vec<_>>();
    let swaps = column
        .iter()
        .copied()
        .filter(|gate| gate.kind == GateKind::Swap)
        .collect::<Vec<_>>();

    let connected = match selected_gate.kind {
        GateKind::Swap if swaps.len() == 2 => column
            .into_iter()
            .filter(|gate| {
                matches!(
                    gate.kind,
                    GateKind::Control | GateKind::AntiControl | GateKind::Swap
                )
            })
            .collect::<Vec<_>>(),
        GateKind::Control | GateKind::AntiControl
            if controls.len() >= 2 || column.iter().any(|gate| is_control_target(gate.kind)) =>
        {
            column
                .into_iter()
                .filter(|gate| {
                    matches!(gate.kind, GateKind::Control | GateKind::AntiControl)
                        || is_control_target(gate.kind)
                })
                .collect::<Vec<_>>()
        }
        _ if !controls.is_empty() && is_control_target(selected_gate.kind) => column
            .into_iter()
            .filter(|gate| {
                matches!(gate.kind, GateKind::Control | GateKind::AntiControl)
                    || is_control_target(gate.kind)
            })
            .collect::<Vec<_>>(),
        _ => vec![selected_gate],
    };

    connected.into_iter().map(|gate| gate.id).collect()
}

fn is_control_target(kind: GateKind) -> bool {
    !matches!(
        kind,
        GateKind::Control | GateKind::AntiControl | GateKind::Spacer
    )
}

fn selection_paste_anchor(
    placed_gates: &[PlacedGate],
    selected_gate_ids: &BTreeSet<GateId>,
) -> Option<CircuitCell> {
    let selected = placed_gates
        .iter()
        .filter(|gate| selected_gate_ids.contains(&gate.id))
        .collect::<Vec<_>>();
    let rightmost_column = selected
        .iter()
        .filter_map(|gate| {
            gate.column
                .checked_add(gate_width_cols(gate.kind, gate.span.get()).saturating_sub(1))
        })
        .max()?;
    let top_wire = selected.iter().map(|gate| gate.wire).min()?;

    Some(CircuitCell {
        column: rightmost_column,
        wire: top_wire,
    })
}

pub(crate) fn paste_fragment(
    placed_gates: &[PlacedGate],
    fragment: &CircuitFragment,
    insert_column: CircuitColumnIndex,
    anchor_wire: WireIndex,
    capacity: QubitCapacity,
    gate_ids: &mut GateIdAllocator,
) -> Result<Vec<PlacedGate>, PasteFragmentError> {
    let fragment_wire_end = anchor_wire
        .as_usize()
        .checked_add(fragment.height)
        .ok_or(PasteFragmentError::QubitCapacityExceeded)?;
    if fragment_wire_end > capacity.get() {
        return Err(PasteFragmentError::QubitCapacityExceeded);
    }
    for gate in placed_gates {
        let gate_end = gate
            .column
            .checked_add(gate_width_cols(gate.kind, gate.span.get()))
            .ok_or(PasteFragmentError::ColumnOverflow)?;
        if gate.column < insert_column && insert_column < gate_end {
            return Err(PasteFragmentError::InsertionSplitsGate);
        }
    }
    let shifted_columns = placed_gates
        .iter()
        .map(|gate| {
            if gate.column >= insert_column {
                gate.column
                    .checked_add(fragment.width)
                    .ok_or(PasteFragmentError::ColumnOverflow)
            } else {
                Ok(gate.column)
            }
        })
        .collect::<Result<Vec<_>, _>>()?;

    let pasted_positions = fragment
        .gates
        .iter()
        .map(|gate| {
            let column = insert_column
                .checked_add(gate.column_offset)
                .ok_or(PasteFragmentError::ColumnOverflow)?;
            let wire = anchor_wire
                .as_usize()
                .checked_add(gate.wire_offset)
                .ok_or(PasteFragmentError::QubitCapacityExceeded)?;
            let wire_end = wire
                .checked_add(gate.span.get())
                .ok_or(PasteFragmentError::QubitCapacityExceeded)?;
            if wire_end > capacity.get() {
                return Err(PasteFragmentError::QubitCapacityExceeded);
            }
            Ok((column, WireIndex::new(wire)))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut result = placed_gates.to_vec();
    for (gate, column) in result.iter_mut().zip(shifted_columns) {
        gate.column = column;
        gate.sync_pos_from_grid();
    }
    result.extend(
        fragment
            .gates
            .iter()
            .zip(pasted_positions)
            .map(|(gate, (column, wire))| {
                PlacedGate::new(
                    gate_ids.allocate(),
                    gate.kind,
                    column,
                    wire,
                    gate.span,
                    gate.angle,
                )
            }),
    );
    Ok(result)
}

impl super::QniApp {
    pub(crate) fn select_gate_for_copy(&mut self, gate_id: GateId) {
        let Some(gate) = self.placed_gates.iter().find(|gate| gate.id == gate_id) else {
            return;
        };
        let selection = connected_selection(&self.placed_gates, gate);
        if selection.len() != 1 {
            self.selected_gate_ids.clear();
            self.paste_anchor = None;
            return;
        }
        self.selected_gate_ids = selection;
        self.paste_anchor = selection_paste_anchor(&self.placed_gates, &self.selected_gate_ids);
    }

    pub(crate) fn handle_copy_paste_shortcuts(&mut self, ctx: &eframe::egui::Context) {
        if ctx.wants_keyboard_input() || self.library.active_locked() || self.picker.is_open() {
            return;
        }
        let (copy, cut, paste) = ctx.input_mut(|input| {
            let command = eframe::egui::Modifiers::COMMAND;
            (
                input.consume_key(command, eframe::egui::Key::C),
                input.consume_key(command, eframe::egui::Key::X),
                input.consume_key(command, eframe::egui::Key::V),
            )
        });
        if copy {
            self.copy_selected_gates();
        }
        if cut {
            self.copy_selected_gates();
            self.delete_selected_gates(ctx);
        }
        if paste {
            self.paste_copied_gates(ctx);
        }
    }

    fn copy_selected_gates(&mut self) {
        let Some(fragment) =
            CircuitFragment::from_selection(&self.placed_gates, &self.selected_gate_ids)
        else {
            return;
        };
        self.circuit_clipboard = Some(fragment);
    }

    fn paste_copied_gates(&mut self, ctx: &eframe::egui::Context) {
        if self.library.active_locked() {
            return;
        }
        let (Some(fragment), Some(anchor)) = (&self.circuit_clipboard, self.paste_anchor) else {
            return;
        };
        let Some(insert_column) = anchor.column.checked_add(1) else {
            return;
        };
        let Ok(next_gates) = paste_fragment(
            &self.placed_gates,
            fragment,
            insert_column,
            anchor.wire,
            self.exec_mode.qubit_capacity(),
            &mut self.gate_ids,
        ) else {
            return;
        };

        self.begin_circuit_commit();
        self.placed_gates = next_gates;
        self.update_qubit_count();
        if self.commit_current_circuit(ctx) {
            self.gpu_plan.mark_dirty();
            self.clear_gpu_plan_capacity_error();
        }
    }

    fn delete_selected_gates(&mut self, ctx: &eframe::egui::Context) {
        if self.selected_gate_ids.is_empty() {
            return;
        }
        self.begin_circuit_commit();
        self.placed_gates
            .retain(|gate| !self.selected_gate_ids.contains(&gate.id));
        self.selected_gate_ids.clear();
        self.paste_anchor = None;
        self.compact_empty_steps();
        self.update_qubit_count();
        if self.commit_current_circuit(ctx) {
            self.gpu_plan.mark_dirty();
            self.clear_gpu_plan_capacity_error();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(id: u32, kind: GateKind, column: usize, wire: usize) -> PlacedGate {
        PlacedGate::new(
            GateId::from_u32(id),
            kind,
            CircuitColumnIndex::new(column),
            WireIndex::new(wire),
            GateSpan::SINGLE,
            None,
        )
    }

    fn capacity() -> QubitCapacity {
        QubitCapacity::local()
    }

    #[test]
    fn selecting_control_selects_its_controlled_structure() {
        let gates = vec![gate(1, GateKind::Control, 0, 0), gate(2, GateKind::X, 0, 2)];

        assert_eq!(
            connected_selection(&gates, &gates[0]),
            BTreeSet::from([GateId::from_u32(1), GateId::from_u32(2)])
        );
    }

    #[test]
    fn selecting_controlled_target_selects_its_control() {
        let gates = vec![gate(1, GateKind::Control, 0, 0), gate(2, GateKind::X, 0, 2)];

        assert_eq!(
            connected_selection(&gates, &gates[1]),
            BTreeSet::from([GateId::from_u32(1), GateId::from_u32(2)])
        );
    }

    #[test]
    fn selecting_swap_selects_exactly_one_swap_pair() {
        let gates = vec![gate(1, GateKind::Swap, 0, 0), gate(2, GateKind::Swap, 0, 2)];

        assert_eq!(
            connected_selection(&gates, &gates[0]),
            BTreeSet::from([GateId::from_u32(1), GateId::from_u32(2)])
        );
    }

    #[test]
    fn selecting_parallel_gate_does_not_select_unrelated_gate() {
        let gates = vec![gate(1, GateKind::H, 0, 0), gate(2, GateKind::X, 0, 1)];

        assert_eq!(
            connected_selection(&gates, &gates[0]),
            BTreeSet::from([GateId::from_u32(1)])
        );
    }

    #[test]
    fn wide_gate_anchors_paste_after_its_full_footprint() {
        let mut amplitude = gate(1, GateKind::AmplitudeDisplay, 3, 0);
        amplitude.span = GateSpan::try_new(2).unwrap();

        assert_eq!(
            selection_paste_anchor(&[amplitude], &BTreeSet::from([GateId::from_u32(1)])),
            Some(CircuitCell {
                column: CircuitColumnIndex::new(4),
                wire: WireIndex::ZERO,
            })
        );
    }

    #[test]
    fn empty_selection_has_no_fragment() {
        assert_eq!(CircuitFragment::from_selection(&[], &BTreeSet::new()), None);
    }

    #[test]
    fn fragment_preserves_gaps_between_selected_columns() {
        let gates = vec![gate(1, GateKind::H, 2, 1), gate(2, GateKind::X, 4, 2)];
        let fragment = CircuitFragment::from_selection(
            &gates,
            &BTreeSet::from([GateId::from_u32(1), GateId::from_u32(2)]),
        )
        .unwrap();

        assert_eq!(fragment.width, 3);
    }

    #[test]
    fn fragment_width_includes_wide_gate_footprint() {
        let mut amplitude = gate(1, GateKind::AmplitudeDisplay, 3, 0);
        amplitude.span = GateSpan::try_new(2).unwrap();
        let fragment =
            CircuitFragment::from_selection(&[amplitude], &BTreeSet::from([GateId::from_u32(1)]))
                .unwrap();

        assert_eq!(fragment.width, 2);
    }

    #[test]
    fn fragment_height_includes_gate_span() {
        let mut qft = gate(1, GateKind::QftGate, 0, 3);
        qft.span = GateSpan::try_new(4).unwrap();
        let fragment =
            CircuitFragment::from_selection(&[qft], &BTreeSet::from([GateId::from_u32(1)]))
                .unwrap();

        assert_eq!(fragment.height, 4);
    }

    #[test]
    fn fragment_normalizes_gate_coordinates() {
        let gates = vec![gate(1, GateKind::H, 2, 1), gate(2, GateKind::X, 4, 2)];
        let fragment = CircuitFragment::from_selection(
            &gates,
            &BTreeSet::from([GateId::from_u32(1), GateId::from_u32(2)]),
        )
        .unwrap();

        assert_eq!(
            fragment
                .gates
                .iter()
                .map(|gate| (gate.column_offset, gate.wire_offset))
                .collect::<Vec<_>>(),
            vec![(0, 0), (2, 1)]
        );
    }

    #[test]
    fn fragment_preserves_span_and_angle() {
        let angle = ParametricAngle::parse_qni("π/4").unwrap();
        let mut phase = gate(1, GateKind::Phase, 0, 0);
        phase.angle = Some(angle);
        let mut qft = gate(2, GateKind::QftGate, 1, 1);
        qft.span = GateSpan::try_new(2).unwrap();
        let fragment = CircuitFragment::from_selection(
            &[phase, qft],
            &BTreeSet::from([GateId::from_u32(1), GateId::from_u32(2)]),
        )
        .unwrap();

        assert_eq!(
            (fragment.gates[0].angle, fragment.gates[1].span),
            (Some(angle), GateSpan::try_new(2).unwrap())
        );
    }

    #[test]
    fn paste_inserts_fragment_and_shifts_trailing_gates() {
        let existing = vec![gate(1, GateKind::X, 1, 0)];
        let source = vec![gate(2, GateKind::H, 0, 0)];
        let fragment =
            CircuitFragment::from_selection(&source, &BTreeSet::from([GateId::from_u32(2)]))
                .unwrap();
        let mut ids = GateIdAllocator::new();
        let result = paste_fragment(
            &existing,
            &fragment,
            CircuitColumnIndex::new(1),
            WireIndex::ZERO,
            capacity(),
            &mut ids,
        )
        .unwrap();

        assert_eq!(
            result
                .iter()
                .map(|gate| (gate.kind, gate.column.as_usize()))
                .collect::<Vec<_>>(),
            vec![(GateKind::X, 2), (GateKind::H, 1)]
        );
    }

    #[test]
    fn pasted_gates_receive_fresh_identity() {
        let source = vec![gate(41, GateKind::H, 0, 0)];
        let fragment =
            CircuitFragment::from_selection(&source, &BTreeSet::from([GateId::from_u32(41)]))
                .unwrap();
        let mut ids = GateIdAllocator::new();
        let result = paste_fragment(
            &[],
            &fragment,
            CircuitColumnIndex::ZERO,
            WireIndex::ZERO,
            capacity(),
            &mut ids,
        )
        .unwrap();

        assert_ne!(result[0].id, GateId::from_u32(41));
    }

    #[test]
    fn paste_rejects_fragment_beyond_qubit_capacity() {
        let source = vec![gate(1, GateKind::H, 0, 0)];
        let fragment =
            CircuitFragment::from_selection(&source, &BTreeSet::from([GateId::from_u32(1)]))
                .unwrap();
        let mut ids = GateIdAllocator::new();
        let result = paste_fragment(
            &[],
            &fragment,
            CircuitColumnIndex::ZERO,
            WireIndex::new(capacity().get()),
            capacity(),
            &mut ids,
        );

        assert!(matches!(
            result,
            Err(PasteFragmentError::QubitCapacityExceeded)
        ));
    }

    #[test]
    fn paste_rejects_trailing_column_overflow() {
        let existing = vec![gate(1, GateKind::X, usize::MAX, 0)];
        let source = vec![gate(2, GateKind::H, 0, 0)];
        let fragment =
            CircuitFragment::from_selection(&source, &BTreeSet::from([GateId::from_u32(2)]))
                .unwrap();
        let mut ids = GateIdAllocator::new();
        let result = paste_fragment(
            &existing,
            &fragment,
            CircuitColumnIndex::ZERO,
            WireIndex::ZERO,
            capacity(),
            &mut ids,
        );

        assert!(matches!(result, Err(PasteFragmentError::ColumnOverflow)));
    }

    #[test]
    fn paste_rejects_insertion_inside_wide_gate() {
        let mut amplitude = gate(1, GateKind::AmplitudeDisplay, 0, 0);
        amplitude.span = GateSpan::try_new(2).unwrap();
        let source = vec![gate(2, GateKind::H, 0, 0)];
        let fragment =
            CircuitFragment::from_selection(&source, &BTreeSet::from([GateId::from_u32(2)]))
                .unwrap();
        let mut ids = GateIdAllocator::new();
        let result = paste_fragment(
            &[amplitude],
            &fragment,
            CircuitColumnIndex::new(1),
            WireIndex::ZERO,
            capacity(),
            &mut ids,
        );

        assert!(matches!(
            result,
            Err(PasteFragmentError::InsertionSplitsGate)
        ));
    }

    #[test]
    fn failed_paste_does_not_consume_gate_ids() {
        let source = vec![gate(1, GateKind::H, 0, 0)];
        let fragment =
            CircuitFragment::from_selection(&source, &BTreeSet::from([GateId::from_u32(1)]))
                .unwrap();
        let mut ids = GateIdAllocator::new();
        let _ = paste_fragment(
            &[],
            &fragment,
            CircuitColumnIndex::ZERO,
            WireIndex::new(capacity().get()),
            capacity(),
            &mut ids,
        );

        assert_eq!(ids.allocate(), GateId::from_u32(1));
    }
}
