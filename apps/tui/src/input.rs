use crossterm::event;
use ratatui::layout::Rect;

use crate::layout::{
    circuit_layout, display_index_to_state_index, hit_test_circuit_slot, hit_test_palette,
    hovered_column_at, hovered_start_at, is_empty_drop, layout_regions, state_circle_layout,
};
use crate::model::{
    default_phase_value, display_qubits, ensure_slots, parse_phase_label, qubit_count, AppState,
    DragOrigin, DragState, Gate, PhaseEdit,
};
use crate::{GATE_BOX_WIDTH, MAX_QUBIT_COUNT, MIN_QUBIT_COUNT, SLOT_GAP, SNAP_DISTANCE};

fn add_empty_qubit_row(state: &mut AppState) {
    if state.placed.len() >= MAX_QUBIT_COUNT {
        return;
    }
    state.placed.push(Vec::new());
    state.phase_values.push(Vec::new());
}

fn compact_empty_columns(state: &mut AppState) {
    let max_len = state.placed.iter().map(|row| row.len()).max().unwrap_or(0);
    if max_len == 0 {
        return;
    }

    let mut new_rows = vec![Vec::new(); state.placed.len()];
    let mut new_phase_rows = vec![Vec::new(); state.phase_values.len()];
    for col in 0..max_len {
        let mut has_gate = false;
        for row in &state.placed {
            if row.get(col).and_then(|gate| *gate).is_some() {
                has_gate = true;
                break;
            }
        }
        if !has_gate {
            continue;
        }
        for (row_index, row) in state.placed.iter().enumerate() {
            let value = row.get(col).and_then(|gate| *gate);
            new_rows[row_index].push(value);
            let phase_value = state
                .phase_values
                .get(row_index)
                .and_then(|row_values| row_values.get(col))
                .and_then(|value| value.clone());
            new_phase_rows[row_index].push(phase_value);
        }
    }
    state.placed = new_rows;
    state.phase_values = new_phase_rows;
}

fn trim_trailing_empty_qubits(state: &mut AppState) {
    while state.placed.len() > MIN_QUBIT_COUNT {
        let remove = state
            .placed
            .last()
            .map(|row| row.iter().all(|gate| gate.is_none()))
            .unwrap_or(false);
        if remove {
            state.placed.pop();
            state.phase_values.pop();
        } else {
            break;
        }
    }
}

fn insertion_target(state: &AppState, x: u16, y: u16, area: Rect) -> Option<(usize, usize)> {
    let layout = circuit_layout(area, qubit_count(state));
    let mut best: Option<(usize, usize, u16)> = None;
    for (row, row_slots) in layout.slots.iter().enumerate() {
        if let Some(first) = row_slots.first() {
            let gap = Rect {
                x: layout.wire_start_x,
                y: first.y,
                width: first.x.saturating_sub(layout.wire_start_x),
                height: first.height,
            };
            let first_gate = state
                .placed
                .get(row)
                .and_then(|row_gates| row_gates.first())
                .and_then(|value| *value);
            if first_gate.is_some() && gap.width > 0 {
                let dx = if x < gap.x {
                    gap.x - x
                } else if x >= gap.x.saturating_add(gap.width) {
                    x - gap.x.saturating_add(gap.width - 1)
                } else {
                    0
                };
                let dy = if y < gap.y {
                    gap.y - y
                } else if y >= gap.y.saturating_add(gap.height) {
                    y - gap.y.saturating_add(gap.height - 1)
                } else {
                    0
                };
                let dist = dx.saturating_add(dy);
                if dist <= SNAP_DISTANCE && best.is_none_or(|(_, _, best_dist)| dist < best_dist) {
                    best = Some((row, 0, dist));
                }
            }
        }
        let last_index = row_slots.len().saturating_sub(1);
        for (index, left) in row_slots.iter().copied().enumerate().take(last_index) {
            let gap_x = left.x.saturating_add(GATE_BOX_WIDTH);
            let gap = Rect {
                x: gap_x,
                y: left.y,
                width: SLOT_GAP,
                height: left.height,
            };
            let left_gate = state
                .placed
                .get(row)
                .and_then(|row_gates| row_gates.get(index))
                .and_then(|value| *value);
            let right_gate = state
                .placed
                .get(row)
                .and_then(|row_gates| row_gates.get(index + 1))
                .and_then(|value| *value);
            if left_gate.is_none() || right_gate.is_none() {
                continue;
            }
            let dx = if x < gap.x {
                gap.x - x
            } else if x >= gap.x.saturating_add(gap.width) {
                x - gap.x.saturating_add(gap.width - 1)
            } else {
                0
            };
            let dy = if y < gap.y {
                gap.y - y
            } else if y >= gap.y.saturating_add(gap.height) {
                y - gap.y.saturating_add(gap.height - 1)
            } else {
                0
            };
            let dist = dx.saturating_add(dy);
            if dist > SNAP_DISTANCE {
                continue;
            }
            if best.is_none_or(|(_, _, best_dist)| dist < best_dist) {
                best = Some((row, index + 1, dist));
            }
        }
    }
    best.map(|(row, index, _)| (row, index))
}

