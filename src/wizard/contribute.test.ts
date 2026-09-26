/**
 * The wizard's extension point refuses what would let one pack's answers collide with another's
 * or with a built-in: an id not namespaced by the pack's own directory, and an id offered twice.
 * The sweeps in `wizard.test.ts` hold every merged answer to what a built-in one is held to.
 */

import { describe, expect, it } from 'vitest'

import type { StartContribution, WizardContribution } from './contribute'
import { CONTRIBUTIONS, mergeContributions } from './contribute'
import { viewsById } from './options'

const start = (id: string): StartContribution =>
  ({
    id,
    label: id,
    blurb: '',
    hint: { text: '' },
    head: () => ({ node: { id: 'x', type: 'x' }, port: ['x', 'x'], links: [] }),
  }) as StartContribution

const file = (pack: string, contribution: WizardContribution) => ({
  [`../packs/${pack}/wizard.ts`]: contribution,
})

describe('a pack’s contribution', () => {
  it('is found by its file, the Cortex pack’s among them', () => {
    expect(CONTRIBUTIONS.starts.map((s) => s.id)).toContain('cortex:gallery')
    expect(CONTRIBUTIONS.analyses.map((a) => a.id)).toContain('cortex:laminar')
  })

  it('refuses an id not namespaced by its own pack', () => {
    expect(() => mergeContributions(file('cortex', { starts: [start('gallery')] }))).toThrow(
      /not an answer of pack "cortex"/,
    )
    // Another pack's prefix is no better than none: it would mint that pack's ids. Nor is an
    // empty name, which `packOf`'s grammar refuses where a prefix test would not.
    for (const id of ['zapbench:x', 'cortex:']) {
      expect(() => mergeContributions(file('cortex', { starts: [start(id)] }))).toThrow(
        /not an answer of pack/,
      )
    }
  })

  it('refuses one id offered twice, across kinds too', () => {
    const twice = file('cortex', { starts: [start('cortex:a'), start('cortex:a')] })
    expect(() => mergeContributions(twice)).toThrow(/offered twice/)
    // A start and a viewer sharing an id would draw one as the other.
    const across = file('cortex', {
      starts: [start('cortex:a')],
      visualisations: [{ id: 'cortex:a', label: '', blurb: '', hint: { text: '' } }],
    })
    expect(() => mergeContributions(across)).toThrow(/offered twice/)
  })

  it('may end an analysis on a built-in viewer, and never as another node', () => {
    const analysis = (type: string) => ({ id: 'cortex:x', views: { table: { type } } })
    expect(viewsById([analysis('out.table')], []).get('table')?.type).toBe('out.table')
    expect(() => viewsById([analysis('cortex:laminarProfile')], [])).toThrow(/never redefine/)
  })

  it('holds a pack’s own viewer to one node, one pack, a row and an analysis', () => {
    const ends = (id: string, analysis: string, type = 'cortex:laminarProfile') => ({
      id: analysis,
      views: { [id]: { type } },
    })
    const row = [{ id: 'cortex:v' }]
    expect(viewsById([ends('cortex:v', 'cortex:a')], row).get('cortex:v')?.type).toBe(
      'cortex:laminarProfile',
    )
    // Another pack's viewer, no row, two nodes for one viewer, and a row nothing ends on.
    expect(() => viewsById([ends('cortex:v', 'zapbench:a')], row)).toThrow(/own pack/)
    expect(() => viewsById([ends('cortex:v', 'cortex:a')], [])).toThrow(
      /no `visualisations` row/,
    )
    expect(() =>
      viewsById([ends('cortex:v', 'cortex:a'), ends('cortex:v', 'cortex:b', 'out.table')], row),
    ).toThrow(/another analysis/)
    expect(() => viewsById([], row)).toThrow(/ended on by no analysis/)
  })
})
