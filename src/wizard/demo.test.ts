/**
 * The per-node demo workflows, held to what `wizard.test.ts` holds every combination to.
 *
 * Nothing here is a snapshot. The demos are derived from the wizard's own graphs and the
 * registry's own ports, so a golden file would only record what the code did on the day it was
 * written — what is worth asserting is that every listable node gets a *working* graph, which is
 * exactly the property that goes quietly wrong when somebody adds a port.
 *
 * The whole set is built once here, which is also the timing measurement the node guide's build
 * step depends on: 102 workflows, and the suite runs in well under a second.
 */

import { describe, expect, it } from 'vitest'
import '../nodes'
import { registerBuiltinSources } from '../data/builtins'
import { inferGraph } from '../core/inference'
import { defaultInputPorts } from '../core/ports'
import { getNodeDef, listableNodeDefs } from '../core/registry'
import { serializeGraph, deserializeGraph, type CodaGraph } from '../core/graph'
import { demoFragment, parseShareFragment } from '../data/share/fragment'
import { demoGraph, demoPlan, demoPlans } from './demo'

registerBuiltinSources()

const TYPES = listableNodeDefs().map((def) => def.type)

/*
 * Built the way the app builds them: search for a plan, then *replay* it. That split is the
 * whole of what keeps a click off every backend's listing endpoint, so a suite that only called
 * the search would be testing the half nobody runs in a browser.
 *
 * Built **once** and read by every test below that wants a graph rather than a plan. They each
 * rebuilt all 102 — the same type with the same plan, so the same graph — which is four more
 * `append` passes and four more `inferGraph` walks per node for nothing.
 */
const DEMOS = new Map<string, CodaGraph>()
for (const type of TYPES) {
  const graph = demoGraph(type, demoPlan(type))
  if (graph) DEMOS.set(type, graph)
}

/** Every issue the type checker raises on a graph, flattened with the node id that raised it. */
function issuesOf(
  graph: CodaGraph,
): Array<{ node: string; severity: string; message: string }> {
  return Object.entries(inferGraph(graph).nodes).flatMap(([node, types]) =>
    types.issues.map((issue) => ({ node, severity: issue.severity, message: issue.message })),
  )
}

describe('coverage', () => {
  it('gives every listable node a workflow', () => {
    expect([...DEMOS.keys()].sort()).toEqual([...TYPES].sort())
  })

  it('agrees with the set the node guide asks for', () => {
    expect([...demoPlans().keys()].sort()).toEqual([...TYPES].sort())
  })

  it('puts the node it is about in the graph', () => {
    for (const [type, graph] of DEMOS) {
      expect(
        graph.nodes.map((node) => node.type),
        type,
      ).toContain(type)
    }
  })

  /*
   * The point of a demo is a chain, not a card on its own: a dataset at one end, and something
   * downstream of the node unless the node is itself the end of a pipeline.
   */
  it('is a pipeline, not a lone node', () => {
    for (const [type, graph] of DEMOS) {
      expect(graph.nodes.length, type).toBeGreaterThan(2)
      expect(
        graph.nodes.some((node) => node.type.startsWith('dataset.')),
        type,
      ).toBe(true)
    }
  })
})

