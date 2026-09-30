//! Amplitude display capture + rendering shaders.
//!
//! Both the gate body and popup values consume GPU storage buffers directly;
//! production rendering never maps amplitude values back to the CPU.

pub(in crate::gpu) const AMPLITUDE_CAPTURE_SHADER: &str = include_str!("amplitude_capture.wgsl");

pub(in crate::gpu) const AMPLITUDE_RENDER_SHADER: &str = include_str!("amplitude_render.wgsl");
