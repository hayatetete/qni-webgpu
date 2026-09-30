import { expect, test, type Page } from '@playwright/test'
import {
  pixelRgbDistance,
  readProbabilityDistributions,
  sampleCanvasPixels,
  waitForStartupReady,
  waitForValue,
  type CanvasPixel,
} from './support/web-spec-helpers'

type CircuitLibrarySnapshot = {
  entries: Array<{ id: string; name: string; circuit_json: string; updated_at: number; locked?: boolean; origin?: { kind: string; locked?: boolean; origin_id?: string } }>
  active_id: string
}

type CircuitPickerRenameGeometry = {
  row_text_left: number
  edit_text_left: number
  selection_text_rgba: [number, number, number, number]
}

type Point = { x: number; y: number }

const BELL_JSON = '{"cols":[["H"]]}'
const GHZ_JSON = '{"cols":[["X"]]}'
const QFT_JSON = '{"cols":[["QFT4"]]}'
const LEGACY_BELL_SAMPLE_JSON = '{"cols":[["H"],["•","X"]]}'
const LEGACY_GHZ_SAMPLE_JSON = '{"cols":[["H"],["•","X"],["•",1,"X"]]}'
const GROVER_PROBABILITY_SLOTS = 5
const GROVER_OUTCOME_COUNT = 32
const GROVER_MARKED_OUTCOME = 27
const GROVER_SUCCESS_THRESHOLD = 0.99
const GROVER_ORACLE_COL = ['Z', '•', '◦', '•', '•']
const GROVER_DIFFUSER_COLS = [
  ['H', 'H', 'H', 'H', 1],
  ['•', '•', '•', '•', 'X'],
  ['H', 'H', 'H', 'H', 1],
]
const GROVER_ITERATION_COLS = [GROVER_ORACLE_COL, ...GROVER_DIFFUSER_COLS, ['Probability5']]
const GROVER_JSON = JSON.stringify({
  cols: [
    ['X', 'X', 'X', 'X', 'X'],
    ['H', 'H', 'H', 'H', 'H'],
    ['Probability5'],
    ...GROVER_ITERATION_COLS,
    ...GROVER_ITERATION_COLS,
    ...GROVER_ITERATION_COLS,
    ...GROVER_ITERATION_COLS,
  ],
})
const STORAGE_KEY = 'qni.circuit_library.v2'
const LEGACY_STORAGE_KEY = 'qni.circuit_library.v1'

const TRIGGER: Point = { x: 80, y: 22 }
const ROW_1: Point = { x: 80, y: 100 }
const ROW_2: Point = { x: 80, y: 136 }
const FOOTER: Point = { x: 90, y: 249 }
const ROW_3: Point = { x: 80, y: 172 }
const ROW_4: Point = { x: 80, y: 208 }
const KEBAB_X = 226
const SUBMENU_X = 320
const MOVE_UP_SUBMENU_Y = 244
const FLEXOKI_BG: CanvasPixel = [255, 252, 240, 255] // Flexoki bg #FFFCF0

const readCircuitColsFromHash = (url: string): unknown[] => {
  const hash = new URL(url).hash.slice(1)
  if (!hash) return []
  return JSON.parse(decodeURIComponent(hash)).cols
}

const snapshot = async (page: Page): Promise<CircuitLibrarySnapshot> => {
  const raw = await page.evaluate(() => {
    const getter = (window as any).__qniCircuitPickerSnapshot
    if (typeof getter !== 'function') throw new Error('__qniCircuitPickerSnapshot hook missing')
    return getter()
  })
  return JSON.parse(raw) as CircuitLibrarySnapshot
}

