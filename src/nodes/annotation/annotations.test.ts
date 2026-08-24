/**
 * The three annotation source nodes.
 *
 * They had no node-level test at all, which is the gap invariant 5's corollary records about
 * `out.barChart` — a refusal it had carried "since long before, unnoticed because it had no
 * node-level test". What is worth pinning here is the pairing and the two unknowns:
 *
 *  - **The schema half and the value half describe one join.** `chainSchema` publishes what a
 *    downstream picker configures against and `joinAnnotations` builds what actually arrives, and
 *    nothing type-checks the pair. They had already parted company on where the id column sits.
 *  - **Unknown is not empty, twice over.** An *unwired* socket means "nothing upstream", which is
 *    a complete answer; a *wired* one whose columns have not landed means "not yet", which is
 *    not. Publishing half a chain is the partial schema every picker downstream then holds.
 *  - **A later source wins a collision**, which is the whole of what the order on the canvas
 *    means.
 *  - **The chain is ordinary tables**, so a Filter can sit in it — which is the reason there is
 *    no `annotations` type any more, and the one thing a socket type used to forbid.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph, topoSort } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { checkConnection, inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { column, columnNames, tableSchema } from '../../core/types'
import type { TableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { isTableValue, tableFromRows } from '../../core/values'
import type { AnnotationProvider } from '../../data/annotations/types'
import { CAVE_TABLE_PROVIDER } from '../../data/annotations/caveTable'
import { GOOGLE_SHEET_PROVIDER } from '../../data/annotations/googleSheet'
import { SEATABLE_PROVIDER } from '../../data/annotations/seaTable'
// Reached directly rather than through the barrel, which re-exports only what production code
// outside this directory consumes — a registration seam is for a test and for `index.ts` itself.
import { registerAnnotationProvider } from '../../data/annotations/registry'
import '../index'

// ---------------------------------------------------------------------------
// A provider standing in for both real ones
// ---------------------------------------------------------------------------

/** What each stub ref answers with, keyed by the table name in its config. */
const TABLES: Record<string, TableValue> = {
  /*
   * `side` is deliberately typed differently on the two tables. The merged column takes the
   * *later* source's dtype, and the dtype is the only thing that shows which side won — with two
   * `str` columns the collision rule is invisible, so swapping the two arguments of the merge
   * passes every assertion about names and rows.
   */
  nuclei: tableFromRows(
    tableSchema(column('neuronId', 'str'), column('type', 'str'), column('side', 'i64')),
    [
      { neuronId: '720575940379279312', type: 'LC4', side: 1 },
      { neuronId: '720575940379279313', type: 'LC6', side: 1 },
    ],
  ),
  // Overlaps on one neuron and on two columns, and adds one of its own.
  info: tableFromRows(
    tableSchema(
      column('neuronId', 'str'),
      column('type', 'str'),
      column('side', 'str'),
      column('hemilineage', 'str'),
    ),
    [
      { neuronId: '720575940379279313', type: 'LPLC2', side: 'right', hemilineage: 'LC' },
      { neuronId: '720575940379279314', type: 'LC11', side: 'left', hemilineage: 'LC' },
    ],
  ),
}

/** Refs whose columns are deliberately not known yet — the cold-session case. */
let unknown = new Set<string>()

function stub(id: string): AnnotationProvider {
  return {
    id,
    label: id,
    peekColumns: (ref) => {
      const name = String((ref.config as { table?: string }).table ?? '')
      if (unknown.has(name)) return undefined
      return TABLES[name]?.schema
    },
    fetch: (ref) => {
      const name = String((ref.config as { table?: string }).table ?? '')
      const table = TABLES[name]
      if (!table) throw new Error(`no stub table "${name}"`)
      return Promise.resolve(table)
    },
  }
}

beforeEach(() => {
  unknown = new Set()
  // Registered by id, so this replaces the real providers for this file only.
  registerAnnotationProvider(stub(CAVE_TABLE_PROVIDER))
  registerAnnotationProvider(stub(SEATABLE_PROVIDER))
})

