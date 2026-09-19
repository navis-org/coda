/**
 * An opened NeuronBridge match: the EM neuron and the LM image it matched, drawn as the reader asks.
 *
 * What is drawn is `data/neuronbridge/views.ts`' decision (`comparisonFor`); this file renders it.
 * Two things here are drawing rather than decision, and both are about stacking:
 *
 * - **A figure is a stack of same-sized images**, so the stack is sized to the first image's own
 *   aspect ratio and every layer fills it exactly. `object-fit: contain` would letterbox each layer
 *   inside a box of the wrong shape — and a `clip-path` in percentages then clips the letterbox
 *   rather than the image, missing the scale-bar corner it is there for.
 * - **A flipped layer stays hidden until its size is known**, since the corner clip is computed
 *   from it: drawn early, a mirrored scale bar flashes for a frame.
 *
 * Full screen is a portalled `Modal`, which renders into the fullscreen element when there is one
 * and stops the card's React events — click, double-click, context menu, bare keys — at its root.
 */

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'

import type { NbConfig, NbMethod } from '../../data/neuronbridge/client'
import { NB_APP, matchesPageUrl, searchPageUrl } from '../../data/neuronbridge/client'
import type { NbImage, NbMatch } from '../../data/neuronbridge/types'
import type {
  NbComparison,
  NbCompare,
  NbEmTint,
  NbFigure,
  NbLmView,
} from '../../data/neuronbridge/views'
import {
  COMPARE_MODES,
  LM_VIEWS,
  comparisonFor,
  cornerClip,
} from '../../data/neuronbridge/views'
import { isTypingTarget } from '../appShortcuts'
import { formatNumber } from '../format'
import { Modal } from '../Modal'
import { Pager } from './Pager'

/**
 * How an opened match is drawn. One object because the five travel together from the node's
 * params to every surface that draws a comparison, and each key *is* its param's id — so the
 * setter is `onParamChange` itself, and a sixth setting is one field rather than four signatures.
 */
export interface NbView {
  compare: NbCompare
  lmView: NbLmView
  emOpacity: number
  emTint: NbEmTint
  /** Hold an opened match above the tiles while they scroll. */
  freeze: boolean
}

export type SetView = <K extends keyof NbView>(key: K, value: NbView[K]) => void

/** A line's place in the tiles' order, `index` -1 when it is filtered out of them. */
interface LinePosition {
  index: number
  total: number
  onStep: (delta: -1 | 1) => void
}

export interface ComparisonProps {
  config: NbConfig
  /** The page's neuron, as NeuronBridge records it. */
  emImage: NbImage
  match: NbMatch
  method: NbMethod
  view: NbView
  onView: SetView
  /** Where this match's line is among the tiles, and how to step to its neighbours. */
  position: LinePosition
  /** Whether this match is pinned, and the toggle — the tile's ☆, offered where the image is. */
  pinned: boolean
  onPin: () => void
  onClose: () => void
}

/**
 * -1 or 1 for a bare ← or → outside a field, else undefined: the line-stepping rule, once, for the
 * card and full screen. A slider under focus keeps its arrows — it is `isTypingTarget`'s kind of
 * thing. What each caller does about propagation is its own.
 */
export function arrowStep(event: KeyboardEvent): -1 | 1 | undefined {
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return undefined
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return undefined
  if (isTypingTarget(event.target)) return undefined
  return event.key === 'ArrowLeft' ? -1 : 1
}

/** One option of a segmented switch. */
export interface SegmentOption<T extends string> {
  id: T
  label: string
  disabled?: boolean
  title?: string
}

/** A row of pressed/unpressed buttons choosing one of a few — the card's every either/or. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly SegmentOption<T>[]
  value: T | undefined
  onChange: (next: T) => void
}) {
  return (
    <span className="nbridge__switch" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </span>
  )
}

/**
 * ☆ Pin / ★ Pinned for the match on screen. Beside the image rather than only on its tile, since
 * scanning lines in full screen is exactly when the tile is out of sight.
 */
function PinButton({ pinned, onPin }: { pinned: boolean; onPin: () => void }) {
  return (
    <button
      type="button"
      className="profile__pin nbridge__pin"
      data-pinned={pinned || undefined}
      aria-pressed={pinned}
      title={pinned ? 'Unpin — remove from the Pinned port' : 'Pin — send to the Pinned port'}
      onClick={onPin}
    >
      {pinned ? '★ Pinned' : '☆ Pin'}
    </button>
  )
}