const waitForSnapshot = async (
  page: Page,
  predicate: (state: CircuitLibrarySnapshot) => boolean,
  description: string,
): Promise<CircuitLibrarySnapshot> => {
  // 反映はフレーム描画をまたぐため、回数で切ると CPU 飽和時に取りこぼす。
  const state = await waitForValue(
    async () => {
      try {
        return await snapshot(page)
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('__qniCircuitPickerSnapshot hook missing')) {
          throw error
        }
        return null
      }
    },
    (value) => value !== null && predicate(value),
    `timed out waiting for circuit picker snapshot: ${description}`,
  )
  if (!state) throw new Error(`circuit picker snapshot missing: ${description}`)
  return state
}

const renameGeometry = async (page: Page): Promise<CircuitPickerRenameGeometry | null> =>
  page.evaluate(() => {
    const raw = (window as any).__qniCircuitPickerRenameGeometryJson
    return typeof raw === 'string' ? JSON.parse(raw) : null
  })

const waitForRenameGeometry = async (page: Page): Promise<CircuitPickerRenameGeometry> => {
  const geometry = await waitForValue(
    () => renameGeometry(page),
    (value) => value !== null,
    'timed out waiting for circuit picker rename geometry',
  )
  if (!geometry) throw new Error('circuit picker rename geometry missing')
  return geometry
}

const storedDocument = async (page: Page): Promise<any> =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), STORAGE_KEY)

const legacySeedLibraryDocument = () => ({
  version: 1,
  activeId: 'ghz',
  circuits: [
    {
      id: 'bell',
      name: 'Bell state',
      json: LEGACY_BELL_SAMPLE_JSON,
      createdAt: 1,
      updatedAt: 1,
      meta: { qubits: 2, columns: 2, gateCount: 3 },
    },
    {
      id: 'ghz',
      name: 'GHZ state',
      json: LEGACY_GHZ_SAMPLE_JSON,
      createdAt: 2,
      updatedAt: 2,
      meta: { qubits: 3, columns: 3, gateCount: 5 },
    },
    {
      id: 'qft-4',
      name: 'QFT 4-qubit',
      json: QFT_JSON,
      createdAt: 3,
      updatedAt: 3,
      meta: { qubits: 4, columns: 1, gateCount: 1 },
    },
  ],
})

const waitForProbabilityEntries = async (page: Page, count: number) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const entries = await readProbabilityDistributions(page)
    if (entries.length === count) return entries
    await page.waitForTimeout(50)
  }
  throw new Error(`timed out waiting for ${count} Probability entries`)
}

const seedLibrary = async (page: Page, activeId = 'bell'): Promise<void> => {
  const library = {
    entries: [
      { id: 'bell', name: 'Bell state', circuit_json: BELL_JSON, updated_at: 1 },
      { id: 'ghz', name: 'GHZ state', circuit_json: GHZ_JSON, updated_at: 2 },
      { id: 'qft', name: 'QFT 4-qubit', circuit_json: QFT_JSON, updated_at: 3 },
    ],
    active_id: activeId,
  }
  await page.evaluate((payload) => {
    const seed = (window as any).__seedCircuits
    if (typeof seed !== 'function') throw new Error('__seedCircuits hook missing')
    seed(JSON.stringify(payload))
  }, library)
  await expect.poll(async () => (await snapshot(page)).active_id).toBe(activeId)
}

const clickCanvas = async (page: Page, point: Point): Promise<void> => {
  const canvas = page.locator('#egui-canvas')
  const box = await canvas.boundingBox()
  if (!box) {
    throw new Error('expected egui canvas to be measurable')
  }
  await page.mouse.click((box?.x ?? 0) + point.x, (box?.y ?? 0) + point.y)
}

test.beforeEach(async ({ page }, testInfo) => {
  await page.goto('/')
  const skipsStateVectorReady = [
    'legacy seeded localStorage gains Grover Search on reload',
    'migrated Grover Search remains locked against low-level deletion',
  ].includes(testInfo.title)
  await waitForStartupReady(page, skipsStateVectorReady ? undefined : { waitForStateVector: true })
})

