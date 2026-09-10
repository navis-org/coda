/**
 * The Heatmap node's two halves: colour that never enters the key, order that always does.
 *
 * The clustering crosses the Python bridge, which vitest cannot run, so that arm is driven
 * through a stub of `runClusterOrder` — what is pinned is that the node sends a *copy* of the
 * matrix, asks per leading axis, and puts the answer through the same plan as every other
 * order. The arithmetic it stands in for is checked against SciPy by
 * `scripts/probe-heatmap-order.py`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EvalContext, ParamValues } from '../../core/node'
import {
  configurableParams,
  defaultParams,
  hiddenParams,
  makeInferContext,
} from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { reshapingKey } from './heatmap'
import { T, column, tableSchema } from '../../core/types'
import type { MatrixValue, TableValue } from '../../core/values'
import {
  getColumn,
  isMatrixValue,
  isTableValue,
  makeMatrix,
  tableFromRows,
} from '../../core/values'

import type * as LinkageBridge from '../../pyodide/linkage'
import type { ClusterOrderRequest } from '../../pyodide/linkage'
import '../index'

const runClusterOrder = vi.hoisted(() => vi.fn())
vi.mock('../../pyodide/linkage', async (importOriginal) => ({
  ...(await importOriginal<typeof LinkageBridge>()),
  runClusterOrder,
}))

const def = () => requireNodeDef('out.heatmap')

/** One column of a result table, for the assertions below. */
const cells = (table: TableValue, name: string): unknown[] => [...getColumn(table, name)]

function square(): MatrixValue {
  return makeMatrix(
    ['LC4', 'LC10', 'DNp02'],
    ['LC4', 'LC10', 'DNp02'],
    Float64Array.from([1, 9, 2, 0, 0, 3, 5, 1, 0]),
    'synapses',
  )
}

/**
 * A neuron table for the Annotations port: two of the square matrix's three lines named, so
 * every test of the join can see the "some of them" arm without building a second table.
 * `DNp02` is deliberately absent — an unnamed line keeps its own label.
 */
function annotationTable(): TableValue {
  return tableFromRows(
    tableSchema(column('neuronId', 'str'), column('type', 'str')),
    [
      { neuronId: 'LC4', type: 'visual' },
      { neuronId: 'LC10', type: 'visual' },
      { neuronId: 'DNp99', type: 'descending' },
    ],
    'neurons',
  )
}

/**
 * `column` answers the two label pickers rather than `undefined`, because invariant 5 is what
 * `readLabelOptions` obeys: the node never reads `params.matchColumn`, so a stub that returns
 * nothing switches the whole Labels tab off — which is what every test written before the port
 * existed relies on, and why the resolutions are opt-in here.
 */
interface Wiring {
  annotations?: TableValue
  columns?: Record<string, string>
  /** What `inputKey('annotations')` answers — the reshaping cache reads it. */
  inputKey?: string
}

/** The annotation table wired up, which three blocks below ask for. */
const NAMED: Wiring = {
  annotations: annotationTable(),
  columns: { matchColumn: 'neuronId', labelColumn: 'type' },
}

function ctx(
  matrix: MatrixValue,
  params: Record<string, unknown>,
  wiring: Wiring = {},
): EvalContext & { warnings: string[] } {
  const warnings: string[] = []
  return {
    params: { ...defaultParams(def()), ...params } as EvalContext['params'],
    warnings,
    refresh: false,
    reportFetched: () => undefined,
    warn: (m) => warnings.push(m),
    publish: () => undefined,
    input: (port) =>
      port === 'in' ? matrix : port === 'annotations' ? wiring.annotations : undefined,
    inputKey: (port) => (port === 'annotations' ? (wiring.inputKey ?? 'anno-key') : 'in-key'),
    column: (id) => wiring.columns?.[id],
    columns: () => [],
    inputPorts: () => [],
    outputPorts: () => [],
    resolveSource: () => {
      throw new Error('no sources here')
    },
    signal: new AbortController().signal,
    progress: () => {},
  }
}

