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
import { useGraphStore } from '../../store/graphStore'
import { MarkdownBlocks } from '../MarkdownView'
import type { MarkdownRenderOptions } from '../MarkdownView'
import { FigureView } from './FigureView'

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

  // Capture-phase, and stopped, so the canvas underneath does not also act on the key — the
  // same arrangement `ViewerOverlay` uses, and for the same reason.
  useEffect(() => {
    if (!helpType) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [helpType, close])

  if (!helpType || !current) return null
  return (
    <div className="overlay" role="presentation" onPointerDown={close}>
      <div
        className="overlay__panel help-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${getNodeDef(current)?.label ?? current} help`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <HelpHeader
          type={current}
          canGoBack={trail.length > 1}
          onBack={() => setTrail((t) => t.slice(0, -1))}
          onClose={close}
        />
        <HelpBody type={current} onNavigate={(next) => setTrail((t) => [...t, next])} />
      </div>
    </div>
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
      </article>
    </div>
  )
}