test('startup current entry preserves the four seeded sample circuits', async ({ page }) => {
  const state = await snapshot(page)

  expect({
    activeId: state.active_id,
    current: state.entries.find((entry) => entry.id === 'current'),
    bell: state.entries.find((entry) => entry.id === 'bell'),
    ghzName: state.entries.find((entry) => entry.id === 'ghz')?.name,
    qftName: state.entries.find((entry) => entry.id === 'qft-4')?.name,
    grover: state.entries.find((entry) => entry.id === 'grover-search'),
    groverHasCustomGateSection: state.entries
      .find((entry) => entry.id === 'grover-search')
      ?.circuit_json.includes('"gates"'),
    hashCols: readCircuitColsFromHash(page.url()),
  }).toMatchObject({
    activeId: 'current',
    current: { name: 'Circuit 1', circuit_json: '{"cols":[]}' },
    bell: { name: 'Bell state', circuit_json: '{"cols":[["H"],["•","X"]]}' },
    ghzName: 'GHZ state',
    qftName: 'QFT 4-qubit',
    grover: { name: 'Grover Search', circuit_json: GROVER_JSON },
    groverHasCustomGateSection: false,
    hashCols: [],
  })
})

test('legacy seeded localStorage gains Grover Search on reload', async ({ page }) => {
  await page.evaluate(({ key, v2Key, document }) => {
    localStorage.removeItem(v2Key)
    localStorage.setItem(key, JSON.stringify(document))
  }, { key: LEGACY_STORAGE_KEY, v2Key: STORAGE_KEY, document: legacySeedLibraryDocument() })
  await page.goto('/')
  await waitForStartupReady(page)

  const state = await waitForSnapshot(page, (next) =>
    next.active_id === 'ghz'
    && next.entries.some((entry) => entry.id === 'grover-search'), 'Grover Search migrated')
  const stored = await storedDocument(page)
  expect({
    activeId: state.active_id,
    grover: state.entries.find((entry) => entry.id === 'grover-search'),
    storedGrover: stored.entries.find((entry: { id: string }) => entry.id === 'grover-search'),
  }).toMatchObject({
    activeId: 'ghz',
    grover: { name: 'Grover Search', circuit_json: GROVER_JSON },
    storedGrover: { name: 'Grover Search', circuit_json: GROVER_JSON, origin: { kind: 'sample', origin_id: 'grover-search' } },
  })
})

test('migrated Grover Search remains locked against low-level deletion', async ({ page }) => {
  await page.evaluate(({ key, v2Key, document }) => {
    localStorage.removeItem(v2Key)
    localStorage.setItem(key, JSON.stringify(document))
  }, { key: LEGACY_STORAGE_KEY, v2Key: STORAGE_KEY, document: legacySeedLibraryDocument() })
  await page.goto('/')
  await waitForStartupReady(page)
  await waitForSnapshot(page, (next) =>
    next.active_id === 'ghz'
    && next.entries.some((entry) => entry.id === 'grover-search'), 'Grover Search migrated')
  await page.evaluate(() => {
    const remove = (window as any).__qniCircuitLibraryDelete
    if (typeof remove !== 'function') throw new Error('__qniCircuitLibraryDelete hook missing')
    try { remove('grover-search') } catch {}
  })

  const stored = await storedDocument(page)
  expect(stored.entries.some((entry: { id: string }) => entry.id === 'grover-search')).toBe(true)
})