async function run(matrix: MatrixValue, params: Record<string, unknown>, wiring: Wiring = {}) {
  const c = ctx(matrix, params, wiring)
  const out = (await def().evaluate(c)).out
  if (!isMatrixValue(out)) throw new Error('not a matrix')
  return { out, warnings: c.warnings }
}

// Braces, not a bare expression: `mockReset()` returns the mock, and a hook that returns a
// function has handed vitest a *cleanup* to call after the test — with no arguments, which is
// a third call to the bridge that nothing in the node made.
beforeEach(() => {
  runClusterOrder.mockReset()
})

describe('what reaches the provenance key', () => {
  it('switches the order details off until an order is chosen, and the palette of the other scale', () => {
    /*
     * `configurableParams` is what the card counts and the key reads: a param `visibleIf` has
     * switched off is not a param the node has right now. So the details of an order do not
     * exist until there is one, and exactly one palette list exists at a time.
     */
    const base = defaultParams(def())
    const ids = (params: ParamValues) => configurableParams(def(), params).map((p) => p.id)
    const none = ids(base)
    expect(none).toContain('sortBy')
    expect(none).toContain('palette')
    for (const id of [
      'sortAxis',
      'sortFollow',
      'sortReverse',
      'sortKey',
      'clusterMethod',
      'divergingPalette',
    ]) {
      expect(none, id).not.toContain(id)
    }
    const clustered = ids({ ...base, scale: 'diverging', sortBy: 'cluster' })
    expect(clustered).toContain('divergingPalette')
    expect(clustered).not.toContain('palette')
    expect(clustered).toContain('clusterMethod')
    expect(clustered).toContain('sortFollow')
    expect(clustered).not.toContain('sortKey')
    // Independent axes have nothing to follow.
    expect(ids({ ...base, sortBy: 'total', sortAxis: 'both' })).not.toContain('sortFollow')
    // The card draws the pickers somebody reaches for and keeps the rest for the panel: the
    // colour ends and the log switch are settings you change once, not while reading.
    const advanced = hiddenParams(def(), { ...base, sortBy: 'value' }).map((p) => p.id)
    expect(advanced).toEqual([
      'colorMin',
      'colorMax',
      'logColor',
      'labelAxis',
      'sortAxis',
      'sortFollow',
      'sortReverse',
    ])
    // Neither colour end nor the log switch is offered where it would not mean anything.
    const diverging = configurableParams(def(), { ...base, scale: 'diverging' }).map(
      (p) => p.id,
    )
    expect(diverging).not.toContain('colorMin')
    expect(diverging).not.toContain('logColor')
    expect(diverging).toContain('colorMax')
  })

  it('declares every data tab as changing data and the Colour tab as not', () => {
    expect(def().paramGroups).toEqual([
      { id: 'colour', label: 'Colour' },
      { id: 'labels', label: 'Labels', affectsData: true },
      { id: 'filter', label: 'Filter', affectsData: true },
      { id: 'order', label: 'Order', affectsData: true },
      { id: 'selection', label: 'Selection', affectsData: true },
    ])
    /*
     * Read off the group table rather than listed again: `affectsData` is the tab's promise that
     * downstream nodes go stale, and a param under it that was `presentational` would be a tab
     * saying so over a control that does not. Derived, a fifth group cannot arrive uncovered.
     */
    const data = new Set(
      (def().paramGroups ?? []).filter((g) => g.affectsData).map((g) => g.id),
    )
    expect(data).toEqual(new Set(['labels', 'filter', 'order', 'selection']))
    for (const p of def().params ?? []) {
      const changes = p.group !== undefined && data.has(p.group)
      expect(changes ? !p.presentational : p.presentational === true, p.id).toBe(true)
    }
  })
})

/**
 * The Labels tab. What is being pinned throughout is that this is **data** — the dendrogram's
 * port is the same join drawn instead of written, and the two nodes have to stay on opposite
 * sides of that line.
 */
