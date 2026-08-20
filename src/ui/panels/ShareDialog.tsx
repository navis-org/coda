/**
 * Share workflow — the sending half.
 *
 * Two destinations for one graph. **In the link** packs it into the `#!` fragment, which is
 * 1.5–2 kB for an ordinary workflow and needs no account, no server and no network; **GitHub
 * Gist** puts it somewhere and leaves a forty-character link, which is what an Explore
 * selection needs, since that packs to roughly 56,000 characters.
 *
 * The gist route is offered rather than defaulted to, and that ordering is the whole design: a
 * link that carries its own contents cannot rot, cannot be deleted by its author, and works for
 * a recipient who has never heard of any of this. It is strictly better right up to the point
 * where it stops fitting.
 *
 * **The advisories are the reason this is a dialog rather than a menu item that copies a link.**
 * What a shared workflow does *not* carry is not obvious — uploaded rows live in the browser,
 * a real connectome needs the recipient's own token — and the moment to say so is while the
 * sender still has the link in front of them.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { encodeShareFragment, isLocalOrigin, shareUrl } from '../../data/share/fragment'
import { GIST_EXTENSION, createGist, githubLogin, updateGist } from '../../data/share/gist'
import { getGithubToken } from '../../data/share/credentials'
import { serializeGraph } from '../../core/graph'
import { errorMessage } from '../../core/errors'
import { useGraphStore } from '../../store/graphStore'
import { LONG_LINK_CHARS, shareAdvisories } from '../shareAdvisories'
import { copyText, slugify } from '../export'
import { formatNumber } from '../format'
import { useDismissOnOutside } from '../useDismiss'

type Mode = 'link' | 'gist'

type GistState =
  | { state: 'idle' }
  | { state: 'working' }
  | { state: 'done'; id: string; owner: string | undefined; updated: boolean }
  | { state: 'error'; message: string }

/**
 * Mounted once, in `App`, and opened by a store request.
 *
 * A counter rather than local state in the toolbar, because the command palette opens it too
 * and the palette closes on pick — it has nowhere to hold a dialog. The mount-seeded guard is
 * the same one `paletteRequest` needs and for the same reason: the store outlives the
 * component, so without it any remount re-fires the last request and the dialog pops open
 * unprompted.
 */
export function ShareDialog() {
  const request = useGraphStore((s) => s.shareRequest)
  const [open, setOpen] = useState(false)
  const seen = useRef(request)

  useEffect(() => {
    if (request === seen.current) return
    seen.current = request
    setOpen(true)
  }, [request])

  if (!open) return null
  return <Dialog onClose={() => setOpen(false)} />
}

