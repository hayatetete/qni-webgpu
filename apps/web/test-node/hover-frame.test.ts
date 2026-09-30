const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const rootDir = path.join(__dirname, '..')
const hoverFramePath = path.join(rootDir, 'src', 'render', 'hover_frame.rs')
const circuitGatesPath = path.join(rootDir, 'src', 'render', 'circuit_gates.rs')
const palettePanelPath = path.join(rootDir, 'src', 'render', 'circuit_palette', 'panel.rs')
const docsRootDir = path.join(rootDir, '..', '..', 'docs', 'design-system')
const designSystemCssPath = path.join(docsRootDir, 'design-system.css')
const hoverFrameComponentPath = path.join(docsRootDir, 'components', 'hover-frame.js')

export {}

test('Display block host hover frames use zero-radius corners', async () => {
  const source = await fs.readFile(hoverFramePath, 'utf8')

  assert.match(source, /matches!\(\s*kind,\s*GateKind::ProbabilityDisplay\s*\|\s*GateKind::AmplitudeDisplay\s*\|\s*GateKind::DensityMatrixDisplay\s*\)[\s\S]*egui::CornerRadius::ZERO/)
})

test('Circuit gate hover rendering uses the shared hover frame radius for a single-gate group', async () => {
  const source = await fs.readFile(circuitGatesPath, 'utf8')

  assert.match(source, /hover_frame_corner_radius\(first_kind\)[\s\S]*painter\.rect_stroke\(/)
})

test('Palette hover rendering squares the display-block gap with the shared helper', async () => {
  const source = await fs.readFile(palettePanelPath, 'utf8')

  assert.match(source, /painter\.rect_filled\([\s\S]*hover_frame_corner_radius\(gate\)[\s\S]*painter\.rect_filled\([\s\S]*hover_frame_inner_corner_radius\(gate\)/)
})

test('Design-system hover primitive exposes square display-block corners', async () => {
  const [css, component] = await Promise.all([
    fs.readFile(designSystemCssPath, 'utf8'),
    fs.readFile(hoverFrameComponentPath, 'utf8'),
  ])

  assert.match(`${css}\n${component}`, /hover-frame-host--square[\s\S]*border-radius:\s*0;[\s\S]*\[shape="square"\][\s\S]*border-radius:\s*0;/)
})