describe('the annotations port', () => {
  it('writes the names into the matrix, both axes by default', async () => {
    const { out } = await run(square(), {}, NAMED)
    expect(out.rowLabels).toEqual(['visual', 'visual', 'DNp02'])
    expect(out.colLabels).toEqual(['visual', 'visual', 'DNp02'])
    // The cells are untouched and are not copied: only the two label arrays changed.
    expect(Array.from(out.values)).toEqual([1, 9, 2, 0, 0, 3, 5, 1, 0])
  })

  it('names one axis when asked, and leaves the other alone', async () => {
    const { out } = await run(square(), { labelAxis: 'columns' }, NAMED)
    expect(out.rowLabels).toEqual(['LC4', 'LC10', 'DNp02'])
    expect(out.colLabels).toEqual(['visual', 'visual', 'DNp02'])
  })

  it('is off until both pickers resolve, so a wired-but-unset port draws what arrived', async () => {
    const input = square()
    const half = { annotations: annotationTable(), columns: { matchColumn: 'neuronId' } }
    const { out, warnings } = await run(input, {}, half)
    expect(out).toBe(input)
    expect(warnings).toEqual([])
  })

  it('hands the matrix back by identity when nothing is named', async () => {
    const input = square()
    const { out } = await run(input, {}, { columns: NAMED.columns })
    expect(out).toBe(input)
  })

  /*
   * The whole reason this is not the dendrogram's port: the filter reads what the relabel
   * wrote. Typed against the *original* labels it must now match nothing — which is the
   * mismatch a presentational rename would have produced silently, here made a fact of the
   * data that the count on the card explains.
   */
  it('runs before the filter, so the filter matches the names on screen', async () => {
    const { out } = await run(square(), { rowFilter: 'visual' }, NAMED)
    expect(out.rowLabels).toEqual(['visual', 'visual'])
    const original = await run(square(), { rowFilter: 'LC' }, NAMED)
    expect(original.out.rowLabels).toEqual([])
  })

  it('runs before the order, so a total is taken over the named matrix', async () => {
    // Ordering by label: `DNp02` before `visual` under natural order, where the arriving
    // labels would have put `DNp02` after `LC10`.
    const { out } = await run(square(), { sortBy: 'label', sortAxis: 'rows' }, NAMED)
    expect(out.rowLabels).toEqual(['DNp02', 'visual', 'visual'])
  })

  it('counts the lines the table did not name rather than blanking them', async () => {
    const { out, warnings } = await run(square(), { labelAxis: 'rows' }, NAMED)
    expect(out.rowLabels[2]).toBe('DNp02')
    expect(warnings).toEqual([
      '1 of 3 rows are not named by the annotation table and keep their own labels.',
    ])
  })

  it('says which controls to look at when an axis is named by nothing at all', async () => {
    const rois = makeMatrix(['LC4'], ['ME(R)', 'LO(R)'], Float64Array.from([1, 2]))
    const { out, warnings } = await run(rois, {}, NAMED)
    expect(out.colLabels).toEqual(['ME(R)', 'LO(R)'])
    expect(warnings).toEqual([
      'No columns are named by "type", so they keep the labels the matrix arrived with. ' +
        'Check Match on, or narrow Apply to.',
    ])
  })

  it('says nothing when the table named every line', async () => {
    const both = makeMatrix(['LC4', 'LC10'], ['LC4', 'LC10'], Float64Array.from([1, 2, 3, 4]))
    const { warnings } = await run(both, {}, NAMED)
    expect(warnings).toEqual([])
  })
})

/**
 * The rectangle. What is pinned throughout is that a selection is a set of **positions** — the
 * lines under the box and no others — because the Labels tab exists to put one name on many
 * lines, and resolving by name took every one of them.
 */
