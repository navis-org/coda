/**
 * The headless half of the assistant: what a plan may say, and what the applier refuses.
 *
 * Everything here runs against the *real* node registry rather than fixtures, which is the
 * point — the catalogue is generated from it, so a test built on a fake one would prove that
 * the fake is self-consistent and nothing about the thing the model is actually told.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../nodes'
import type { CodaGraph } from '../core/graph'
import { addEdge, addNode, emptyGraph, newId, updateNode } from '../core/graph'
import { inferGraph } from '../core/inference'
import { configurableParams, defaultParams } from '../core/node'
import { getNodeDef, listableNodeDefs } from '../core/registry'
import type { ApplyOk, ApplyResult } from './apply'
import { applyPlan } from './apply'
import { buildSystemPrompt, catalogueText, gateNote, optionLines } from './catalogue'
import { registerBuiltinSources } from '../data/builtins'
import { setKey } from '../data/ai/credentials'
import { getSource } from '../data/source'
import type { NodeDefinition } from '../core/node'
import { T } from '../core/types'
import type { CodaType } from '../core/types'
import { pivotGraph, pivotObserved } from './fixture'
import { messagesReply, stubFetch } from '../data/ai/fixture'
import {
  concernPrompt,
  concernsFrom,
  describeGraph,
  repairPrompt,
  requestPlan,
  runTurn,
} from './converse'
import type { GraphContext } from './converse'
import type { Value } from '../core/values'
import { makeTable } from '../core/values'
import { column, tableSchema } from '../core/types'
import type { AssistantPlan } from './planShape'
import { parsePlan, planJsonSchema } from './plan'
import { emptyPlan, isEmptyPlan, plannableParams } from './planShape'
import {
  allInputPorts,
  allOutputPorts,
  defaultInputPorts,
  defaultOutputPorts,
} from '../core/ports'
import { searchFor } from '../test/findNeurons'
import { ALL_ROW_OPS, arityOf, decodeRows } from '../data/filterRows'
import { opsForDType } from '../nodes/lib/tableOps'
import { SKELETON_ROUTES, skeletonRouteVocabulary } from '../data/skeletonRoutes'
import { SYNAPSE_UNITS, synapseUnitVocabulary } from '../data/synapseUnits'
import { requireNodeDef } from '../core/registry'

function plan(patch: Partial<AssistantPlan>): AssistantPlan {
  return { ...emptyPlan(), summary: 'a test edit', ...patch }
}

/** Narrow, and fail with the errors rather than with `undefined is not an object`. */
function expectOk(result: ApplyResult) {
  if (!result.ok) expect.fail(`expected the plan to apply, got:\n${result.errors.join('\n')}`)
  return result
}

function expectFail(result: ApplyResult) {
  if (result.ok) expect.fail('expected the plan to be refused')
  return result
}

/** The refusal a plan earns, as one string. Every refusal test is a phrase against this. */
function refusal(patch: Partial<AssistantPlan>, graph: CodaGraph = emptyGraph()): string {
  return expectFail(applyPlan(graph, plan(patch))).errors.join('\n')
}

/** The node a plan ref ended up as. */
function nodeFor(result: ApplyOk, ref: string) {
  const node = result.graph.nodes.find((n) => n.id === result.created[ref])
  if (!node) expect.fail(`no node was created for ref "${ref}"`)
  return node
}

/** A parsed plan, failing the test rather than the narrowing at each call site. */
function parsedPlan(text: string): AssistantPlan {
  const parsed = parsePlan(text)
  if (!parsed.ok) expect.fail(`expected a plan, got: ${parsed.error}`)
  return parsed.plan
}

/** `Dataset → Find Neurons`, the start of nearly every pipeline. */
const SEED: AssistantPlan = plan({
  add: [
    { ref: 'ds', type: 'dataset.mock.opticlobe' },
    { ref: 'find', type: 'neuron.findNeurons', params: searchFor({ type: 'LC.*' }) },
  ],
  connect: [{ from: { node: 'ds', port: 'dataset' }, to: { node: 'find', port: 'dataset' } }],
})

function seeded(): { graph: CodaGraph; ids: Record<string, string> } {
  const result = expectOk(applyPlan(emptyGraph(), SEED))
  return { graph: result.graph, ids: result.created }
}

describe('applying a plan', () => {
  it('builds a pipeline, merging params over the definition defaults', () => {
    const result = expectOk(
      applyPlan(
        emptyGraph(),
        plan({
          add: [
            { ref: 'ds', type: 'dataset.mock.opticlobe' },
            { ref: 'find', type: 'neuron.findNeurons', params: searchFor({ type: 'LC.*' }) },
            { ref: 'conn', type: 'neuron.connectivity' },
            { ref: 'chart', type: 'out.barChart', title: 'Partners' },
          ],
          connect: [
            { from: { node: 'ds', port: 'dataset' }, to: { node: 'find', port: 'dataset' } },
            { from: { node: 'ds', port: 'dataset' }, to: { node: 'conn', port: 'dataset' } },
            { from: { node: 'find', port: 'neurons' }, to: { node: 'conn', port: 'neurons' } },
            { from: { node: 'conn', port: 'connections' }, to: { node: 'chart', port: 'in' } },
          ],
        }),
      ),
    )

    expect(result.graph.nodes).toHaveLength(4)
    expect(result.graph.edges).toHaveLength(4)

    const find = nodeFor(result, 'find')
    expect(find.params.filters).toEqual(searchFor({ type: 'LC.*' }).filters)
    // Untouched params keep the definition's default rather than arriving undefined. `roi` and
    // `limit` are all Find Neurons has left besides the filters, so they are what say the merge
    // happened rather than the plan having replaced the params wholesale.
    expect(find.params.roi).toBe('')
    expect(find.params.limit).toBe(0)

    const chart = nodeFor(result, 'chart')
    expect(chart.title).toBe('Partners')
  })

  it('mints ids rather than trusting the refs, and reports the mapping', () => {
    const result = expectOk(applyPlan(emptyGraph(), SEED))
    expect(Object.keys(result.created).sort()).toEqual(['ds', 'find'])
    // A ref is a plan-local handle; nothing on the canvas is called "ds".
    expect(result.graph.nodes.map((n) => n.id)).not.toContain('ds')
    for (const id of Object.values(result.created)) {
      expect(result.graph.nodes.some((n) => n.id === id)).toBe(true)
    }
  })

  it('lays new nodes out in topological columns', () => {
    const result = expectOk(applyPlan(emptyGraph(), SEED))
    const ds = nodeFor(result, 'ds')
    const find = nodeFor(result, 'find')

    expect(ds.position).toEqual({ x: 60, y: 80 })
    expect(find.position.x).toBeGreaterThan(ds.position.x)
    expect(find.position.y).toBe(ds.position.y)
  })

  it('puts the new block clear of what was already on the canvas, and moves nothing', () => {
    const { graph } = seeded()
    const before = graph.nodes.map((n) => ({ id: n.id, ...n.position }))

    const result = expectOk(
      applyPlan(graph, plan({ add: [{ ref: 'note', type: 'note.text' }] })),
    )

    for (const node of before) {
      const after = result.graph.nodes.find((n) => n.id === node.id)!
      expect(after.position).toEqual({ x: node.x, y: node.y })
    }
    const added = nodeFor(result, 'note')
    const rightmost = Math.max(...before.map((n) => n.x))
    expect(added.position.x).toBeGreaterThan(rightmost)
  })
})

