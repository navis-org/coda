import { beforeAll, describe, expect, it } from 'vitest'

import { deserializeGraph, serializeGraph, topoSort } from '../core/graph'
import { inferGraph } from '../core/inference'
import { ID_COLUMN_NAME } from '../core/ids'
import type { AggFn } from '../nodes/lib/tableOps'
import { aggColumnName } from '../nodes/lib/tableOps'
import { Scheduler } from '../core/scheduler'
import { isTableValue } from '../core/values'
import { registerBuiltinSources } from '../data/builtins'
import { requireSource } from '../data/source'
import { L1_CATMAID_SOURCE_ID } from '../data/catmaid/registry'
import '../nodes'
import type { StarterSpec } from './starters'
import { buildStarter } from './starters'

/**
 * Starter graphs — what the New menu and the start page's dataset rail build.
 *
 * The examples this file used to cover are gone: the Workflow Wizard replaced them, and their
 * fixture standing went with them to `wizard/wizard.test.ts`. What is left here is the other
 * hand-built graph in the app, held to the same bar for the same reason — a starter is the first
 * thing a new user sees, and one that reports a type error on open is worse than an empty canvas.
 */
beforeAll(() => {
  /*
   * The whole builtin set rather than a hand-listed subset, which is what this was until a
   * starter began reading things off sources other than the mock — a capability for the
   * Neuroglancer node, and now a neuron schema for `tagColumnFor`. Most of them are registered
   * and never called; what matters is that the list cannot fall behind `builtins.ts`, which is
   * the drift that file's own header exists to prevent.
   */
  registerBuiltinSources({ mockLatencyMs: 0 })
})

function scheduler(): Scheduler {
  return new Scheduler({ resolveSource: (id) => requireSource(id) })
}

