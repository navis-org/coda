/**
 * The analysis exports' decisions, asked of the plans directly.
 *
 * The goldens hold what the two documents say for the fixture's nodes, and the fixture takes one
 * branch per node where these plans have several: an Embedding with its route's columns unpicked
 * or two routes wired, a matrix already of distances, a Linkage with symmetry off, a similarity
 * whose metric hides Output.
 */

import { describe, expect, it } from 'vitest'

import type { ParamValues } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { transformFor } from '../../nodes/lib/linkageOps'
import { repeatParamId } from '../../nodes/lib/repeatParams'
import { LANDMARK_AXES, landmarkParamId } from '../../nodes/transform/landmarkTransform'
import {
  compareConnectivityPlan,
  cutPlan,
  embedPlan,
  filterNetworkPlan,
  landmarkPlan,
  linkagePlan,
  matchesPlan,
  partnerVectorsPlan,
  similarityPlan,
} from './analysis'
import { fakeNeutralContext } from './testContext'

const similarity = (params: ParamValues) =>
  similarityPlan(fakeNeutralContext({ type: 'core.similarity', params }))
const embed = (params: ParamValues, wires: Record<string, string> = {}) =>
  embedPlan(fakeNeutralContext({ type: 'core.embed', params, wires }))

describe('similarityPlan', () => {
  it('asks for distances when the metric has no similarity form', () => {
    const plan = similarity({
      layout: 'wide',
      idColumn: 'neuronId',
      wideFeatures: ['a'],
      metric: 'euclidean',
      output: 'similarity',
    })
    expect(plan.refusal === undefined && plan.call).toMatchObject({
      layout: 'wide',
      columns: ['a'],
      output: 'distance',
    })
  })

  // Every case names a metric: a real context fills the declared default (`withDefaults`), and
  // this fake one does not.
  it('refuses a layout missing its columns, naming the layout', () => {
    const wide = { layout: 'wide', idColumn: 'neuronId', metric: 'cosine' }
    expect(similarity(wide).refusal).toBe(
      'This Similarity Matrix needs an Id column and at least one feature column.',
    )
    expect(similarity({ observations: 'neuronId', metric: 'cosine' }).refusal).toBe(
      'This Similarity Matrix needs an Observations and a Features column.',
    )
  })

  it('passes a value column only when one is picked', () => {
    const base = { observations: 'neuronId', features: 'feature', metric: 'cosine' }
    const plain = similarity(base)
    expect(
      plain.refusal === undefined && plain.call.layout === 'long' && plain.call.value,
    ).toBeUndefined()
    const weighted = similarity({ ...base, value: 'weight' })
    expect(weighted.refusal === undefined && weighted.call).toMatchObject({
      layout: 'long',
      value: 'weight',
    })
  })
})