pub fn handle_mouse_down(state: &mut AppState, x: u16, y: u16, area: Rect) {
    if let Some((row, slot)) = hit_test_phase_label(state, x, y, area) {
        let label = state
            .phase_values
            .get(row)
            .and_then(|row_values| row_values.get(slot))
            .and_then(|value| value.as_ref())
            .map(|value| value.label.clone())
            .unwrap_or_else(|| default_phase_value().label);
        state.phase_edit = Some(PhaseEdit {
            row,
            slot,
            input: label,
        });
        state.phase_edit_error = None;
        return;
    }
    if state.phase_edit.is_some() {
        state.phase_edit = None;
        state.phase_edit_error = None;
    }
    if let Some(gate) = hit_test_palette(x, y, area) {
        state.dragging = Some(DragState {
            gate,
            origin: DragOrigin::Palette,
        });
        state.drag_pos = Some((x, y));
        state.drag_phase_value = if matches!(gate, Gate::Phase | Gate::Rx | Gate::Ry | Gate::Rz) {
            Some(default_phase_value())
        } else {
            None
        };
        state.hovered_insert = None;
        state.hovered_column = None;
        state.hovered_start = false;
        add_empty_qubit_row(state);
        return;
    }

    let layout = circuit_layout(area, qubit_count(state));
    let counts: Vec<usize> = layout
        .slots
        .iter()
        .map(|row_slots| row_slots.len())
        .collect();
    ensure_slots(state, &counts);
    if let Some((row, slot)) = hit_test_circuit_slot(x, y, area, qubit_count(state)) {
        if let Some(gate) = state
            .placed
            .get(row)
            .and_then(|row_slots| row_slots.get(slot))
            .and_then(|value| *value)
        {
            state.dragging = Some(DragState {
                gate,
                origin: DragOrigin::Circuit,
            });
            state.drag_pos = Some((x, y));
            state.placed[row][slot] = None;
            state.drag_phase_value = state
                .phase_values
                .get(row)
                .and_then(|row_values| row_values.get(slot))
                .and_then(|value| value.clone());
            if let Some(row_values) = state.phase_values.get_mut(row) {
                if let Some(value) = row_values.get_mut(slot) {
                    *value = None;
                }
            }
            state.cache_valid = false;
            state.cached_full_valid = false;
            state.hovered_insert = None;
            state.hovered_column = None;
            state.hovered_start = false;
            add_empty_qubit_row(state);
        }
    }
}

pub fn handle_mouse_move(state: &mut AppState, x: u16, y: u16) {
    if state.dragging.is_some() {
        state.drag_pos = Some((x, y));
    }
}

pub fn handle_mouse_up(state: &mut AppState, x: u16, y: u16, area: Rect) {
    let Some(dragging) = state.dragging else {
        return;
    };
    let mut changed = false;

    let layout = circuit_layout(area, qubit_count(state));
    let counts: Vec<usize> = layout
        .slots
        .iter()
        .map(|row_slots| row_slots.len())
        .collect();
    ensure_slots(state, &counts);
    if let Some((row, index)) = state
        .hovered_insert
        .or_else(|| insertion_target(state, x, y, area))
    {
        for row_slots in &mut state.placed {
            let insert_at = index.min(row_slots.len());
            row_slots.insert(insert_at, None);
        }
        for row_values in &mut state.phase_values {
            let insert_at = index.min(row_values.len());
            row_values.insert(insert_at, None);
        }
        state.placed[row][index] = Some(dragging.gate);
        if let Some(row_values) = state.phase_values.get_mut(row) {
            if let Some(value) = row_values.get_mut(index) {
                if matches!(dragging.gate, Gate::Phase | Gate::Rx | Gate::Ry | Gate::Rz) {
                    *value = state
                        .drag_phase_value
                        .clone()
                        .or_else(|| Some(default_phase_value()));
                } else {
                    *value = None;
                }
            }
        }
        changed = true;
    } else if let Some((row, slot)) = state
        .hovered_row
        .zip(state.hovered_slot)
        .or_else(|| hit_test_circuit_slot(x, y, area, qubit_count(state)))
    {
        state.placed[row][slot] = Some(dragging.gate);
        if let Some(row_values) = state.phase_values.get_mut(row) {
            if let Some(value) = row_values.get_mut(slot) {
                if matches!(dragging.gate, Gate::Phase | Gate::Rx | Gate::Ry | Gate::Rz) {
                    *value = state
                        .drag_phase_value
                        .clone()
                        .or_else(|| Some(default_phase_value()));
                } else {
                    *value = None;
                }
            }
        }
        changed = true;
    } else if is_empty_drop(x, y, area, qubit_count(state))
        && dragging.origin == DragOrigin::Circuit
    {
        // already cleared on drag start
        changed = true;
    }

    state.dragging = None;
    state.drag_pos = None;
    state.drag_phase_value = None;
    state.hovered_slot = None;
    state.hovered_row = None;
    state.hovered_insert = None;
    state.hovered_column = None;
    state.hovered_start = false;
    compact_empty_columns(state);
    trim_trailing_empty_qubits(state);
    if changed {
        state.cache_valid = false;
        state.cached_full_valid = false;
    }
}