describe('refusing a plan', () => {
  it('refuses a node type that does not exist, and names it', () => {
    const message = refusal({ add: [{ ref: 'x', type: 'core.doesNotExist' }] })

    expect(message).toContain('core.doesNotExist')
  })

  it('refuses a superseded type, since the catalogue does not offer it', () => {
    // `neuron.dataset` is registered so old files keep loading, and `hidden` so nothing offers it.
    expect(getNodeDef('neuron.dataset')?.hidden).toBe(true)
    const message = refusal({ add: [{ ref: 'x', type: 'neuron.dataset' }] })

    expect(message).toMatch(/superseded/i)
  })

  it('refuses a wire the type system rejects, in the same words the canvas would use', () => {
    const message = refusal({
      add: [
        { ref: 'ds', type: 'dataset.mock.opticlobe' },
        { ref: 'filter', type: 'core.filterTable' },
      ],
      connect: [{ from: { node: 'ds', port: 'dataset' }, to: { node: 'filter', port: 'in' } }],
    })

    expect(message).toContain('does not fit')
    // Named by what is on screen, not by the plan's refs.
    expect(message).toContain('Filter')
  })

  it('refuses a port the node does not have, and lists the ones it does', () => {
    const message = refusal({
      add: [
        { ref: 'a', type: 'core.filterTable' },
        { ref: 'b', type: 'core.filterTable' },
      ],
      connect: [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'input' } }],
    })

    expect(message).toContain('no input "input"')
    expect(message).toContain('in')
  })

  it('refuses a cycle', () => {
    const message = refusal({
      add: [
        { ref: 'a', type: 'core.filterTable' },
        { ref: 'b', type: 'core.filterTable' },
      ],
      connect: [
        { from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } },
        { from: { node: 'b', port: 'out' }, to: { node: 'a', port: 'in' } },
      ],
    })

    expect(message).toMatch(/cycle/i)
  })

  it('refuses a param the node does not have, and says which it does', () => {
    const message = refusal({
      add: [{ ref: 'f', type: 'neuron.findNeurons', params: { pattern: 'LC4' } }],
    })

    expect(message).toContain('no param "pattern"')
    expect(message).toContain('filters')
  })

  it('refuses a value of the wrong kind', () => {
    /*
     * Still refused after `coerceParamValue` learned to read a number as an enum option, and
     * deliberately so: nothing downstream checks a `string` param, so `4` here would become the
     * id list `"4"` and apply cleanly. This used to be asked of Find Neurons' `typePattern`,
     * whose deletion left `Input IDs` as the plainest `string` param in the catalogue — and it
     * makes the point harder, since a number where an id list goes is invariant 8's own hazard.
     */
    const message = refusal({
      add: [{ ref: 'f', type: 'neuron.inputIds', params: { ids: 4 as never } }],
    })

    expect(message).toContain('wants a string, got a number')
  })

  it('refuses a fractional value for a whole-number param', () => {
    const message = refusal({
      add: [{ ref: 'f', type: 'neuron.findNeurons', params: { limit: 1.5 } }],
    })

    expect(message).toContain('whole number')
  })

  it('refuses an option the enum does not have, and lists the ones it does', () => {
    const message = refusal({
      add: [{ ref: 'g', type: 'core.groupBy', params: { agg: 'median' } }],
    })

    expect(message).toContain('no option "median"')
    expect(message).toContain('countDistinct')
  })

  it('accepts an enum whose options depend on the input, and leaves validate to judge it', () => {
    // `roi` options come from the dataset, which inference cannot resolve here — so this file
    // must not pretend to know them. A wrong one is the node's own `validate` to report. This
    // used to ask it of `status`, which was one of the four legacy params; `roi` is the same
    // shape of question and is the one that could never have become a filter row.
    const result = expectOk(
      applyPlan(
        emptyGraph(),
        plan({
          add: [{ ref: 'f', type: 'neuron.findNeurons', params: { roi: 'Anything' } }],
        }),
      ),
    )
    expect(result.graph.nodes[0]?.params.roi).toBe('Anything')
  })

  it('refuses a number outside the bounds the definition declares', () => {
    // The number input honours `min`/`max`, so a plan that did not would be the one route that
    // can store a value the UI would have refused.
    expect(
      refusal({ add: [{ ref: 'n', type: 'out.network', params: { topNodes: -1 } }] }),
    ).toContain('must be at least')
  })

  it('refuses a param the node’s other settings have switched off', () => {
    // `core.stack`'s labels are `visibleIf` its source column is named. `normalizeParams` leaves
    // a switched-off param out of the provenance key, so setting one changes nothing, stales
    // nothing and would be reported as applied — silent success, which is the outcome this
    // module is arranged to avoid.
    expect(
      refusal({ add: [{ ref: 's', type: 'core.stack', params: { label1: 'Left' } }] }),
    ).toContain('does not apply')
  })

  it('accepts the same param once the plan also sets the switch that reveals it', () => {
    // Order-independently: the check is against the node's finished params, not the params as
    // they were when this entry was read.
    const result = expectOk(
      applyPlan(
        emptyGraph(),
        plan({
          add: [
            {
              ref: 's',
              type: 'core.stack',
              params: { label1: 'Left', sourceColumn: 'origin' },
            },
          ],
        }),
      ),
    )
    expect(nodeFor(result, 's').params.label1).toBe('Left')
  })

  it('refuses to set an internal param', () => {
    // `refresh` is a nonce a reload button bumps. Setting it from a plan would invalidate a
    // cache entry as though it were a setting somebody chose.
    const message = refusal({
      add: [{ ref: 'ds', type: 'dataset.mock.opticlobe', params: { refresh: 1 } }],
    })

    expect(message).toMatch(/internal/i)
  })

  it('refuses a ref that collides with an id already on the canvas', () => {
    const { graph } = seeded()
    const taken = graph.nodes[0]!.id
    const message = refusal({ add: [{ ref: taken, type: 'core.filterTable' }] }, graph)

    expect(message).toContain('already the id of a node')
  })

  it('refuses a ref used twice', () => {
    const message = refusal({
      add: [
        { ref: 'f', type: 'core.filterTable' },
        { ref: 'f', type: 'core.sort' },
      ],
    })

    expect(message).toContain('used twice')
  })

  it('refuses to remove a node that is not there', () => {
    const message = refusal({ remove: ['nope'] })

    expect(message).toContain('no node "nope"')
  })

  it('names every problem at once, rather than only the first', () => {
    const result = expectFail(
      applyPlan(
        emptyGraph(),
        plan({
          add: [
            { ref: 'a', type: 'core.nope' },
            { ref: 'b', type: 'neuron.findNeurons', params: { limit: 'lots' as never } },
          ],
          remove: ['ghost'],
        }),
      ),
    )
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })

  it('reports a bad node type once, not again for every wire touching it', () => {
    const result = expectFail(
      applyPlan(
        emptyGraph(),
        plan({
          add: [
            { ref: 'bad', type: 'core.nope' },
            { ref: 'f', type: 'core.filterTable' },
          ],
          connect: [
            { from: { node: 'bad', port: 'out' }, to: { node: 'f', port: 'in' } },
            { from: { node: 'bad', port: 'out' }, to: { node: 'f', port: 'in' } },
          ],
          setParams: [{ node: 'bad', param: 'x', value: 1 }],
        }),
      ),
    )
    expect(result.errors).toHaveLength(1)
  })

  it('leaves the graph untouched when it refuses — all or nothing', () => {
    const { graph } = seeded()
    const before = JSON.stringify(graph)

    const result = applyPlan(
      graph,
      plan({
        add: [
          { ref: 'conn', type: 'neuron.connectivity' },
          { ref: 'chart', type: 'out.barChart' },
        ],
        connect: [
          // The first three are fine; the last one is not.
          { from: { node: 'conn', port: 'connections' }, to: { node: 'chart', port: 'in' } },
          { from: { node: 'chart', port: 'out' }, to: { node: 'conn', port: 'dataset' } },
        ],
      }),
    )

    expect(result.ok).toBe(false)
    expect(JSON.stringify(graph)).toBe(before)
  })
})

describe('editing what is already there', () => {
  it('sets a param on an existing node', () => {
    const { graph, ids } = seeded()
    const result = expectOk(
      applyPlan(graph, plan({ setParams: [{ node: ids.find!, param: 'limit', value: 50 }] })),
    )
    expect(result.graph.nodes.find((n) => n.id === ids.find)!.params.limit).toBe(50)
  })

  it('removes a node and takes its wires with it', () => {
    const { graph, ids } = seeded()
    expect(graph.edges).toHaveLength(1)
    const result = expectOk(applyPlan(graph, plan({ remove: [ids.ds!] })))
    expect(result.graph.nodes).toHaveLength(1)
    expect(result.graph.edges).toHaveLength(0)
  })

  it('cuts the one wire an input port carries', () => {
    const { graph, ids } = seeded()
    const result = expectOk(
      applyPlan(graph, plan({ disconnect: [{ node: ids.find!, port: 'dataset' }] })),
    )
    expect(result.graph.edges).toHaveLength(0)
    expect(result.graph.nodes).toHaveLength(2)
  })

  it('treats cutting a wire that is not there as already done, not as an error', () => {
    // The plan describes a state; that state holds. Refusing would send the model back to
    // repair a wire nobody has.
    const { graph, ids } = seeded()
    const result = expectOk(
      applyPlan(graph, plan({ disconnect: [{ node: ids.find!, port: 'dataset' }] })),
    )
    expect(
      expectOk(
        applyPlan(result.graph, plan({ disconnect: [{ node: ids.find!, port: 'dataset' }] })),
      ).graph.edges,
    ).toHaveLength(0)
  })

  it('re-points an input that is already occupied, rather than refusing', () => {
    const { graph, ids } = seeded()
    const result = expectOk(
      applyPlan(
        graph,
        plan({
          add: [{ ref: 'other', type: 'dataset.mock.opticlobe' }],
          connect: [
            {
              from: { node: 'other', port: 'dataset' },
              to: { node: ids.find!, port: 'dataset' },
            },
          ],
        }),
      ),
    )
    expect(result.graph.edges).toHaveLength(1)
    expect(result.graph.edges[0]!.source).toBe(result.created.other)
  })

  it('brings a published dataset node’s Description card, like every other add path does', () => {
    /*
     * The attribution is meant to be on the canvas by default and dismissed if unwanted, so an
     * assistant that used bare `addNode` would be the one route into the editor that silently
     * drops a connectome's citation. Invisible to the rest of this file, which builds on
     * `dataset.mock.*` — the synthetic families are exactly the ones that opt out.
     */
    const result = expectOk(
      applyPlan(emptyGraph(), plan({ add: [{ ref: 'ds', type: 'dataset.hemibrain' }] })),
    )

    expect(result.graph.nodes).toHaveLength(2)
    const card = result.graph.nodes.find((n) => n.type === 'dataset.description')
    expect(card).toBeDefined()
    expect(result.graph.edges).toHaveLength(1)
    expect(result.graph.edges[0]!.source).toBe(result.created.ds)
    expect(result.graph.edges[0]!.target).toBe(card!.id)

    // It came along; it was not asked for, so it has no ref.
    expect(Object.values(result.created)).not.toContain(card!.id)
    // And it sits relative to the host's *final* position, not the origin it was built at.
    const host = nodeFor(result, 'ds')
    expect(card!.position.y).toBeGreaterThan(host.position.y)
  })

  it('keeps the companion beside its host when the block is placed clear of the canvas', () => {
    const { graph } = seeded()
    const result = expectOk(
      applyPlan(graph, plan({ add: [{ ref: 'ds', type: 'dataset.manc' }] })),
    )
    const host = nodeFor(result, 'ds')
    const card = result.graph.nodes.find((n) => n.type === 'dataset.description')!
    expect(card.position.x).toBe(host.position.x)
    expect(card.position.y).toBeGreaterThan(host.position.y)
  })

  it('wires a new node onto an existing one', () => {
    const { graph, ids } = seeded()
    const result = expectOk(
      applyPlan(
        graph,
        plan({
          add: [{ ref: 'table', type: 'out.table' }],
          connect: [
            { from: { node: ids.find!, port: 'neurons' }, to: { node: 'table', port: 'in' } },
          ],
        }),
      ),
    )
    expect(result.graph.edges).toHaveLength(2)
    expect(
      result.graph.edges.some(
        (e) => e.source === ids.find && e.target === result.created.table,
      ),
    ).toBe(true)
  })
})

describe('what is left for the user', () => {
  it('reports an unset picker as a warning rather than refusing', () => {
    // Group By needs at least one key and cannot have one chosen from here — the columns are
    // whatever the query returns. Refusing this would refuse most real pipelines.
    const { graph, ids } = seeded()
    const result = expectOk(
      applyPlan(
        graph,
        plan({
          add: [{ ref: 'g', type: 'core.groupBy' }],
          connect: [
            { from: { node: ids.find!, port: 'neurons' }, to: { node: 'g', port: 'in' } },
          ],
        }),
      ),
    )
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings.every((w) => w.nodeId === result.created.g)).toBe(true)
    expect(result.warnings[0]!.label).toBe('Group By')
  })

  it('says nothing about a node the plan did not touch', () => {
    // A pre-existing problem elsewhere is not news about this edit, and reporting it reads as
    // the assistant having broken something.
    const orphan = {
      id: newId('n'),
      type: 'core.groupBy',
      position: { x: 0, y: 0 },
      params: { by: [], agg: 'sum', value: [] },
    }
    const graph: CodaGraph = addNode(emptyGraph(), orphan)
    const result = expectOk(applyPlan(graph, plan({ add: [{ ref: 'n', type: 'note.text' }] })))
    expect(result.warnings.map((w) => w.nodeId)).not.toContain(orphan.id)
  })
})