describe('embedPlan', () => {
  const settings = { neighbors: 8, minDist: 0.1, spread: 1, epochs: 0, seed: 7 }

  it('refuses no route and several routes before anything else', () => {
    expect(embed(settings).refusal).toMatch(
      /^This Embedding cannot be translated: Wire one of Matrix, Features, Neighbours in/,
    )
    const both = embed(settings, { matrix: 'm', features: 'f' })
    expect(both.refusal).toMatch(/^This Embedding cannot be translated: Matrix and Features/)
  })

  it('refuses a route with unpicked columns on the input, not on the plan', () => {
    const knn = embed({ ...settings, queryColumn: 'q' }, { neighbours: 'nn' })
    expect(knn.refusal).toBeUndefined()
    expect(knn.refusal === undefined && knn.input).toEqual({
      route: 'neighbours',
      refusal: 'This Embedding needs the two columns naming each neighbour pair.',
    })

    const features = embed({ ...settings, layout: 'long' }, { features: 'f' })
    expect(features.refusal === undefined && features.input).toEqual({
      route: 'features',
      refusal: 'This Embedding needs an Observations and a Features column.',
    })
  })

  it('reads the neighbour columns, leaving an unpicked score out', () => {
    const plan = embed(
      {
        ...settings,
        queryColumn: 'q',
        targetColumn: 't',
        scoreColumn: '',
        scoreIs: 'distance',
      },
      { neighbours: 'nn' },
    )
    expect(plan.refusal === undefined && plan.input).toEqual({
      route: 'neighbours',
      src: 'nn',
      query: 'q',
      target: 't',
      scoreIs: 'distance',
    })
  })

  it('inverts a matrix unless it is distances already, and notes only auto', () => {
    const input = (distance: string) => {
      const plan = embed({ ...settings, distance }, { matrix: 'm' })
      return plan.refusal === undefined ? plan.input : undefined
    }
    expect(input('auto')).toMatchObject({ invert: true, notes: ['autoDistance'] })
    expect(input('one_minus')).toMatchObject({ invert: true, notes: [] })
    expect(input('none')).toMatchObject({ invert: false, notes: [] })
  })

  it('asks the Features route for distances, so there is nothing to invert', () => {
    const plan = embed(
      {
        ...settings,
        distance: 'auto',
        observations: 'neuronId',
        featureColumn: 'feature',
        metric: 'cosine',
      },
      { features: 'f' },
    )
    expect(plan.refusal === undefined && plan.input).toMatchObject({
      route: 'features',
      src: 'f',
      call: { layout: 'long', features: 'feature', output: 'distance' },
      invert: false,
      notes: [],
    })
  })

  it('leaves epochs out at 0, and joins annotations only with a label column', () => {
    const plain = embed({ ...settings, labelBy: '' }, { matrix: 'm', annotations: 'a' })
    expect(plain.refusal === undefined && plain.settings).toEqual({
      neighbours: 8,
      minDist: 0.1,
      spread: 1,
      seed: 7,
    })
    expect(plain.refusal === undefined && plain.annotations).toBeUndefined()

    const joined = embed(
      { ...settings, epochs: 200, labelBy: 'type' },
      { matrix: 'm', annotations: 'a' },
    )
    expect(joined.refusal === undefined && joined.settings.epochs).toBe(200)
    // An unpicked Match on falls to the id column, as on the canvas.
    expect(joined.refusal === undefined && joined.annotations).toEqual({
      table: 'a',
      key: 'neuronId',
      value: 'type',
    })
  })
})

describe('linkagePlan', () => {
  const linkage = (params: ParamValues) =>
    linkagePlan(fakeNeutralContext({ type: 'cluster.linkage', params }))

  it('reads an unsymmetrised matrix as it stands, noting only an explicit none', () => {
    expect(linkage({ method: 'ward', symmetry: 'none', distance: 'none' })).toEqual({
      method: 'ward',
      invert: false,
      notes: ['symmetryOff'],
    })
    // An unrecognised stored value reads the matrix as it stands too, but was never noted.
    expect(linkage({ method: 'ward', symmetry: 'other', distance: 'one_minus' })).toEqual({
      method: 'ward',
      invert: true,
      notes: [],
    })
  })

  it('combines and inverts, saying what auto became in one sentence both documents write', () => {
    const plan = linkage({ method: 'average', symmetry: 'max', distance: 'auto' })
    expect(plan).toMatchObject({ method: 'average', combine: 'max', invert: true, notes: [] })
    // The option named is the card's own label, read off the definition.
    expect(plan.refusal === undefined && plan.autoNote).toMatch(
      /assumes similarities and uses 1 − score\. If the matrix holds distances, set Distance to "the values are already distances" on the card/,
    )
    expect(
      linkage({ method: 'average', symmetry: 'max', distance: 'one_minus' }),
    ).not.toHaveProperty('autoNote', expect.anything())
  })

  it('takes every method fastcore does, and refuses the rest as the canvas would fail', () => {
    for (const method of [
      'single',
      'complete',
      'average',
      'weighted',
      'ward',
      'centroid',
      'median',
    ]) {
      expect(linkage({ method, symmetry: 'mean', distance: 'none' }).refusal).toBeUndefined()
    }
    expect(linkage({ method: 'ward.D2', symmetry: 'mean', distance: 'none' }).refusal).toBe(
      '"ward.D2" is not a linkage method fastcore knows (single, complete, average, weighted, ' +
        'ward, centroid, median), so the canvas cannot cluster with it either.',
    )
  })

  /*
   * The inversion is the node's own `transformFor`, asked without a measure. Pinned against the
   * rule it replaced — everything but `none` inverts — over every declared value and one no
   * definition declares, since a stored graph can hold anything.
   */
  it('inverts exactly where the node would with no measure to read', () => {
    for (const distance of ['auto', 'one_minus', 'none', 'unrecognised']) {
      expect(transformFor(undefined, distance) === 'one_minus').toBe(distance !== 'none')
      const plan = linkagePlan(
        fakeNeutralContext({
          type: 'cluster.linkage',
          params: { method: 'ward', symmetry: 'mean', distance },
        }),
      )
      expect(plan.refusal === undefined && plan.invert).toBe(distance !== 'none')
    }
  })
})