// ---------------------------------------------------------------------------

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/**
 * `Custom CAVE`, the dataset node that answers from its own params.
 *
 * Nothing here waits on a listing (invariant 2) or reaches a source, which is what lets these
 * tests be about the annotation nodes rather than about a backend.
 */
function datasetNode(): GraphNode {
  return node('ds', 'dataset.cave', {
    datastack: 'test_stack',
    version: '1',
    neuronTable: 'neurons',
  })
}

/** `CAVE table → FlyTable → Dataset`, the chain the guide describes. */
function chain(second?: Record<string, unknown>): CodaGraph {
  let g = emptyGraph('annotations-test')
  g = addNode(g, datasetNode())
  g = addNode(
    g,
    node('cave', 'annotation.caveTable', { datastack: 'test_stack:1', table: 'nuclei' }),
  )
  if (second) {
    g = addNode(
      g,
      node('fly', 'annotation.flyTable', { base: 'main', workspace: '5', ...second }),
    )
    g = addEdge(g, {
      source: 'cave',
      sourceHandle: 'annotations',
      target: 'fly',
      targetHandle: 'annotations',
    })
  }
  return g
}

/**
 * The schema a node publishes on its Annotations port.
 *
 * Narrowed to `neurons` rather than read through `schemaOf`, which would answer for any tabular
 * type: the kind is half the claim. A source guarantees a `neuronId` — that is what makes its
 * output wireable into a Dataset at all — so a node that quietly published a plain `table` would
 * satisfy every column assertion below and still be wrong.
 */
function published(g: CodaGraph, id: string): TableSchema | undefined {
  const type = inferGraph(g).nodes[id]?.outputs['annotations']
  return type?.kind === 'neurons' ? type.schema : undefined
}

/** Everything a node complains about, as one string. */
function issuesOf(inf: ReturnType<typeof inferGraph>, id: string): string {
  return (inf.nodes[id]?.issues ?? []).map((i) => i.message).join(' ')
}

/** The table a node put on its Annotations port, refusing anything that is not one. */
function produced(sched: Scheduler, id: string): TableValue {
  const value = sched.output(id, 'annotations')
  if (!isTableValue(value)) throw new Error(`expected a table on ${id}, got ${value?.kind}`)
  return value
}

