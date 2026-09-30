//! Placed circuit gates and GPU-backed circuit overlays.

use std::time::Duration;

use eframe::egui;
use eframe::egui_wgpu;

use crate::app::{gate_frame_group, selection_frame_groups, GateId, QniApp};
use crate::colors::Colors;
use crate::constants::{DRAG_REPAINT_MIN_SECS, GATE_SIZE, LINE_GAP};
use crate::gates::GateKind;
use crate::gpu::{
    AmplitudeDisplayCallback, AmplitudeInstance, AmplitudePopupValueCallback, BlochOverlayCallback,
    BlochOverlayInstance, BlochPopupValueCallback, DensityInstance, DensityMatrixDisplayCallback,
    MeasurementDigitCallback, MeasurementDigitInstance, ProbabilityDisplayCallback,
    ProbabilityInstance, ProbabilityPopupValueCallback, AMPLITUDE_FORCE_NONE,
    AMPLITUDE_FORCE_PLACEHOLDER, DENSITY_RENDER_MODE_PLACEHOLDER, DENSITY_RENDER_MODE_SAMPLE,
    POPUP_GLYPH_CELL_H, POPUP_GLYPH_CELL_W, PROBABILITY_RENDER_MODE_PLACEHOLDER,
    PROBABILITY_RENDER_MODE_SAMPLE,
};
use crate::grid_cell::GridCell;
use crate::icons::{draw_bloch_vector, draw_gate_body, draw_meter_icon};
use crate::layout::{amplitude_grid_dims, amplitude_grid_rect, gate_visible_rect};
use crate::shared::now_seconds;
use crate::span_resize::{span_resize_body_rect, span_resize_ease_out_back, SpanResizeHandles};

use super::amplitude_circle_popover as amplitude_popover;
use super::hover_frame::{connected_gate_frame_corner_radius, hover_frame_corner_radius};
use super::popover::{self, PopoverPlacement, PopoverTail};
use super::state_panel_popup::{draw_amplitude_icon, draw_phase_icon, draw_probability_icon};

// qni's Bloch vector tip is a 6px dot whose centre lands on the sphere
// circumference for ±Z states; the dot itself may extend slightly outside.
// Font-rasterisation baseline correction for the GPU atlas: keep the visible
// digit's vertical centre on the wire, matching qni's flex-centred value layer.
const MEASUREMENT_DIGIT_CENTER_Y_OFFSET: f32 = 1.0;
// Tailwind spacing-1 = 4px: qni shortens the measurement dropzone wires
// around the meter body, so the wire never touches or runs through the arc.
const MEASUREMENT_WIRE_CLEARANCE: f32 = 4.0;
// 3px keeps the anti-control ring open without biting into the 3px stroke.
// The mask is painted after the glyph so the qubit wire never remains in the
// hollow center.
const ANTI_CONTROL_WIRE_MASK_RADIUS: f32 = 3.0;
fn probability_hover_popup_ket(outcome: u32, span: usize) -> String {
    let width = span.clamp(1, 16);
    format!("|{outcome:0width$b}⟩")
}

fn probability_hover_popup_subtitle(outcome: u32) -> String {
    format!("Probability if measured · k = {outcome}")
}

fn amplitude_hover_popup_header(outcome: u32, span: usize) -> String {
    let width = span.clamp(1, 16);
    format!("|{outcome:0width$b}⟩ decimal {outcome}")
}

fn bloch_hover_popup_title() -> &'static str {
    "Bloch sphere representation of local state"
}

impl QniApp {
    fn gate_group_frame(
        &self,
        group: &std::collections::BTreeSet<GateId>,
        circuit_origin: egui::Pos2,
        now: f64,
    ) -> Option<(egui::Rect, egui::CornerRadius)> {
        let mut gates = self
            .placed_gates
            .iter()
            .filter(|gate| group.contains(&gate.id));
        let first = gates.next()?;
        let first_kind = first.kind;
        let frame_rect =
            std::iter::once(first)
                .chain(gates)
                .fold(egui::Rect::NOTHING, |rect, gate| {
                    let motion_x = self
                        .circuit_motion_offset_x(gate.id, now)
                        .unwrap_or_default();
                    let rendered_pos = gate.pos + egui::vec2(motion_x, 0.0);
                    let gate_rect =
                        gate_visible_rect(gate, circuit_origin + rendered_pos.to_vec2());
                    rect.union(span_resize_body_rect(gate.kind, gate.span.get(), gate_rect))
                });
        let corner_radius = if group.len() == 1 {
            hover_frame_corner_radius(first_kind)
        } else {
            connected_gate_frame_corner_radius()
        };
        Some((frame_rect, corner_radius))
    }

    fn amplitude_display_slot(&self, gate_id: GateId) -> Option<u32> {
        let external_slot = self
            .external_gpu_amplitude_uploads
            .as_ref()
            .and_then(|batch| batch.slot_for_gate(gate_id.as_u32()));
        if self.external_gpu_display_placeholders_active() {
            external_slot
        } else {
            external_slot.or_else(|| {
                self.gpu_plan
                    .amplitude_slot(gate_id)
                    .map(|slot| slot.as_u32())
            })
        }
    }

    fn bloch_display_slot(&self, gate_id: GateId) -> Option<u32> {
        self.external_gpu_bloch_uploads
            .as_ref()
            .and_then(|batch| batch.slot_for_gate(gate_id.as_u32()))
            .or_else(|| self.gpu_plan.bloch_slot(gate_id).map(|slot| slot.as_u32()))
    }

    fn probability_display_slot(&self, gate_id: GateId) -> Option<u32> {
        let external_slot = self
            .external_gpu_probability_uploads
            .as_ref()
            .and_then(|batch| batch.slot_for_gate(gate_id.as_u32()));
        if self.external_gpu_display_placeholders_active() {
            external_slot
        } else {
            external_slot.or_else(|| {
                self.gpu_plan
                    .probability_slot(gate_id)
                    .map(|slot| slot.as_u32())
            })
        }
    }

    fn density_display_slot(&self, gate_id: GateId) -> Option<u32> {
        let external_slot = self
            .external_gpu_density_uploads
            .as_ref()
            .and_then(|batch| batch.slot_for_gate(gate_id.as_u32()));
        if self.external_gpu_display_placeholders_active() {
            external_slot
        } else {
            external_slot.or_else(|| {
                self.gpu_plan
                    .density_slot(gate_id)
                    .map(|slot| slot.as_u32())
            })
        }
    }

