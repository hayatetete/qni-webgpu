const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

const rootDir = path.join(__dirname, '..')
const readText = (filePath: string) => fs.readFile(filePath, 'utf8')
const densityPaletteIconSource = async (): Promise<string> => {
  const source = await readText(path.join(rootDir, 'src', 'icons', 'gate_body.rs'))
  return source.split('fn draw_density_palette_icon')[1].split('fn draw_probability_preview_body')[0]
}
const densityPreviewBodySource = async (): Promise<string> => {
  const source = await readText(path.join(rootDir, 'src', 'icons', 'gate_body.rs'))
  return source.split('fn draw_density_preview_body')[1].split('pub(crate) fn draw_density_palette_icon')[0]
}
const densityRenderShaderSource = async (): Promise<string> => readText(path.join(rootDir, 'src', 'gpu', 'shaders', 'density_render.wgsl'))

test('Density palette icon maximizes circles without touching the frame', async () => {
  const source = await densityPaletteIconSource()

  assert.match(source, /let outline_clearance = 1\.5;[\s\S]*let outline_radius = \(cell \* 0\.5 - outline_stroke \* 0\.5 - outline_clearance\)\.max\(0\.0\);/)
})

test('Density palette icon uses equal half-radius disks', async () => {
  const source = await densityPaletteIconSource()

  assert.match(source, /let disk_radius = outline_radius \* 0\.5;/)
})

test('Density palette icon phase-zero needles point upward', async () => {
  const source = await densityPaletteIconSource()

  assert.match(source, /center \+ egui::vec2\(0\.0, -outline_radius\)/)
})

test('Density palette icon omits the outer square frame', async () => {
  const source = await densityPaletteIconSource()

  assert.doesNotMatch(source, /rect_stroke/)
})

test('Density placed preview keeps the matrix outer frame', async () => {
  const source = await densityPreviewBodySource()

  assert.match(source, /rect_stroke/)
})

test('Density render shader maximizes circles without touching the matrix frame', async () => {
  const source = await densityRenderShaderSource()

  assert.match(source, /let outline_clearance = 1\.5;[\s\S]*let outline_radius = max\(0\.0, cell \* 0\.5 - half_stroke - outline_clearance\);/)
})

export {}