describe('the plan format', () => {
  it('reads a plan out of a reply, and fills in the arrays a model left out', () => {
    const parsed = parsedPlan('{"summary":"hi","add":[{"ref":"a","type":"core.filterTable"}]}')
    expect(parsed.add).toHaveLength(1)
    expect(parsed.remove).toEqual([])
    expect(parsed.connect).toEqual([])
  })

  it('refuses a shape that would silently do nothing', () => {
    // A `connect` with no `to` is not a wire. Skipping it would report a successful edit that
    // did not make the connection the user asked for.
    const parsed = parsePlan('{"summary":"x","connect":[{"from":{"node":"a","port":"out"}}]}')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('connect[0].to')
  })

  it('refuses a reply that is not JSON, saying so', () => {
    const parsed = parsePlan('Sure! Here is the plan you asked for.')
    expect(parsed.ok).toBe(false)
  })

  it('recognises a plan that asks for nothing', () => {
    const parsed = parsedPlan('{"summary":"I cannot do that."}')
    expect(isEmptyPlan(parsed)).toBe(true)
    // An empty plan still applies, cleanly, and changes nothing.
    const { graph } = seeded()
    const result = expectOk(applyPlan(graph, parsed))
    expect(result.graph).toEqual(graph)
  })

  it('describes itself in a schema the structured-output compiler accepts', () => {
    const schema = planJsonSchema() as Record<string, unknown>
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'summary',
        'add',
        'remove',
        'setParams',
        'connect',
        'disconnect',
      ]),
    )

    /*
     * Walked rather than spot-checked, because the failure is a 400 at the far end of a
     * request the user already paid for. Two rules, and the second is the one that bit: every
     * object must carry `additionalProperties`, and it may only ever be `false` — so the
     * obvious shape for `params`, a map from param id to value, cannot be expressed at all.
     */
    const banned = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'multipleOf']
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return
      const record = node as Record<string, unknown>
      for (const key of banned) expect(record[key], `${path}.${key}`).toBeUndefined()
      if ('additionalProperties' in record) {
        expect(record.additionalProperties, `${path}.additionalProperties`).toBe(false)
      } else if (record.type === 'object') {
        expect.fail(`${path} is an object with no additionalProperties`)
      }
      /*
       * Strict mode has *two* rules and this used to check one. Every property of every object
       * must be `required` — add an optional field to a nested object and OpenAI returns a 400
       * at request time, on a request the user paid for, while the suite stays green.
       */
      if (record.type === 'object' && record.properties) {
        expect(record.required ?? [], `${path}.required`).toEqual(
          expect.arrayContaining(Object.keys(record.properties as object)),
        )
      }
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`)
    }
    walk(schema, 'schema')
  })

  it('takes params as the wire sends them — a list of pairs — and as a map', () => {
    // The schema cannot express a map, so the model sends pairs; a plan written by hand is far
    // more readable as a map. Both have to arrive at the same node.
    const fromWire = parsedPlan(
      '{"summary":"x","add":[{"ref":"f","type":"neuron.findNeurons",' +
        '"params":[{"param":"roi","value":"ME(R)"},{"param":"limit","value":10}]}]}',
    )
    expect(fromWire.add[0]!.params).toEqual({ roi: 'ME(R)', limit: 10 })

    const fromMap = parsedPlan(
      '{"summary":"x","add":[{"ref":"f","type":"neuron.findNeurons",' +
        '"params":{"roi":"ME(R)","limit":10}}]}',
    )
    expect(fromMap.add[0]!.params).toEqual(fromWire.add[0]!.params)
  })

  it('refuses a param set twice, rather than silently keeping one of them', () => {
    const parsed = parsePlan(
      '{"summary":"x","add":[{"ref":"f","type":"core.filterTable",' +
        '"params":[{"param":"value","value":"a"},{"param":"value","value":"b"}]}]}',
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('set twice')
  })
})

/**
 * The boundary, followed all the way rather than one file deep.
 *
 * `eslint.config.js` lists `src/assistant/**` in its boundary block so the assistant stays
 * reachable by a non-React consumer — but its `**\/ui/*` pattern matches a *direct* import, and
 * the property it protects is transitive. That gap was not hypothetical: `digest.ts` reuses
 * `describeTable` (so a plan's median and the Describe card's are the same number), and
 * `describeOps` reached `ui/viewers/boxStats` for `quantileSorted`, which reaches `ui/colors`.
 * Three files deep, lint clean, property false.
 *
 * Moving `quantileSorted` to `core/stats.ts` fixed that instance. This is what stops the next one:
 * a walk, from every non-test module in `src/assistant`, over relative imports, asserting nothing
 * under `src/ui` or `src/store` is reachable at any depth.
 */
describe('the headless boundary', () => {
  it('reaches no UI or store module, at any depth, from any headless area', () => {
    /*
     * All five directories `eslint.config.js` names, not just this one. The transitive hole is
     * identical in each, and `src/data` is three times the size of `src/assistant` and the most
     * likely to reach for a UI formatter. Zero offenders across 255 modules today.
     */
    const root = new URL('..', import.meta.url).pathname
    const seen = new Set<string>()
    const offenders: string[] = []

    const resolve = (from: string, spec: string): string | undefined => {
      if (!spec.startsWith('.')) return undefined
      const base = join(dirname(from), spec)
      for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
        if (existsSync(candidate)) return candidate
      }
      return undefined
    }

    const walk = (file: string, trail: readonly string[]): void => {
      if (seen.has(file)) return
      seen.add(file)
      const rel = file.slice(root.length)
      if (rel.startsWith('ui/') || rel.startsWith('store/')) {
        offenders.push([...trail, rel].join(' → '))
        return
      }
      /*
       * `import('…')` as well as `from '…'`: a dynamic import is a live idiom here — the
       * assistant drawer loads `converse.ts` that way on purpose — so a walk that read only
       * static imports would let `await import('../ui/…')` through.
       */
      const source = readFileSync(file, 'utf8')
      for (const [, a, b] of source.matchAll(
        /(?:from|import)\s*\(?\s*'([^']+)'|import\('([^']+)'\)/g,
      )) {
        const next = resolve(file, (a ?? b)!)
        if (next) walk(next, [...trail, rel])
      }
    }

    for (const area of ['assistant', 'core', 'data', 'layout', 'pyodide']) {
      const walkDir = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) walkDir(path)
          else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) walk(path, [])
        }
      }
      walkDir(join(root, area))
    }

    expect(offenders, 'no headless area may reach the UI or the store').toEqual([])
    // A walk that visited almost nothing would pass for the wrong reason.
    expect(seen.size, 'the walk actually followed the import graph').toBeGreaterThan(150)
  })
})

describe('the catalogue', () => {
  it('offers every listable node type and nothing else', () => {
    const text = catalogueText()
    for (const def of listableNodeDefs()) {
      expect(text, `missing ${def.type}`).toContain(`## ${def.type} —`)
    }
    expect(text).not.toContain('neuron.dataset —')
  })

  it('names every port a plan is allowed to wire', () => {
    const text = catalogueText()
    // Picked because it is the wiring people get wrong: three inputs, three outputs.
    // Port id first, type in parentheses — a model read the old `out: dataset:Dataset` form's
    // *label* as the port id and tried to wire from a port called "out".
    expect(text).toContain('inputs:  dataset (Dataset)  sources (Neurons')
    expect(text).toContain('layout (Layout)')
  })

  it('marks optional inputs, so an unwired one does not read as a mistake', () => {
    // `out.neuroglancer`'s Neurons port is optional: a dataset alone is a valid scene.
    const def = getNodeDef('out.neuroglancer')!
    expect(defaultInputPorts(def).find((p) => p.id === 'neurons')?.required).toBe(false)
    expect(catalogueText()).toContain('neurons? (Neurons')
  })

  it('says which node fills a port only that node can fill', () => {
    /*
     * `Compare Connectivity`'s Labels ports. Both ends of the pair are `Table{?}` and
     * `isAssignable` ignores schema, so nothing else in the catalogue says these two nodes
     * compose — and a model wired each Connectivity's own neuron table there instead, 0/5.
     * Rendered as a sentence rather than a tag because a tag measured 0/5 too; the numbers are
     * in `producerLines`.
     */
    expect(catalogueText()).toContain(
      'labels1 comes from compare.matchTypes (Match Cell Types): ' +
        'add one and wire its labels1 output here.',
    )
  })

  it('never names a producer that is not a registered node type', () => {
    /*
     * `registerNode` cannot check this — a producer may register after its consumer — so it is
     * checked here, where the failure would otherwise be a catalogue line telling a model to
     * add a node that does not exist, which reads to it as our mistake and to us as the model
     * hallucinating.
     */
    for (const def of listableNodeDefs()) {
      for (const port of allInputPorts(def)) {
        if (!port.producedBy) continue
        const { type, port: source = port.id } = port.producedBy
        const producer = getNodeDef(type)
        expect(producer, `${def.type}.${port.id} names ${type}`).toBeTruthy()
        // The rendered sentence tells the model to wire *this* output, so it has to be real.
        expect(
          allOutputPorts(producer!).map((p) => p.id),
          `${type} has no ${source} output`,
        ).toContain(source)
      }
    }
  })

  it('never offers an internal param', () => {
    // A plan that set one is refused, so listing it would be a round trip spent on a
    // contradiction between two files.
    for (const def of listableNodeDefs()) {
      for (const param of def.params ?? []) {
        if (!param.internal) continue
        expect(plannableParams(def).map((entry) => entry.id)).not.toContain(param.id)
      }
    }
    expect(catalogueText()).not.toContain('refresh int')
  })

  it('says what a Network port carries, on both of its attribute tables', () => {
    /*
     * `schemaOf` answers for a table and says nothing for a network, so a Network port used to
     * advertise no columns at all — and a model configuring the viewer reached for a *neuron*
     * column, earning `Column "post" is gone` on the card. Network, Skeletons, Meshes and Points
     * all pair geometry with an ordinary attribute table, so `attributeSchema` is what answers.
     */
    const text = catalogueText()
    expect(text).toContain('network carries (nodes): id, degreeIn, degreeOut')
    expect(text).toContain('network carries (links): source, target, weight')
  })

  it('lists static enum options and admits when they depend on the input', () => {
    const text = catalogueText()
    expect(text).toContain('sum | mean | min | max | count | countDistinct')
    expect(text).toContain('options depend on the input')
  })

  it('names the input a picker reads, when that input is one the node runs without', () => {
    /*
     * **Measured on the live suite, and the failure is a plan that looks finished.** Asked to
     * label a dendrogram's leaves by cell type, a model set `labelColumn` and wired nothing —
     * "Configure the dendrogram to use the 'type' column" — `0 added, 0 wired, 1 set`. The value
     * is right and the picker is inert, because `annotations` is empty; nothing refuses it,
     * since an unwired optional port is an ordinary half-built graph.
     *
     * The fact was in the definition all along (`ColumnParam.from`) and simply was not printed.
     * With it: **10/10 against 5/10** over twenty runs of that case on `gemma4:31b-cloud`.
     */
    const text = catalogueText('lean')
    const dendrogram = text.slice(text.indexOf('## out.dendrogram'))
    expect(dendrogram).toContain('labelColumn column default=type (reads the annotations input')
  })

  it('says nothing of the sort for a picker on a required input', () => {
    /*
     * The asymmetry, and it is what keeps this from costing 2.4k characters: 97 column params
     * read a *required* port, where the model has to wire it to use the node at all, so saying
     * so repeats what the port list already forces. Sixteen read an optional one, and those are
     * exactly the params that can be set while the port stays empty.
     */
    const text = catalogueText('lean')
    const filter = text.slice(text.indexOf('## core.filterTable'))
    expect(filter.slice(0, filter.indexOf('##', 2))).not.toContain('reads the')
  })

  it('names the setting that switches a param off', () => {
    /*
     * The measured case. Building a chart from scratch, a model set `core.groupBy`'s
     * `agg: 'count'` *and* its `value: ['weight']` — count the rows, and also aggregate a
     * column — and `applyPlan` refused the whole plan. The gate was in the definition
     * (`visibleIf`) and rendered nowhere, so the two read as independent settings.
     */
    const def = requireNodeDef('core.groupBy')
    const value = def.params?.find((p) => p.id === 'value')
    expect(gateNote(def, value!)).toBe(' (not with agg=count)')
    expect(catalogueText('lean')).toContain('value columns (not with agg=count)')
  })

  it('derives every gate note from the gate itself, so none can be wrong', () => {
    /*
     * **The anti-drift assertion, and the reason this is a probe rather than a sentence beside
     * each predicate.** Every note is checked back against `configurableParams` — the same
     * function `applyPlan` refuses a plan with — so a note can only ever say what the applier
     * will actually do. A hand-written phrase is the second spelling this codebase keeps a rule
     * about; this test is what makes the generated one worth having.
     */
    let checked = 0
    for (const def of listableNodeDefs()) {
      for (const param of def.params ?? []) {
        const note = gateNote(def, param)
        if (!note) continue
        const base = defaultParams(def)
        for (const [, kind, gate, values] of note.matchAll(/(not|only) with (\w+)=([^,)]+)/g)) {
          for (const raw of values!.split('|')) {
            const value = raw === 'true' ? true : raw === 'false' ? false : raw!
            const applies = configurableParams(def, { ...base, [gate!]: value }).some(
              (p) => p.id === param.id,
            )
            // `not with X=v` claims the param is off at v; `only with X=v` claims it is on.
            expect(applies, `${def.type}.${param.id}: "${kind} with ${gate}=${raw}"`).toBe(
              kind === 'only',
            )
            checked++
          }
        }
      }
    }
    // A silent pass would mean the probe found nothing at all, which is its own failure.
    expect(checked, 'gate notes were actually produced and verified').toBeGreaterThan(50)
  })

  it('says nothing for a param nothing gates', () => {
    const def = requireNodeDef('core.groupBy')
    expect(
      gateNote(
        def,
        def.params!.find((p) => p.id === 'agg')!,
      ),
    ).toBe('')
  })

  it('is stable between calls, because it is the cached prefix', () => {
    /*
     * Asked of `catalogueText`, which is rebuilt each time, rather than of the memoised
     * prompt — that would be identity-equal by construction and would pass however unstable
     * the underlying walk was. A single byte differing between turns costs a re-prefill of
     * the whole ~8k-token prefix, so this is the property, and the memo is belt on top of it.
     */
    expect(catalogueText()).toBe(catalogueText())
    expect(buildSystemPrompt()).toContain(catalogueText())
  })
})

