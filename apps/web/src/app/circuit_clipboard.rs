//! Copy/paste domain model for circuit fragments.
//!
//! Clipboard data deliberately excludes entity identity and draw positions.
//! A paste allocates fresh gate ids and derives positions from semantic
//! column/wire coordinates, keeping this layer independent from egui and GPU
//! state.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use super::{CircuitColumnIndex, GateId, GateIdAllocator, PlacedGate, WireIndex};
use crate::constants::CIRCUIT_PADDING;
use crate::gates::{GateKind, GateSpan, ParametricAngle};
use crate::layout::{gate_visible_rect, gate_width_cols, layout_metrics};
use crate::qubit_count::QubitCapacity;
use crate::shared::now_seconds;

const COPY_FLASH_SECS: f64 = 0.18;
const PASTE_FLASH_SECS: f64 = 0.5;
const PASTE_REVEAL_DELAY_SECS: f64 = CIRCUIT_MOTION_SECS + 0.03;
const FLASH_OVERLAY_STRENGTH: f32 = 0.35;
const CIRCUIT_MOTION_SECS: f64 = 0.12;
const CIRCUIT_SCROLL_SECS: f64 = 0.18;
const PASTE_ERROR_HOLD_SECS: f64 = 3.5;
const PASTE_ERROR_FADE_SECS: f64 = 0.2;

#[derive(Clone, Debug)]
pub(crate) struct PasteErrorNotice {
    message: String,
    started_at: f64,
}

impl PasteErrorNotice {
    fn qubit_capacity_exceeded(capacity: QubitCapacity, started_at: f64) -> Self {
        Self {
            message: format!("Cannot paste beyond {} qubits.", capacity.get()),
            started_at,
        }
    }

    pub(crate) fn message(&self) -> &str {
        &self.message
    }

    pub(crate) fn opacity(&self, now: f64) -> f32 {
        let fade_elapsed = now - self.started_at - PASTE_ERROR_HOLD_SECS;
        if fade_elapsed <= 0.0 {
            1.0
        } else {
            (1.0 - fade_elapsed / PASTE_ERROR_FADE_SECS).clamp(0.0, 1.0) as f32
        }
    }

