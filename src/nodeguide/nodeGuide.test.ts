/**
 * The node guide's data, and the coverage claims the page rests on.
 *
 * The page itself has no test, for the reason the tutorial page has none: jsdom performs no
 * layout, so the grid, the sticky detail pane and the preview card's socket positions are
 * exactly the class of thing it cannot see. What *is* testable is everything the page renders
 * *from*, which is this module — and the failure mode worth guarding is not a crash but a
 * quietly incomplete guide: a node with no paragraph, a socket with no shape, a setting the
 * page decided not to mention.
 */

import { describe, expect, it } from 'vitest'
import { guideData } from './data'
import '../nodes'
import { listableNodeDefs } from '../core/registry'
import { familyForNodeType } from '../nodes/lib/datasetFamilies'
import { DEMO_DATASET, buildWorkflow } from '../wizard/build'
import { analysisOption, everyCombination } from '../wizard/options'

const DATA = guideData()
const byType = new Map(DATA.nodes.map((n) => [n.type, n]))

describe('coverage', () => {
  it('carries the family silhouette for every dataset node that has one', () => {
    /*
     * The page cannot look this up — reading the family table in the browser would put every
     * blurb and version list behind a static document — so it travels in this JSON. Without it
     * `glyphShapes` falls through to the generic disc stack and every published connectome on
     * `nodes.html` draws the same picture, which is a regression nothing else would catch.
     */
    const datasets = DATA.nodes.filter((n) => familyForNodeType(n.type))
    expect(datasets.length).toBeGreaterThan(0)
    for (const node of datasets) {
      expect(node.datasetGlyph, node.type).toBe(familyForNodeType(node.type)?.glyph)
    }
    // And nothing else carries the key, which is what keeps it out of the inlined JSON.
    expect(DATA.nodes.filter((n) => n.datasetGlyph && !familyForNodeType(n.type))).toEqual([])
  })

  it('has an entry for every listable node, and only those', () => {
    expect(DATA.nodes.map((n) => n.type).sort()).toEqual(
      listableNodeDefs()
        .map((d) => d.type)
        .sort(),
    )
  })

  /*
   * The whole page is one paragraph per node wide. A node shipped without one degrades to its
   * palette one-liner, which is a sentence written for a different surface and reads as a
   * placeholder at this size — so it is a failure rather than a fallback.
   */
  it('gives every node a guide paragraph, distinct from its description', () => {
    for (const n of DATA.nodes) {
      expect(n.guide.length, n.type).toBeGreaterThan(120)
      expect(n.guide, n.type).not.toBe(n.description)
    }
  })

  it('gives every socket a family and a shape', () => {
    for (const n of DATA.nodes) {
      for (const p of [...n.inputs, ...n.outputs]) {
        expect(p.family, `${n.type}.${p.id}`).toBeTruthy()
        expect(p.shape, `${n.type}.${p.id}`).toBeTruthy()
      }
    }
  })
})

describe('ports', () => {
  it('reads socket style off the real type, so the guide and the canvas agree', () => {
    const conn = byType.get('neuron.connectivity')!
    expect(conn.inputs.map((p) => [p.label, p.family, p.shape])).toEqual([
      ['Dataset', 'dataset', 'square'],
      ['Neurons', 'table', 'circle'],
    ])
    expect(conn.outputs[0]).toMatchObject({ kind: 'table', family: 'table', shape: 'ring' })
  })

  /* An optional socket is a real difference in how a node is used — Input IDs answers without
     a Dataset, Neuroglancer opens on a published scene with no neurons. */
  it('marks an optional input as optional', () => {
    const inputIds = byType.get('neuron.inputIds')!
    expect(inputIds.inputs.find((p) => p.id === 'dataset')?.required).toBe(false)
    expect(byType.get('neuron.connectivity')!.inputs.every((p) => p.required)).toBe(true)
  })
})

describe('settings', () => {
  /*
   * `internal` is machinery a widget writes — a refresh nonce, a pager. Listing one would be
   * documenting a control nobody sets, and it is the same exclusion the card's "… N more"
   * counter makes. `advanced` is the opposite case and must survive: those are real settings
   * that happen to live in the inspector, and a guide is where somebody learns they exist.
   */
  it('drops internal params and keeps advanced ones', () => {
    const dataset = byType.get('dataset.hemibrain')!
    expect(dataset.params.map((p) => p.id)).not.toContain('refresh')

    const rois = byType.get('out.rois')!
    expect(rois.params.length).toBeGreaterThan(0)
    expect(rois.params.every((p) => p.advanced)).toBe(true)
  })

  /* An enum prints its option's *label*: the app's picker says "downstream (outputs)" where
     the stored value is `outputs`, and a guide naming the other one describes a control that
     is not on screen. */
  it('renders an enum default as the label the picker shows', () => {
    const direction = byType
      .get('neuron.connectivity')!
      .params.find((p) => p.id === 'direction')!
    expect(direction.value).toBe('downstream (outputs)')
    expect(direction.picker).toBe(true)
  })

  /* Filter's operator list is a function of the incoming column's dtype, so there is no answer
     without a graph. Saying so beats printing whatever the first option happens to be. */
  it('admits when an enum has no static option list', () => {
    const op = byType.get('core.filterTable')!.params.find((p) => p.id === 'op')!
    expect(op.value).toBe('resolved live')
  })

  it('carries help text where the definition has it', () => {
    const hops = byType.get('neuron.connectivity')!.params.find((p) => p.id === 'hops')!
    expect(hops.help).toContain('1 is direct partners')
  })

  it('reports presentational params, since editing one stales nothing', () => {
    const profile = byType.get('out.profile')!
    expect(profile.params.find((p) => p.id === 'minWeight')?.presentational).toBe(true)
  })
})

describe('the workflow cross-reference', () => {
  it('names the workflows a node actually appears in', () => {
    // Group By is in three of the five arms, so it is the one to ask: a node that appears in
    // exactly one would pass this while the derivation returned a constant.
    const group = byType.get('core.groupBy')!
    expect(group.workflows.length).toBeGreaterThan(1)
    for (const name of group.workflows) expect(DATA.workflows).toContain(name)
  })

  /*
   * Derived from the built graphs rather than from a list, so this is really asserting that the
   * derivation runs — a node in a workflow and absent from its own cross-reference is the
   * failure, and it is silent.
   */
  it('agrees with the graphs themselves', () => {
    for (const answers of everyCombination(DEMO_DATASET)) {
      const name = analysisOption(answers.analysis)!.label
      for (const node of buildWorkflow({ ...answers, notes: false }).nodes) {
        const entry = byType.get(node.type)
        if (!entry || entry.annotation) continue
        expect(entry.workflows, `${node.type} in ${name}`).toContain(name)
      }
    }
  })

  /*
   * The viewers only one answer reaches are the whole reason this is derived from *every*
   * combination rather than from a handful of canonical graphs — four hand-written examples
   * credited whichever viewers they happened to contain.
   */
  it('credits a viewer that only one answer reaches', () => {
    expect(byType.get('out.pie')!.workflows.length).toBeGreaterThan(0)
    expect(byType.get('net.metrics')!.workflows.length).toBeGreaterThan(0)
  })

  /* Every workflow carries several notes, so "seen in all of them" would be true and useless. */
  it('says nothing about a text note', () => {
    expect(byType.get('note.text')!.workflows).toEqual([])
    expect(byType.get('note.text')!.annotation).toBe(true)
  })
})