describe('the selection ports', () => {
  const selected = async (
    params: Record<string, unknown>,
    wiring: Wiring = {},
  ): Promise<{ rows: TableValue; columns: TableValue }> => {
    const c = ctx(square(), params, wiring)
    const out = await def().evaluate(c)
    if (!isTableValue(out.rows) || !isTableValue(out.columns)) throw new Error('not tables')
    return { rows: out.rows, columns: out.columns }
  }

  it('hands back the lines a rectangle covered, one table per axis', async () => {
    const out = await selected({ selection: ['r:0', 'r:1', 'c:2'] })
    expect(cells(out.rows, 'label')).toEqual(['LC4', 'LC10'])
    expect(cells(out.rows, 'index')).toEqual([0, 1])
    expect(cells(out.columns, 'label')).toEqual(['DNp02'])
  })

  /*
   * The bug this shape was chosen for. Naming rows by cell type is one-to-many by design, so a
   * box drawn round one cell of a repeated block must take that line and not its namesakes —
   * which resolving by name could not express.
   */
  it('takes one line of a repeated name, not every line sharing it', async () => {
    const out = await selected({ selection: ['r:0'] }, NAMED)
    expect(cells(out.rows, 'label')).toEqual(['LC4'])
    expect(cells(out.rows, 'relabel')).toEqual(['visual'])
    // Row 1 is also called `visual`, and is not in the box.
    expect(out.rows.length).toBe(1)
  })

  it('is empty with nothing selected, and still has all three columns', async () => {
    const out = await selected({})
    expect(out.rows.length).toBe(0)
    expect(out.rows.schema.columns.map((c) => c.name)).toEqual(['label', 'index', 'relabel'])
  })

  /*
   * The cost of positions, pinned rather than papered over: the Order tab is one tab from the
   * gesture, and a sort under a standing selection re-points it. Visible on the card the instant
   * it happens, which is the trade against a name quietly widening a selection.
   */
  it('names whatever now sits at those positions after a sort', async () => {
    const out = await selected({ selection: ['r:0'], sortBy: 'label', sortAxis: 'rows' })
    // Natural order puts DNp02 first, so position 0 is a different line than it was.
    expect(cells(out.rows, 'label')).toEqual(['DNp02'])
  })

  it('carries no row for a position the matrix no longer reaches', async () => {
    const out = await selected({ selection: ['r:0', 'r:99'], rowFilter: 'LC4' })
    expect(cells(out.rows, 'label')).toEqual(['LC4'])
  })

  /*
   * The `label`/`relabel` split, and the whole reason the arrival names are tracked through both
   * reshaping steps: a selection made by cell type still has to say which *neurons* it caught,
   * and naming by type is one-to-many so nothing at the end could derive it.
   */
  it('carries the arrival label beside the drawn one when the axes are renamed', async () => {
    const out = await selected({ selection: ['r:0', 'r:1'] }, NAMED)
    expect(cells(out.rows, 'label')).toEqual(['LC4', 'LC10'])
    expect(cells(out.rows, 'relabel')).toEqual(['visual', 'visual'])
  })

  it('keeps the pair aligned through a filter and a sort', async () => {
    const out = await selected(
      { selection: ['r:0', 'r:1'], rowFilter: 'visual', sortBy: 'label', sortAxis: 'rows' },
      NAMED,
    )
    // Both LC-rows survive the filter and are sorted by their *drawn* name, which is a tie —
    // so arrival order holds, and each row still carries its own id.
    expect(cells(out.rows, 'label')).toEqual(['LC4', 'LC10'])
    expect(cells(out.rows, 'index')).toEqual([0, 1])
  })

  it('says the same thing twice when nothing renamed the axes', async () => {
    const out = await selected({ selection: ['r:0'] })
    expect(cells(out.rows, 'label')).toEqual(['LC4'])
    expect(cells(out.rows, 'relabel')).toEqual(['LC4'])
  })

  /*
   * `r:LC4` is what a selection stored by the label-based build looks like. It is not a position,
   * and reading it as one would select whichever line happened to sit at a plausible index — so
   * it degrades to nothing, which `decodeMatrixSelection` states as its rule.
   */
  it('ignores an entry that is not a position on a known axis', async () => {
    const out = await selected({ selection: ['x:0', '0', 'r:LC4', 'r:-1', 'r:1.5', 'r:0'] })
    expect(cells(out.rows, 'label')).toEqual(['LC4'])
  })

  /*
   * The selection is in the provenance key, so every drag re-enters `evaluate` — and the
   * reshaping must not re-run. The clustering is where that bites: `runClusterOrder` marshals
   * the whole matrix across the Pyodide bridge and caches nothing, so a rectangle dragged on a
   * clustered heatmap would re-cluster it once per gesture.
   */
  it('does not reshape again when only the selection changed', async () => {
    const input = square()
    runClusterOrder.mockResolvedValue(Int32Array.from([2, 0, 1]))
    const first = await run(input, { sortBy: 'cluster', selection: ['r:0'] })
    const calls = runClusterOrder.mock.calls.length
    expect(calls).toBeGreaterThan(0)

    const second = await run(input, { sortBy: 'cluster', selection: ['r:1', 'r:2'] })
    expect(runClusterOrder.mock.calls.length).toBe(calls)
    // By identity, which is the half the viewer cares about: it keys its extent scan, its fold
    // and its zoom window on the matrix object.
    expect(second.out).toBe(first.out)
  })

  /*
   * The guard the cache key cannot carry itself: it hand-lists three readers, and a fifth data
   * param added to a tab later would simply not be in it — the node would then serve a stale
   * matrix with nothing failing. Asked by *watching which params the key reads*, so the
   * assertion is about coverage rather than about a list somebody has to keep in step.
   */
  it('keys the reshaping on every param that reshapes', async () => {
    const groups = new Set(
      (def().paramGroups ?? []).filter((g) => g.affectsData).map((g) => g.id),
    )
    const reshaping = (def().params ?? [])
      .filter((p) => p.group && groups.has(p.group) && p.group !== 'selection')
      .map((p) => p.id)
    expect(reshaping.length).toBeGreaterThan(4)

    /*
     * Both doors, because a `column` param is read through the resolver and never off `params` —
     * invariant 5 — so watching only one of them reports the two pickers as uncovered when they
     * are the best-covered things in the key.
     */
    const read = new Set<string>()
    const params = defaultParams(def())
    const spy = new Proxy(params, {
      get: (target, key) => {
        read.add(String(key))
        return target[key as string]
      },
    })
    const c = ctx(square(), {})
    reshapingKey({
      ...c,
      params: spy as EvalContext['params'],
      column: (id) => {
        read.add(id)
        return undefined
      },
    })
    expect([...reshaping].filter((id) => !read.has(id))).toEqual([])
  })

  /*
   * The key holds the *resolved* pickers, so two different annotation tables under the same two
   * column names are two different sets of names — and the input matrix is very often the same
   * object across that change, since the two arrive on independent branches.
   */
  it('reshapes again when the annotation table changed under the same pickers', async () => {
    const input = square()
    const columns = { matchColumn: 'neuronId', labelColumn: 'type' }
    const first = await run(input, {}, { annotations: annotationTable(), columns })
    expect(first.out.rowLabels).toEqual(['visual', 'visual', 'DNp02'])

    const other = tableFromRows(
      tableSchema(column('neuronId', 'str'), column('type', 'str')),
      [{ neuronId: 'LC4', type: 'renamed' }],
      'neurons',
    )
    const second = await run(input, {}, { annotations: other, columns, inputKey: 'other' })
    expect(second.out.rowLabels).toEqual(['renamed', 'LC10', 'DNp02'])
  })

  it('reshapes again when something that reshapes changed', async () => {
    const input = square()
    runClusterOrder.mockResolvedValue(Int32Array.from([2, 0, 1]))
    await run(input, { sortBy: 'cluster' })
    const calls = runClusterOrder.mock.calls.length
    await run(input, { sortBy: 'cluster', clusterMetric: 'cosine' })
    expect(runClusterOrder.mock.calls.length).toBeGreaterThan(calls)
  })

  it('replays the warnings it cached, so a card does not lose them on a drag', async () => {
    const input = square()
    const wiring = { annotations: annotationTable(), columns: NAMED.columns }
    const first = await run(input, { labelAxis: 'rows', selection: ['r:0'] }, wiring)
    expect(first.warnings).toHaveLength(1)
    const second = await run(input, { labelAxis: 'rows', selection: ['r:1'] }, wiring)
    expect(second.warnings).toEqual(first.warnings)
  })

  it('leaves the Matrix output untouched by the selection', async () => {
    const withPick = await run(square(), { selection: ['r:0'] })
    expect(withPick.out.rowLabels).toEqual(['LC4', 'LC10', 'DNp02'])
  })
})

