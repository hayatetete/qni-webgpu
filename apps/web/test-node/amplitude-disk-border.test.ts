const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const rootDir = path.join(__dirname, '..')
const shaderPath = path.join(rootDir, 'src', 'gpu', 'shaders', 'amplitude_render.wgsl')
const paramsPath = path.join(rootDir, 'src', 'gpu', 'params.rs')
const colorsPath = path.join(rootDir, 'src', 'colors.rs')
const circuitGatesPath = path.join(rootDir, 'src', 'render', 'circuit_gates.rs')
const dragPreviewPath = path.join(rootDir, 'src', 'render', 'circuit_palette', 'drag_preview.rs')

const readRenderShader = async () => fs.readFile(shaderPath, 'utf8')

test('Amplitude render params expose a disk border color', async () => {
  const params = await fs.readFile(paramsPath, 'utf8')

  assert.match(params, /pub\(crate\) disk_border: \[f32; 4\]/)
})

test('Amplitude disk border maps to Flexoki blue-400', async () => {
  const colors = await fs.readFile(colorsPath, 'utf8')

  assert.match(colors, /amplitude_disk_border: blue_400,\s*\/\/ amplitude disk inset border \(Flexoki blue-400\)/)
})

test('Amplitude shader samples the disk border uniform', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /var disk_border = params\.disk_border;/)
})

test('Amplitude disk border is inset by half a pixel', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /let disk_border_radius = radius - 0\.5;/)
})

test('Amplitude disk border does not expand disk coverage', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /let disk_border_alpha = min\(max\(0\.0, disk_border_outer - disk_border_inner\), disk_alpha\);/)
})

test('Amplitude circuit rendering passes the semantic disk border color', async () => {
  const circuitGates = await fs.readFile(circuitGatesPath, 'utf8')

  assert.match(circuitGates, /disk_border: colors\.amplitude_disk_border\.to_normalized_gamma_f32\(\)/)
})

test('Amplitude drag preview passes the semantic disk border color', async () => {
  const dragPreview = await fs.readFile(dragPreviewPath, 'utf8')

  assert.match(dragPreview, /disk_border: colors\.amplitude_disk_border\.to_normalized_gamma_f32\(\)/)
})

export {}
