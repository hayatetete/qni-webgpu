//! Circuit-domain model helpers extracted from `QniApp`.
//!
//! This module keeps qni's semantic step/dropzone idea explicit: committed
//! gates are addressed by `column` + `wire`; pixels are derived layout data or
//! drag previews, never the source of truth for URL / GPU planning.

use eframe::egui;
use std::collections::{BTreeSet, HashMap};

use crate::layout::gate_width_cols;

use crate::constants::{GATE_SIZE, LINE_GAP, LINE_LEFT_OFFSET, LINE_Y, MIN_QUBITS, SLOT_SPACING};
use crate::gates::{GateKind, GateSpan, ParametricAngle};
use crate::qubit_count::{QubitCapacity, QubitCount, QubitCountError};

use super::QniApp;

mod column_index;
pub(crate) use column_index::{CircuitColumnIndex, CircuitColumnIndexError};
mod gate_id;
pub(crate) use gate_id::{GateId, GateIdAllocator};
mod wire_index;
pub(crate) use wire_index::{WireIndex, WireIndexError};

#[derive(Clone, Debug)]
pub(crate) struct PlacedGate {
    pub(crate) id: GateId,
    pub(crate) kind: GateKind,
    /// Semantic circuit column (qni `CircuitStepElement` index). This is the
    /// authoritative horizontal model; `pos.x` is only the derived draw/drag
    /// preview coordinate.
    pub(crate) column: CircuitColumnIndex,
    /// Derived circuit-local draw position. During drag this follows the
    /// pointer as a preview; on committed placement it is resynchronised from
    /// `column` / `wire`.
    pub(crate) pos: egui::Pos2,
    pub(crate) wire: WireIndex,
    /// Vertical span in qubit wires. 1 for ordinary single-qubit gates;
    /// resizable-span gates (Probability, Amplitude, QFT / QFT†) can grow via hover-revealed
    /// resize handles.
    pub(crate) span: GateSpan,
    /// Angle value for parametric gates (`GateKind::Phase` / `Rx` / `Ry` / `Rz`).
    /// `Some` stores a qni-compatible, normalized value object. Palette-placed
    /// parametric gates store the explicit default `π/2` so the circuit can show
    /// the angle label immediately. `None` still represents a bare legacy token
    /// and is evaluated as the gate's default.
    pub(crate) angle: Option<ParametricAngle>,
}

impl PlacedGate {
    pub(crate) fn new(
        id: GateId,
        kind: GateKind,
        column: CircuitColumnIndex,
        wire: WireIndex,
        span: GateSpan,
        angle: Option<ParametricAngle>,
    ) -> Self {
        Self {
            id,
            kind,
            column,
            pos: Self::grid_pos(column, wire),
            wire,
            span,
            angle,
        }
    }

    pub(crate) fn grid_pos(column: CircuitColumnIndex, wire: WireIndex) -> egui::Pos2 {
        let slot_left = LINE_LEFT_OFFSET + GATE_SIZE;
        let slot_center_x = slot_left + SLOT_SPACING * column.as_usize() as f32;
        let line_y = LINE_Y + LINE_GAP * wire.as_usize() as f32;
        egui::pos2(slot_center_x - GATE_SIZE / 2.0, line_y - GATE_SIZE / 2.0)
    }

    pub(crate) fn sync_pos_from_grid(&mut self) {
        self.pos = Self::grid_pos(self.column, self.wire);
    }