/**
 * What the card can say before a Run. `T.matrix()` carries no labels and the ones it will carry
 * are data the run decides, so an unannotated matrix cannot be told from a mistyped one — every
 * line here is about the *table*.
 */
describe('what validate can see at edit time', () => {
  const issues = (params: Record<string, unknown>, annotations?: ReturnType<typeof T.table>) =>
    def().validate?.(
      makeInferContext(def(), { ...defaultParams(def()), ...params } as ParamValues, {
        in: T.matrix(),
        ...(annotations ? { annotations } : {}),
      }),
    ) ?? []

  it('says nothing at all until a table arrives', () => {
    expect(issues({})).toEqual([])
  })

  it('names the two pickers when the port is wired and one is unset', () => {
    const table = T.table(tableSchema(column('neuronId', 'str'), column('type', 'str')))
    expect(issues({ matchColumn: '', labelColumn: '' }, table).join(' ')).toMatch(
      /Match on and Label by are not both set/,
    )
  })

  /*
   * Invariant 8, and it presents identically to having wired nothing: an 18-digit root id in an
   * `i64` column is a float64 that has already lost the digits identifying it, so `idText` drops
   * it and the line keeps its own label. Hence a line here rather than silence.
   */
  it('flags a numeric id column, which silently names nothing wide', () => {
    const table = T.table(tableSchema(column('neuronId', 'i64'), column('type', 'str')))
    expect(issues({}, table).join(' ')).toMatch(/has already lost the digits/)
  })

  it('flags a table asked to name every line after itself', () => {
    const table = T.table(tableSchema(column('type', 'str')))
    expect(issues({ matchColumn: 'type', labelColumn: 'type' }, table).join(' ')).toMatch(
      /every line keeps its own name/,
    )
  })
})

