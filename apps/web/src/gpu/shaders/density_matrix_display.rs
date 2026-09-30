//! Density matrix display capture + rendering shaders.
//!
//! Local execution computes reduced density matrices on WebGPU and renders them
//! directly from storage buffers. Production code never maps density values
//! back to the CPU.

pub(in crate::gpu) const DENSITY_CAPTURE_SHADER: &str = include_str!("density_capture.wgsl");

pub(in crate::gpu) const DENSITY_RENDER_SHADER: &str = include_str!("density_render.wgsl");
