// @vitest-environment jsdom

/**
 * How the embed navigates, which is the whole of its behaviour.
 *
 * The rule being pinned: the *first* navigation carries the whole scene, and every later one
 * carries only what this app owns, in neuroglancer's `#!+` merge form. The full form makes
 * neuroglancer reset before restoring, so sending it on every change threw away the framing
 * someone had just set up each time a selection changed upstream. Nothing fails if this
 * regresses — the camera just jumps, and nobody connects that to a filter three nodes away.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import { parseSceneUrl, sceneUrl } from '../../data/neuroglancer/scene'
import { installJsdomStubs } from '../../test/jsdomStubs'
import { NeuroglancerViewer } from './NeuroglancerViewer'

beforeAll(() => installJsdomStubs({ width: 800, height: 500 }))
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const NEURONS = tableFromRows(
  tableSchema(column('neuronId', 'i64'), column('type', 'str')),
  [
    { neuronId: 1, type: 'DNa02' },
    { neuronId: 2, type: 'DNa02' },
    { neuronId: 3, type: 'DNp01' },
  ],
  'neurons',
)

const SEGMENTATION = {
  type: 'segmentation',
  name: 'hemibrain:v1.2.1',
  source: 'precomputed://gs://b/segmentation',
}

/** A published scene: a curated camera plus two layers, one of which holds the neurons. */
function sceneWith(segments: string[], position = [1, 2, 3]) {
  return {
    position,
    projectionScale: 91364,
    layout: '3d',
    showSlices: false,
    layers: [
      { type: 'image', name: 'em', source: 'precomputed://gs://b/em' },
      { ...SEGMENTATION, segments },
    ],
  }
}

const URL_A = sceneUrl(undefined, sceneWith(['1']))
const URL_B = sceneUrl(undefined, sceneWith(['1', '2']))
/** A different dataset: same shape, different published camera. */
const URL_OTHER = sceneUrl(undefined, sceneWith(['9'], [900, 900, 900]))
const CATEGORICAL = { mode: 'categorical' as const, column: 'type', constant: '0' }

function frame(container: HTMLElement): HTMLIFrameElement | null {
  return container.querySelector('iframe')
}

const frameSrc = (container: HTMLElement): string => frame(container)?.getAttribute('src') ?? ''
/** The scene the frame is pointed at, whichever host and whichever form the URL took. */
const frameScene = (container: HTMLElement) => parseSceneUrl(frameSrc(container))

function scaleBox(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.ng-frame')
}

/**
 * Stand in for a same-origin frame whose live state can be read.
 *
 * jsdom never loads the document, so it has no `contentWindow.location` to read. Where the
 * viewer is proxied the real thing does, and that is the difference between editing the user's
 * state and overwriting it.
 */
function frameShowing(container: HTMLElement, scene: unknown): void {
  const found = frame(container)!
  Object.defineProperty(found, 'contentWindow', {
    configurable: true,
    value: { location: { hash: `#!${encodeURIComponent(JSON.stringify(scene))}` } },
  })
}

/**
 * Stand in for the document arriving.
 *
 * jsdom never fetches an iframe, so it never fires `load` — and the component will not merge
 * into a frame it has not seen load, since there would be no state there to merge into.
 */
function frameLoaded(container: HTMLElement): void {
  const found = frame(container)
  if (found) fireEvent.load(found)
}

/**
 * Let a debounced merge through.
 *
 * Merges are deliberately not applied on the spot: auto-run turns one upstream edit into a
 * stream of scenes, and each applied would have neuroglancer rebuilding its layers several
 * times a second. Tests have to say when the burst is over, the same as a user pausing.
 */
function flushMerge(): void {
  act(() => {
    vi.advanceTimersByTime(1000)
  })
}

