/**
 * Feedback — bug reports, feature requests, and just getting in touch, all one Web3Forms POST.
 *
 * Three tabs rather than one field with a dropdown: the three questions ("what broke", "what do
 * you wish it did", "hello") want different prompts and, for bug reports only, an attached
 * diagnostic snapshot — three fields worth keeping independent so switching tabs to add a second
 * kind of note does not overwrite the first.
 *
 * Mounted once, in `App`, and opened by a store request — the same idiom as `ShareDialog` and
 * `ShortcutsDialog`. The category rides along in the request so the `?` menu, the palette and
 * the periodic nudge can each land on the tab that makes sense for them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { errorMessage } from '../../core/errors'
import { encodeShareFragment, shareUrl } from '../../data/share/fragment'
import type { FeedbackCategory } from '../../data/feedback'
import { buildFeedbackDiagnostics, submitFeedback } from '../../data/feedback'
import { useGraphStore } from '../../store/graphStore'
import { formatNumber } from '../format'
import { LONG_LINK_CHARS } from '../shareAdvisories'
import { useDismissOnOutside } from '../useDismiss'

interface CategoryCopy {
  label: string
  blurb: string
  placeholder: string
}

const CATEGORIES: Record<FeedbackCategory, CategoryCopy> = {
  bug: {
    label: 'Bug Report',
    blurb: 'What went wrong, and what did you expect instead?',
    placeholder: 'What were you doing, what happened, what should have happened…',
  },
  feature: {
    label: 'Feature Request',
    blurb: 'What should Coda be able to do that it can\u2019t today?',
    placeholder: 'What are you trying to do, and what would make that possible…',
  },
  general: {
    label: 'Get in Touch',
    blurb: 'Anything else \u2014 a question, a thought, a hello.',
    placeholder: 'Say hello, ask a question, anything…',
  },
}

const CATEGORY_ORDER: FeedbackCategory[] = ['bug', 'feature', 'general']

type Status =
  | { state: 'idle' }
  | { state: 'sending' }
  | { state: 'done' }
  | { state: 'error'; message: string }

/**
 * The optional graph link, for the bug-report tab only.
 *
 * `too-long` is not an error — the graph packed fine, it is just past what a plain link should
 * carry (see `LONG_LINK_CHARS`), so the dialog offers the Gist route instead of silently
 * attaching an 8,000-character URL to an email.
 */
type LinkState =
  | { state: 'idle' }
  | { state: 'building' }
  | { state: 'ready'; url: string }
  | { state: 'too-long'; length: number }
  | { state: 'error'; message: string }

export function FeedbackDialog() {
  const request = useGraphStore((s) => s.feedbackRequest)
  const [open, setOpen] = useState(false)
  const seen = useRef(request.seq)

  useEffect(() => {
    if (request.seq === seen.current) return
    seen.current = request.seq
    setOpen(true)
  }, [request])

  if (!open) return null
  return <Dialog initialCategory={request.category} onClose={() => setOpen(false)} />
}

