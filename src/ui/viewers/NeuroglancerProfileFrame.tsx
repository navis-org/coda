/**
 * The profile's 3D tile: the dataset's published neuroglancer scene, showing one neuron.
 *
 * A thin wrapper over `NeuroglancerViewer` rather than a second iframe implementation, and
 * that is the whole point of it existing. The `#!+` merge form — which is what lets paging to
 * the next neuron keep the camera, the layout and every runtime tweak instead of resetting
 * the viewer — lives in that component, and it was established against the deployed viewer
 * rather than reasoned about. Reimplementing it here would mean rediscovering all four of the
 * facts behind it.
 *
 * Mounted only in the overlay. Each frame is a full WebGL application that starts fetching EM
 * on mount, and a canvas can hold a dozen profile cards; the card shows the cached coarse
 * silhouette instead and offers a control that opens this.
 */

import { useEffect, useState } from 'react'

import type { NgScene } from '../../data/neuroglancer/scene'
import { buildScene, sceneUrl, viewerBaseFor } from '../../data/neuroglancer/scene'
import { getSource } from '../../data/source'
import type { ColorSpec } from '../../nodes/lib/encodingParams'
import { NeuroglancerViewer } from './NeuroglancerViewer'
import { errorMessage } from '../../core/errors'

export interface NeuroglancerProfileFrameProps {
  sourceId: string | undefined
  datasetId: string | undefined
  /** Text, never a number: it becomes a neuroglancer segment. See invariant 8. */
  neuronId: string | undefined
  onError?: (message: string) => void
}

/**
 * One neuron, one colour, in palette.
 *
 * Slot 0 rather than neuroglancer's own hash colouring: a profile shows a single segment, so
 * a hashed hue would differ between this frame and the 3D view of the same neuron elsewhere
 * in the graph for no reason anyone could act on.
 */
const SEGMENT_COLOR: ColorSpec = { mode: 'constant', column: undefined, constant: '0' }

type SceneState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; scene: NgScene }
  /** The dataset publishes no scene. A legitimate answer, not a failure. */
  | { status: 'unpublished' }
  | { status: 'error'; message: string }

/**
 * The published scene for a dataset.
 *
 * Cached by the source itself — including the undefined — so this costs one small JSON per
 * dataset no matter how many profiles are open on it.
 */
function usePublishedScene(
  sourceId: string | undefined,
  datasetId: string | undefined,
): SceneState {
  const [state, setState] = useState<SceneState>({ status: 'none' })

  useEffect(() => {
    if (!sourceId || !datasetId) {
      setState({ status: 'none' })
      return
    }
    const source = getSource(sourceId)
    if (!source?.fetchViewerScene) {
      setState({ status: 'unpublished' })
      return
    }

    const controller = new AbortController()
    let live = true
    setState({ status: 'loading' })

    source
      .fetchViewerScene({ datasetId, signal: controller.signal })
      .then((scene) => {
        if (!live) return
        setState(scene ? { status: 'ready', scene } : { status: 'unpublished' })
      })
      .catch((error: unknown) => {
        if (!live) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        setState({
          status: 'error',
          message: errorMessage(error),
        })
      })

    return () => {
      live = false
      controller.abort()
    }
  }, [sourceId, datasetId])

  return state
}

export function NeuroglancerProfileFrame({
  sourceId,
  datasetId,
  neuronId,
  onError,
}: NeuroglancerProfileFrameProps) {
  const state = usePublishedScene(sourceId, datasetId)

  if (state.status === 'loading') return <p className="profile__pending">Loading scene…</p>
  if (state.status === 'none') return <p className="profile__pending">No dataset</p>
  if (state.status === 'error') return <p className="profile__pending">{state.message}</p>
  if (state.status === 'unpublished') {
    return (
      <p className="profile__pending">
        This dataset publishes no neuroglancer scene, so there is nothing to point a viewer at.
      </p>
    )
  }

  /*
   * Rebuilt on every render rather than memoised, and that is safe *because* of the merge:
   * an identical scene produces an identical URL, and `NeuroglancerViewer` compares the URL
   * before touching the frame. Memoising here would guard nothing and hide the fact that the
   * only thing that changes between neurons is the segment list.
   */
  const scene = buildScene(state.scene, {
    datasetId: datasetId ?? '',
    segments: neuronId === undefined ? [] : [neuronId],
    segmentDefaultColor: '#3987e5',
    layout: '3d',
    layers: 'all',
  })

  return (
    <NeuroglancerViewer
      // The dataset's own deployment, through the same resolver `out.neuroglancer` uses. This
      // was a bare `''`, so a CAVE dataset opened in the built-in default rather than the viewer
      // its own datastack names — and a segmentation source is written for one flavour or the
      // other, so it drew the EM volume with no neurons in it. See `viewerKind`.
      url={sceneUrl(
        viewerBaseFor('', getSource(sourceId ?? '')?.peekDataset(datasetId ?? '')?.viewerSite),
        scene,
      )}
      color={SEGMENT_COLOR}
      compact
      onError={onError}
    />
  )
}