pub fn confirm_hovered_column(state: &mut AppState) {
    if state.hovered_start {
        state.confirmed_column = None;
        state.confirmed_start = true;
    } else if let Some((_, index)) = state.hovered_column {
        state.confirmed_column = Some(index);
        state.confirmed_start = false;
    }
    state.cache_valid = false;
    state.cached_full_valid = false;
}

pub fn update_hovered_slot(state: &mut AppState, x: u16, y: u16, area: Rect) {
    update_hovered_state_circle(state, x, y, area);
    let layout = circuit_layout(area, qubit_count(state));
    let next_hovered_start = hovered_start_at(x, y, &layout);
    let next_hovered_column = if next_hovered_start {
        None
    } else {
        hovered_column_at(x, y, &layout)
    };
    if next_hovered_start != state.hovered_start || next_hovered_column != state.hovered_column {
        state.cache_valid = false;
        state.cached_full_valid = false;
    }
    state.hovered_start = next_hovered_start;
    state.hovered_column = next_hovered_column;
    if state.dragging.is_none() {
        state.hovered_slot = None;
        state.hovered_row = None;
        state.hovered_insert = None;
        return;
    }

    let counts: Vec<usize> = layout
        .slots
        .iter()
        .map(|row_slots| row_slots.len())
        .collect();
    ensure_slots(state, &counts);
    let mut best: Option<(usize, u16)> = None;
    let mut best_row: Option<usize> = None;
    for (row, row_slots) in layout.slots.iter().enumerate() {
        for (index, rect) in row_slots.iter().enumerate() {
            if state.placed[row]
                .get(index)
                .and_then(|value| *value)
                .is_some()
            {
                continue;
            }
            let dx = if x < rect.x {
                rect.x - x
            } else if x >= rect.x.saturating_add(rect.width) {
                x - rect.x.saturating_add(rect.width - 1)
            } else {
                0
            };
            let dy = if y < rect.y {
                rect.y - y
            } else if y >= rect.y.saturating_add(rect.height) {
                y - rect.y.saturating_add(rect.height - 1)
            } else {
                0
            };
            let dist = dx.saturating_add(dy);
            if dist > SNAP_DISTANCE {
                continue;
            }
            if best.is_none_or(|(_, best_dist)| dist < best_dist) {
                best = Some((index, dist));
                best_row = Some(row);
            }
        }
    }
    let slot_target = match (best, best_row) {
        (Some((index, dist)), Some(row)) => Some((row, index, dist)),
        _ => None,
    };
    let insert_target = insertion_target(state, x, y, area).and_then(|(row, index)| {
        let layout = circuit_layout(area, qubit_count(state));
        let left = layout
            .slots
            .get(row)
            .and_then(|slots| slots.get(index.saturating_sub(1)))?;
        let gap_x = left.x.saturating_add(GATE_BOX_WIDTH);
        let gap = Rect {
            x: gap_x,
            y: left.y,
            width: SLOT_GAP,
            height: left.height,
        };
        let dx = if x < gap.x {
            gap.x - x
        } else if x >= gap.x.saturating_add(gap.width) {
            x - gap.x.saturating_add(gap.width - 1)
        } else {
            0
        };
        let dy = if y < gap.y {
            gap.y - y
        } else if y >= gap.y.saturating_add(gap.height) {
            y - gap.y.saturating_add(gap.height - 1)
        } else {
            0
        };
        Some((row, index, dx.saturating_add(dy)))
    });

    if let Some((row, index, _)) = insert_target {
        state.hovered_slot = None;
        state.hovered_row = None;
        state.hovered_insert = Some((row, index));
        return;
    }

    state.hovered_slot = slot_target.map(|(_, index, _)| index);
    state.hovered_row = slot_target.map(|(row, _, _)| row);
    state.hovered_insert = None;
}