describe('annotation nodes — what a chain publishes', () => {
  it('publishes its own columns with nothing wired', () => {
    expect(columnNames(published(chain(), 'cave'))).toEqual(['neuronId', 'type', 'side'])
  })

  it('merges the chain, the later source winning a name it shares', () => {
    const g = chain({ table: 'info' })
    // One `type` and one `side`, not two of either; `hemilineage` is new and joins the end.
    expect(published(g, 'fly')?.columns.map((c) => `${c.name}:${c.dtype}`)).toEqual([
      'neuronId:str',
      'type:str',
      // `str`, from the later source — the dtype is what says which side won a collision.
      'side:str',
      'hemilineage:str',
    ])
  })

  it('publishes nothing at all while an upstream link’s columns have not landed', () => {
    unknown.add('nuclei')
    const g = chain({ table: 'info' })
    // Its *own* columns are perfectly well known. Publishing them alone is the partial schema —
    // every picker downstream would configure against it and have it change underneath them.
    expect(published(g, 'fly')).toBeUndefined()
  })

  it('publishes nothing while its own columns have not landed', () => {
    unknown.add('info')
    expect(published(chain({ table: 'info' }), 'fly')).toBeUndefined()
  })

  it('reaches the Dataset it is wired to, which is the point of the socket', () => {
    let g = chain()
    g = addEdge(g, {
      source: 'cave',
      sourceHandle: 'annotations',
      target: 'ds',
      targetHandle: 'annotations',
    })
    const dataset = inferGraph(g).nodes['ds']?.outputs['dataset']
    // Substituted, not merged: what the chain produces *is* the dataset's label half.
    expect(dataset?.kind === 'dataset' ? columnNames(dataset.annotations) : []).toEqual([
      'neuronId',
      'type',
      'side',
    ])
  })

  it('takes its datastack from a Dataset it also feeds, which is not a cycle', () => {
    /*
     * The wiring this node's guide describes: a datastack's own table handed back to that
     * datastack as its labels. Two edges between one pair in opposite directions, which at node
     * granularity `topoSort` reads as a cycle — both cards go dark with no result and nothing
     * naming the cause, which is what this did before the Dataset input became a `reference`.
     *
     * Nothing circular is computed. The Dataset publishes its *identity* from its params alone,
     * and that is all this node reads; the annotations it publishes back are the other half. So
     * the reference is excluded from the order and the pair sorts.
     */
    let g = chain()
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'cave',
      targetHandle: 'dataset',
    })
    g = addEdge(g, {
      source: 'cave',
      sourceHandle: 'annotations',
      target: 'ds',
      targetHandle: 'annotations',
    })
    expect(topoSort(g).cyclic).toEqual([])
    // And in an order that runs the annotation node first, since the dataset genuinely waits on
    // its labels while the reference waits on nothing.
    expect(topoSort(g).order.indexOf('cave')).toBeLessThan(topoSort(g).order.indexOf('ds'))

    // The editor has to permit the wire as well as the sort, and it is a separate walk.
    const inf = inferGraph(g)
    expect(
      checkConnection(
        g,
        inf,
        { nodeId: 'ds', portId: 'dataset' },
        { nodeId: 'cave', portId: 'dataset' },
      ).ok,
    ).toBe(true)

    /*
     * What the reference resolves to: the identity, and *not* the annotations schema — which is
     * the honest answer as well as the terminating one, since those annotations are the ones this
     * node is itself about to supply.
     */
    const seen = inf.nodes['cave']?.inputs['dataset']
    expect(seen?.kind).toBe('dataset')
    expect(seen && 'datasetId' in seen ? seen.datasetId : undefined).toBe('test_stack:1')
    expect(seen && 'annotations' in seen ? seen.annotations : undefined).toBeUndefined()

    // Without the wire — the ordinary shape — the same graph still sorts.
    let ok = chain()
    ok = addEdge(ok, {
      source: 'cave',
      sourceHandle: 'annotations',
      target: 'ds',
      targetHandle: 'annotations',
    })
    expect(topoSort(ok).cyclic).toEqual([])
  })
})

