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
 *    means — and `sources` accumulates, because that list is what keeps two graphs on one
 *    datastack from sharing a cached neuron index.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph, topoSort } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { column, columnNames, tableSchema } from '../../core/types'
import type { TableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import type { AnnotationProvider } from '../../data/annotations/types'
import { CAVE_TABLE_PROVIDER } from '../../data/annotations/caveTable'
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
  g = addNode(g, node('cave', 'annotation.caveTable', { datastack: 'test_stack:1', table: 'nuclei' }))
  if (second) {
    g = addNode(g, node('fly', 'annotation.flyTable', { base: 'main', workspace: '5', ...second }))
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
 * Read off the type's own `schema`, not through `schemaOf` — that answers for a table-shaped
 * type and `undefined` for everything else, so using it here would make every one of the
 * "publishes nothing" assertions below pass whatever the node did.
 */
function published(g: CodaGraph, id: string): TableSchema | undefined {
  const type = inferGraph(g).nodes[id]?.outputs['annotations']
  return type?.kind === 'annotations' ? type.schema : undefined
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

  it('names its own datastack, so annotating one is not a cycle', () => {
    // The whole reason the Dataset input is optional. Wired *and* feeding the dataset back, the
    // pair is two edges between one pair in opposite directions: `topoSort` returns both as
    // `cyclic`, so the cards go dark with no result and nothing naming the cause.
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
    expect(topoSort(g).cyclic).toEqual(['ds', 'cave'])

    // Without the wire — the ordinary shape — the same graph sorts.
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

    const value = sched.output('fly', 'annotations')
    if (value?.kind !== 'annotations') throw new Error('expected annotations')
    // Invariant 3 across a seam nothing type-checks: the claim and the result, column for column.
    expect(value.table.schema.columns).toEqual(published(g, 'fly')?.columns)
  })

  it('keeps a neuron annotated by only one source, and lets the later one win', async () => {
    const sched = scheduler()
    await sched.run(chain({ table: 'info' }), { mode: 'full' })

    const value = sched.output('fly', 'annotations')
    if (value?.kind !== 'annotations') throw new Error('expected annotations')
    // A full outer join: three neurons, not the one both tables carry. Two bases covering
    // different populations is the common case, not the exotic one.
    expect(value.table.data['neuronId']).toEqual([
      '720575940379279312',
      '720575940379279313',
      '720575940379279314',
    ])
    // The shared neuron takes the *later* source's type, which is what the canvas order means.
    expect(value.table.data['type']).toEqual(['LC4', 'LPLC2', 'LC11'])
    // And keeps the earlier source's row for a column the later one has nothing to say about.
    expect(value.table.data['hemilineage']).toEqual([null, 'LC', 'LC'])
  })

  it('accumulates the sources, because that list keys the neuron index', async () => {
    const sched = scheduler()
    await sched.run(chain({ table: 'info' }), { mode: 'full' })

    const value = sched.output('fly', 'annotations')
    if (value?.kind !== 'annotations') throw new Error('expected annotations')
    // Two entries, in chain order. One would let two graphs on one datastack share a cached
    // index, and the first fetched would win for the rest of the session.
    expect(value.sources).toHaveLength(2)
    expect(value.sources[0]).toContain('nuclei')
    expect(value.sources[1]).toContain('info')
  })
})

describe('annotation nodes — refusals', () => {
  const issues = (g: CodaGraph, id: string) =>
    (inferGraph(g).nodes[id]?.issues ?? []).map((i) => i.message).join(' ')

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
    expect(columnNames(published(g, 'fly'))).toEqual(['neuronId', 'type', 'side', 'hemilineage'])
  })
})