test('seeded Grover Search amplifies the Quirk marked outcome', async ({ page }) => {
  const state = await snapshot(page)
  const groverJson = state.entries.find((entry) => entry.id === 'grover-search')?.circuit_json
  if (!groverJson) throw new Error('Grover Search seed missing')

  await page.evaluate((circuitJson) => {
    const seed = (window as any).__seedCircuits
    if (typeof seed !== 'function') throw new Error('__seedCircuits hook missing')
    seed(JSON.stringify({
      entries: [{
        id: 'grover-search',
        name: 'Grover Search',
        circuit_json: circuitJson,
        updated_at: 1,
      }],
      active_id: 'grover-search',
    }))
  }, groverJson)
  await waitForSnapshot(page, (next) => next.active_id === 'grover-search', 'Grover Search active')
  const probabilityEntries = await waitForProbabilityEntries(page, GROVER_PROBABILITY_SLOTS)
  const finalProbability = probabilityEntries.at(-1)?.probabilities ?? []
  const finalPeak = finalProbability.slice(0, GROVER_OUTCOME_COUNT).reduce(
    (best, probability, outcome) =>
      probability > best.probability ? { outcome, probability } : best,
    { outcome: -1, probability: -1 },
  )

  expect({
    probabilitySlots: probabilityEntries.length,
    finalArgMax: finalPeak.outcome,
    finalPeakOver99Percent: finalPeak.probability > GROVER_SUCCESS_THRESHOLD,
  }).toEqual({
    probabilitySlots: GROVER_PROBABILITY_SLOTS,
    finalArgMax: GROVER_MARKED_OUTCOME,
    finalPeakOver99Percent: true,
  })
})

test('localStorage active circuit hydrates the picker and URL on reload', async ({ page }) => {
  await page.evaluate(({ key, v2Key }) => {
    localStorage.removeItem(v2Key)
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      activeId: 'stored-x',
      circuits: [{
        id: 'stored-x',
        name: 'Stored X',
        json: '{"cols":[["X"]]}',
        createdAt: 1,
        updatedAt: 1,
        meta: { qubits: 1, columns: 1, gateCount: 1 },
      }],
    }))
  }, { key: LEGACY_STORAGE_KEY, v2Key: STORAGE_KEY })
  await page.goto('/')
  await waitForStartupReady(page)

  const state = await waitForSnapshot(page, (next) => next.active_id === 'stored-x', 'stored circuit active')
  expect({ entry: state.entries.find((entry) => entry.id === 'stored-x'), hashCols: readCircuitColsFromHash(page.url()) }).toMatchObject({
    entry: { name: 'Stored X', circuit_json: '{"cols":[["X"]]}' },
    hashCols: [['X']],
  })
})

test('startup does not overwrite unsupported localStorage documents', async ({ page }) => {
  await page.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify({ version: 99, active_id: null, entries: [] }))
  }, STORAGE_KEY)
  await page.goto('/')
  await waitForStartupReady(page)

  expect(await storedDocument(page)).toEqual({ version: 99, active_id: null, entries: [] })
})

test('URL payload wins over a different persisted active circuit', async ({ page }) => {
  await page.evaluate(({ key, v2Key }) => {
    localStorage.removeItem(v2Key)
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      activeId: 'stored-x',
      circuits: [{
        id: 'stored-x',
        name: 'Stored X',
        json: '{"cols":[["X"]]}',
        createdAt: 1,
        updatedAt: 1,
        meta: { qubits: 1, columns: 1, gateCount: 1 },
      }],
    }))
  }, { key: LEGACY_STORAGE_KEY, v2Key: STORAGE_KEY })
  await page.goto('/#' + encodeURIComponent('{"cols":[["H"]]}'))
  await waitForStartupReady(page, { waitForStateVector: true })

  const state = await waitForSnapshot(page, (next) => next.active_id === 'current', 'URL payload current entry')
  expect({ activeId: state.active_id, hashCols: readCircuitColsFromHash(page.url()) }).toEqual({
    activeId: 'current',
    hashCols: [['H']],
  })
})

test('low-level localStorage save hook refreshes the live picker', async ({ page }) => {
  const id = await page.evaluate(() => {
    const save = (window as any).__qniCircuitLibrarySave
    if (typeof save !== 'function') throw new Error('__qniCircuitLibrarySave hook missing')
    return save('Saved X', '{"cols":[["X"]]}')
  })

  const state = await waitForSnapshot(page, (next) => next.active_id === id, 'saved circuit active')
  expect({ entry: state.entries.find((entry) => entry.id === id), hashCols: readCircuitColsFromHash(page.url()) }).toMatchObject({
    entry: { id, name: 'Saved X', circuit_json: '{"cols":[["X"]]}' },
    hashCols: [['X']],
  })
})

