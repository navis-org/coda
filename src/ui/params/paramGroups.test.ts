/**
 * The tabs-and-rows reshaping behind the styling panel.
 *
 * Tested against the *real* `out.network` definition rather than a fixture, because the
 * thing worth guarding is the claim that reorganising its params changed nothing: every
 * control the flat rail used to show still reaches the panel, exactly once.
 */

import { describe, expect, it } from 'vitest'

import type { NodeDefinition, ParamDef } from '../../core/node'
import { defaultParams } from '../../core/node'
import { listableNodeDefs, requireNodeDef } from '../../core/registry'
import '../../nodes'
import type { CompositeRow, ParamRow } from './paramGroups'
import { UNGROUPED_TAB, bucketParams, facetLabel, groupParams, paramsForPanel } from './paramGroups'

const def = requireNodeDef('out.network')
const base = defaultParams(def)
const presentational = (param: ParamDef) => param.presentational === true

const composites = (rows: ParamRow[]) =>
  rows.filter((r): r is CompositeRow => r.kind === 'composite')
const rowLabels = (rows: ParamRow[]) =>
  rows.map((row) => (row.kind === 'composite' ? row.label : row.param.label))

/** Every param id the rendered tabs put on screen, in order. */
function shownIds(tabs: ReturnType<typeof groupParams>): string[] {
  const ids: string[] = []
  for (const tab of tabs) {
    for (const row of tab.rows) {
      if (row.kind === 'single') ids.push(row.param.id)
      else {
        if (row.primary) ids.push(row.primary.id)
        if (row.value) ids.push(row.value.id)
        for (const extra of row.extras) ids.push(extra.id)
      }
    }
  }
  return ids
}

