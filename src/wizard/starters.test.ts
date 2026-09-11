import { beforeAll, describe, expect, it } from 'vitest'

import type { CodaGraph } from '../core/graph'
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
import { COLLAPSED_SIZE, collapsedView } from '../layout/collapse'
import { CAPTION_GAP } from '../layout/companions'
import { cardWidth } from '../layout/elkGraph'
import '../nodes'
import type { StarterSpec } from './starters'
import { buildStarter } from './starters'

/**
 * Starter graphs — what the New menu and the start page's dataset rail build.
 *
 * A starter is the Workflow Wizard's output now (`starters.ts`), so the fixture standing every
 * wizard graph has is `wizard.test.ts`'s. What is here is what a starter adds to it: the
 * dataset node it was asked for, the viewers its source can draw, and the two CAVE datasets that
 * used to be bespoke graphs and are now the same answer with a chain in front — held to what
 * those graphs were held to, because a starter is the first thing a new user sees and one that
 * reports a type error on open is worse than an empty canvas.
 *
 * Node ids are the wizard's: `ds`, `explore`, `view` (the Table), `view2` (Neuroglancer).
 */
beforeAll(() => {
  /*
   * The whole builtin set rather than a hand-listed subset: a starter reads things off sources
   * other than the mock — a capability for the Neuroglancer node, a neuron schema for
   * `exploreTagColumn` — and the list must not fall behind `builtins.ts`.
   */
  registerBuiltinSources({ mockLatencyMs: 0 })
})

function scheduler(): Scheduler {
  return new Scheduler({ resolveSource: (id) => requireSource(id) })
}

function issuesIn(graph: CodaGraph): string[] {
  return Object.entries(inferGraph(graph).nodes).flatMap(([nodeId, node]) =>
    node.issues.map((i) => `${nodeId}: ${i.severity}: ${i.message}`),
  )
}

const byId = (graph: CodaGraph, id: string) => graph.nodes.find((n) => n.id === id)