test('circuit picker opens and selecting another item syncs the URL hash', async ({ page }) => {
  await seedLibrary(page)

  await clickCanvas(page, TRIGGER)
  await page.waitForTimeout(300)
  await clickCanvas(page, ROW_2)

  const selected = await waitForSnapshot(page, (state) => state.active_id === 'ghz', 'selected GHZ entry')
  const hashAfterSelect = readCircuitColsFromHash(page.url())

  await page.reload()
  await waitForStartupReady(page)
  const reloaded = await waitForSnapshot(page, (state) => state.active_id === 'ghz', 'reloaded GHZ entry')
  expect({ selected: selected.active_id, hashAfterSelect, reloaded: reloaded.active_id }).toEqual({
    selected: 'ghz',
    hashAfterSelect: [['X']],
    reloaded: 'ghz',
  })
})

test('Create new circuit adds an empty numbered Circuit entry and makes it active', async ({ page }) => {
  await seedLibrary(page)

  await clickCanvas(page, TRIGGER)
  await page.waitForTimeout(300)
  await clickCanvas(page, FOOTER)

  const state = await waitForSnapshot(page, (next) => next.entries.length === 4, 'new circuit appended')
  const lastEntry = state.entries.at(-1)
  const stored = await storedDocument(page)
  expect({
    lastEntry,
    activeId: state.active_id,
    hashCols: readCircuitColsFromHash(page.url()),
    storedActiveId: stored.active_id,
    storedLast: stored.entries.find((entry: { id: string }) => entry.id === lastEntry?.id),
  }).toMatchObject({
    lastEntry: { name: 'Circuit 1', circuit_json: '{"cols":[]}' },
    activeId: lastEntry?.id,
    hashCols: [],
    storedActiveId: lastEntry?.id,
    storedLast: { name: 'Circuit 1', circuit_json: '{"cols":[]}' },
  })
})

test('Rename action turns the item into an inline editor and commits on Enter', async ({ page }) => {
  await seedLibrary(page)

  await clickCanvas(page, TRIGGER)
  await page.waitForTimeout(300)
  await clickCanvas(page, { x: KEBAB_X, y: ROW_1.y })
  await page.waitForTimeout(300)
  await clickCanvas(page, { x: SUBMENU_X, y: 100 })
  await page.waitForTimeout(300)
  await page.keyboard.type('Renamed Bell')
  await page.keyboard.press('Enter')

  await expect.poll(async () => (await snapshot(page)).entries[0].name).toBe('Renamed Bell')
})

test('Rename action aligns inline editor text and uses Flexoki near-black selected text', async ({ page }) => {
  await seedLibrary(page)

  await clickCanvas(page, TRIGGER)
  await page.waitForTimeout(300)
  await clickCanvas(page, { x: KEBAB_X, y: ROW_1.y })
  await page.waitForTimeout(300)
  await clickCanvas(page, { x: SUBMENU_X, y: 100 })
  await page.waitForTimeout(300)

  const geometry = await waitForRenameGeometry(page)
  expect({
    textStartAligned: Math.abs(geometry.edit_text_left - geometry.row_text_left) <= 0.5,
    selectionTextRgba: geometry.selection_text_rgba,
  }).toEqual({
    textStartAligned: true,
    selectionTextRgba: [0x10, 0x0f, 0x0f, 0xff],
  })
})

