// @vitest-environment jsdom

/**
 * The Paths card: its four settings, and the caption under them.
 *
 * The settings half is what this file mostly guards, and the failure it guards against is
 * silent. A body replaces the generic param band outright, so a control it does not render is
 * reachable only from the inspector — and a card drawing no controls looks exactly like a node
 * that has none. On this node that is the whole of the query: `Max hops`, `Min synapses`,
 * `N strongest` and `Collapse types` decide what is searched, and the card's own empty readout
 * names two of them.
 *
 * Rendered directly rather than through the editor: what is under test is the card, and a real
 * path query would need a backend to answer hops it is not the point of this file to fetch.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import type { ParamValue } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { tableFromRows } from '../../core/values'
import { useGraphStore } from '../../store/graphStore'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { PathsBody } from './PathsBody'
import '../../nodes'

beforeAll(() => {
  installJsdomStubs({ width: 300, height: 240 })
})
afterEach(cleanup)

const TYPE = 'neuron.paths'

/** The node's own `paths` output — one row per route, ranked strongest-first. */
function routes(): TableValue {
  return tableFromRows(
    tableSchema(column('path', 'str'), column('hops', 'i64'), column('bottleneck', 'i64')),
    [
      { path: 'LC4 → PLP1 → DNp01', hops: 2, bottleneck: 120 },
      { path: 'LC4 → PLP1 → LPLC2 → DNp01', hops: 3, bottleneck: 40 },
    ],
  )
}

function draw(options: {
  params?: Record<string, ParamValue>
  paths?: TableValue
  setParam?: (id: string, value: ParamValue) => void
  compact?: boolean
}) {
  const def = requireNodeDef(TYPE)
  const merged = { ...defaultParams(def), ...(options.params ?? {}) }
  const node = { id: 'paths', type: TYPE, position: { x: 0, y: 0 }, params: merged }

  // The body reads the run through the store, so the store is what has to be primed — the
  // scheduler is not what is under test.
  useGraphStore.setState({ nodeOutput: (() => options.paths) as never } as never)

  const ctx = makeInferContext(def, merged, {
    sources: T.neurons(),
    targets: T.neurons(),
  })
  return render(
    <PathsBody
      node={node as never}
      ctx={ctx}
      compact={options.compact ?? true}
      setParam={options.setParam ?? (() => {})}
      onError={() => {}}
    />,
  )
}

const defaults = () => defaultParams(requireNodeDef(TYPE))

const labels = () => [...document.querySelectorAll('.param__label')].map((el) => el.textContent)

