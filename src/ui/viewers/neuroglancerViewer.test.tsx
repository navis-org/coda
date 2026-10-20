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

import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import { tableFromRows } from '../../core/values'
import type { NgScene } from '../../data/neuroglancer/scene'
import {
  layerSourceUrl,
  parseSceneUrl,
  sceneUrl,
  withLayerPanel,
} from '../../data/neuroglancer/scene'
import {
  FRAME_STATE_MESSAGE,
  FRAME_UPDATE_KEY,
  FRAME_VIEW_MESSAGE,
  updateIn,
} from '../../data/neuroglancer/frameMessage'
import { installJsdomStubs, installMoveBeforeStub } from '../../test/jsdomStubs'
import { NeuroglancerViewer } from './NeuroglancerViewer'
import { useGraphStore } from '../../store/graphStore'
import { RELEASE_AFTER_MS } from './persistentRoots'
import { resetSceneMemos } from './sceneMemo'

beforeAll(() => installJsdomStubs({ width: 800, height: 500 }))
beforeEach(() => {
  vi.useFakeTimers()
  // Module-level and session-scoped by design, so one test's frame would otherwise be resumed
  // by the next one's — see `sceneMemo`.
  resetSceneMemos()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllEnvs()
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

/**
 * What the node knows and the URL cannot carry: which dataset the scene was built for, and how
 * many layers came off the Extra layers socket. Without it the splice is skipped and updates fall
 * to the merge tier — see the prop's own note.
 */
const OWNED = 'hemibrain:v1.2.1'

function frame(container: HTMLElement): HTMLIFrameElement | null {
  return container.querySelector('iframe')
}

const frameSrc = (container: HTMLElement): string => frame(container)?.getAttribute('src') ?? ''
/**
 * The scene the frame is pointed at, whichever host and whichever form the URL took — less the
 * update number every navigation carries (`FRAME_UPDATE_KEY`), which no scene assertion is about.
 */
const frameScene = (container: HTMLElement) => {
  const scene = parseSceneUrl(frameSrc(container))
  if (!scene) return scene
  const { [FRAME_UPDATE_KEY]: _update, ...rest } = scene
  return rest
}
/** The update number the frame was last navigated with. */
const frameUpdate = (container: HTMLElement) => updateIn(parseSceneUrl(frameSrc(container)))
/** A scene as the frame is pointed at it by default: the layer bar hidden, which the link never is. */
const framed = (url: string) => withLayerPanel(parseSceneUrl(url)!, false)
/** The layer list of a scene, which nine assertions here read and none of them care is `unknown`. */
const layersOf = (scene: NgScene) => scene['layers'] as Array<Record<string, unknown>>

function scaleBox(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.ng-frame')
}

/**
 * Stand in for a same-origin frame whose live state can be read.
 *
 * jsdom never loads the document, so it has no `contentWindow.location` to read. Where the
 * viewer is proxied the real thing does, and that is the difference between editing the user's
 * state and overwriting it.
 *
 * A getter rather than a value, so it is honest about the one thing that decides whether the
 * state survives a remount: **a detached iframe has no browsing context**, so its
 * `contentWindow` is null. jsdom would happily keep answering from a removed element, which
 * would let the read on the way out pass here and return nothing in a browser — and a nothing
 * that looks exactly like the cross-origin degrade. This is why the registry destroys a frame —
 * which is when its state is read — before it removes the element.
 */
function frameShowing(container: HTMLElement, scene: unknown): void {
  const found = frame(container)!
  // One window object, as a browser keeps: a message's `source` is checked by identity.
  const win = {
    location: { hash: `#!${encodeURIComponent(JSON.stringify(scene))}` },
    postMessage: () => undefined,
  }
  Object.defineProperty(found, 'contentWindow', {
    configurable: true,
    get: () => (found.isConnected ? win : null),
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
    // The scene the node built, less the layer bar, which is off unless asked for.
    expect(frameScene(container)).toEqual({
      ...parseSceneUrl(URL_A),
      uiControlVisibility: { showLayerPanel: false },
    })
  })

  it('mounts it full size, pointed at the URL the node built', () => {
    const { container } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    expect(frameScene(container)).toEqual(framed(URL_A))
  })

  it('merges a changed selection instead of replacing the scene', () => {
    // The defect this exists for: the full `#!` form makes neuroglancer reset() first, so
    // every upstream edit threw away the camera, the panel layout and the layer toggles.
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    const before = frame(container)
    expect(frameScene(container)).toEqual(framed(URL_A))
    frameLoaded(container)

    rerender(<NeuroglancerViewer url={URL_B} neurons={NEURONS} color={CATEGORICAL} />)
    flushMerge()

    // Same element, so the application is not reloaded and its meshes are not re-fetched.
    expect(frame(container)).toBe(before)
    const src = frame(container)?.getAttribute('src') ?? ''
    expect(src).toContain('#!+')

    const patch = parseSceneUrl(src)!
    // The new selection is applied...
    const segmentation = layersOf(patch)[1]!
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
    expect(layersOf(patch)[0]!['name']).toBe('em')
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
    expect(frameScene(container)).toEqual(framed(URL_OTHER))
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
    expect(frameScene(container)).toEqual(framed(URL_B))
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
      expect(frameScene(container)).toEqual(framed(URL_A))
    }

    flushMerge()
    const patch = parseSceneUrl(frame(container)?.getAttribute('src') ?? '')!
    const segmentation = layersOf(patch)[1]!
    expect(segmentation['segments']).toEqual(['1', '2', '3', '4'])
  })

  it('does not renavigate when nothing changed', () => {
    // Re-rendering for an unrelated reason must not re-point the frame — and under
    // StrictMode's double-invoked effects that would send a patch as the *first*
    // navigation, merging onto neuroglancer's defaults rather than the published scene.
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    rerender(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} summary="x" />,
    )
    expect(frameScene(container)).toEqual(framed(URL_A))
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
      <NeuroglancerViewer
        url={URL_A}
        neurons={NEURONS}
        color={CATEGORICAL}
        datasetId={OWNED}
      />,
    )
    frameLoaded(container)
    frameShowing(container, live)

    rerender(
      <NeuroglancerViewer
        url={URL_B}
        neurons={NEURONS}
        color={CATEGORICAL}
        datasetId={OWNED}
      />,
    )
    flushMerge()

    const patch = parseSceneUrl(frame(container)?.getAttribute('src') ?? '')!
    const layers = layersOf(patch)
    expect(layers.map((l) => l['name'])).toEqual(['em', 'hemibrain:v1.2.1', 'mine'])
    expect(layers[0]!['visible']).toBe(false)
    expect(layers[1]!['segments']).toEqual(['1', '2'])
  })

  it('merges rather than splicing when nothing said which layers are ours', () => {
    // The honest degrade. Splicing writes into somebody's live state, and doing it to the wrong
    // layer is worse than sending our own list — a published scene ships preset selections on
    // layers that are not ours, so this is not guessable from the scene.
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    frameLoaded(container)
    frameShowing(container, live)

    rerender(<NeuroglancerViewer url={URL_B} neurons={NEURONS} color={CATEGORICAL} />)
    flushMerge()

    const patch = parseSceneUrl(frame(container)?.getAttribute('src') ?? '')!
    // Our list, not theirs: `mine` is gone, which is the merge tier's documented cost.
    expect(layersOf(patch).map((l) => l['name'])).toEqual(['em', 'hemibrain:v1.2.1'])
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
    const layers = layersOf(patch)
    expect(layers.map((l) => l['name'])).toEqual(['em', 'hemibrain:v1.2.1'])
  })
})

