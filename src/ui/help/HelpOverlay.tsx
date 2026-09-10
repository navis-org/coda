/**
 * The `?` overlay: a node's long-form document.
 *
 * A modal over the canvas rather than a panel beside it, and a *reading* surface rather than a
 * reference one — the node guide already covers "what are this node's sockets", and repeating it
 * here would make the button open a worse copy of a page that exists. What belongs here is what
 * neither the guide nor the node card can carry: why the node behaves the way it does, what it
 * quietly assumes, and the pipeline it is normally part of.
 *
 * **Keyed on the node type, not on a node.** Nothing in here reads the graph, which is what lets
 * the same overlay open from a card, from the inspector, from the node browser before anything
 * has been placed, and from a cross-reference inside another document.
 *
 * ## The trail is the component's, not the store's
 *
 * A document may link to another node's with `[Skeletons](#query.skeletons)`. Those hops are
 * local state: routing them through `openHelp` would make every hop indistinguishable from a
 * fresh open, and Back would push the entry it had just popped. So the store holds where the
 * reader *came in*, and this holds where they have got to since.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getNodeDef } from '../../core/registry'
import { buildFigure, isFigureLang } from '../../help/figures'
import type { HelpDoc } from '../../help/registry'
import { helpImageUrl, loadHelpDoc } from '../../help/registry'
import { seeAlsoFor } from '../../help/seeAlso'
import { useGraphStore } from '../../store/graphStore'
import { MarkdownBlocks, MarkdownInlines } from '../MarkdownView'
import type { MarkdownRenderOptions } from '../MarkdownView'
import { parseInline } from '../markdown'
import { FigureView } from './FigureView'
import { Modal } from '../Modal'

const NODE_GUIDE_URL = `${import.meta.env.BASE_URL}nodes.html`

export function HelpOverlay() {
  const helpType = useGraphStore((s) => s.helpType)
  const openHelp = useGraphStore((s) => s.openHelp)

  /** Where the reader has got to, oldest first. Reset whenever the overlay is opened afresh. */
  const [trail, setTrail] = useState<string[]>([])
  const current = trail[trail.length - 1]

  useEffect(() => {
    setTrail(helpType ? [helpType] : [])
  }, [helpType])

  const close = useCallback(() => openHelp(undefined), [openHelp])

  if (!helpType || !current) return null
  return (
    <Modal
      className="overlay__panel help-panel"
      label={`${getNodeDef(current)?.label ?? current} help`}
      onClose={close}
    >
      <HelpHeader
        type={current}
        canGoBack={trail.length > 1}
        onBack={() => setTrail((t) => t.slice(0, -1))}
        onClose={close}
      />
      <HelpBody type={current} onNavigate={(next) => setTrail((t) => [...t, next])} />
    </Modal>
  )
}

