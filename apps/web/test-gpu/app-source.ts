import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { constants, fingerprints, kernels, type Kernel } from './kernels'
const src = join(__dirname, '../src')
const text = (file: string) => readFileSync(join(src, file), 'utf8')
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
  const lines = body.matchAll(/(?:pub\(crate\)\s+)?(\w+):\s*(u32|i32|f32|\[(?:u32|f32);\s*\d+\]),/g)
  for (const match of lines) {
    const type = match[2]
    const array = type.match(/^\[(u32|f32);\s*(\d+)\]$/)
    const words = array ? Number(array[2]) : 1
    fields.push({ name: match[1], offset, words, type: array ? array[1] : type })
    offset += words * 4
  }
  if (!fields.length || [...body.matchAll(/^\s*(?:pub\(crate\)\s+)?\w+:\s*/gm)].length !== fields.length)
    drift(`unrecognized Rust fields in ${name}`)
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
export function rustConst(name: string, seen = new Set<string>()): number {
  if (seen.has(name)) return drift(`recursive const ${name}`)
  seen.add(name)
  let expr: string | undefined
  for (const file of constSources) {
    expr = text(file).match(new RegExp(`pub\\(crate\\) const ${name}:\\s*\\w+\\s*=\\s*([^;]+);`))?.[1]
    if (expr) break
  }
  if (!expr) return drift(`missing Rust const ${name}`)
  const tokens = expr.match(/\w+|<<|[()*+]/g)
  if (!tokens || tokens.join('').replace(/\s/g, '') !== expr.replace(/\s/g, ''))
    return drift(`unrecognized const ${name}: ${expr}`)
  let i = 0
  const atom = (): number => {
    const t = tokens[i++]
    if (t === '(') {
      const n = shift()
      if (tokens[i++] !== ')') drift(`const ${name}: unmatched paren`)
      return n
    }
    if (!t || !/^\w+$/.test(t)) return drift(`const ${name}: ${t}`)
    return /^\d+$/.test(t) ? Number(t) : rustConst(t, new Set(seen))
  }
  const product = (): number => {
    let n = atom()
    while (tokens[i] === '*') {
      i++
      n *= atom()
    }
    return n
  }
  const sum = (): number => {
    let n = product()
    while (tokens[i] === '+') {
      i++
      n += product()
    }
    return n
  }
  const shift = (): number => {
    let n = sum()
    while (tokens[i] === '<<') {
      i++
      n *= 2 ** sum()
    }
    return n
  }
  const result = shift()
  if (i !== tokens.length || !Number.isSafeInteger(result)) drift(`invalid const ${name}`)
  return result
}
function wgslFields(code: string, name: string): Field[] {
  const body = code.match(new RegExp(`struct ${name}\\s*\\{([^}]+)\\}`))?.[1]
  if (!body) return drift(`WGSL struct ${name} missing`)
  const fields: Field[] = []
  let end = 0
  for (const match of body.matchAll(/(\w+):\s*(u32|i32|f32|vec2<f32>|vec4<f32>)\s*,/g)) {
    const words = match[2].startsWith('vec') ? Number(match[2][3]) : 1
    const align = words * 4
    const offset = Math.ceil(end / align) * align
    fields.push({ name: match[1], offset, words, type: match[2].includes('f32') ? 'f32' : match[2] })
    end = offset + words * 4
  }
  if (!fields.length || [...body.matchAll(/:\s*/g)].length !== fields.length)
    drift(`unrecognized WGSL fields ${name}`)
  return fields
}
function compare(rust: string, code: string, shader: string) {
  const a = rustStruct(rust),
    b = wgslFields(code, shader)
  const words = a.fields.flatMap((f) =>
    Array.from({ length: f.words }, (_, i) => ({
      name: f.name.startsWith('_') ? '_' : f.name,
      type: f.type,
      offset: f.offset + i * 4,
    })),
  )
  const actual = b.flatMap((f) =>
    Array.from({ length: f.words }, (_, i) => ({
      name: f.name.startsWith('_') ? '_' : f.name,
      type: f.type,
      offset: f.offset + i * 4,
    })),
  )
  if (
    actual.length > words.length ||
    actual.some(
      (f, i) =>
        f.offset !== words[i].offset ||
        f.type !== words[i].type ||
        f.name !== words[i].name ||
        f.offset + 4 > a.size,
    )
  )
    drift(`${rust}/${shader}: fields/offsets differ`)
}
export function checkDrift(): void {
  for (const [name, spec] of Object.entries(kernels) as [Kernel, (typeof kernels)[Kernel]][]) {
    const code = wgsl(name).code
    if (spec.uniform) compare(spec.uniform, code, spec.wgsl!)
    const declarations = [
      ...code.matchAll(
        /@group\(0\)\s*@binding\((\d+)\)\s*var<(storage,\s*(?:read|read_write)|uniform)>\s+(\w+):/g,
      ),
    ]
    const bindingNames: Record<string, string[]> = {
      stateA: ['state_in', 'state'],
      stateB: ['state_out'],
      measurement: ['aux_out', 'aux'],
      probability: ['probability_out', 'probability_data'],
      aggregate: ['aggregate_out'],
      instances: ['instances'],
      bloch: ['bloch_out'],
      amplitude: ['amplitude_data'],
      amplitudeMeta: ['amplitude_meta'],
      density: ['density_data'],
      densityMeta: ['density_meta'],
      uniform: ['params'],
    }
    if (
      declarations.length !== spec.bindings.length ||
      declarations.some(
        (m, i) =>
          Number(m[1]) !== i ||
          (m[2].replace(/\s/g, '') === 'uniform' ? 'u' : m[2].includes('read_write') ? 'rw' : 'r') !==
            spec.bindings[i].split(':')[1] ||
          !bindingNames[spec.bindings[i].split(':')[0]]?.includes(m[3]),
      )
    )
      drift(`${name}: bindings`)
    if (Number(code.match(/@workgroup_size\((\d+)\)/)?.[1]) !== spec.workgroup) drift(`${name}: workgroup`)
    const mapped = (constants as Record<string, Record<string, string>>)[name] ?? {}
    const declared = [...code.matchAll(/const\s+(\w+):\s*u32\s*=\s*([^;]+);/g)]
    if (declared.length !== Object.keys(mapped).length) drift(`${name}: constants`)
    for (const [, key, expr] of declared) {
      if (!mapped[key]) drift(`${name}: unmapped const ${key}`)
      const v = expr.replace(/\b(\w+)\b/g, (token) =>
        /^\d+u?$/.test(token)
          ? token.replace(/u$/, '')
          : mapped[token]
            ? String(rustConst(mapped[token]))
            : token,
      )
      if (!/^[\d\s*+<()]+$/.test(v) || Function(`return ${v}`)() !== rustConst(mapped[key]))
        drift(`${name}: const ${key}`)
    }
  }
  compare('ProbabilityInstance', wgsl('probability_aggregate').code, 'ProbabilityInstance')
  if (rustStruct('ProbabilityInstance').size !== 32) drift('ProbabilityInstance stride')
  for (const [file, snippet] of fingerprints)
    if (
      !text(file)
        .split('\n')
        .some((line) => line.trim().replace(/\s+/g, ' ') === snippet.trim().replace(/\s+/g, ' '))
    )
      drift(`${file}: re-derive kernels.ts fingerprint ${snippet}`)
}