describe('the graphs themselves', () => {
  /*
   * The assertion the whole file exists for. An error is a port receiving a value it cannot
   * accept, which is a demo that opens with a red card — and every one of the four found while
   * this was written was a wiring rule that looked right: a Dataset into an `any` port, a
   * passthrough node's *declared* output type read instead of its inferred one.
   */
  it('has no type errors anywhere', () => {
    for (const [type, graph] of DEMOS) {
      const errors = issuesOf(graph).filter((issue) => issue.severity === 'error')
      expect(errors, `${type}: ${errors.map((e) => e.message).join('; ')}`).toEqual([])
    }
  })

  /*
   * Warnings are not failures — "no file chosen" on Upload Table is the honest state of a fresh
   * card, and a demo of that node cannot be anything else. What is worth pinning is the *count*,
   * because it only moves when a wiring rule changes: 28 today, down from 44 as the search
   * learned to rank sources, to read a passthrough's *inferred* output, and to leave the
   * synthetic dataset for a node that is about a backend. A ceiling rather than an equality, so
   * adding a node with an unset setting of its own does not fail a test about the wiring.
   */
  it('keeps warnings to the ones a node raises about its own settings', () => {
    const warnings = [...DEMOS.values()].flatMap(issuesOf)
    expect(warnings.filter((issue) => issue.severity === 'warning').length).toBeLessThanOrEqual(
      40,
    )
  })

  it('wires every required input of the node being demonstrated', () => {
    for (const [type, graph] of DEMOS) {
      const def = getNodeDef(type)!
      const required = defaultInputPorts(def).filter((port) => port.required !== false)
      for (const node of graph.nodes.filter((n) => n.type === type)) {
        for (const port of required) {
          const wired = graph.edges.some(
            (edge) => edge.target === node.id && edge.targetHandle === port.id,
          )
          expect(wired, `${type}.${port.id}`).toBe(true)
        }
      }
    }
  })

  /* A demo travels as a `demo://` link and arrives through `deserializeGraph`, so it has to
     survive that round trip like any other document — a node the loader drops is a demo that
     opens missing the thing it was about. */
  it('survives serialisation, which is how it reaches the canvas', () => {
    for (const [type, graph] of DEMOS) {
      const back = deserializeGraph(serializeGraph(graph))
      expect(back.warnings, type).toEqual([])
      expect(back.graph.nodes.length, type).toBe(graph.nodes.length)
      expect(back.graph.edges.length, type).toBe(graph.edges.length)
    }
  })
})

describe('which workflow a node lands in', () => {
  /*
   * A wizard node keeps the wizard's own graph — the demo *is* the workflow somebody would have
   * been given had they answered the dialog — rather than a synthetic chain with the node stuck
   * on the end. Connectivity is the case to ask about, since it is the node three arms open with.
   */
  it('hands a wizard node the wizard workflow it belongs to', () => {
    const graph = DEMOS.get('neuron.connectivity')!
    expect(graph.nodes.some((node) => node.id === 'conn')).toBe(true)
    expect(graph.nodes.map((node) => node.type)).toContain('out.table')
  })

  it('demos a dataset node on its own dataset', () => {
    const graph = DEMOS.get('dataset.hemibrain')!
    expect(graph.nodes[0]?.type).toBe('dataset.hemibrain')
    // One connectome, plus the Description card every dataset node opens with (`core/companion`).
    expect(
      graph.nodes.filter(
        (node) => node.type.startsWith('dataset.') && node.type !== 'dataset.description',
      ),
    ).toHaveLength(1)
  })

  /*
   * Nothing that can be shown on the synthetic dataset is moved off it: those demos run in the
   * browser with no credential, which is most of the value of the link. Asked as a majority
   * rather than as a list, because which nodes are backend-specific is a fact about the registry
   * and not something this test should be re-stating.
   */
  it('keeps most demos on the synthetic dataset', () => {
    const synthetic = [...DEMOS.values()].filter((graph) =>
      graph.nodes.some((node) => node.type === 'dataset.mock.opticlobe'),
    )
    expect(synthetic.length).toBeGreaterThan(DEMOS.size * 0.7)
  })

  /*
   * …and a node that is *about* a backend leaves it, because the alternative is a demo of the
   * node's own refusal. Raw Cypher on the mock dataset opened saying "Mock connectome has no
   * query engine", which is a true sentence and a useless workflow.
   */
  it('moves a backend-specific node onto a dataset that can answer it', () => {
    for (const type of ['neuron.rawCypher', 'cave.tables', 'cave.updateRootIds']) {
      const graph = DEMOS.get(type)!
      expect(
        graph.nodes.some((node) => node.type === 'dataset.mock.opticlobe'),
        type,
      ).toBe(false)
    }
  })

  /*
   * A viewer the wizard only offers on a published dataset is found in the workflow that offers
   * it, rather than appended to a synthetic chain where it can only warn. `out.neuroglancer` is
   * the one that forced the host index to look past `DEMO_DATASET`.
   */
  it('finds a capability-gated viewer in a workflow that has the capability', () => {
    const graph = DEMOS.get('out.neuroglancer')!
    expect(
      issuesOf(graph)
        .map((issue) => issue.message)
        .join(' '),
    ).not.toContain('publishes no neuroglancer scene')
  })

  /* Nothing the wizard builds fetches meshes, so Clean Meshes had no demo at all until the
     search could put a Meshes node in front of it. */
  it('grows a producer for a type no workflow makes', () => {
    const graph = DEMOS.get('neuron.cleanMeshes')!
    expect(graph.nodes.map((node) => node.type)).toContain('neuron.meshes')
  })
})