function Dialog({
  initialCategory,
  onClose,
}: {
  initialCategory: FeedbackCategory
  onClose: () => void
}) {
  const graph = useGraphStore((s) => s.graph)
  const requestShare = useGraphStore((s) => s.requestShare)
  const panelRef = useRef<HTMLDivElement>(null)
  useDismissOnOutside(panelRef, onClose, { onEscape: true })

  const [category, setCategory] = useState<FeedbackCategory>(initialCategory)
  const [messages, setMessages] = useState<Record<FeedbackCategory, string>>({
    bug: '',
    feature: '',
    general: '',
  })
  const [email, setEmail] = useState('')
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true)
  const [includeLink, setIncludeLink] = useState(false)
  const [linkState, setLinkState] = useState<LinkState>({ state: 'idle' })
  const [manualLink, setManualLink] = useState('')
  const [status, setStatus] = useState<Status>({ state: 'idle' })

  const diagnostics = useMemo(() => buildFeedbackDiagnostics(graph), [graph])
  const message = messages[category]
  const copy = CATEGORIES[category]

  /*
   * Built only when asked for, not on every graph edit while the dialog sits open — packing is
   * cheap for an ordinary graph but not free, and this can run again with no visible cost since
   * nothing else in the dialog depends on it.
   */
  useEffect(() => {
    if (!includeLink) {
      setLinkState({ state: 'idle' })
      return
    }
    let live = true
    setLinkState({ state: 'building' })
    encodeShareFragment(graph).then(
      (fragment) => {
        if (!live) return
        const url = shareUrl(fragment, import.meta.env.BASE_URL, window.location.href)
        setLinkState(
          url.length > LONG_LINK_CHARS
            ? { state: 'too-long', length: url.length }
            : { state: 'ready', url },
        )
      },
      (err: unknown) => {
        if (live) setLinkState({ state: 'error', message: errorMessage(err) })
      },
    )
    return () => {
      live = false
    }
  }, [includeLink, graph])

  // The packed link when it fits; otherwise whatever gist link the sender pasted in, if any.
  const graphLink =
    linkState.state === 'ready'
      ? linkState.url
      : linkState.state === 'too-long'
        ? manualLink.trim() || undefined
        : undefined

  const submit = useCallback(() => {
    const trimmed = message.trim()
    if (!trimmed) return
    setStatus({ state: 'sending' })
    void submitFeedback({
      category,
      message: trimmed,
      email: email.trim() || undefined,
      diagnostics: category === 'bug' && includeDiagnostics ? diagnostics : undefined,
      graphLink: category === 'bug' && includeLink ? graphLink : undefined,
    }).then(
      () => setStatus({ state: 'done' }),
      (err: unknown) => setStatus({ state: 'error', message: errorMessage(err) }),
    )
  }, [category, message, email, includeDiagnostics, diagnostics, includeLink, graphLink])

  return (
    <div className="overlay" role="presentation">
      <div
        ref={panelRef}
        className="overlay__panel feedback"
        role="dialog"
        aria-modal="true"
        aria-label="Send feedback"
      >
        <header className="sources__header">
          <h2>Feedback</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="sources__tabs" role="tablist" aria-label="Kind of feedback">
          {CATEGORY_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="sources__tab"
              aria-selected={category === id}
              onClick={() => {
                setCategory(id)
                setStatus({ state: 'idle' })
              }}
            >
              {CATEGORIES[id].label}
            </button>
          ))}
        </div>

        <div className="sources__body feedback__body" role="tabpanel">
          {status.state === 'done' ? (
            <>
              <p className="sources__result" data-tone="ok">
                Thanks — your {copy.label.toLowerCase()} is on its way.
              </p>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setMessages((m) => ({ ...m, [category]: '' }))
                  setStatus({ state: 'idle' })
                }}
              >
                Send another
              </button>
            </>
          ) : (
            <>
              <p className="sources__note">{copy.blurb}</p>

              <label className="sources__field">
                <span>Message</span>
                <textarea
                  className="field feedback__message"
                  value={message}
                  placeholder={copy.placeholder}
                  onChange={(e) => setMessages((m) => ({ ...m, [category]: e.target.value }))}
                  rows={6}
                />
              </label>

              <label className="sources__field">
                <span>Your email (optional — only if you&rsquo;d like a reply)</span>
                <input
                  className="field"
                  type="email"
                  value={email}
                  placeholder="you@example.com"
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>

              {category === 'bug' && (
                <>
                  <label className="share__check">
                    <input
                      type="checkbox"
                      checked={includeDiagnostics}
                      onChange={(e) => setIncludeDiagnostics(e.target.checked)}
                    />
                    <span>
                      Include diagnostic details
                      <em>Graph size, browser and app version — nothing from your data.</em>
                    </span>
                  </label>
                  {includeDiagnostics && (
                    <pre className="feedback__diagnostics">{diagnostics}</pre>
                  )}

                  <label className="share__check">
                    <input
                      type="checkbox"
                      checked={includeLink}
                      onChange={(e) => setIncludeLink(e.target.checked)}
                    />
                    <span>
                      Include a link to this graph
                      <em>
                        Lets us open the exact graph you saw the bug in. Leave this off if it
                        holds anything sensitive.
                      </em>
                    </span>
                  </label>

                  {includeLink && linkState.state === 'building' && (
                    <p className="sources__note sources__note--tight">Building the link…</p>
                  )}

                  {includeLink && linkState.state === 'ready' && (
                    <input
                      className="field feedback__link"
                      readOnly
                      value={linkState.url}
                      aria-label="Graph link"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                  )}

                  {includeLink && linkState.state === 'error' && (
                    <p className="sources__result" data-tone="error">
                      Could not build a link: {linkState.message}
                    </p>
                  )}

                  {includeLink && linkState.state === 'too-long' && (
                    <div className="feedback__link-toolong">
                      <p className="sources__note sources__note--tight">
                        This graph packs to {formatNumber(linkState.length)} characters — too
                        long for a plain link. Close this and use{' '}
                        <strong>Share ▸ GitHub Gist</strong> to shorten it, then paste the
                        result below.
                      </p>
                      <input
                        className="field"
                        value={manualLink}
                        placeholder="Paste a gist link here"
                        aria-label="Gist link"
                        onChange={(e) => setManualLink(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          onClose()
                          requestShare()
                        }}
                      >
                        Open the Share dialog
                      </button>
                    </div>
                  )}
                </>
              )}

              {status.state === 'error' && (
                <p className="sources__result" data-tone="error">
                  {status.message}
                </p>
              )}

              <button
                type="button"
                className="btn btn--primary feedback__submit"
                disabled={!message.trim() || status.state === 'sending'}
                onClick={submit}
              >
                {status.state === 'sending' ? 'Sending…' : 'Send'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