describe('the Paths card', () => {
  /** What the definition says belongs on the card, given these values. `visibleIf` included. */
  const declared = (params: Record<string, ParamValue> = {}) =>
    (requireNodeDef(TYPE).params ?? [])
      .filter((p) => !p.advanced && (!p.visibleIf || p.visibleIf({ ...defaults(), ...params })))
      .map((p) => p.label)

  it('draws every non-advanced param exactly once, in declaration order', () => {
    // Against a written-out list rather than against `declared()`: comparing the card to the
    // definition passes just as well when both are empty, and the order is half the assertion.
    draw({})
    expect(labels()).toEqual([
      'Max hops',
      'Min synapses',
      'N strongest',
      'Collapse types',
      'Normalize',
    ])
  })

  it('draws the normalisation settings only once Normalize is on', () => {
    /*
     * Four of the nine are `visibleIf`-hidden, which is what keeps a card holding the whole of a
     * path query from being nine rows deep for everybody. The body has to honour that itself —
     * it renders the param list rather than the band, so the generic card's filtering is not
     * doing this for it, and the params are excluded from the provenance key on the same test.
     */
    draw({})
    expect(labels()).not.toContain('Normalize by')

    cleanup()
    draw({ params: { normalize: true } })
    // Asked of the definition here, so a sixth setting cannot arrive drawn nowhere — the case
    // the literal above cannot see, since it is a list somebody has to remember to extend.
    expect(labels()).toEqual(declared({ normalize: true }))
    expect(labels()).toHaveLength(9)
    expect(labels().slice(5)).toEqual([
      'Normalize by',
      'Denominator',
      'Rank by',
      'Min fraction',
    ])
  })

  it('labels the Collapse types checkbox once', () => {
    /*
     * `ParamField`'s checkbox draws its own label under the default `node` variant, and the
     * generic card suppresses the row's label in CSS instead — so a body rendering both would
     * say "Collapse types Collapse types". jsdom applies no CSS, which is exactly why the count
     * has to be asserted rather than looked at.
     */
    draw({})
    const written = [...document.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && el.textContent?.trim() === 'Collapse types',
    )
    expect(written).toHaveLength(1)
    expect(screen.getByRole('checkbox', { name: 'Collapse types' })).toBeTruthy()
  })

  it('writes an edited setting back to the node', () => {
    const setParam = vi.fn()
    draw({ setParam })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Collapse types' }))
    expect(setParam).toHaveBeenCalledWith('collapseTypes', false)
  })

  it('shows what the params are, not what the run reported', () => {
    // A stored graph carries its own values, and the card is where they are read before a run.
    draw({ params: { maxHops: 5, minWeight: 50 } })
    // A textbox rather than a number input: `NumberField` is drag-to-scrub, so it holds text
    // and reads only until it is clicked into.
    const field = (name: string) => (screen.getByLabelText(name) as HTMLInputElement).value
    expect(field('Max hops')).toBe('5')
    expect(field('Min synapses')).toBe('50')
  })

  it('reads the strongest fraction off the run, and names the end it is a share of', () => {
    /*
     * Only where the run published one — the `bottleneckNorm` column is the switch, the same way
     * it is for everything downstream. Which end it is a share *of* is `Normalize by`, so the
     * label reads the param rather than assuming the default: a card saying "of input" over a
     * run normalised by the source's output is a wrong number with the right shape.
     */
    const normalised = tableFromRows(
      tableSchema(
        column('path', 'str'),
        column('hops', 'i64'),
        column('bottleneck', 'f64'),
        column('bottleneckNorm', 'f64'),
      ),
      [
        { path: 'LC4 → PLP1 → DNp01', hops: 2, bottleneck: 120, bottleneckNorm: 0.42 },
        { path: 'LC4 → LPLC2 → DNp01', hops: 2, bottleneck: 400, bottleneckNorm: null },
      ],
    )
    draw({ paths: normalised, params: { normalize: true } })
    // The maximum over the routes that have one; the null is skipped rather than read as zero.
    expect(screen.getByText(/42% of input/)).toBeTruthy()

    cleanup()
    draw({ paths: normalised, params: { normalize: true, normalizeBy: 'presynaptic' } })
    expect(screen.getByText(/42% of output/)).toBeTruthy()
  })

  it('says nothing about fractions on a run that had none', () => {
    draw({ paths: routes() })
    expect(screen.queryByText(/of input/)).toBeNull()
  })

  it('reads the shortest route and the strongest bottleneck off its own output', () => {
    // Neither is legible from the network downstream — you would have to trace it by eye.
    draw({ paths: routes() })
    expect(screen.getByText(/2 routes/)).toBeTruthy()
    expect(screen.getByText(/min 2 hops/)).toBeTruthy()
    expect(screen.getByText(/120 syn bottleneck/)).toBeTruthy()
  })

  it('distinguishes an empty result from a node that has not run', () => {
    // "No route within N hops at this threshold" is a real answer, and it points at the two
    // controls now sitting directly above the sentence.
    draw({ paths: tableFromRows(routes().schema, []) })
    expect(screen.getByText(/No route found/)).toBeTruthy()
    cleanup()
    draw({})
    expect(screen.getByText('Not run yet.')).toBeTruthy()
  })

  it('writes the strongest route out only where there is room for it', () => {
    // An identifier chain wrapped over three lines grows the card on every extra hop, so the
    // card gets the counts and the full-size surface gets the route.
    draw({ paths: routes() })
    expect(screen.queryByText('LC4 → PLP1 → DNp01')).toBeNull()
    cleanup()
    draw({ paths: routes(), compact: false })
    expect(screen.getByText('LC4 → PLP1 → DNp01')).toBeTruthy()
  })
})