describe('the filter', () => {
  it('keeps the rows and columns whose labels match', async () => {
    const { out } = await run(square(), { rowFilter: 'lc', colFilter: '/^DN' })
    expect(out.rowLabels).toEqual(['LC4', 'LC10'])
    expect(out.colLabels).toEqual(['DNp02'])
    // LC4 → DNp02 is 2 and LC10 → DNp02 is 3.
    expect([...out.values]).toEqual([2, 3])
  })

  it('filters before it sorts, so a total is taken over what is left', async () => {
    /*
     * Over every column the row totals are LC4 12, DNp02 6, LC10 3. Over the DNp02 column alone
     * they are LC10 3, LC4 2, DNp02 0 — a different order, and the one somebody who filtered to
     * that column asked for.
     */
    const { out } = await run(square(), {
      colFilter: 'DNp02',
      sortBy: 'total',
      sortFollow: false,
    })
    expect(out.rowLabels).toEqual(['LC10', 'LC4', 'DNp02'])
  })

  it('is honest about a filter that matches nothing', async () => {
    const { out, warnings } = await run(square(), { rowFilter: 'nobody' })
    expect(out.rowLabels).toEqual([])
    expect(out.colLabels).toEqual(['LC4', 'LC10', 'DNp02'])
    expect(warnings.join('\n')).toContain('No rows match "nobody"')
  })

  it('keeps the axis whole for a pattern that will not compile, and says so', async () => {
    // Half-typed, which is every regex on its way in: the picture must not empty for it.
    const m = square()
    const { out, warnings } = await run(m, { rowFilter: '/^LC[' })
    expect(out).toBe(m)
    expect(warnings.join('\n')).toContain('not a valid regular expression')
  })

  it('passes the matrix through when a filter matches everything', async () => {
    const m = square()
    expect((await run(m, { rowFilter: '/.' })).out).toBe(m)
  })
})