    pub(crate) fn remaining_hold(&self, now: f64) -> Option<Duration> {
        let remaining = self.started_at + PASTE_ERROR_HOLD_SECS - now;
        (remaining > 0.0).then(|| Duration::from_secs_f64(remaining))
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CircuitMotion {
    start_offsets_x: BTreeMap<GateId, f32>,
    started_at: f64,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct CircuitScrollMotion {
    from_x: f32,
    target_x: f32,
    started_at: f64,
}

impl CircuitScrollMotion {
    fn x(self, now: f64) -> f32 {
        let t = ((now - self.started_at) / CIRCUIT_SCROLL_SECS).clamp(0.0, 1.0) as f32;
        self.from_x + (self.target_x - self.from_x) * (1.0 - (1.0 - t).powi(3))
    }

    fn finished(self, now: f64) -> bool {
        now - self.started_at >= CIRCUIT_SCROLL_SECS
    }
}

fn circuit_scroll_target_x(
    current_x: f32,
    viewport_width: f32,
    content_right: f32,
    target_left: f32,
    target_right: f32,
) -> f32 {
    let viewport_right = current_x + viewport_width;
    let target_x = if target_left < current_x + CIRCUIT_PADDING {
        target_left - CIRCUIT_PADDING
    } else if target_right > viewport_right - CIRCUIT_PADDING {
        target_right - viewport_width + CIRCUIT_PADDING
    } else {
        current_x
    };
    target_x.clamp(
        0.0,
        (content_right + CIRCUIT_PADDING - viewport_width).max(0.0),
    )
}

impl CircuitMotion {
    fn between(
        before: &[PlacedGate],
        after: &[PlacedGate],
        previous: Option<&Self>,
        started_at: f64,
    ) -> Option<Self> {
        let before_x = before
            .iter()
            .map(|gate| {
                let visible_x = gate.pos.x
                    + previous
                        .and_then(|motion| motion.offset_x(gate.id, started_at))
                        .unwrap_or_default();
                (gate.id, visible_x)
            })
            .collect::<BTreeMap<_, _>>();
        let start_offsets_x = after
            .iter()
            .filter_map(|gate| {
                let offset = before_x.get(&gate.id)? - gate.pos.x;
                (offset.abs() > f32::EPSILON).then_some((gate.id, offset))
            })
            .collect::<BTreeMap<_, _>>();
        (!start_offsets_x.is_empty()).then_some(Self {
            start_offsets_x,
            started_at,
        })
    }

    pub(crate) fn offset_x(&self, gate_id: GateId, now: f64) -> Option<f32> {
        let elapsed = (now - self.started_at).max(0.0);
        if elapsed >= CIRCUIT_MOTION_SECS {
            return None;
        }
        let start = *self.start_offsets_x.get(&gate_id)?;
        let t = (elapsed / CIRCUIT_MOTION_SECS) as f32;
        Some(start * (1.0 - t).powi(3))
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CopyFlash {
    gate_ids: BTreeSet<GateId>,
    started_at: f64,
}

impl CopyFlash {
    pub(crate) fn strength(&self, gate_id: GateId, now: f64) -> Option<f32> {
        if !self.gate_ids.contains(&gate_id) {
            return None;
        }
        let elapsed = (now - self.started_at).max(0.0);
        (elapsed < COPY_FLASH_SECS).then_some(1.0 - (elapsed / COPY_FLASH_SECS) as f32)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PasteFlash {
    gate_ids: BTreeSet<GateId>,
    started_at: f64,
}

impl PasteFlash {
    pub(crate) fn is_active(&self, now: f64) -> bool {
        now - self.started_at < PASTE_REVEAL_DELAY_SECS + PASTE_FLASH_SECS
    }

    pub(crate) fn hides(&self, gate_id: GateId, now: f64) -> bool {
        self.gate_ids.contains(&gate_id) && now - self.started_at < PASTE_REVEAL_DELAY_SECS
    }

    pub(crate) fn strength(&self, gate_id: GateId, now: f64) -> Option<f32> {
        self.strength_for_gate_ids([gate_id], now)
    }

    pub(crate) fn strength_for_gate_ids(
        &self,
        gate_ids: impl IntoIterator<Item = GateId>,
        now: f64,
    ) -> Option<f32> {
        let applies = gate_ids.into_iter().any(|id| self.gate_ids.contains(&id));
        let elapsed = now - self.started_at - PASTE_REVEAL_DELAY_SECS;
        (applies && (0.0..PASTE_FLASH_SECS).contains(&elapsed))
            .then_some(FLASH_OVERLAY_STRENGTH * (1.0 - (elapsed / PASTE_FLASH_SECS) as f32))
    }
}

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
        let min_wire = selected.iter().map(|gate| gate.wire.as_usize()).min()?;
        let selected_ranges = selected
            .iter()
            .map(|gate| {
                let start = gate.column.as_usize();
                let end = start.checked_add(gate_width_cols(gate.kind, gate.span.get()))?;
                Some(start..end)
            })
            .collect::<Option<Vec<_>>>()?;
        let occupied_columns = selected_ranges
            .into_iter()
            .flatten()
            .collect::<BTreeSet<_>>();
        let column_offsets = occupied_columns
            .iter()
            .enumerate()
            .map(|(offset, column)| (*column, offset))
            .collect::<std::collections::BTreeMap<_, _>>();
        let max_wire_end = selected
            .iter()
            .map(|gate| gate.wire.as_usize().checked_add(gate.span.get()))
            .collect::<Option<Vec<_>>>()?
            .into_iter()
            .max()?;
        let width = occupied_columns.len();
        let height = max_wire_end.checked_sub(min_wire)?;
        let gates = selected
            .into_iter()
            .map(|gate| ClipboardGate {
                kind: gate.kind,
                column_offset: column_offsets[&gate.column.as_usize()],
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

pub(crate) fn gate_frame_group(placed_gates: &[PlacedGate], gate_id: GateId) -> BTreeSet<GateId> {
    placed_gates
        .iter()
        .find(|gate| gate.id == gate_id)
        .map(|gate| connected_selection(placed_gates, gate))
        .unwrap_or_default()
}

pub(crate) fn selection_frame_groups(
    placed_gates: &[PlacedGate],
    selected_gate_ids: &BTreeSet<GateId>,
) -> Vec<BTreeSet<GateId>> {
    let mut remaining = selected_gate_ids.clone();
    let mut groups = Vec::new();
    for gate in placed_gates {
        if !remaining.remove(&gate.id) {
            continue;
        }
        let connected = connected_selection(placed_gates, gate);
        let group = if connected.len() > 1 && connected.is_subset(selected_gate_ids) {
            connected
        } else {
            BTreeSet::from([gate.id])
        };
        for gate_id in &group {
            remaining.remove(gate_id);
        }
        groups.push(group);
    }
    groups
}

fn individually_selected(
    placed_gates: &[PlacedGate],
    gate_id: GateId,
    mut selection: BTreeSet<GateId>,
) -> BTreeSet<GateId> {
    let Some(gate) = placed_gates.iter().find(|gate| gate.id == gate_id) else {
        return selection;
    };
    for connected_id in connected_selection(placed_gates, gate) {
        selection.remove(&connected_id);
    }
    selection.insert(gate_id);
    selection
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

fn copied_selection(
    placed_gates: &[PlacedGate],
    selected_gate_ids: &BTreeSet<GateId>,
    started_at: f64,
) -> Option<(CircuitFragment, CircuitCell, CopyFlash)> {
    let fragment = CircuitFragment::from_selection(placed_gates, selected_gate_ids)?;
    let anchor = selection_paste_anchor(placed_gates, selected_gate_ids)?;
    let flash = CopyFlash {
        gate_ids: selected_gate_ids.clone(),
        started_at,
    };
    Some((fragment, anchor, flash))
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
    pub(crate) fn paste_gate_hidden(&self, gate_id: GateId, now: f64) -> bool {
        self.paste_flashes
            .iter()
            .any(|flash| flash.hides(gate_id, now))
    }

    pub(crate) fn circuit_motion_offset_x(&self, gate_id: GateId, now: f64) -> Option<f32> {
        self.circuit_motion
            .as_ref()
            .and_then(|motion| motion.offset_x(gate_id, now))
    }

    pub(crate) fn update_circuit_scroll_motion(&mut self, ctx: &eframe::egui::Context) {
        let Some(motion) = self.circuit_scroll_motion else {
            return;
        };
        let now = now_seconds();
        self.circuit_scroll_x = motion.x(now);
        if motion.finished(now) {
            self.circuit_scroll_motion = None;
        } else {
            ctx.request_repaint();
        }
    }

    pub(crate) fn paste_preview(&self) -> Option<(CircuitCell, (usize, usize))> {
        let cell = self.active_cell?;
        let fragment = self.circuit_clipboard.as_ref()?;
        Some((cell, (fragment.width, fragment.height)))
    }

    pub(crate) fn select_gate_for_copy(&mut self, gate_id: GateId) {
        let Some(gate) = self.placed_gates.iter().find(|gate| gate.id == gate_id) else {
            return;
        };
        self.selected_gate_ids = connected_selection(&self.placed_gates, gate);
        self.active_cell = Some(CircuitCell {
            column: gate.column,
            wire: gate.wire,
        });
    }

    pub(crate) fn select_empty_cell(&mut self, cell: CircuitCell) {
        self.active_cell = Some(cell);
    }

    pub(crate) fn add_gate_to_copy_selection(&mut self, gate_id: GateId) {
        let Some(gate) = self.placed_gates.iter().find(|gate| gate.id == gate_id) else {
            return;
        };
        self.selected_gate_ids
            .extend(connected_selection(&self.placed_gates, gate));
        self.active_cell = Some(CircuitCell {
            column: gate.column,
            wire: gate.wire,
        });
    }

    pub(crate) fn select_gate_individually(
        &mut self,
        gate_id: GateId,
        selection: BTreeSet<GateId>,
    ) {
        let Some(gate) = self.placed_gates.iter().find(|gate| gate.id == gate_id) else {
            return;
        };
        self.selected_gate_ids = individually_selected(&self.placed_gates, gate_id, selection);
        self.active_cell = Some(CircuitCell {
            column: gate.column,
            wire: gate.wire,
        });
    }

    pub(crate) fn handle_circuit_edit_shortcuts(&mut self, ctx: &eframe::egui::Context) {
        if ctx.wants_keyboard_input()
            || self.library.active_locked()
            || self.shortcut_help_open
            || self.picker.is_open()
        {
            return;
        }
        let (select_all, copy, cut, paste, undo, redo, delete, escape) = ctx.input_mut(|input| {
            let command = eframe::egui::Modifiers::COMMAND;
            let command_shift = eframe::egui::Modifiers {
                command: true,
                shift: true,
                ..Default::default()
            };
            let redo = input.consume_key(command_shift, eframe::egui::Key::Z)
                || input.consume_key(command, eframe::egui::Key::Y);
            (
                input.consume_key(command, eframe::egui::Key::A),
                input.consume_key(command, eframe::egui::Key::C),
                input.consume_key(command, eframe::egui::Key::X),
                input.consume_key(command, eframe::egui::Key::V),
                input.consume_key(command, eframe::egui::Key::Z),
                redo,
                input.consume_key(eframe::egui::Modifiers::NONE, eframe::egui::Key::Delete)
                    || input
                        .consume_key(eframe::egui::Modifiers::NONE, eframe::egui::Key::Backspace),
                input.consume_key(eframe::egui::Modifiers::NONE, eframe::egui::Key::Escape),
            )
        });
        if escape {
            self.selected_gate_ids.clear();
            self.active_cell = None;
            self.copy_flash = None;
            self.selection_drag = None;
            self.gate_click_selection = None;
            ctx.request_repaint();
            return;
        }
        if select_all {
            self.select_all_gates();
        }
        if copy {
            self.copy_selected_gates(ctx);
        }
        if cut {
            self.copy_selected_gates(ctx);
            self.delete_selected_gates(ctx, true);
        }
        if paste {
            self.paste_copied_gates(ctx);
        }
        if undo {
            self.undo_circuit(ctx);
        }
        if redo {
            self.redo_circuit(ctx);
        }
        if delete {
            self.delete_selected_gates(ctx, false);
        }
    }

    fn copy_selected_gates(&mut self, ctx: &eframe::egui::Context) {
        let Some((fragment, anchor, flash)) =
            copied_selection(&self.placed_gates, &self.selected_gate_ids, now_seconds())
        else {
            return;
        };
        self.circuit_clipboard = Some(fragment);
        self.active_cell = Some(anchor);
        self.copy_flash = Some(flash);
        ctx.request_repaint();
        ctx.request_repaint_after(Duration::from_secs_f64(COPY_FLASH_SECS));
    }

    fn select_all_gates(&mut self) {
        self.selected_gate_ids = self.placed_gates.iter().map(|gate| gate.id).collect();
        self.active_cell = selection_paste_anchor(&self.placed_gates, &self.selected_gate_ids);
    }

    fn paste_copied_gates(&mut self, ctx: &eframe::egui::Context) {
        if self.library.active_locked() {
            return;
        }
        let (Some(fragment), Some(anchor)) = (&self.circuit_clipboard, self.active_cell) else {
            return;
        };
        let Some(insert_column) = anchor.column.checked_add(1) else {
            return;
        };
        let capacity = self.exec_mode.qubit_capacity();
        let next_gates = match paste_fragment(
            &self.placed_gates,
            fragment,
            insert_column,
            anchor.wire,
            capacity,
            &mut self.gate_ids,
        ) {
            Ok(gates) => gates,
            Err(PasteFragmentError::QubitCapacityExceeded) => {
                self.paste_error_notice = Some(PasteErrorNotice::qubit_capacity_exceeded(
                    capacity,
                    now_seconds(),
                ));
                ctx.request_repaint();
                ctx.request_repaint_after(Duration::from_secs_f64(PASTE_ERROR_HOLD_SECS));
                return;
            }
            Err(PasteFragmentError::ColumnOverflow | PasteFragmentError::InsertionSplitsGate) => {
                return;
            }
        };
        let pasted_gate_ids = next_gates[self.placed_gates.len()..]
            .iter()
            .map(|gate| gate.id)
            .collect::<BTreeSet<_>>();

        let now = now_seconds();
        let motion = CircuitMotion::between(
            &self.placed_gates,
            &next_gates,
            self.circuit_motion.as_ref(),
            now,
        );
        self.begin_circuit_commit();
        self.placed_gates = next_gates;
        self.circuit_motion = motion;
        self.start_paste_scroll(&pasted_gate_ids, ctx);
        self.paste_flashes.retain(|flash| flash.is_active(now));
        self.paste_flashes.push(PasteFlash {
            gate_ids: pasted_gate_ids,
            started_at: now,
        });
        ctx.request_repaint();
        ctx.request_repaint_after(Duration::from_secs_f64(
            PASTE_REVEAL_DELAY_SECS + PASTE_FLASH_SECS,
        ));
        self.update_qubit_count();
        if self.commit_current_circuit(ctx) {
            self.gpu_plan.mark_dirty();
            self.clear_gpu_plan_capacity_error();
        }
    }

    fn start_paste_scroll(
        &mut self,
        pasted_gate_ids: &BTreeSet<GateId>,
        ctx: &eframe::egui::Context,
    ) {
        let viewport_width = ctx.content_rect().width();
        let metrics = layout_metrics(
            viewport_width,
            self.layout_qubits(),
            self.min_circuit_slots(),
        );
        let pasted_rect = self
            .placed_gates
            .iter()
            .filter(|gate| pasted_gate_ids.contains(&gate.id))
            .map(|gate| gate_visible_rect(gate, gate.pos))
            .reduce(|left, right| left.union(right));
        let Some(pasted_rect) = pasted_rect else {
            return;
        };
        let target_x = circuit_scroll_target_x(
            self.circuit_scroll_x,
            viewport_width,
            metrics.line_right,
            pasted_rect.left(),
            pasted_rect.right(),
        );
        if (target_x - self.circuit_scroll_x).abs() > f32::EPSILON {
            self.circuit_scroll_motion = Some(CircuitScrollMotion {
                from_x: self.circuit_scroll_x,
                target_x,
                started_at: now_seconds(),
            });
            ctx.request_repaint();
        }
    }

    fn delete_selected_gates(&mut self, ctx: &eframe::egui::Context, animate_compaction: bool) {
        if self.library.active_locked() || self.selected_gate_ids.is_empty() {
            return;
        }
        let before = animate_compaction.then(|| self.placed_gates.clone());
        self.begin_circuit_commit();
        self.placed_gates
            .retain(|gate| !self.selected_gate_ids.contains(&gate.id));
        self.selected_gate_ids.clear();
        self.active_cell = None;
        self.compact_empty_steps();
        self.circuit_motion = before.as_deref().and_then(|before| {
            CircuitMotion::between(
                before,
                &self.placed_gates,
                self.circuit_motion.as_ref(),
                now_seconds(),
            )
        });
        if self.circuit_motion.is_some() {
            ctx.request_repaint();
            ctx.request_repaint_after(Duration::from_secs_f64(CIRCUIT_MOTION_SECS));
        }
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

    #[test]
    fn copy_flash_fades_from_full_strength() {
        let flash = CopyFlash {
            gate_ids: BTreeSet::from([GateId::from_u32(1)]),
            started_at: 10.0,
        };

        assert_eq!(flash.strength(GateId::from_u32(1), 10.0), Some(1.0));
    }

    #[test]
    fn circuit_motion_starts_at_the_previous_position() {
        let before = vec![gate(1, GateKind::H, 2, 0)];
        let after = vec![gate(1, GateKind::H, 1, 0)];
        let motion = CircuitMotion::between(&before, &after, None, 10.0).unwrap();

        assert_eq!(
            motion.offset_x(GateId::from_u32(1), 10.0),
            Some(before[0].pos.x - after[0].pos.x)
        );
    }

    #[test]
    fn circuit_motion_preserves_the_previous_visible_position() {
        let first_before = vec![gate(1, GateKind::H, 0, 0)];
        let first_after = vec![gate(1, GateKind::H, 1, 0)];
        let first = CircuitMotion::between(&first_before, &first_after, None, 10.0).unwrap();
        let second_after = vec![gate(1, GateKind::H, 2, 0)];
        let second =
            CircuitMotion::between(&first_after, &second_after, Some(&first), 10.06).unwrap();
        let visible_before =
            first_after[0].pos.x + first.offset_x(GateId::from_u32(1), 10.06).unwrap();

        assert_eq!(
            second_after[0].pos.x + second.offset_x(GateId::from_u32(1), 10.06).unwrap(),
            visible_before
        );
    }

    #[test]
    fn circuit_motion_finishes_after_one_hundred_twenty_milliseconds() {
        let before = vec![gate(1, GateKind::H, 2, 0)];
        let after = vec![gate(1, GateKind::H, 1, 0)];
        let motion = CircuitMotion::between(&before, &after, None, 10.0).unwrap();

        assert_eq!(
            motion.offset_x(GateId::from_u32(1), 10.0 + CIRCUIT_MOTION_SECS + 1.0e-9,),
            None
        );
    }

    #[test]
    fn circuit_scroll_motion_interpolates_between_endpoints() {
        let motion = CircuitScrollMotion {
            from_x: 20.0,
            target_x: 100.0,
            started_at: 10.0,
        };

        assert!((20.0..100.0).contains(&motion.x(10.0 + CIRCUIT_SCROLL_SECS / 2.0)));
    }

    #[test]
    fn circuit_scroll_motion_finishes_at_target() {
        let motion = CircuitScrollMotion {
            from_x: 20.0,
            target_x: 100.0,
            started_at: 10.0,
        };

        assert_eq!(motion.x(10.0 + CIRCUIT_SCROLL_SECS), 100.0);
    }

    #[test]
    fn circuit_scroll_reveals_target_beyond_viewport_right_edge() {
        assert_eq!(
            circuit_scroll_target_x(0.0, 200.0, 400.0, 240.0, 280.0),
            80.0 + CIRCUIT_PADDING
        );
    }

    #[test]
    fn copied_selection_starts_flash_for_the_selected_gate() {
        let gates = vec![gate(1, GateKind::H, 0, 0)];
        let (_, _, flash) =
            copied_selection(&gates, &BTreeSet::from([GateId::from_u32(1)]), 10.0).unwrap();

        assert_eq!(flash.strength(GateId::from_u32(1), 10.0), Some(1.0));
    }

    #[test]
    fn copy_flash_ignores_gates_outside_the_copy() {
        let flash = CopyFlash {
            gate_ids: BTreeSet::from([GateId::from_u32(1)]),
            started_at: 10.0,
        };

        assert_eq!(flash.strength(GateId::from_u32(2), 10.0), None);
    }

    #[test]
    fn copy_flash_ends_after_its_duration() {
        let flash = CopyFlash {
            gate_ids: BTreeSet::from([GateId::from_u32(1)]),
            started_at: 10.0,
        };

        assert_eq!(
            flash.strength(GateId::from_u32(1), 10.0 + COPY_FLASH_SECS + 0.001),
            None
        );
    }

    #[test]
    fn paste_flash_starts_at_thirty_five_percent() {
        let flash = PasteFlash {
            gate_ids: BTreeSet::from([GateId::from_u32(1)]),
            started_at: 10.0,
        };

        assert_eq!(
            flash.strength(GateId::from_u32(1), 10.0 + PASTE_REVEAL_DELAY_SECS),
            Some(0.35)
        );
    }

    #[test]
    fn paste_flash_ends_after_half_a_second() {
        let flash = PasteFlash {
            gate_ids: BTreeSet::from([GateId::from_u32(1)]),
            started_at: 10.0,
        };

        assert_eq!(
            flash.strength(
                GateId::from_u32(1),
                10.0 + PASTE_REVEAL_DELAY_SECS + PASTE_FLASH_SECS
            ),
            None
        );
    }

    #[test]
    fn paste_flash_applies_when_connector_contains_a_pasted_gate() {
        let flash = PasteFlash {
            gate_ids: BTreeSet::from([GateId::from_u32(2)]),
            started_at: 10.0,
        };

        assert_eq!(
            flash.strength_for_gate_ids(
                [GateId::from_u32(1), GateId::from_u32(2)],
                10.0 + PASTE_REVEAL_DELAY_SECS
            ),
            Some(0.35)
        );
    }

    #[test]
    fn paste_flash_ignores_connector_without_a_pasted_gate() {
        let flash = PasteFlash {
            gate_ids: BTreeSet::from([GateId::from_u32(3)]),
            started_at: 10.0,
        };

        assert_eq!(
            flash.strength_for_gate_ids([GateId::from_u32(1), GateId::from_u32(2)], 10.0),
            None
        );
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
    fn controlled_gate_selection_uses_one_frame_group() {
        let gates = vec![
            gate(1, GateKind::Control, 0, 0),
            gate(2, GateKind::Control, 0, 1),
            gate(3, GateKind::X, 0, 2),
        ];
        let selected = BTreeSet::from([
            GateId::from_u32(1),
            GateId::from_u32(2),
            GateId::from_u32(3),
        ]);

        assert_eq!(selection_frame_groups(&gates, &selected), vec![selected]);
    }

    #[test]
    fn individually_selected_control_keeps_one_gate_frame() {
        let gates = vec![gate(1, GateKind::Control, 0, 0), gate(2, GateKind::X, 0, 1)];
        let selected = BTreeSet::from([GateId::from_u32(1)]);

        assert_eq!(selection_frame_groups(&gates, &selected), vec![selected]);
    }

    #[test]
    fn individual_control_selection_preserves_unrelated_selection() {
        let gates = vec![
            gate(1, GateKind::H, 0, 3),
            gate(2, GateKind::Control, 1, 0),
            gate(3, GateKind::X, 1, 1),
        ];
        let selected = BTreeSet::from([
            GateId::from_u32(1),
            GateId::from_u32(2),
            GateId::from_u32(3),
        ]);

        assert_eq!(
            individually_selected(&gates, GateId::from_u32(2), selected),
            BTreeSet::from([GateId::from_u32(1), GateId::from_u32(2)])
        );
    }

    #[test]
    fn swap_selection_uses_one_frame_group() {
        let gates = vec![gate(1, GateKind::Swap, 0, 0), gate(2, GateKind::Swap, 0, 2)];
        let selected = BTreeSet::from([GateId::from_u32(1), GateId::from_u32(2)]);

        assert_eq!(selection_frame_groups(&gates, &selected), vec![selected]);
    }

    #[test]
    fn unrelated_selected_gates_keep_individual_frame_groups() {
        let gates = vec![gate(1, GateKind::H, 0, 0), gate(2, GateKind::X, 1, 1)];
        let selected = BTreeSet::from([GateId::from_u32(1), GateId::from_u32(2)]);

        assert_eq!(
            selection_frame_groups(&gates, &selected),
            vec![
                BTreeSet::from([GateId::from_u32(1)]),
                BTreeSet::from([GateId::from_u32(2)])
            ]
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
    fn fragment_removes_gaps_between_selected_columns() {
        let gates = vec![gate(1, GateKind::H, 2, 1), gate(2, GateKind::X, 4, 2)];
        let fragment = CircuitFragment::from_selection(
            &gates,
            &BTreeSet::from([GateId::from_u32(1), GateId::from_u32(2)]),
        )
        .unwrap();

        assert_eq!(fragment.width, 2);
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
            vec![(0, 0), (1, 1)]
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