describe('groupParams over out.network', () => {
  it('produces the declared tabs, in the declared order', () => {
    const tabs = groupParams(def, base, presentational)
    expect(tabs.map((t) => t.id)).toEqual(['node', 'link', 'layout'])
    expect(tabs.map((t) => t.label)).toEqual(['Node', 'Link', 'Layout'])
  })

  it('shows every param the flat rail did, and no more', () => {
    // The rail's rule, verbatim: presentational and not hidden by visibleIf.
    const rail = (def.params ?? [])
      .filter((p) => p.presentational && (!p.visibleIf || p.visibleIf(base)))
      .map((p) => p.id)
    expect([...shownIds(groupParams(def, base, presentational))].sort()).toEqual(
      [...rail].sort(),
    )
  })

  it('shows each param exactly once', () => {
    const ids = shownIds(groupParams(def, base, presentational))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('leaves nothing ungrouped, so the Other tab never appears', () => {
    expect(groupParams(def, base, presentational).map((t) => t.id)).not.toContain(UNGROUPED_TAB)
  })

  it('keeps the selection out, exactly as the rail did — it is not presentational', () => {
    expect(shownIds(groupParams(def, base, presentational))).not.toContain('selection')
  })
})

describe('composite rows', () => {
  const tabs = groupParams(def, base, presentational)
  const node = tabs.find((t) => t.id === 'node')!
  const link = tabs.find((t) => t.id === 'link')!

  it('collapses colour’s three params into one labelled row', () => {
    const colour = composites(node.rows).find((r) => r.key === 'nodeColor')!
    expect(colour.label).toBe('Colour')
    expect(colour.primary?.id).toBe('nodeColorMode')
    // Default mode is categorical, so the column picker is the visible value, not the swatch.
    expect(colour.value?.id).toBe('nodeColorBy')
    expect(colour.extras).toHaveLength(0)
  })

  it('swaps the column picker for the swatch when the mapping says constant', () => {
    const flat = groupParams(def, { ...base, nodeColorMode: 'constant' }, presentational)
    const colour = composites(flat.find((t) => t.id === 'node')!.rows).find(
      (r) => r.key === 'nodeColor',
    )!
    expect(colour.value?.id).toBe('nodeColor')
  })

  it('hangs a size range off its column picker rather than making three rows', () => {
    const size = composites(node.rows).find((r) => r.key === 'nodeSize')!
    expect(size.label).toBe('Size')
    expect(size.primary?.id).toBe('nodeSizeBy')
    expect(size.extras.map((p) => p.id)).toEqual(['nodeSizeMin', 'nodeSizeMax'])
    expect(size.extras.map(facetLabel)).toEqual(['min', 'max'])
  })

  it('reads a row label off the primary, not off whichever member came first', () => {
    expect(rowLabels(node.rows)).toEqual(['Colour', 'Size', 'Border', 'Label'])
    expect(rowLabels(link.rows)).toEqual(['Colour', 'Width', 'Arrows', 'Label'])
  })

  it('hangs link opacity off the link colour row rather than giving it one of its own', () => {
    const colour = composites(link.rows).find((r) => r.key === 'edgeColor')!
    expect(colour.extras.map((p) => p.id)).toEqual(['edgeOpacity'])
    expect(colour.extras.map(facetLabel)).toEqual(['opacity'])
  })

  it('leaves a param with no composite as a row of its own', () => {
    const arrows = link.rows.find((r) => r.kind === 'single' && r.param.id === 'arrows')
    expect(arrows).toBeTruthy()
  })

  it('drops a composite row entirely when every member is hidden', () => {
    // `iterations` is the only layout extra visible under the default force layout; switching
    // to circular hides all three, leaving the algorithm picker alone.
    const circular = groupParams(def, { ...base, layout: 'circular' }, presentational)
    const layout = composites(circular.find((t) => t.id === 'layout')!.rows)[0]!
    expect(layout.extras).toHaveLength(0)
    expect(layout.primary?.id).toBe('layout')
  })

  it('follows visibleIf into the extras, so only the current algorithm’s knobs show', () => {
    const fromColumns = groupParams(def, { ...base, layout: 'columns' }, presentational)
    const layout = composites(fromColumns.find((t) => t.id === 'layout')!.rows)[0]!
    expect(layout.extras.map((p) => p.id)).toEqual(['xColumn', 'yColumn'])
  })
})

describe('link colour offers no sequential mode', () => {
  /*
   * Measured, not preferred: the blue ramp's receding end is 1.46:1 on the dark surface, and
   * clamping it to clear 3:1 drops adjacent steps to ΔL 0.047 against a 0.06 floor. Fine for
   * an area mark, unusable for a hairline. If someone adds it back, this is the tripwire.
   */
  const mode = (def.params ?? []).find((p) => p.id === 'edgeColorMode')!

  it('offers a constant and a category, and nothing driven by magnitude', () => {
    const options = mode.kind === 'enum' && Array.isArray(mode.options) ? mode.options : []
    expect(options.map((o) => o.value)).toEqual(['constant', 'categorical'])
  })

  it('still offers it for nodes, which are area marks', () => {
    const nodeMode = (def.params ?? []).find((p) => p.id === 'nodeColorMode')!
    const options =
      nodeMode.kind === 'enum' && Array.isArray(nodeMode.options) ? nodeMode.options : []
    expect(options.map((o) => o.value)).toContain('sequential')
  })

  it('defaults links to the ink they have always been drawn in', () => {
    expect(mode.default).toBe('constant')
    const constant = (def.params ?? []).find((p) => p.id === 'edgeColor')!
    expect(constant.default).toBe('muted')
  })
})

describe('groupParams safety net', () => {
  const stub = (
    params: ParamDef[],
    groups?: NodeDefinition['paramGroups'],
  ): NodeDefinition => ({
    type: 'test.stub',
    label: 'Stub',
    category: 'visualisation',
    cost: 'cheap',
    ...(groups ? { paramGroups: groups } : {}),
    params,
    evaluate: () => ({}),
  })

  const plain = (id: string, group?: string): ParamDef => ({
    id,
    kind: 'boolean',
    label: id,
    default: false,
    ...(group ? { group } : {}),
  })

  it('collects a param the definition forgot to group, rather than losing it', () => {
    const tabs = groupParams(
      stub([plain('a', 'x'), plain('stray')], [{ id: 'x', label: 'X' }]),
      {},
    )
    expect(tabs.map((t) => t.id)).toEqual(['x', UNGROUPED_TAB])
    expect(shownIds(tabs)).toContain('stray')
  })

  it('does the same for a param naming a group that does not exist', () => {
    const tabs = groupParams(stub([plain('a', 'ghost')], [{ id: 'x', label: 'X' }]), {})
    expect(tabs.map((t) => t.id)).toEqual([UNGROUPED_TAB])
  })

  it('keeps a tab out of the panel when everything in it is filtered away', () => {
    const tabs = groupParams(
      stub([plain('a', 'x')], [{ id: 'x', label: 'X' }]),
      {},
      () => false,
    )
    expect(tabs).toHaveLength(0)
  })

  it('does not merge same-named composites living in different tabs', () => {
    // Both the node and the link half call their row "Label"; sharing a key must not move a
    // control into the wrong tab.
    const shared = (id: string, group: string): ParamDef => ({
      ...plain(id, group),
      composite: { key: 'label', role: 'primary', label: 'Label' },
    })
    const tabs = groupParams(
      stub(
        [shared('a', 'x'), shared('b', 'y')],
        [
          { id: 'x', label: 'X' },
          { id: 'y', label: 'Y' },
        ],
      ),
      {},
    )
    expect(tabs.map((t) => t.rows.length)).toEqual([1, 1])
    expect(shownIds(tabs)).toEqual(['a', 'b'])
  })
})

/**
 * The panel's promise, checked against every node that opts into it.
 *
 * Presentational-only is what makes a styling panel safe to touch, and `affectsData` is the
 * deliberate, *visible* way out of it. A node that quietly admitted a data param to an
 * ordinary tab would go stale with nothing on screen saying why — which is exactly the
 * confusion `ParamGroup.affectsData` exists to prevent, so the absence of a flag has to be a
 * claim something checks rather than an omission nobody notices.
 */
describe('the panel admission rule, over every grouped node', () => {
  const grouped = listableNodeDefs().filter((d) => (d.paramGroups ?? []).length > 0)

  it('covers more than one node, or this proves nothing', () => {
    expect(grouped.length).toBeGreaterThan(1)
  })

  for (const node of grouped) {
    it(`${node.type} admits only presentational params outside a declared data tab`, () => {
      const dataTabs = new Set(
        (node.paramGroups ?? []).filter((g) => g.affectsData).map((g) => g.id),
      )
      const admits = paramsForPanel(node)
      for (const param of node.params ?? []) {
        if (!admits(param)) continue
        if (dataTabs.has(param.group ?? '')) continue
        expect(param.presentational, `${node.type}.${param.id}`).toBe(true)
      }
    })

    it(`${node.type} places every panel param in a declared tab`, () => {
      // Anything ungrouped still reaches the panel, in a trailing "Other" tab — the right
      // safety net, and the wrong home for a control that has one.
      const known = new Set((node.paramGroups ?? []).map((g) => g.id))
      const admits = paramsForPanel(node)
      for (const param of node.params ?? []) {
        if (!admits(param)) continue
        expect(known.has(param.group ?? ''), `${node.type}.${param.id}`).toBe(true)
      }
    })
  }
})

// ---------------------------------------------------------------------------

/**
 * The card's half of the same bucketing.
 *
 * `compare.connectivity` is why the card tabs at all: four settings per dataset behind an arity
 * param, so its band is linear in something the user sets. These pin the two things that make
 * the arrangement work rather than merely exist — that the arity control is in the tab a fresh
 * card opens on, and that turning the arity down takes the tabs with it.
 */
describe('bucketParams over compare.connectivity, the card filter', () => {
  const compare = requireNodeDef('compare.connectivity')
  const card = (p: ParamDef) => !p.advanced
  const at = (datasetCount: number) =>
    bucketParams(compare, { ...defaultParams(compare), datasetCount }, card)

  it('opens with a Settings tab and one per dataset', () => {
    expect(at(2).map((b) => b.label)).toEqual(['Settings', 'Dataset 1', 'Dataset 2'])
    expect(at(4).map((b) => b.label)).toEqual([
      'Settings',
      'Dataset 1',
      'Dataset 2',
      'Dataset 3',
      'Dataset 4',
    ])
  })

  /*
   * The first bucket is the one the card selects by default, and `datasetCount` is what brings
   * the other tabs into existence — behind `Dataset 3` it would be a control you need in order
   * to reach the tab hiding it.
   */
  it('keeps the arity control in the first tab', () => {
    expect(at(4)[0]!.params.map((p) => p.id)).toEqual(['datasetCount', 'minWeight'])
  })

  it('drops a dataset tab when the arity comes back down', () => {
    expect(at(4)).toHaveLength(5)
    expect(at(2)).toHaveLength(3)
    // Nothing is stranded: every visible card param is in exactly one tab.
    const shown = at(2).flatMap((b) => b.params.map((p) => p.id))
    const params = { ...defaultParams(compare), datasetCount: 2 }
    const flat = (compare.params ?? [])
      .filter((p) => card(p) && (!p.visibleIf || p.visibleIf(params)))
      .map((p) => p.id)
    expect([...shown].sort()).toEqual([...flat].sort())
    expect(new Set(shown).size).toBe(shown.length)
  })

  /*
   * The rule that keeps the strip off cards nobody asked for: the card draws one only past two
   * tabs. `out.viewer3d` has no generic rows at all and `out.network` has one, in one group.
   */
  it.each([
    ['out.viewer3d', 0],
    ['out.network', 1],
  ])('leaves %s alone, at %i bucket(s)', (type, expected) => {
    const def = requireNodeDef(type)
    expect(bucketParams(def, defaultParams(def), card)).toHaveLength(expected)
  })
})
