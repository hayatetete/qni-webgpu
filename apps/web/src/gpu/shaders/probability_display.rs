//! Probability display marginalize + render WGSL sources.

pub(in crate::gpu) const PROBABILITY_REDUCE_SHADER: &str = include_str!("probability_reduce.wgsl");

pub(in crate::gpu) const PROBABILITY_NORMALIZE_SHADER: &str =
    include_str!("probability_normalize.wgsl");

pub(in crate::gpu) const PROBABILITY_AGGREGATE_SHADER: &str =
    include_str!("probability_aggregate.wgsl");

pub(in crate::gpu) const PROBABILITY_RENDER_SHADER: &str = include_str!("probability_render.wgsl");