function Dialog({ onClose }: { onClose: () => void }) {
  const graph = useGraphStore((s) => s.graph)
  const setGraphGist = useGraphStore((s) => s.setGraphGist)
  const setNotice = useGraphStore((s) => s.setNotice)

  const [mode, setMode] = useState<Mode>('link')
  const [fragment, setFragment] = useState<string | undefined>()
  const [encodeError, setEncodeError] = useState<string | undefined>()
  const [secret, setSecret] = useState(false)
  const [gist, setGist] = useState<GistState>({ state: 'idle' })
  const [copied, setCopied] = useState(false)
  const [login, setLogin] = useState<string | undefined>()
  const panelRef = useRef<HTMLDivElement>(null)

  // Escape and a click outside, through the hook every other popover here uses rather than a
  // sixth hand-rolled `keydown` listener. Without it this dialog had no Escape at all.
  useDismissOnOutside(panelRef, onClose, { onEscape: true })

  const name = (graph.meta?.name ?? '').trim() || 'Untitled'
  const stored = graph.meta?.gist
  const hasToken = Boolean(getGithubToken())

  /**
   * Whether pressing Share updates the gist this workflow already names, or makes a new one.
   *
   * One derived value rather than the same expression at the button and at the write: they have
   * to agree, or the button says "Update" and the click creates. An unknown owner counts as ours
   * — the attempt is the cheapest way to find out, and the failure is reported plainly.
   */
  const mine = Boolean(stored) && (!stored?.owner || !login || stored.owner === login)

  /*
   * The packed link is built **once**, on open.
   *
   * Deps of `[graph]` looked right — a dialog is modal, so nobody can edit behind it — and were
   * wrong about the one edit the dialog itself makes: a successful gist write records
   * `meta.gist`, which mints a new graph object and re-ran the whole deflate, on the largest
   * graphs, while the user was looking at the gist tab where the packed link is not even shown.
   * Read through `getState` so the effect can honestly take no dependencies.
   */
  useEffect(() => {
    let live = true
    encodeShareFragment(useGraphStore.getState().graph).then(
      (value) => {
        if (live) setFragment(value)
      },
      (err: unknown) => {
        if (live) setEncodeError(errorMessage(err))
      },
    )
    return () => {
      live = false
    }
  }, [])

  /*
   * Who the token belongs to, asked once. It decides whether the button says Update or Create:
   * a workflow you were *sent* names somebody else's gist, and PATCHing that is a 404 with
   * nothing on screen to explain it.
   */
  useEffect(() => {
    if (!hasToken) return
    let live = true
    githubLogin().then(
      (value) => {
        if (live) setLogin(value)
      },
      () => {
        // A failed lookup is not worth a message of its own — it only downgrades Update to
        // Create, and the write itself reports properly if it fails too.
      },
    )
    return () => {
      live = false
    }
  }, [hasToken])

  const gistUrl =
    gist.state === 'done'
      ? shareUrl(
          `#!gh://${gist.owner ? `${gist.owner}/` : ''}${gist.id}`,
          import.meta.env.BASE_URL,
          window.location.href,
        )
      : undefined

  const linkUrl = fragment
    ? shareUrl(fragment, import.meta.env.BASE_URL, window.location.href)
    : undefined

  const url = mode === 'gist' ? gistUrl : linkUrl
  const advisories = shareAdvisories(graph, mode === 'link' ? linkUrl?.length : undefined)

  /*
   * A copy failure is *not* a gist failure. Reporting it through `GistState` — which this did —
   * rendered it in the gist result slot even in link mode and, worse, overwrote `state: 'done'`,
   * so a failed copy took the freshly created `gh://` link off the screen with it.
   */
  const copy = useCallback(() => {
    if (!url) return
    void copyText(url).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      },
      (err: unknown) => setNotice(errorMessage(err)),
    )
  }, [setNotice, url])

  /**
   * Write the gist.
   *
   * Update when the stored gist is one this token can write — same owner, or an unknown owner,
   * where the attempt is the cheapest way to find out and the failure is reported plainly.
   * Otherwise create, which is the right answer for a workflow that arrived from somebody else.
   */
  const share = useCallback(() => {
    setGist({ state: 'working' })
    const options = {
      json: serializeGraph(graph),
      name,
      // The same slug `Download .coda.json` uses, so the two names cannot drift.
      filename: `${slugify(name, 'workflow')}${GIST_EXTENSION}`,
      secret,
      appVersion: __APP_VERSION__,
    }
    const write = mine && stored ? updateGist(stored.id, options) : createGist(options)
    void write.then(
      (ref) => {
        setGist({ state: 'done', id: ref.id, owner: ref.owner, updated: mine })
        setGraphGist({ id: ref.id, ...(ref.owner ? { owner: ref.owner } : {}) })
      },
      (err: unknown) => setGist({ state: 'error', message: errorMessage(err) }),
    )
  }, [graph, mine, name, secret, setGraphGist, stored])

  const local = isLocalOrigin(window.location.href)

  /*
   * What to say while there is no link to show. `LinkBox` renders this only when `url` is
   * absent, so the two "…then undefined" arms this used to carry — for a fragment that exists
   * and a gist that is done — described states it can never be rendered in.
   */
  const pending =
    mode === 'link'
      ? encodeError
        ? `Could not build a link: ${encodeError}`
        : 'Building the link…'
      : gist.state === 'working'
        ? 'Uploading to GitHub…'
        : hasToken
          ? 'Press the button above to make the link.'
          : undefined

  return (
    <div className="overlay" role="presentation">
      <div
        ref={panelRef}
        className="overlay__panel share"
        role="dialog"
        aria-modal="true"
        aria-label="Share workflow"
      >
        <header className="sources__header">
          <h2>Share “{name}”</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="sources__sections" role="tablist" aria-label="Where the workflow goes">
          <button
            type="button"
            role="tab"
            className="sources__section"
            aria-selected={mode === 'link'}
            onClick={() => setMode('link')}
          >
            In the link
          </button>
          <button
            type="button"
            role="tab"
            className="sources__section"
            aria-selected={mode === 'gist'}
            onClick={() => setMode('gist')}
          >
            GitHub Gist
          </button>
        </div>

        <div className="sources__body share__body" role="tabpanel">
          {mode === 'link' ? (
            <p className="sources__note">
              The workflow travels inside the address — no account, no server, nothing to keep
              alive. Anyone who opens it gets your graph exactly as it is on the canvas.
            </p>
          ) : (
            <p className="sources__note">
              The workflow is stored in a gist on your GitHub account and the link points at it.
              Forty characters however large the graph, and you can update it later. Reading one
              needs no token, so the link works for anybody.
            </p>
          )}

          {mode === 'gist' && !hasToken ? (
            <p className="share__blocked">
              No GitHub token yet. Add one in <strong>Connections ▸ Sharing</strong> — the
              branch icon in the toolbar. It needs the <code>gist</code> scope and nothing else.
            </p>
          ) : null}

          {mode === 'gist' && hasToken ? (
            <div className="share__controls">
              <label className="share__check">
                <input
                  type="checkbox"
                  checked={secret}
                  disabled={Boolean(stored) && gist.state !== 'done'}
                  onChange={(e) => setSecret(e.target.checked)}
                />
                <span>
                  Secret gist
                  <em>
                    Unlisted, not private — anyone with the link can read it, and it will not
                    appear on your profile or in search.
                  </em>
                </span>
              </label>
              <button
                type="button"
                className="btn btn--primary"
                disabled={gist.state === 'working'}
                onClick={share}
              >
                {gist.state === 'working'
                  ? 'Uploading…'
                  : mine
                    ? 'Update the gist'
                    : 'Create a gist'}
              </button>
            </div>
          ) : null}

          <LinkBox url={url} copied={copied} onCopy={copy} pending={pending} />

          {mode === 'link' && linkUrl ? (
            <p className="share__size">
              {formatNumber(linkUrl.length)} characters
              {linkUrl.length > LONG_LINK_CHARS ? ' — longer than most clients carry' : ''}
            </p>
          ) : null}

          {gist.state === 'done' ? (
            <p className="sources__result" data-tone="ok">
              {gist.updated ? 'Gist updated.' : 'Gist created.'} Pressing Share again updates
              this same gist, so the link you have already sent stays current.
            </p>
          ) : null}
          {gist.state === 'error' ? (
            <p className="sources__result" data-tone="error">
              {gist.message}
            </p>
          ) : null}

          {local ? (
            <p className="share__advisory">
              This link points at <code>{window.location.host || 'this machine'}</code>, so it
              only opens where Coda is running now. Share from the deployed site to send it
              anywhere else.
            </p>
          ) : null}

          {advisories.map((advisory) => (
            <p className="share__advisory" key={advisory.id}>
              {advisory.text}
            </p>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * The link and its Copy button.
 *
 * A read-only input rather than a `<p>`: it is selectable, it scrolls rather than wrapping to
 * six lines, and it is what somebody reaches for when the clipboard API is unavailable — which
 * is every page not served over a secure origin.
 */
function LinkBox({
  url,
  copied,
  onCopy,
  pending,
}: {
  url: string | undefined
  copied: boolean
  onCopy: () => void
  pending: string | undefined
}) {
  if (!url) return pending ? <p className="share__pending">{pending}</p> : null
  return (
    <div className="share__link">
      <input
        className="field"
        readOnly
        value={url}
        aria-label="Shareable link"
        onFocus={(e) => e.currentTarget.select()}
      />
      <button type="button" className="btn" onClick={onCopy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
