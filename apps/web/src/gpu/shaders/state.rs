//! State-vector compute and render WGSL sources.

pub(in crate::gpu) const STATE_COMPUTE_SHADER: &str = include_str!("state_compute.wgsl");
pub(in crate::gpu) const STATE_RENDER_SHADER: &str = include_str!("state_render.wgsl");
