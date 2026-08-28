/**
 * The Match Cell Types node — the half `typeMapping.test.ts` cannot see.
 *
 * That file owns the algorithm and tests it against cocoa's worked examples. What is left for
 * the node is everything the algorithm was deliberately kept ignorant of, and all of it is a
 * place where two things have to agree:
 *
 * - the **ports** it draws and the ports its body reads, which for a variadic node are generated
 *   rather than written down (`core/ports.ts`);
 * - the **schemas** `inferOutputs` promises against the tables `evaluate` builds — invariant 3,
 *   and the reason the report is long rather than a count column per dataset;
 * - the **rows** it works from, which decision 4 says are the dataset's whole annotation table
 *   and never the neurons somebody wired in. There is no input to wire neurons into, so the way
 *   that goes wrong is a source with no neuron index, which must be refused by name.
 *
 * The end-to-end case wires the *same* mock dataset into both sockets. That is a degenerate
 * mapping — every type matches itself — and it is exactly what makes it a good check of the
 * chain rather than of the mapper: two fetches, two labels ports, one report, and a result whose
 * right answer is known without reasoning about label graphs at all.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams, makeInferContext } from '../../core/node'
import type { EvalContext, ParamValues } from '../../core/node'
import {
  defaultInputPorts,
  defaultOutputPorts,
  inputPorts,
  outputPorts,
} from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import type { TableValue, Value } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { T, column, tableSchema } from '../../core/types'
import type { CodaType } from '../../core/types'
import type { DataSource } from '../../data/source'
import { CANONICAL_SCHEMAS, registerSource, requireSource } from '../../data/source'
import { MockSource } from '../../data/mock/MockSource'
import { mockDatasetIds } from '../../data/mock/generate'
import { resetCache } from '../../data/cache'
import '../index'

const def = requireNodeDef('compare.matchTypes')
const DATASET = mockDatasetIds()[0]!

/**
 * A source with no neuron index, which is the case decision 4 turns into a refusal.
 *
 * Registered rather than borrowed: every backend Coda ships answers `neuronIndex: true`, and the
 * real example is a Neuroglancer volume published without segment properties — a per-dataset
 * `false` on `PrecomputedSource`. A stub says the same thing in four lines and does not tie this
 * test to how that source decides.
 */
const NO_INDEX = {
  id: 'test.noindex',
  label: 'Bucket',
  capabilities: { neuronIndex: false },
  // Not decoration: `schemasFromType` is total by contract and the type-column pickers call it
  // on every graph mutation, so a source without schemas takes the whole editor down rather
  // than showing an empty picker.
  schemas: CANONICAL_SCHEMAS,
  listDatasets: async () => [],
  peekDataset: () => undefined,
} as unknown as DataSource

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
  registerSource(NO_INDEX)
})

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** One mock dataset into both sockets, which is the whole graph this node needs. */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('match-types-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
  g = addNode(
    g,
    node('match', 'compare.matchTypes', { types1: ['type'], types2: ['type'], ...params }),
  )
  for (const handle of ['dataset1', 'dataset2']) {
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'match',
      targetHandle: handle,
    })
  }
  return g
}

// ---------------------------------------------------------------------------

