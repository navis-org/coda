import { beforeAll, describe, expect, it } from 'vitest'

import { deserializeGraph, serializeGraph, topoSort } from '../core/graph'
import { inferGraph } from '../core/inference'
import { ID_COLUMN_NAME } from '../core/ids'
import { isAnnotation } from '../core/registry'
import type { AggFn } from '../nodes/lib/tableOps'
import { aggColumnName } from '../nodes/lib/tableOps'
import { parseMarkdown } from '../ui/markdown'
import { Scheduler } from '../core/scheduler'
import { isMatrixValue, isTableValue } from '../core/values'
import { MockSource } from '../data/mock/MockSource'
import { CaveSource } from '../data/cave/CaveSource'
import { NeuPrintSource } from '../data/neuprint/NeuPrintSource'
import { registerSource, requireSource } from '../data/source'
import '../nodes'
import { EXAMPLES } from './index'
import { buildStarter } from './starters'

/**
 * The examples double as end-to-end fixtures: if one of them stops inferring cleanly or
 * stops running, something in the engine, the node set, or the mock source regressed.
 */
beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
  // Registered but never called: the starter only asks what this source *can* do, which is
  // a synchronous capability read.
  registerSource(new NeuPrintSource())
  registerSource(new CaveSource())
})

function scheduler(): Scheduler {
  return new Scheduler({ resolveSource: (id) => requireSource(id) })
}