describe('replaying a plan', () => {
  /*
   * The property the whole split exists for. A demo is *opened* by building one workflow, so a
   * replay must not touch a dataset the plan does not name — the search does, and that is why it
   * runs at build time. Asked by counting dataset nodes rather than by spying on fetch, since
   * every request comes from a dataset node's inference peek and jsdom reaches none of it.
   */
  it('builds one dataset, the one the plan names', () => {
    for (const [type, plan] of demoPlans()) {
      const datasets = new Set(
        DEMOS.get(type)!
          .nodes.map((node) => node.type)
          .filter((t) => t.startsWith('dataset.') && t !== 'dataset.description'),
      )
      datasets.delete(`dataset.${plan.dataset}`)
      // The one thing that may remain is a dataset node being demonstrated: the four Custom
      // nodes have no family of their own, so their demo is a workflow with the node beside it.
      expect([...datasets], type).toEqual(datasets.size ? [type] : [])
    }
  })

  /*
   * Structure, not bytes. `serializeGraph` stamps a fresh `modifiedAt` on every call and
   * `addNodeWithCompanion` mints the Description card's id from the session counter, so two
   * builds of one plan differ in exactly the two places a document is allowed to.
   */
  it('gives the same graph every time, so a link is stable', () => {
    const plan = demoPlan('core.filterTable')!
    const shape = (graph: CodaGraph) => [
      graph.nodes.map((node) => node.type).join(' '),
      graph.edges
        .map((edge) => `${edge.sourceHandle}->${edge.target}.${edge.targetHandle}`)
        .join(' '),
    ]
    expect(shape(demoGraph('core.filterTable', plan)!)).toEqual(
      shape(demoGraph('core.filterTable', plan)!),
    )
  })

  /* A hand-written `demo://core.filterTable` has no plan, and searching without one stays on the
     synthetic dataset — the one whose inference asks nothing of any server. */
  it('falls back to the synthetic dataset when a link carries no plan', () => {
    const graph = demoGraph('core.filterTable')!
    expect(graph.nodes.map((node) => node.type)).toContain('dataset.mock.opticlobe')
    expect(graph.nodes.map((node) => node.type)).toContain('core.filterTable')
  })

  /*
   * A plan the wizard would not build is *dropped*, not refused — `parseDemoRef` states the same
   * rule one layer down, and for the same reason: the type is the address and the plan is a fact
   * about the guide's build. A link made against an older registry still opens the node it names.
   */
  it('falls back to the search when a plan will not build', () => {
    const graph = demoGraph('core.sort', {
      dataset: 'mock.opticlobe',
      analysis: 'nope',
      view: 'table',
    })!
    expect(graph.nodes.map((node) => node.type)).toContain('core.sort')
  })

  /*
   * …which leaves exactly one way to answer nothing, and it is the one `useShareLink` writes a
   * sentence about. If this stops being true that message starts lying.
   */
  it('answers undefined only for a node this build does not have', () => {
    expect(demoGraph('core.notARealNode', demoPlan('core.filterTable'))).toBeUndefined()
  })

  /*
   * Through the string, which is the app's actual input: the guide writes a fragment, the app
   * parses it, and the plan that comes out is a `DemoPlanRef` of loose strings. Nothing else
   * crosses that seam — `fragment.test.ts` round-trips the format and `share.test.tsx` only ever
   * sends the bare form.
   */
  it('builds from a plan that has been through a link', () => {
    const plan = demoPlan('core.filterTable')!
    const ref = parseShareFragment(demoFragment('core.filterTable', plan))
    expect(ref.kind).toBe('demo')
    const graph = demoGraph('core.filterTable', ref.kind === 'demo' ? ref.plan : undefined)!
    expect(graph.nodes.map((node) => node.type)).toContain('core.filterTable')
  })
})

