/**
 * The split gallery (`splitSession.ts`), mounted once in the app shell like Submit's overlay, so
 * it outlives the card whose key opened it (`docs/split-gallery-plan.md`).
 *
 * The candidates as tiles (`SplitTiles`), nearest first, each the neuron coloured by the part the
 * split keeps and the part it takes off; a click enlarges one, with **Accept** — which writes the
 * split (`splitAccept.ts`, phase 4) — and **Back** to all of them, which Escape is too (a second
 * Escape closes). After a write, its answer, and **Undo** while the edit can still be undone. The
 * status line says what is still being read or looked for, and why there is nothing where there
 * is nothing.
 */

import { useState, useSyncExternalStore } from 'react'

import type { SplitCandidate } from '../../packs/seam/splitGallery'
import { NM_PER_UM } from '../../data/units'
import { plural } from '../../style/format'
import { Modal, ModalHeader } from '../Modal'
import { KEPT_HEX, SplitTiles, TAKEN_HEX } from './SplitTiles'
import type { SplitAccept } from './splitAccept'
import {
  acceptSplit,
  onSplitAccept,
  sentenceOf,
  splitAccept,
  undoAccepted,
  mayHaveWritten,
  undoable,
} from './splitAccept'
import type { SplitSession } from './splitSession'
import {
  closeSplit,
  onSplitSession,
  regenerateSplit,
  splitExact,
  splitMesh,
  splitSession,
} from './splitSession'