describe('the sockets', () => {
  it('opens with one Dataset and one Labels port per dataset, numbered from 1', () => {
    expect(defaultInputPorts(def).map((p) => p.id)).toEqual(['dataset1', 'dataset2', 'extra'])
    expect(defaultOutputPorts(def).map((p) => p.id)).toEqual(['labels1', 'labels2', 'report'])
    // The index is substituted into the label rather than appended, so the card reads properly.
    expect(defaultInputPorts(def).map((p) => p.label)).toContain('Dataset 2')
  })

  it('grows both sides together when the count goes up', () => {
    const params = { ...defaultParams(def), datasetCount: 4 }
    expect(inputPorts(def, params).map((p) => p.id)).toEqual([
      'dataset1',
      'dataset2',
      'dataset3',
      'dataset4',
      'extra',
    ])
    expect(outputPorts(def, params).map((p) => p.id)).toEqual([
      'labels1',
      'labels2',
      'labels3',
      'labels4',
      'report',
    ])
  })

  /*
   * The Synonyms port is how a hand-curated correspondence gets in, and a node that refused to
   * run without one would be demanding a table most graphs have no reason to build.
   */
  it('does not require the Synonyms port', () => {
    expect(defaultInputPorts(def).find((p) => p.id === 'extra')?.required).toBe(false)
  })

  /*
   * Invariant 6. Each socket is a whole-brain annotation download from a shared server, so a
   * `cheap` node here would fire one per keystroke in the ignore-labels box.
   */
  it('is expensive and offers Clear Cache', () => {
    expect(def.cost).toBe('expensive')
    expect(def.dataCache).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('what it says it will emit', () => {
  /*
   * Through `inferGraph`, which is the path the editor actually takes, rather than through an
   * `inferOutputs` this node deliberately does not have: every schema it publishes is a constant
   * declared on the port, and `outputTypesFor` seeds each output from its declared type. What
   * this asserts is therefore that the *declarations* are right and that they survive the walk.
   */
  const published = (params: Record<string, unknown>) =>
    inferGraph(pipeline(params)).nodes['match']!.outputs

  it('types every port before anything has run, at whatever arity', () => {
    const three = published({ datasetCount: 3 })
    expect(Object.keys(three)).toEqual(['labels1', 'labels2', 'labels3', 'report'])
    for (const id of ['labels1', 'labels2', 'labels3']) {
      expect(three[id]).toEqual(
        T.table(tableSchema(column('neuronId', 'str'), column('label', 'str'))),
      )
    }
  })

  /*
   * The report is **long** — one row per label per dataset — and that is what keeps its schema a
   * constant while the node's arity is not. A count column per dataset would be the one output
   * whose columns the declaration and `evaluate` derived separately, which is invariant 3's
   * failure exactly: it would break only after a run.
   */
  it('promises a report whose columns do not depend on the arity', () => {
    const two = published({ datasetCount: 2 })
    const four = published({ datasetCount: 4 })
    expect(two.report).toEqual(four.report)
    expect(two.report).toEqual(
      T.table(
        tableSchema(
          column('label', 'str'),
          column('dataset', 'str'),
          column('nNeurons', 'i64'),
          column('suspicious', 'bool'),
        ),
      ),
    )
  })
})

// ---------------------------------------------------------------------------

describe('what it refuses on the card', () => {
  const issues = (params: ParamValues, inputs: Record<string, CodaType | undefined>) =>
    def.validate?.(makeInferContext(def, { ...defaultParams(def), ...params }, inputs)) ?? []

  const mock = T.dataset('mock', DATASET)

  /*
   * Decision 4: the mapper reads every neuron's types, so a source that cannot list a whole
   * dataset cannot be matched — and the answer is to say so by name at edit time rather than to
   * fall back to whatever rows are around, which would be a different answer wearing this node.
   */
  it('names a source that cannot list a whole dataset', () => {
    const bucket = T.dataset('test.noindex', 'some-volume')
    expect(issues({ types1: ['type'] }, { dataset1: bucket })[0]).toMatch(
      /Dataset 1: Bucket cannot list a whole dataset/,
    )
  })

  it('asks for type columns, naming which dataset has none', () => {
    expect(
      issues({ types1: ['type'], types2: [] }, { dataset1: mock, dataset2: mock }),
    ).toEqual(['Dataset 2: pick at least one column holding cell types.'])
  })

  // Also the "empty Synonyms socket" case: nothing wired means no synonyms, which is a state
  // rather than a problem.
  it('says nothing once both are picked', () => {
    expect(
      issues({ types1: ['type'], types2: ['type'] }, { dataset1: mock, dataset2: mock }),
    ).toEqual([])
  })

  /*
   * Both pickers are optional, so empty means "no synonyms" — which is the right reading of an
   * empty *socket* and the wrong reading of a wired table nobody has pointed the node at. The
   * alternative was required pickers, and those would both fall back to the first column of the
   * wired table: every row would then say a label is a synonym of itself, silently.
   */
  it('says so when a Synonyms table is wired but no columns are chosen', () => {
    const extra = T.table(tableSchema(column('from', 'str'), column('to', 'str')))
    const found = issues(
      { types1: ['type'], types2: ['type'] },
      { dataset1: mock, dataset2: mock, extra },
    )
    expect(found.join(' ')).toMatch(/Synonyms: pick the two columns/)

    const chosen = issues(
      { types1: ['type'], types2: ['type'], synonymLabel: 'from', synonymOther: 'to' },
      { dataset1: mock, dataset2: mock, extra },
    )
    expect(chosen).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('through a real Scheduler, on the mock connectome', () => {
  async function run(params: Record<string, unknown> = {}) {
    resetCache()
    const sched = new Scheduler({ resolveSource: (id) => requireSource(id) })
    const summary = await sched.run(pipeline(params), { mode: 'full' })
    expect(summary.failed).toEqual([])
    return (id: string) => sched.output('match', id) as TableValue
  }

  /** The default graph, mapped once — three of these tests ask different things of one result. */
  let defaults: Awaited<ReturnType<typeof run>>
  beforeAll(async () => {
    defaults = await run()
  })

  it('emits one labels table per dataset and one long report', () => {
    const out = defaults

    const labels1 = out('labels1')
    const labels2 = out('labels2')
    expect(labels1.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'label'])
    expect(labels1.length).toBeGreaterThan(0)
    // The same dataset twice, so both sides carry the same neurons under the same labels.
    expect(labels2.data['neuronId']).toEqual(labels1.data['neuronId'])
    expect(labels2.data['label']).toEqual(labels1.data['label'])

    // Ids as text, exactly — the mock's column is `i64`, and this is the seam that must not
    // hand a rounded number on (invariant 8).
    expect(typeof labels1.data['neuronId']![0]).toBe('string')

    const report = out('report')
    const labelCount = new Set(labels1.data['label']!.map(String)).size
    // Long form: one row per (label, dataset), so exactly two rows per label here.
    expect(report.length).toBe(labelCount * 2)
    expect(new Set(report.data['dataset']!.map(String))).toEqual(new Set([DATASET]))
  })

  /*
   * A type matched against itself has identical counts on both sides, so nothing can be
   * suspicious. Worth pinning: a report that flagged everything would be as useless as one that
   * flagged nothing, and this is the one input whose right answer is knowable in advance.
   */
  it('flags nothing when a dataset is matched against itself', () => {
    expect(defaults('report').data['suspicious']!.every((v) => v === false)).toBe(true)
  })

  it('maps a type to itself, so a known type comes back under its own name', () => {
    // AOTU008 is in the mock, and is cocoa's own worked example.
    expect(new Set(defaults('labels1').data['label']!.map(String))).toContain('AOTU008')
  })

  /*
   * The pickers are the node's, not the mapper's: matching on `instance` instead of `type` is a
   * different question with a different answer, and the point of resolving through `ctx.columns`
   * is that the same resolution feeds the run and the provenance key (invariant 5).
   */
  it('matches on the columns that were picked', async () => {
    const byInstance = await run({ types1: ['instance'], types2: ['instance'] })
    expect(byInstance('report').length).not.toBe(defaults('report').length)
  })
})

// ---------------------------------------------------------------------------

describe('what it does at run time that the card cannot', () => {
  /** A context holding only what this node reads, so a failure points at the node. */
  function ctx(options: {
    inputs?: Record<string, Value | undefined>
    params?: Record<string, unknown>
    source?: Partial<DataSource>
    warn?: (message: string) => void
  }): EvalContext {
    const params: ParamValues = {
      ...defaultParams(def),
      types1: ['type'],
      types2: ['type'],
      ...options.params,
    }
    return {
      params,
      refresh: false,
      input: (portId) => options.inputs?.[portId],
      inputKey: () => undefined,
      column: (id) => String(params[id] ?? '') || undefined,
      columns: (id) => (params[id] as string[]) ?? [],
      inputPorts: () => inputPorts(def, params as ParamValues),
      outputPorts: () => outputPorts(def, params as ParamValues),
      resolveSource: () => (options.source ?? {}) as DataSource,
      signal: new AbortController().signal,
      progress: () => {},
      warn: options.warn ?? (() => {}),
      publish: () => {},
      reportFetched: () => {},
    } as EvalContext
  }

  const dataset = (id: string): Value => ({
    kind: 'dataset',
    sourceId: 'somewhere',
    datasetId: id,
    label: id,
  })

  const INDEX_SCHEMA = tableSchema(column('neuronId', 'i64'), column('type', 'str'))

  /** Half of `brain-a` has a type `brain-b` has never heard of. */
  const indexFor = async (req: { datasetId: string }) =>
    tableFromRows(
      INDEX_SCHEMA,
      req.datasetId === 'brain-a'
        ? [
            { neuronId: 1, type: 'LC4' },
            { neuronId: 2, type: 'OnlyInA' },
          ]
        : [{ neuronId: 9, type: 'LC4' }],
    )

  /*
   * Decision 4 again, at the other end. The refusal names the source *and* says why the node
   * needs the whole table, because "no neuron index" reads as a transient fault otherwise.
   */
  it('refuses a source with no neuron index, naming it', async () => {
    const context = ctx({
      inputs: { dataset1: dataset('a'), dataset2: dataset('b') },
      source: { label: 'CATMAID' },
    })
    await expect(def.evaluate(context)).rejects.toThrow(
      /CATMAID does not publish a neuron index/,
    )
  })

  it('refuses before it fetches anything', async () => {
    let fetches = 0
    const context = ctx({
      inputs: { dataset1: dataset('a'), dataset2: dataset('b') },
      // The second socket is the one that cannot answer, and the first must not have been
      // downloaded by the time that is discovered.
      source: {
        label: 'Somewhere',
        neuronIndex: undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({ countFetches: () => fetches++ } as any),
      },
    })
    await expect(def.evaluate(context)).rejects.toThrow()
    expect(fetches).toBe(0)
  })

  /*
   * An attribution rather than a threshold, in `docs/limits.md`'s sense: a mapping that covered
   * a tenth of a brain produces a perfectly ordinary pair of tables, and everything built on it
   * then silently describes that tenth.
   */
  it('says how much of a dataset matched nothing', async () => {
    const warnings: string[] = []
    const context = ctx({
      inputs: { dataset1: dataset('brain-a'), dataset2: dataset('brain-b') },
      source: { label: 'Mock', neuronIndex: indexFor },
      warn: (m) => warnings.push(m),
    })
    await def.evaluate(context)
    // One of the two neurons has a type the other dataset does not, which is half of it.
    expect(warnings.join(' ')).toMatch(/1 of 2 neurons matched nothing/)
  })

  it('is silent when nearly everything matched', async () => {
    const warnings: string[] = []
    const allMatched = tableFromRows(INDEX_SCHEMA, [
      { neuronId: 1, type: 'LC4' },
      { neuronId: 2, type: 'LC6' },
    ])
    await def.evaluate(
      ctx({
        inputs: { dataset1: dataset('brain-a'), dataset2: dataset('brain-b') },
        source: { label: 'Mock', neuronIndex: async () => allMatched },
        warn: (m) => warnings.push(m),
      }),
    )
    expect(warnings).toEqual([])
  })
})
