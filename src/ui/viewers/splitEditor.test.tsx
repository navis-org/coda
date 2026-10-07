// @vitest-environment jsdom
/**
 * Split Axon/Dendrite's expanded view: a click on a drawn branch writes the correction it stands
 * for, and the list edits what is stored.
 *
 * jsdom lays nothing out, so the click is aimed the way the Neuron Dendrogram's test aims its own:
 * at where the stubbed 800 × 480 stage draws the branch, scaled by the stub's card zoom. Whether
 * the menu sits sensibly over a real arbour is a browser question this cannot answer.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { PointsValue, SkeletonsValue } from '../../core/values'
import { CODE_AXON, CODE_DENDRITE, EMPTY_BOUNDS, makeTable } from '../../core/values'
import { DAYLIGHT_PASSES, equalAngleLayout } from '../../nodes/lib/arborLayout'
import { buildArbor, keyTree, landmarkDistances } from '../../nodes/lib/arborOps'
import { ySkeleton } from '../../nodes/lib/__fixtures__/ySkeleton'
import type { SplitCorrection } from '../../nodes/lib/splitCorrections'
import {
  CORRECTIONS_PARAM,
  readCorrections,
  writeCorrection,
} from '../../nodes/lib/splitCorrections'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { fitTransform, toScreen } from './arborPlot'
import { SplitEditor } from './SplitEditor'

const D = CODE_DENDRITE
const A = CODE_AXON

/** Two Ys: the first split, the second not. */
function value(): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [
      { ...ySkeleton(), id: '1001', split: Uint8Array.from([D, D, D, A, D, D]) },
      { ...ySkeleton(), id: '1002' },
    ],
    attributes: makeTable(tableSchema(column('neuronId', 'str'), column('type', 'str')), {
      neuronId: ['1001', '1002'],
      type: ['LC4', 'LC6'],
    }),
    bounds: EMPTY_BOUNDS,
    units: 'nm',
  }
}

/**
 * Where the stub's stage draws a point `along` the piece ending at `leaf`, with the Y rooted at
 * `root` — the unrooted layout the editor draws, daylight passes included. Scaled by the stub's
 * card zoom, the Neuron Dendrogram test's aim.
 */
function onBranch(along: number, leaf = 3, root = 0): { clientX: number; clientY: number } {
  const arbor = buildArbor(ySkeleton(), root)
  const tree = keyTree(arbor)
  const shape = equalAngleLayout(tree, landmarkDistances(tree, arbor.geodesic), DAYLIGHT_PASSES)
  const k = tree.nodes.indexOf(leaf)
  const [x, y] = toScreen(
    fitTransform(shape, 800, 480),
    shape.x0[k]! + along * (shape.x1[k]! - shape.x0[k]!),
    shape.y0[k]! + along * (shape.y1[k]! - shape.y0[k]!),
  )
  const zoom = 800 / 1200
  return { clientX: x * zoom, clientY: y * zoom }
}

/** Let the unrooted layout's daylight refinement land, as it would a frame later. */
const settle = () => act(async () => {})