describe('starters', () => {
  const spec = { nodeType: 'dataset.mock.opticlobe', label: 'Demo Data' }

  it('builds with no type errors or warnings', () => {
    const inference = inferGraph(buildStarter(spec))
    const issues = Object.entries(inference.nodes).flatMap(([nodeId, node]) =>
      node.issues.map((i) => `${nodeId}: ${i.severity}: ${i.message}`),
    )
    expect(issues).toEqual([])
    expect(inference.ok).toBe(true)
  })

  it('wires Explore between the dataset and a viewer', () => {
    const graph = buildStarter(spec)
    expect(graph.nodes.map((n) => n.type)).toEqual([
      'dataset.mock.opticlobe',
      'neuron.explore',
      'out.table',
    ])
    // The viewer hangs off `selected`, not `hits`: an empty search means the entire dataset,
    // and a starter whose first Run pushes 165k rows into a table teaches the wrong lesson.
    expect(graph.edges.map((e) => e.sourceHandle)).toEqual(['dataset', 'selected'])
  })

  it('adds a Neuroglancer view where the source publishes a scene', () => {
    const graph = buildStarter({
      nodeType: 'dataset.hemibrain',
      label: 'Hemibrain',
      sourceId: 'neuprint',
    })
    expect(graph.nodes.map((n) => n.type)).toContain('out.neuroglancer')

    // Both of its inputs are wired, or it opens as a node that can only complain.
    const ngl = graph.nodes.find((n) => n.type === 'out.neuroglancer')!
    const into = graph.edges.filter((e) => e.target === ngl.id)
    expect(into.map((e) => e.targetHandle).sort()).toEqual(['dataset', 'neurons'])
    // Same selection the table shows, so the two viewers always agree about what is picked.
    expect(into.find((e) => e.targetHandle === 'neurons')?.sourceHandle).toBe('selected')
  })

  it('leaves it out where the source has no bucket to publish one from', () => {
    // The mock generates geometry in the browser. Including the node there would put a
    // permanent warning on the first screen a newcomer sees.
    const graph = buildStarter({ ...spec, sourceId: 'mock' })
    expect(graph.nodes.map((n) => n.type)).not.toContain('out.neuroglancer')
  })

  it('opens on the newest version without pinning one', () => {
    // An empty `version` tracks the latest the server reports; the starter only pins when the
    // caller asked for a specific one.
    const graph = buildStarter(spec)
    const dataset = graph.nodes.find((n) => n.type === 'dataset.mock.opticlobe')
    expect(dataset?.params.version).toBe('')
  })

  it('pins a version when one is given', () => {
    const graph = buildStarter({ ...spec, params: { version: 'mock-1.0' } })
    expect(graph.nodes[0]?.params.version).toBe('mock-1.0')
  })

  it('runs end to end, with an empty selection rather than a failure', async () => {
    const graph = buildStarter(spec)
    const sched = scheduler()
    const summary = await sched.run(graph, { mode: 'full' })

    expect(summary.failed).toEqual([])
    const explore = graph.nodes.find((n) => n.type === 'neuron.explore')!
    const hits = sched.output(explore.id, 'hits')
    const selected = sched.output(explore.id, 'selected')
    // Nothing ticked yet, but the whole dataset matches an empty query.
    expect(isTableValue(hits) && hits.length).toBeGreaterThan(0)
    expect(isTableValue(selected) && selected.length).toBe(0)
  })

  it('survives a save and reload', () => {
    const graph = buildStarter(spec)
    const { graph: restored, warnings } = deserializeGraph(
      JSON.parse(JSON.stringify(serializeGraph(graph))),
    )
    expect(warnings).toEqual([])
    expect(restored.nodes).toHaveLength(graph.nodes.length)
  })

  /*
   * `tagColumn` is `optional`, and an optional picker never takes its declared default — empty
   * is a choice there, which is what makes `out.scatter`'s `idColumn: ''` mean "row index".
   * So a source publishing a free-form bag can only be opened on by *setting* the param, and
   * nothing else in the suite would notice it silently going missing: the node draws fine, the
   * graph runs fine, and the tags are simply absent.
   */
  const tagColumnOf = (starter: StarterSpec) =>
    buildStarter(starter).nodes.find((n) => n.id === 'explore')?.params.tagColumn

  it('opens CATMAID’s annotations as Additional tags, on both instances', () => {
    expect(
      tagColumnOf({ nodeType: 'dataset.catmaid.fafb', label: 'FAFB', sourceId: 'catmaid' }),
    ).toBe('annotations')
    expect(
      tagColumnOf({
        nodeType: 'dataset.catmaid.l1',
        label: 'L1',
        sourceId: L1_CATMAID_SOURCE_ID,
      }),
    ).toBe('annotations')
  })

  it('leaves it unset where the source publishes no such column', () => {
    // Not `''` by accident and `'annotations'` by accident elsewhere: the neuPrint and mock
    // schemas have no free-form bag, and naming a column they lack would draw an empty row.
    expect(tagColumnOf(spec)).toBe('')
    expect(
      tagColumnOf({ nodeType: 'dataset.hemibrain', label: 'Hemibrain', sourceId: 'neuprint' }),
    ).toBe('')
  })
})

/**
 * BANC opts out too, and differently — see `bancStarter` in `starters.ts`.
 *
 * Same problem as FlyWire's, much smaller answer: a CAVE datastack keeps its cell typing in a
 * table, so the generic four nodes open on a list of root ids. BANC's labels are already *in* the
 * datastack, so one CAVE table node is the whole chain — which is why this starter is composed
 * from `genericStarter` rather than written out. These tests are what says the composition still
 * produces the generic half.
 */
