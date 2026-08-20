// @vitest-environment jsdom

/**
 * The ROIs widget.
 *
 * The geometry is pinned in `roiProjection.test.ts` and what gets stored in
 * `roiOutlines.test.ts`; what is left for here is everything those cannot see — that the card
 * asks before spending sixty megabytes, that it stops asking once the outlines are cached, and
 * that the caption admits what is not on screen.
 *
 * The first test is the one that matters most and is the least interesting to read. It drives
 * **`ValuePreview`** rather than the component, because this node has no outputs: its value is
 * `undefined` forever, so a branch placed below that guard is unreachable and the card reads
 * "No result yet" permanently. `out.datasetSummary` shipped exactly that, with a green suite,
 * because every test rendered the viewer directly.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { defaultParams, makeInferContext } from '../../core/node'
import type { ParamValue } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { T } from '../../core/types'
import { resetCache } from '../../data/cache'
import { MockSource } from '../../data/mock/MockSource'
import { getConnectome } from '../../data/mock/generate'
import type { DataSource } from '../../data/source'
import { registerSource } from '../../data/source'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { ValuePreview } from './ValuePreview'
import { resetRoiOutlineState } from './roiOutlines'
import { resetRoiOutlineHooks } from './useRoiOutlines'
import '../../nodes'

const DATASET = 'hemibrain-mini'

let source: MockSource
let fetches = 0

beforeAll(() => {
  installJsdomStubs({ width: 620, height: 460 })
})

beforeEach(() => {
  fetches = 0
  const real = new MockSource({ latencyMs: 0 })
  source = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'fetchRoiMeshes') {
        return (req: Parameters<MockSource['fetchRoiMeshes']>[0]) => {
          fetches++
          return target.fetchRoiMeshes(req)
        }
      }
      return Reflect.get(target, prop, receiver) as unknown
    },
  }) as MockSource
  registerSource(source as unknown as DataSource)
  resetCache()
  resetRoiOutlineState()
  resetRoiOutlineHooks()
})

afterEach(cleanup)

function draw(params: Record<string, ParamValue> = {}, compact = false) {
  const def = requireNodeDef('out.rois')
  const merged = { ...defaultParams(def), ...params }
  const node = { id: 'rois', type: 'out.rois', position: { x: 0, y: 0 }, params: merged }
  const ctx = makeInferContext(def, merged, { dataset: T.dataset('mock', DATASET) })
  return render(
    <ValuePreview
      node={node as never}
      value={undefined}
      ctx={ctx}
      compact={compact}
      inputValues={{
        dataset: { kind: 'dataset', sourceId: 'mock', datasetId: DATASET, label: 'Mock' },
      }}
    />,
  )
}

describe('the ROIs card', () => {
  it('renders at all, though the node has no output value', async () => {
    draw()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Load \d+ regions/ })).toBeTruthy(),
    )
    // The failure this test exists for: a branch below `!value` shows this forever.
    expect(screen.queryByText(/No result yet/)).toBeNull()
  })

  it('asks before downloading, and says why', async () => {
    /*
     * 29-62 MB of region mesh, four to nine times Explore's whole-dataset index. A card that
     * pulled that off a shared production server because somebody dropped it on a canvas is not
     * one anybody can leave lying around.
     */
    draw()
    await waitFor(() => expect(screen.getByRole('button', { name: /Load/ })).toBeTruthy())
    expect(fetches).toBe(0)
    expect(screen.getByText(/tens of megabytes/i)).toBeTruthy()
  })

  it('draws the regions once loaded', async () => {
    draw()
    const button = await screen.findByRole('button', { name: /Load/ })
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())
    expect(fetches).toBe(1)
    const svg = screen.getByRole('img', { name: /frontal/i })
    // One path per ring; the mock's shells are convex, so one ring each.
    expect(svg.querySelectorAll('path').length).toBeGreaterThanOrEqual(
      getConnectome(DATASET)!.rois.length,
    )
  })

  it('does not ask a second time once the outlines are cached', async () => {
    const first = draw()
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())
    first.unmount()
    resetRoiOutlineHooks()

    // A fresh card on the same dataset: the polylines are in the cache, so no button and no
    // download. `idle` means "not stored", never "never loaded".
    draw()
    await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Load/ })).toBeNull()
    expect(fetches).toBe(1)
  })

  it('names the plane it is showing, and switches', async () => {
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())

    // Three planes and no camera, which is what makes the outlines cacheable at all.
    expect(screen.getByRole('button', { name: 'Frontal' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dorsal' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Lateral' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '3D' })).toBeNull()
  })

  it('puts every drawing control on the card, not only in the inspector', async () => {
    // A map whose colour and labels could only be changed from a panel elsewhere is a map you
    // have to leave to read.
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())
    expect(screen.getByLabelText('Explode')).toBeTruthy()
    expect(screen.getByLabelText('Colour')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Labels' })).toBeTruthy()
  })

  it('keys the ramp only for the sequential colour modes', async () => {
    /*
     * `region` gets no key by design: 63 to 152 hues meaning "not that one" have nothing to
     * list. `side` and `flat` are self-evident from three colours and one. A ramp is the only
     * one standing for numbers, and a ramp without its ends labelled is decoration.
     */
    const withRamp = draw({ colorBy: 'postCompleteness' })
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(screen.getByText(/postsynaptic traced/i)).toBeTruthy())
    expect(document.querySelector('.colorbar__ramp')).toBeTruthy()
    withRamp.unmount()
    resetRoiOutlineHooks()

    draw({ colorBy: 'region' })
    await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())
    expect(document.querySelector('.colorbar__ramp')).toBeNull()
  })

  it('reddens the presynaptic ramp, so the two measures are not one picture', async () => {
    const post = draw({ colorBy: 'postCompleteness' })
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(document.querySelector('.colorbar__ramp')).toBeTruthy())
    const blue = document.querySelector('.colorbar__ramp')!.getAttribute('style')
    post.unmount()
    resetRoiOutlineHooks()

    draw({ colorBy: 'preCompleteness' })
    await waitFor(() => expect(screen.getByText(/presynaptic traced/i)).toBeTruthy())
    const red = document.querySelector('.colorbar__ramp')!.getAttribute('style')
    expect(red).not.toBe(blue)
  })

  it('gives a left/right pair one colour under Region', async () => {
    // The mock connectome is one-sided, so this is asserted on the rule rather than on a
    // rendered pair — see roiStyle.test.ts for the rest of it.
    draw({ colorBy: 'region' })
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())
    const fills = new Set(
      Array.from(document.querySelectorAll('.roi path')).map((p) => p.getAttribute('stroke')),
    )
    // Every region distinguishable from every other, which is the whole claim.
    expect(fills.size).toBe(getConnectome(DATASET)!.rois.length)
  })

  it('admits the explode in the caption rather than only in the picture', async () => {
    draw({ explode: 60 })
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(screen.getByText(/exploded 60%/)).toBeTruthy())
  })

  it('says when completeness has not arrived, rather than painting a colour it does not have', async () => {
    // The colour means "traced fraction". Before the table lands there is nothing to encode, and
    // a card that just drew grey would be indistinguishable from a fully untraced connectome.
    const noCompleteness = new Proxy(source, {
      get(target, prop, receiver) {
        if (prop === 'capabilities') return { ...target.capabilities, roiSummary: false }
        if (prop === 'fetchRoiCompleteness') return undefined
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    registerSource(noCompleteness as unknown as DataSource)

    draw({ colorBy: 'postCompleteness' })
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(screen.getByText(/completeness not loaded/i)).toBeTruthy())
  })

  it("offers the dataset's region groups, and only where there are some", async () => {
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())
    // hemibrain-mini's regions fall into two groups, with AL(R) and LH(R) deliberately in
    // neither — the optic-lobe dataset has its own, which is the point of reading them off the
    // dataset rather than from a list in the code.
    fireEvent.click(screen.getByText('Groups'))
    expect(screen.getByLabelText('Mushroom body')).toBeTruthy()
    expect(screen.getByLabelText('Superior')).toBeTruthy()
    expect(screen.queryByLabelText('Optic lobe')).toBeNull()
  })

  it('hides a group when it is unticked, and never the ungrouped regions', async () => {
    /*
     * An ungrouped region survives a group filter, because no box could ever be ticked to bring
     * it back — hemibrain lists `AL(L)` and `GNG` directly under the dataset root, so that is the
     * common case rather than an oddity.
     */
    draw({ superRois: ['Mushroom body'] })
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())

    expect(screen.getByRole('button', { name: 'CA(R)' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'SLP(R)' })).toBeNull()
    // Ungrouped, so still drawn.
    expect(screen.getByRole('button', { name: 'AL(R)' })).toBeTruthy()
  })

  it('starts from every group when the first one is unticked', async () => {
    /*
     * Empty means *all*, so the first untick has to expand to the full list minus one. Starting
     * from nothing would hide every other group on the first click, which reads as the control
     * being inverted.
     */
    const changes: Array<[string, unknown]> = []
    const def = requireNodeDef('out.rois')
    const merged = { ...defaultParams(def) }
    const node = { id: 'rois', type: 'out.rois', position: { x: 0, y: 0 }, params: merged }
    const ctx = makeInferContext(def, merged, { dataset: T.dataset('mock', DATASET) })
    render(
      <ValuePreview
        node={node as never}
        value={undefined}
        ctx={ctx}
        onParamChange={(id, value) => changes.push([id, value])}
        inputValues={{
          dataset: { kind: 'dataset', sourceId: 'mock', datasetId: DATASET, label: 'Mock' },
        }}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())

    fireEvent.click(screen.getByText('Groups'))
    fireEvent.click(screen.getByLabelText('Mushroom body'))

    const [, value] = changes.find(([id]) => id === 'superRois')!
    expect(value).not.toContain('Mushroom body')
    // Everything else stays on: the untick expanded from "all" rather than starting empty.
    expect(value as string[]).toContain('Superior')
  })

  it('drops the rail on a card and keeps it in the overlay', async () => {
    const compact = draw({}, true)
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())
    expect(document.querySelector('.rois__rail')).toBeNull()
    compact.unmount()
    resetRoiOutlineHooks()

    draw({}, false)
    await waitFor(() => expect(document.querySelector('.rois__rail')).toBeTruthy())
  })

  it('reports a source that publishes no region meshes, rather than an empty map', async () => {
    const withoutMeshes = new Proxy(source, {
      get(target, prop, receiver) {
        if (prop === 'capabilities') return { ...target.capabilities, roiMeshes: false }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    registerSource(withoutMeshes as unknown as DataSource)

    draw()
    await waitFor(() => expect(screen.getByText(/no region meshes/i)).toBeTruthy())
    expect(fetches).toBe(0)
  })

  it('marks the volume as an estimate, because neuPrint says these are not measurements', async () => {
    /*
     * "Intended for visualization only… not suitable for quantitative analysis" is neuprint's
     * own docstring, and Coda decimates them further before measuring. The number is carried
     * because nothing else in the app can say anything about a region's size — but it has to
     * say where it came from.
     */
    draw()
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(document.querySelector('.rois__rail')).toBeTruthy())

    const region = getConnectome(DATASET)!.rois[0]!
    fireEvent.click(screen.getByRole('button', { name: region }))
    await waitFor(() => expect(screen.getByText(/from display mesh/i)).toBeTruthy())
  })
})