test('Rename action accepts Japanese circuit names', async ({ page }) => {
  await seedLibrary(page)

  await clickCanvas(page, TRIGGER)
  await page.waitForTimeout(300)
  await clickCanvas(page, { x: KEBAB_X, y: ROW_1.y })
  await page.waitForTimeout(300)
  await clickCanvas(page, { x: SUBMENU_X, y: 100 })
  await page.waitForTimeout(300)
  await page.keyboard.type('量子回路')
  await page.keyboard.press('Enter')

  await expect.poll(async () => (await snapshot(page)).entries[0].name).toBe('量子回路')
})

test('Move up keeps the displaced bottom item visually idle', async ({ page }) => {
  const library = {
    entries: [
      { id: 'current', name: 'Circuit 1', circuit_json: '{"cols":[]}', updated_at: 0 },
      { id: 'bell', name: 'Bell state', circuit_json: BELL_JSON, updated_at: 1 },
      { id: 'ghz', name: 'GHZ state', circuit_json: GHZ_JSON, updated_at: 2 },
      { id: 'qft', name: 'QFT 4-qubit', circuit_json: QFT_JSON, updated_at: 3 },
    ],
    active_id: 'qft',
  }
  await page.evaluate((payload) => {
    const seed = (window as any).__seedCircuits
    if (typeof seed !== 'function') throw new Error('__seedCircuits hook missing')
    seed(JSON.stringify(payload))
  }, library)
  await waitForSnapshot(page, (state) => state.active_id === 'qft', 'seeded QFT active')

  await clickCanvas(page, TRIGGER)
  await waitForValue(
    () => page.evaluate(() => (window as any).__qniCircuitPickerDropdownGeometryJson ?? null),
    (geometry) => typeof geometry === 'string',
    'circuit picker dropdown paint',
  )
  // egui は移動とクリックの間に描画を挟むと kebab のホバーを認識する。
  await page.mouse.move(KEBAB_X, ROW_4.y)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await clickCanvas(page, { x: KEBAB_X, y: ROW_4.y })
  const submenu = await waitForValue(
    () => page.evaluate(() => {
      const raw = (window as any).__qniCircuitPickerGeometryJson
      return typeof raw === 'string' ? JSON.parse(raw) as { index: number; submenu_left: number; submenu_right: number } : null
    }),
    (geometry) => geometry?.index === 3,
    'QFT kebab submenu paint',
  )
  if (!submenu) throw new Error('QFT kebab submenu missing')
  const moveUp = { x: (submenu.submenu_left + submenu.submenu_right) / 2, y: MOVE_UP_SUBMENU_Y + 36 }
  await page.mouse.move(moveUp.x, moveUp.y)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await clickCanvas(page, moveUp)

  const state = await waitForSnapshot(
    page,
    (next) => next.entries.map((entry) => entry.id).join(',') === 'current,bell,qft,ghz',
    'QFT moved above GHZ',
  )
  const pixels = await sampleCanvasPixels(page, page.locator('#egui-canvas'), [
    { name: 'bottomRowBg', x: 180, y: ROW_4.y },
  ])
  expect({
    order: state.entries.map((entry) => entry.id),
    bottomRowIdle: pixelRgbDistance(pixels.bottomRowBg, FLEXOKI_BG) < 10,
  }).toEqual({
    order: ['current', 'bell', 'qft', 'ghz'],
    bottomRowIdle: true,
  })
})

test('Delete active circuit falls back to the first remaining entry', async ({ page }) => {
  await seedLibrary(page, 'ghz')

  await clickCanvas(page, TRIGGER)
  await page.waitForTimeout(300)
  await clickCanvas(page, { x: KEBAB_X, y: ROW_2.y })
  await page.waitForTimeout(300)
  await clickCanvas(page, { x: SUBMENU_X, y: 302 })

  const state = await waitForSnapshot(page, (next) => next.active_id === 'bell', 'delete fallback active')
  expect({
    activeId: state.active_id,
    entries: state.entries.map((entry) => entry.id),
    hashCols: readCircuitColsFromHash(page.url()),
  }).toEqual({
    activeId: 'bell',
    entries: ['bell', 'qft'],
    hashCols: [['H']],
  })
})