describe('where the proxy is actually served', () => {
  // Every test in here is about the deployed build; a third one added without this would
  // silently run with the proxy on and pass for the wrong reason.
  beforeEach(() => vi.stubEnv('DEV', false))

  /*
   * `proxiedViewer` answers which origins have a prefix *declared*; this asks whether anything
   * is serving it, and they are not the same question. The `/ng` rule is in `vite.config.ts`,
   * so it exists under `pnpm dev` and nowhere else — and because `/ng` is an absolute path, a
   * build that takes it anyway does not fall back to the public viewer, it points the frame at
   * a 404 on its own origin. Measured against the published site, where `/ng/` and `/coda/ng/`
   * both answer 404: the deployed card showed a blank panel for every dataset that does not
   * name a viewer of its own.
   */
  it('points the frame at the public viewer when no dev server is behind it', () => {
    const { container } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    expect(frameSrc(container).startsWith('https://neuroglancer-demo.appspot.com/#!')).toBe(
      true,
    )
    // Still the same scene — this is about *which host*, not about what is shown.
    expect(frameScene(container)).toEqual(framed(URL_A))
  })

  it('still merges there, since only the splice needed same-origin', () => {
    // The documented degrade, and the thing that has to keep working without the proxy: no
    // reading the live state, so no preserving their layer edits — but the camera still
    // survives, because that is the merge form rather than the splice.
    const { container, rerender } = render(
      <NeuroglancerViewer
        url={URL_A}
        neurons={NEURONS}
        color={CATEGORICAL}
        datasetId={OWNED}
      />,
    )
    frameLoaded(container)
    rerender(
      <NeuroglancerViewer
        url={URL_B}
        neurons={NEURONS}
        color={CATEGORICAL}
        datasetId={OWNED}
      />,
    )
    flushMerge()

    const src = frameSrc(container)
    expect(src.startsWith('https://neuroglancer-demo.appspot.com/#!+')).toBe(true)
    expect(parseSceneUrl(src)!['position']).toBeUndefined()
  })
})