describe('cutPlan', () => {
  it('refuses the mixed mode and reads the one control each other mode shows', () => {
    expect(cutPlan({ mode: 'mixed', count: 4 }).refusal).toMatch(/^This Cut Tree groups by/)
    // A height cut carries the note both documents write beside it; a count cut has nothing.
    expect(cutPlan({ mode: 'height', height: 0.6, count: 4 })).toEqual({
      by: 'height',
      at: 0.6,
      note:
        'Cutting at a height gives however many groups fall out below it, which may be one ' +
        'if the height is above the top of the tree.',
    })
    expect(cutPlan({ mode: 'count', height: 0.6, count: 4 })).toEqual({ by: 'count', at: 4 })
  })
})

describe('the smaller analysis plans', () => {
  it('refuse a Filter Network with no condition and no complete seed table', () => {
    const nodes: TableSchema = {
      columns: [
        { name: 'type', dtype: 'str' },
        { name: 'size', dtype: 'i64' },
      ],
    }
    const plan = (params: ParamValues, wires: Record<string, string> = {}) =>
      filterNetworkPlan(
        fakeNeutralContext({ type: 'net.filter', params, wires, attributes: { in: nodes } }),
      )
    const refusal = 'Nothing selects any nodes on this Filter Network.'
    expect(plan({}).refusal).toBe(refusal)
    // A wired table with no id column picked seeds nothing.
    expect(plan({}, { seed: 'seeds' }).refusal).toBe(refusal)
    // The comparison is Filter Table's, with the dtype read off the network's node attributes.
    expect(plan({ column: 'type', op: 'eq', value: 'LC4' })).toEqual({
      condition: { column: 'type', op: 'eq', value: 'LC4', numeric: false, keepsNull: false },
    })
    expect(plan({ column: 'size', op: 'gt', value: '5' })).toMatchObject({
      condition: { numeric: true, keepsNull: false },
    })
    // The same null rule as Filter Table, since the node runs the same `filterTable`.
    expect(plan({ column: 'size', op: 'eq', value: '0' })).toMatchObject({
      condition: { keepsNull: true },
    })
    // And no refusal of its own: a condition the canvas throws on still writes the seed half.
    expect(plan({ column: 'size', op: 'contains', value: 'x' }).refusal).toBeUndefined()
    expect(plan({ seedColumn: 'neuronId' }, { seed: 'seeds' })).toEqual({
      seed: { table: 'seeds', column: 'neuronId' },
    })
  })

  it('refuse a Landmark Transform missing any of its six columns', () => {
    const params: ParamValues = {}
    for (const side of ['source', 'target'] as const) {
      for (const axis of LANDMARK_AXES) params[landmarkParamId(side, axis)] = `${side}_${axis}`
    }
    const plan = (p: ParamValues) =>
      landmarkPlan(fakeNeutralContext({ type: 'core.landmarkTransform', params: p }))
    expect(plan(params)).toEqual({
      from: LANDMARK_AXES.map((axis) => `source_${axis}`),
      to: LANDMARK_AXES.map((axis) => `target_${axis}`),
    })
    expect(
      plan({ ...params, [landmarkParamId('target', LANDMARK_AXES[2]!)]: '' }).refusal,
    ).toBe('Landmark Transform has unset coordinate columns — pick all six.')
  })

  it('note a Matches direction read off the matrix, and no other', () => {
    expect(matchesPlan({ direction: 'auto' }).notes).toEqual(['autoDirection'])
    expect(matchesPlan({ direction: 'lower' }).notes).toEqual([])
  })

  it('refuse Partner Vectors with no weight, and Compare Connectivity at the first bare dataset', () => {
    const vectors = (params: ParamValues) =>
      partnerVectorsPlan(fakeNeutralContext({ type: 'neuron.partnerVectors', params }))
    expect(vectors({}).refusal).toBe('This Partner Vectors node has no weight column picked.')
    expect(vectors({ weight: 'weight' })).toEqual({ weight: 'weight' })

    const compare = compareConnectivityPlan(
      fakeNeutralContext({
        type: 'compare.connectivity',
        params: {
          datasetCount: 3,
          [repeatParamId('pre', 1)]: 'pre',
          [repeatParamId('post', 1)]: 'post',
          [repeatParamId('pre', 2)]: 'pre',
        },
      }),
    )
    expect(compare.refusal).toBe(
      'Dataset 2 of this Compare Connectivity has no pre or post column.',
    )
  })
})