    pub(super) fn draw_placed_circuit_gates(
        &self,
        painter: &egui::Painter,
        circuit_origin: egui::Pos2,
        colors: &Colors,
        fast_drag: bool,
        dragging_gate_id: Option<GateId>,
    ) {
        let now = now_seconds();
        let editing_enabled = !self.library.active_locked();
        for gate in &self.placed_gates {
            if editing_enabled && self.paste_gate_hidden(gate.id, now) {
                painter
                    .ctx()
                    .request_repaint_after(Duration::from_secs_f64(DRAG_REPAINT_MIN_SECS));
                continue;
            }
            let live_dragging_gate = dragging_gate_id == Some(gate.id)
                && self.dragging_live_display_snap
                && ((gate.kind == GateKind::BlochDisplay
                    && self.bloch_display_slot(gate.id).is_some())
                    || (gate.kind == GateKind::Measurement
                        && self.gpu_plan.has_measurement_slot(gate.id)));
            if dragging_gate_id == Some(gate.id) && !live_dragging_gate {
                continue;
            }
            let motion_x = editing_enabled
                .then(|| self.circuit_motion_offset_x(gate.id, now))
                .flatten();
            if motion_x.is_some() {
                painter
                    .ctx()
                    .request_repaint_after(Duration::from_secs_f64(DRAG_REPAINT_MIN_SECS));
            }
            let rendered_pos = gate.pos + egui::vec2(motion_x.unwrap_or_default(), 0.0);
            let gate_rect = gate_visible_rect(gate, circuit_origin + rendered_pos.to_vec2());
            // docs/design-system/amplitude-display.html §04: Amplitude's footprint follows
            // slot spacing, but the visible matrix body is the square-cell
            // draw area. The shared span-resize component uses that same body.
            let body_rect = span_resize_body_rect(gate.kind, gate.span.get(), gate_rect);
            let measurement_has_slot =
                gate.kind == GateKind::Measurement && self.gpu_plan.has_measurement_slot(gate.id);
            let paste_strength = editing_enabled
                .then(|| {
                    self.paste_flashes
                        .iter()
                        .filter_map(|flash| flash.strength(gate.id, now))
                        .reduce(f32::max)
                })
                .flatten();
            let highlight_strength = paste_strength;
            if highlight_strength.is_some() {
                painter
                    .ctx()
                    .request_repaint_after(Duration::from_secs_f64(DRAG_REPAINT_MIN_SECS));
            }
            let highlighted_colors =
                highlight_strength.map(|strength| colors.gate_highlighted(strength));
            let gate_colors = highlighted_colors.as_ref().unwrap_or(colors);
            let circuit_fill = colors.background;
            if gate.kind == GateKind::Measurement {
                // qni shortens the input/output wire around a measurement
                // dropzone and the meter's interior is opaque. Mask the
                // circuit wire before painting hover chrome / SVG strokes /
                // digit overlay so the hover side borders remain visible.
                let mask_rect = gate_rect.expand2(egui::vec2(MEASUREMENT_WIRE_CLEARANCE, 0.0));
                painter.rect_filled(mask_rect, egui::CornerRadius::ZERO, circuit_fill);
            }
            if matches!(gate.kind, GateKind::Write0 | GateKind::Write1) {
                // Write gates have no fill, so the wire would otherwise show
                // through the brackets. Mask just the wire under the gate.
                painter.rect_filled(gate_rect, egui::CornerRadius::ZERO, colors.background);
            }
            if measurement_has_slot {
                // Repaint the meter in the same neutral tone as the wire after
                // masking the wire gap. Draw it once (instead of purple then
                // neutral) so anti-aliased edges do not leak the palette colour.
                draw_meter_icon(painter, gate_rect, gate_colors.measurement_fired_icon);
            } else {
                draw_gate_body(painter, body_rect, gate.kind, gate_colors);
                if gate.kind == GateKind::AntiControl {
                    painter.circle_filled(
                        gate_rect.center(),
                        ANTI_CONTROL_WIRE_MASK_RADIUS,
                        colors.background,
                    );
                }
            }
            // Resizable-span gates use one shared handle component: top +
            // bottom cyan pills with hover/active scaling. Amplitude's
            // component body is its centred matrix, so width follows the body.
            if let Some(handles) = SpanResizeHandles::for_gate_at_with_availability(
                gate,
                gate_rect,
                &self.placed_gates,
                self.exec_mode.qubit_capacity().get(),
            ) {
                let visible = (editing_enabled && self.hovered_gate_id == Some(gate.id))
                    || self.span_resize_drag.map(|d| d.gate_id) == Some(gate.id);
                let visible_t = painter.ctx().animate_bool_with_time_and_easing(
                    egui::Id::new(("span_resize_handles", gate.id)),
                    visible,
                    0.25,
                    span_resize_ease_out_back,
                );
                if visible || visible_t > 0.01 {
                    handles.paint(
                        painter,
                        colors,
                        self.hovered_span_resize_handle,
                        self.span_resize_drag,
                        visible_t,
                    );
                }
            }
            if gate.kind == GateKind::BlochDisplay && self.bloch_display_slot(gate.id).is_none() {
                // Not yet captured by a recompute (placed mid-drag, unsnapped,
                // or before the first frame's GPU dispatch). Show the
                // inactive tx-3 center dot via egui until the GPU overlay takes over.
                draw_bloch_vector(painter, gate_rect, [0.0, 0.0, 0.0], gate_colors);
            }
        }
        if !fast_drag && editing_enabled {
            let selection_groups =
                selection_frame_groups(&self.placed_gates, &self.selected_gate_ids);
            if let Some(hovered_gate_id) = self.hovered_gate_id {
                let group = selection_groups
                    .iter()
                    .find(|group| group.contains(&hovered_gate_id))
                    .cloned()
                    .unwrap_or_else(|| gate_frame_group(&self.placed_gates, hovered_gate_id));
                if let Some((frame_rect, corner_radius)) =
                    self.gate_group_frame(&group, circuit_origin, now)
                {
                    painter.rect_stroke(
                        frame_rect.expand(4.0),
                        corner_radius,
                        egui::Stroke::new(2.0_f32, colors.gate_hover_border),
                        egui::StrokeKind::Inside,
                    );
                }
            }
            for group in selection_groups {
                if dragging_gate_id.is_some_and(|gate_id| group.contains(&gate_id))
                    || group
                        .iter()
                        .any(|&gate_id| self.paste_gate_hidden(gate_id, now))
                {
                    continue;
                }
                let Some((frame_rect, corner_radius)) =
                    self.gate_group_frame(&group, circuit_origin, now)
                else {
                    continue;
                };
                let copy_strength = group
                    .iter()
                    .filter_map(|&gate_id| {
                        self.copy_flash
                            .as_ref()
                            .and_then(|flash| flash.strength(gate_id, now))
                    })
                    .reduce(f32::max);
                let selection_color = copy_strength
                    .map(|strength| colors.semantic_on.lerp_to_gamma(colors.surface, strength))
                    .unwrap_or(colors.semantic_on);
                painter.rect_stroke(
                    frame_rect.expand(4.0),
                    corner_radius,
                    egui::Stroke::new(2.0_f32, selection_color),
                    egui::StrokeKind::Inside,
                );
            }
        }
    }