/** ‹ › 3 / 746 — the line stepper, shared by the card and full screen. */
function Stepper({ position }: { position: LinePosition }) {
  return (
    <span className="nbridge__stepper" title="← and → step through the lines">
      <Pager {...position} unit="line" />
    </span>
  )
}

/**
 * Images fetched ahead of being drawn, so stepping to the next line shows it at once.
 *
 * The bucket sends `Last-Modified` and an `ETag` and no `Cache-Control`, so a fetched image is
 * kept by the browser and the `<img>` that asks for it next is answered from there. Remembered
 * here so a step back and forth does not start the same request twice, and bounded, since a
 * reader scanning a neuron's 746 lines would otherwise hold every URL of the session.
 */
const preloaded = new Set<string>()
const PRELOAD_MEMORY = 300

export function preloadImages(urls: readonly string[]): void {
  for (const url of urls) {
    if (preloaded.has(url)) continue
    preloaded.add(url)
    if (preloaded.size > PRELOAD_MEMORY) preloaded.delete(preloaded.values().next().value!)
    const image = new Image()
    image.decoding = 'async'
    image.src = url
  }
}

/** A match's score as the card prints it: CDS's score, or PPPM's rank counted from one. */
export function scoreText(match: NbMatch, method: NbMethod): string {
  if (method === 'pppm') return match.pppmRank === undefined ? '—' : `#${match.pppmRank + 1}`
  return match.normalizedScore === undefined
    ? '—'
    : formatNumber(Math.round(match.normalizedScore))
}

/** The opacity of an overlay's EM layer: what is drawn now, a drag in progress, and its end. */
interface Opacity {
  value: number
  onDraft: (next: number) => void
  onCommit: (next: number) => void
}

export function Comparison(props: ComparisonProps) {
  const { config, emImage, match, method, view, onView, onClose } = props
  const plan = comparisonFor(config, emImage, match, method, view.compare, view.lmView)
  const [full, setFull] = useState<NbFigure['id'] | undefined>(undefined)
  // The opacity being dragged, drawn live and written once on release (`OpacitySlider`).
  const [draft, setDraft] = useState<number | undefined>(undefined)
  const opacity: Opacity = {
    value: draft ?? view.emOpacity,
    onDraft: setDraft,
    onCommit: (next) => {
      if (next !== view.emOpacity) onView('emOpacity', next)
      setDraft(undefined)
    },
  }
  const line = match.image.publishedName

  /*
   * Opened, the comparison takes the keyboard focus unless something in the card already has it.
   * Chrome focuses a clicked button and Safari does not, so without this ← and → would work after
   * a click in one browser and go to the page body in the other.
   */
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = root.current
    if (el && !el.closest('.nbridge')?.contains(document.activeElement)) {
      el.focus({ preventScroll: true })
    }
  }, [])

  return (
    <div
      ref={root}
      className="nbridge__detail"
      role="region"
      aria-label={`Match ${line}`}
      tabIndex={-1}
    >
      <div className="nbridge__detail-head">
        <Stepper position={props.position} />
        <strong className="nbridge__detail-line">{line}</strong>
        <span className="nbridge__muted">{scoreText(match, method)}</span>
        <PinButton pinned={props.pinned} onPin={props.onPin} />
        <span className="profile__spacer" />
        <label
          className="nbridge__freeze"
          title="Keep this comparison above the tiles while they scroll"
        >
          <input
            type="checkbox"
            checked={view.freeze}
            onChange={(e) => onView('freeze', e.target.checked)}
          />
          Keep in view
        </label>
        <button
          type="button"
          className="nbridge__close"
          aria-label="Close comparison"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <CompareControls view={view} onView={onView} plan={plan} opacity={opacity} />
      <div
        className="nbridge__pair"
        style={{ '--nb-figures': plan.figures.length } as CSSProperties}
      >
        {plan.figures.map((figure) => (
          <figure key={figure.id} className="nbridge__figure">
            <button
              type="button"
              className="nbridge__open"
              title="Show full screen"
              aria-label={`Show ${figure.caption} full screen`}
              onClick={() => setFull(figure.id)}
            >
              <Stack figure={figure} emOpacity={opacity.value} emTint={view.emTint} />
            </button>
            <figcaption>{figure.caption}</figcaption>
          </figure>
        ))}
      </div>
      {plan.note && <div className="nbridge__note">{plan.note}</div>}
      <MatchFacts match={match} method={method} emImage={emImage} />
      {full && (
        <FullScreen
          {...props}
          plan={plan}
          opacity={opacity}
          figureId={full}
          onFigure={setFull}
          onClose={() => setFull(undefined)}
        />
      )}
    </div>
  )
}

