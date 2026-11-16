/**
 * Submit's confirm overlay — the plan beside the neuron as the merges will make it
 * (`docs/seam-merge-plan.md`, phase 4, for what was decided and why).
 *
 * **Sends nothing, and imports nothing that can**: Confirm hands the ticked merges to `onConfirm`,
 * and the submit session (`mergeSession.ts`) makes the confirmations and sends them, so only the
 * modules `importGraph.test.ts` names can reach the writer.
 *
 * **A tick changes only the segments**, which the viewer sets in place. The lines and the camera
 * are the whole plan's and never move: a change to the line layer is a full re-navigation that
 * rebuilds every layer and re-centres the camera, losing the view the reader was checking.
 */

import { useMemo, useRef, useState } from 'react'

import type { NgScene } from '../../data/neuroglancer/scene'
import {
  buildScene,
  sceneUrl,
  sceneVoxelNm,
  selectionLayerName,
  selfHostedViewer,
  viewerBaseFor,
} from '../../data/neuroglancer/scene'
import { decodeSelectionEdits } from '../../data/neuroglancer/selectionEdits'
import { controlPartColor } from '../../nodes/output/neuroglancer'
import type { MergeProgress } from '../../packs/seam/mergeRecord'
import type { PlannedMerge, PlanRefusal, ReadyPlan } from '../../packs/seam/mergePlan'
import { gapLabel, sizeLabel, sizeOf } from '../../packs/seam/reviewQueue'
import { mergeLineLayer } from '../../packs/seam/scene'
import { Modal } from '../Modal'
import { NeuroglancerViewer } from '../viewers/NeuroglancerViewer'

export interface MergeConfirmProps {
  readonly plan: ReadyPlan
  /** When the plan's checks ran, epoch ms. */
  readonly plannedAt: number
  /** The dataset's published scene, its id and viewer site — what the card's own viewer is built from. */
  readonly published: NgScene | undefined
  readonly datasetId: string
  readonly viewerSite: string | undefined
  /**
   * Points the neuron reaches, nm — its tips — so the view opens on the whole neuron with every
   * merge on it, rather than at the published zoom.
   */
  readonly extentNm?: readonly (readonly number[])[] | undefined
  /** Per candidate root, once the batch runs. */
  readonly progress?: ReadonlyMap<string, MergeProgress> | undefined
  readonly running?: boolean | undefined
  /** The neuron's root now, where the batch has moved it on from the plan's. */
  readonly neuronRoot?: string | undefined
  /**
   * Starts the batch. A throw or a rejected promise means it did not start: the overlay unlocks
   * and says why, so the reader can try again or close.
   */
  readonly onConfirm: (merges: readonly PlannedMerge[]) => void | Promise<void>
  readonly onStop?: (() => void) | undefined
  readonly onRecheck?: (() => void) | undefined
  readonly onClose: () => void
}

/** A piece's colour: green, or orange where it is itself another reviewed neuron. */
/*
 * A piece that is itself another reviewed neuron takes the `candidate` hue: the overlay never shows
 * a candidate, and a fourth hue would have to be validated against the three, not picked.
 */
const colorOf = (merge: PlannedMerge) =>
  controlPartColor(merge.joinsNeuron ? 'candidate' : 'accepted')

/** The viewer colours by the scene, not by a column. */
const BY_SCENE = { mode: 'constant', column: undefined, constant: '0' } as const

/** The self-hosted viewer page, which does not change while the app runs. */
const FRAME_VIEWER = selfHostedViewer()

/** The viewer's edits are turned into ticks at once, so none is ever held. */
const NO_EDITS_LIST: readonly string[] = []

const IGNORE = () => {}

/** Where a merge is part of the neuron already. */
const MERGED: ReadonlySet<string> = new Set(['merged', 'already-merged'])

const REFUSAL_LABEL: Record<PlanRefusal, string> = {
  'already-merged': 'already merged',
  'merged-elsewhere': 'in another neuron',
  outdated: 'outdated',
  'neuron-outdated': 'neuron edited',
  'same-root': 'same segment',
  'bad-id': 'bad id',
  'no-contact': 'no contact point',
  'gap-too-wide': 'too far apart',
  'bad-gap': 'bad gap',
  'outside-volume': 'outside the volume',
  'neuron-absent': 'neuron not there',
  'candidate-absent': 'piece not there',
  'too-far': 'too many chunks apart',
}

