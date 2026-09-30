const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const rootDir = path.join(__dirname, '..')
const shaderPath = path.join(rootDir, 'src', 'gpu', 'shaders', 'state_render.wgsl')

const readRenderShader = async () => fs.readFile(shaderPath, 'utf8')

test('State vector circles use display-matched anti-alias width', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /let edge = max\(0\.5, length\(fwidth\(input\.panel_local\)\) \* 0\.65\);[\s\S]*cell_contribution\(col, row, input\.panel_local, edge\)/)
})

test('State vector disks draw the display blue inset border', async () => {
  const renderShader = await readRenderShader()

  assert.match(renderShader, /disk_border: vec4<f32>,[\s\S]*let disk_border_radius = fill_radius - 0\.5;[\s\S]*params\.disk_border\.rgb \* hover_mult \* disk_border_alpha/)
})