describe('starters', () => {
  const spec = { nodeType: 'dataset.mock.opticlobe', label: 'Demo Data' }

  it('builds with no type errors or warnings', () => {
    const graph = buildStarter(spec)
    expect(issuesIn(graph)).toEqual([])
    expect(inferGraph(graph).ok).toBe(true)
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

  it('is named for what it is for, and carries no overview note', () => {
    // The wizard's overview describes four answers nobody opening `New ▸ …` was asked. Its hints
    // stay, because they are about the two cards somebody has to act on.
    const graph = buildStarter(spec)
    expect(graph.meta?.name).toBe('Demo Data')
    expect(graph.meta?.description).toBe(
      'Browsing Demo Data. Search in the Explore Dataset node, tick neurons, then Run.',
    )
    expect(graph.nodes.some((n) => n.type === 'note.text')).toBe(false)
    expect(byId(graph, 'explore')?.hints?.length).toBe(1)
    expect(byId(graph, 'view')?.hints?.length).toBe(1)
  })

  it('adds a Neuroglancer view where the source publishes a scene', () => {
    const graph = buildStarter({
      nodeType: 'dataset.hemibrain',
      label: 'Hemibrain',
      sourceId: 'neuprint',
    })
    const ngl = graph.nodes.find((n) => n.type === 'out.neuroglancer')!
    expect(ngl).toBeDefined()

    // Both of its inputs are wired, or it opens as a node that can only complain.
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
    expect(byId(buildStarter(spec), 'ds')?.params.version).toBe('')
  })

  it('pins a version when one is given', () => {
    const graph = buildStarter({ ...spec, params: { version: 'mock-1.0' } })
    expect(byId(graph, 'ds')?.params.version).toBe('mock-1.0')
  })

  it('opens a custom dataset node as itself, with the params it was given', () => {
    /*
     * The New menu's escape hatches are node types that are no family, and the wizard's first
     * question only ever names a family — so this is what `BuildOptions.dataset` is for. The node
     * has to arrive as the type asked for, holding the server, or the starter silently opened
     * somebody's custom neuPrint as a default one.
     */
    const graph = buildStarter({
      nodeType: 'dataset.neuprint',
      label: 'Custom neuPrint',
      sourceId: 'neuprint',
      params: { server: 'neuprint.example.org', dataset: 'mine:v1' },
    })
    const ds = byId(graph, 'ds')!
    expect(ds.type).toBe('dataset.neuprint')
    expect(ds.params.server).toBe('neuprint.example.org')
    expect(ds.params.dataset).toBe('mine:v1')
    expect(graph.edges.some((e) => e.source === 'ds' && e.target === 'explore')).toBe(true)
  })

  it('runs end to end, with an empty selection rather than a failure', async () => {
    const graph = buildStarter(spec)
    const sched = scheduler()
    const summary = await sched.run(graph, { mode: 'full' })

    expect(summary.failed).toEqual([])
    const hits = sched.output('explore', 'hits')
    const selected = sched.output('explore', 'selected')
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
    byId(buildStarter(starter), 'explore')?.params.tagColumn

  it('opens CATMAID’s annotations as Additional tags, on both instances and the custom node', () => {
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
    // No family, so the source is the spec's own — which is why `BuildOptions.dataset` carries it.
    expect(
      tagColumnOf({
        nodeType: 'dataset.catmaid',
        label: 'Custom CATMAID',
        sourceId: 'catmaid',
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
 * BANC: the generic starter with its one-card chain in front.
 *
 * A CAVE datastack keeps its cell typing in a table, so without the chain the starter opens on
 * a list of root ids. BANC's labels are already *in* the datastack, so one CAVE table node is
 * the whole chain, and `foldChain` leaves a single card unfolded.
 */
describe('the BANC starter', () => {
  const spec = { nodeType: 'dataset.banc', label: 'BANC public', sourceId: 'cave' }

  it('builds clean, and the reference edge is not a cycle', () => {
    const graph = buildStarter(spec)
    // Pinned empty, unlike FlyWire's: nothing here waits on a fetch to know its columns, because
    // the CAVE table's kinds come from `unique_string_values` rather than from a run.
    expect(issuesIn(graph)).toEqual([])
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

    expect(into('ds', 'annotations')?.source).toBe('annotations')
    expect(into('annotations', 'dataset')?.source).toBe('ds')

    /*
     * `codex_annotations` is long-format — one row per (neuron, kind, value) — so `pivotOn` is
     * the whole configuration: the distinct values of `classification_system` become the columns,
     * and `cell_type` arrives renamed to `type`, which is the name Explore's chips, the
     * connectivity tables and Profile's roll-ups all address by literal.
     */
    const table = byId(graph, 'annotations')!
    expect(table.params.table).toBe('codex_annotations')
    expect(table.params.pivotOn).toBe('classification_system')
    expect(table.params.valueColumn).toBe('cell_type')
    // Left at its default even though on a reference table it names a column of the *referenced*
    // table: same field, same default, and overriding it would suggest it had to differ.
    expect(table.params.idColumn).toBe('pt_root_id')
  })

  it('is the generic starter plus its chain, below the dataset node', () => {
    // What composing used to buy by hand, now by construction: everything downstream of the
    // dataset is the same wizard answer, compared on the cards the generic shape names.
    const banc = buildStarter(spec)
    const generic = buildStarter({ ...spec, nodeType: 'dataset.malecns', sourceId: 'neuprint' })
    const GENERIC = new Set(['ds', 'explore', 'view', 'view2'])
    const shape = (graph: CodaGraph) =>
      graph.edges
        .filter((e) => GENERIC.has(e.source) && GENERIC.has(e.target))
        .map((e) => `${e.source}.${e.sourceHandle}→${e.target}.${e.targetHandle}`)
        .sort()
    expect(shape(banc)).toEqual(shape(generic))
  })

  it('hangs its caption under the lone card, at the card’s width', () => {
    // `AnnotationChain.caption`, placed by the same rule any builder folding a chain follows;
    // a one-card chain is not folded, so the caption goes under the card itself.
    const graph = buildStarter(spec)
    const card = byId(graph, 'annotations')!
    const note = byId(graph, 'note-annotations')!
    expect(note.type).toBe('note.text')
    expect(note.position.x).toBe(card.position.x)
    expect(note.position.y).toBeGreaterThan(card.position.y)
    expect(note.size?.width).toBe(cardWidth(card.type))
  })

  it('opens with nothing browsed to and nothing ticked', () => {
    // `page` and `selection` are written by the Explore *widget*, so a starter carrying either
    // ships whoever exported the graph's browsing position.
    const explore = byId(buildStarter(spec), 'explore')!
    expect(explore.params.page).toBe(0)
    expect(explore.params.selection).toEqual([])
  })
})

/**
 * FlyWire FAFB: the generic starter with its six-card chain in front, folded into one frame.
 *
 * Held to the same bar as the rest, and to one more: the point of this starter is the chain that
 * fetches the typing. A wire missing there is a starter that opens on a list of root ids.
 */
describe('the FlyWire starter', () => {
  const spec = { nodeType: 'dataset.flywire', label: 'FlyWire FAFB', sourceId: 'cave' }

  it('builds with no type errors, and one known warning', () => {
    /*
     * `Column "join_tag" is gone` is the cold-start state rather than a mistake in the graph, and
     * it is here as a tripwire rather than as an endorsement. `annotationSchemaFrom` answers the
     * same `undefined` for an unwired socket and for a chain whose columns are not known yet, so
     * `withAnnotations` falls back to the datastack's *own* labels — known, and known to be wrong.
     * The chain's schema lands once `Table from URL` has run, so the badge clears on the first Run.
     *
     * Pinned exactly, so a second issue fails this rather than hiding behind the first.
     */
    const graph = buildStarter(spec)
    expect(issuesIn(graph)).toEqual(['explore: warning: Column "join_tag" is gone'])
    expect(inferGraph(graph).ok).toBe(true)
  })

  it('feeds the dataset both label sources, joined', () => {
    const graph = buildStarter(spec)
    const into = (target: string, handle: string) =>
      graph.edges.find((e) => e.target === target && e.targetHandle === handle)

    // Structured fields along the top, community tags along the bottom, joined rather than
    // chained — a chain would let the later source *win* a collision rather than sit beside it.
    expect(into('ds', 'annotations')?.source).toBe('join')
    expect(into('join', 'left')?.source).toBe('repair')
    expect(into('join', 'right')?.source).toBe('foldTags')
    expect(into('foldTags', 'in')?.source).toBe('tags')
    expect(into('repair', 'in')?.source).toBe('combine')
    expect(into('combine', 'in')?.source).toBe('annotations')

    // `left`, so a neuron nobody has tagged still comes through.
    expect(byId(graph, 'join')!.params.how).toBe('left')

    // The published file spreads a neuron's type over two columns; coalescing them into `type`
    // is what makes the connectivity tables and Explore's chips read in words.
    const combine = byId(graph, 'combine')!
    expect(combine.params.columns).toEqual(['cell_type', 'hemibrain_type'])
    expect(combine.params.into).toBe('type')
  })

  it('folds the tags to one row per neuron before the Join sees them', () => {
    // `joinTables` takes the *first* matching row for a repeated key, so without this fold a
    // neuron carrying eight community tags shows exactly one of them, with nothing saying so.
    const fold = byId(buildStarter(spec), 'foldTags')!
    expect(fold.params.by).toEqual([ID_COLUMN_NAME])
    expect(fold.params.agg).toBe('join')
    expect(fold.params.value).toEqual(['tag'])
  })

  it('narrows the tag table, and points Explore at the column the fold produces', () => {
    const graph = buildStarter(spec)
    expect(byId(graph, 'tags')!.params.columns).toBe('pt_root_id, tag')
    // Through `aggColumnName`, because a literal here is the naming rule stated in a second
    // place — and a wrong `Additional tags` does not fail, it just draws no tag row.
    const fold = byId(graph, 'foldTags')!
    expect(byId(graph, 'explore')!.params.tagColumn).toBe(
      aggColumnName(fold.params.agg as AggFn, String(fold.params.value)),
    )
  })

  it('opens with nothing browsed to and nothing ticked', () => {
    // A Neuroglancer panel opening on a neuron nobody chose reads as the app having decided
    // something.
    const explore = byId(buildStarter(spec), 'explore')!
    expect(explore.params.page).toBe(0)
    expect(explore.params.selection).toEqual([])
  })

  it('reads the annotations through a host that answers a browser', () => {
    // `github.com/.../raw/...` answers 302 with an empty `access-control-allow-origin`, and a
    // browser CORS-checks every hop — so the address the repository's own UI hands you is the
    // one address this cannot use.
    const url = String(byId(buildStarter(spec), 'annotations')!.params.url)
    expect(url.startsWith('https://raw.githubusercontent.com/')).toBe(true)
  })

  it('names the datastack through references, so neither round trip is a cycle', () => {
    const graph = buildStarter(spec)
    for (const target of ['repair', 'tags']) {
      expect(
        graph.edges.find((e) => e.target === target && e.targetHandle === 'dataset')?.source,
      ).toBe('ds')
    }
    expect(topoSort(graph).cyclic).toEqual([])
  })

  it('ships the whole chain folded into one frame', () => {
    // Membership pinned as a set: a card that fell out of the frame would draw beside the box
    // rather than inside it, with nothing saying so.
    const graph = buildStarter(spec)
    expect(graph.groups).toHaveLength(1)
    const frame = graph.groups![0]!
    expect(frame.collapsed).toBe(true)
    expect(frame.title).toBe('FlyWire annotations')
    expect([...frame.nodeIds].sort()).toEqual(
      ['annotations', 'combine', 'foldTags', 'join', 'repair', 'tags'].sort(),
    )
    // Nothing promoted: every param down this chain is a wiring decision made once.
    expect(frame.exposed ?? []).toEqual([])
    for (const id of ['ds', 'explore', 'view', 'view2']) expect(frame.nodeIds).not.toContain(id)
  })

  it('puts its caption directly under the folded box, the same width as it', () => {
    /*
     * The rule the bespoke starter placed by hand, now `AnnotationChain.caption` placed by the
     * wizard. Checked against `collapsedView` — what the canvas actually draws — rather than
     * against the placement's arithmetic, so the two cannot agree with each other and both be
     * wrong: the box is derived from the members, and the caption from the box.
     */
    const graph = buildStarter(spec)
    const box = collapsedView(graph).boxes[0]!
    const note = byId(graph, 'note-join')!
    expect(note.position.x).toBe(box.position.x)
    expect(note.position.y).toBe(box.position.y + COLLAPSED_SIZE.height + CAPTION_GAP)
    expect(note.size?.width).toBe(COLLAPSED_SIZE.width)
  })

  it('survives a save and reload', () => {
    const graph = buildStarter(spec)
    const { graph: restored, warnings } = deserializeGraph(
      JSON.parse(JSON.stringify(serializeGraph(graph))),
    )
    expect(warnings).toEqual([])
    expect(restored.nodes).toHaveLength(graph.nodes.length)
    // `validGroups` drops a frame naming a node this build has never had, so a round trip is
    // where a mistyped member id would surface — silently, as an unfolded chain.
    expect(restored.groups).toEqual(graph.groups)
  })
})