describe('a value written as text', () => {
  /*
   * The one thing a live model was ever refused for. Thirty questions against `qwen3.8:latest`
   * produced exactly one rejected plan, and all five problems in it were this: `hops` and
   * `minWeight` as `"1"`, `descending` and `sortBars` as `"true"`. The repair round was told
   * `"hops" wants a whole number, got a string` and sent a string again — the plan schema
   * offers `anyOf: [string, number, …]` and a small model takes the first branch.
   */
  const withParam = (type: string, param: string, value: unknown) =>
    applyPlan(
      emptyGraph(),
      plan({ add: [{ ref: 'n', type, params: { [param]: value as never } }] }),
    )
  /** The same plan, refused — through the file's own helper rather than a narrowing guard. */
  const refusalFor = (type: string, param: string, value: unknown) =>
    refusal({ add: [{ ref: 'n', type, params: { [param]: value as never } }] })

  it('reads "1" as 1 where the param wants a whole number', () => {
    expect(
      nodeFor(expectOk(withParam('neuron.connectivity', 'hops', '2')), 'n').params.hops,
    ).toBe(2)
  })

  it('reads "true" as true where the param wants a boolean', () => {
    const chart = nodeFor(expectOk(withParam('out.barChart', 'sortBars', 'true')), 'n')
    expect(chart.params.sortBars).toBe(true)
  })

  it('leaves a text param alone, since text is what it wanted', () => {
    const found = nodeFor(expectOk(withParam('neuron.inputIds', 'ids', '42')), 'n')
    expect(found.params.ids).toBe('42')
  })

  it('reads 50 as "50" where the options are strings that look like numbers', () => {
    /*
     * The other direction, and the one the prompt fix bought on its very next run:
     * `"pageSize" wants one of its options, got a number`. `out.table`'s options are
     * `'25' | '50' | '100' | '500'` — told to prefer real numbers, the model obliged where it
     * should not have. A conversion that only went one way was always going to leave the other
     * open, whichever way the prompt leaned.
     */
    expect(nodeFor(expectOk(withParam('out.table', 'pageSize', 50)), 'n').params.pageSize).toBe(
      '50',
    )
  })

  it('still refuses a number that is not one of the options', () => {
    // Converting a spelling is not the same as accepting a value. `validateParamValue` keeps
    // the last word, and its message names what is on offer.
    expect(refusalFor('out.table', 'pageSize', 37)).toMatch(/no option "37"/)
  })

  it('refuses "1.5" for a whole number rather than rounding it', () => {
    // Converting is reading a spelling; rounding would be inventing a value. The message the
    // model gets back names the number, which is the honest half of the answer.
    expect(refusalFor('neuron.connectivity', 'hops', '1.5')).toMatch(/whole number/)
  })

  it('refuses text that denotes nothing, in the validator’s own words', () => {
    expect(refusalFor('neuron.connectivity', 'hops', 'two')).toMatch(
      /wants a whole number, got a string/,
    )
  })
})