    pub(super) fn draw_circuit_gpu_overlays(
        &self,
        painter: &egui::Painter,
        rect: egui::Rect,
        circuit_origin: egui::Pos2,
        dragging_gate_id: Option<GateId>,
        colors: &Colors,
    ) {
        let now = now_seconds();
        // Egui clamps callback viewports to the physical screen. Use the
        // visible clip intersection as the callback viewport; otherwise tall
        // circuits (e.g. 16 qubits) get vertically rescaled by wgpu and GPU
        // overlays drift above their egui-painted gate bodies.
        let callback_rect = rect.intersect(painter.clip_rect());
        if callback_rect.width() <= 0.0 || callback_rect.height() <= 0.0 {
            return;
        }

        // GPU overlay: draw Probability bars from the GPU-side
        // marginalization buffer. CPU supplies only geometry + hover row.
        let mut next_probability_placeholder_slot = self
            .external_gpu_probability_uploads
            .as_ref()
            .map(|batch| batch.slot_to_gate_id.len() as u32)
            .unwrap_or(0);
        let probability_instances: Vec<ProbabilityInstance> = self
            .placed_gates
            .iter()
            .filter_map(|gate| {
                if gate.kind != GateKind::ProbabilityDisplay {
                    return None;
                }
                if self.paste_gate_hidden(gate.id, now) {
                    return None;
                }
                if dragging_gate_id == Some(gate.id) {
                    return None;
                }
                let span = gate.span.get().clamp(1, 16) as u32;
                let (slot, render_mode) = if let Some(slot) = self.probability_display_slot(gate.id)
                {
                    (slot, PROBABILITY_RENDER_MODE_SAMPLE)
                } else if self.external_gpu_display_placeholders_active()
                    && (next_probability_placeholder_slot as usize)
                        < crate::gpu::MAX_PROBABILITY_SLOTS
                {
                    let slot = next_probability_placeholder_slot;
                    next_probability_placeholder_slot += 1;
                    (slot, PROBABILITY_RENDER_MODE_PLACEHOLDER)
                } else {
                    return None;
                };
                let gate_height = (span.saturating_sub(1)) as f32 * LINE_GAP + GATE_SIZE;
                let gate_rect = egui::Rect::from_min_size(
                    circuit_origin
                        + (gate.pos
                            + egui::vec2(
                                self.circuit_motion_offset_x(gate.id, now)
                                    .unwrap_or_default(),
                                0.0,
                            ))
                        .to_vec2(),
                    egui::vec2(GATE_SIZE, gate_height),
                );
                let hovered_outcome = self
                    .hovered_probability_outcome
                    .filter(|(id, _)| *id == gate.id)
                    .map(|(_, outcome)| outcome as i32)
                    .unwrap_or(-1);
                Some(ProbabilityInstance {
                    rect_min: [gate_rect.min.x, gate_rect.min.y],
                    rect_size: [gate_rect.width(), gate_rect.height()],
                    slot,
                    span,
                    hovered_outcome: if render_mode == PROBABILITY_RENDER_MODE_PLACEHOLDER {
                        -1
                    } else {
                        hovered_outcome
                    },
                    render_mode,
                })
            })
            .collect();
        if !probability_instances.is_empty() {
            let callback = ProbabilityDisplayCallback {
                instances: probability_instances.into(),
                viewport_min: [callback_rect.min.x, callback_rect.min.y],
                viewport_size: [callback_rect.width(), callback_rect.height()],
                background: colors.surface.to_normalized_gamma_f32(),
                placeholder_background: colors.display_placeholder_fill.to_normalized_gamma_f32(),
                border: colors.line.to_normalized_gamma_f32(),
                log_hint: colors.probability_log_hint.to_normalized_gamma_f32(),
                bar: colors.state_fill.to_normalized_gamma_f32(),
                bar_edge: colors.popup_icon.to_normalized_gamma_f32(),
                hover_border: colors.gate_hover_border.to_normalized_gamma_f32(),
                text_color: colors.text_strong.to_normalized_gamma_f32(),
                external_uploads: self.external_gpu_probability_uploads.clone(),
            };
            let paint_callback = egui_wgpu::Callback::new_paint_callback(callback_rect, callback);
            painter.add(egui::Shape::Callback(paint_callback));
        }

        let live_dragging_amplitude_id =
            dragging_gate_id.filter(|_| self.dragging_live_display_snap);
        let mut next_amplitude_placeholder_slot = self
            .external_gpu_amplitude_uploads
            .as_ref()
            .map(|batch| batch.slot_to_gate_id.len() as u32)
            .unwrap_or(0);
        let amplitude_instances: Vec<AmplitudeInstance> = self
            .placed_gates
            .iter()
            .filter_map(|gate| {
                if gate.kind != GateKind::AmplitudeDisplay {
                    return None;
                }
                if self.paste_gate_hidden(gate.id, now) {
                    return None;
                }
                let dragging_this_gate = dragging_gate_id == Some(gate.id);
                if dragging_this_gate && live_dragging_amplitude_id != Some(gate.id) {
                    return None;
                }
                let span = gate.span.get().clamp(1, 16) as u32;
                let (slot, force_zero_amplitude) = if let Some(slot) =
                    self.amplitude_display_slot(gate.id)
                {
                    (slot, AMPLITUDE_FORCE_NONE)
                } else if self.external_gpu_display_placeholders_active()
                    && (next_amplitude_placeholder_slot as usize) < crate::gpu::MAX_AMPLITUDE_SLOTS
                {
                    let slot = next_amplitude_placeholder_slot;
                    next_amplitude_placeholder_slot += 1;
                    (slot, AMPLITUDE_FORCE_PLACEHOLDER)
                } else {
                    return None;
                };
                let rendered_pos = gate.pos
                    + egui::vec2(
                        self.circuit_motion_offset_x(gate.id, now)
                            .unwrap_or_default(),
                        0.0,
                    );
                let gate_rect = gate_visible_rect(gate, circuit_origin + rendered_pos.to_vec2());
                let body_rect = amplitude_grid_rect(gate_rect, gate.span.get());
                let hovered_outcome = self
                    .hovered_amplitude_outcome
                    .filter(|(id, _)| *id == gate.id)
                    .map(|(_, outcome)| outcome as i32)
                    .unwrap_or(-1);
                Some(AmplitudeInstance {
                    rect_min: [body_rect.min.x, body_rect.min.y],
                    rect_size: [body_rect.width(), body_rect.height()],
                    slot,
                    span,
                    hovered_outcome: if force_zero_amplitude == AMPLITUDE_FORCE_PLACEHOLDER {
                        -1
                    } else {
                        hovered_outcome
                    },
                    use_drag_background: u32::from(dragging_this_gate),
                    force_zero_amplitude,
                })
            })
            .collect();
        if !amplitude_instances.is_empty() {
            let callback = AmplitudeDisplayCallback {
                instances: amplitude_instances.into(),
                use_drag_preview_buffer: false,
                viewport_min: [callback_rect.min.x, callback_rect.min.y],
                viewport_size: [callback_rect.width(), callback_rect.height()],
                background: colors.surface.to_normalized_gamma_f32(),
                drag_background: colors.drag_fill.to_normalized_gamma_f32(),
                border: colors.line.to_normalized_gamma_f32(),
                disk: colors.state_fill.to_normalized_gamma_f32(),
                disk_border: colors.amplitude_disk_border.to_normalized_gamma_f32(),
                outline: colors.state_outline.to_normalized_gamma_f32(),
                outline_zero: colors.state_outline_zero.to_normalized_gamma_f32(),
                needle: colors.state_needle.to_normalized_gamma_f32(),
                hover_border: colors.gate_hover_border.to_normalized_gamma_f32(),
                placeholder_background: colors.display_placeholder_fill.to_normalized_gamma_f32(),
                external_uploads: self.external_gpu_amplitude_uploads.clone(),
            };
            let paint_callback = egui_wgpu::Callback::new_paint_callback(callback_rect, callback);
            painter.add(egui::Shape::Callback(paint_callback));
        }

        let live_dragging_density_id = dragging_gate_id.filter(|_| self.dragging_live_display_snap);
        let mut next_density_placeholder_slot = self
            .external_gpu_density_uploads
            .as_ref()
            .map(|batch| batch.slot_to_gate_id.len() as u32)
            .unwrap_or(0);
        let density_instances: Vec<DensityInstance> = self
            .placed_gates
            .iter()
            .filter_map(|gate| {
                if gate.kind != GateKind::DensityMatrixDisplay {
                    return None;
                }
                if self.paste_gate_hidden(gate.id, now) {
                    return None;
                }
                let dragging_this_gate = dragging_gate_id == Some(gate.id);
                if dragging_this_gate && live_dragging_density_id != Some(gate.id) {
                    return None;
                }
                let (slot, render_mode) = if let Some(slot) = self.density_display_slot(gate.id) {
                    (slot, DENSITY_RENDER_MODE_SAMPLE)
                } else if self.external_gpu_display_placeholders_active()
                    && (next_density_placeholder_slot as usize) < crate::gpu::MAX_DENSITY_SLOTS
                {
                    let slot = next_density_placeholder_slot;
                    next_density_placeholder_slot += 1;
                    (slot, DENSITY_RENDER_MODE_PLACEHOLDER)
                } else {
                    return None;
                };
                let span = gate.span.get().clamp(1, 8) as u32;
                let rendered_pos = gate.pos
                    + egui::vec2(
                        self.circuit_motion_offset_x(gate.id, now)
                            .unwrap_or_default(),
                        0.0,
                    );
                let gate_rect = gate_visible_rect(gate, circuit_origin + rendered_pos.to_vec2());
                let hovered_cell = self
                    .hovered_density_cell
                    .filter(|(id, _)| *id == gate.id)
                    .map(|(_, cell)| cell as i32)
                    .unwrap_or(-1);
                Some(DensityInstance {
                    rect_min: [gate_rect.min.x, gate_rect.min.y],
                    rect_size: [gate_rect.width(), gate_rect.height()],
                    slot,
                    span,
                    hovered_cell: if render_mode == DENSITY_RENDER_MODE_PLACEHOLDER {
                        -1
                    } else {
                        hovered_cell
                    },
                    use_drag_background: u32::from(dragging_this_gate),
                    render_mode,
                })
            })
            .collect();
        if !density_instances.is_empty() {
            let callback = DensityMatrixDisplayCallback {
                instances: density_instances.into(),
                viewport_min: [callback_rect.min.x, callback_rect.min.y],
                viewport_size: [callback_rect.width(), callback_rect.height()],
                background: colors.surface.to_normalized_gamma_f32(),
                drag_background: colors.drag_fill.to_normalized_gamma_f32(),
                border: colors.line.to_normalized_gamma_f32(),
                disk: colors.state_fill.to_normalized_gamma_f32(),
                disk_border: colors.amplitude_disk_border.to_normalized_gamma_f32(),
                outline: colors.state_outline.to_normalized_gamma_f32(),
                outline_zero: colors.state_outline_zero.to_normalized_gamma_f32(),
                needle: colors.state_needle.to_normalized_gamma_f32(),
                hover_border: colors.gate_hover_border.to_normalized_gamma_f32(),
                placeholder_background: colors.display_placeholder_fill.to_normalized_gamma_f32(),
                external_uploads: self.external_gpu_density_uploads.clone(),
            };
            let paint_callback = egui_wgpu::Callback::new_paint_callback(callback_rect, callback);
            painter.add(egui::Shape::Callback(paint_callback));
        }

        // GPU overlay: draws the dynamic arrow + tip dot for every placed
        // BlochDisplay whose values are live in `bloch_output_buffer`. No
        // CPU readback — the fragment shader samples the storage buffer
        // directly.
        let live_dragging_bloch_id = dragging_gate_id.filter(|_| self.dragging_live_display_snap);
        let bloch_overlay_instances: Vec<BlochOverlayInstance> = self
            .placed_gates
            .iter()
            .filter_map(|gate| {
                if gate.kind != GateKind::BlochDisplay {
                    return None;
                }
                if self.paste_gate_hidden(gate.id, now) {
                    return None;
                }
                if dragging_gate_id == Some(gate.id) && live_dragging_bloch_id != Some(gate.id) {
                    return None;
                }
                let slot = self.bloch_display_slot(gate.id)?;
                let gate_rect = egui::Rect::from_min_size(
                    circuit_origin
                        + (gate.pos
                            + egui::vec2(
                                self.circuit_motion_offset_x(gate.id, now)
                                    .unwrap_or_default(),
                                0.0,
                            ))
                        .to_vec2(),
                    egui::vec2(GATE_SIZE, GATE_SIZE),
                );
                let center = gate_rect.center();
                let sphere_radius = gate_rect.width().min(gate_rect.height()) * 0.5 - 1.0;
                // 6px slack covers the 4px tip dot + 1px outline + AA fringe.
                let outer = sphere_radius + 6.0;
                Some(BlochOverlayInstance {
                    center: [center.x, center.y],
                    radius: sphere_radius,
                    outer,
                    slot,
                })
            })
            .collect();
        if !bloch_overlay_instances.is_empty() {
            let callback = BlochOverlayCallback {
                instances: bloch_overlay_instances.into(),
                viewport_min: [callback_rect.min.x, callback_rect.min.y],
                viewport_size: [callback_rect.width(), callback_rect.height()],
                // Same gamma story as `RenderColors::new` — surface is
                // rgba8unorm so we hand the GPU sRGB bytes, not linear.
                line_color: colors.bloch_vector_line.to_normalized_gamma_f32(),
                tip_0_color: colors.bloch_vector_tip_0.to_normalized_gamma_f32(),
                tip_mid_color: colors.bloch_vector_tip_mid.to_normalized_gamma_f32(),
                tip_1_color: colors.bloch_vector_tip_1.to_normalized_gamma_f32(),
                tip_outline_color: colors.bloch_vector_tip_outline.to_normalized_gamma_f32(),
                zero_color: colors.bloch_vector_zero.to_normalized_gamma_f32(),
                external_uploads: self.external_gpu_bloch_uploads.clone(),
            };
            let paint_callback = egui_wgpu::Callback::new_paint_callback(callback_rect, callback);
            painter.add(egui::Shape::Callback(paint_callback));
        }

        // GPU overlay: 0/1 digit per measurement, sourced directly from
        // `measurement_aux_buffer.z`. Half extent is roughly digit-bounding
        // box + AA fringe.
        let live_dragging_measurement_id =
            dragging_gate_id.filter(|_| self.dragging_live_display_snap);
        let measurement_digit_instances: Vec<MeasurementDigitInstance> = self
            .placed_gates
            .iter()
            .filter_map(|gate| {
                if gate.kind != GateKind::Measurement {
                    return None;
                }
                if self.paste_gate_hidden(gate.id, now) {
                    return None;
                }
                if dragging_gate_id == Some(gate.id)
                    && live_dragging_measurement_id != Some(gate.id)
                {
                    return None;
                }
                let slot = self.gpu_plan.measurement_slot(gate.id)?.as_u32();
                let gate_rect = egui::Rect::from_min_size(
                    circuit_origin
                        + (gate.pos
                            + egui::vec2(
                                self.circuit_motion_offset_x(gate.id, now)
                                    .unwrap_or_default(),
                                0.0,
                            ))
                        .to_vec2(),
                    egui::vec2(GATE_SIZE, GATE_SIZE),
                );
                let center =
                    gate_rect.center() + egui::vec2(0.0, MEASUREMENT_DIGIT_CENTER_Y_OFFSET);
                Some(MeasurementDigitInstance {
                    center: [center.x, center.y],
                    // Quad spans the full gate body, matching the Write gate digit
                    // rect so Measurement and Write share the same SVG/SDF digit size.
                    half_extent: GATE_SIZE * 0.5,
                    slot,
                })
            })
            .collect();
        if !measurement_digit_instances.is_empty() {
            let callback = MeasurementDigitCallback {
                instances: measurement_digit_instances.into(),
                viewport_min: [callback_rect.min.x, callback_rect.min.y],
                viewport_size: [callback_rect.width(), callback_rect.height()],
                // Surface is rgba8unorm (non-sRGB) — egui paints text using
                // sRGB-encoded colours straight to the framebuffer, so we
                // need to do the same for the digit to read identically.
                // `Rgba::from(Color32)` would convert to linear and produce
                // a desaturated digit.
                zero_color: colors.semantic_off.to_normalized_gamma_f32(),
                one_color: colors.semantic_on.to_normalized_gamma_f32(),
            };
            let paint_callback = egui_wgpu::Callback::new_paint_callback(callback_rect, callback);
            painter.add(egui::Shape::Callback(paint_callback));
        }
    }