describe('evaluate', () => {
  it('passes the matrix through untouched by default', async () => {
    const m = square()
    const { out } = await run(m, {})
    expect(out).toBe(m)
  })

  it('sorts rows by total and the columns follow', async () => {
    const { out } = await run(square(), { sortBy: 'total' })
    expect(out.rowLabels).toEqual(['LC4', 'DNp02', 'LC10'])
    expect(out.colLabels).toEqual(['LC4', 'DNp02', 'LC10'])
    expect(out.valueLabel).toBe('synapses')
  })

  it('warns and leaves an axis alone when the key names nothing', async () => {
    const m = square()
    const { out, warnings } = await run(m, { sortBy: 'value', sortKey: 'nobody' })
    expect(out).toBe(m)
    expect(warnings.join('\n')).toContain('"nobody"')
  })

  it('clusters through the bridge with a copy, once per leading axis', async () => {
    const m = square()
    // Recorded and asserted after the run: an `expect` inside a mock implementation is where a
    // failure surfaces as a rejected `evaluate` rather than as the assertion that failed.
    const requests: ClusterOrderRequest[] = []
    runClusterOrder.mockImplementation(async (request: ClusterOrderRequest) => {
      requests.push(request)
      return request.axis === 'rows' ? Int32Array.from([2, 0, 1]) : Int32Array.from([1, 2, 0])
    })
    const { out } = await run(m, { sortBy: 'cluster', sortAxis: 'both' })
    expect(requests.map((r) => r.axis)).toEqual(['rows', 'columns'])
    expect(requests[0]).toMatchObject({
      method: 'average',
      metric: 'euclidean',
      rows: 3,
      cols: 3,
    })
    for (const request of requests) {
      // The buffer must not be the upstream value's own: `callPython` transfers it.
      expect(request.values).not.toBe(m.values)
      expect([...request.values]).toEqual([...m.values])
    }
    expect(out.rowLabels).toEqual(['DNp02', 'LC4', 'LC10'])
    expect(out.colLabels).toEqual(['LC10', 'DNp02', 'LC4'])
  })

  it('lets the columns follow a clustered row order, reversed', async () => {
    runClusterOrder.mockResolvedValue(Int32Array.from([2, 0, 1]))
    const { out } = await run(square(), { sortBy: 'cluster', sortReverse: true })
    expect(runClusterOrder).toHaveBeenCalledTimes(1)
    expect(out.rowLabels).toEqual(['LC10', 'LC4', 'DNp02'])
    expect(out.colLabels).toEqual(out.rowLabels)
  })

  it('says which cells the clustering reads as zero', async () => {
    runClusterOrder.mockResolvedValue(Int32Array.from([0, 1, 2]))
    const m = makeMatrix(['a', 'b', 'c'], ['x'], Float64Array.from([1, Number.NaN, 3]))
    const { out, warnings } = await run(m, { sortBy: 'cluster' })
    expect(warnings.join('\n')).toContain('read as 0')
    // …and the cells themselves are not rewritten.
    expect(Number.isNaN(out.values[1])).toBe(true)
  })

  it('does not cross the bridge for an axis with one line', async () => {
    const m = makeMatrix(['only'], ['x', 'y'], Float64Array.from([1, 2]))
    const { out } = await run(m, { sortBy: 'cluster' })
    expect(runClusterOrder).not.toHaveBeenCalled()
    expect(out).toBe(m)
  })
})
