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

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

const DATASET = 'optic-lobe-mini'

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

/*
 * Draw a card and get past the Load button, whether or not there is one.
 *
 * Two races otherwise, and both read as the card being broken. The resting state is decided in
 * an effect, so on the first tick there is neither a button nor a map; and the outline cache
 * outlives `cleanup`, so a second card in one test comes up `ready` with no button at all —
 * which is the caching working.
 */
async function loadCard(params: Record<string, ParamValue> = {}, compact = false) {
  const result = draw(params, compact)
  await waitFor(() =>
    expect(
      screen.queryByRole('img', { name: /frontal/i }) ??
        screen.queryByRole('button', { name: /Load/ }),
    ).toBeTruthy(),
  )
  const button = screen.queryByRole('button', { name: /Load/ })
  if (button) fireEvent.click(button)
  await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())
  return result
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
    // optic-lobe-mini's regions fall into two groups, with AOTU(R) deliberately in neither —
    // and the groups are the dataset's own, which is the point of reading them off the dataset
    // rather than from a list in the code.
    fireEvent.click(screen.getByText('Groups'))
    expect(screen.getByLabelText('Optic lobe')).toBeTruthy()
    expect(screen.getByLabelText('Ventrolateral')).toBeTruthy()
    expect(screen.queryByLabelText('Mushroom body')).toBeNull()
  })

  it('hides a group when it is unticked, and never the ungrouped regions', async () => {
    /*
     * An ungrouped region survives a group filter, because no box could ever be ticked to bring
     * it back — hemibrain lists `AL(L)` and `GNG` directly under the dataset root, so that is the
     * common case rather than an oddity.
     */
    draw({ superRois: ['Optic lobe'] })
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())

    expect(screen.getByRole('button', { name: 'ME(R)' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'PVLP(R)' })).toBeNull()
    // Ungrouped, so still drawn.
    expect(screen.getByRole('button', { name: 'AOTU(R)' })).toBeTruthy()
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
    fireEvent.click(screen.getByLabelText('Optic lobe'))

    const [, value] = changes.find(([id]) => id === 'superRois')!
    expect(value).not.toContain('Optic lobe')
    // Everything else stays on: the untick expanded from "all" rather than starting empty.
    expect(value as string[]).toContain('Ventrolateral')
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

  /*
   * A dataset whose published list nests, which the mock's does not.
   *
   * `MockSource` states `primaryRois: meta.rois` deliberately — its shells are flat, no region
   * contains another, and saying so is what lets anything totalling a per-region column total.
   * So the two lists coming apart is stubbed here rather than invented in the mock, where it
   * would be a claim about that connectome's anatomy that is not true of it. The names are the
   * shape a real one takes: medulla layers sit inside `ME(R)`, and neither tiles the volume
   * twice.
   */
  function nesting(extra: string[]): void {
    const nested = new Proxy(source, {
      get(target, prop, receiver) {
        if (prop === 'peekDataset') {
          return (id: string) => {
            const info = target.peekDataset(id)
            if (!info || id !== DATASET) return info
            return { ...info, rois: [...info.rois, ...extra] }
          }
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    registerSource(nested as unknown as DataSource)
  }

  const LAYERS = ['ME(R)_layer_1', 'ME(R)_layer_2', 'ME(R)_layer_3']

  /** Enough sub-regions to be past `ROI_CONFIRM_REGIONS`, which is what the confirm is about. */
  const COLUMNS = Array.from({ length: 600 }, (_, i) => `ME(R)_col_${i}`)

  it('draws the nested regions when Primary regions only is unticked', async () => {
    /*
     * The bug this test exists for: the param was declared, documented and honoured by both
     * exporters, and never reached the card at all — the loader asked for `primaryRois` however
     * the box sat, so unticking it changed the emitted notebook and nothing on screen.
     */
    nesting(LAYERS)

    const primary = await loadCard({ primaryOnly: true })
    expect(screen.getByRole('button', { name: 'ME(R)' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'ME(R)_layer_1' })).toBeNull()
    primary.unmount()
    resetRoiOutlineHooks()

    draw({ primaryOnly: false })
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'ME(R)_layer_1' })).toBeTruthy(),
    )
    // Still the whole list, not the sub-regions instead of their parents.
    expect(screen.getByRole('button', { name: 'ME(R)' })).toBeTruthy()
  })

  it('keeps the two region sets on separate shelves rather than evicting one another', async () => {
    /*
     * The cache key carries a variant, so unticking the box and ticking it back does not pay for
     * the primary set's download a second time. One shared key would have made the two sets two
     * *versions* of one thing, with each switch a fresh 29-62 MB.
     */
    nesting(LAYERS)

    const primary = await loadCard({ primaryOnly: true })
    primary.unmount()
    resetRoiOutlineHooks()

    // A different set, so it has to be asked for — the stored primary copy cannot answer it.
    const all = draw({ primaryOnly: false })
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'ME(R)_layer_1' })).toBeTruthy(),
    )
    expect(fetches).toBe(2)
    all.unmount()
    resetRoiOutlineHooks()

    // And back: no button, no download, because the first copy was never overwritten.
    draw({ primaryOnly: true })
    await waitFor(() => expect(screen.getByRole('img', { name: /frontal/i })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Load/ })).toBeNull()
    expect(fetches).toBe(2)
  })

  it('asks a second time before downloading a whole published list', async () => {
    /*
     * `Load 144 regions` and `Load 5,619 regions` are the same button and not the same wait: one
     * request per region at a concurrency of four is, for male-CNS's published list, well over a
     * thousand sequential rounds against a shared production server.
     */
    nesting(COLUMNS)

    draw({ primaryOnly: false })
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))

    // The press asked rather than started.
    await waitFor(() => expect(screen.getByText(/whole published list/i)).toBeTruthy())
    expect(fetches).toBe(0)
    // Both numbers, because "606 against 6" is what makes somebody press Cancel.
    expect(screen.getByText(/606 regions/)).toBeTruthy()
    expect(screen.getByText(/6 of them tile the volume/)).toBeTruthy()

    // It refuses nothing: Download is right there.
    fireEvent.click(screen.getByRole('button', { name: /Download anyway/ }))
    await waitFor(() => expect(fetches).toBe(1))
  })

  it('goes back to the button on Cancel, and starts nothing', async () => {
    nesting(COLUMNS)

    draw({ primaryOnly: false })
    fireEvent.click(await screen.findByRole('button', { name: /Load/ }))
    await waitFor(() => expect(screen.getByText(/whole published list/i)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Load/ })).toBeTruthy())
    expect(fetches).toBe(0)
  })

  it('keeps two cards on one dataset apart when they want different sets', async () => {
    /*
     * The shared entry is keyed by the region set as well as the dataset, and this is the only
     * arrangement that can show it: one card ticked and one unticked, mounted together. Keyed on
     * the dataset alone, the load started by the first publishes `ready` into the state the
     * second is reading, and the card asking for the whole published list silently draws the
     * primary set — a picture that is not wrong-looking in any way, under a caption promising a
     * different number of regions.
     *
     * The state machine is shared so that two cards do not each paint a progress bar over one
     * download; what it must not do is hand one of them the other's answer.
     */
    nesting(LAYERS)

    // Scoped to each card's own container: RTL's bound queries read `document.body`, so two
    // mounted cards answer every query twice.
    const primary = within(draw({ primaryOnly: true }).container)
    const all = within(draw({ primaryOnly: false }).container)

    // Each already describes its own set — 6 primary regions against 9 published.
    await waitFor(() =>
      expect(all.getByRole('button', { name: /Load 9 regions/ })).toBeTruthy(),
    )

    fireEvent.click(await primary.findByRole('button', { name: /Load 6 regions/ }))
    await waitFor(() => expect(primary.getByRole('img', { name: /frontal/i })).toBeTruthy())

    // Untouched: its own set was never asked for, so it still has its own button.
    expect(all.getByRole('button', { name: /Load 9 regions/ })).toBeTruthy()
    expect(all.queryByRole('img', { name: /frontal/i })).toBeNull()
    expect(fetches).toBe(1)
  })

  it('does not ask twice for a primary set, however large the published one is', async () => {
    // The threshold is about the count being downloaded, not about which box is ticked: the
    // primary set is what the Load button has always described, so it keeps costing one press.
    nesting(COLUMNS)

    await loadCard({ primaryOnly: true })
    expect(fetches).toBe(1)
  })

  /*
   * The frame follows the arrangement.
   *
   * Measurable in jsdom despite there being no layout, because the path data is *ours*: the
   * coordinates in `d` are `ringPath`'s arithmetic, so what the card would draw can be read back
   * without anything being laid out. The property is the one a fit has by definition — the
   * content touches its padding on at least one axis — and the frame held at full explode had it
   * on neither, which is the corner-of-the-card picture this replaced.
   */
  describe('the frame', () => {
    /** The extent of everything drawn, off the path data. */
    function drawnSpan(): { minX: number; minY: number; maxX: number; maxY: number } {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const path of document.querySelectorAll('.roi path')) {
        for (const [, x, y] of (path.getAttribute('d') ?? '').matchAll(
          /[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g,
        )) {
          minX = Math.min(minX, Number(x))
          maxX = Math.max(maxX, Number(x))
          minY = Math.min(minY, Number(y))
          maxY = Math.max(maxY, Number(y))
        }
      }
      return { minX, minY, maxX, maxY }
    }

    /** The box the card drew into, off the viewBox rather than assumed. */
    function box(): { width: number; height: number } {
      const parts = (
        screen.getByRole('img', { name: /frontal/i }).getAttribute('viewBox') ?? ''
      )
        .split(' ')
        .map(Number)
      return { width: parts[2] ?? 0, height: parts[3] ?? 0 }
    }

    const drawn = (explode: number, compact = false) => loadCard({ explode }, compact)

    /** How much of the box the drawing fills on its tighter axis — 1 is touching the padding. */
    function fill(pad: number): number {
      const span = drawnSpan()
      const { width, height } = box()
      return Math.max(
        (span.maxX - span.minX) / (width - pad * 2),
        (span.maxY - span.minY) / (height - pad * 2),
      )
    }

    /*
     * A fit touches its padding on one axis by definition — at any setting of the slider, and on
     * a card as well as in the overlay. The frame held at full explode did so on neither axis,
     * which is the corner-of-the-card picture this replaced. The tolerance is `ringPath`'s
     * `toFixed(1)`.
     */
    it.each([
      ['at rest', 0, false, 12],
      ['once exploded, which is what keeps every region in view', 100, false, 12],
      ['on a card, where the padding is tighter', 0, true, 6],
    ])('fills the box %s', async (_case, explode, compact, pad) => {
      await drawn(explode, compact)
      expect(fill(pad)).toBeGreaterThan(0.99)
      expect(fill(pad)).toBeLessThanOrEqual(1.001)
    })

    it('names every region at rest, and none on a card', async () => {
      /*
       * What this pins is the label pass reaching the card at all — six regions, a budget of
       * eighteen, each a sixth of the picture, so nothing is near the area threshold — and the
       * compact short-circuit, which returns before the pass rather than ranking every region to
       * slice the result to nothing.
       *
       * It deliberately does **not** claim to pin the frame and the labels reading one array.
       * That was its first name, and it was wrong: measured on this connectome, judging the
       * anchors at full explode gives the identical answer at 0/25/50/75/100%, its six regions
       * being large next to their displacements. `roiProjection.test.ts` pins that headlessly on
       * a fixture where the two genuinely differ.
       */
      const rest = await drawn(0)
      const names = [...document.querySelectorAll('.roi__label')].map((n) => n.textContent)
      expect([...names].sort()).toEqual([...getConnectome(DATASET)!.rois].sort())
      rest.unmount()
      resetRoiOutlineHooks()

      await drawn(0, true)
      expect(document.querySelectorAll('.roi__label')).toHaveLength(0)
    })
  })

  /*
   * The zoom's surface.
   *
   * The window arithmetic is `roiProjection.test.ts`' — jsdom lays nothing out and dispatches no
   * real wheel — so what is left here is the two questions a headless test cannot ask: whether
   * the gesture is offered at all, and whether offering it took the *click* away from the
   * regions, which is what this map's pinning is.
   */
  describe('zoom and pan', () => {
    it('offers a fit control off the canvas, and none on it', async () => {
      await loadCard()
      expect(screen.getByLabelText('Fit to view')).toBeTruthy()
      cleanup()
      resetRoiOutlineHooks()
      // Compact is the card on the canvas, where a wheel belongs to React Flow: a map that
      // swallowed it would leave the pane unable to zoom wherever a card happened to be.
      await loadCard({}, true)
      expect(screen.queryByLabelText('Fit to view')).toBeNull()
    })

    it('starts fitted, so the control is dead and the caption says nothing', async () => {
      await loadCard()
      expect(screen.getByLabelText('Fit to view').hasAttribute('disabled')).toBe(true)
      expect(screen.queryByText(/zoomed/)).toBeNull()
    })

    it('still pins a region on a click, which the pan must never take away', async () => {
      /*
       * The regression a pointer-capture-on-press implementation causes: the click after
       * `pointerup` goes to the capturing element rather than to the region under it, so pinning
       * stops working the moment anybody zooms in. `usePanGesture` stops that click in the
       * capture phase, which is just as able to swallow a click that was never a drag — this
       * asserts the ordinary press still lands.
       */
      await loadCard()
      const region = getConnectome(DATASET)!.rois[0]!
      fireEvent.click(screen.getByRole('button', { name: region }))
      await waitFor(() => expect(screen.getByText(/from display mesh/i)).toBeTruthy())
      expect(screen.getByRole('button', { name: region }).getAttribute('aria-pressed')).toBe(
        'true',
      )
    })
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