    pub(crate) fn draw_bloch_hover_popup(
        &self,
        painter: &egui::Painter,
        screen_rect: egui::Rect,
        circuit_origin: egui::Pos2,
        dragging_gate_id: Option<GateId>,
        colors: &Colors,
    ) {
        let Some(gate_id) = self.hovered_gate_id else {
            return;
        };
        if dragging_gate_id == Some(gate_id) {
            return;
        }
        let Some(gate) = self
            .placed_gates
            .iter()
            .find(|gate| gate.id == gate_id && gate.kind == GateKind::BlochDisplay)
        else {
            return;
        };
        let Some(slot) = self.bloch_display_slot(gate.id) else {
            return;
        };
        let gate_rect = egui::Rect::from_min_size(
            circuit_origin + gate.pos.to_vec2(),
            egui::vec2(GATE_SIZE, GATE_SIZE),
        );

        // docs/design-system/bloch-display-popover.html: title uses Geist regular
        // text-sm; labels are Geist Mono text-xs; values are rendered by GPU from
        // `bloch_output_buffer` to avoid production GPU→CPU readback.
        let title_font = egui::FontId::proportional(14.0); // text-sm = 14px.
        let label_font = egui::FontId::monospace(12.0); // text-xs = 12px.
        let title_galley = painter.layout_no_wrap(
            bloch_hover_popup_title().to_owned(),
            title_font,
            colors.text_strong,
        );
        let label_galleys = ["r", "φ", "θ", "x", "y", "z"]
            .map(|label| painter.layout_no_wrap(label.to_owned(), label_font.clone(), colors.text));

        let pad_x = 16.0; // spacing-4.
        let pad_y = 12.0; // spacing-3.
        let divider_gap = 12.0; // spacing-3.
        let label_gap = 8.0; // spacing-2.
        let col_gap = 12.0; // spacing-3.
        let label_w = 12.0; // min-width 12px for r / φ / θ / x / y / z.
        let value_chars = 8.0; // Matches WGSL VALUE_CHARS.
        let value_w = POPUP_GLYPH_CELL_W as f32 * value_chars;
        let value_h = POPUP_GLYPH_CELL_H as f32;
        let value_pitch = 20.0; // text-sm default line-height = 20px.
        let cell_w = label_w + label_gap + value_w;
        let col_pitch = cell_w + col_gap;
        let content_w = title_galley.size().x.max(cell_w * 3.0 + col_gap * 2.0);
        let width = content_w + pad_x * 2.0;
        let title_h = title_galley.size().y.max(20.0);
        let height =
            pad_y + title_h + divider_gap + 1.0 + divider_gap + value_pitch + value_h + pad_y;
        let placement = bloch_hover_popup_placement(gate_rect, width, height, screen_rect);
        let rect = placement.rect;
        popover::paint_popover(painter, colors, placement);

        let title_pos = egui::pos2(rect.left() + pad_x, rect.top() + pad_y);
        let divider_y = title_pos.y + title_h + divider_gap;
        let row0_y = divider_y + 1.0 + divider_gap;
        let row1_y = row0_y + value_pitch;
        painter.galley(title_pos, title_galley, colors.text_strong);
        painter.rect_filled(
            egui::Rect::from_min_size(
                egui::pos2(rect.left() + pad_x, divider_y),
                egui::vec2(rect.width() - pad_x * 2.0, 1.0),
            ),
            egui::CornerRadius::ZERO,
            colors.line,
        );

        let label_x0 = rect.left() + pad_x;
        for row in 0..2 {
            for col in 0..3 {
                let label_index = row * 3 + col;
                let label_x = label_x0 + col as f32 * col_pitch;
                let label_y = if row == 0 { row0_y } else { row1_y } + 2.0;
                painter.galley(
                    egui::pos2(label_x, label_y),
                    label_galleys[label_index].clone(),
                    colors.text,
                );
            }
        }

        let value_anchor = egui::pos2(label_x0 + label_w + label_gap, row0_y + 2.0);
        let callback = BlochPopupValueCallback {
            viewport_min: [screen_rect.min.x, screen_rect.min.y],
            viewport_size: [screen_rect.width(), screen_rect.height()],
            value_anchor: [value_anchor.x, value_anchor.y],
            col_pitch,
            row_pitch: value_pitch,
            char_size: [POPUP_GLYPH_CELL_W as f32, value_h],
            text_color: colors.text_strong.to_normalized_gamma_f32(),
            slot,
        };
        let paint_callback = egui_wgpu::Callback::new_paint_callback(screen_rect, callback);
        let value_clip = egui::Rect::from_min_size(
            value_anchor,
            egui::vec2(value_w + col_pitch * 2.0, value_pitch + value_h),
        );
        painter
            .with_clip_rect(value_clip.intersect(rect.shrink(4.0)))
            .add(egui::Shape::Callback(paint_callback));
    }

