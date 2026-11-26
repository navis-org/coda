/**
 * The Proofread Merges card's verdict-sharing control, in its foot (user, 2026-11-18): a switch
 * to send this browser's verdicts to SEAM, what has been sent, and a small panel for the name and
 * email. Everything it shows and writes is `src/data/verdictLog.ts`'s, kept per browser — never in
 * the workflow (`docs/seam-verdict-log-plan.md`).
 */

import { useEffect, useState, useSyncExternalStore } from 'react'

import {
  COLLECTED_FOR_MS,
  collectedDatastacks,
  flushVerdicts,
  subscribeVerdictLog,
  verdictLogState,
  writeSharing,
} from '../../data/verdictLog'
import type { VerdictLogState } from '../../data/verdictLog'
import { formatNumber } from '../../style/format'
import { ContextMenu } from '../menu/ContextMenu'
import { anchorBelow } from '../menu/placement'

/** How soon the server's list is asked again after asking failed. */
const RETRY_MS = 60 * 1000

/**
 * Whether the server collects this datastack's verdicts: `undefined` while it is being asked or
 * where it could not be, so a card that cannot reach the server neither claims nor denies it.
 * **Asked only once the reader has turned sharing on**: a reader who never does sends the lab's
 * server nothing at all, not even this question.
 */
function useVerdictsCollected(datastack: string | undefined): boolean | undefined {
  const sharing = useSyncExternalStore(subscribeVerdictLog, () => verdictLogState().sharing.on)
  const [collected, setCollected] = useState<ReadonlySet<string>>()
  useEffect(() => {
    if (!sharing) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let live = true
    // Asked again as the answer goes stale, and a minute after a failure, so a server briefly
    // out of reach does not leave the card without an answer for the session.
    const ask = () =>
      collectedDatastacks().then(
        (set) => {
          if (!live) return
          setCollected(set)
          timer = setTimeout(ask, COLLECTED_FOR_MS)
        },
        () => {
          if (live) timer = setTimeout(ask, RETRY_MS)
        },
      )
    void ask()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [sharing])
  return datastack === undefined || collected === undefined
    ? undefined
    : collected.has(datastack)
}

export function VerdictSharing({
  datastack,
}: {
  /** The wired dataset's datastack, where it is a CAVE one. */
  datastack: string | undefined
}) {
  const collected = useVerdictsCollected(datastack)
  const state = useSyncExternalStore(subscribeVerdictLog, verdictLogState)
  const [panelAt, setPanelAt] = useState<{ x: number; y: number }>()
  const { sharing } = state

  // What an earlier page left waiting goes as soon as a card can show it going.
  useEffect(() => {
    if (sharing.on && verdictLogState().waiting > 0) void flushVerdicts()
  }, [sharing.on])

  return (
    <span className="verdict-sharing">
      <label
        className="checkbox-field verdict-sharing__switch"
        title="Send each verdict you give on this card to our server, to improve SEAM’s predictions. Kept in this browser, not in the workflow."
      >
        <input
          type="checkbox"
          checked={sharing.on}
          onChange={(event) => writeSharing({ ...sharing, on: event.target.checked })}
        />
        {/* The control's baseline is the words', not the checkbox's: the foot lines up by text. */}
        <span className="verdict-sharing__label">Help improve</span>
      </label>
      <button
        type="button"
        className="review-body__fold verdict-sharing__settings"
        aria-haspopup="dialog"
        aria-expanded={panelAt !== undefined}
        aria-label="What Help improve sends, and your name and email"
        title="What Help improve sends, and your name and email"
        onClick={(event) => setPanelAt(panelAt ? undefined : anchorBelow(event.currentTarget))}
      >
        {/* Text presentation, so no platform draws the cog as an emoji. */}
        {'\u2699\uFE0E'}
      </button>
      {sharing.on && (
        <span className="verdict-sharing__said">{said(state, datastack, collected)}</span>
      )}
      {panelAt && (
        <ContextMenu
          at={panelAt}
          onClose={() => setPanelAt(undefined)}
          portal
          role="dialog"
          label="Help improve"
          dismissOnOutside={false}
          className="verdict-sharing__panel"
        >
          <p className="verdict-sharing__note">
            {'Toggling on "Help improve" will send your verdicts plus meta data (tip, candidate, ' +
              'scores, etc) to our server. We will use that data to improve predictions. Name and ' +
              'email are optional.'}
          </p>
          <label>
            Name
            <input
              className="field"
              type="text"
              value={sharing.name}
              autoComplete="name"
              onChange={(event) => writeSharing({ ...sharing, name: event.target.value })}
            />
          </label>
          <label>
            Email
            <input
              className="field"
              type="email"
              value={sharing.email}
              autoComplete="email"
              onChange={(event) => writeSharing({ ...sharing, email: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="btn verdict-sharing__done"
            onClick={() => setPanelAt(undefined)}
          >
            Done
          </button>
        </ContextMenu>
      )}
    </span>
  )
}

/** The line beside the switch: where the verdicts stand, or why none can go. */
function said(
  state: VerdictLogState,
  datastack: string | undefined,
  collected: boolean | undefined,
): string {
  if (datastack === undefined) return 'Wire a CAVE dataset to send verdicts.'
  if (collected === false) return `Not collected for ${datastack}.`
  const counts = [`${formatNumber(state.sent)} sent`]
  if (state.waiting > 0) counts.push(`${formatNumber(state.waiting)} waiting`)
  if (state.dropped > 0) counts.push(`${formatNumber(state.dropped)} not kept`)
  const line = (state.sending ? 'sending… ' : '') + counts.join(' · ')
  return state.problem ? `${line} — ${state.problem}` : line
}