describe('annotation nodes — what a chain returns', () => {
  const scheduler = () =>
    new Scheduler({
      resolveSource: (id) => {
        throw new Error(`an annotation node must not reach a data source (asked for ${id})`)
      },
    })

  it('describes the table it builds — the two halves of one join', async () => {
    const g = chain({ table: 'info' })
    const sched = scheduler()
    await sched.run(g, { mode: 'full' })

    const value = produced(sched, 'fly')
    // Invariant 3 across a seam nothing type-checks: the claim and the result, column for column.
    expect(value.schema.columns).toEqual(published(g, 'fly')?.columns)
    // And the kind, which is the other half of the claim — a Dataset takes a table, but only a
    // table carrying neuron ids is one it can use as labels.
    expect(value.kind).toBe('neurons')
  })

  it('keeps a neuron annotated by only one source, and lets the later one win', async () => {
    const sched = scheduler()
    await sched.run(chain({ table: 'info' }), { mode: 'full' })

    const value = produced(sched, 'fly')
    // A full outer join: three neurons, not the one both tables carry. Two bases covering
    // different populations is the common case, not the exotic one.
    expect(value.data['neuronId']).toEqual([
      '720575940379279312',
      '720575940379279313',
      '720575940379279314',
    ])
    // The shared neuron takes the *later* source's type, which is what the canvas order means.
    expect(value.data['type']).toEqual(['LC4', 'LPLC2', 'LC11'])
    // And keeps the earlier source's row for a column the later one has nothing to say about.
    expect(value.data['hemilineage']).toEqual([null, 'LC', 'LC'])
  })

  it('lets a Filter stand in the chain, which is the whole point of it being a table', async () => {
    /*
     * `CAVE table → Filter → FlyTable → Dataset`. An annotation base is somebody's spreadsheet
     * and routinely needs a row dropped before it is used as a connectome's labels; until this
     * the socket carried its own type and no table op could touch it.
     *
     * The join still means what it meant — the Filter is invisible to it — which is what says
     * the chain is about tables rather than about a list of sources.
     */
    let g = emptyGraph('filtered-chain')
    g = addNode(g, datasetNode())
    g = addNode(
      g,
      node('cave', 'annotation.caveTable', { datastack: 'test_stack:1', table: 'nuclei' }),
    )
    g = addNode(g, node('keep', 'core.filter', { column: 'type', op: 'eq', value: 'LC6' }))
    g = addNode(g, node('fly', 'annotation.flyTable', { base: 'main', table: 'info' }))
    g = addEdge(g, {
      source: 'cave',
      sourceHandle: 'annotations',
      target: 'keep',
      targetHandle: 'in',
    })
    g = addEdge(g, {
      source: 'keep',
      sourceHandle: 'out',
      target: 'fly',
      targetHandle: 'annotations',
    })
    g = addEdge(g, {
      source: 'fly',
      sourceHandle: 'annotations',
      target: 'ds',
      targetHandle: 'annotations',
    })

    /*
     * Asserted separately from the run, because `addEdge` takes the handle it is given — the
     * trap `export.test.ts` records about a fixture wired to a socket that never existed. The
     * values flowing proves the join; only this proves the editor would let anybody draw it.
     */
    const inf = inferGraph(g)
    for (const [from, to] of [
      [
        { nodeId: 'cave', portId: 'annotations' },
        { nodeId: 'keep', portId: 'in' },
      ],
      [
        { nodeId: 'keep', portId: 'out' },
        { nodeId: 'fly', portId: 'annotations' },
      ],
    ] as const) {
      expect(checkConnection(g, inf, from, to).ok).toBe(true)
    }

    const sched = scheduler()
    await sched.run(g, { mode: 'full' })

    const value = produced(sched, 'fly')
    // 279312 is gone: the Filter dropped it upstream of the join. The other two survive, one
    // from each side, and the shared neuron still takes the later source's type.
    expect(value.data['neuronId']).toEqual(['720575940379279313', '720575940379279314'])
    expect(value.data['type']).toEqual(['LPLC2', 'LC11'])
    // The earlier source's own column still rides along for the neuron it knew about.
    expect(value.data['side']).toEqual(['right', 'left'])
  })

  it('takes a Select too, which is why the socket is a table and not Neurons', () => {
    /*
     * The case that decides the socket's type, and the one a Filter cannot show: Filter, Sort,
     * Sample and Stack all *preserve* neurons-ness, so `T.neurons()` accepts every one of them
     * and then refuses this — narrowing sixty columns of somebody's base to the four that matter
     * is as ordinary a clean-up as dropping a row, and `core.select` publishes a plain `table`
     * because a selection *may* drop the id.
     *
     * So the requirement moves to `validate`, where it can name the column (`types.ts`'s own
     * rule), and the two halves are asserted together: the wire is allowed, and a Select that
     * really did drop `neuronId` is reported rather than silently accepted.
     */
    let g = emptyGraph('select-chain')
    g = addNode(g, datasetNode())
    g = addNode(
      g,
      node('cave', 'annotation.caveTable', { datastack: 'test_stack:1', table: 'nuclei' }),
    )
    g = addNode(g, node('cols', 'core.select', { columns: ['neuronId', 'type'] }))
    g = addEdge(g, {
      source: 'cave',
      sourceHandle: 'annotations',
      target: 'cols',
      targetHandle: 'in',
    })
    g = addEdge(g, {
      source: 'cols',
      sourceHandle: 'out',
      target: 'ds',
      targetHandle: 'annotations',
    })

    const inf = inferGraph(g)
    // A plain `table`, which is what makes this the deciding case rather than a second Filter.
    expect(inf.nodes['cols']?.outputs['out']?.kind).toBe('table')
    expect(
      checkConnection(
        g,
        inf,
        { nodeId: 'cols', portId: 'out' },
        { nodeId: 'ds', portId: 'annotations' },
      ).ok,
    ).toBe(true)
    expect(issuesOf(inf, 'ds')).toBe('')

    // And the column the type no longer promises is checked where it can be named.
    let dropped = emptyGraph('select-dropped')
    dropped = addNode(dropped, datasetNode())
    dropped = addNode(
      dropped,
      node('cave', 'annotation.caveTable', { datastack: 'test_stack:1', table: 'nuclei' }),
    )
    dropped = addNode(dropped, node('cols', 'core.select', { columns: ['type'] }))
    dropped = addEdge(dropped, {
      source: 'cave',
      sourceHandle: 'annotations',
      target: 'cols',
      targetHandle: 'in',
    })
    dropped = addEdge(dropped, {
      source: 'cols',
      sourceHandle: 'out',
      target: 'ds',
      targetHandle: 'annotations',
    })
    expect(issuesOf(inferGraph(dropped), 'ds')).toContain('neuronId')
  })

  it('carries Clear Cache through to the provider, which the Refresh param used to do', async () => {
    /*
     * The gap that made "Invalidate" look broken: it drops the node's *result*, so `evaluate`
     * runs again — and a re-run reads the base back out of IndexedDB in milliseconds, because
     * that entry is keyed by what was fetched rather than by the graph. `ctx.refresh` is the only
     * thing that crosses to the second layer.
     *
     * It replaced a `refresh` nonce param, whose cost was that re-fetching became an *edit*: in
     * the provenance key, in the saved file, and carried to whoever the graph was sent to. So
     * `dataCache` is asserted here too — it is what puts the button on the card, and a node
     * offering it while ignoring the flag is a control that does nothing.
     */
    const asked: Array<boolean | undefined> = []
    registerAnnotationProvider({
      ...stub(SEATABLE_PROVIDER),
      fetch: (_ref, options) => {
        asked.push(options.refresh)
        return Promise.resolve(TABLES.info!)
      },
    })

    let g = emptyGraph('refresh')
    g = addNode(g, node('fly', 'annotation.flyTable', { base: 'main', table: 'info' }))

    const sched = scheduler()
    await sched.run(g, { mode: 'full' })
    expect(asked).toEqual([undefined])

    sched.clearNodeCache(g, 'fly')
    await sched.run(g, { mode: 'full' })
    expect(asked).toEqual([undefined, true])

    for (const type of ['annotation.flyTable', 'annotation.seaTable', 'annotation.caveTable']) {
      expect(requireNodeDef(type).dataCache).toBe(true)
      // And the nonce is gone rather than left beside its replacement, which would be two ways
      // to say one thing with only one of them wired up.
      expect((requireNodeDef(type).params ?? []).some((p) => p.id === 'refresh')).toBe(false)
    }
  })

  it('refuses a table it cannot match to neurons, rather than running without the labels', async () => {
    /*
     * `validate` only ever produces *warnings*, so the edit-time report above does not stop the
     * node — and the two things a run could do instead are both silent. Ignoring the wire is the
     * control that quietly does nothing; carrying it on leaves every neuron unlabelled with the
     * connectome to blame. Asserted through the scheduler because that is the half `validate`
     * cannot cover.
     */
    let g = emptyGraph('unusable')
    g = addNode(g, datasetNode())
    g = addNode(
      g,
      node('cave', 'annotation.caveTable', { datastack: 'test_stack:1', table: 'nuclei' }),
    )
    g = addNode(g, node('cols', 'core.select', { columns: ['type'] }))
    g = addEdge(g, {
      source: 'cave',
      sourceHandle: 'annotations',
      target: 'cols',
      targetHandle: 'in',
    })
    g = addEdge(g, {
      source: 'cols',
      sourceHandle: 'out',
      target: 'ds',
      targetHandle: 'annotations',
    })

    const sched = scheduler()
    await sched.run(g, { mode: 'full' })
    expect(sched.info('ds').state).toBe('error')
    expect(String(sched.info('ds').error)).toContain('neuronId')
  })

  it('keys a dataset by what produced its annotations, not by which base they came from', async () => {
    /*
     * What replaced the `sources` list. The neuron index, the Explore widget's shared entry and
     * the profile cache are all keyed by this string, and once a Filter is allowed in the chain
     * the refs stop describing the table — two graphs filtering one base differently would share
     * an index, and the first fetched would win for the rest of the session.
     *
     * So the key is the scheduler's own provenance for whatever arrived on the port. Two chains
     * over the *same* base differing only in a filter must not agree.
     */
    const build = (value: string): CodaGraph => {
      let g = emptyGraph(`keyed-${value}`)
      g = addNode(g, datasetNode())
      g = addNode(
        g,
        node('cave', 'annotation.caveTable', { datastack: 'test_stack:1', table: 'nuclei' }),
      )
      g = addNode(g, node('keep', 'core.filter', { column: 'type', op: 'eq', value }))
      g = addEdge(g, {
        source: 'cave',
        sourceHandle: 'annotations',
        target: 'keep',
        targetHandle: 'in',
      })
      return addEdge(g, {
        source: 'keep',
        sourceHandle: 'out',
        target: 'ds',
        targetHandle: 'annotations',
      })
    }

    const keyOf = async (value: string): Promise<string | undefined> => {
      const sched = scheduler()
      await sched.run(build(value), { mode: 'full' })
      const dataset = sched.output('ds', 'dataset')
      return dataset?.kind === 'dataset' ? dataset.annotations?.key : undefined
    }

    const [lc4, lc6] = [await keyOf('LC4'), await keyOf('LC6')]
    expect(lc4).toBeTruthy()
    expect(lc6).not.toEqual(lc4)
    // And the same pipeline twice is the same key, or nothing would ever hit the cache.
    expect(await keyOf('LC4')).toEqual(lc4)
  })
})