    pub(crate) fn draw_amplitude_hover_popup(
        &self,
        painter: &egui::Painter,
        screen_rect: egui::Rect,
        circuit_origin: egui::Pos2,
        dragging_gate_id: Option<GateId>,
        colors: &Colors,
    ) {
        let Some((gate_id, outcome)) = self.hovered_amplitude_outcome else {
            return;
        };
        if dragging_gate_id == Some(gate_id) {
            return;
        }
        let Some(gate) = self
            .placed_gates
            .iter()
            .find(|gate| gate.id == gate_id && gate.kind == GateKind::AmplitudeDisplay)
        else {
            return;
        };
        let Some(slot) = self.amplitude_display_slot(gate.id) else {
            return;
        };
        let span = gate.span.get().clamp(1, 16);
        let gate_rect = gate_visible_rect(gate, circuit_origin + gate.pos.to_vec2());
        let Some((circle_center, circle_radius)) = amplitude_hover_circle(gate_rect, span, outcome)
        else {
            return;
        };

        // docs/design-system/amplitude-circle-popover.html: state-vector panel
        // amplitude-circle popover is canonical. CPU paints only fixed chrome,
        // labels, and icons; all numeric values are rendered by WebGPU from the
        // Amplitude Display storage buffers without production readback.
        let header = amplitude_hover_popup_header(outcome, span);
        let header_font = egui::FontId::monospace(14.0); // text-sm = 14px.
        let body_font = egui::FontId::monospace(12.0); // text-xs = 12px.
        let height = amplitude_popover::height();
        let placement = amplitude_hover_popup_placement(
            circle_center,
            circle_radius,
            amplitude_popover::WIDTH,
            height,
            screen_rect,
        );
        let rect = placement.rect;
        popover::paint_popover(painter, colors, placement);

        let header_pos = amplitude_popover::header_pos(rect);
        painter.text(
            header_pos,
            egui::Align2::LEFT_TOP,
            header,
            header_font,
            colors.text_strong,
        );

        let icon_accent = colors.popup_icon;
        let icon_chrome = colors.popup_icon_chrome;
        let labels = ["Amplitude:", "Probability:", "Phase:"];
        for (row, label) in labels.iter().enumerate() {
            let icon_rect = amplitude_popover::icon_rect(rect, row);
            match row {
                0 => draw_amplitude_icon(painter, icon_rect, icon_chrome, icon_accent),
                1 => draw_probability_icon(painter, icon_rect, icon_chrome, icon_accent),
                _ => draw_phase_icon(painter, icon_rect, icon_chrome, icon_accent),
            }
            painter.text(
                amplitude_popover::label_pos(rect, row),
                egui::Align2::LEFT_TOP,
                *label,
                body_font.clone(),
                colors.text,
            );
        }

        let value_anchor = amplitude_popover::value_anchor(rect);
        let value_h = POPUP_GLYPH_CELL_H as f32;
        let callback = AmplitudePopupValueCallback {
            viewport_min: [screen_rect.min.x, screen_rect.min.y],
            viewport_size: [screen_rect.width(), screen_rect.height()],
            value_anchor: [value_anchor.x, value_anchor.y],
            row_pitch: amplitude_popover::ROW_H,
            char_size: [POPUP_GLYPH_CELL_W as f32, value_h],
            text_color: colors.text_strong.to_normalized_gamma_f32(),
            muted_text_color: colors.text.to_normalized_gamma_f32(),
            slot,
            outcome,
        };
        let paint_callback = egui_wgpu::Callback::new_paint_callback(screen_rect, callback);
        let value_clip = amplitude_popover::value_clip_rect(value_anchor);
        painter
            .with_clip_rect(value_clip.intersect(rect.shrink(4.0)))
            .add(egui::Shape::Callback(paint_callback));
    }

