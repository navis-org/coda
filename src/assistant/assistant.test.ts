/**
 * The headless half of the assistant: what a plan may say, and what the applier refuses.
 *
 * Everything here runs against the *real* node registry rather than fixtures, which is the
 * point — the catalogue is generated from it, so a test built on a fake one would prove that
 * the fake is self-consistent and nothing about the thing the model is actually told.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import '../nodes'
import type { CodaGraph } from '../core/graph'
import { addEdge, addNode, emptyGraph, newId } from '../core/graph'
import { inferGraph } from '../core/inference'
import { configurableParams, defaultParams } from '../core/node'
import { getNodeDef, listableNodeDefs } from '../core/registry'
import type { ApplyOk, ApplyResult } from './apply'
import { applyPlan } from './apply'
import { buildSystemPrompt, catalogueText } from './catalogue'
import { pivotGraph, pivotObserved } from './fixture'
import { messagesReply, stubFetch } from '../data/ai/fixture'
import { describeGraph, repairPrompt, requestPlan } from './converse'
import type { AssistantPlan } from './planShape'
import { parsePlan, planJsonSchema } from './plan'
import { emptyPlan, isEmptyPlan, plannableParams } from './planShape'
import { defaultInputPorts, defaultOutputPorts } from '../core/ports'

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
    { ref: 'find', type: 'neuron.findNeurons', params: { typePattern: 'LC.*' } },
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
            { ref: 'find', type: 'neuron.findNeurons', params: { typePattern: 'LC.*' } },
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
    expect(find.params.typePattern).toBe('LC.*')
    // Untouched params keep the definition's default rather than arriving undefined. Find
    // Neurons' `status` default is empty now — a fresh node filters nothing — so `limit` and
    // `filters` are what say the merge happened.
    expect(find.params.status).toBe('')
    expect(find.params.limit).toBe(0)
    expect(find.params.filters).toEqual([])

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
        { ref: 'filter', type: 'core.filter' },
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
        { ref: 'a', type: 'core.filter' },
        { ref: 'b', type: 'core.filter' },
      ],
      connect: [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'input' } }],
    })

    expect(message).toContain('no input "input"')
    expect(message).toContain('in')
  })

  it('refuses a cycle', () => {
    const message = refusal({
      add: [
        { ref: 'a', type: 'core.filter' },
        { ref: 'b', type: 'core.filter' },
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
    expect(message).toContain('typePattern')
  })

  it('refuses a value of the wrong kind', () => {
    /*
     * Still refused after `coerceParamValue` learned to read a number as an enum option, and
     * deliberately so: nothing downstream checks a `string` param, so `4` here would become the
     * pattern `"4"` and apply cleanly. A model putting a limit in the wrong field is exactly
     * what that looks like, and this refusal is the only thing that ever says so.
     */
    const message = refusal({
      add: [{ ref: 'f', type: 'neuron.findNeurons', params: { typePattern: 4 as never } }],
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
    // `status` options come from the dataset, which inference cannot resolve here — so this
    // file must not pretend to know them. A wrong one is the node's own `validate` to report.
    const result = expectOk(
      applyPlan(
        emptyGraph(),
        plan({
          add: [{ ref: 'f', type: 'neuron.findNeurons', params: { status: 'Anything' } }],
        }),
      ),
    )
    expect(result.graph.nodes[0]?.params.status).toBe('Anything')
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
      refusal({ add: [{ ref: 's', type: 'core.stack', params: { topLabel: 'Left' } }] }),
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
              params: { topLabel: 'Left', sourceColumn: 'origin' },
            },
          ],
        }),
      ),
    )
    expect(nodeFor(result, 's').params.topLabel).toBe('Left')
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
    const message = refusal({ add: [{ ref: taken, type: 'core.filter' }] }, graph)

    expect(message).toContain('already the id of a node')
  })

  it('refuses a ref used twice', () => {
    const message = refusal({
      add: [
        { ref: 'f', type: 'core.filter' },
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
            { ref: 'f', type: 'core.filter' },
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
      params: { by: [], agg: 'sum', value: '' },
    }
    const graph: CodaGraph = addNode(emptyGraph(), orphan)
    const result = expectOk(applyPlan(graph, plan({ add: [{ ref: 'n', type: 'note.text' }] })))
    expect(result.warnings.map((w) => w.nodeId)).not.toContain(orphan.id)
  })
})

describe('the plan format', () => {
  it('reads a plan out of a reply, and fills in the arrays a model left out', () => {
    const parsed = parsedPlan('{"summary":"hi","add":[{"ref":"a","type":"core.filter"}]}')
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
        '"params":[{"param":"typePattern","value":"LC.*"},{"param":"limit","value":10}]}]}',
    )
    expect(fromWire.add[0]!.params).toEqual({ typePattern: 'LC.*', limit: 10 })

    const fromMap = parsedPlan(
      '{"summary":"x","add":[{"ref":"f","type":"neuron.findNeurons",' +
        '"params":{"typePattern":"LC.*","limit":10}}]}',
    )
    expect(fromMap.add[0]!.params).toEqual(fromWire.add[0]!.params)
  })

  it('refuses a param set twice, rather than silently keeping one of them', () => {
    const parsed = parsePlan(
      '{"summary":"x","add":[{"ref":"f","type":"core.filter",' +
        '"params":[{"param":"value","value":"a"},{"param":"value","value":"b"}]}]}',
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('set twice')
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
    const found = nodeFor(expectOk(withParam('neuron.findNeurons', 'typePattern', '42')), 'n')
    expect(found.params.typePattern).toBe('42')
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
    expect(text).toContain('typePattern=LC.*')
    // `status` is still at its default, so saying it would bury the one value that was set.
    expect(text).not.toContain('status=Traced')
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
    const text = describeGraph(graph, inferGraph(graph, { observedSchemas }))
    expect(text).toContain('partnerType')
    expect(text).toContain('weight')
  })

  it('hands a refusal back in the plan’s own terms', () => {
    const text = repairPrompt(['connect[2]: Table ▸ out → Filter ▸ in — Would create a cycle.'])
    expect(text).toContain('connect[2]')
    expect(text).toContain('nothing was applied')
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
        params: [{ param: 'typePattern', value: 'LC4' }],
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
    expect(body.system[0]!.text).toContain('## core.filter —')
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
            add: { ref: 'findLC4', type: 'neuron.findNeurons', params: { typePattern: 'LC4' } },
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
    expect(result.plan.add[1]!.params).toEqual({ typePattern: 'LC4' })
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
            params: { typePattern: 'LC4' },
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