describe('annotation nodes — refusals', () => {
  const issues = (g: CodaGraph, id: string) => issuesOf(inferGraph(g), id)

  it('asks for a datastack with neither a wire nor a param, and for a table once it has one', () => {
    let g = emptyGraph('x')
    g = addNode(g, node('cave', 'annotation.caveTable'))
    expect(issues(g, 'cave')).toContain('datastack')

    let named = emptyGraph('x')
    named = addNode(named, node('cave', 'annotation.caveTable', { datastack: 'test_stack:1' }))
    expect(issues(named, 'cave')).toContain('annotation table')

    // A wire answers the same question, so it must not still be asked for.
    let wired = emptyGraph('x')
    wired = addNode(wired, datasetNode())
    wired = addNode(wired, node('cave', 'annotation.caveTable', { table: 'nuclei' }))
    wired = addEdge(wired, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'cave',
      targetHandle: 'dataset',
    })
    expect(issues(wired, 'cave')).toBe('')
  })

  /**
   * The wire, and the field, both saying `datastack:materialization` — the two ways this node was
   * handed something that is not one.
   *
   * Both used to reach `data/annotations/caveTable.ts` and throw `"…" does not name a CAVE
   * dataset. Expected datastack:materialization.` at Run: a sentence about a grammar, two layers
   * below the card, for a wire anybody could make. The Dataset input is a *reference* naming a
   * datastack, so nothing about a neuPrint Dataset makes it refusable at the type level.
   */
  it('refuses a Dataset from another backend, naming it and both ways out', () => {
    let g = emptyGraph('x')
    g = addNode(g, node('np', 'dataset.neuprint', { dataset: 'male-cns:v1.0' }))
    g = addNode(g, node('cave', 'annotation.caveTable', { table: 'nuclei' }))
    g = addEdge(g, {
      source: 'np',
      sourceHandle: 'dataset',
      target: 'cave',
      targetHandle: 'dataset',
    })
    const message = issues(g, 'cave')
    expect(message).toContain('neuPrint')
    expect(message).toContain('wire a CAVE Dataset')
    // The other way out is the field this wire makes inert, and it has to be said: unwiring is
    // not an obvious repair for a node whose own datastack param is ignored while a wire exists.
    expect(message).toContain('unwire')

    // The same wiring from a CAVE dataset is silent, which is the case the check must not catch.
    expect(issues(chain(), 'cave')).toBe('')
  })

  it('asks a typed datastack for its materialization, since the colon is the whole grammar', () => {
    let g = emptyGraph('x')
    g = addNode(
      g,
      node('cave', 'annotation.caveTable', { datastack: 'flywire_fafb_public', table: 'nuclei' }),
    )
    // Names the fix with the datastack already in it, rather than restating the grammar: the help
    // on the field states it and the placeholder is the only thing that shows the colon.
    expect(issues(g, 'cave')).toContain('flywire_fafb_public:783')

    let pinned = emptyGraph('x')
    pinned = addNode(
      pinned,
      node('cave', 'annotation.caveTable', {
        datastack: 'flywire_fafb_public:783',
        table: 'nuclei',
      }),
    )
    expect(issues(pinned, 'cave')).toBe('')
  })

  it('asks for the value column only once Pivot on is set', () => {
    const g = chain()
    expect(issues(g, 'cave')).toBe('')
    let pivoted = emptyGraph('x')
    pivoted = addNode(
      pivoted,
      node('cave', 'annotation.caveTable', {
        datastack: 'test_stack:1',
        table: 'nuclei',
        pivotOn: 'classification_system',
      }),
    )
    expect(issues(pivoted, 'cave')).toContain('value')
  })

  it('does not ask a SeaTable node for a workspace it can work out', () => {
    let g = emptyGraph('x')
    g = addNode(g, node('fly', 'annotation.flyTable', { base: 'main', table: 'info' }))
    /*
     * It used to demand one, which was wrong twice: a base name is very nearly always unique
     * across an account, and the field is `advanced`, so the card was refusing over something it
     * does not draw. The address is still workspace-and-name; what changed is who supplies it.
     */
    expect(issues(g, 'fly')).toBe('')
  })

  it('names a ref with no workspace, so the column picker still fills in', () => {
    // Before the resolution existed, `seaRef` returned undefined without one — so the ordinary
    // configuration published no schema at all and every picker downstream sat empty.
    let g = emptyGraph('x')
    g = addNode(g, node('fly', 'annotation.flyTable', { base: 'main', table: 'info' }))
    expect(columnNames(published(g, 'fly'))).toEqual([
      'neuronId',
      'type',
      'side',
      'hemilineage',
    ])
  })
})

