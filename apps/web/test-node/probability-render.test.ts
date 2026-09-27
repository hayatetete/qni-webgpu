const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const rootDir = path.join(__dirname, '..')
const shaderPath = path.join(rootDir, 'src', 'gpu', 'shaders', 'probability_display.rs')
const callbackPath = path.join(rootDir, 'src', 'gpu', 'callbacks', 'probability_display.rs')
const resourcesPath = path.join(rootDir, 'src', 'gpu', 'resources', 'probability_display.rs')

const readProbabilityShader = async () => fs.readFile(shaderPath, 'utf8')
const readRenderShader = async () => fs.readFile(path.join(rootDir, 'src', 'gpu', 'shaders', 'probability_render.wgsl'), 'utf8')

test('dense Probability rendering defines a GPU preaggregation shader', async () => {
  const shader = await readProbabilityShader()

  assert.equal(shader.includes('const PROBABILITY_AGGREGATE_SHADER'), true)
})

test('dense Probability rendering samples the aggregate buffer', async () => {
  const renderShader = await readRenderShader()

  assert.equal(renderShader.includes('probability_aggregate_data['), true)
})

test('dense Probability rendering dispatches the aggregate pass', async () => {
  const callback = await fs.readFile(callbackPath, 'utf8')

  assert.equal(callback.includes('probability_aggregate_rows_pass'), true)
})

test('dense Probability aggregation only dispatches for sampled dense instances', async () => {
  const callback = await fs.readFile(callbackPath, 'utf8')

  assert.match(callback, /instance\.render_mode == PROBABILITY_RENDER_MODE_SAMPLE[\s\S]*instance\.span >= PROBABILITY_AGGREGATE_MIN_SPAN/)
})

test('Probability placeholder rendering uses the display placeholder background', async () => {
  const renderShader = await readRenderShader()

  assert.equal(renderShader.includes('params.placeholder_background'), true)
})

test('Probability placeholder rendering returns before sampling probabilities', async () => {
  const renderShader = await readRenderShader()

  assert.equal(renderShader.indexOf('if (input.render_mode == PROBABILITY_RENDER_MODE_PLACEHOLDER)') < renderShader.indexOf('let prob = probability_prob'), true)
})

test('Probability render mode is wired to vertex location 6', async () => {
  const resources = await fs.readFile(resourcesPath, 'utf8')

  assert.match(resources, /offset: 28,[\s\S]*shader_location: 6,[\s\S]*format: wgpu::VertexFormat::Uint32/)
})

test('Probability hover outline snaps fractional rows to a pixel-aligned box', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /fn pixel_row_top[\s\S]*let row_top = pixel_row_top\(hovered_row, row_h, rect_size\.y\)[\s\S]*local\.y < row_top/)
})

test('Probability logarithm hints use their dedicated tx-3 color uniform', async () => {
  const renderShader = await readRenderShader()

  assert.equal(renderShader.includes('color = params.log_hint;'), true)
})

test('Probability borders and row separators keep the border color uniform', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /if \(on_border \|\| on_separator\) \{\s*color = params\.border;/)
})

test('dense Probability rendering avoids fragment-row scans', async () => {
  const renderShader = await readRenderShader()

  assert.equal(/var row = row_lo;[\s\S]*?row = row \+ 1u;/.test(renderShader), false)
})

export {}