describe.each(EXAMPLES.map((e) => [e.id, e] as const))('example: %s', (_id, example) => {
  it('builds with no type errors', () => {
    const inference = inferGraph(example.build())
    const errors = Object.entries(inference.nodes).flatMap(([nodeId, node]) =>
      node.issues.filter((i) => i.severity === 'error').map((i) => `${nodeId}: ${i.message}`),
    )
    expect(errors).toEqual([])
    expect(inference.cyclic).toEqual([])
    expect(inference.ok).toBe(true)
  })

  it('has no validation warnings', () => {
    const inference = inferGraph(example.build())
    const warnings = Object.entries(inference.nodes).flatMap(([nodeId, node]) =>
      node.issues.filter((i) => i.severity === 'warning').map((i) => `${nodeId}: ${i.message}`),
    )
    expect(warnings).toEqual([])
  })

  it('runs to completion and produces output at every terminal node', async () => {
    const graph = example.build()
    const sched = scheduler()
    const summary = await sched.run(graph, { mode: 'full' })

    expect(summary.failed).toEqual([])
    expect(summary.cancelled).toBe(false)
    /*
     * Annotations are excluded on both counts, and the exclusion is the assertion: a text note
     * is not work, so it must appear in neither `executed` nor `deferred`, and it is terminal in
     * the graph-theoretic sense while producing nothing. Counting it here would be counting the
     * comments in a program as statements.
     */
    const dataflow = graph.nodes.filter((n) => !isAnnotation(n.type))
    expect(dataflow.length).toBeLessThan(graph.nodes.length)
    expect(summary.executed.length).toBe(dataflow.length)

    // Terminal nodes are the ones nothing consumes — the graph's actual answers.
    const consumed = new Set(graph.edges.map((e) => e.source))
    const terminals = dataflow.filter((n) => !consumed.has(n.id))
    expect(terminals.length).toBeGreaterThan(0)

    for (const node of terminals) {
      const outputs = sched.outputs(node.id)
      expect(outputs, `${node.id} produced no outputs`).toBeDefined()
      const entries = Object.entries(outputs!)
      const [portId, value] = entries[0]!
      expect(value, `${node.id} output is empty`).toBeDefined()

      // A viewer's `selected` port is empty until someone clicks in it — that is the
      // correct state for a freshly-run graph, not a failure.
      if (portId === 'selected') continue

      if (isTableValue(value)) {
        expect(value.length, `${node.id} returned an empty table`).toBeGreaterThan(0)
      } else if (isMatrixValue(value)) {
        expect(value.rowLabels.length, `${node.id} returned an empty matrix`).toBeGreaterThan(0)
        expect(
          [...value.values].some((v) => v > 0),
          `${node.id} matrix is all zeros`,
        ).toBe(true)
      }
    }
  })

  it('carries notes whose markdown actually parses', () => {
    const notes = example
      .build()
      .nodes.filter((n) => isAnnotation(n.type))
      .map((n) => String(n.params.text ?? ''))
    expect(notes.length).toBeGreaterThan(1)

    for (const text of notes) {
      const blocks = parseMarkdown(text)
      expect(blocks.length).toBeGreaterThan(0)
      /*
       * The dedent trap: the parser only recognises a heading or a bullet at the *start* of a
       * line, so a note left at its source indentation degrades to paragraphs beginning with
       * three hashes. It renders, it looks wrong, and nothing else notices.
       */
      for (const block of blocks) {
        if (block.kind !== 'paragraph') continue
        const [first] = block.children
        expect(first?.kind === 'text' ? first.text.trimStart() : '').not.toMatch(/^[#*-] /)
      }
    }
    // Each example opens with an overview headed by a heading, not with a wall of prose.
    expect(parseMarkdown(notes[0]!)[0]?.kind).toBe('heading')
  })

  it('survives a save/load round trip unchanged', () => {
    const original = example.build()
    const { graph, warnings } = deserializeGraph(serializeGraph(original))
    expect(warnings).toEqual([])
    expect(graph.nodes).toEqual(original.nodes)
    expect(
      graph.edges.map((e) => `${e.source}:${e.sourceHandle}→${e.target}:${e.targetHandle}`),
    ).toEqual(
      original.edges.map((e) => `${e.source}:${e.sourceHandle}→${e.target}:${e.targetHandle}`),
    )
  })
})

describe('example results', () => {
  it('aggregates LC outputs onto central-brain targets, ranked by weight', async () => {
    const example = EXAMPLES.find((e) => e.id === 'partners')!
    const graph = example.build()
    const sched = scheduler()
    await sched.run(graph, { mode: 'full' })

    const table = sched.output('view', 'out')
    if (!isTableValue(table)) throw new Error('expected a table')

    const partnerTypes = table.data.postType as string[]
    const weights = table.data.sum_weight as number[]

    expect(partnerTypes.length).toBeGreaterThan(2)
    // Sort node ran: descending by aggregate weight, no exceptions.
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]!).toBeLessThanOrEqual(weights[i - 1]!)
    }
    // Every partner is a type the generator's rules actually give LC neurons — this is
    // guaranteed by the wiring, unlike any particular *ranking*, which depends on how
    // many neurons each target type has.
    const expected = new Set([
      'DNp02',
      'DNp11',
      'PVLP002',
      'PVLP008',
      'PLP003',
      'AOTU008',
      'LT1',
    ])
    for (const type of partnerTypes)
      expect(expected.has(type), `unexpected partner ${type}`).toBe(true)
    expect(partnerTypes).toContain('DNp02')
    // `n` (rows per group) always travels with the aggregate.
    expect(table.schema.columns.map((c) => c.name)).toEqual(['postType', 'n', 'sum_weight'])
  })

  it('row-normalises the adjacency matrix to sum to 1 per row', async () => {
    const example = EXAMPLES.find((e) => e.id === 'matrix')!
    const sched = scheduler()
    await sched.run(example.build(), { mode: 'full' })

    const matrix = sched.output('norm', 'out')
    if (!isMatrixValue(matrix)) throw new Error('expected a matrix')

    const cols = matrix.colLabels.length
    for (let r = 0; r < matrix.rowLabels.length; r++) {
      let total = 0
      for (let c = 0; c < cols; c++) total += matrix.values[r * cols + c] ?? 0
      // A row of all-zeros stays zero; anything else must normalise to 1.
      expect(
        total === 0 || Math.abs(total - 1) < 1e-9,
        `row ${matrix.rowLabels[r]} = ${total}`,
      ).toBe(true)
    }
  })

  it('puts the calyx first in the KC ROI summary', async () => {
    const example = EXAMPLES.find((e) => e.id === 'roi-summary')!
    const sched = scheduler()
    await sched.run(example.build(), { mode: 'full' })

    const table = sched.output('group', 'out')
    if (!isTableValue(table)) throw new Error('expected a table')

    const byRoi = new Map<string, number>()
    const rois = table.data.roi as string[]
    const posts = table.data.sum_post as number[]
    for (let i = 0; i < table.length; i++) {
      byRoi.set(rois[i]!, (byRoi.get(rois[i]!) ?? 0) + posts[i]!)
    }
    const ranked = [...byRoi.entries()].sort((a, b) => b[1] - a[1])
    // Kenyon cells receive their input in the calyx.
    expect(ranked[0]?.[0]).toBe('CA(R)')
  })
})

/**
 * Starter graphs — what the New menu builds. Held to the same bar as the examples, because
 * they are the first thing a new user sees and a starter that reports a type error on open is
 * worse than an empty canvas.
 */
describe('starters', () => {
  const spec = { nodeType: 'dataset.mock.hemibrain', label: 'Hemibrain (mini)' }

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
      'dataset.mock.hemibrain',
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
    const dataset = graph.nodes.find((n) => n.type === 'dataset.mock.hemibrain')
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
    expect(fold.params.value).toBe('tag')
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