// ---------------------------------------------------------------------------
// Google Sheet
// ---------------------------------------------------------------------------

/**
 * The refs the Google Sheet node built, so what a pasted link *became* can be asserted.
 *
 * The node is the only place the link grammar meets the params, and what it produces is a ref
 * nothing else on the canvas shows — so the alternative is asserting on a fetch URL two layers
 * down, which would pass just as happily with the tab dropped.
 */
let sheetRefs: Array<Record<string, string>> = []

const SHEET_TABLE = tableFromRows(
  tableSchema(column('neuronId', 'str'), column('type', 'str'), column('side', 'str')),
  [{ neuronId: '720575940628857210', type: 'LC4', side: 'left' }],
)

/** Whether the sheet's columns have landed yet — the cold-session case, per ref. */
let sheetKnown = true

function sheetStub(): AnnotationProvider {
  return {
    id: GOOGLE_SHEET_PROVIDER,
    label: 'Google Sheet',
    peekColumns: (ref) => {
      sheetRefs.push(ref.config as Record<string, string>)
      return sheetKnown ? SHEET_TABLE.schema : undefined
    },
    fetch: (ref) => {
      sheetRefs.push(ref.config as Record<string, string>)
      return Promise.resolve(SHEET_TABLE)
    },
  }
}

const SHEET_ID = '1s0Pl9uTJ7Rl0Q1cQeXsp3s5kCsPRk9dU8jZ6yQnB4Vw'
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=1874360847`

/** One Google Sheet node, alone. */
function sheetGraph(params: Record<string, unknown> = {}): CodaGraph {
  return addNode(
    emptyGraph('sheet-test'),
    node('sheet', 'annotation.googleSheet', { sheet: SHEET_URL, ...params }),
  )
}

describe('the Google Sheet node', () => {
  const issues = (g: CodaGraph, id: string) => issuesOf(inferGraph(g), id)
  const scheduler = () =>
    new Scheduler({
      resolveSource: (id) => {
        throw new Error(`an annotation node must not reach a data source (asked for ${id})`)
      },
    })

  beforeEach(() => {
    sheetRefs = []
    sheetKnown = true
    registerAnnotationProvider(sheetStub())
  })

  it('takes the document and the tab out of the pasted link', () => {
    published(sheetGraph(), 'sheet')
    // The Tab field is an override, not the only way to name one: a link copied out of the
    // address bar already says which tab was open, and asking for the number again is asking
    // somebody to read it back out of the string they just pasted.
    expect(sheetRefs[0]).toMatchObject({ documentId: SHEET_ID, gid: '1874360847' })
  })

  it('lets the Tab field override the link, and an empty one mean the first tab', () => {
    published(sheetGraph({ gid: '42' }), 'sheet')
    expect(sheetRefs[0]?.gid).toBe('42')

    sheetRefs = []
    published(sheetGraph({ sheet: SHEET_ID }), 'sheet')
    expect(sheetRefs[0]?.gid).toBe('')
  })

  it('publishes what the provider answers, and nothing before it has answered', () => {
    expect(columnNames(published(sheetGraph(), 'sheet'))).toEqual([
      'neuronId',
      'type',
      'side',
    ])
    sheetKnown = false
    expect(published(sheetGraph(), 'sheet')).toBeUndefined()
  })

  it('refuses a publish-to-web link in the same words the run would', async () => {
    const g = sheetGraph({
      sheet: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQx9/pub?output=csv',
    })
    const badge = issues(g, 'sheet')
    expect(badge).toMatch(/publish to web/i)

    // The same sentence, so a badge and an error do not read as two different problems. It is a
    // *refusal* rather than a warning because there is nothing to fall back to — see
    // `parseSheetLocation`, where the id would otherwise be read as the literal "e".
    const sched = scheduler()
    await sched.run(g, { mode: 'full' })
    expect(sched.info('sheet').state).toBe('error')
    expect(sched.info('sheet').error).toBe(badge)
  })

  it('says nothing about a column while the tab is still unread', () => {
    sheetKnown = false
    // Unknown is not empty. A name that cannot be checked yet is not a name that is wrong, and a
    // check that cries wolf is how a real issue further down the list stops being read.
    expect(issues(sheetGraph({ columns: 'nope' }), 'sheet')).toBe('')
  })

  it('names a column the tab does not have, without refusing over it', async () => {
    const g = sheetGraph({ columns: 'side, nope' })
    expect(issues(g, 'sheet')).toContain('nope')
    // A warning: the other columns are still worth having, and an annotation source that refused
    // would take the whole dataset down with it.
    const sched = scheduler()
    await sched.run(g, { mode: 'full' })
    expect(sched.info('sheet').state).not.toBe('error')
  })

  it('chains, joining onto whatever arrived on its Annotations socket', async () => {
    let g = emptyGraph('sheet-chain')
    g = addNode(
      g,
      node('cave', 'annotation.caveTable', { datastack: 'test_stack:1', table: 'nuclei' }),
    )
    g = addNode(g, node('sheet', 'annotation.googleSheet', { sheet: SHEET_URL }))
    g = addEdge(g, {
      source: 'cave',
      sourceHandle: 'annotations',
      target: 'sheet',
      targetHandle: 'annotations',
    })
    const sched = scheduler()
    await sched.run(g, { mode: 'full' })
    // The later source wins `type` and `side` and the earlier one's neurons still come through,
    // which is `joinAnnotations`' outer join — the sheet is the same node in a chain as any
    // other source, which is the point of it taking an ordinary table.
    const table = produced(sched, 'sheet')
    expect(columnNames(table.schema)).toEqual(['neuronId', 'type', 'side'])
    expect(table.length).toBe(3)
  })
})