export function SplitGalleryHost() {
  const session = useSyncExternalStore(onSplitSession, splitSession)
  const mesh = useSyncExternalStore(onSplitSession, splitMesh)
  const exact = useSyncExternalStore(onSplitSession, splitExact)
  const accepted = useSyncExternalStore(onSplitAccept, splitAccept)
  // Which tile is enlarged, for this press only: a new press starts from all of them.
  const [selected, setSelected] = useState<{ press: SplitSession['request']; index: number }>()
  if (!session) return null
  const enlarged = selected?.press === session.request ? selected.index : undefined
  // The tiles need the neuron as well, which a session has once it has candidates to offer.
  const shown = 'candidates' in session && session.candidates.length > 0 ? session : undefined
  // The last Accept, where it was made from this press.
  const accept = accepted?.request === session.request ? accepted : undefined
  const busy = Boolean(accepted?.step || accepted?.out)
  const undo = undoable(accept)
  const blocked = acceptBlocked(accept)
  // A new set is offered for the neuron as it was read: not once a split may have changed it.
  const canRegenerate =
    shown !== undefined && enlarged === undefined && !busy && !mayHaveWritten(accept?.result)
  const backToAll = () => setSelected(undefined)
  // Escape steps back as the buttons do: from an enlarged tile to all of them (not while a write
  // is out, as Back), and from there closes the gallery. The ✕ always closes.
  const onEscape = enlarged === undefined ? closeSplit : busy ? () => undefined : backToAll

  return (
    <Modal
      className="overlay__panel split-gallery"
      labelledBy="split-gallery-title"
      portal
      backdrop={false}
      onClose={onEscape}
    >
      <ModalHeader titleId="split-gallery-title" onClose={closeSplit}>
        Split {session.request.root}
      </ModalHeader>
      <div className="split-gallery__body">
        <p className="split-gallery__status" role="status">
          {statusOf(session)}
          {mesh?.status === 'loading' && shown
            ? ' Drawing level-2 chunks until the mesh arrives.'
            : ''}
          {mesh?.status === 'failed'
            ? ` No mesh (${mesh.message}); drawing level-2 chunks.`
            : ''}
        </p>
        {shown && (
          <>
            <p className="split-gallery__legend">
              <span className="legend__swatch" style={{ background: KEPT_HEX }} /> kept
              <span className="legend__swatch" style={{ background: TAKEN_HEX }} /> taken off
              <span className="split-gallery__hint">
                {enlarged === undefined
                  ? 'Drag to turn a tile; click one to enlarge it.'
                  : 'Drag to turn, scroll to zoom.'}
              </span>
            </p>
            <SplitTiles
              candidates={shown.candidates}
              chunks={shown.input.chunks}
              positions={shown.input.positions}
              mesh={mesh?.status === 'ready' ? mesh.mesh : undefined}
              exact={exact}
              pointNm={session.request.pointNm}
              selected={enlarged}
              onSelect={(index) => setSelected({ press: session.request, index })}
              caption={(candidate, i) => `${i + 1}. ${describe(candidate)}`}
            />
            {accept && (
              <p className="split-gallery__written" role="status">
                {writtenLine(accept)}
              </p>
            )}
            {(enlarged !== undefined || undo || canRegenerate) && (
              <footer className="split-gallery__foot">
                {canRegenerate && (
                  <button
                    type="button"
                    className="btn"
                    disabled={session.phase !== 'ready' || shown.exhausted === true}
                    title={
                      shown.exhausted
                        ? 'No other splits were found near the point.'
                        : 'Look for the next splits near the point, passing over the ones shown so far.'
                    }
                    onClick={regenerateSplit}
                  >
                    Regenerate
                  </button>
                )}
                {undo && (
                  <button type="button" className="btn" onClick={undoAccepted}>
                    Undo
                  </button>
                )}
                {enlarged !== undefined && (
                  <>
                    <button type="button" className="btn" disabled={busy} onClick={backToAll}>
                      Back to all
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={busy || Boolean(blocked)}
                      title={blocked}
                      onClick={() =>
                        acceptSplit({
                          request: shown.request,
                          graphene: shown.graphene,
                          input: shown.input,
                          index: enlarged,
                          candidate: shown.candidates[enlarged]!,
                        })
                      }
                    >
                      Accept
                    </button>
                  </>
                )}
              </footer>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

/** Why Accept is off for this press, or undefined: once written, the neuron is not what was read. */
function acceptBlocked(accept: SplitAccept | undefined): string | undefined {
  return mayHaveWritten(accept?.result)
    ? 'The neuron may have been edited from here. Press K over it again for splits of what it is now.'
    : undefined
}

/** Where the last Accept is, or what it came to, as the overlay says it. */
function writtenLine(accept: SplitAccept): string {
  const split = `Split ${accept.index + 1}:`
  switch (accept.step) {
    case 'checking':
      return `${split} checking the split and the neuron…`
    case 'splitting':
      return `${split} splitting…`
    case 'reading':
      return `${split} reading the new roots…`
    case 'undoing':
      return 'Undoing…'
    case undefined: {
      const said = sentenceOf(accept.result)
      if (accept.out) return `${said} Waiting for that answer before anything else is sent…`
      return accept.undo ? `${said} ${accept.undo.message}` : said
    }
  }
}

function statusOf(session: SplitSession): string {
  switch (session.phase) {
    case 'reading':
      return `Reading ${session.request.datastack} around the point…`
    case 'computing':
      return session.regenerating
        ? 'Looking for other splits near the point…'
        : `Looking for splits near the point… ${plural(session.candidates.length, 'split')} so far.`
    case 'ready':
      if (session.candidates.length === 0) {
        return 'No split near the point separates this neuron. Try a point closer to where the two touch, or split with two points in Neuroglancer.'
      }
      if (session.exhausted) return 'No other splits near the point: these are the last found.'
      return session.round > 1
        ? `${plural(session.candidates.length, 'other split')} near the point, nearest first (set ${session.round}).`
        : `${plural(session.candidates.length, 'split')} near the point, nearest first.`
    case 'failed':
      return session.message
  }
}

/** A candidate in a few words: how much it takes off, and how far along the neuron it is. */
function describe(candidate: SplitCandidate): string {
  const taken = Math.min(candidate.sizes.a, candidate.sizes.b)
  const um = candidate.alongNm / NM_PER_UM
  // Under half a micrometre is the chunk the point is in.
  return `takes off ${plural(taken, 'chunk')}, ${um < 0.5 ? 'at the point' : `${um.toFixed(1)} µm away`}`
}