    pub(crate) fn draw_probability_hover_popup(
        &self,
        painter: &egui::Painter,
        screen_rect: egui::Rect,
        circuit_origin: egui::Pos2,
        dragging_gate_id: Option<GateId>,
        colors: &Colors,
    ) {
        let Some((gate_id, outcome)) = self.hovered_probability_outcome else {
            return;
        };
        if dragging_gate_id == Some(gate_id) {
            return;
        }
        let Some(gate) = self
            .placed_gates
            .iter()
            .find(|gate| gate.id == gate_id && gate.kind == GateKind::ProbabilityDisplay)
        else {
            return;
        };
        let span = gate.span.get().clamp(1, 16);
        let row_count = 1usize << span;
        let gate_height = (span - 1) as f32 * LINE_GAP + GATE_SIZE;
        let gate_rect = egui::Rect::from_min_size(
            circuit_origin + gate.pos.to_vec2(),
            egui::vec2(GATE_SIZE, gate_height),
        );
        let row_h = gate_rect.height() / row_count as f32;
        let row_top = gate_rect.top() + row_h * outcome as f32;
        let ket = probability_hover_popup_ket(outcome, span);
        let subtitle = probability_hover_popup_subtitle(outcome);
        let Some(slot) = self.probability_display_slot(gate.id) else {
            return;
        };

        // Popup typography follows docs/design-system/probability-display.html §10: text-sm ket,
        // text-xs subtitle/labels, spacing on the Tailwind 4px scale.
        let ket_font = egui::FontId::monospace(14.0); // text-sm = 14px.
        let subtitle_font = egui::FontId::proportional(12.0); // text-xs = 12px.
        let label_font = egui::FontId::monospace(12.0); // text-xs = 12px.
        let ket_galley = painter.layout_no_wrap(ket, ket_font, colors.text_strong);
        let subtitle_galley = painter.layout_no_wrap(subtitle, subtitle_font, colors.text);
        let raw_label_galley =
            painter.layout_no_wrap("RAW".to_owned(), label_font.clone(), colors.text);
        let log_label_galley = painter.layout_no_wrap("LOG".to_owned(), label_font, colors.text);

        let pad_x = 16.0; // spacing-4.
        let pad_y = 12.0; // spacing-3.
        let subtitle_gap = 4.0; // spacing-1.
        let divider_gap = 12.0; // spacing-3.
        let row_gap = 16.0; // spacing-4.
        let value_chars = 12.0; // Must match WGSL VALUE_CHARS; fits raw percent and compact log dB rows.
        let value_w = POPUP_GLYPH_CELL_W as f32 * value_chars;
        let value_h = POPUP_GLYPH_CELL_H as f32;
        let value_pitch = 20.0; // text-sm default line-height = 20px.
        let label_w = 32.0_f32.max(raw_label_galley.size().x.max(log_label_galley.size().x));
        let row_w = label_w + row_gap + value_w;
        let content_w = ket_galley.size().x.max(subtitle_galley.size().x).max(row_w);
        let width = content_w + pad_x * 2.0;
        let ket_h = ket_galley.size().y.max(16.0);
        let subtitle_h = subtitle_galley.size().y.max(16.0);
        let height = pad_y * 2.0
            + ket_h
            + subtitle_gap
            + subtitle_h
            + divider_gap
            + 1.0
            + divider_gap
            + value_h
            + 4.0
            + value_h;
        let placement = probability_hover_popup_placement(
            gate_rect,
            row_top,
            row_h,
            width,
            height,
            screen_rect,
        );
        let rect = placement.rect;
        popover::paint_popover(painter, colors, placement);

        let ket_pos = egui::pos2(
            rect.center().x - ket_galley.size().x * 0.5,
            rect.top() + pad_y,
        );
        let subtitle_pos = egui::pos2(rect.left() + pad_x, ket_pos.y + ket_h + subtitle_gap);
        let divider_y = subtitle_pos.y + subtitle_h + divider_gap;
        let raw_y = divider_y + 1.0 + divider_gap;
        let log_y = raw_y + value_pitch;
        painter.galley(ket_pos, ket_galley, colors.text_strong);
        painter.galley(subtitle_pos, subtitle_galley, colors.text);
        painter.rect_filled(
            egui::Rect::from_min_size(
                egui::pos2(rect.left() + pad_x, divider_y),
                egui::vec2(rect.width() - pad_x * 2.0, 1.0),
            ),
            egui::CornerRadius::ZERO,
            colors.line,
        );

        let label_x = rect.left() + pad_x;
        let value_x = rect.right() - pad_x - value_w;
        painter.galley(
            egui::pos2(label_x, raw_y + 2.0),
            raw_label_galley,
            colors.text,
        );
        painter.galley(
            egui::pos2(label_x, log_y + 2.0),
            log_label_galley,
            colors.text,
        );

        // Raw/log values come from the GPU Probability buffer via a
        // dedicated render pass. CPU paints only static labels; no readback.
        // Align the GPU-rasterised 16px-tall value cells with the
        // egui-painted RAW / LOG labels in the same popup rows.
        let value_anchor = egui::pos2(value_x, raw_y + 2.0);
        let value_color = colors.text_strong.to_normalized_gamma_f32();
        let callback = ProbabilityPopupValueCallback {
            viewport_min: [screen_rect.min.x, screen_rect.min.y],
            viewport_size: [screen_rect.width(), screen_rect.height()],
            value_anchor: [value_anchor.x, value_anchor.y],
            row_pitch: value_pitch,
            char_size: [POPUP_GLYPH_CELL_W as f32, value_h],
            text_color: value_color,
            slot,
            outcome,
        };
        let paint_callback = egui_wgpu::Callback::new_paint_callback(screen_rect, callback);
        let value_clip =
            egui::Rect::from_min_size(value_anchor, egui::vec2(value_w, value_pitch + value_h));
        painter
            .with_clip_rect(value_clip.intersect(rect.shrink(4.0)))
            .add(egui::Shape::Callback(paint_callback));
    }
}

