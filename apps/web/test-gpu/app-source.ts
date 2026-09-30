import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bindingNames, bindingTypes, constants, fingerprints, kernels, type Kernel } from './kernels'
const src = join(__dirname, '../src')
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
const text = (file: string) => stripComments(readFileSync(join(src, file), 'utf8'))
const drift = (message: string): never => {
  throw Error(`host contract drift: ${message}`)
}
export function wgsl(kernel: Kernel) {
  const path = join(src, 'gpu/shaders', `${kernel}.wgsl`)
  return { path, code: readFileSync(path, 'utf8') }
}
type Field = { name: string; offset: number; words: number; type: string }
function rustBody(name: string) {
  for (const file of ['gpu/params.rs', 'gates/params.rs']) {
    const body = text(file).match(new RegExp(`pub\\(crate\\) struct ${name}\\s*\\{([^}]+)\\}`))?.[1]
    if (body) return body
  }
  return drift(`Rust struct ${name} missing`)
}
export function rustStruct(name: string): { fields: Field[]; size: number } {
  const fields: Field[] = []
  let offset = 0
  const body = rustBody(name)
  const pattern = /\s*(?:pub\(crate\)\s+)?(\w+):\s*(u32|i32|f32|\[(?:u32|f32);\s*\d+\]),/g
  const matches = [...body.matchAll(pattern)]
  if (!matches.length || matches.map((m) => m[0]).join('').trim() !== body.trim())
    drift(`unrecognized Rust fields in ${name}`)
  for (const match of matches) {
    const type = match[2]
    const array = type.match(/^\[(u32|f32);\s*(\d+)\]$/)
    const words = array ? Number(array[2]) : 1
    fields.push({ name: match[1], offset, words, type: array ? array[1] : type })
    offset += words * 4
  }
  return { fields, size: offset }
}
export function pack(name: string, values: Record<string, number | number[]>): ArrayBuffer {
  const { fields, size } = rustStruct(name)
  const allowed = new Set(fields.filter((f) => !f.name.startsWith('_')).map((f) => f.name))
  for (const key of Object.keys(values)) if (!allowed.has(key)) drift(`${name}: unknown field ${key}`)
  const result = new ArrayBuffer(size)
  const view = new DataView(result)
  for (const f of fields) {
    const value = f.name.startsWith('_') ? Array(f.words).fill(0) : values[f.name]
    if (value === undefined) drift(`${name}: missing ${f.name}`)
    const items = Array.isArray(value) ? value : [value]
    if (items.length !== f.words) drift(`${name}.${f.name}: expected ${f.words} words`)
    items.forEach((v, i) => {
      if (!Number.isFinite(v)) drift(`${name}.${f.name}: nonfinite`)
      const at = f.offset + i * 4
      if (f.type === 'f32') view.setFloat32(at, v, true)
      else if (f.type === 'i32') view.setInt32(at, v, true)
      else view.setUint32(at, v, true)
    })
  }
  return result
}
const constSources = ['gpu/params.rs', 'gates/params.rs', 'constants.rs']
function evaluate(expr: string, name: string, resolve: (id: string) => number): number {
  const tokens = expr.match(/<<|\d+u?|[A-Za-z_]\w*|[()*+]/g) ?? []
  if (!tokens.length || tokens.join('') !== expr.replace(/\s/g, '')) drift(`unrecognized const ${name}: ${expr}`)
  let i = 0
  const atom = (): number => {
    const t = tokens[i++]
    if (t === '(') {
      const n = shift()
      if (tokens[i++] !== ')') drift(`const ${name}: unmatched paren`)
      return n
    }
    if (!t || !/^(?:\d+u?|[A-Za-z_]\w*)$/.test(t)) return drift(`const ${name}: ${t}`)
    return /^\d+u?$/.test(t) ? Number(t.replace(/u$/, '')) : resolve(t)
  }
  const product = (): number => {
    let n = atom()
    while (tokens[i] === '*') { i++; n *= atom() }
    return n
  }
  const sum = (): number => {
    let n = product()
    while (tokens[i] === '+') { i++; n += product() }
    return n
  }
  const shift = (): number => {
    let n = sum()
    while (tokens[i] === '<<') { i++; n *= 2 ** sum() }
    return n
  }
  const result = shift()
  if (i !== tokens.length || !Number.isSafeInteger(result)) drift(`invalid const ${name}`)
  return result
}
export function rustConst(name: string, seen = new Set<string>()): number {
  if (seen.has(name)) return drift(`recursive const ${name}`)
  seen.add(name)
  for (const file of constSources) {
    const expr = text(file).match(new RegExp(`pub\\(crate\\) const ${name}:\\s*\\w+\\s*=\\s*([^;]+);`))?.[1]
    if (expr) return evaluate(expr, name, (id) => rustConst(id, new Set(seen)))
  }
  return drift(`missing Rust const ${name}`)
}
function wgslFields(code: string, name: string): { fields: Field[]; size: number } {
  const body = code.match(new RegExp(`struct ${name}\\s*\\{([^}]+)\\}`))?.[1]
  if (!body) return drift(`WGSL struct ${name} missing`)
  if (body.includes('@')) drift(`WGSL struct ${name}: member attributes unsupported`)
  const fields: Field[] = []
  let end = 0, maxAlign = 4
  const pattern = /\s*(\w+):\s*(u32|i32|f32|vec2(?:<f32>|f)|vec4(?:<f32>|f))\s*(?:,|(?=\s*$))/g
  const matches = [...body.matchAll(pattern)]
  if (!matches.length || matches.map((m) => m[0]).join('').trim() !== body.trim())
    drift(`unrecognized WGSL fields ${name}`)
  for (const match of matches) {
    const words = match[2].startsWith('vec') ? Number(match[2][3]) : 1
    const align = words * 4
    maxAlign = Math.max(maxAlign, align)
    const offset = Math.ceil(end / align) * align
    fields.push({ name: match[1], offset, words, type: match[2].startsWith('vec') ? 'f32' : match[2] })
    end = offset + words * 4
  }
  return { fields, size: Math.ceil(end / maxAlign) * maxAlign }
}
function compare(rust: string, code: string, shader: string) {
  const a = rustStruct(rust), b = wgslFields(code, shader)
  const words = a.fields.flatMap((f) => Array.from({ length: f.words }, (_, i) => ({
    name: f.name.startsWith('_') ? '_' : f.name, type: f.type, offset: f.offset + i * 4,
  })))
  const actual = b.fields.flatMap((f) => Array.from({ length: f.words }, (_, i) => ({
    name: f.name.startsWith('_') ? '_' : f.name, type: f.type, offset: f.offset + i * 4,
  })))
  if (b.size > a.size || actual.length > words.length ||
    a.fields.slice(b.fields.length).some((f) => !f.name.startsWith('_')) ||
    a.fields.filter((f) => !f.name.startsWith('_')).some((f) =>
      !b.fields.some((g) => g.name === f.name && g.offset === f.offset && g.words === f.words && g.type === f.type)) ||
    actual.some((f, i) => f.offset !== words[i].offset || f.type !== words[i].type ||
      f.name !== words[i].name || f.offset + 4 > a.size))
    drift(`${rust}/${shader}: fields/offsets differ`)
}
export function checkDrift(): void {
  for (const [name, spec] of Object.entries(kernels) as [Kernel, (typeof kernels)[Kernel]][]) {
    const code = stripComments(wgsl(name).code)
    if (spec.uniform) compare(spec.uniform, code, spec.wgsl!)
    const declarations = [...code.matchAll(
      /@group\(0\)\s*@binding\((\d+)\)\s*var<(storage,\s*(?:read|read_write)|uniform)>\s+(\w+):\s*([^;]+);/g,
    )]
    if ([...code.matchAll(/@group\s*\(/g)].length !== declarations.length ||
      declarations.length !== spec.bindings.length || declarations.some((m, i) =>
      Number(m[1]) !== i ||
      (m[2].replace(/\s/g, '') === 'uniform' ? 'u' : m[2].includes('read_write') ? 'rw' : 'r') !== spec.bindings[i].split(':')[1] ||
      !bindingNames[spec.bindings[i].split(':')[0]]?.includes(m[3]) ||
      m[4].replace(/\s/g, '') !== (spec.bindings[i].startsWith('uniform:') ? spec.wgsl : bindingTypes[spec.bindings[i].split(':')[0]]),
    )) drift(`${name}: bindings`)
    const workgroup = Number(code.match(/@workgroup_size\((\d+)\)/)?.[1])
    if (workgroup !== spec.workgroup ||
      ((name === 'state_compute' || name === 'measure_collapse') && workgroup !== rustConst('STATE_WORKGROUP_SIZE')))
      drift(`${name}: workgroup`)
    let depth = 0
    const topLevel = Array.from(code, (char) => {
      if (char === '{') depth++
      const visible = depth === 0 ? char : ' '
      if (char === '}') depth--
      return visible
    }).join('')
    if (depth !== 0) drift(`${name}: unmatched braces`)
    const mapped = (constants as Record<string, Record<string, string>>)[name] ?? {}
    const declared = [...topLevel.matchAll(/\bconst\s+(\w+)\s*(?::\s*\w+)?\s*=\s*([^;]+);/g)]
    if ([...topLevel.matchAll(/\bconst\b/g)].length !== declared.length ||
      declared.length !== Object.keys(mapped).length) drift(`${name}: constants`)
    for (const [, key, expr] of declared) {
      if (!mapped[key]) drift(`${name}: unmapped const ${key}`)
      if (evaluate(expr, key, (id) => mapped[id] ? rustConst(mapped[id]) : drift(`${name}: unknown const ${id}`)) !== rustConst(mapped[key]))
        drift(`${name}: const ${key}`)
    }
  }
  compare('ProbabilityInstance', stripComments(wgsl('probability_aggregate').code), 'ProbabilityInstance')
  if (rustStruct('ProbabilityInstance').size !== 32) drift('ProbabilityInstance stride')
  const normalizeLines = (source: string) => source.split('\n').map((line) => line.trim().replace(/\s+/g, ' ')).join('\n')
  for (const [file, snippet, count] of fingerprints)
    if (`\n${normalizeLines(text(file))}\n`.split(`\n${normalizeLines(snippet)}\n`).length - 1 !== count)
      drift(`${file}: re-derive kernels.ts fingerprint ${snippet}`)
}