describe('mounting', () => {
  it('mounts in the node body, not only when expanded', () => {
    // The node *is* the viewer; needing to open it before anything appears would defeat it.
    const { container } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} compact />,
    )
    expect(frameScene(container)).toEqual(parseSceneUrl(URL_A))
  })

  it('mounts it full size, pointed at the URL the node built', () => {
    const { container } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    expect(frameScene(container)).toEqual(parseSceneUrl(URL_A))
  })

  it('merges a changed selection instead of replacing the scene', () => {
    // The defect this exists for: the full `#!` form makes neuroglancer reset() first, so
    // every upstream edit threw away the camera, the panel layout and the layer toggles.
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    const before = frame(container)
    expect(frameScene(container)).toEqual(parseSceneUrl(URL_A))
    frameLoaded(container)

    rerender(<NeuroglancerViewer url={URL_B} neurons={NEURONS} color={CATEGORICAL} />)
    flushMerge()

    // Same element, so the application is not reloaded and its meshes are not re-fetched.
    expect(frame(container)).toBe(before)
    const src = frame(container)?.getAttribute('src') ?? ''
    expect(src).toContain('#!+')

    const patch = parseSceneUrl(src)!
    // The new selection is applied...
    const segmentation = (patch['layers'] as Array<Record<string, unknown>>)[1]!
    expect(segmentation['segments']).toEqual(['1', '2'])
    // ...and the camera is not mentioned at all, so the live one survives the merge.
    expect(patch['position']).toBeUndefined()
    expect(patch['projectionScale']).toBeUndefined()
  })

  it('keeps every layer in the patch, since the merge replaces the whole list', () => {
    // A patch naming only the segmentation layer deletes the EM volume and every ROI mesh
    // beside it. The merge is per top-level key, not per layer.
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    frameLoaded(container)
    rerender(<NeuroglancerViewer url={URL_B} neurons={NEURONS} color={CATEGORICAL} />)
    flushMerge()

    const patch = parseSceneUrl(frame(container)?.getAttribute('src') ?? '')!
    expect((patch['layers'] as unknown[]).length).toBe(2)
    expect((patch['layers'] as Array<Record<string, unknown>>)[0]!['name']).toBe('em')
  })

  it('replaces the scene outright when it points somewhere else', () => {
    // Merging into a different dataset would keep a camera framed on the old volume, which
    // lands you in empty space beside the one you asked for.
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    frameLoaded(container)
    rerender(<NeuroglancerViewer url={URL_OTHER} neurons={NEURONS} color={CATEGORICAL} />)
    expect(frameSrc(container)).not.toContain('#!+')
    expect(frameScene(container)).toEqual(parseSceneUrl(URL_OTHER))
  })

  it('replaces rather than merges while the frame is still loading', () => {
    // Changing a selection during the second or two neuroglancer takes to boot would
    // otherwise land a patch as the opening navigation, merging onto its defaults — no
    // published camera, no framing, and nothing to say why.
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    rerender(<NeuroglancerViewer url={URL_B} neurons={NEURONS} color={CATEGORICAL} />)
    expect(frameSrc(container)).not.toContain('#!+')
    expect(frameScene(container)).toEqual(parseSceneUrl(URL_B))
  })

  it('collapses a burst of updates into one navigation, carrying the last', () => {
    /*
     * The shape of the reported failure: with auto-run on, editing anything upstream produces
     * a scene per keystroke, and applying each has neuroglancer tearing its layers down and
     * rebuilding them several times a second underneath whatever the user is doing with the
     * mouse. Only the last of a burst is worth anything.
     */
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    frameLoaded(container)

    for (const segments of [
      ['1', '2'],
      ['1', '2', '3'],
      ['1', '2', '3', '4'],
    ]) {
      rerender(
        <NeuroglancerViewer
          url={sceneUrl(undefined, sceneWith(segments))}
          neurons={NEURONS}
          color={CATEGORICAL}
        />,
      )
      act(() => {
        vi.advanceTimersByTime(80)
      })
      // Nothing sent yet — the burst is still running.
      expect(frameScene(container)).toEqual(parseSceneUrl(URL_A))
    }

    flushMerge()
    const patch = parseSceneUrl(frame(container)?.getAttribute('src') ?? '')!
    const segmentation = (patch['layers'] as Array<Record<string, unknown>>)[1]!
    expect(segmentation['segments']).toEqual(['1', '2', '3', '4'])
  })

  it('does not renavigate when nothing changed', () => {
    // Re-rendering for an unrelated reason must not re-point the frame — and under
    // StrictMode's double-invoked effects that would send a patch as the *first*
    // navigation, merging onto neuroglancer's defaults rather than the published scene.
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    rerender(<NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} compact />)
    expect(frameScene(container)).toEqual(parseSceneUrl(URL_A))
  })

  it('says what to do before the node has run', () => {
    const { container } = render(<NeuroglancerViewer url="" color={CATEGORICAL} />)
    expect(frame(container)).toBeNull()
    expect(screen.getByText(/Run the node/)).toBeTruthy()
  })
})