fn amplitude_hover_circle(
    gate_rect: egui::Rect,
    span: usize,
    outcome: u32,
) -> Option<(egui::Pos2, f32)> {
    let grid_rect = amplitude_grid_rect(gate_rect, span);
    let (cols, rows) = amplitude_grid_dims(span);
    let outcome = outcome as usize;
    if outcome >= cols * rows {
        return None;
    }
    let cell = grid_rect.width() / cols as f32;
    let grid_cell = GridCell::from_index(outcome, cols);
    let center = egui::pos2(
        grid_rect.left() + (grid_cell.col() as f32 + 0.5) * cell,
        grid_rect.top() + (grid_cell.row() as f32 + 0.5) * cell,
    );
    Some((center, amplitude_popover::outline_radius_for_cell(cell)))
}

fn amplitude_hover_popup_placement(
    circle_center: egui::Pos2,
    circle_radius: f32,
    width: f32,
    height: f32,
    screen_rect: egui::Rect,
) -> PopoverPlacement {
    let size = egui::vec2(width, height);
    let above_top =
        circle_center.y - circle_radius - popover::ANCHOR_GAP - popover::TAIL_H - height;
    let min_top = screen_rect.top() + popover::VIEWPORT_PAD;
    let prefer_above = above_top >= min_top;
    let top = if prefer_above {
        above_top
    } else {
        circle_center.y + circle_radius + popover::ANCHOR_GAP + popover::TAIL_H
    };
    let rect = amplitude_popover::clamp_horizontally_to_bounds(
        egui::Rect::from_min_size(egui::pos2(circle_center.x - width * 0.5, top), size),
        screen_rect,
    );

    let tail = if prefer_above {
        PopoverTail::on_bottom_edge(rect, circle_center.x)
    } else {
        PopoverTail::on_top_edge(rect, circle_center.x)
    };
    PopoverPlacement { rect, tail }
}

fn bloch_hover_popup_placement(
    gate_rect: egui::Rect,
    width: f32,
    height: f32,
    screen_rect: egui::Rect,
) -> PopoverPlacement {
    let side_gap = popover::ANCHOR_GAP + popover::TAIL_H;
    let size = egui::vec2(width, height);
    let prefer_right =
        gate_rect.right() + side_gap + width <= screen_rect.right() - popover::VIEWPORT_PAD;
    let left = if prefer_right {
        gate_rect.right() + side_gap
    } else {
        gate_rect.left() - side_gap - width
    };
    let mut rect = egui::Rect::from_min_size(egui::pos2(left, gate_rect.top()), size);

    let min_left = screen_rect.left() + popover::VIEWPORT_PAD;
    let max_left = screen_rect.right() - popover::VIEWPORT_PAD - rect.width();
    let target_left = if max_left >= min_left {
        rect.left().clamp(min_left, max_left)
    } else {
        min_left
    };
    let min_top = screen_rect.top() + popover::VIEWPORT_PAD;
    let max_top = screen_rect.bottom() - popover::VIEWPORT_PAD - rect.height();
    let target_top = if max_top >= min_top {
        rect.top().clamp(min_top, max_top)
    } else {
        min_top
    };
    rect = rect.translate(egui::vec2(
        target_left - rect.left(),
        target_top - rect.top(),
    ));

    // The popover card top aligns to the 40px Bloch host top, while the tail
    // apex points at the host's vertical center. This keeps the callout visually
    // anchored to the sphere instead of drooping below it.
    let anchor_y = gate_rect.center().y;
    let tail = if rect.center().x >= gate_rect.center().x {
        PopoverTail::on_left_edge(rect, anchor_y)
    } else {
        PopoverTail::on_right_edge(rect, anchor_y)
    };
    PopoverPlacement { rect, tail }
}

