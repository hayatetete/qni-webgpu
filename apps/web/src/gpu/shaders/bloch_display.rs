//! Bloch vector reduction and overlay WGSL sources.

pub(in crate::gpu) const BLOCH_REDUCE_SHADER: &str = include_str!("bloch_reduce.wgsl");
pub(in crate::gpu) const BLOCH_OVERLAY_SHADER: &str = include_str!("bloch_overlay.wgsl");