describe('the filter-row note on Find Neurons', () => {
  /*
   * The one param whose shape its kind cannot convey, and the only one carrying a
   * `catalogueNote`.
   *
   * Read off the **definition**, not scraped out of the prompt between two prose landmarks —
   * that was the first spelling and it could only find the paragraph by its own wording, so
   * moving or renaming it broke the test in a way that looked like a formatting change. What is
   * asserted is that the note is *derived*: its example decodes back to the row it claims to be,
   * every operator it names is one `decodeRows` accepts, and its arity groups agree with
   * `arityOf`. A transcribed grammar passes none of these once the encoder moves, and the
   * failure it would otherwise produce is a plan refused with a message about `filters` — which
   * a model reads as "that param is wrong" rather than "that detail is stale".
   */
  const note = () => {
    const param = requireNodeDef('neuron.findNeurons').params?.find(
      (def) => def.id === 'filters',
    )
    expect(param?.catalogueNote, 'filters carries a catalogue note').toBeTruthy()
    return param!.catalogueNote!
  }

  it('shows an example that decodes back to the row it says it is', () => {
    // Greedy, over one whole line: the encoded row contains `"]` itself, so a non-greedy match
    // stops inside it and hands `JSON.parse` half an example.
    const example = /^\s*(\[".*\])\s*$/m.exec(note())?.[1]
    expect(example, 'the note carries a JSON example').toBeTruthy()
    expect(decodeRows(JSON.parse(example!) as unknown)).toEqual([
      { field: 'type', op: 'matches', values: ['LC.*'] },
    ])
  })

  it('names only operators a stored row can carry', () => {
    const listed = /`op` is one of: ([^.]+)\./.exec(note())![1]!.split(', ')
    expect(listed).toEqual([...ALL_ROW_OPS])
    for (const op of listed) {
      expect(decodeRows([JSON.stringify({ f: 'type', op, v: ['x'] })]), op).toHaveLength(1)
    }
  })

  it('groups the operators by the arity `arityOf` gives them', () => {
    // The half a name-and-count check cannot see: an operator can keep its name and change how
    // many values it takes, and the note would go on claiming the old shape.
    const text = note()
    for (const op of ALL_ROW_OPS) {
      const clause = /take several values in `v`; (.*) take none; the rest take one\./.exec(
        text,
      )
      expect(clause, 'the note states its arity groups').toBeTruthy()
      const takesNone = clause![1]!.includes(`\`${op}\``)
      expect(takesNone, op).toBe(arityOf(op) === 'none')
    }
  })

  it('says what an empty list means, since that is the half a model gets backwards', () => {
    expect(note()).toContain('no neurons')
  })

  it('reaches the model under `lean` as well, or the param cannot be set at all', () => {
    // `help` is dropped under `lean` and this must not be: it is the only thing that makes an
    // opaque param writable, so a lean catalogue without it lists a control nothing can reach.
    expect(catalogueText('lean')).toContain('`op` is one of:')
  })
})

/**
 * The operator vocabulary, in the catalogue rather than in the graph listing.
 *
 * The per-node `options:` line describes a node *on the canvas*, and the commonest thing a plan
 * does is **add** one — at which point there is nothing to describe. Measured live, twice: told
 * only `(options depend on the input)`, a model wrote `op: "is"`, the *label* of `eq`; told
 * nothing about the vocabulary at all, it left `op` unset and inherited the numeric default
 * `ge` on a text column. Both applied and both left a warning on a card.
 */
describe('the operator vocabulary on a filter', () => {
  const note = () => {
    const param = requireNodeDef('core.filterTable').params?.find((p) => p.id === 'op')
    expect(param?.catalogueNote, 'op carries a catalogue note').toBeTruthy()
    return param!.catalogueNote!
  }

  it('names every operator each column type actually allows', () => {
    // Generated by asking `opsForDType`, so a new operator cannot be missing from it — the rule
    // `filtersNote()` already follows, and for the same reason.
    for (const dtype of ['i64', 'str', 'bool'] as const) {
      for (const option of opsForDType(dtype)) {
        expect(note(), `${dtype} allows ${option.value}`).toContain(option.value)
      }
    }
  })

  it('gives values and never labels, which is what a model reached for', () => {
    // `is` is the label of `eq`, `is not` of `ne`, `matches regex` of `matches`.
    expect(note()).not.toMatch(/\bis not\b/)
    expect(note()).not.toContain('matches regex')
    expect(note()).toContain('Write the value, never the label')
  })

  it('reaches the model under `lean`, where every other prose line is dropped', () => {
    // A note says how a value is *written*; without it the param cannot be set correctly at all,
    // which is the asymmetry that keeps `catalogueNote` out of the `help` that `lean` drops.
    expect(catalogueText('lean')).toContain('a boolean column: isTrue | isFalse')
  })
})

/**
 * The two closed vocabularies whose options are dynamic and dataset-dependent.
 *
 * Same criterion `operatorVocabulary()` set: a note is worth writing where the vocabulary is
 * *closed and known to the type*, even though which members are **available** is discovered and
 * cannot be asked for without starting a probe. Measured on the route case: asked for skeletons
 * "from the level-2 cache", a model wrote `"level-2"` five times, `"level2"` three and `"L2"`
 * once in ten runs — the id is `l2` — and with the note, `l2` ten times out of ten.
 */
describe('the closed vocabularies behind a dynamic enum', () => {
  it('names every skeleton route this build knows, generated from the table', () => {
    // Generated, so a route added later cannot be missing from it. That is the whole reason it
    // is a function rather than a sentence beside the param.
    const note = skeletonRouteVocabulary()
    for (const id of Object.values(SKELETON_ROUTES)) {
      expect(note, `route ${id} is named`).toContain(id)
    }
    expect(note).toContain('Empty means Automatic')
  })

  it('names every synapse unit, the same way', () => {
    const note = synapseUnitVocabulary()
    for (const id of Object.values(SYNAPSE_UNITS)) {
      expect(note, `unit ${id} is named`).toContain(id)
    }
  })

  it('reaches the model under `lean`, where the options themselves cannot be listed', () => {
    /*
     * The asymmetry that makes this a `catalogueNote` rather than `help`: the options function
     * is dynamic *and* peeks, so `optionLines` refuses it (`optionsWithoutPeek` is absent on
     * `skeletonSource` on purpose) and `renderParam` can only print "(options depend on the
     * input)". Without the note there is no legal value anywhere in the prompt.
     */
    const text = catalogueText('lean')
    const skeletons = text.slice(text.indexOf('## neuron.skeletons'))
    expect(skeletons).toContain('skeletonSource enum (options depend on the input)')
    expect(skeletons).toContain('l2 (level-2 chunk graph)')
    expect(text).toContain('Unit ids: links (one row per connection)')
  })

  it('offers no live option line for the route, because asking would start a probe', () => {
    // The other half of the same decision — see `optionsWithoutPeek`. If this ever starts
    // emitting, the note is no longer the only source of truth and the probe is firing.
    const def = requireNodeDef('neuron.skeletons')
    expect(
      optionLines(def, defaultParams(def), { dataset: T.dataset('neuprint', 'x') }),
    ).toEqual([])
  })
})

describe('describing the canvas', () => {
  it('says so when there is nothing on it', () => {
    expect(describeGraph(emptyGraph())).toContain('empty')
  })

  it('lists ids, types and wires, so a plan can name them', () => {
    const { graph, ids } = seeded()
    const text = describeGraph(graph)
    expect(text).toContain(ids.find!)
    expect(text).toContain('neuron.findNeurons')
    expect(text).toContain(`${ids.ds}:dataset → ${ids.find}:dataset`)
  })

  it('prints only the params somebody chose', () => {
    const { graph } = seeded()
    const text = describeGraph(graph)
    // An `ids` param prints as the list it stores, which is the same shape the rules teach a
    // plan to write — so what the model reads back is what it would have to send.
    expect(text).toContain(`filters=[${searchFor({ type: 'LC.*' }).filters.join(',')}]`)
    // `limit` is still at its default, so saying it would bury the one value that was set.
    expect(text).not.toContain('limit=')
  })

  it('says nothing about a Pivot’s columns when nothing has run', () => {
    /*
     * Correct, and the reason the rules tell the model to leave such a picker alone: what a
     * Pivot emits depends on the data, so before a run there is genuinely no answer. Unknown
     * is not none — the same rule the column pickers follow.
     */
    const { graph, pivotId } = pivotGraph()
    const text = describeGraph(graph)
    expect(text).toContain(pivotId)
    expect(text).not.toContain('carries: partnerType')
  })

  it('names a Pivot’s real columns once the editor has observed them', () => {
    /*
     * The gap this closes. `inferGraph` takes the schemas that `observesOutputSchema` nodes
     * actually produced, the store folds them in on every commit — and `describeGraph` used to
     * infer without them, so it reported a blank where the app already knew the answer. The
     * model was then following advice ("leave it at its default") that was only correct
     * because of the omission.
     */
    const { graph, pivotId } = pivotGraph()
    const observedSchemas = pivotObserved(pivotId)
    const text = describeGraph(graph, { inference: inferGraph(graph, { observedSchemas }) })
    expect(text).toContain('partnerType')
    expect(text).toContain('weight')
  })

  it('hands a refusal back in the plan’s own terms', () => {
    const text = repairPrompt(['connect[2]: Table ▸ out → Filter ▸ in — Would create a cycle.'])
    expect(text).toContain('connect[2]')
    expect(text).toContain('nothing was applied')
  })
})

/**
 * What a run produced, in the user turn — the values half of "can the assistant inspect
 * results", which turned out to need no tool because every question it answers is an aggregate.
 *
 * The cases that matter are the ones where a line is *wrong to print*: a node whose settings
 * have moved since it ran, an id column, and a folded value list read as the whole set. Each of
 * those produces a plan that applies cleanly and answers a different question, which is the one
 * failure this whole module is arranged against.
 */
describe('what a run produced', () => {
  const TYPES = ['LC4', 'LC4', 'LC4', 'LC6', 'LC6', 'LPLC2', 'LT1', 'T4a', 'T4b', 'T5a', 'Tm3']

  /** A neuron table with a wide id, a category, a measure and a column of prose. */
  function neurons(types: readonly string[] = TYPES) {
    return makeTable(
      tableSchema(
        column('neuronId', 'i64'),
        column('type', 'str'),
        column('pre', 'i64'),
        column('note', 'str'),
      ),
      {
        neuronId: types.map((_, i) => 720575940000000000 + i),
        type: [...types],
        pre: types.map((_, i) => i * 10),
        note: types.map((_, i) =>
          i === 0 ? 'a note that runs on well past forty characters' : '',
        ),
      },
      'neurons',
    )
  }

  /** A context answering for one node, so freshness can be turned off without moving anything. */
  function reader(nodeId: string, value: Value, fresh = true): GraphContext {
    return {
      results: {
        fresh: (id) => fresh && id === nodeId,
        output: (id, port) => (id === nodeId && port === 'neurons' ? value : undefined),
      },
    }
  }

  it('reports the rows and the columns a fresh node produced', () => {
    const { graph, ids } = seeded()
    const text = describeGraph(graph, reader(ids.find!, neurons()))

    expect(text).toContain('ran: neurons — 11 rows')
    // A value a filter could be written with, which is the whole point of the line.
    expect(text).toContain('LC4 (3)')
  })

  it('says nothing at all about a node whose settings have moved since it ran', () => {
    /*
     * **The load-bearing case.** A cache entry is keyed by provenance, so a stale node still
     * holds the numbers its *previous* settings produced — and a digest built from those
     * describes a graph that no longer exists, in a line indistinguishable from a current one.
     * Absence is the answer, and the rules already give absence a meaning: unknown, never none.
     */
    const { graph, ids } = seeded()
    const text = describeGraph(graph, reader(ids.find!, neurons(), false))

    expect(text).not.toContain('ran:')
    expect(text).not.toContain('LC4 (3)')
  })

  it('names the total when it folds a value list, so eight cannot read as all of them', () => {
    /*
     * A bare list of eight cell types invites a filter that silently excludes the rest. Same
     * rule as `+N more` on a legend: where a fold happens, its cost is said out loud.
     */
    const many = Array.from({ length: 30 }, (_, i) => `type${i % 10}`)
    const { graph, ids } = seeded()
    const text = describeGraph(graph, reader(ids.find!, neurons(many)))

    expect(text).toContain('10 distinct, 8 commonest')
  })

  it('drops the counts on a key column, where every one of them is 1', () => {
    /*
     * Downstream of a `Group By` every value appears exactly once, so `AOTU008 (1), Dm8 (1)`
     * spends a third of the line on the number 1 and calls an arbitrary eight the *commonest*.
     * Measured on the wizard's own demo, where the whole chain past the grouping is like this.
     */
    const unique = Array.from({ length: 30 }, (_, i) => `type${i}`)
    const { graph, ids } = seeded()
    const text = describeGraph(graph, reader(ids.find!, neurons(unique)))

    expect(text).toContain('30 distinct, 8 of them: type0, type1')
    expect(text).not.toContain('commonest')
  })

  it('says nothing about folding when the list is the whole list', () => {
    // The other spelling, and the reason there are two: a complete list must not carry a
    // caveat, or every list reads as partial and the caveat stops meaning anything.
    const { graph, ids } = seeded()
    const text = describeGraph(graph, reader(ids.find!, neurons(['LC4', 'LC6'])))

    expect(text).toContain('2 distinct: LC4, LC6')
    expect(text).not.toContain('commonest')
  })

  it('never prints a value from the id column', () => {
    /*
     * Invariant 8, reached from the one direction that has no type to stop it. `CellValue` is a
     * float64, so an 18-digit root id in a cell is already a different neuron — offering one as
     * a value to copy into a filter is how this module would invent a neuron. `describeOps`
     * refuses to *measure* the id column for the same reason; this refuses to list it.
     */
    const { graph, ids } = seeded()
    const text = describeGraph(graph, reader(ids.find!, neurons()))

    expect(text).toContain('neuronId (i64)')
    expect(text).not.toContain('720575940')
  })

  it('gives a numeric column a range and a median rather than a list of values', () => {
    // A threshold is chosen from the spread. A list of the eight commonest synapse counts is
    // not a thing anybody filters on, and it would cost the line that is.
    const { graph, ids } = seeded()
    const text = describeGraph(graph, reader(ids.find!, neurons()))

    expect(text).toMatch(/pre \(i64\) 0 … 100, median 50/)
  })

  it('counts an absent cell rather than listing it, empty string included', () => {
    // `valueLabel`'s rule, inherited by using `describeTable` rather than a second pass: an
    // empty string is nothing recorded, so a column of one note is one distinct value.
    const { graph, ids } = seeded()
    const text = describeGraph(graph, reader(ids.find!, neurons()))

    expect(text).toContain('10 null')
  })

  it('summarises a value that is not a table by what it is', () => {
    const { graph, ids } = seeded()
    const network: Value = {
      kind: 'network',
      directed: true,
      nodes: makeTable(tableSchema(column('id', 'str')), { id: ['a', 'b', 'c'] }),
      edges: makeTable(tableSchema(column('source', 'str'), column('target', 'str')), {
        source: ['a', 'b'],
        target: ['b', 'c'],
      }),
    }
    const text = describeGraph(graph, reader(ids.find!, network))

    expect(text).toContain('network — 3 nodes, 2 links')
  })

  it('counts a table too large to summarise instead of walking it', () => {
    /*
     * This runs unasked on every question, so the ceiling is far below the Describe node's own —
     * that one warns on a node somebody chose to add. A digest that spent seconds sorting a
     * 400k-row table before the model had seen the request would be a hang with no cause.
     */
    const big = makeTable(tableSchema(column('type', 'str')), {
      type: Array.from({ length: 300_000 }, (_, i) => `t${i % 7}`),
    })
    const { graph, ids } = seeded()
    const text = describeGraph(graph, reader(ids.find!, big))

    expect(text).toContain('ran: neurons — 300,000 rows')
    expect(text).toContain('too large to summarise')
  })

  it('names a repeated summary rather than printing it again', () => {
    /*
     * Measured, not anticipated: a passthrough chain summarises identically at every step — a
     * Sort changes no per-column aggregate, and a Table viewer's `out` and `filtered` are the
     * same table with no filter set — so the wizard's own seven-node demo emitted one four-line
     * block **four times**, 2,257 characters of which about six hundred said anything.
     *
     * Named rather than dropped, because "these two are the same table" is worth knowing and
     * costs one line.
     */
    const table = neurons()
    const chain = expectOk(
      applyPlan(
        emptyGraph(),
        plan({
          add: [
            { ref: 'a', type: 'core.filterTable' },
            { ref: 'b', type: 'core.sort' },
          ],
        }),
      ),
    )
    const text = describeGraph(chain.graph, {
      results: { fresh: () => true, output: () => table },
    })

    expect(text.match(/type \(str\)/g)).toHaveLength(1)
    expect(text).toMatch(/\(same columns as \w+:out\)/)
    // The headline survives on both, because a row count is the half most questions need.
    expect(text.match(/ran: out — 11 rows/g)).toHaveLength(2)
  })

  it('counts the columns of a very wide table rather than naming every one', () => {
    /*
     * `core.pivot` emits one column per distinct value of the column it pivots on, so a pivot
     * over cell type is hundreds of narrow columns and very few cells — it sails past the cell
     * ceiling and would then spend the whole graph's budget in one node. The `carries:` line has
     * already named them all, so the count here is what stops the two contradicting each other.
     */
    const names = Array.from({ length: 40 }, (_, i) => `col${i}`)
    const wide = makeTable(
      tableSchema(...names.map((name) => column(name, 'str'))),
      Object.fromEntries(names.map((name) => [name, ['a', 'b']])),
    )
    const { graph, ids } = seeded()
    const text = describeGraph(graph, reader(ids.find!, wide))

    expect(text).toContain('col0 (str)')
    expect(text).toContain('and 16 more columns, not summarised')
    expect(text).not.toContain('col39 (str)')
  })

  it('drops column detail rather than the node once the budget is spent, and counts it', () => {
    /*
     * The graph listing is already the largest per-request thing in the prompt, and a canvas of
     * twenty run nodes would double it. The headline survives — a row count is the half most
     * questions need — and the shortfall is stated rather than being an absence the model would
     * read as "this node has not run".
     */
    const many = expectOk(
      applyPlan(
        emptyGraph(),
        plan({
          add: Array.from({ length: 20 }, (_, i) => ({
            ref: `f${i}`,
            type: 'core.filterTable',
          })),
        }),
      ),
    )
    /*
     * A different table per node, or the repeat detection answers first and the budget is never
     * reached — which is itself the measured behaviour on a real passthrough chain, and the
     * reason this fixture has to work at it.
     */
    const perNode = new Map(
      many.graph.nodes.map((n) => [n.id, neurons(TYPES.map((t) => `${t}-${n.id}`))]),
    )
    const text = describeGraph(many.graph, {
      results: { fresh: () => true, output: (id) => perNode.get(id) },
    })

    expect(text).toContain('ran: out — 11 rows')
    expect(text).toMatch(/column detail left out for \d+ more nodes/)
    // Every node still says how many rows it has; only the columns are rationed.
    expect(text.match(/ran: out — 11 rows/g)).toHaveLength(20)
  })

  it('is absent entirely when the caller has no results to read', () => {
    // Every headless caller, and a graph nobody has run. The same fallback `inference` takes.
    const { graph } = seeded()
    expect(describeGraph(graph)).not.toContain('ran:')
  })
})

/**
 * What a param's options actually are on *this* node — the answer the catalogue cannot give.
 *
 * `renderParam` prints `(options depend on the input)` for a function-valued enum, because a
 * catalogue describes a node *type* and `core.filterTable`'s operators depend on the dtype of
 * the column somebody picked. A model that cannot see them guesses: measured live, both a local
 * and a cloud model wrote `op: "is"`, which is the *label* of `eq`. Nothing refuses it —
 * `validateParamValue` skips dynamic options by design — so the plan applies and the node
 * carries a warning the user has to find.
 */
describe('the options a node actually offers', () => {
  /** `Connectivity → Filter`, so the filter's column has a real dtype to derive operators from. */
  function filtering(column: string) {
    const result = expectOk(
      applyPlan(emptyGraph(), {
        ...SEED,
        add: [
          ...SEED.add,
          { ref: 'conn', type: 'neuron.connectivity' },
          { ref: 'f', type: 'core.filterTable', params: { column } },
        ],
        connect: [
          ...SEED.connect,
          { from: { node: 'ds', port: 'dataset' }, to: { node: 'conn', port: 'dataset' } },
          { from: { node: 'find', port: 'neurons' }, to: { node: 'conn', port: 'neurons' } },
          { from: { node: 'conn', port: 'connections' }, to: { node: 'f', port: 'in' } },
        ],
      }),
    )
    return describeGraph(result.graph)
  }

  it('opens on a condition the chosen column actually offers', () => {
    /*
     * `core.filterTable` declares `default: 'ge'`, a number comparison, so a fresh node pointed
     * at a text column carried `"ge" does not apply to a str column` before anything had been
     * done to it — and the assistant, which cannot see the dropdown, had no reason to set `op`
     * at all and inherited it silently. `resolveFilterOp` resolves a *declared default* against
     * the column; a value somebody chose is kept so `validate` can still refuse it.
     */
    const text = filtering('postType')
    expect(text).not.toContain('does not apply')

    // The resolver's own arithmetic is pinned beside it, in `tableOps.test.ts`; what belongs
    // here is only that the assistant sees a node it can configure without a warning.
  })

  it('names the operators a string column offers, by value and not by label', () => {
    // `is` is the label of `eq` in `tableOps.ts`, and is what a model reached for unprompted.
    const text = filtering('postType')
    expect(text).toContain('options: op = eq | ne | contains')
    expect(text).not.toMatch(/options: op = .*\bis\b/)
  })

  it('names different operators for a numeric column, which is why it cannot be in the catalogue', () => {
    // The whole reason this is per-node: the same param on the same type answers differently
    // depending on what is wired to it.
    const text = filtering('weight')
    expect(text).toContain('options: op = eq | ne | gt | ge | lt | le')
    expect(text).not.toContain('contains')
  })

  it('says nothing about a param whose options are static, since the catalogue has them', () => {
    /*
     * `neuron.connectivity`'s `direction` is a real static enum, which is what makes this able
     * to fail: an earlier version asserted on `limit` and `filters`, an `int` and an `ids` param
     * that carry no options at all, so it passed on the `kind` guard without reaching the
     * question.
     */
    expect(filtering('weight')).not.toContain('options: direction =')
  })

  it('counts the tail rather than printing every value', () => {
    /*
     * A fold is stated, the digest's rule — and it matters more here, because a value the model
     * cannot see may still be legal while one it invents is refused. Asked of a definition built
     * for the purpose rather than of a registered node, because no shipped node has thirty
     * options against a dataset a test can hold still.
     */
    const def: NodeDefinition = {
      type: 'test.manyOptions',
      label: 'Many',
      category: 'transform',
      cost: 'cheap',
      inputs: [],
      outputs: [],
      params: [
        {
          id: 'pick',
          kind: 'enum',
          label: 'Pick',
          default: '',
          optionsWithoutPeek: true,
          options: () =>
            Array.from({ length: 30 }, (_, i) => ({ value: `R${i}`, label: `R${i}` })),
        },
      ],
      inferOutputs: () => ({}),
      evaluate: () => ({}),
    }

    const [line] = optionLines(def, { pick: '' }, {})
    expect(line).toContain('pick = R0 | R1')
    expect(line).toContain('and 18 more')
  })

  it('resolves no options function that would start a dataset listing', () => {
    /*
     * **The safety property, and the whole reason `optionsWithoutPeek` is opt-in rather than
     * assumed.** `dataset.*.version` reads `versionsFor` → `peekDatasets`, one of the two peeks
     * that *start the fetch they cannot answer*. Resolving every dynamic param here would fire a
     * dataset listing per dataset node — at two CATMAID servers and CAVE — because somebody
     * asked a question, which is the failure the demo links had to be redesigned around.
     *
     * Behavioural rather than a check that the line is absent: that one would pass just as well
     * if the function were called and its answer thrown away, which is the version that still
     * makes the requests.
     */
    registerBuiltinSources()
    const source = getSource('neuprint')
    expect(source, 'the neuPrint source is registered').toBeTruthy()

    /*
     * **The deny-list itself, method by method, rather than `fetch`.** Watching `fetch` reads as
     * the stronger pin and is the weaker one: `skeletonSourcesFor` starts its probe through an
     * `await` chain that bails in a fresh process before any request goes out, so a `fetch` spy
     * stays green on exactly the param that made this rename necessary. These three are the
     * seams the flag's contract names, they are synchronous, and calling one *is* the violation
     * whether or not a socket is opened afterwards.
     */
    const watched = ['peekDatasets', 'schemasFor', 'skeletonSourcesFor'] as const
    const held = source as unknown as Record<string, () => unknown>
    const spies = watched.map((name) => {
      const original = held[name]!
      expect(typeof original, `${name} exists to be watched`).toBe('function')
      const spy = vi.fn(original)
      held[name] = spy
      return { name, spy, original }
    })

    for (const def of listableNodeDefs()) {
      const inputs: Record<string, CodaType | undefined> = {}
      for (const port of defaultInputPorts(def)) {
        inputs[port.id] = T.dataset('neuprint', 'hemibrain:v1.2.1')
      }
      optionLines(def, defaultParams(def), inputs)
    }

    for (const { name, spy } of spies) {
      expect(spy, `no options function reached ${name}`).not.toHaveBeenCalled()
    }
    for (const { name, original } of spies) held[name] = original
  })
})

describe('the loop, end to end', () => {
  /**
   * Everything except the network: a reply in the shape the API returns it, through
   * `requestPlan`, `parsePlan` and `applyPlan`, out as a graph.
   *
   * The reply is written the way the schema constrains the model to write it — params as a
   * list of pairs, every array present — rather than the way the internal types read, so this
   * fails if the wire format and the applier ever stop agreeing.
   */
  const MODEL_REPLY = JSON.stringify({
    summary: 'Chart the strongest partners of the LC4 neurons.',
    add: [
      { ref: 'ds', type: 'dataset.mock.opticlobe', params: [], title: '' },
      {
        ref: 'find',
        type: 'neuron.findNeurons',
        params: [{ param: 'filters', value: searchFor({ type: 'LC4' }).filters }],
        title: '',
      },
      {
        ref: 'conn',
        type: 'neuron.connectivity',
        params: [{ param: 'minWeight', value: 5 }],
        title: '',
      },
      { ref: 'chart', type: 'out.barChart', params: [], title: 'Partners' },
    ],
    remove: [],
    setParams: [],
    connect: [
      { from: { node: 'ds', port: 'dataset' }, to: { node: 'find', port: 'dataset' } },
      { from: { node: 'ds', port: 'dataset' }, to: { node: 'conn', port: 'dataset' } },
      { from: { node: 'find', port: 'neurons' }, to: { node: 'conn', port: 'neurons' } },
      { from: { node: 'conn', port: 'connections' }, to: { node: 'chart', port: 'in' } },
    ],
    disconnect: [],
  })

  /** The reply shape lives with the client it is a reply from, so the two cannot drift. */
  function stubReply(text: string): void {
    stubFetch((name, value) => vi.stubGlobal(name, vi.fn(value as never)), messagesReply(text))
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('turns a reply into a graph the type system already accepted', async () => {
    stubReply(MODEL_REPLY)

    const outcome = await requestPlan({
      graph: emptyGraph(),
      messages: [{ role: 'user', content: 'Chart what LC4 talks to.' }],
      apiKey: 'sk-ant-test',
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const result = expectOk(applyPlan(emptyGraph(), outcome.plan))
    expect(result.graph.nodes).toHaveLength(4)
    expect(result.graph.edges).toHaveLength(4)
    expect(nodeFor(result, 'conn').params.minWeight).toBe(5)

    /*
     * The Bar Chart's category and value columns are not knowable here — Connectivity's
     * schema is published, but the point stands for anything downstream of a Pivot or a
     * Cypher — and the plan was applied anyway. Whatever is reported belongs to a node this
     * plan created, never to the rest of the canvas.
     *
     * (The one warning that does turn up here is `Data source "mock" is not registered`, which
     * is an artefact of the test importing the node pack without the app's source registry.)
     */
    const ids = new Set(Object.values(result.created))
    expect(result.warnings.every((w) => ids.has(w.nodeId))).toBe(true)
  })

  it('sends the catalogue as the cached prefix and the graph as the user turn', async () => {
    stubReply(MODEL_REPLY)
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>

    const { graph } = seeded()
    await requestPlan({
      graph,
      messages: [{ role: 'user', content: 'Add a table.' }],
      apiKey: 'sk-ant-test',
    })

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as {
      system: Array<{ text: string; cache_control?: unknown }>
      messages: Array<{
        role: string
        content: Array<{ text: string; cache_control?: unknown }>
      }>
    }
    // The graph changes every turn; if it were in the system prompt nothing would ever cache.
    expect(body.system[0]!.text).toContain('## core.filterTable —')
    expect(body.system[0]!.text).not.toContain(graph.nodes[0]!.id)
    expect(body.system[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })

    const lastTurn = body.messages.at(-1)!
    expect(lastTurn.content[0]!.text).toContain(graph.nodes[0]!.id)
    expect(lastTurn.content[0]!.text).toContain('Add a table.')
    // The second breakpoint: without it every repair round re-uploads the whole conversation.
    expect(lastTurn.content[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('hands back a reply that is not a plan as a message, not as a throw', async () => {
    stubReply('I would rather not.')
    const outcome = await requestPlan({
      graph: emptyGraph(),
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-ant-test',
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain('not JSON')
  })

  it('refuses to send a conversation that does not end with the user', async () => {
    // The graph is attached to the last user turn, so there is nowhere to put it otherwise.
    const outcome = await requestPlan({
      graph: emptyGraph(),
      messages: [{ role: 'assistant', content: 'done' }],
      apiKey: 'sk-ant-test',
    })
    expect(outcome.ok).toBe(false)
  })
})

describe('the whole registry, against the applier', () => {
  let graph: CodaGraph

  beforeEach(() => {
    graph = emptyGraph()
  })

  it('can add every listable node type with its defaults', () => {
    // The catalogue offers all of them, so all of them have to survive being asked for. This
    // is the tripwire for a node whose defaults do not satisfy its own param kinds.
    for (const def of listableNodeDefs()) {
      const result = applyPlan(graph, plan({ add: [{ ref: 'x', type: def.type }] }))
      if (!result.ok) expect.fail(`${def.type}: ${result.errors.join(' ')}`)
    }
  })

  it('accepts every definition default as a param value a plan could send', () => {
    // A default the applier would reject means the catalogue is advertising a value that
    // cannot be written back — which is exactly what a model copies out of it.
    //
    // Asked of the params that *apply* to a node holding its own defaults, not of every
    // plannable param: one whose `visibleIf` its defaults switch off is refused on purpose,
    // which the test below covers.
    for (const def of listableNodeDefs()) {
      const params: Record<string, unknown> = {}
      for (const param of configurableParams(def, defaultParams(def))) {
        params[param.id] = (param as { default?: unknown }).default
      }
      const result = applyPlan(
        graph,
        plan({ add: [{ ref: 'x', type: def.type, params: params as never }] }),
      )
      if (!result.ok) expect.fail(`${def.type}: ${result.errors.join(' ')}`)
    }
  })

  it('can wire the first output of one node into a matching input of another', () => {
    // A smoke test over the type system rather than an exhaustive one: every table producer
    // should reach `out.table`.
    const producers = listableNodeDefs().filter((d) =>
      defaultOutputPorts(d).some((p) => p.type.kind === 'table'),
    )
    expect(producers.length).toBeGreaterThan(5)

    for (const def of producers) {
      const port = defaultOutputPorts(def).find((p) => p.type.kind === 'table')!
      const result = applyPlan(
        emptyGraph(),
        plan({
          add: [
            { ref: 'src', type: def.type },
            { ref: 'sink', type: 'out.table' },
          ],
          connect: [{ from: { node: 'src', port: port.id }, to: { node: 'sink', port: 'in' } }],
        }),
      )
      if (!result.ok)
        expect.fail(`${def.type}:${port.id} → out.table: ${result.errors.join(' ')}`)
    }
  })

  it('adds an edge for a graph that was loaded rather than planned', () => {
    // `applyPlan` must not assume the graph it was handed came from a plan — the usual case
    // is a `.coda.json` somebody opened.
    const loaded = addEdge(
      addNode(
        addNode(emptyGraph(), {
          id: 'ds1',
          type: 'dataset.mock.opticlobe',
          position: { x: 0, y: 0 },
          params: { version: '', refresh: 0 },
        }),
        {
          id: 'find1',
          type: 'neuron.findNeurons',
          position: { x: 300, y: 0 },
          params: {},
        },
      ),
      { source: 'ds1', sourceHandle: 'dataset', target: 'find1', targetHandle: 'dataset' },
    )

    const result = expectOk(
      applyPlan(
        loaded,
        plan({
          add: [{ ref: 't', type: 'out.table' }],
          connect: [
            { from: { node: 'find1', port: 'neurons' }, to: { node: 't', port: 'in' } },
          ],
        }),
      ),
    )
    expect(result.graph.edges).toHaveLength(2)
  })
})

/** A plan the applier accepts and the mapper would have to fix: Labels fed by a neuron table. */
const MIS_WIRED_REPLY = JSON.stringify({
  summary: 'Compare connectivity across two datasets.',
  add: [
    { ref: 'ds', type: 'dataset.mock.opticlobe', params: [], title: '' },
    { ref: 'find', type: 'neuron.findNeurons', params: [], title: '' },
    { ref: 'conn', type: 'neuron.connectivity', params: [], title: '' },
    { ref: 'cmp', type: 'compare.connectivity', params: [], title: '' },
  ],
  remove: [],
  setParams: [],
  connect: [
    { from: { node: 'ds', port: 'dataset' }, to: { node: 'find', port: 'dataset' } },
    { from: { node: 'ds', port: 'dataset' }, to: { node: 'conn', port: 'dataset' } },
    { from: { node: 'find', port: 'neurons' }, to: { node: 'conn', port: 'neurons' } },
    { from: { node: 'conn', port: 'connections' }, to: { node: 'cmp', port: 'edges1' } },
    { from: { node: 'find', port: 'neurons' }, to: { node: 'cmp', port: 'labels1' } },
  ],
  disconnect: [],
})

describe('a plan that is legal and still wrong', () => {
  /*
   * The gap: `applyPlan` checks types, ports, params and cycles, and `isAssignable` ignores
   * schema — so `Table{?} → Table{?}` is accepted whatever the two tables hold. Asked for a
   * three-dataset comparison, a model wired each dataset's own neuron table into Compare
   * Connectivity's Labels ports on five runs out of five, and nothing anywhere said so.
   */

  /**
   * The graph, built by applying the plan the model sends rather than restated by hand.
   *
   * The suite's whole claim is that the graph *this plan* produces raises the concern — so a
   * hand-built copy is the one that goes stale while still passing, which is the rule
   * `fixture.ts` states in its own header. `dataset.mock.opticlobe` is synthetic, so no
   * Description companion arrives to make the two disagree.
   */
  const misWiredComparison = () =>
    expectOk(applyPlan(emptyGraph(), parsedPlan(MIS_WIRED_REPLY)))

  /**
   * One turn against a scripted sequence of replies, with the graph it left and what reached
   * `turn.apply` — the three loop tests differ only in the replies and the two assertions.
   */
  async function turnWith(replies: readonly string[]) {
    stubFetch(
      (name, value) => vi.stubGlobal(name, vi.fn(value as never)),
      replies.map(messagesReply),
    )
    setKey('anthropic', 'sk-ant-test')
    let graph = emptyGraph()
    const applied: AssistantPlan[] = []
    const outcome = await runTurn({
      request: 'Compare connectivity across two datasets.',
      graph: () => graph,
      apply: (plan) => {
        applied.push(plan)
        const result = applyPlan(graph, plan)
        if (result.ok) graph = result.graph
        return result
      },
    })
    return { outcome, applied, types: () => graph.nodes.map((n) => n.type) }
  }

  /** Every complaint on a graph, as one string. */
  const messagesOf = (graph: CodaGraph) =>
    Object.values(inferGraph(graph).nodes)
      .flatMap((n) => n.issues.map((i) => i.message))
      .join('\n')

  // A tail `unstubAllGlobals` leaks the stubbed `fetch` into the next test when an assertion
  // above it fails, which is how one broken test becomes five.
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('says a Labels table is not a labels table, where the schema is known', () => {
    expect(messagesOf(misWiredComparison().graph)).toContain(
      'Dataset 1: the Labels table has no "label" column, so it is not a Match Cell Types',
    )
  })

  it('stands down once a picker has been pointed somewhere by hand', () => {
    /*
     * `resolveColumn`'s rule, applied here: a declared default is not a decision and a chosen
     * value is. A hand-built `{neuronId, name}` table with `labelColumn` set to `name` is a
     * legitimate thing to wire, and `producedBy` states the pairing without constraining it.
     */
    const applied = misWiredComparison()
    const cmp = applied.created.cmp!
    const node = applied.graph.nodes.find((n) => n.id === cmp)!
    const graph = updateNode(applied.graph, cmp, {
      params: { ...node.params, labelColumn: 'type' },
    })
    expect(messagesOf(graph)).not.toContain('is not a Match Cell Types labels table')
  })

  it('leaves column complaints out, having already told the model they are fine', () => {
    /*
     * `NodeIssue.aboutColumns`, carried through `ApplyWarning`. The model has already been told
     * a column it cannot know yet is fine, so raising them again contradicts the system prompt
     * — and on a live build there were four to six of them around the one actionable line,
     * which is how the actionable line gets ignored.
     */
    const withBadColumn = parsedPlan(MIS_WIRED_REPLY)
    withBadColumn.setParams.push({ node: 'cmp', param: 'pre1', value: 'nosuchcolumn' })
    const applied = expectOk(applyPlan(emptyGraph(), withBadColumn))
    // Both complaints are on the card; the model is shown one of them.
    expect(applied.warnings.some((w) => w.aboutColumns)).toBe(true)
    const concerns = concernsFrom(applied.warnings).join('\n')
    expect(concerns).toContain('is not a Match Cell Types labels table')
    expect(concerns).not.toContain('nosuchcolumn')
  })

  it('says nothing about a node the plan did not touch', () => {
    /*
     * `collectWarnings`' scoping, which is what this reuses instead of diffing two inferences:
     * a graph that was already complaining three nodes away did not acquire that here, and
     * reporting it beside the edit reads as the assistant having broken something.
     */
    const already = misWiredComparison().graph
    const elsewhere = expectOk(
      applyPlan(
        already,
        plan({ add: [{ ref: 'note', type: 'note.text', params: {}, title: '' }] }),
      ),
    )
    expect(concernsFrom(elsewhere.warnings).join('\n')).not.toContain(
      'is not a Match Cell Types labels table',
    )
  })

  it('holds the plan, asks once, and applies the answer', async () => {
    /*
     * The round is advisory, not a refusal: the first plan is *valid* and is kept. So the whole
     * turn stays one commit and one undo step — the plan is previewed with the pure `applyPlan`
     * and only the answer reaches `turn.apply`.
     */
    const mapper = JSON.stringify({
      summary: 'Use the mapper for labels.',
      add: [{ ref: 'm', type: 'compare.matchTypes', params: [], title: '' }],
      remove: [],
      setParams: [],
      connect: [],
      disconnect: [],
    })
    const { outcome, applied } = await turnWith([MIS_WIRED_REPLY, mapper])
    expect(outcome.ok).toBe(true)
    // Applied once — the first plan was previewed, held, and never committed.
    expect(applied.map((p) => p.add.length)).toEqual([1])
  })

  it('falls back to the held plan when the second answer does not fit', async () => {
    /*
     * An advisory round must never leave the user with less than they would have had. The
     * follow-up here names a node type that does not exist, so it is refused — and the plan we
     * chose to question is applied instead.
     */
    const nonsense = JSON.stringify({
      summary: 'Nonsense.',
      add: [{ ref: 'x', type: 'no.such.node', params: [], title: '' }],
      remove: [],
      setParams: [],
      connect: [],
      disconnect: [],
    })
    const { outcome, types } = await turnWith([MIS_WIRED_REPLY, nonsense])
    expect(outcome.ok).toBe(true)
    expect(types()).toContain('compare.connectivity')
  })

  it('takes an empty answer as “these are all fine” and applies what it held', async () => {
    const declined = JSON.stringify({ ...emptyPlan(), summary: 'All fine.' })
    const { outcome, types } = await turnWith([MIS_WIRED_REPLY, declined])
    expect(outcome.ok).toBe(true)
    expect(types()).toContain('compare.connectivity')
  })

  it('tells the model the graph is unchanged and that doing nothing is an answer', () => {
    /*
     * Both halves are load-bearing and neither is `repairPrompt`'s. A model told its edit landed
     * sends a diff against a graph that does not exist; a model not told that leaving a warning
     * alone is allowed invents an edit to justify the round.
     */
    const text = concernPrompt(['n1 (Compare Connectivity): the Labels table has no "label".'])
    expect(text).toContain('nothing has been applied yet')
    expect(text).toContain('reply with an empty plan')
    expect(text).toContain('warnings, not refusals')
  })
})

describe('a reply that is not quite a plan', () => {
  /*
   * Structured output is *requested* of every provider here and honoured to wildly different
   * degrees — a compiled grammar at one end, a strong suggestion at the other. These are the
   * three shapes a reply arrives in when it is not honoured, found against a local model that
   * accepts the schema and ignores it.
   */
  it('digs the object out of a fenced reply', () => {
    const result = parsePlan('```json\n{"summary":"hi","add":[]}\n```')
    if (!result.ok) expect.fail(result.error)
    expect(result.plan.summary).toBe('hi')
  })

  it('digs the object out from behind prose', () => {
    const result = parsePlan(
      'Sure! Here is the plan:\n\n{"summary":"hi","add":[]}\n\nHope that helps.',
    )
    if (!result.ok) expect.fail(result.error)
    expect(result.plan.summary).toBe('hi')
  })

  it('ignores braces inside a reasoning block, which come before the real ones', () => {
    // A model reasoning about a plan writes braces while doing it, so the *first* `{` in the
    // reply is the wrong one — this returned the scratch object before the strip existed.
    const result = parsePlan(
      '<think>Maybe {"add": "a dataset"} would work?</think>{"summary":"real","add":[]}',
    )
    if (!result.ok) expect.fail(result.error)
    expect(result.plan.summary).toBe('real')
  })

  it('does not end the object at a brace inside a string', () => {
    // Fenced on purpose: a bare object parses on the fast path and never reaches the scanner,
    // so the plain spelling of this test passes with the string handling removed.
    const result = parsePlan('```\n{"summary":"a } brace","add":[]}\n```')
    if (!result.ok) expect.fail(result.error)
    expect(result.plan.summary).toBe('a } brace')
  })

  it("refuses a reply in somebody else's shape rather than reading it as an empty plan", () => {
    /*
     * The failure this exists for. Every field is read by name, so an object carrying none of
     * them parsed *successfully* as a plan that does nothing — while carrying a confident
     * sentence about what it had done. Observed verbatim from a model given the real schema.
     */
    const result = parsePlan(
      JSON.stringify({
        summary: 'Find LC4 neurons and show them.',
        // Nothing here names a verb, so there is nothing to recover — as against
        // `{action: 'add', …}`, which is recognised and refused on its payload instead.
        steps: [{ description: 'open the dataset' }],
      }),
    )
    if (result.ok) expect.fail('a foreign shape must not pass as an empty plan')
    expect(result.error).toContain('steps')
    expect(result.error).toContain('did not follow the requested format')
  })

  it('still accepts a summary on its own, because that is how a decline arrives', () => {
    // "Coda has no node for that" is a real answer and carries no actions at all. It must not
    // be caught by the rule above.
    const result = parsePlan(
      JSON.stringify({ summary: 'Coda has no statistical-testing node.' }),
    )
    if (!result.ok) expect.fail(result.error)
    expect(isEmptyPlan(result.plan)).toBe(true)
  })

  it('says the model may not support structured output when there is no object at all', () => {
    const result = parsePlan('I am afraid I cannot help with that.')
    if (result.ok) expect.fail('expected a refusal')
    expect(result.error).toContain('structured output')
  })
})

describe('recovering a plan a weak model wrapped in an envelope of its own', () => {
  /*
   * Every reply quoted here was captured verbatim from a local model that accepts the JSON
   * schema and ignores it. The actions came back *right* every time — correct node types,
   * correct params, correct ports — inside a list of the model's own invention, under a
   * different key each run. That is what makes them recoverable, and the varying key is why the
   * rule is written against Coda's own verb names rather than against a list of envelope names.
   */
  it('reads `steps`, which is not a word this format uses', () => {
    const result = parsePlan(
      JSON.stringify({
        summary: 'Find LC4 neurons in hemibrain and display them in a table.',
        steps: [
          { add: { ref: 'hemi', type: 'dataset.hemibrain' } },
          {
            add: {
              ref: 'findLC4',
              type: 'neuron.findNeurons',
              params: searchFor({ type: 'LC4' }),
            },
          },
          { add: { ref: 'table', type: 'out.table' } },
          {
            connect: {
              from: { ref: 'hemi', port: 'dataset' },
              to: { ref: 'findLC4', port: 'dataset' },
            },
          },
          {
            connect: {
              from: { ref: 'findLC4', port: 'neurons' },
              to: { ref: 'table', port: 'in' },
            },
          },
        ],
      }),
    )
    if (!result.ok) expect.fail(result.error)
    expect(result.plan.add.map((n) => n.type)).toEqual([
      'dataset.hemibrain',
      'neuron.findNeurons',
      'out.table',
    ])
    expect(result.plan.add[1]!.params).toEqual(searchFor({ type: 'LC4' }))
    // `ref` where the format says `node` — the same word `add` uses for that very node.
    expect(result.plan.connect[0]!.from).toEqual({ node: 'hemi', port: 'dataset' })
  })

  it('reads `ops` the same way, without `ops` appearing anywhere in the code', () => {
    const result = parsePlan(
      JSON.stringify({
        summary: 'Find all LC4 neurons.',
        ops: [
          { add: { type: 'dataset.hemibrain', ref: 'ds' } },
          {
            connect: {
              from: { node: 'ds', port: 'dataset' },
              to: { node: 'find', port: 'dataset' },
            },
          },
        ],
      }),
    )
    if (!result.ok) expect.fail(result.error)
    expect(result.plan.add).toHaveLength(1)
    expect(result.plan.connect).toHaveLength(1)
  })

  it('reads the tagged form, which was three of four samples', () => {
    // `{action: 'add', …}` rather than `{add: {…}}` — the verb as a value, the rest as payload.
    const result = parsePlan(
      JSON.stringify({
        summary: 'Chart the upstream partners of DNp01.',
        plan: [
          { action: 'add', type: 'dataset.hemibrain', ref: 'ds' },
          {
            action: 'add',
            type: 'neuron.findNeurons',
            ref: 'find',
            params: searchFor({ type: 'LC4' }),
          },
          {
            action: 'connect',
            from: { node: 'ds', port: 'dataset' },
            to: { node: 'find', port: 'dataset' },
          },
        ],
      }),
    )
    if (!result.ok) expect.fail(result.error)
    expect(result.plan.add.map((n) => n.ref)).toEqual(['ds', 'find'])
    expect(result.plan.connect).toHaveLength(1)
  })

  it('does not mistake a node type for a verb', () => {
    /*
     * The tagged form finds the verb by *value*, and `add`'s own payload carries a `type` field.
     * Node types all contain a dot and none is a bare verb, which is what keeps the two apart —
     * a type of literally `connect` would be the collision, and no such type exists.
     */
    const result = parsePlan(
      JSON.stringify({ summary: 'x', ops: [{ op: 'add', type: 'out.table', ref: 't' }] }),
    )
    if (!result.ok) expect.fail(result.error)
    expect(result.plan.add).toEqual([{ ref: 't', type: 'out.table' }])
  })

  it('takes a removal named as an object, since only that verb is a bare string', () => {
    // The tagged envelope hands every verb an object, so `remove` alone needs the leniency.
    const result = parsePlan(
      JSON.stringify({ summary: 'x', steps: [{ action: 'remove', node: 'n3_k91' }] }),
    )
    if (!result.ok) expect.fail(result.error)
    expect(result.plan.remove).toEqual(['n3_k91'])
  })

  it('reads a compact "node.port" reference', () => {
    const result = parsePlan(
      '{"summary":"x","connect":[{"from":"ds.dataset","to":"find.dataset"}]}',
    )
    if (!result.ok) expect.fail(result.error)
    expect(result.plan.connect[0]).toEqual({
      from: { node: 'ds', port: 'dataset' },
      to: { node: 'find', port: 'dataset' },
    })
  })

  it('splits a dotted reference at the port, not at the first dot it sees', () => {
    const result = parsePlan('{"summary":"x","disconnect":["n3_k9.in"]}')
    if (!result.ok) expect.fail(result.error)
    expect(result.plan.disconnect[0]).toEqual({ node: 'n3_k9', port: 'in' })
  })

  it('leaves a well-formed plan completely alone', () => {
    /*
     * The unwrap must never reach a real plan. A plan that legitimately carries `add` *and* some
     * other list — a model echoing its reasoning as `steps`, say — has already said what it
     * wants in the format, and re-reading the envelope would double every action.
     */
    const result = parsePlan(
      JSON.stringify({
        summary: 'x',
        add: [{ ref: 'a', type: 'dataset.mock.opticlobe' }],
        steps: [{ add: { ref: 'b', type: 'out.table' } }],
      }),
    )
    if (!result.ok) expect.fail(result.error)
    expect(result.plan.add.map((n) => n.ref)).toEqual(['a'])
  })

  it('still refuses an envelope carrying nothing it recognises', () => {
    // Recovery is not a licence to accept anything: entries that name no verb stay a refusal.
    const result = parsePlan(JSON.stringify({ summary: 'x', steps: [{ frobnicate: {} }] }))
    if (result.ok) expect.fail('expected a refusal')
    expect(result.error).toContain('did not follow the requested format')
  })
})