fn probability_hover_popup_placement(
    gate_rect: egui::Rect,
    row_top: f32,
    row_h: f32,
    width: f32,
    height: f32,
    screen_rect: egui::Rect,
) -> PopoverPlacement {
    let side_gap = popover::ANCHOR_GAP + popover::TAIL_H;
    let size = egui::vec2(width, height);
    let row_center_y = row_top + row_h * 0.5;
    let prefer_right =
        gate_rect.right() + side_gap + width <= screen_rect.right() - popover::VIEWPORT_PAD;
    let left = if prefer_right {
        gate_rect.right() + side_gap
    } else {
        gate_rect.left() - side_gap - width
    };
    let top = row_center_y - height * 0.5;
    let mut rect = egui::Rect::from_min_size(egui::pos2(left, top), size);

    let min_left = screen_rect.left() + popover::VIEWPORT_PAD;
    let max_left = screen_rect.right() - popover::VIEWPORT_PAD - rect.width();
    let target_left = if max_left >= min_left {
        rect.left().clamp(min_left, max_left)
    } else {
        min_left
    };
    let min_top = screen_rect.top() + popover::VIEWPORT_PAD;
    let max_top = screen_rect.bottom() - popover::VIEWPORT_PAD - rect.height();
    let target_top = if max_top >= min_top {
        rect.top().clamp(min_top, max_top)
    } else {
        min_top
    };
    rect = rect.translate(egui::vec2(
        target_left - rect.left(),
        target_top - rect.top(),
    ));

    // Choose the tail edge after viewport clamping. In cramped viewports the
    // card can move away from the preferred side; the tail should still point
    // from the card edge nearest to the hovered probability/amplitude row.
    let tail = if rect.center().x >= gate_rect.center().x {
        PopoverTail::on_left_edge(rect, row_center_y)
    } else {
        PopoverTail::on_right_edge(rect, row_center_y)
    };
    PopoverPlacement { rect, tail }
}

#[cfg(test)]
mod tests {
    use eframe::egui;

    #[test]
    fn bloch_hover_popup_title_matches_spec() {
        assert_eq!(
            super::bloch_hover_popup_title(),
            "Bloch sphere representation of local state"
        );
    }

    #[test]
    fn bloch_hover_popup_prefers_right_side_when_space_allows() {
        let gate_rect = egui::Rect::from_min_size(egui::pos2(0.0, 0.0), egui::vec2(40.0, 40.0));
        let screen_rect = egui::Rect::from_min_size(egui::pos2(0.0, 0.0), egui::vec2(800.0, 600.0));
        let placement = super::bloch_hover_popup_placement(gate_rect, 320.0, 104.0, screen_rect);

        assert_eq!(placement.rect.left(), 52.0);
    }

    #[test]
    fn bloch_hover_popup_tail_points_to_gate_vertical_center() {
        let gate_rect = egui::Rect::from_min_size(egui::pos2(20.0, 40.0), egui::vec2(40.0, 40.0));
        let screen_rect = egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(800.0, 600.0));
        let placement = super::bloch_hover_popup_placement(gate_rect, 320.0, 104.0, screen_rect);

        assert_eq!(placement.tail.apex_y(), 60.0);
    }

    #[test]
    fn bloch_hover_popup_flips_left_near_viewport_right_edge() {
        let gate_rect = egui::Rect::from_min_size(egui::pos2(600.0, 40.0), egui::vec2(40.0, 40.0));
        let screen_rect = egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(800.0, 600.0));
        let placement = super::bloch_hover_popup_placement(gate_rect, 320.0, 104.0, screen_rect);

        assert_eq!(placement.rect.left(), 268.0);
    }

    #[test]
    fn bloch_hover_popup_clamps_inside_viewport_left_edge() {
        let gate_rect = egui::Rect::from_min_size(egui::pos2(20.0, 40.0), egui::vec2(40.0, 40.0));
        let screen_rect = egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(280.0, 180.0));
        let placement = super::bloch_hover_popup_placement(gate_rect, 320.0, 104.0, screen_rect);

        assert_eq!(placement.rect.left(), 4.0);
    }

    #[test]
    fn probability_hover_popup_text_matches_probability_display_spec() {
        assert_eq!(
            (
                super::probability_hover_popup_ket(3, 2),
                super::probability_hover_popup_subtitle(3)
            ),
            (
                "|11⟩".to_owned(),
                "Probability if measured · k = 3".to_owned()
            )
        );
    }

    #[test]
    fn probability_hover_popup_flips_left_near_viewport_right_edge() {
        let gate_rect = egui::Rect::from_min_size(egui::pos2(200.0, 40.0), egui::vec2(40.0, 96.0));
        let screen_rect = egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(260.0, 180.0));

        let placement = super::probability_hover_popup_placement(
            gate_rect,
            64.0,
            24.0,
            80.0,
            60.0,
            screen_rect,
        );

        assert_eq!(
            (placement.rect.left(), placement.rect.right()),
            (108.0, 188.0)
        );
    }

    #[test]
    fn probability_hover_popup_clamps_inside_viewport_left_edge() {
        let gate_rect = egui::Rect::from_min_size(egui::pos2(64.0, 40.0), egui::vec2(40.0, 96.0));
        let screen_rect = egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(120.0, 180.0));

        let placement = super::probability_hover_popup_placement(
            gate_rect,
            64.0,
            24.0,
            140.0,
            60.0,
            screen_rect,
        );

        assert_eq!(placement.rect.left(), 4.0);
    }

    #[test]
    fn amplitude_hover_popup_header_matches_spec() {
        assert_eq!(
            super::amplitude_hover_popup_header(3, 4),
            "|0011⟩ decimal 3"
        );
    }

    #[test]
    fn amplitude_hover_popup_prefers_above_with_spec_gap() {
        let screen_rect = egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(800.0, 600.0));
        let placement = super::amplitude_hover_popup_placement(
            egui::pos2(200.0, 220.0),
            16.0,
            296.0,
            108.0,
            screen_rect,
        );

        assert_eq!(placement.rect.bottom(), 192.0);
    }

    #[test]
    fn amplitude_hover_popup_flips_below_near_viewport_top() {
        let screen_rect = egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(800.0, 600.0));
        let placement = super::amplitude_hover_popup_placement(
            egui::pos2(200.0, 24.0),
            16.0,
            296.0,
            108.0,
            screen_rect,
        );

        assert_eq!(placement.rect.top(), 52.0);
    }
}