describe('what a demo looks like on arrival', () => {
  /*
   * A demo is looked at before it is touched, so it has to draw something on its own. The first
   * start the wizard offers is `browse`, whose Explore card opens with nothing ticked — the Paths
   * demo therefore opened on two empty cards and a red "No neuronIds in the incoming Sources
   * table". Seen in a browser, where auto-run had already fired.
   */
  it('chooses its neurons with a search, not an empty Explore card', () => {
    for (const [type, graph] of DEMOS) {
      const types = graph.nodes.map((node) => node.type)
      if (types.includes('neuron.explore') && type !== 'neuron.explore') {
        expect.unreachable(`${type} demos on an unticked Explore card`)
      }
    }
  })
})

describe('the synthetic-data hint', () => {
  /*
   * A demo link hands somebody synthetic data they did not ask for — they clicked "Open in a
   * workflow" on Filter Table and were thinking about filtering tables. The wizard's overview
   * note already says the numbers are not a finding; the hint says the card is replaceable,
   * which is the actionable half and the one a reader arriving from the guide needs.
   */
  it('docks a hint to the Demo Data card, and only there', () => {
    for (const [type, graph] of DEMOS) {
      for (const node of graph.nodes) {
        const hinted = node.hints?.some((hint) => hint.text.includes('synthetic'))
        expect(Boolean(hinted), `${type} / ${node.type}`).toBe(
          node.type === 'dataset.mock.opticlobe',
        )
      }
    }
  })

  /* One text, so `ui/hints.ts` — which keys dismissal on the text itself — forgets it once
     rather than once per node. The bare-link path gets the same card and the same sentence. */
  it('is the same sentence everywhere, so dismissing it once is enough', () => {
    const texts = new Set(
      [...demoPlans()].flatMap(([type, plan]) =>
        (
          demoGraph(type, plan)!.nodes.find((n) => n.type === 'dataset.mock.opticlobe')
            ?.hints ?? []
        ).map((hint) => hint.text),
      ),
    )
    expect(texts.size).toBe(1)
    expect(
      demoGraph('core.filterTable')!.nodes.find((n) => n.type === 'dataset.mock.opticlobe')
        ?.hints?.[0]?.text,
    ).toBe([...texts][0])
  })

  /*
   * A demo that is not on the synthetic dataset is a real connectome, and telling somebody to
   * swap it for one is telling them to do what they are already doing. The wizard's own three
   * stage hints are still there — those are about the cards they are docked to, not the dataset.
   */
  it('says nothing on a demo that is already on a real dataset', () => {
    const graph = demoGraph('dataset.hemibrain', demoPlan('dataset.hemibrain'))!
    const texts = graph.nodes.flatMap((node) => node.hints ?? []).map((hint) => hint.text)
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.some((text) => text.includes('synthetic'))).toBe(false)
  })

  /* Dismissal is `localStorage` and hints ride on the node, so the hint has to survive the trip
     a demo actually makes: serialise, `deserializeGraph`, onto the canvas. */
  it('survives the round trip a demo link makes', () => {
    const graph = demoGraph('core.filterTable', demoPlan('core.filterTable'))!
    const back = deserializeGraph(serializeGraph(graph))
    expect(
      back.graph.nodes.find((node) => node.type === 'dataset.mock.opticlobe')?.hints,
    ).toHaveLength(1)
  })
})

describe('an unknown type', () => {
  it('answers undefined rather than throwing, since a link can name a retired node', () => {
    expect(demoGraph('core.notARealNode')).toBeUndefined()
  })
})