const PROGRESS_LABEL: Record<MergeProgress['state'], string> = {
  waiting: '…',
  sending: 'sending',
  merged: '✓ merged',
  'already-merged': '✓ already',
  failed: '✗ failed',
  unknown: '? unknown',
  'not-sent': '— not sent',
}

export function MergeConfirm({
  plan,
  plannedAt,
  published,
  datasetId,
  viewerSite,
  extentNm,
  progress,
  running = false,
  neuronRoot = plan.currentRoot,
  onConfirm,
  onStop,
  onRecheck,
  onClose,
}: MergeConfirmProps) {
  /*
   * What is ticked, with the plan it was ticked on. A new plan (Re-check) keeps the ticks that
   * still apply; **a piece new to it starts unticked**, since the reader has not looked at it.
   */
  const [chosen, setChosen] = useState(() => ({
    plan,
    ids: new Set(plan.merges.map((merge) => merge.candidateRoot)) as ReadonlySet<string>,
  }))
  let ids = chosen.ids
  if (chosen.plan !== plan) {
    ids = new Set(plan.merges.map((m) => m.candidateRoot).filter((id) => chosen.ids.has(id)))
    setChosen({ plan, ids })
  }
  const ticked = useMemo(
    () => plan.merges.filter((merge) => ids.has(merge.candidateRoot)),
    [plan, ids],
  )
  /*
   * Pressed once: the button hands its merges on a single time. A ref as well as state, because a
   * double click can land twice before React redraws, and the second would read the old state.
   */
  const pressed = useRef(false)
  const [sent, setSent] = useState(false)
  const [failed, setFailed] = useState<string>()
  const started = sent || running || progress !== undefined
  /*
   * Locked from the press until the batch has finished: between Merge and the parent setting
   * `running`, the merges are already on their way, and closing then would unmount the overlay —
   * and possibly the card — from under them.
   */
  const locked = running || (sent && progress === undefined)
  const confirm = () => {
    if (pressed.current) return
    pressed.current = true
    setSent(true)
    setFailed(undefined)
    const unlock = (error: unknown) => {
      pressed.current = false
      setSent(false)
      setFailed(error instanceof Error ? error.message : String(error))
    }
    try {
      void Promise.resolve(onConfirm(ticked)).catch(unlock)
    } catch (error) {
      unlock(error)
    }
  }
  const setTicked = (change: (next: Set<string>) => void) =>
    setChosen((held) => {
      const next = new Set(held.ids)
      change(next)
      // Unchanged, the same object: a viewer report that moves no tick must not rebuild the scene.
      const same = next.size === held.ids.size && [...next].every((id) => held.ids.has(id))
      return same ? held : { plan: held.plan, ids: next }
    })
  const toggle = (candidateRoot: string) =>
    setTicked((next) => {
      if (!next.delete(candidateRoot)) next.add(candidateRoot)
    })
  // A piece hidden or shown in the viewer is unticked or ticked: the view and the list agree.
  const fromViewer = (edits: string[]) => {
    if (started) return
    const { added, removed, hidden } = decodeSelectionEdits(edits)
    setTicked((next) => {
      for (const merge of plan.merges) {
        const id = merge.candidateRoot
        if (removed.has(id) || hidden.has(id)) next.delete(id)
        else if (added.has(id)) next.add(id)
      }
    })
  }

  // A piece already merged is part of the neuron's new root, and leaves the view as its own.
  const shown = useMemo(
    () =>
      ticked.filter((merge) => !MERGED.has(progress?.get(merge.candidateRoot)?.state ?? '')),
    [ticked, progress],
  )
  // The URL is rebuilt only when the scene is, not on every render.
  const url = useMemo(
    () =>
      published
        ? sceneUrl(
            viewerBaseFor('', viewerSite),
            mergeScene(published, datasetId, neuronRoot, plan.merges, shown),
          )
        : undefined,
    [published, datasetId, viewerSite, neuronRoot, plan, shown],
  )
  // The whole neuron, framed once: a tick must not move the camera.
  const framing = useMemo(() => {
    const voxel = published ? sceneVoxelNm(published) : undefined
    const points = [
      ...(extentNm ?? []),
      ...plan.merges.flatMap((merge) => [merge.neuron.positionNm, merge.candidate.positionNm]),
    ]
    return voxel && points.length > 0 ? frameOf(points, voxel) : undefined
  }, [published, plan, extentNm])

  const label =
    `Merge ${ticked.length} piece${ticked.length === 1 ? '' : 's'} into ${neuronRoot} ` +
    `on ${plan.datastack}`

  return (
    <Modal
      className="overlay__panel merge-confirm"
      label="Confirm merges"
      portal
      backdrop={false}
      // While merges are on their way, Escape is still taken — by nothing — so it cannot reach a
      // surface underneath and close the card from under the batch.
      onClose={locked ? IGNORE : onClose}
    >
      <div className="merge-confirm__body">
        <section className="merge-confirm__plan">
          <header className="merge-confirm__head">
            <h2>Merges into {neuronRoot}</h2>
            <p>
              {plan.datastack} · checked at {new Date(plannedAt).toLocaleTimeString()}
              {onRecheck && !started && (
                <button type="button" className="btn btn--ghost" onClick={onRecheck}>
                  Re-check
                </button>
              )}
            </p>
          </header>

          <ol className="merge-confirm__list">
            {plan.merges.map((merge) => (
              <MergeRow
                key={merge.candidateRoot}
                merge={merge}
                ticked={ids.has(merge.candidateRoot)}
                locked={started}
                progress={progress?.get(merge.candidateRoot)}
                onToggle={() => toggle(merge.candidateRoot)}
              />
            ))}
          </ol>
          {plan.merges.length === 0 && (
            <p className="merge-confirm__empty">Nothing can be merged — see why below.</p>
          )}

          {plan.rejected.length > 0 && (
            <details className="merge-confirm__refused" open={plan.merges.length === 0}>
              <summary>{plan.rejected.length} not merged</summary>
              <ul>
                {plan.rejected.map((refused) => (
                  <li key={refused.candidateRoot}>
                    <span className="merge-confirm__id">{refused.candidateRoot}</span>
                    <span className="merge-confirm__reason">
                      {REFUSAL_LABEL[refused.reason]}
                    </span>
                    <span className="merge-confirm__why">{refused.message}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <footer className="merge-confirm__foot">
            {!started && (
              <button
                type="button"
                className="btn btn--primary merge-confirm__go"
                disabled={ticked.length === 0}
                // A click or Space; never Enter, which a reader can press without meaning to.
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.preventDefault()
                }}
                onClick={confirm}
              >
                {label}
              </button>
            )}
            {failed && <p className="merge-confirm__failed">Not started: {failed}</p>}
            {running ? (
              <button type="button" className="btn" onClick={onStop} disabled={!onStop}>
                Stop after this merge
              </button>
            ) : (
              <button type="button" className="btn" onClick={onClose} disabled={locked}>
                {started ? 'Close' : 'Cancel'}
              </button>
            )}
          </footer>
        </section>

        <section className="merge-confirm__viewer" aria-label="The neuron after the merges">
          {url ? (
            <NeuroglancerViewer
              url={url}
              frameViewer={FRAME_VIEWER}
              focus={framing?.focus}
              focusWidth={framing?.width}
              color={BY_SCENE}
              datasetId={datasetId}
              // The neuron's layer and the merge lines: ours, so a re-navigation replaces them.
              extraLayers={2}
              selectionEdits={NO_EDITS_LIST}
              onSelectionEdits={fromViewer}
              summary={`${shown.length} of ${plan.merges.length} pieces shown`}
              compact
            />
          ) : (
            <p className="merge-confirm__empty">No viewer for this dataset.</p>
          )}
        </section>
      </div>
    </Modal>
  )
}

function MergeRow({
  merge,
  ticked,
  locked,
  progress,
  onToggle,
}: {
  merge: PlannedMerge
  ticked: boolean
  locked: boolean
  progress: MergeProgress | undefined
  onToggle: () => void
}) {
  const { candidate } = merge.used
  return (
    <li className="merge-confirm__row" data-ticked={ticked ? 'yes' : 'no'}>
      <label>
        <input type="checkbox" checked={ticked} disabled={locked} onChange={onToggle} />
        <span className="legend__swatch" style={{ background: colorOf(merge) }} />
        <span className="merge-confirm__id">{merge.candidateRoot}</span>
      </label>
      <span className="merge-confirm__facts">
        {[
          `tip ${merge.used.endUid}`,
          `rank ${candidate.rank}`,
          sizeLabel(sizeOf(candidate)),
          gapLabel(candidate.minDistUm),
          merge.rows.length > 1 ? `accepted at ${merge.rows.length} tips` : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {merge.joinsNeuron && (
        <span className="merge-confirm__joins">joins two reviewed neurons</span>
      )}
      {progress && (
        <span
          className="merge-confirm__progress"
          data-state={progress.state}
          title={progress.message}
        >
          {PROGRESS_LABEL[progress.state]}
        </span>
      )}
    </li>
  )
}

/**
 * The neuron and the shown pieces, and a line for every merge in the plan.
 *
 * **The neuron has a layer of its own, drawn see-through** (`NEURON_ALPHA`, user, 2026-11-16), so
 * the pieces about to join it stand out against it: a copy of the dataset's segmentation layer
 * holding the neuron alone. The pieces stay in the dataset's layer, which the lines are linked to
 * (`mergeLineLayer`) so neuroglancer draws a line only while its piece is shown.
 *
 * Every layer is the plan's, never the ticks': only segment lists change between two scenes — a
 * tick in the pieces' layer, a merge in the neuron's — so the viewer sets them in place
 * (`selectionChanges`) and the camera stays where the reader put it.
 */
function mergeScene(
  published: NgScene,
  datasetId: string,
  neuronRoot: string,
  all: readonly PlannedMerge[],
  shown: readonly PlannedMerge[],
): NgScene {
  const pieces = {
    datasetId,
    segments: shown.map((merge) => merge.candidateRoot),
    segmentColors: Object.fromEntries(
      shown.map((merge) => [merge.candidateRoot, colorOf(merge)]),
    ),
    layout: '3d',
    layers: 'all',
  } as const
  const selection = selectionLayerName(published, datasetId)
  // The dataset's own layer as the pieces have it: what the neuron's layer is a copy of.
  const own = (buildScene(published, pieces)['layers'] as Record<string, unknown>[]).find(
    (layer) => layer['name'] === selection,
  )
  const neuron = own && {
    ...own,
    name: NEURON_LAYER,
    segments: [neuronRoot],
    segmentColors: { [neuronRoot]: controlPartColor('neuron') },
    objectAlpha: NEURON_ALPHA,
  }
  const lines = mergeLineLayer(
    all.map((merge) => ({
      id: merge.candidateRoot,
      segment: merge.candidateRoot,
      fromNm: merge.neuron.positionNm,
      toNm: merge.candidate.positionNm,
      color: colorOf(merge),
      description: `merge ${merge.candidateRoot} into the neuron`,
    })),
    'merges',
    selection,
  )
  // Always two extras (`extraLayers={2}`): without a segmentation layer to copy there is no scene
  // worth drawing, and an empty annotation layer keeps the count honest.
  return buildScene(published, {
    ...pieces,
    extraLayers: [neuron ?? mergeLineLayer([], NEURON_LAYER, undefined), lines],
  })
}

/** The neuron's layer, and how see-through its mesh is drawn (user, 2026-11-16). */
const NEURON_LAYER = 'neuron'
const NEURON_ALPHA = 0.2

/** How much room around the neuron: its span, and a little more so its ends are not on the edge. */
const FRAME_MARGIN = 1.15
/** The least a view is framed to, nm: a neuron with one tip still opens on something visible. */
const MIN_FRAME_NM = 5_000

/**
 * The box around `points` (nm), as the camera takes it: its middle in the scene's voxel units, and
 * its widest span across the coarsest axis's units — the convention `ValuePreview` frames by.
 */
function frameOf(
  points: readonly (readonly number[])[],
  voxelNm: readonly number[],
): { focus: number[]; width: number } {
  const axes = [0, 1, 2]
  const low = axes.map((a) => Math.min(...points.map((p) => p[a]!)))
  const high = axes.map((a) => Math.max(...points.map((p) => p[a]!)))
  const span = Math.max(MIN_FRAME_NM, ...axes.map((a) => high[a]! - low[a]!)) * FRAME_MARGIN
  return {
    focus: axes.map((a) => (low[a]! + high[a]!) / 2 / voxelNm[a]!),
    width: span / Math.max(...voxelNm),
  }
}