/** The menu item with this text. */
function item(text: string): HTMLElement {
  const found = [
    ...screen.getByRole('menu').querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((el) => el.textContent?.includes(text))
  if (!found) throw new Error(`no menu item "${text}"`)
  return found
}

/** The `index`-th menu item offering `target` — 0 under "Away from the root", 1 under "Everything else". */
function target(target: string, index: 0 | 1): HTMLElement {
  return [
    ...screen.getByRole('menu').querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].filter((el) => el.textContent === target)[index]!
}

const stored = (corrections: SplitCorrection[]) => corrections.map(writeCorrection)
const mine: SplitCorrection = { neuron: '1001', at: [3000, 0, 0], scope: 'distal', to: 'axon' }
const theirs: SplitCorrection = { ...mine, neuron: '1002' }

function renderEditor(
  corrections: SplitCorrection[] = [],
  extra: { synapses?: PointsValue; showSynapses?: boolean } = {},
) {
  const onParamChange = vi.fn()
  render(
    <SplitEditor
      skeletons={value()}
      synapses={extra.synapses}
      corrections={stored(corrections)}
      showSynapses={extra.showSynapses ?? true}
      onParamChange={onParamChange}
    />,
  )
  return onParamChange
}

/**
 * Neuron 1001's synapses: two outputs on the axon leaf (node 3) and two inputs on the dendrite
 * leaf (node 5) — wholly segregated, so its index is 1.
 */
function cloud(): PointsValue {
  const rows: [number, number, string][] = [
    [3000, 0, 'pre'],
    [3000, 0, 'pre'],
    [2000, 2000, 'post'],
    [2000, 2000, 'post'],
  ]
  return {
    kind: 'points',
    positions: Float32Array.from(rows.flatMap(([x, y]) => [x, y, 0])),
    attributes: makeTable(tableSchema(column('neuronId', 'str'), column('polarity', 'str')), {
      neuronId: rows.map(() => '1001'),
      polarity: rows.map(([, , p]) => p),
    }),
    bounds: EMPTY_BOUNDS,
    units: 'nm',
  }
}

/** What the last write stored, read back. */
function written(onParamChange: ReturnType<typeof vi.fn>): SplitCorrection[] {
  const [paramId, next] = onParamChange.mock.calls.at(-1)!
  expect(paramId).toBe(CORRECTIONS_PARAM)
  return readCorrections(next)
}

beforeEach(() => installJsdomStubs())
afterEach(cleanup)

describe('SplitEditor', () => {
  it('draws the neuron on screen, and pages to the next', () => {
    renderEditor()
    expect(screen.getByLabelText('LC4 split')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Next neuron'))
    // The second neuron carries no split, so there is nothing to draw or correct.
    expect(screen.getByText(/has no split/)).toBeTruthy()
  })

  it('writes the correction a click on a branch stands for, with the root it was made against', async () => {
    const onParamChange = renderEditor([theirs])
    await settle()
    fireEvent.click(screen.getByLabelText('LC4 split').parentElement!, onBranch(0.5))
    fireEvent.click(target('linker', 0))
    expect(written(onParamChange)).toEqual([
      theirs,
      { neuron: '1001', at: [3000, 0, 0], scope: 'distal', to: 'linker', root: [0, 0, 0] },
    ])
  })

  it('re-roots at the nearer end of a clicked branch, and corrections then record that root', async () => {
    const onParamChange = renderEditor()
    await settle()
    const plot = () => screen.getByLabelText('LC4 split').parentElement!
    // Near the leaf end of 2 → 3: node 3 becomes the root.
    fireEvent.click(plot(), onBranch(0.9))
    fireEvent.click(item('Make this the root'))
    await settle()
    expect(screen.getByText('Reset root')).toBeTruthy()

    // Rooted at 3 the leaves are 0 and 5; a correction on the piece ending at 0.
    fireEvent.click(plot(), onBranch(0.5, 0, 3))
    fireEvent.click(target('axon', 0))
    expect(written(onParamChange)[0]!.root).toEqual([3000, 0, 0])

    fireEvent.click(screen.getByText('Reset root'))
    expect(screen.queryByText('Reset root')).toBeNull()
  })

  it('says how segregated the split on screen is — Summary’s number, corrections included', () => {
    renderEditor([], { synapses: cloud() })
    // Outputs all on the axon, inputs all on the dendrite.
    expect(screen.getByText('SI 1.00')).toBeTruthy()
  })

  it('toggles the synapses through the remembered setting', () => {
    const onParamChange = renderEditor([], { synapses: cloud(), showSynapses: true })
    const toggle = screen.getByText('Synapses')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(onParamChange).toHaveBeenLastCalledWith('showSynapses', false)
  })

  it('lists this neuron’s corrections only, and removes or resets them', () => {
    const onParamChange = renderEditor([theirs, mine])
    expect(screen.getAllByLabelText(/^Remove correction/)).toHaveLength(1)

    fireEvent.click(screen.getByLabelText('Remove correction 1'))
    expect(written(onParamChange)).toEqual([theirs])

    fireEvent.click(screen.getByText('Reset this neuron'))
    expect(written(onParamChange)).toEqual([theirs])
  })
})