describe('holding an update back while the pointer is in the frame', () => {
  /*
   * The reported crash, and it is neuroglancer's rather than ours: restoring `layers` tears
   * down and rebuilds every layer in two steps — constructed, then initialised — and a layer
   * subscribes to the hover machinery in the first step while `selectionState` is only assigned
   * in the second. `LayerSelectedValues.handleLayerChange` asks it anyway whenever
   * `mouseState.active`, which is true exactly when the pointer is over a render panel, and the
   * read is `undefined.generation`.
   *
   * It cannot be recovered from either: the subscription is never disposed, so the half-built
   * layer keeps answering for the life of the document and every later mouse movement throws
   * the same error. Hence a hold rather than a retry.
   */
  const enter = (container: HTMLElement) => fireEvent.mouseEnter(scaleBox(container)!)
  const leave = (container: HTMLElement) => fireEvent.mouseLeave(scaleBox(container)!)
  /** The state every hold starts from: a loaded frame with the pointer inside it. */
  const hovered = () => {
    const view = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    frameLoaded(view.container)
    enter(view.container)
    return view
  }

  it('sends nothing while the pointer is inside, and sends it when they leave', () => {
    const { container, rerender } = hovered()

    rerender(<NeuroglancerViewer url={URL_B} neurons={NEURONS} color={CATEGORICAL} />)
    flushMerge()
    // Still the opening scene: the patch is waiting, not lost.
    expect(frameScene(container)).toEqual(framed(URL_A))

    leave(container)
    flushMerge()
    const patch = parseSceneUrl(frameSrc(container))!
    expect(layersOf(patch)[1]!['segments']).toEqual(['1', '2'])
  })

  it('carries only the last of a burst that arrived during the hold', () => {
    // The hold and the debounce answer different halves of the same problem, so the one must
    // not undo the other: a run finishing while somebody reads the scene should cost one
    // rebuild when they look away, not one per scene that arrived meanwhile.
    const { container, rerender } = hovered()

    for (const segments of [
      ['1', '2'],
      ['1', '2', '3'],
    ]) {
      rerender(
        <NeuroglancerViewer
          url={sceneUrl(undefined, sceneWith(segments))}
          neurons={NEURONS}
          color={CATEGORICAL}
        />,
      )
      flushMerge()
    }
    expect(frameScene(container)).toEqual(framed(URL_A))

    leave(container)
    flushMerge()
    const patch = parseSceneUrl(frameSrc(container))!
    expect(layersOf(patch)[1]!['segments']).toEqual(['1', '2', '3'])
  })

  it('holds a replacement too, since that rebuilds the layers as well', () => {
    // A full navigation is not exempt: `#!` resets and restores, which is the same teardown
    // through the same code. It also loses its immediacy here on purpose — the pointer has just
    // crossed out and the frame's own `mouseleave` is what clears `mouseState.active`, so going
    // through the timer keeps our write behind it rather than racing it across two documents.
    const { container, rerender } = hovered()

    rerender(<NeuroglancerViewer url={URL_OTHER} neurons={NEURONS} color={CATEGORICAL} />)
    expect(frameScene(container)).toEqual(framed(URL_A))

    leave(container)
    expect(frameScene(container)).toEqual(framed(URL_A))
    flushMerge()
    expect(frameScene(container)).toEqual(framed(URL_OTHER))
  })

  it('does not hold the opening navigation', () => {
    // An empty frame has no layers to tear down and no mouse state to ask, so a card that
    // mounts under the cursor still fills in rather than waiting for somebody to look away.
    const { container } = render(
      <NeuroglancerViewer url={URL_A} neurons={NEURONS} color={CATEGORICAL} />,
    )
    enter(container)
    expect(frameScene(container)).toEqual(framed(URL_A))
  })
})

describe('handing the live frame to the next surface', () => {
  /*
   * Where the browser can move an element without reloading it, the card and the overlay share one
   * frame: the application never stops, so there is nothing to resume. jsdom has no `moveBefore`,
   * so it is stood in for by an `insertBefore`, which keeps the element — what is checked is that
   * the next instance adopts the frame rather than building and navigating one of its own.
   */
  let stub: ReturnType<typeof installMoveBeforeStub>
  beforeEach(() => {
    stub = installMoveBeforeStub()
  })

  afterEach(() => {
    cleanup()
    // Release what the last test parked, so no kept frame outlives its test.
    vi.advanceTimersByTime(RELEASE_AFTER_MS + 1)
    stub.restore()
  })

  /** A mount that loaded and went away — the card handing the node to the overlay. */
  function handOff(viewerId: string) {
    const view = render(
      <NeuroglancerViewer
        url={URL_A}
        color={CATEGORICAL}
        datasetId={OWNED}
        viewerId={viewerId}
      />,
    )
    frameLoaded(view.container)
    const element = frame(view.container)!
    const src = element.getAttribute('src')
    view.unmount()
    return { element, src }
  }

  it('shows the same frame, still pointed where it was, and navigates nothing', () => {
    const { element, src } = handOff('kept-a')
    const { container } = render(
      <NeuroglancerViewer
        url={URL_A}
        color={CATEGORICAL}
        datasetId={OWNED}
        viewerId="kept-a"
      />,
    )
    expect(frame(container)).toBe(element)
    expect(frameSrc(container)).toBe(src)
  })

  it('merges the next selection into the frame it adopted, since a document is already there', () => {
    handOff('kept-b')
    const props = { color: CATEGORICAL, datasetId: OWNED, viewerId: 'kept-b' }
    const { container, rerender } = render(<NeuroglancerViewer url={URL_A} {...props} />)
    rerender(<NeuroglancerViewer url={URL_B} {...props} />)
    flushMerge()
    expect(frameSrc(container)).toContain('#!+')
  })

  it('flips the layer bar on the frame it adopted, and sends nothing else', () => {
    // The card and the overlay share this one frame, and the setting can change while it is
    // loaded. A patch naming `layers` would rebuild every layer for a change that touches none.
    const card = render(
      <NeuroglancerViewer
        url={URL_A}
        color={CATEGORICAL}
        datasetId={OWNED}
        viewerId="kept-bar"
        compact
      />,
    )
    frameLoaded(card.container)
    expect(frameScene(card.container)!['uiControlVisibility']).toEqual({
      showLayerPanel: false,
    })
    card.unmount()

    const props = { url: URL_A, color: CATEGORICAL, datasetId: OWNED, viewerId: 'kept-bar' }
    const { container, rerender } = render(<NeuroglancerViewer {...props} />)
    // Moving to the overlay alone sends nothing: the bar is hidden there too.
    expect(frameScene(container)).toEqual(framed(URL_A))

    rerender(<NeuroglancerViewer {...props} layerBar />)
    expect(frameSrc(container)).toContain('#!+')
    expect(frameScene(container)).toEqual({ uiControlVisibility: { showLayerPanel: true } })

    // And back.
    rerender(<NeuroglancerViewer {...props} />)
    expect(frameScene(container)).toEqual({ uiControlVisibility: { showLayerPanel: false } })
  })

  it('builds a new frame on Reload, which is how somebody leaves one that has gone wrong', () => {
    const { element } = handOff('kept-c')
    const { container } = render(
      <NeuroglancerViewer
        url={URL_A}
        color={CATEGORICAL}
        datasetId={OWNED}
        viewerId="kept-c"
      />,
    )
    act(() => {
      fireEvent.click(screen.getByLabelText('Reload the viewer'))
    })
    expect(frame(container)).not.toBe(element)
    expect(frameScene(container)).toEqual(framed(URL_A))
  })

  it('keeps nothing without a viewerId, which the profile tile does not pass', () => {
    const first = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} datasetId={OWNED} />,
    )
    const element = frame(first.container)
    first.unmount()
    const { container } = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} datasetId={OWNED} />,
    )
    expect(frame(container)).not.toBe(element)
  })
})