const TINTS: readonly SegmentOption<NbEmTint>[] = [
  { id: 'white', label: 'EM white' },
  { id: 'colour', label: 'EM in colour' },
]

function CompareControls({
  view,
  onView,
  plan,
  opacity,
}: {
  view: NbView
  onView: SetView
  plan: NbComparison
  opacity: Opacity
}) {
  const overlay = view.compare === 'overlay'
  return (
    <div className="nbridge__compare">
      <Segmented
        label="Compare"
        options={COMPARE_MODES}
        value={view.compare}
        onChange={(next) => onView('compare', next)}
      />
      <Segmented
        label="LM image"
        options={LM_VIEWS.map((v) =>
          plan.lmViews.includes(v.id)
            ? v
            : {
                ...v,
                disabled: true,
                title: 'PPPM publishes its hit on grey, which cannot be laid over the line.',
              },
        )}
        value={plan.lmView}
        onChange={(next) => onView('lmView', next)}
      />
      {overlay && (
        <Segmented
          label="EM drawn in"
          options={plan.emOpacity ? TINTS : TINTS.map((t) => ({ ...t, disabled: true }))}
          value={view.emTint}
          onChange={(next) => onView('emTint', next)}
        />
      )}
      {overlay && (
        <OpacitySlider
          opacity={opacity}
          disabled={!plan.emOpacity}
          title={
            plan.emOpacity
              ? 'How strongly the EM neuron is drawn over the LM image'
              : 'PPPM’s overlay is drawn by NeuronBridge, EM skeleton included'
          }
        />
      )}
    </div>
  )
}

/**
 * The EM opacity, dragged locally and written on release.
 *
 * Writing the param on every `input` event would make a drag a hundred edits — a hundred undo steps
 * and a hundred document saves for one gesture.
 */
function OpacitySlider({
  opacity,
  disabled,
  title,
}: {
  opacity: Opacity
  disabled: boolean
  title: string
}) {
  const commit = () => opacity.onCommit(opacity.value)
  return (
    <label className="nbridge__slider" title={title}>
      EM
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={opacity.value}
        disabled={disabled}
        aria-label="EM opacity"
        onChange={(e) => opacity.onDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="nbridge__count">{Math.round(opacity.value * 100)}%</span>
    </label>
  )
}

/** One figure: its layers stacked in a box of the images' own aspect ratio. */
function Stack({
  figure,
  emOpacity,
  emTint,
}: {
  figure: NbFigure
  emOpacity: number
  emTint: NbEmTint
}) {
  // Keyed on the layers, so a figure of another geometry — PPPM's 1427 × 668 after CDS's 1210 × 566
  // — measures afresh rather than inheriting the last one's ratio and clip.
  return (
    <StackOf
      key={figure.layers.map((l) => l.url).join('|')}
      figure={figure}
      emOpacity={emOpacity}
      emTint={emTint}
    />
  )
}

function StackOf({
  figure,
  emOpacity,
  emTint,
}: {
  figure: NbFigure
  emOpacity: number
  emTint: NbEmTint
}) {
  const [size, setSize] = useState<[number, number] | undefined>(undefined)
  if (figure.layers.length === 0) {
    return <span className="nbridge__stack nbridge__stack--empty">no image published</span>
  }
  const ratio = size ? size[0] / size[1] : 1210 / 566
  const clip = size ? cornerClip(size[0], size[1]) : undefined
  return (
    <span className="nbridge__stack" style={{ '--nb-ratio': ratio } as CSSProperties}>
      {figure.layers.map((layer, index) => (
        <img
          key={`${index}|${layer.url}`}
          className="nbridge__layer"
          src={layer.url}
          alt={index === 0 ? figure.caption : ''}
          draggable={false}
          data-flip={layer.flip}
          data-grey={layer.grey}
          data-lighten={layer.lighten}
          data-tint={layer.em ? emTint : undefined}
          onLoad={
            index === 0
              ? (e) => setSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])
              : undefined
          }
          style={{
            ...(layer.hideCorner && clip ? { clipPath: clip } : {}),
            ...(layer.hideCorner && !clip ? { visibility: 'hidden' } : {}),
            ...(layer.em ? { opacity: emOpacity } : {}),
          }}
        />
      ))}
    </span>
  )
}