describe('updating a viewer the user has edited', () => {
  /** What the viewer holds after someone hid a layer, added one, and moved the camera. */
  const live = {
    position: [900, 900, 900],
    layout: '3d',
    layers: [
      { type: 'image', name: 'em', source: 'precomputed://gs://b/em', visible: false },
      { ...SEGMENTATION, segments: ['1'] },
      { type: 'segmentation', name: 'mine', source: 'precomputed://gs://b/rois' },
    ],
  }

  it('changes the selection and leaves their layers alone', () => {
    // The complaint this answers: every update used to restore *our* layer list, so layers the
    // user hid came back and layers they added disappeared.
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    frameLoaded(container)
    frameShowing(container, live)

    rerender(<NeuroglancerViewer url={URL_B} neurons={NEURONS} color={CATEGORICAL} />)
    flushMerge()

    const patch = parseSceneUrl(frame(container)?.getAttribute('src') ?? '')!
    const layers = patch['layers'] as Array<Record<string, unknown>>
    expect(layers.map((l) => l['name'])).toEqual(['em', 'hemibrain:v1.2.1', 'mine'])
    expect(layers[0]!['visible']).toBe(false)
    expect(layers[1]!['segments']).toEqual(['1', '2'])
  })

  it('sends the frame to the proxied path, and the link stays absolute', () => {
    // Reading the frame is only possible same-origin. The copyable link must not become a
    // path on our own host, though — it has to open anywhere.
    const { container } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    expect(frame(container)?.getAttribute('src')?.startsWith('/ng/#!')).toBe(true)
    expect(screen.getByLabelText('Open in a new tab').getAttribute('href')).toBe(URL_A)
  })

  it('falls back to merging when the frame cannot be read', () => {
    // No proxy for a viewer someone named themselves, so it stays cross-origin and this is
    // the best available — the embed still works, it just cannot preserve their layer edits.
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    frameLoaded(container)
    rerender(<NeuroglancerViewer url={URL_B} neurons={NEURONS} color={CATEGORICAL} />)
    flushMerge()

    const patch = parseSceneUrl(frame(container)?.getAttribute('src') ?? '')!
    const layers = patch['layers'] as Array<Record<string, unknown>>
    expect(layers.map((l) => l['name'])).toEqual(['em', 'hemibrain:v1.2.1'])
  })
})

describe('interface scale', () => {
  it('lays the document out larger and draws it smaller', () => {
    // Which is what shrinks neuroglancer's own toolbar and panels relative to the card — the
    // frame still fills it exactly, but the viewer believes it has more room.
    const { container } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} scale={0.75} />,
    )
    expect(scaleBox(container)?.style.getPropertyValue('--ng-scale')).toBe('0.75')
  })

  it('refuses a scale that would give the frame no size, or an infinite one', () => {
    // A stored file can carry anything, and the CSS divides the frame's size by this.
    for (const bad of [0, -1, Number.NaN]) {
      const { container, unmount } = render(
        <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} scale={bad} />,
      )
      expect(scaleBox(container)?.style.getPropertyValue('--ng-scale')).toBe('1')
      unmount()
    }
  })

  it('does not touch the scene, so restyling the frame cannot renavigate it', () => {
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} scale={1} />,
    )
    frameLoaded(container)
    rerender(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} scale={0.6} />,
    )
    expect(frameScene(container)).toEqual(parseSceneUrl(URL_A))
  })
})