    pub(crate) fn clamp_span_to_qubit_capacity(&mut self, capacity: QubitCapacity) {
        if !self.kind.is_resizable_span() {
            return;
        }
        let remaining_wires = capacity.get().saturating_sub(self.wire.as_usize()).max(1);
        self.span = self.span.clamped_for(self.kind, remaining_wires);
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct DragState {
    pub(crate) id: GateId,
    pub(crate) offset: egui::Vec2,
    /// Original semantic column for an existing gate. `None` means a palette
    /// gate that has no committed source column yet.
    pub(crate) original_column: Option<CircuitColumnIndex>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LiveDragSnap {
    Slot {
        column: CircuitColumnIndex,
        wire: WireIndex,
    },
    Insert {
        column: CircuitColumnIndex,
        wire: WireIndex,
    },
}

/// Which vertical edge of a span-resizable gate is being manipulated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SpanResizeEdge {
    Top,
    Bottom,
}

/// A concrete resizable-span handle under the pointer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SpanResizeHandle {
    pub(crate) gate_id: GateId,
    pub(crate) edge: SpanResizeEdge,
}

/// In-flight resize of a resizable-span gate's vertical span. Tracks which
/// handle was grabbed and the starting grid geometry so per-frame drag math
/// derives the new span from the *total* cursor delta.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SpanResizeDrag {
    pub(crate) gate_id: GateId,
    pub(crate) edge: SpanResizeEdge,
    pub(crate) start_pointer_y: f32,
    pub(crate) start_wire: usize,
    pub(crate) start_span: usize,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct AngleAffordance {
    pub(crate) gate_id: GateId,
    pub(crate) started_at: f64,
    pub(crate) open_editor_after_delay: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct AngleEditor {
    pub(crate) gate_id: GateId,
    pub(crate) draft: String,
    pub(crate) reveal_started_at: f64,
    pub(crate) select_all_pending: bool,
    pub(crate) commit_after_frame: bool,
}

impl QniApp {
    /// Minimum number of slot centers the layout must expose so every placed
    /// gate has a valid snap target. Passed to `layout_metrics` so the wire
    /// stretches all the way past the rightmost gate even when that gate sits
    /// beyond the canvas's natural right edge.
    ///
    /// Each gate's column is semantic state (qni's step index), not a value
    /// recovered from pixels. Reserve one extra trailing slot as a drop-target
    /// landing zone (mirrors qni's `appendMinimumSteps`).
    pub(super) fn min_circuit_slots(&self) -> usize {
        let placed_gate_slots = self
            .placed_gates
            .iter()
            .filter_map(|gate| {
                gate.column
                    .checked_add(gate_width_cols(gate.kind, gate.span.get()))
                    .and_then(|column| column.checked_add(1))
                    .map(CircuitColumnIndex::as_usize)
            })
            .max()
            .unwrap_or(0);
        let active_cell_slots = self
            .paste_preview()
            .and_then(|(cell, size)| cell.column.checked_add(1 + size.0))
            .map(CircuitColumnIndex::as_usize)
            .unwrap_or(0);

        placed_gate_slots.max(active_cell_slots)
    }

    fn raw_required_qubit_count(&self) -> usize {
        self.placed_gates
            .iter()
            .map(|gate| gate.wire.as_usize() + gate.span.get().saturating_sub(1) + 1)
            .max()
            .unwrap_or(0)
    }

    pub(super) fn required_qubit_count(&self) -> QubitCount {
        QubitCount::try_new(self.raw_required_qubit_count().max(1))
            .expect("required qubit count is clamped to at least one")
    }

    pub(crate) fn required_visible_wire_count(&self) -> usize {
        self.required_qubit_count().get().max(MIN_QUBITS)
    }

    pub(super) fn external_execution_qubits(&self) -> Result<QubitCount, QubitCountError> {
        QubitCount::try_for_capacity(
            self.raw_required_qubit_count().max(1),
            self.exec_mode.qubit_capacity(),
        )
    }

    pub(super) fn state_qubits(&self) -> QubitCount {
        let capacity = QubitCapacity::local();
        let qubits = self.raw_required_qubit_count().max(1).min(capacity.get());
        QubitCount::try_for_capacity(qubits, capacity)
            .expect("local state qubit count is clamped to local capacity")
    }

    pub(crate) fn update_qubit_count(&mut self) {
        self.qubit_count = self
            .required_visible_wire_count()
            .clamp(MIN_QUBITS, self.exec_mode.qubit_capacity().get());
    }

    /// After a successful drop or off-circuit removal, collapse empty columns
    /// and shift trailing gates left. Mirrors qni's
    /// `QuantumCircuitElement.removeEmptySteps()`.
    pub(crate) fn compact_empty_steps(&mut self) {
        if self.placed_gates.is_empty() {
            return;
        }
        let occupied: BTreeSet<usize> = self
            .placed_gates
            .iter()
            .flat_map(|gate| {
                let start = gate.column.as_usize();
                gate.column
                    .checked_add(gate_width_cols(gate.kind, gate.span.get()))
                    .into_iter()
                    .flat_map(move |end| start..end.as_usize())
            })
            .collect();
        let already_compact = occupied
            .iter()
            .enumerate()
            .all(|(new_i, &old_i)| new_i == old_i);
        if already_compact {
            return;
        }
        let mut remap: HashMap<usize, usize> = HashMap::with_capacity(occupied.len());
        for (new_i, &old_i) in occupied.iter().enumerate() {
            remap.insert(old_i, new_i);
        }
        for gate in &mut self.placed_gates {
            if let Some(&new_i) = remap.get(&gate.column.as_usize()) {
                gate.column = CircuitColumnIndex::new(new_i);
                gate.sync_pos_from_grid();
            }
        }
    }

    /// After a resizable gate changes horizontal footprint, move every gate
    /// that starts at or after the old right edge by the width delta so the
    /// grown display does not overlap later columns.
    pub(crate) fn shift_trailing_gates_after_width_change(
        &mut self,
        gate_id: GateId,
        column: CircuitColumnIndex,
        old_width: usize,
        new_width: usize,
    ) {
        if old_width == new_width {
            return;
        }
        let Some(boundary) = column
            .checked_add(old_width)
            .map(CircuitColumnIndex::as_usize)
        else {
            return;
        };
        if new_width > old_width {
            let delta = new_width - old_width;
            if self.placed_gates.iter().any(|gate| {
                gate.id != gate_id
                    && gate.column.as_usize() >= boundary
                    && gate.column.checked_add(delta).is_none()
            }) {
                return;
            }
            for gate in &mut self.placed_gates {
                if gate.id != gate_id && gate.column.as_usize() >= boundary {
                    let Some(column) = gate.column.checked_add(delta) else {
                        return;
                    };
                    gate.column = column;
                    gate.sync_pos_from_grid();
                }
            }
        } else {
            let delta = old_width - new_width;
            for gate in &mut self.placed_gates {
                if gate.id != gate_id && gate.column.as_usize() >= boundary {
                    gate.column = gate.column.saturating_sub(delta);
                    gate.sync_pos_from_grid();
                }
            }
        }
    }

    pub(crate) fn insert_gate_at_column(
        &mut self,
        gate_id: GateId,
        wire: WireIndex,
        insert_index: CircuitColumnIndex,
        original_column: Option<CircuitColumnIndex>,
    ) {
        let Some(gate_index) = self.placed_gates.iter().position(|gate| gate.id == gate_id) else {
            return;
        };

        let moving_width = gate_width_cols(
            self.placed_gates[gate_index].kind,
            self.placed_gates[gate_index].span.get(),
        );
        let mut adjusted_insert = insert_index;
        let remove_old_column = original_column.is_some_and(|old_column| {
            let old_column_still_occupied = self
                .placed_gates
                .iter()
                .any(|gate| gate.id != gate_id && gate.column == old_column);
            !old_column_still_occupied
        });
        if remove_old_column {
            if let Some(old_column) = original_column {
                if old_column < adjusted_insert {
                    adjusted_insert = adjusted_insert.saturating_sub(moving_width);
                }
            }
        }
        if self.placed_gates.iter().any(|gate| {
            gate.id != gate_id
                && gate.column >= adjusted_insert
                && gate.column.checked_add(moving_width).is_none()
        }) {
            return;
        }
        if remove_old_column {
            if let Some(old_column) = original_column {
                for gate in &mut self.placed_gates {
                    if gate.id != gate_id && gate.column > old_column {
                        gate.column = gate.column.saturating_sub(moving_width);
                    }
                }
            }
        }

        for gate in &mut self.placed_gates {
            if gate.id != gate_id && gate.column >= adjusted_insert {
                let Some(column) = gate.column.checked_add(moving_width) else {
                    return;
                };
                gate.column = column;
            }
        }

        let capacity = self.exec_mode.qubit_capacity();
        let gate = &mut self.placed_gates[gate_index];
        gate.column = adjusted_insert;
        gate.wire = wire;
        gate.clamp_span_to_qubit_capacity(capacity);

        for gate in &mut self.placed_gates {
            gate.sync_pos_from_grid();
        }
    }

    pub(super) fn state_count(&self) -> usize {
        self.state_qubits()
            .local_state_count()
            .expect("state_qubits always returns a local-capacity value")
    }
}
