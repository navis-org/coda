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
import { EXAMPLES } from '../examples'

const DATA = guideData()
const byType = new Map(DATA.nodes.map((n) => [n.type, n]))

describe('coverage', () => {
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
    const op = byType.get('core.filter')!.params.find((p) => p.id === 'op')!
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

describe('the examples cross-reference', () => {
  it('names the examples a node actually appears in', () => {
    const filter = byType.get('core.filter')!
    expect(filter.examples.length).toBeGreaterThan(0)
    for (const name of filter.examples) expect(DATA.examples).toContain(name)
  })

  /*
   * Derived from `build()` rather than from a list, so this is really asserting that the
   * derivation runs — a node in an example and absent from its own cross-reference is the
   * failure, and it is silent.
   */
  it('agrees with the graphs themselves', () => {
    for (const example of EXAMPLES) {
      for (const node of example.build().nodes) {
        const entry = byType.get(node.type)
        if (!entry || entry.annotation) continue
        expect(entry.examples, `${node.type} in ${example.name}`).toContain(example.name)
      }
    }
  })

  /* Every example carries several notes, so "seen in all five" would be true and useless. */
  it('says nothing about a text note', () => {
    expect(byType.get('note.text')!.examples).toEqual([])
    expect(byType.get('note.text')!.annotation).toBe(true)
  })
})