describe('the caption', () => {
  it('distinguishes an unconnected port from an empty selection', () => {
    // "0 neurons" for an unwired port reads as a failed fetch rather than as a scene nobody
    // has asked anything of yet.
    const { rerender } = render(<NeuroglancerViewer url={URL_A} color={CATEGORICAL} />)
    expect(screen.getByText(/no neurons connected/)).toBeTruthy()

    const empty = tableFromRows(
      tableSchema(column('neuronId', 'i64'), column('type', 'str')),
      [],
      'neurons',
    )
    rerender(<NeuroglancerViewer url={URL_A} neurons={empty} color={CATEGORICAL} />)
    expect(screen.getByText(/0 neurons/)).toBeTruthy()
  })

  it('still shows the scene when only a dataset is wired', () => {
    const { container } = render(<NeuroglancerViewer url={URL_A} color={CATEGORICAL} />)
    expect(frameScene(container)).toEqual(parseSceneUrl(URL_A))
  })

  it('carries the legend, since the colours are inside an opaque frame', () => {
    // Nothing in the iframe can be read back, so the only account of what a colour means is
    // the one drawn beside it.
    render(<NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />)
    expect(screen.getByText('DNa02')).toBeTruthy()
    expect(screen.getByText('DNp01')).toBeTruthy()
    expect(screen.getByText(/type · 2 values/)).toBeTruthy()
  })

  it('offers the link on its own, for a browser that will not frame it', () => {
    render(<NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />)
    expect(screen.getByLabelText('Open in a new tab').getAttribute('href')).toBe(URL_A)
  })
})

/**
 * Reloading, which is the only way to clear a warning the viewer has already put up.
 *
 * FlyWire's fork banners a deprecated layer spec along the bottom of the frame and clears it
 * only on a document load — and a foreign-origin frame cannot be reloaded from outside:
 * `contentWindow.location.reload()` is blocked, and re-assigning the same `src` is a
 * *same-document* fragment navigation, which is the very property the merge depends on.
 * Remounting the element is what is left.
 */
describe('reloading the frame', () => {
  it('replaces the element and navigates it afresh', () => {
    const { container } = render(<NeuroglancerViewer url={URL_A} color={CATEGORICAL} />)
    const before = frame(container)
    frameLoaded(container)
    expect(before).not.toBeNull()

    act(() => {
      fireEvent.click(screen.getByLabelText('Reload the viewer'))
    })

    // A new element, or the browser has been asked to re-fetch nothing: assigning a src that
    // has not changed does not reload a document.
    expect(frame(container)).not.toBe(before)
    expect(frameScene(container)).toEqual(parseSceneUrl(URL_A))
  })

  it('sends the whole scene rather than a merge, since there is nothing left to merge into', () => {
    const { container } = render(<NeuroglancerViewer url={URL_A} color={CATEGORICAL} />)
    frameLoaded(container)
    frameShowing(container, sceneWith(['1']))

    act(() => {
      fireEvent.click(screen.getByLabelText('Reload the viewer'))
    })

    /*
     * The `#!+` form merges onto whatever the document currently holds. After a remount that is
     * neuroglancer's *defaults*, not the published scene — so a reload that patched would land
     * the selection on an empty viewer and lose the camera it was meant to restore.
     */
    expect(frameSrc(container)).toContain('#!%7B')
    expect(frameSrc(container)).not.toContain('#!+')
  })

  it('does not merge into the reloaded document before it has loaded', () => {
    /*
     * The guard `loadedRef` exists for, arrived at from the other side. After a remount the old
     * document is gone and the new one has not booted, so an upstream edit landing in that
     * window would send a patch as the frame's *opening* navigation — merging onto
     * neuroglancer's defaults instead of the published scene.
     *
     * Clearing `appliedRef` alone does not cover this: it is cleared, then set again by the
     * reload's own navigation, and the next edit is a merge from there.
     */
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} />,
    )
    frameLoaded(container)
    act(() => {
      fireEvent.click(screen.getByLabelText('Reload the viewer'))
    })

    // Deliberately no `frameLoaded` here: the new document is still on its way.
    rerender(<NeuroglancerViewer url={URL_B} color={CATEGORICAL} />)
    flushMerge()
    expect(frameSrc(container)).not.toContain('#!+')
    expect(frameScene(container)).toEqual(parseSceneUrl(URL_B))
  })

  it('merges again once the reloaded document has landed', () => {
    // The reload must not leave the frame permanently in replace mode: the next upstream edit
    // is an ordinary merge, which is what keeps the camera across a selection change.
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} />,
    )
    frameLoaded(container)
    act(() => {
      fireEvent.click(screen.getByLabelText('Reload the viewer'))
    })
    frameLoaded(container)

    rerender(<NeuroglancerViewer url={URL_B} color={CATEGORICAL} />)
    flushMerge()
    expect(frameSrc(container)).toContain('#!+')
  })
})