describe('the BANC starter', () => {
  const spec = { nodeType: 'dataset.banc', label: 'BANC public', sourceId: 'cave' }

  it('builds clean, and the reference edge is not a cycle', () => {
    const graph = buildStarter(spec)
    const issues = Object.entries(inferGraph(graph).nodes).flatMap(([nodeId, node]) =>
      node.issues.map((i) => `${nodeId}: ${i.severity}: ${i.message}`),
    )
    // Pinned empty, unlike FlyWire's: nothing here waits on a fetch to know its columns, because
    // the CAVE table's kinds come from `unique_string_values` rather than from a run.
    expect(issues).toEqual([])
    expect(inferGraph(graph).ok).toBe(true)

    /*
     * Two edges between one pair in opposite directions, which at node granularity looks like a
     * cycle and is not: the CAVE table reads the datastack's *identity*, which is a function of
     * the dataset node's params alone. `topoSort` sees only the dataflow half.
     */
    expect(topoSort(graph).cyclic).toEqual([])
  })

  it('feeds the dataset its labels from the datastack’s own table', () => {
    const graph = buildStarter(spec)
    const into = (target: string, handle: string) =>
      graph.edges.find((e) => e.target === target && e.targetHandle === handle)

    expect(into('dataset', 'annotations')?.source).toBe('annotations')
    expect(into('annotations', 'dataset')?.source).toBe('dataset')

    /*
     * `codex_annotations` is long-format — one row per (neuron, kind, value) — so `pivotOn` is
     * the whole configuration: the distinct values of `classification_system` become the columns,
     * and `cell_type` arrives renamed to `type`, which is the name Explore's chips, the
     * connectivity tables and Profile's roll-ups all address by literal.
     */
    const table = graph.nodes.find((n) => n.id === 'annotations')!
    expect(table.params.table).toBe('codex_annotations')
    expect(table.params.pivotOn).toBe('classification_system')
    expect(table.params.valueColumn).toBe('cell_type')
    // Left at its default even though on a reference table it names a column of the *referenced*
    // table: same field, same default, and overriding it would suggest it had to differ.
    expect(table.params.idColumn).toBe('pt_root_id')
  })

  it('keeps the generic half it composes from', () => {
    // The point of composing rather than copying. Everything downstream of the dataset is the
    // generic starter's, and a copy would only ever *happen* to still agree with it.
    const banc = buildStarter(spec)
    const generic = buildStarter({ ...spec, nodeType: 'dataset.malecns', sourceId: 'neuprint' })
    /*
     * Between the four nodes the generic shape names, and only those. The Description companion
     * is excluded because `addNodeWithCompanion` mints its id, so two builds of one starter do
     * not agree on it — which is a fact about companions rather than about this comparison.
     */
    const GENERIC = new Set(['dataset', 'explore', 'picked', 'ngl'])
    const shape = (graph: ReturnType<typeof buildStarter>) =>
      graph.edges
        .filter((e) => GENERIC.has(e.source) && GENERIC.has(e.target))
        .map((e) => `${e.source}.${e.sourceHandle}→${e.target}.${e.targetHandle}`)
        .sort()
    expect(shape(banc)).toEqual(shape(generic))
  })

  it('opens with nothing browsed to and nothing ticked', () => {
    // `page` and `selection` are written by the Explore *widget*, so a starter carrying either
    // ships whoever exported the graph's browsing position. The attached graph this was built
    // from carried `page: 15`.
    const explore = buildStarter(spec).nodes.find((n) => n.id === 'explore')!
    expect(explore.params.page).toBe(0)
    expect(explore.params.selection).toEqual([])
  })
})

/**
 * FlyWire FAFB opts out of the generic shape — see `BESPOKE` in `starters.ts`.
 *
 * Held to the same bar as the rest, and to one more: a CAVE datastack takes its cell typing from
 * a table rather than from properties on the neuron, so the point of this starter is the chain
 * that fetches it. A wire missing there is a starter that opens on a list of root ids.
 */
