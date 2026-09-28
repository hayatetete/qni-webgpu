use eframe::egui;
use eframe::{egui_wgpu, wgpu};

use crate::simulation_plan::SimulationOp;

use super::super::params::{RenderParams, MAX_STEP_SNAPSHOT_SLOTS};
use super::super::readback::{
    AmplitudeGpuHandle, BlochGpuHandle, DensityGpuHandle, GpuReadbackState, MeasurementGpuHandle,
    ProbabilityGpuHandle, AMPLITUDE_GPU_HANDLE, BLOCH_GPU_HANDLE, DENSITY_GPU_HANDLE, GPU_READBACK,
    MEASUREMENT_GPU_HANDLE, PROBABILITY_GPU_HANDLE,
};
use super::super::recompute::recompute_state_vector;
use super::super::resources::StateVectorResources;

pub(crate) struct StateVectorResourceBootstrapCallback {
    pub(crate) target_format: wgpu::TextureFormat,
}

impl egui_wgpu::CallbackTrait for StateVectorResourceBootstrapCallback {
    fn prepare(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        _screen_descriptor: &egui_wgpu::ScreenDescriptor,
        _egui_encoder: &mut wgpu::CommandEncoder,
        callback_resources: &mut egui_wgpu::CallbackResources,
    ) -> Vec<wgpu::CommandBuffer> {
        let resources = if callback_resources.contains::<StateVectorResources>() {
            callback_resources
                .get_mut::<StateVectorResources>()
                .expect("StateVectorResources missing")
        } else {
            callback_resources.insert(StateVectorResources::new(device, queue, self.target_format));
            callback_resources
                .get_mut::<StateVectorResources>()
                .expect("StateVectorResources just inserted")
        };
        resources.update_target_format(device, self.target_format);
        Vec::new()
    }

    fn paint(
        &self,
        _info: egui::PaintCallbackInfo,
        _render_pass: &mut wgpu::RenderPass<'static>,
        _callback_resources: &egui_wgpu::CallbackResources,
    ) {
    }
}

pub(crate) struct StateVectorCallback {
    /// Linearised simulation ops for the GPU pipeline. Includes gate
    /// application, readout captures, measurement collapse, and optional
    /// state-panel snapshots. The GPU dispatches them in order; ping-pong of
    /// the state buffers happens for any op that mutates state (gates and
    /// `MeasureCollapse`).
    pub(crate) sim_ops: Vec<SimulationOp>,
    pub(crate) state_count: usize,
    pub(crate) recompute: bool,
    pub(crate) preview_step: Option<usize>,
    pub(crate) snapshot_slot_count: usize,
    pub(crate) target_format: wgpu::TextureFormat,
    /// Pre-built render params describing the panel geometry, cell pitch,
    /// circle radii, and palette. Built by `render.rs` from
    /// `StatePanelLayout` and passed straight through to the uniform
    /// buffer; the fragment shader uses every field to figure out which
    /// cell each pixel belongs to and how to draw its state circle.
    pub(crate) render_params: RenderParams,
}

impl StateVectorCallback {
    fn select_preview_state(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        resources: &mut StateVectorResources,
    ) {
        let available_snapshot_slots = self
            .snapshot_slot_count
            .min(MAX_STEP_SNAPSHOT_SLOTS)
            .min(resources.common.snapshot_cache_slots());
        let Some(step) = self
            .preview_step
            .filter(|step| *step < available_snapshot_slots)
        else {
            resources.active_state = resources.final_state;
            resources.last_preview_step = None;
            return;
        };
        if self.state_count == 0 {
            resources.active_state = resources.final_state;
            resources.last_preview_step = None;
            return;
        }
        if resources.active_state != 2 || resources.last_preview_step != Some(step) {
            let byte_len =
                (self.state_count * std::mem::size_of::<[f32; 2]>()) as wgpu::BufferAddress;
            encoder.copy_buffer_to_buffer(
                &resources.common.state_snapshot_cache_buffer,
                resources.common.snapshot_cache_offset(step),
                &resources.common.state_preview_buffer,
                0,
                byte_len,
            );
            resources.last_preview_step = Some(step);
        }
        resources.active_state = 2;
    }
}