describe('where moving a frame would reload it', () => {
  it('builds a frame per mount and leaves the resume to sceneMemo', () => {
    // No `moveBefore`: kept and moved the ordinary way, the frame would reload onto whatever `src`
    // it was last given while still claiming to show the scene it had applied.
    const first = render(
      <NeuroglancerViewer
        url={URL_A}
        color={CATEGORICAL}
        datasetId={OWNED}
        viewerId="unkept"
      />,
    )
    const element = frame(first.container)
    first.unmount()
    const { container } = render(
      <NeuroglancerViewer
        url={URL_A}
        color={CATEGORICAL}
        datasetId={OWNED}
        viewerId="unkept"
      />,
    )
    expect(frame(container)).not.toBe(element)
  })
})

describe('resuming across a remount', () => {
  /*
   * The complaint this answers: expanding a Neuroglancer card reset the view, and closing the
   * expansion reset it again. Nothing in the merge path helps, because the component itself goes
   * away — the card stands down while the overlay owns the node, and each is a mount of its own.
   * So the live state is read on the way out and the next mount navigates to *that*.
   */

  /** What the viewer holds after someone moved the camera, hid a layer and added one. */
  const live = {
    position: [900, 900, 900],
    layout: '3d',
    layers: [
      { type: 'image', name: 'em', source: 'precomputed://gs://b/em', visible: false },
      { ...SEGMENTATION, segments: ['1'] },
      { type: 'segmentation', name: 'mine', source: 'precomputed://gs://b/rois' },
    ],
  }

  /** A mount that loaded, was read, and went away — the card handing the node to the overlay. */
  function handOff(url = URL_A, viewerId = 'ng1'): void {
    const first = render(
      <NeuroglancerViewer
        url={url}
        color={CATEGORICAL}
        datasetId={OWNED}
        viewerId={viewerId}
      />,
    )
    frameLoaded(first.container)
    frameShowing(first.container, live)
    first.unmount()
  }

  it('opens where the last instance was left, not at the published camera', () => {
    handOff()
    const { container } = render(
      <NeuroglancerViewer url={URL_B} color={CATEGORICAL} datasetId={OWNED} viewerId="ng1" />,
    )

    const scene = frameScene(container)!
    // The camera, and the layer edits with it.
    expect(scene['position']).toEqual([900, 900, 900])
    const layers = layersOf(scene)
    expect(layers.map((l) => l['name'])).toEqual(['em', 'hemibrain:v1.2.1', 'mine'])
    expect(layers[0]!['visible']).toBe(false)
    // And the selection the node is emitting *now*, spliced into it.
    expect(layers[1]!['segments']).toEqual(['1', '2'])
  })

  it('shows the bar the card hid when asked to, though the state it resumes hid it', () => {
    const first = render(
      <NeuroglancerViewer
        url={URL_A}
        color={CATEGORICAL}
        datasetId={OWNED}
        viewerId="bar"
        compact
      />,
    )
    frameLoaded(first.container)
    frameShowing(first.container, { ...live, uiControlVisibility: { showLayerPanel: false } })
    first.unmount()

    const { container } = render(
      <NeuroglancerViewer
        url={URL_A}
        color={CATEGORICAL}
        datasetId={OWNED}
        viewerId="bar"
        layerBar
      />,
    )
    const scene = frameScene(container)!
    expect(scene['position']).toEqual([900, 900, 900])
    expect(scene['uiControlVisibility']).toBeUndefined()
  })

  it('sends the resumed state as a full navigation, not as a merge', () => {
    // There is nothing to merge into: the frame is new and holds no document. The whole point
    // of resuming through the *state* rather than the URL form is that one navigation carries
    // everything, which the `#!+` form could not do here.
    handOff()
    const { container } = render(
      <NeuroglancerViewer url={URL_B} color={CATEGORICAL} datasetId={OWNED} viewerId="ng1" />,
    )
    expect(frameSrc(container).includes('#!+')).toBe(false)
  })

  it('remembers nothing for a frame with no viewerId', () => {
    // A frame with no identity of its own — the profile tile — has nothing to be handed to.
    const first = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} datasetId={OWNED} />,
    )
    frameLoaded(first.container)
    frameShowing(first.container, live)
    first.unmount()

    const { container } = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} datasetId={OWNED} />,
    )
    expect(frameScene(container)).toEqual(framed(URL_A))
  })

  it('refuses to resume into a different scene', () => {
    // Another dataset, so the remembered camera is framed on a volume that is no longer there —
    // the same gate a merge goes through, and for the same reason.
    handOff()
    const { container } = render(
      <NeuroglancerViewer
        url={URL_OTHER}
        color={CATEGORICAL}
        datasetId={OWNED}
        viewerId="ng1"
      />,
    )
    expect(frameScene(container)).toEqual(framed(URL_OTHER))
  })

  it('keeps each viewer to itself', () => {
    handOff()
    const { container } = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} datasetId={OWNED} viewerId="ng2" />,
    )
    expect(frameScene(container)).toEqual(framed(URL_A))
  })

  it('remembers nothing it could not read', () => {
    // Cross-origin, so there was never a state to store. The embed behaves as it did.
    const first = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} datasetId={OWNED} viewerId="ng1" />,
    )
    frameLoaded(first.container)
    first.unmount()

    const { container } = render(
      <NeuroglancerViewer url={URL_B} color={CATEGORICAL} datasetId={OWNED} viewerId="ng1" />,
    )
    expect(frameScene(container)).toEqual(framed(URL_B))
  })

  it('remembers nothing before the frame has loaded', () => {
    // Whatever `location.hash` reads as then belongs to no scene this component has applied.
    const first = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} datasetId={OWNED} viewerId="ng1" />,
    )
    frameShowing(first.container, live)
    first.unmount()

    const { container } = render(
      <NeuroglancerViewer url={URL_B} color={CATEGORICAL} datasetId={OWNED} viewerId="ng1" />,
    )
    expect(frameScene(container)).toEqual(framed(URL_B))
  })

  it('falls back to the published scene when the layers no longer line up', () => {
    // The splice bails — the user deleted one of our layers — and there is no merge tier to fall
    // to on a fresh frame. Replaying their state with the wrong selection in it would be worse.
    const first = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} datasetId={OWNED} viewerId="ng1" />,
    )
    frameLoaded(first.container)
    frameShowing(first.container, { ...live, layers: [live.layers[0], live.layers[2]] })
    first.unmount()

    const { container } = render(
      <NeuroglancerViewer url={URL_B} color={CATEGORICAL} datasetId={OWNED} viewerId="ng1" />,
    )
    expect(frameScene(container)).toEqual(framed(URL_B))
  })

  it('drops the remembered state when the viewer is reloaded', () => {
    // Reload is how somebody gets out of a frame that has gone wrong. Resuming into the state it
    // went wrong in is the one thing that button must not do — neither in the frame it opens nor
    // in the next instance to mount.
    handOff()
    const second = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} datasetId={OWNED} viewerId="ng1" />,
    )
    act(() => {
      fireEvent.click(screen.getByLabelText('Reload the viewer'))
    })
    expect(frameScene(second.container)).toEqual(framed(URL_A))
    // The remounted frame holds no document, so the way out leaves nothing behind either.
    second.unmount()

    const { container } = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} datasetId={OWNED} viewerId="ng1" />,
    )
    expect(frameScene(container)).toEqual(framed(URL_A))
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
    expect(frameScene(container)).toEqual(framed(URL_A))
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

  it('says what a caller hands it, for segments that travel in the scene', () => {
    // The profile's 3D tile puts its neurons in the URL and wires no table, so a count of
    // `neurons` would claim nothing is connected under a neuron that is drawn.
    render(<NeuroglancerViewer url={URL_A} color={CATEGORICAL} summary="2 neurons" />)
    expect(screen.getByText('2 neurons')).toBeTruthy()
    expect(screen.queryByText(/no neurons connected/)).toBeNull()
  })

  it('still shows the scene when only a dataset is wired', () => {
    const { container } = render(<NeuroglancerViewer url={URL_A} color={CATEGORICAL} />)
    expect(frameScene(container)).toEqual(framed(URL_A))
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

describe('hiding the layer bar', () => {
  it('hides it in the frame and leaves it on in the link', () => {
    // The embed is too small to spare the strip; a tab of its own is not, so ↗ and ⧉ hand out
    // the scene exactly as built.
    const { container } = render(<NeuroglancerViewer url={URL_A} color={CATEGORICAL} compact />)
    expect(frameScene(container)!['uiControlVisibility']).toEqual({ showLayerPanel: false })
    expect(screen.getByLabelText('Open in a new tab').getAttribute('href')).toBe(URL_A)
  })

  it('hides it on the expanded surface too', () => {
    const { container } = render(<NeuroglancerViewer url={URL_A} color={CATEGORICAL} />)
    expect(frameScene(container)!['uiControlVisibility']).toEqual({ showLayerPanel: false })
  })

  it('leaves the scene untouched when the bar is asked for', () => {
    const { container } = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} layerBar />,
    )
    expect(frameScene(container)!['uiControlVisibility']).toBeUndefined()
  })

  it('sends a change of setting along with a selection that changed in the same pass', () => {
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} datasetId={OWNED} />,
    )
    frameLoaded(container)
    rerender(<NeuroglancerViewer url={URL_B} color={CATEGORICAL} datasetId={OWNED} layerBar />)
    flushMerge()
    const patch = frameScene(container)!
    expect(frameSrc(container)).toContain('#!+')
    expect(patch['uiControlVisibility']).toEqual({ showLayerPanel: true })
    expect(layersOf(patch)[1]!['segments']).toEqual(['1', '2'])
  })

  it('does not hide it again in a merge, once somebody has brought it back', () => {
    const { container, rerender } = render(
      <NeuroglancerViewer url={URL_A} color={CATEGORICAL} datasetId={OWNED} compact />,
    )
    frameLoaded(container)
    // The reader switched the bar back on inside the viewer.
    frameShowing(container, { ...sceneWith(['1']), uiControlVisibility: {} })

    rerender(<NeuroglancerViewer url={URL_B} color={CATEGORICAL} datasetId={OWNED} compact />)
    flushMerge()

    expect(frameSrc(container)).toContain('#!+')
    expect(frameScene(container)!['uiControlVisibility']).toBeUndefined()
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
    expect(frameScene(container)).toEqual(framed(URL_A))
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
    expect(frameScene(container)).toEqual(framed(URL_B))
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

/**
 * An explicit `Viewer type` has to reach the *frame*, not only the copied link.
 *
 * It cannot travel in the URL: `sceneForViewer` normalises, so a viewer re-deriving the kind
 * from the host would strip an override back out — on exactly the deployment `SEUNGLAB_HOSTS`
 * gets wrong, which is the only reason the control exists. And this card is where the symptom
 * is seen, since a segmentation layer that is present and empty looks like a broken viewer.
 */
describe('an explicit viewer type', () => {
  const GRAPHENE = 'graphene://https://prodv1.flywire-daf.com/segmentation/table/fly_v31'
  const CAVE_SCENE = {
    layers: [
      { type: 'segmentation', name: 'hemibrain:v1.2.1', source: GRAPHENE, segments: ['1'] },
    ],
  }
  const sourceIn = (container: HTMLElement): string => {
    const scene = frameScene(container) as { layers: Array<{ source?: unknown }> } | undefined
    return String(layerSourceUrl(scene?.layers[0]?.source))
  }

  it('is honoured rather than re-derived from the host', () => {
    // `neuroglancer-demo.appspot.com` is spelunker in the table, so the default would prefix.
    const url = sceneUrl(undefined, CAVE_SCENE, 'spelunker')
    const { container } = render(
      <NeuroglancerViewer url={url} color={CATEGORICAL} viewerType="seunglab" />,
    )
    expect(sourceIn(container)).toBe(GRAPHENE)
  })

  it('falls back to the deployment when nobody said', () => {
    const url = sceneUrl(undefined, CAVE_SCENE)
    const { container } = render(<NeuroglancerViewer url={url} color={CATEGORICAL} />)
    expect(sourceIn(container)).toContain('middleauth+')
  })

  it('re-navigates when the choice changes', () => {
    // It is in the effect's dependency list, or flipping the control leaves the frame showing
    // the scene built for the other flavour until something else happens to change the URL.
    const url = sceneUrl(undefined, CAVE_SCENE, 'spelunker')
    const { container, rerender } = render(
      <NeuroglancerViewer url={url} color={CATEGORICAL} viewerType="spelunker" />,
    )
    expect(sourceIn(container)).toContain('middleauth+')
    rerender(<NeuroglancerViewer url={url} color={CATEGORICAL} viewerType="seunglab" />)
    expect(sourceIn(container)).toBe(GRAPHENE)
  })
})

describe('neurons changed inside the viewer', () => {
  /** What Coda's own frame posts, from its own window, at this origin. */
  /** A message as if from `source` (by default the card's own frame), at this origin. */
  function post(container: HTMLElement, data: unknown, source?: unknown): void {
    const event = new MessageEvent('message', { data, origin: window.location.origin })
    // jsdom refuses a non-window `source` in the init dict; the listener only compares identity.
    Object.defineProperty(event, 'source', { value: source ?? frame(container)!.contentWindow })
    act(() => {
      window.dispatchEvent(event)
    })
  }

  function report(
    container: HTMLElement,
    scene: unknown,
    source?: unknown,
    update = frameUpdate(container),
  ): void {
    post(container, { type: FRAME_STATE_MESSAGE, state: scene, update }, source)
  }

  const viewer = (
    url: string,
    selectionEdits: string[],
    onSelectionEdits: (next: string[]) => void,
    extra: Partial<ComponentProps<typeof NeuroglancerViewer>> = {},
  ) => (
    <NeuroglancerViewer
      url={url}
      neurons={NEURONS}
      color={CATEGORICAL}
      datasetId={OWNED}
      selectionEdits={selectionEdits}
      onSelectionEdits={onSelectionEdits}
      {...extra}
    />
  )

  function mounted(url: string, selectionEdits: string[] = []) {
    const onSelectionEdits = vi.fn<(next: string[]) => void>()
    const view = render(viewer(url, selectionEdits, onSelectionEdits))
    frameLoaded(view.container)
    return { ...view, onSelectionEdits }
  }

  it('writes a neuron double-clicked into the scene back as an edit', () => {
    const { container, onSelectionEdits } = mounted(URL_A)
    frameShowing(container, sceneWith(['1']))
    report(container, sceneWith(['1', '5']))
    expect(onSelectionEdits).toHaveBeenCalledWith(['+5'])
  })

  it('writes a neuron taken out of the scene, on top of the edits already held', () => {
    const { container, onSelectionEdits } = mounted(URL_B, ['+7'])
    frameShowing(container, sceneWith(['1', '2']))
    report(container, sceneWith(['2']))
    expect(onSelectionEdits).toHaveBeenCalledWith(['+7', '-1'])
  })

  it('writes nothing for a report of the scene it was sent', () => {
    // The frame posts after every navigation; that is not somebody's edit.
    const { container, onSelectionEdits } = mounted(URL_B)
    frameShowing(container, sceneWith(['1', '2']))
    report(container, sceneWith(['2', '1']))
    expect(onSelectionEdits).not.toHaveBeenCalled()
  })

  it('drops a report of an update the card has since replaced', () => {
    // The frame's settle timer fired before it took the card's latest update: the report shows the
    // old scene, and read against the new one every neuron the update added would be a removal.
    const view = mounted(URL_A)
    const posted = speakingFrame(view.container, sceneWith(['1']))
    rerendered(view, URL_B)
    expect(posted).toHaveBeenCalled()
    report(view.container, sceneWith(['1']), undefined, 1)
    expect(view.onSelectionEdits).not.toHaveBeenCalled()
    // A report of the update it was sent is read as before.
    report(view.container, sceneWith(['1', '2', '5']), undefined, 2)
    expect(view.onSelectionEdits).toHaveBeenCalledWith(['+5'])
  })

  it('opens the frame at Coda’s own copy, while the link stays the one the node built', () => {
    const own = 'https://coda.example.org/neuroglancer.html'
    const { container } = render(
      <NeuroglancerViewer
        url={URL_A}
        neurons={NEURONS}
        color={CATEGORICAL}
        frameViewer={own}
      />,
    )
    expect(frameSrc(container).startsWith(`${own}#!`)).toBe(true)
    expect(screen.getByRole('link', { name: 'Open in a new tab' }).getAttribute('href')).toBe(
      URL_A,
    )
  })

  it('reads a hidden neuron as removed by default, and as hidden where it stays selected', () => {
    const plain = mounted(URL_B)
    frameShowing(plain.container, sceneWith(['1', '2']))
    report(plain.container, sceneWith(['1', '!2']))
    expect(plain.onSelectionEdits).toHaveBeenCalledWith(['-2'])
    cleanup()

    const onSelectionEdits = vi.fn<(next: string[]) => void>()
    const kept = render(
      <NeuroglancerViewer
        url={URL_B}
        neurons={NEURONS}
        color={CATEGORICAL}
        datasetId={OWNED}
        selectionEdits={[]}
        onSelectionEdits={onSelectionEdits}
        keepHidden
      />,
    )
    frameLoaded(kept.container)
    frameShowing(kept.container, sceneWith(['1', '2']))
    report(kept.container, sceneWith(['1', '!2']))
    expect(onSelectionEdits).toHaveBeenCalledWith(['~2'])
  })

  describe('the saved view', () => {
    const VIEW = { position: [5, 6, 7], projectionScale: 1234, layout: 'xy-3d' }
    const saved = (dataset: string) => JSON.stringify({ dataset, view: VIEW })

    const viewReport = (
      container: HTMLElement,
      view: unknown,
      update = frameUpdate(container),
    ) => post(container, { type: FRAME_VIEW_MESSAGE, view, update })

    function withView(url: string, savedView: string) {
      const onSavedView = vi.fn<(text: string) => void>()
      const view = render(viewer(url, [], vi.fn(), { savedView, onSavedView }))
      return { ...view, onSavedView }
    }

    it('opens where the workflow was saved looking', () => {
      const { container } = withView(URL_A, saved(OWNED))
      const scene = frameScene(container)!
      expect(scene['position']).toEqual([5, 6, 7])
      expect(scene['projectionScale']).toBe(1234)
      expect(scene['layout']).toBe('xy-3d')
    })

    it('saves where the frame is looking, with the dataset it was taken in', () => {
      const { container, onSavedView } = withView(URL_A, '')
      frameLoaded(container)
      frameShowing(container, sceneWith(['1']))
      // Every view the frame reports is somebody moving the camera: the frame keeps the opening
      // view to itself, so a card nobody has touched receives none (probed in the browser).
      viewReport(container, VIEW)
      expect(onSavedView).toHaveBeenCalledWith(saved(OWNED))
      // A report from before the latest update is the old framing, and is not saved.
      onSavedView.mockClear()
      viewReport(container, { position: [0, 0, 0] }, 0)
      expect(onSavedView).not.toHaveBeenCalled()
    })

    it('clears a view taken in another dataset, and opens as published', () => {
      const { container, onSavedView } = withView(URL_A, saved('manc:v1.2.3'))
      expect(frameScene(container)!['position']).toEqual([1, 2, 3])
      expect(onSavedView).toHaveBeenCalledWith('')
    })

    it('is not applied by a later full navigation, which means the published framing', () => {
      const { container, rerender, onSavedView } = withView(URL_A, saved(OWNED))
      frameLoaded(container)
      rerender(viewer(URL_OTHER, [], vi.fn(), { savedView: saved(OWNED), onSavedView }))
      flushMerge()
      expect(frameScene(container)!['position']).toEqual([900, 900, 900])
    })
  })

  it('reads a FlyWire link’s neuron layer back, though the link names it for the Seung-lab fork', () => {
    // The link is written for the datastack's own viewer (`segmentation_with_graph`); the frame is
    // Coda's own, mainline, and reports a plain `segmentation` layer of the same name.
    const layers = (segments: string[], type: string) => [
      { type: 'image', name: 'em', source: 'precomputed://gs://b/em' },
      { type, name: 'flywire_fafb', source: 'graphene://https://x/seg', segments },
    ]
    const link = sceneUrl('https://ngl.flywire.ai', { layers: layers(['1'], 'segmentation') })
    expect(JSON.stringify(parseSceneUrl(link))).toContain('segmentation_with_graph')
    const onSelectionEdits = vi.fn<(next: string[]) => void>()
    const view = render(
      <NeuroglancerViewer
        url={link}
        neurons={NEURONS}
        color={CATEGORICAL}
        datasetId="flywire_fafb:783"
        onSelectionEdits={onSelectionEdits}
        frameViewer="https://coda.example.org/neuroglancer.html"
      />,
    )
    frameLoaded(view.container)
    frameShowing(view.container, { layers: layers(['1', '5'], 'segmentation') })
    report(view.container, { layers: layers(['1', '5'], 'segmentation') })
    expect(onSelectionEdits).toHaveBeenCalledWith(['+5'])
  })

  it('navigates instead when the frame could not set a selection in place', () => {
    const view = mounted(URL_A)
    const posted = speakingFrame(view.container, sceneWith(['1']))
    const before = frameSrc(view.container)
    rerendered(view, URL_B)
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'coda:ng-set-segments' }),
      window.location.origin,
    )
    // The frame says it could not — somebody renamed the layer — so the card navigates.
    post(view.container, {
      type: 'coda:ng-unapplied',
      update: frameUpdate(view.container)! + 1,
    })
    flushMerge()
    expect(frameSrc(view.container)).not.toBe(before)
    expect(layersOf(frameScene(view.container)!)[1]!['segments']).toEqual(['1', '2'])
  })

  it('forgets what it knew about a frame once it navigates to another deployment', () => {
    const view = mounted(URL_A)
    const posted = speakingFrame(view.container, sceneWith(['1']))
    // Re-pointed at a custom deployment: a new document, which has not reported.
    view.rerender(
      viewer(URL_A, [], view.onSelectionEdits, { frameViewer: 'https://custom.example.org' }),
    )
    flushMerge()
    expect(frameSrc(view.container).startsWith('https://custom.example.org/#!')).toBe(true)
    posted.mockClear()
    view.rerender(
      viewer(URL_B, [], view.onSelectionEdits, { frameViewer: 'https://custom.example.org' }),
    )
    flushMerge()
    // Not set in place: nothing there has said it can take one.
    expect(posted).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'coda:ng-set-segments' }),
      expect.anything(),
    )
  })

  describe('the dashboard’s tab keys', () => {
    afterEach(() => useGraphStore.setState({ dashboardOpen: false }))

    it('tells Coda’s own frame to hand ⌥1–9 over while the dashboard is open, and not after', () => {
      const view = mounted(URL_A)
      const posted = speakingFrame(view.container, sceneWith(['1']))
      // Told on the frame's first report: on the canvas they stay neuroglancer's.
      expect(posted).toHaveBeenCalledWith(
        { type: 'coda:ng-keys', altDigits: false },
        window.location.origin,
      )
      act(() => useGraphStore.setState({ dashboardOpen: true }))
      expect(posted).toHaveBeenLastCalledWith(
        { type: 'coda:ng-keys', altDigits: true },
        window.location.origin,
      )
    })

    it('presses a key the frame hands back as if it were pressed here', () => {
      const view = mounted(URL_A)
      frameShowing(view.container, sceneWith(['1']))
      const heard = vi.fn()
      const listen = (event: KeyboardEvent) => heard(event.code, event.altKey)
      window.addEventListener('keydown', listen)
      post(view.container, { type: 'coda:ng-key', code: 'Digit2', altKey: true })
      window.removeEventListener('keydown', listen)
      expect(heard).toHaveBeenCalledWith('Digit2', true)
    })
  })

  it('ignores a message from any other window', () => {
    const { container, onSelectionEdits } = mounted(URL_A)
    report(container, sceneWith(['1', '5']), window)
    expect(onSelectionEdits).not.toHaveBeenCalled()
  })

  /** The stable window, with a spy for what the card posts into the frame. */
  function speakingFrame(container: HTMLElement, scene: unknown) {
    frameShowing(container, scene)
    const win = frame(container)!.contentWindow as unknown as { postMessage?: unknown }
    const posted = vi.fn()
    win.postMessage = posted
    // The frame's report is what says it is Coda's own and can take a selection in place.
    report(container, scene)
    return posted
  }

  function rerendered(
    view: ReturnType<typeof mounted>,
    url: string,
    selectionEdits: string[] = [],
  ) {
    view.rerender(viewer(url, selectionEdits, view.onSelectionEdits))
  }

  it('sets a changed selection in place, at once, with the pointer inside the frame', () => {
    // Restoring `layers` rebuilds every layer, which is why an update used to wait for the pointer
    // to leave; setting the segments in place rebuilds nothing.
    const view = mounted(URL_A)
    const posted = speakingFrame(view.container, sceneWith(['1']))
    const before = frameSrc(view.container)
    fireEvent.mouseEnter(scaleBox(view.container)!)
    rerendered(view, URL_B)
    expect(posted).toHaveBeenCalledWith(
      {
        type: 'coda:ng-set-segments',
        layers: [{ name: OWNED, segments: ['1', '2'], segmentColors: {} }],
        // The navigation was update 1; this is the next.
        update: 2,
      },
      window.location.origin,
    )
    flushMerge()
    // No navigation at all: the camera, the layout and every other layer are left alone.
    expect(frameSrc(view.container)).toBe(before)
  })

  it('treats the scene handed back after a double-click the same way', () => {
    // The frame already shows it, so setting it in place changes nothing — and nothing rebuilds.
    const view = mounted(URL_A)
    speakingFrame(view.container, sceneWith(['1', '2']))
    const before = frameSrc(view.container)
    rerendered(view, URL_B, ['+2'])
    flushMerge()
    expect(frameSrc(view.container)).toBe(before)
  })

  it('navigates as before when more than the selection changes', () => {
    const view = mounted(URL_A)
    const posted = speakingFrame(view.container, sceneWith(['1']))
    const before = frameSrc(view.container)
    rerendered(view, URL_OTHER)
    flushMerge()
    expect(posted).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'coda:ng-set-segments' }),
      expect.anything(),
    )
    expect(frameSrc(view.container)).not.toBe(before)
  })

  it('navigates as before for a frame that never said it can take one', () => {
    // A typed `Viewer`, or the public demo through the dev proxy: no report, no in-place update.
    const view = mounted(URL_A)
    frameShowing(view.container, sceneWith(['1']))
    const before = frameSrc(view.container)
    rerendered(view, URL_B)
    flushMerge()
    expect(frameSrc(view.container)).not.toBe(before)
  })

  it('reads the neurons from a pasted link where the frame cannot be read', () => {
    // The default deployment is another origin, so nothing comes back by itself — once the dev
    // proxy, which makes it readable, is out of the picture.
    vi.stubEnv('DEV', false)
    const { container, onSelectionEdits } = mounted(URL_A)
    fireEvent.click(screen.getByRole('button', { name: 'Read neurons from a link' }))
    const input = screen.getByRole('textbox', { name: 'Neuroglancer link' })
    fireEvent.change(input, { target: { value: sceneUrl(undefined, sceneWith(['1', '8'])) } })
    fireEvent.submit(input.closest('form')!)
    expect(onSelectionEdits).toHaveBeenCalledWith(['+8'])
    expect(container.querySelector('.ng-paste')).toBeNull()
  })
})