function HelpHeader({
  type,
  canGoBack,
  onBack,
  onClose,
}: {
  type: string
  canGoBack: boolean
  onBack: () => void
  onClose: () => void
}) {
  const def = getNodeDef(type)
  return (
    <div className="overlay__header">
      {canGoBack && (
        <button type="button" className="btn btn--ghost" onClick={onBack} aria-label="Back">
          ‹ Back
        </button>
      )}
      <div className="overlay__title">
        <strong>{def?.label ?? type}</strong>
        <span>
          {type}
          {def && ` · ${def.category}`}
          {/* The one fact about a node that changes how you use it before you have used it. */}
          {def?.cost === 'expensive' && ' · runs on demand'}
        </span>
      </div>
      <OpenInWorkflow type={type} onOpened={onClose} />
      <a
        className="btn btn--ghost"
        href={NODE_GUIDE_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        Node guide ↗
      </a>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={onClose}
        title="Close (Esc)"
        aria-label="Close help"
      >
        ✕
      </button>
    </div>
  )
}

/**
 * "Open in a workflow": the same button the node guide's entries carry, doing the same thing one
 * step more directly.
 *
 * The guide is a static page, so its version is a `#!demo://` link that reloads the app and lets
 * `useShareLink` build the graph. In here there is nothing to navigate to — the builder is a
 * dynamic import away and `openDocument` is the same call that link ends in, so the workflow
 * opens in a document of its own beside whatever the reader already had.
 *
 * **Built without a plan**, unlike the link's. A plan is a fact about a guide *build*, and the
 * app has no build behind it; `demoGraph` searches instead, over every dataset it may build and
 * the synthetic one alone for anything it must score. See `wizard/demo.ts` for what that costs.
 *
 * The overlay closes on the way, because the thing it was describing is now on the canvas — and
 * a modal left open over it would have to be dismissed before the reader could look.
 */
function OpenInWorkflow({ type, onOpened }: { type: string; onOpened: () => void }) {
  const openDocument = useGraphStore((s) => s.openDocument)
  const [busy, setBusy] = useState(false)

  const open = useCallback(() => {
    setBusy(true)
    void (async () => {
      /*
       * Dynamic, on the pattern `useShareLink` and `ui/export.ts` follow: the builder drags in
       * the wizard and the inference pass for a button most sessions never press. It is the same
       * chunk the share link loads, so a reader who arrives by link pays for it once.
       */
      const { demoGraph } = await import('../../wizard/demo')
      const graph = demoGraph(type)
      setBusy(false)
      if (!graph) return
      openDocument(graph)
      onOpened()
    })()
  }, [type, openDocument, onOpened])

  /*
   * A bordered `.btn` where everything else in this header is a `.btn--ghost`. Back, Node guide
   * and ✕ are chrome — ways out of the overlay — and this is the one thing in it that *does*
   * something, so it is the one thing that looks like a button. The arrow is the node guide's,
   * on the same button, which is the whole of what makes the two read as one feature.
   */
  return (
    <button
      type="button"
      className="btn"
      onClick={open}
      disabled={busy}
      title="Build a workflow with this node in it, in a document of its own"
    >
      Open in a workflow
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <line x1="4" y1="12" x2="19" y2="12" />
        <polyline points="13,6 19,12 13,18" />
      </svg>
    </button>
  )
}

/**
 * The docstring convention, at the foot of the document where a reader who has finished is.
 *
 * The relation is `help/seeAlso.ts` — editorial, symmetric, and deliberately not the prose
 * cross-references, which are one-way and say why in the sentence around them. What it answers is
 * the question the sentences have stopped answering: *what is the other one of these*.
 *
 * **A table, the way numpydoc renders one**, rather than a row of chips: a name on its own asks
 * the reader to already know what Partner Vectors is, which is the thing they came here not
 * knowing. The second column is the registry's own `description` — the same sentence the palette
 * and the node browser show, so nothing is written twice and a node that rewords itself rewords
 * this too.
 *
 * That description is **inline markdown**, not text. They are written for the palette and several
 * name a column or a setting in backticks — Group By's says the aggregate is renamed
 * `<agg>_<column>` — which printed as text is a sentence with punctuation in it that is not
 * punctuation. Same reason a callout's title goes through the same parser, one component up.
 *
 * The name cell is the button, and it navigates **in place** through the same `onNavigate` a
 * cross-reference uses, so Back works across them and the reader keeps the trail they arrived on.
 * Only the name: a whole clickable row puts a click target under a sentence somebody is trying to
 * select, and the sentence is the half they are reading.
 *
 * Rendered only once the document is `ready`. Under "Loading…" it would be a table of links to
 * nowhere in particular, and under the no-document message it would be the only thing on screen.
 */
function SeeAlso({ type, onNavigate }: { type: string; onNavigate: (type: string) => void }) {
  const related = useMemo(
    () =>
      seeAlsoFor(type, (other) => getNodeDef(other)?.label ?? other).map((other) => ({
        type: other,
        label: getNodeDef(other)?.label ?? other,
        description: parseInline(getNodeDef(other)?.description ?? ''),
      })),
    [type],
  )
  if (!related.length) return null
  return (
    <section className="help-see">
      <h2 className="help-see__title">See also</h2>
      <div className="markdown__table-scroll">
        <table className="markdown__table help-see__table">
          <thead>
            <tr>
              <th scope="col">Node</th>
              <th scope="col">Description</th>
            </tr>
          </thead>
          <tbody>
            {related.map((entry) => (
              <tr key={entry.type}>
                <td>
                  <button
                    type="button"
                    className="help-see__item"
                    onClick={() => onNavigate(entry.type)}
                  >
                    {entry.label}
                  </button>
                </td>
                <td className="help-see__desc">
                  <MarkdownInlines nodes={entry.description} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function HelpBody({ type, onNavigate }: { type: string; onNavigate: (type: string) => void }) {
  const [doc, setDoc] = useState<HelpDoc | undefined>(undefined)
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    setState('loading')
    setDoc(undefined)
    void loadHelpDoc(type).then((loaded) => {
      if (!live) return
      setDoc(loaded)
      setState(loaded ? 'ready' : 'missing')
    })
    return () => {
      live = false
    }
  }, [type])

  /*
   * A hop through a cross-reference lands at the top of the new document, not at the scroll
   * position of the old one — which on a long page is somewhere in the middle of nothing.
   *
   * `scrollTop` rather than `scrollTo({ top: 0 })`: jsdom implements the property and not the
   * method, so the smarter call threw on mount and took the whole overlay down with it in every
   * component test. Nothing here wants smooth scrolling anyway.
   */
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [type])

  const def = getNodeDef(type)
  const options = useMemo<MarkdownRenderOptions>(
    () => ({
      renderFence: (fence) =>
        isFigureLang(fence.lang) ? (
          <FigureView figure={buildFigure(fence.lang, fence.text, { focusType: type })} />
        ) : undefined,
      resolveImage: helpImageUrl,
      onNavigate,
    }),
    [type, onNavigate],
  )

  return (
    <div className="overlay__main help-scroll" ref={scrollRef}>
      <article className="help-doc">
        {/*
         * The registry's own summary, above whatever the document says. It is the sentence the
         * node guide and the node browser already show, so a reader arriving from either sees
         * the same words rather than a second, subtly different opening — and a document is
         * free to begin with detail instead of re-introducing the node.
         *
         * Labelled, because an unlabelled opening paragraph reads as the start of the document
         * and gets read as such; what it actually is, is the part somebody in a hurry can stop
         * after. `guide` is held to two or three sentences by its own contract in `core/node.ts`,
         * which is what makes the label true.
         */}
        {def?.guide && (
          <p className="help-doc__lede">
            <span className="help-doc__tldr">TL;DR</span>
            {def.guide}
          </p>
        )}
        {state === 'loading' && <p className="help-doc__status">Loading…</p>}
        {state === 'missing' && (
          <p className="help-doc__status">There is no help document for this node yet.</p>
        )}
        {doc && (
          <MarkdownBlocks blocks={doc.blocks} className="help-doc__body" options={options} />
        )}
        {state === 'ready' && <SeeAlso type={type} onNavigate={onNavigate} />}
      </article>
    </div>
  )
}