impl egui_wgpu::CallbackTrait for StateVectorCallback {
    fn prepare(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        _screen_descriptor: &egui_wgpu::ScreenDescriptor,
        egui_encoder: &mut wgpu::CommandEncoder,
        callback_resources: &mut egui_wgpu::CallbackResources,
    ) -> Vec<wgpu::CommandBuffer> {
        let resources = if callback_resources.contains::<StateVectorResources>() {
            callback_resources
                .get_mut::<StateVectorResources>()
                .expect("StateVectorResources missing")
        } else {
            callback_resources.insert(StateVectorResources::new(device, queue, self.target_format));
            callback_resources
                .get_mut::<StateVectorResources>()
                .expect("StateVectorResources just inserted")
        };

        resources.update_target_format(device, self.target_format);

        if resources.state.last_render_params != Some(self.render_params) {
            queue.write_buffer(
                &resources.state.render_params_buffer,
                0,
                bytemuck::bytes_of(&self.render_params),
            );
            resources.state.last_render_params = Some(self.render_params);
        }

        let recomputed = self.recompute || resources.state_count != self.state_count;
        if recomputed {
            resources.common.ensure_snapshot_cache_slots(
                device,
                self.snapshot_slot_count.min(MAX_STEP_SNAPSHOT_SLOTS),
            );
        }
        if recomputed
            && !recompute_state_vector(device, queue, resources, &self.sim_ops, self.state_count)
        {
            return Vec::new();
        }
        if recomputed {
            resources.final_state = resources.active_state;
            resources.last_preview_step = None;
        }

        self.select_preview_state(egui_encoder, resources);

        GPU_READBACK.with(|slot| {
            *slot.borrow_mut() = Some(GpuReadbackState {
                device: device.clone(),
                queue: queue.clone(),
                state_buffers: [
                    resources.common.state_buffers[0].clone(),
                    resources.common.state_buffers[1].clone(),
                    resources.common.state_preview_buffer.clone(),
                ],
                state_count: resources.state_count,
                active_state: resources.active_state,
            });
        });
        BLOCH_GPU_HANDLE.with(|slot| {
            *slot.borrow_mut() = Some(BlochGpuHandle {
                device: device.clone(),
                queue: queue.clone(),
                output_buffer: resources.bloch.output_buffer.clone(),
            });
        });
        MEASUREMENT_GPU_HANDLE.with(|slot| {
            *slot.borrow_mut() = Some(MeasurementGpuHandle {
                device: device.clone(),
                queue: queue.clone(),
                aux_buffer: resources.measure.aux_buffer.clone(),
            });
        });
        PROBABILITY_GPU_HANDLE.with(|slot| {
            *slot.borrow_mut() = Some(ProbabilityGpuHandle {
                device: device.clone(),
                queue: queue.clone(),
                output_buffer: resources.probability.output_buffer.clone(),
            });
        });
        AMPLITUDE_GPU_HANDLE.with(|slot| {
            *slot.borrow_mut() = Some(AmplitudeGpuHandle {
                device: device.clone(),
                queue: queue.clone(),
                output_buffer: resources.amplitude.output_buffer.clone(),
                meta_buffer: resources.amplitude.meta_buffer.clone(),
            });
        });
        DENSITY_GPU_HANDLE.with(|slot| {
            *slot.borrow_mut() = Some(DensityGpuHandle {
                device: device.clone(),
                queue: queue.clone(),
                output_buffer: resources.density.output_buffer.clone(),
                meta_buffer: resources.density.meta_buffer.clone(),
            });
        });

        Vec::new()
    }

    fn paint(
        &self,
        _info: egui::PaintCallbackInfo,
        render_pass: &mut wgpu::RenderPass<'static>,
        callback_resources: &egui_wgpu::CallbackResources,
    ) {
        let Some(resources) = callback_resources.get::<StateVectorResources>() else {
            return;
        };
        if self.render_params.cols == 0 || self.render_params.rows == 0 {
            return;
        }
        render_pass.set_pipeline(&resources.state.render_pipeline);
        render_pass.set_bind_group(
            0,
            &resources.state.render_bind_groups[resources.active_state],
            &[],
        );
        render_pass.set_vertex_buffer(0, resources.common.unit_quad_vertex_buffer.slice(..));
        render_pass.set_index_buffer(
            resources.common.unit_quad_index_buffer.slice(..),
            wgpu::IndexFormat::Uint16,
        );
        // One instanced draw of the panel quad — the fragment shader splits
        // it into per-cell circles. Replaces the previous N-instance loop
        // (one quad per cell). See gpu/shaders/state_render.wgsl
        // (STATE_RENDER_SHADER).
        render_pass.draw_indexed(0..resources.common.unit_quad_index_count, 0, 0..1);
    }
}
