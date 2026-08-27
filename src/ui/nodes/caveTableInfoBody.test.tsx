// @vitest-environment jsdom

/**
 * The `CAVE table info` card.
 *
 * The card is where this node puts everything that is *not* tabular — the description, the schema
 * type, the two row counts — so what has to hold is that each of those actually appears, and that
 * the states on the way to appearing are told apart. That last part is the whole of `absence`:
 * there are two fetches rather than one, so "the listing has not landed" and "the facts have not
 * landed" are different stalls, and a card that said one thing for both would be unattributable.
 *
 * Rendered directly rather than through the whole editor, with one assertion that the body is
 * registered at all — the failure `descriptionBody.test.tsx` covers for its own card, and the
 * only part of the wiring a component test cannot see.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GraphNode } from '../../core/graph'
import type { InferContext } from '../../core/node'
import { T } from '../../core/types'
import type { CodaType } from '../../core/types'
import { resetCredentials, setToken } from '../../data/cave/credentials'
import { resetCaveState, tableFactsFor, tableListFor } from '../../data/cave/tables'
import { installCaveFetch } from '../../test/caveStubs'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { CaveTableInfoBody } from './CaveTableInfoBody'
import { nodeBody } from './nodeBodies'

function draw(
  params: Record<string, unknown>,
  options: { dataset?: CodaType; compact?: boolean } = {},
) {
  const node = { id: 'n1', type: 'cave.tableInfo', position: { x: 0, y: 0 }, params } as GraphNode
  const ctx = {
    params,
    inputs: options.dataset ? { dataset: options.dataset } : {},
    outputs: {},
    schema: () => undefined,
    column: () => '',
    columns: () => [],
    observed: undefined,
  } as unknown as InferContext
  return render(
    <CaveTableInfoBody
      node={node}
      ctx={ctx}
      compact={options.compact ?? true}
      setParam={() => undefined}
      onError={() => undefined}
    />,
  )
}

beforeEach(() => {
  installJsdomStubs({ width: 1000, height: 700 })
  resetCaveState()
  resetCredentials()
  setToken('token')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetCredentials()
})

describe('the CAVE table info card', () => {
  it('is registered as a body, so the node draws one rather than a bare header', () => {
    expect(nodeBody('cave.tableInfo')?.Component).toBe(CaveTableInfoBody)
    // Prose, and FlyWire's `nuclei_v1` publishes six paragraphs of it — the overlay is where a
    // table's caveats are actually read.
    expect(nodeBody('cave.tableInfo')?.expandable).toBe(true)
  })

  it('draws the name, the schema type, both counts and the publisher’s description', async () => {
    installCaveFetch({ counts: [143140, 140000] })
    await tableFactsFor('flywire_fafb_public', 783, 'nuclei_v1')
    draw({ datastack: 'flywire_fafb_public:783', table: 'nuclei_v1' })

    expect(screen.getByText('nuclei_v1')).toBeTruthy()
    expect(screen.getByText('nucleus_detection')).toBeTruthy()
    expect(screen.getByText('table')).toBeTruthy()
    /*
     * Both counts, each with a label saying which it is. They disagree by up to a third on a real
     * table and each answers a different question; showing one without saying which is what
     * `docs/backends.md` records as having cost a debugging round trip, so the fixture makes
     * them differ deliberately.
     */
    expect(screen.getByText('rows')).toBeTruthy()
    expect(screen.getByText('143,140')).toBeTruthy()
    expect(screen.getByText('in v783')).toBeTruthy()
    expect(screen.getByText('140,000')).toBeTruthy()
    expect(document.body.textContent).toContain('FlyWire nucleus description')
  })

  it('takes the datastack from a wired Dataset over the field', async () => {
    installCaveFetch({ counts: [143140, 140000] })
    await tableFactsFor('flywire_fafb_public', 783, 'nuclei_v1')
    draw(
      { datastack: 'nonsense:1', table: 'nuclei_v1' },
      { dataset: T.dataset('cave', 'flywire_fafb_public:783') },
    )
    expect(screen.getByText('nucleus_detection')).toBeTruthy()
  })

  /*
   * A view has no metadata endpoint and no count endpoint — both were probed and both 404 (the
   * count as a 500 wrapping one) — so its description comes from the listing and the count rows
   * are simply absent. What must not happen is a card claiming a count of zero.
   */
  it('draws a view from the listing, with no row counts at all', async () => {
    installCaveFetch({ counts: [143140, 140000] })
    await tableFactsFor('flywire_fafb_public', 783, 'valid_connection_v2')
    draw({ datastack: 'flywire_fafb_public:783', table: 'valid_connection_v2' })
    expect(screen.getByText('view')).toBeTruthy()
    expect(document.body.textContent).toContain('This is a summary table')
    expect(screen.queryByText('rows')).toBeNull()
    expect(document.body.textContent).not.toContain('in v783')
  })

  it('holds the permissions back on the card and shows them in the overlay', async () => {
    installCaveFetch({ counts: [143140, 140000] })
    await tableFactsFor('flywire_fafb_public', 783, 'nuclei_v1')
    draw({ datastack: 'flywire_fafb_public:783', table: 'nuclei_v1' }, { compact: true })
    expect(screen.queryByText(/read PUBLIC/)).toBeNull()
    cleanup()
    draw({ datastack: 'flywire_fafb_public:783', table: 'nuclei_v1' }, { compact: false })
    expect(screen.getByText(/read PUBLIC/)).toBeTruthy()
  })

  /*
   * The five absences, said apart. They are states the card passes through, and collapsing them
   * would have a card that is about to fill itself look like a card that never will.
   */
  it('says which of the five absences it is in', async () => {
    installCaveFetch({ counts: [143140, 140000] })

    draw({ datastack: '', table: '' })
    expect(document.body.textContent).toContain('Name a datastack')
    cleanup()

    draw({ datastack: 'flywire_fafb_public:783', table: '' })
    expect(document.body.textContent).toContain('Name a table or a view')
    cleanup()

    // The listing is the first hop, and it has not landed.
    draw({ datastack: 'flywire_fafb_public:783', table: 'nuclei_v1' })
    expect(document.body.textContent).toContain('has not listed its tables yet')
    cleanup()

    await tableListFor('flywire_fafb_public', 783)

    // It has now, and this name is not in it.
    draw({ datastack: 'flywire_fafb_public:783', table: 'nuclei_v2' })
    expect(document.body.textContent).toContain('publishes no "nuclei_v2"')
    cleanup()

    // A real name, whose facts are the second hop and are still outstanding.
    draw({ datastack: 'flywire_fafb_public:783', table: 'nuclei_v1' })
    expect(document.body.textContent).toContain('Reading nuclei_v1')
  })
})
