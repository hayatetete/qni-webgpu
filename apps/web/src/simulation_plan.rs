//! GPU simulation-plan construction.
//!
//! No quantum math runs here. These helpers only linearise placed gates into
//! the ordered WebGPU op stream, then validate that the fixed GPU buffers can
//! hold the plan. Per AGENTS.md, production simulation remains GPU-only.

mod capacity;
mod column_analysis;
mod linearize;
mod op;

pub(crate) use capacity::{validate_simulation_plan_capacity, SimulationPlanLimits};
pub(crate) use column_analysis::{AnalyzedColumn, ColumnAnalysis, SimulationColumnAnalysis};
pub(crate) use linearize::linearize_ops;
pub(crate) use op::SimulationOp;