function MatchFacts({
  match,
  method,
  emImage,
}: {
  match: NbMatch
  method: NbMethod
  emImage: NbImage
}) {
  const line = match.image.publishedName
  const facts: Array<[string, string]> = [
    ['Collection', match.image.libraryName],
    ['Sample', match.image.slideCode ?? '—'],
    ['Objective', match.image.objective ?? '—'],
    [method === 'pppm' ? 'Rank' : 'Score', scoreText(match, method)],
  ]
  if (method === 'cds' && match.matchingPixels !== undefined) {
    facts.push(['Matching pixels', formatNumber(match.matchingPixels)])
  }
  if (match.mirrored) facts.push(['Mirrored', 'yes'])
  const matchesPage = matchesPageUrl(emImage, method)
  return (
    <div className="nbridge__facts-row">
      <dl className="nbridge__dl">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <span className="profile__spacer" />
      <a href={searchPageUrl(line)} target="_blank" rel="noreferrer noopener">
        {line} in NeuronBridge ↗
      </a>
      {matchesPage && (
        <a href={matchesPage} target="_blank" rel="noreferrer noopener">
          All matches ↗
        </a>
      )}
    </div>
  )
}

function FullScreen(
  props: ComparisonProps & {
    plan: NbComparison
    opacity: Opacity
    figureId: NbFigure['id']
    onFigure: (id: NbFigure['id']) => void
  },
) {
  const { plan, opacity, figureId, onFigure, onClose, match, method, emImage, view, onView } =
    props
  // Focused on arrival, so ← and → step lines from the first key.
  const inner = useRef<HTMLDivElement>(null)
  useEffect(() => inner.current?.focus(), [])

  // A mode without this figure (EM, after switching to Overlay) shows the one that remains.
  const figure = plan.figures.find((f) => f.id === figureId) ?? plan.figures[0]

  return (
    <Modal
      portal
      rootClassName="nbridge-full"
      className="nbridge-full__panel"
      label={figure ? figure.caption : 'Comparison'}
      onClose={onClose}
    >
      <div
        ref={inner}
        className="nbridge-full__inner"
        tabIndex={-1}
        onKeyDown={(e) => {
          // ← and → step through the lines, as on the card, keeping whichever image is full
          // screen — which is the point: scanning lines by their LM image alone.
          const delta = arrowStep(e)
          if (delta === undefined) return
          e.preventDefault()
          props.position.onStep(delta)
        }}
      >
        <div className="nbridge-full__head">
          <Stepper position={props.position} />
          <strong>{figure?.caption}</strong>
          <PinButton pinned={props.pinned} onPin={props.onPin} />
          <span className="profile__spacer" />
          {plan.figures.length > 1 && (
            <Segmented
              label="Figure"
              options={plan.figures.map((f) => ({ id: f.id, label: f.id.toUpperCase() }))}
              value={figure?.id}
              onChange={onFigure}
            />
          )}
          <button
            type="button"
            className="nbridge__close"
            aria-label="Close full screen"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div
          className="nbridge-full__stage"
          onClick={(e) => e.target === e.currentTarget && onClose()}
        >
          {figure && <Stack figure={figure} emOpacity={opacity.value} emTint={view.emTint} />}
        </div>
        <div className="nbridge-full__foot">
          <CompareControls view={view} onView={onView} plan={plan} opacity={opacity} />
          <MatchFacts match={match} method={method} emImage={emImage} />
          {plan.note && <div className="nbridge__note">{plan.note}</div>}
          <span className="nbridge__muted">
            Images:{' '}
            <a href={NB_APP} target="_blank" rel="noreferrer noopener">
              NeuronBridge
            </a>
            , FlyLight · Janelia
          </span>
        </div>
      </div>
    </Modal>
  )
}