describe('the FlyWire starter', () => {
  const spec = { nodeType: 'dataset.flywire', label: 'FlyWire FAFB', sourceId: 'cave' }

  const issuesIn = (graph: ReturnType<typeof buildStarter>) => {
    const inference = inferGraph(graph)
    return Object.entries(inference.nodes).flatMap(([nodeId, node]) =>
      node.issues.map((i) => `${nodeId}: ${i.severity}: ${i.message}`),
    )
  }

  it('builds with no type errors, and one known warning', () => {
    /*
     * `Column "tag" is gone` is the cold-start state rather than a mistake in the graph, and it
     * is here as a tripwire rather than as an endorsement. `annotationSchemaFrom` deliberately
     * answers the same `undefined` for an unwired socket and for a chain whose columns are not
     * known yet, so `withAnnotations` falls back to the datastack's *own* labels — a schema that
     * is known and, since a chain replaces those labels, known to be wrong. The chain's schema
     * only lands once `Table from URL` has run, so the badge clears on the first Run.
     *
     * Pinned exactly, so a second issue fails this rather than hiding behind the first.
     */
    expect(issuesIn(buildStarter(spec))).toEqual([
      'explore: warning: Column "join_tag" is gone',
    ])
    expect(inferGraph(buildStarter(spec)).ok).toBe(true)
  })

  it('feeds the dataset both label sources, joined', () => {
    const graph = buildStarter(spec)
    const into = (target: string, handle: string) =>
      graph.edges.find((e) => e.target === target && e.targetHandle === handle)

    // Structured fields along the top, community tags along the bottom, joined rather than
    // chained — a chain would let the later source *win* a collision rather than sit beside it.
    expect(into('dataset', 'annotations')?.source).toBe('join')
    expect(into('join', 'left')?.source).toBe('repair')
    expect(into('join', 'right')?.source).toBe('foldTags')
    expect(into('foldTags', 'in')?.source).toBe('tags')
    expect(into('repair', 'in')?.source).toBe('combine')
    expect(into('combine', 'in')?.source).toBe('annotations')

    // `left`, so a neuron nobody has tagged still comes through.
    expect(graph.nodes.find((n) => n.id === 'join')!.params.how).toBe('left')

    // The published file spreads a neuron's type over two columns; coalescing them into `type`
    // is what makes the connectivity tables and Explore's chips read in words.
    const combine = graph.nodes.find((n) => n.id === 'combine')!
    expect(combine.params.columns).toEqual(['cell_type', 'hemibrain_type'])
    expect(combine.params.into).toBe('type')
  })

  it('folds the tags to one row per neuron before the Join sees them', () => {
    /*
     * Not a tidy-up. `neuron_information_v2` is one row per (neuron, tag) and `joinTables` takes
     * the *first* matching row for a repeated key — deliberately, so a many-to-many join cannot
     * multiply the table being annotated. Without this fold a neuron carrying eight community
     * tags shows exactly one of them, with nothing anywhere saying so.
     */
    const fold = buildStarter(spec).nodes.find((n) => n.id === 'foldTags')!
    expect(fold.params.by).toEqual([ID_COLUMN_NAME])
    expect(fold.params.agg).toBe('join')
    expect(fold.params.value).toEqual(['tag'])
  })

  it('narrows the tag table, and points Explore at the column the fold produces', () => {
    const graph = buildStarter(spec)
    // Everything else in `neuron_information_v2` is bookkeeping that would land in every neuron
    // table downstream — and naming the columns is also what lets `peekColumns` answer for a wide
    // table with no fetch at all.
    expect(graph.nodes.find((n) => n.id === 'tags')!.params.columns).toBe('pt_root_id, tag')

    // Through `aggColumnName`, because a literal here is the naming rule stated in a second
    // place — and a wrong `Additional tags` does not fail, it just draws no tag row.
    const fold = graph.nodes.find((n) => n.id === 'foldTags')!
    expect(graph.nodes.find((n) => n.id === 'explore')!.params.tagColumn).toBe(
      aggColumnName(fold.params.agg as AggFn, String(fold.params.value)),
    )
  })

  it('opens with nothing browsed to and nothing ticked', () => {
    // `page` and `selection` are both written by the Explore *widget*, so a starter carrying
    // either is shipping whoever exported the graph's browsing position — and a Neuroglancer
    // panel opening on a neuron nobody chose reads as the app having decided something.
    const explore = buildStarter(spec).nodes.find((n) => n.id === 'explore')!
    expect(explore.params.page).toBe(0)
    expect(explore.params.selection).toEqual([])
  })

  it('reads the annotations through a host that answers a browser', () => {
    // `github.com/.../raw/...` answers 302 with an empty `access-control-allow-origin`, and a
    // browser CORS-checks every hop — so the address the repository's own UI hands you is the
    // one address this cannot use.
    const url = String(buildStarter(spec).nodes.find((n) => n.id === 'annotations')!.params.url)
    expect(url.startsWith('https://raw.githubusercontent.com/')).toBe(true)
  })

  it('names the datastack through references, so neither round trip is a cycle', () => {
    const graph = buildStarter(spec)
    for (const target of ['repair', 'tags']) {
      expect(
        graph.edges.find((e) => e.target === target && e.targetHandle === 'dataset')?.source,
      ).toBe('dataset')
    }
    // Both directions between two pairs. `topoSort` only sees the dataflow half of each.
    expect(topoSort(graph).cyclic).toEqual([])
  })

  it('survives a save and reload', () => {
    const graph = buildStarter(spec)
    const { graph: restored, warnings } = deserializeGraph(
      JSON.parse(JSON.stringify(serializeGraph(graph))),
    )
    expect(warnings).toEqual([])
    expect(restored.nodes).toHaveLength(graph.nodes.length)
  })
})