fn update_hovered_state_circle(state: &mut AppState, x: u16, y: u16, area: Rect) {
    let regions = layout_regions(area, qubit_count(state));
    let in_state = x >= regions.state_circles.x
        && x < regions
            .state_circles
            .x
            .saturating_add(regions.state_circles.width)
        && y >= regions.state_circles.y
        && y < regions
            .state_circles
            .y
            .saturating_add(regions.state_circles.height);
    if !in_state {
        state.hovered_state_display = None;
        state.hovered_state_index = None;
        return;
    }
    let cached_len = state.cached_state.len();
    let display_qubits_count = display_qubits(state);
    let display_total = if cached_len == 0 {
        0
    } else {
        (1usize << display_qubits_count).min(cached_len).max(1)
    };
    let Some(layout) =
        state_circle_layout(regions.state_circles, display_total, display_qubits_count)
    else {
        state.hovered_state_display = None;
        state.hovered_state_index = None;
        return;
    };
    let start_x = regions.state_circles.x as f64 + layout.origin_x - layout.step_x / 2.0;
    let start_y = regions.state_circles.y as f64 + layout.origin_y - layout.step_y / 2.0;
    let rel_x = x as f64 - start_x;
    let rel_y = y as f64 - start_y;
    let col = (rel_x / layout.step_x).floor() as isize;
    let row_from_top = (rel_y / layout.step_y).floor() as isize;
    if col < 0 || row_from_top < 0 {
        state.hovered_state_display = None;
        state.hovered_state_index = None;
        return;
    }
    let col = col as usize;
    let row_from_top = row_from_top as usize;
    if col >= layout.columns || row_from_top >= layout.rows {
        state.hovered_state_display = None;
        state.hovered_state_index = None;
        return;
    }
    let row = layout.rows - 1 - row_from_top;
    let display_index = row * layout.columns + col;
    if display_index >= layout.visible {
        state.hovered_state_display = None;
        state.hovered_state_index = None;
        return;
    }
    let state_index = display_index_to_state_index(display_index, display_qubits_count);
    if state_index >= display_total {
        state.hovered_state_display = None;
        state.hovered_state_index = None;
        return;
    }
    state.hovered_state_display = Some(display_index);
    state.hovered_state_index = Some(state_index);
}

pub fn handle_phase_edit_key(state: &mut AppState, key: event::KeyEvent) -> bool {
    let Some(edit) = state.phase_edit.as_mut() else {
        return false;
    };
    match key.code {
        event::KeyCode::Esc => {
            state.phase_edit = None;
            state.phase_edit_error = None;
            return true;
        }
        event::KeyCode::Enter => {
            match parse_phase_label(&edit.input) {
                Ok(value) => {
                    if let Some(row_values) = state.phase_values.get_mut(edit.row) {
                        if let Some(slot_value) = row_values.get_mut(edit.slot) {
                            *slot_value = Some(value);
                        }
                    }
                    state.phase_edit = None;
                    state.phase_edit_error = None;
                    state.cache_valid = false;
                    state.cached_full_valid = false;
                }
                Err(error) => {
                    state.phase_edit_error = Some(error);
                }
            }
            return true;
        }
        event::KeyCode::Backspace => {
            edit.input.pop();
            return true;
        }
        event::KeyCode::Char(ch) => {
            if ch.is_ascii_digit()
                || ch == 'π'
                || ch == 'p'
                || ch == 'i'
                || ch == '/'
                || ch == '-'
                || ch == '+'
            {
                edit.input.push(ch);
            }
            return true;
        }
        _ => {}
    }
    true
}

fn hit_test_phase_label(state: &AppState, x: u16, y: u16, area: Rect) -> Option<(usize, usize)> {
    let layout = circuit_layout(area, qubit_count(state));
    for (row, row_slots) in layout.slots.iter().enumerate() {
        for (slot, rect) in row_slots.iter().enumerate() {
            let gate = state
                .placed
                .get(row)
                .and_then(|row_gates| row_gates.get(slot))
                .and_then(|gate| *gate);
            if !matches!(gate, Some(Gate::Phase | Gate::Rx | Gate::Ry | Gate::Rz)) {
                continue;
            }
            if rect.y == 0 {
                continue;
            }
            let label = state
                .phase_values
                .get(row)
                .and_then(|row_values| row_values.get(slot))
                .and_then(|value| value.as_ref())
                .map(|value| value.label.as_str())
                .unwrap_or("π/2");
            let label_width = label.chars().count() as u16;
            let label_x = rect
                .x
                .saturating_add(rect.width.saturating_sub(label_width) / 2);
            let label_y = rect.y.saturating_sub(1);
            if y == label_y && x >= label_x && x < label_x.saturating_add(label_width) {
                return Some((row, slot));
            }
        }
    }
    None
}
