const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const rootDir = path.join(__dirname, '..')
const shaderPath = path.join(rootDir, 'src', 'gpu', 'shaders', 'amplitude_render.wgsl')
const circuitGatesPath = path.join(rootDir, 'src', 'render', 'circuit_gates.rs')
const spanResizePath = path.join(rootDir, 'src', 'span_resize.rs')
const dragPreviewPath = path.join(rootDir, 'src', 'render', 'circuit_palette', 'drag_preview.rs')
const gateBodyPath = path.join(rootDir, 'src', 'icons', 'gate_body.rs')
const paramsPath = path.join(rootDir, 'src', 'gpu', 'params.rs')
const amplitudeResourcesPath = path.join(rootDir, 'src', 'gpu', 'resources', 'amplitude_display.rs')
const amplitudeCallbackPath = path.join(rootDir, 'src', 'gpu', 'callbacks', 'amplitude_display.rs')

const readRenderShader = async () => fs.readFile(shaderPath, 'utf8')

test('Amplitude rendering anti-aliases circle SDF edges with derivatives', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /let aa_edge = length\(fwidth\(in\.local\)\);[\s\S]*let edge = max\(0\.5, aa_edge \* 0\.65\);[\s\S]*smoothstep\(radius - edge, radius \+ edge, centered_len\)/)
})

test('Amplitude circle radius maximizes without touching the matrix frame', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /let outline_clearance = 1\.5;[\s\S]*let outline_radius = max\(0\.0, cell \* 0\.5 - half_stroke - outline_clearance\);/)
})

test('Amplitude rendering does not draw internal grid separators', async () => {
  const renderShader = await readRenderShader()

  assert.equal(renderShader.includes('min(gx, gy)'), false)
})

test('Amplitude rendering treats tiny non-zero amplitudes as non-zero outlines', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /select\(params\.outline_zero, params\.outline, mag > 0\.000001\)/)
})

test('Amplitude rendering uses purple background only for dragged non-placeholder instances', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /if \(!placeholder && in\.use_drag_background == 1u\) \{\s*color = params\.drag_background;/)
})

test('Amplitude dragged background preserves the circle interior background', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /var circle_background = params\.background;[\s\S]*color = blend_over\(color, circle_background\);/)
})

test('Amplitude rendering keeps outlines enabled for 15-qubit-sized cells', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /if \(cell >= 3\.0\) \{[\s\S]*var outline = select\(params\.outline_zero, params\.outline, mag > 0\.000001\)/)
})

test('Amplitude circuit rendering delegates visible body selection to span resize', async () => {
  const circuitGates = await fs.readFile(circuitGatesPath, 'utf8')

  assert.match(circuitGates, /let body_rect = span_resize_body_rect\(gate\.kind, gate\.span\.get\(\), gate_rect\);[\s\S]*draw_gate_body\(painter, body_rect, gate\.kind, gate_colors\)/)
})

test('Amplitude span resize body selection uses the matrix draw area', async () => {
  const spanResize = await fs.readFile(spanResizePath, 'utf8')

  assert.match(spanResize, /if kind == GateKind::AmplitudeDisplay \{\s*amplitude_grid_rect\(gate_rect, span\)/)
})

test('Amplitude palette icon omits the square matrix frame', async () => {
  const gateBody = await fs.readFile(gateBodyPath, 'utf8')
  const afterIcon = gateBody.split('fn draw_amplitude_palette_icon')[1] ?? ''
  const iconBody = afterIcon.split(/fn draw_(density|probability)_preview_body/)[0] ?? ''

  assert.equal(iconBody.includes('rect_stroke'), false)
})

test('Amplitude palette icon maximizes without touching the frame', async () => {
  const gateBody = await fs.readFile(gateBodyPath, 'utf8')
  const afterIcon = gateBody.split('fn draw_amplitude_palette_icon')[1] ?? ''
  const iconBody = afterIcon.split(/fn draw_(density|probability)_preview_body/)[0] ?? ''

  assert.match(iconBody, /let outline_clearance = 1\.5;[\s\S]*let outline_radius =\s*\(rect\.width\(\)\.min\(rect\.height\(\)\) \* 0\.5 - half_stroke - outline_clearance\)\.max\(0\.0\);/)
})

test('Amplitude unsnapped Amps1 drag preview uses a foreground GPU callback', async () => {
  const dragPreview = await fs.readFile(dragPreviewPath, 'utf8')

  assert.match(dragPreview, /if gate\.kind == GateKind::AmplitudeDisplay && gate\.span\.get\(\) == 1 \{\s*draw_zero_amplitude_drag_preview\(painter, body_rect, colors\);/)
})

test('Amplitude unsnapped Amps1 drag preview uses a force-zero GPU instance', async () => {
  const dragPreview = await fs.readFile(dragPreviewPath, 'utf8')

  assert.match(dragPreview, /use_drag_background: 1,[\s\S]*force_zero_amplitude: AMPLITUDE_FORCE_ZERO/)
})

test('Amplitude force-zero shader bypasses captured amplitude values', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /var mag = 0\.0;[\s\S]*if \(in\.force_zero_amplitude == AMPLITUDE_MODE_SAMPLE\) \{[\s\S]*amplitude_data\[base \+ 2u \* outcome\]/)
})

test('Amplitude force-zero flag is part of the GPU instance layout', async () => {
  const params = await fs.readFile(paramsPath, 'utf8')

  assert.match(params, /pub\(crate\) force_zero_amplitude: u32/)
})

test('Amplitude force-zero flag is wired to vertex location 7', async () => {
  const resources = await fs.readFile(amplitudeResourcesPath, 'utf8')

  assert.match(resources, /offset: 32,[\s\S]*shader_location: 7,[\s\S]*format: wgpu::VertexFormat::Uint32/)
})

test('Amplitude foreground drag preview uses a separate GPU instance buffer', async () => {
  const callback = await fs.readFile(amplitudeCallbackPath, 'utf8')

  assert.match(callback, /if self\.use_drag_preview_buffer \{[\s\S]*render_drag_instance_buffer[\s\S]*\} else \{[\s\S]*render_instance_buffer/)
})

test('Amplitude foreground drag preview uses a separate GPU params buffer', async () => {
  const callback = await fs.readFile(amplitudeCallbackPath, 'utf8')

  assert.match(callback, /if self\.use_drag_preview_buffer \{[\s\S]*render_drag_params_buffer[\s\S]*\} else if resources\.amplitude\.last_render_params/)
})

test('Amplitude foreground drag preview uses a separate GPU bind group', async () => {
  const callback = await fs.readFile(amplitudeCallbackPath, 'utf8')

  assert.match(callback, /if self\.use_drag_preview_buffer \{[\s\S]*render_drag_bind_group[\s\S]*\} else \{[\s\S]*render_bind_group/)
})

export {}
