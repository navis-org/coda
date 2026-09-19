/**
 * The NeuronBridge card: one neuron per page, the light-microscopy lines that match it as tiles.
 *
 * Laid out like Neuron Profile, whose pager it shares (`Pager`) and whose `profile__` row classes it
 * borrows: pager and name, then what NeuronBridge knows about the neuron, then the tiles.
 *
 * **One tile per line, at its best image** (`groupByLine`), because a line is what people ask for
 * and ranked by image the first screen repeats itself. The other images of a line are one click
 * away and are drawn *only* then — every tile is an `<img>` from Janelia's bucket, so an image not
 * shown is a request not made. Lines arrive the same way: the first `tiles`, then more on request.
 *
 * **A line's tiles re-render only when something about that line changed.** ← and → step the
 * selection through hundreds of lines at key-repeat rate, so `LineTiles` is memoised on primitives
 * and on callbacks that never change identity; a step re-renders the two lines it left and reached.
 *
 * **Thumbnails and full images come from different buckets, and only one answers CORS.** The
 * thumbnail bucket sends no `Access-Control-Allow-Origin`, which an `<img>` does not need and a
 * canvas would; nothing here draws to a canvas, and the CSV export carries names and scores, not
 * pictures.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { NeuronId } from '../../core/ids'
import { ID_COLUMN_NAME, idText } from '../../core/ids'
import { column, findColumn, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { getColumn, tableFromRows } from '../../core/values'
import type { NbConfig, NbMethod } from '../../data/neuronbridge/client'
import {
  fileUrl,
  hasMatches,
  matchesPageUrl,
  versionLabel,
} from '../../data/neuronbridge/client'
import type { NbCollection, NbLine } from '../../data/neuronbridge/matches'
import {
  COLLECTIONS,
  collectionCounts,
  collectionOf,
  collectionShort,
  groupByLine,
} from '../../data/neuronbridge/matches'
import type { NbImage, NbMatch } from '../../data/neuronbridge/types'
import { comparisonFor } from '../../data/neuronbridge/views'
import type { NbPin } from '../../nodes/lib/neuronbridgePins'
import {
  decodePin,
  encodePin,
  pinKey,
  pinnedTable,
  readPins,
} from '../../nodes/lib/neuronbridgePins'
import { idColumn } from '../../nodes/lib/tableOps'
import { tableToCsvParts } from '../export'
import { formatNumber, plural } from '../format'
import { useLatest } from '../useLatest'
import type { NbView, SetView } from './NeuronBridgeCompare'
import {
  Comparison,
  Segmented,
  arrowStep,
  preloadImages,
  scoreText,
} from './NeuronBridgeCompare'
import { Pager } from './Pager'
import { useNeuronBridgeLookup, useNeuronBridgeMatches } from './useNeuronBridge'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import { ViewerEmpty } from './ViewerEmpty'

export interface NeuronBridgeViewerProps {
  /** The incoming neuron table, paged through one neuron at a time. */
  neurons: TableValue | undefined
  sourceId: string | undefined
  datasetId: string | undefined
  page: number
  onPage: (next: number) => void
  method: NbMethod
  onMethod: (next: NbMethod) => void
  /** Collection ids ticked; see `COLLECTIONS`. */
  collections: readonly string[]
  onCollections: (next: string[]) => void
  /** Lines shown at first, and added by each "Show more". */
  tiles: number
  /** The pinned data version, or empty for NeuronBridge's current one. */
  version: string
  /** The stored `pins` param, one encoded match per entry. */
  pins: readonly string[]
  onPins: (next: string[]) => void
  /** How an opened match is drawn; see `NbView`. */
  view: NbView
  onView: SetView
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

const NAME_COLUMNS = ['instance', 'type', 'cell_type', 'name'] as const

/** How long the selection must rest before its neighbours are fetched ahead. */
const PRELOAD_SETTLE_MS = 150

/** What the table calls a neuron, for the header before NeuronBridge has answered. */
function tableName(neurons: TableValue, neuronId: NeuronId): string {
  const row = getColumn(neurons, ID_COLUMN_NAME).findIndex((cell) => idText(cell) === neuronId)
  if (row < 0) return ''
  for (const name of NAME_COLUMNS) {
    if (!findColumn(neurons.schema, name)) continue
    const value = getColumn(neurons, name)[row]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function NeuronBridgeViewer(props: NeuronBridgeViewerProps) {
  const { neurons, page, datasetId } = props
  const hasIds = !!neurons && !!findColumn(neurons.schema, ID_COLUMN_NAME)
  // The table's ids in its order, each once — `idColumn`'s rule per cell (invariant 8).
  const ids = useMemo(
    () => (neurons && hasIds ? [...new Set(idColumn(neurons))] : []),
    [neurons, hasIds],
  )
  const total = ids.length
  const index = total > 0 ? Math.min(Math.max(0, Math.floor(page)), total - 1) : 0
  const neuronId = ids[index]
  const fallbackName = useMemo(
    () => (neurons && neuronId !== undefined ? tableName(neurons, neuronId) : ''),
    [neurons, neuronId],
  )

  if (!neurons) {
    return (
      <ViewerEmpty>Connect a table of neurons to see their NeuronBridge matches.</ViewerEmpty>
    )
  }
  if (!hasIds) {
    return <ViewerEmpty>The incoming table has no neuronId column.</ViewerEmpty>
  }
  if (total === 0 || neuronId === undefined) {
    return <ViewerEmpty>No neurons in the incoming table.</ViewerEmpty>
  }
  return (
    <NeuronBridgePage
      // Keyed on the neuron, so paging resets what was expanded, selected and shown.
      key={`${datasetId ?? ''}|${neuronId}`}
      {...props}
      neuronId={neuronId}
      index={index}
      total={total}
      fallbackName={fallbackName}
    />
  )
}

interface PageProps extends NeuronBridgeViewerProps {
  neuronId: NeuronId
  index: number
  total: number
  fallbackName: string
}

function NeuronBridgePage(props: PageProps) {
  const {
    sourceId,
    datasetId,
    neuronId,
    index,
    total,
    onPage,
    fallbackName,
    method,
    onMethod,
    collections,
    onCollections,
    tiles,
    version,
    pins,
    onPins,
    view,
    onView,
    baseName,
    compact = false,
    onExpand,
    onError,
  } = props

  const found = useNeuronBridgeLookup(sourceId, datasetId, neuronId, version)
  const neuron = found.status === 'ready' ? found.data : undefined
  const records = neuron?.records ?? []

  // A dataset spanning brain and nerve cord can hold one record per area; the first is the default.
  const [areaIndex, setAreaIndex] = useState(0)
  const record: NbImage | undefined = records[Math.min(areaIndex, records.length - 1)]
  const pppmHere = record ? hasMatches(record, 'pppm') : false
  // A PPPM choice carried to a neuron without PPPM falls back to CDS for display, not in the param.
  const shownMethod: NbMethod = method === 'pppm' && record && !pppmHere ? 'cds' : method

  const matches = useNeuronBridgeMatches(neuron?.version, record, shownMethod)
  const results = matches.status === 'ready' ? matches.data.results : undefined

  // Keyed on the contents: `ValuePreview` hands a fresh array per render (`idList` copies), and
  // regrouping ~2,000 matches on every render of the card is what this memo exists to avoid.
  const tickedKey = collections.join('|')
  const ticked = useMemo(
    () => new Set(tickedKey ? (tickedKey.split('|') as NbCollection[]) : []),
    [tickedKey],
  )
  const lines = useMemo(
    () => (results ? groupByLine(results, shownMethod, ticked) : []),
    [results, shownMethod, ticked],
  )
  const counts = useMemo(() => (results ? collectionCounts(results) : undefined), [results])

  const [shown, setShown] = useState(tiles)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [selected, setSelected] = useState<NbMatch | undefined>(undefined)

  const pinsKey = pins.join('\n')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the contents, as above
  const pinnedKeys = useMemo(() => new Set(readPins(pins).map(pinKey)), [pinsKey])
  const isPinned = (match: NbMatch) =>
    pinnedKeys.has(pinKey({ neuronId, method: shownMethod, lmImageId: match.image.id }))

  const name = record?.neuronInstance ?? record?.neuronType ?? fallbackName

  const togglePin = (match: NbMatch) => {
    if (!record || !neuron) return
    const pin: NbPin = {
      neuronId,
      line: match.image.publishedName,
      collection: match.image.libraryName,
      method: shownMethod,
      score: (shownMethod === 'pppm' ? match.pppmScore : match.normalizedScore) ?? null,
      pppmRank: match.pppmRank ?? null,
      matchingPixels: match.matchingPixels ?? null,
      mirrored: match.mirrored,
      area: record.anatomicalArea,
      slideCode: match.image.slideCode ?? '',
      objective: match.image.objective ?? '',
      lmImageId: match.image.id,
      emLibrary: record.libraryName,
      nbVersion: neuron.version,
    }
    const key = pinKey(pin)
    onPins(
      pinnedKeys.has(key)
        ? pins.filter((entry) => {
            const held = decodePin(entry)
            return !held || pinKey(held) !== key
          })
        : [...pins, encodePin(pin)],
    )
  }

  /*
   * The tiles' callbacks, one identity for the card's life, reading the render they are called
   * from — what lets `LineTiles` skip a render when its line did not change.
   */
  const latest = useLatest({ togglePin })
  const onTilePin = useCallback((match: NbMatch) => latest.current.togglePin(match), [latest])
  const onTileExpand = useCallback(
    (line: string) =>
      setExpanded((held) => {
        const next = new Set(held)
        if (next.has(line)) next.delete(line)
        else next.add(line)
        return next
      }),
    [],
  )

  const toggleCollection = (id: NbCollection) => {
    // Written back in the chips' own order, so a round trip does not reorder a saved file.
    onCollections(
      COLLECTIONS.map((c) => c.id).filter((c) => (c === id ? !ticked.has(c) : ticked.has(c))),
    )
  }

  const exportSource: ExportSource = {
    csv: () => (lines.length ? tableToCsvParts(linesTable(neuronId, lines, shownMethod)) : []),
    tables: [
      {
        id: 'pinned',
        label: 'Pinned matches (CSV)',
        /*
         * Every neuron's pins, not only this page's — and through `pinnedTable`, the function the
         * Pinned port is built by, so the file and the port cannot disagree about a column.
         */
        csv: () => {
          const held = readPins(pins)
          if (held.length === 0) throw new Error('Nothing is pinned yet — ☆ a match to pin it.')
          return tableToCsvParts(pinnedTable(held))
        },
      },
    ],
  }

  const matchesPage = record ? matchesPageUrl(record, shownMethod) : undefined

  /*
   * Stepping through lines with ← and →, for scanning a neuron's matches quickly — from the card,
   * the expanded card and full screen alike (full screen calls `step` itself).
   *
   * The step is over **lines**, the tiles' own order under the ticked collections, never over
   * images: an opened second image of a line steps to the *next line's* best, since a reader
   * scanning for a driver line wants the next line, not the same one again. Stepping past the
   * lines on screen shows the next batch, as "Show more" would.
   */
  const at = selected ? lines.findIndex((l) => l.images.includes(selected)) : -1
  const scroll = useRef<HTMLDivElement>(null)
  const reveal = useRef<string | undefined>(undefined)
  const step = (delta: -1 | 1) => {
    if (lines.length === 0) return
    const from = at < 0 ? (delta > 0 ? -1 : lines.length) : at
    const to = Math.min(lines.length - 1, Math.max(0, from + delta))
    if (to === at) return
    if (to >= shown) setShown(Math.ceil((to + 1) / tiles) * tiles)
    reveal.current = lines[to]!.line
    setSelected(lines[to]!.best)
  }

  // The tile just stepped to, scrolled into view inside the tile list — by hand, not
  // `scrollIntoView`, which would also scroll the canvas's overflow-hidden ancestors.
  useEffect(() => {
    const line = reveal.current
    const container = scroll.current
    if (!line || !container) return
    reveal.current = undefined
    const tile = [...container.querySelectorAll<HTMLElement>('[data-line]')].find(
      (el) => el.dataset.line === line,
    )
    if (tile) revealIn(container, tile)
  }, [selected, shown])

  /*
   * The next two lines and the previous one, fetched ahead as they would be drawn, so a step
   * shows its images at once rather than a black frame while they load. Only once the selection
   * rests: a held arrow key passes lines nobody looks at, and a started image load cannot be taken
   * back — the lookup's settle, `useSettledFetch`'s, for the same reason.
   */
  useEffect(() => {
    if (!neuron || !record || at < 0) return
    const timer = setTimeout(() => {
      const neighbours = [lines[at + 1], lines[at + 2], lines[at - 1]].filter(
        (l) => l !== undefined,
      )
      preloadImages(
        neighbours.flatMap((l) =>
          comparisonFor(
            neuron.config,
            record,
            l.best,
            shownMethod,
            view.compare,
            view.lmView,
          ).figures.flatMap((f) => f.layers.map((layer) => layer.url)),
        ),
      )
    }, PRELOAD_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [neuron, record, lines, at, shownMethod, view.compare, view.lmView])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const delta = selected ? arrowStep(event) : undefined
    if (delta === undefined) return
    // Owned here: React Flow moves a selected node with the arrows, from the node wrapper above.
    event.preventDefault()
    event.stopPropagation()
    step(delta)
  }

  const comparison =
    neuron && selected && record ? (
      <Comparison
        config={neuron.config}
        emImage={record}
        match={selected}
        method={shownMethod}
        view={view}
        onView={onView}
        position={{ index: at, total: lines.length, onStep: step }}
        pinned={isPinned(selected)}
        onPin={() => togglePin(selected)}
        onClose={() => setSelected(undefined)}
      />
    ) : undefined
  // Frozen, the comparison sits above the scrolling tiles; otherwise it scrolls away with them.
  const frozen = view.freeze && comparison !== undefined
  const selectedLine = at >= 0 ? lines[at] : undefined

  return (
    <div
      className="viewer nbridge nodrag"
      data-compact={compact || undefined}
      onKeyDown={onKeyDown}
    >
      <div className="profile__pager">
        <Pager index={index} total={total} onStep={(d) => onPage(index + d)} unit="neuron" />
        <span className="profile__name" title={name || neuronId}>
          {name || '—'}
        </span>
        <span className="profile__id">{neuronId}</span>
        <span className="profile__spacer" />
        {matchesPage && (
          <a
            className="nbridge__out"
            href={matchesPage}
            target="_blank"
            rel="noreferrer noopener"
            title="This neuron’s matches on neuronbridge.janelia.org"
          >
            NeuronBridge ↗
          </a>
        )}
      </div>
      <div className="nbridge__body">
        <div className="nbridge__top">
          <Status
            found={found}
            record={record}
            method={method}
            shownMethod={shownMethod}
            matches={matches}
          />
          {neuron && record && (
            <div className="nbridge__meta">
              <Thumb
                src={fileUrl(neuron.config, record.files, 'CDMThumbnail')}
                alt={`${neuronId} colour-depth projection`}
              />
              <div className="nbridge__facts">
                <div>
                  {record.libraryName.replace(/_/g, ' ')} · {record.anatomicalArea} ·
                  NeuronBridge {versionLabel(neuron.version)}
                </div>
                {results && (
                  <div className="nbridge__muted">
                    {plural(lines.length, 'line')} from {plural(results.length, 'image')}
                  </div>
                )}
                {neuron.libraries.versionMismatch && (
                  <div className="nbridge__note" role="note">
                    Matched against {neuron.libraries.nbVersion}; this dataset is{' '}
                    {neuron.libraries.datasetVersion}. A body edited since may be shown with its
                    old shape.
                  </div>
                )}
              </div>
            </div>
          )}
          {neuron && record && (
            <div className="nbridge__controls">
              {COLLECTIONS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="nbridge__chip"
                  aria-pressed={ticked.has(c.id)}
                  title={c.label}
                  onClick={() => toggleCollection(c.id)}
                >
                  {c.short}
                  {counts && (
                    <span className="nbridge__count">
                      {formatNumber(counts.get(c.id) ?? 0)}
                    </span>
                  )}
                </button>
              ))}
              <span className="profile__spacer" />
              {records.length > 1 && (
                <Segmented
                  label="Area"
                  options={records.map((r) => ({ id: r.id, label: r.anatomicalArea }))}
                  value={record.id}
                  onChange={(id) => {
                    setAreaIndex(records.findIndex((r) => r.id === id))
                    setSelected(undefined)
                  }}
                />
              )}
              {pppmHere && (
                <Segmented
                  label="Method"
                  options={[
                    { id: 'cds', label: 'CDS' },
                    { id: 'pppm', label: 'PPPM' },
                  ]}
                  value={shownMethod}
                  onChange={(m) => {
                    onMethod(m)
                    setSelected(undefined)
                  }}
                />
              )}
            </div>
          )}
          {frozen && comparison}
        </div>
        <div className="nbridge__scroll" ref={scroll}>
          {!frozen && comparison}
          {neuron && results && (
            <>
              {lines.length === 0 ? (
                <div className="nbridge__empty">
                  {results.length === 0
                    ? 'NeuronBridge found no matches for this neuron.'
                    : 'No matches in the ticked collections.'}
                </div>
              ) : (
                <div className="nbridge__grid">
                  {lines.slice(0, shown).map((line) => (
                    <LineTiles
                      key={line.line}
                      line={line}
                      config={neuron.config}
                      method={shownMethod}
                      expanded={expanded.has(line.line)}
                      onExpand={onTileExpand}
                      // Only the line holding the selection is handed it, so every other line's
                      // props are unchanged by a step and it skips the render.
                      selected={line === selectedLine ? selected : undefined}
                      onSelect={setSelected}
                      pinnedKeys={pinnedKeys}
                      pinPrefix={`${neuronId}|${shownMethod}|`}
                      onPin={onTilePin}
                    />
                  ))}
                </div>
              )}
              {lines.length > shown && (
                <div className="nbridge__more">
                  <span className="nbridge__muted">
                    Showing {formatNumber(shown)} of {plural(lines.length, 'line')}
                  </span>
                  <button
                    type="button"
                    className="tile__link"
                    onClick={() => setShown((n) => n + tiles)}
                  >
                    Show more
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {/* The caption bar every viewer ends on: it right-aligns ⤓, whose menu opens leftwards from
          the button's right edge — bare at the card's foot it sat left and the menu was clipped. */}
      <div className="viewer__caption">
        <span>
          {pinnedKeys.size > 0 ? `${plural(pinnedKeys.size, 'match', 'matches')} pinned` : ''}
        </span>
        <ViewerActions
          baseName={baseName ?? 'neuronbridge'}
          source={exportSource}
          compact={compact}
          {...(onExpand ? { onExpand } : {})}
          {...(onError ? { onError } : {})}
        />
      </div>
    </div>
  )
}

/** An image that may not exist, drawn as a labelled gap rather than a broken-image icon. */
function Thumb({ src, alt }: { src: string | undefined; alt: string }) {
  return (
    <div className="nbridge__em">
      {src ? (
        <img src={src} alt={alt} loading="lazy" draggable={false} />
      ) : (
        <span>no image</span>
      )}
    </div>
  )
}

function Status({
  found,
  record,
  method,
  shownMethod,
  matches,
}: {
  found: ReturnType<typeof useNeuronBridgeLookup>
  record: NbImage | undefined
  method: NbMethod
  shownMethod: NbMethod
  matches: ReturnType<typeof useNeuronBridgeMatches>
}) {
  let text: string | undefined
  let error = false
  if (found.status === 'uncovered') {
    text = 'NeuronBridge has no matches for this dataset.'
  } else if (found.status === 'loading') {
    text = 'Looking this neuron up in NeuronBridge…'
  } else if (found.status === 'error') {
    text = found.message
    error = true
  } else if (found.status === 'ready' && !record) {
    text =
      'NeuronBridge has no record of this neuron. It indexes the neurons it could render, ' +
      'not every segment.'
  } else if (record && method !== shownMethod) {
    text = 'PPPM matches exist for hemibrain only; showing colour depth search.'
  } else if (record && !hasMatches(record, shownMethod)) {
    text = `NeuronBridge has no ${shownMethod.toUpperCase()} matches for this neuron.`
  } else if (matches.status === 'loading') {
    text = 'Loading matches (about 3 MB)…'
  } else if (matches.status === 'error') {
    text = matches.message
    error = true
  }
  if (!text) return null
  return (
    <div className={error ? 'profile__error' : 'nbridge__status'} role="status">
      {text}
    </div>
  )
}

/**
 * A line's best image, and its other images when expanded.
 *
 * Memoised, and every prop is a primitive, an object that only changes with its line, or a
 * callback that never changes — so a step through the lines re-renders the two it touched.
 */
const LineTiles = memo(function LineTiles({
  line,
  config,
  method,
  expanded,
  onExpand,
  selected,
  onSelect,
  pinnedKeys,
  pinPrefix,
  onPin,
}: {
  line: NbLine
  config: NbConfig
  method: NbMethod
  expanded: boolean
  onExpand: (line: string) => void
  /** The open match, when it is one of this line's images. */
  selected: NbMatch | undefined
  onSelect: (match: NbMatch) => void
  pinnedKeys: ReadonlySet<string>
  /** `pinKey` less the image id — the part every match on this page shares. */
  pinPrefix: string
  onPin: (match: NbMatch) => void
}) {
  const others = line.images.length - 1
  const pinned = (match: NbMatch) => pinnedKeys.has(pinPrefix + match.image.id)
  return (
    <>
      <Tile
        match={line.best}
        config={config}
        method={method}
        selected={selected === line.best}
        onSelect={onSelect}
        pinned={pinned(line.best)}
        onPin={onPin}
        extra={
          others > 0 && (
            <button
              type="button"
              className="nbridge__others"
              aria-expanded={expanded}
              title={
                expanded ? 'Hide this line’s other images' : 'Show this line’s other images'
              }
              onClick={() => onExpand(line.line)}
            >
              {expanded ? '−' : '+'}
              {others}
            </button>
          )
        }
      />
      {expanded &&
        line.images
          .slice(1)
          .map((match) => (
            <Tile
              key={match.image.id}
              match={match}
              config={config}
              method={method}
              secondary
              selected={selected === match}
              onSelect={onSelect}
              pinned={pinned(match)}
              onPin={onPin}
            />
          ))}
    </>
  )
})

/** The LM thumbnail a match is drawn with: the image's own for CDS, PPPM's best rendering. */
function matchThumb(config: NbConfig, match: NbMatch, method: NbMethod): string | undefined {
  return method === 'pppm'
    ? fileUrl(config, match.files, 'CDMBestThumbnail')
    : fileUrl(config, match.image.files, 'CDMThumbnail')
}

function Tile({
  match,
  config,
  method,
  secondary = false,
  selected,
  onSelect,
  pinned,
  onPin,
  extra,
}: {
  match: NbMatch
  config: NbConfig
  method: NbMethod
  secondary?: boolean
  selected: boolean
  onSelect: (match: NbMatch) => void
  pinned: boolean
  onPin: (match: NbMatch) => void
  extra?: React.ReactNode
}) {
  const src = matchThumb(config, match, method)
  const line = match.image.publishedName
  const collection = collectionShort(collectionOf(match.image.libraryName))
  return (
    <div
      className="nbridge__tile"
      data-secondary={secondary || undefined}
      // A line's own tile, which stepping scrolls to; its other images are not stops.
      data-line={secondary ? undefined : match.image.publishedName}
      data-selected={selected || undefined}
    >
      <button
        type="button"
        className="nbridge__thumb"
        title={`${line} · ${match.image.slideCode ?? ''} — open`}
        onClick={() => onSelect(match)}
      >
        {src ? (
          <img
            src={src}
            alt={`${line} colour-depth projection`}
            loading="lazy"
            draggable={false}
          />
        ) : (
          <span className="nbridge__muted">no image</span>
        )}
      </button>
      <div className="nbridge__tile-foot">
        <span className="nbridge__line" title={line}>
          {line}
        </span>
        <span className="nbridge__score" title={method === 'pppm' ? 'PPPM rank' : 'CDS score'}>
          {scoreText(match, method)}
        </span>
      </div>
      <div className="nbridge__tile-foot">
        <span className="nbridge__badge" title={match.image.libraryName}>
          {collection}
        </span>
        {match.mirrored && (
          <span className="nbridge__mirror" title="Matched against the mirrored image">
            ⇋
          </span>
        )}
        <span className="profile__spacer" />
        {extra}
        <button
          type="button"
          className="nbridge__star"
          aria-pressed={pinned}
          aria-label={pinned ? `Unpin ${line}` : `Pin ${line}`}
          title={
            pinned ? 'Unpin — remove from the Pinned port' : 'Pin — send to the Pinned port'
          }
          onClick={() => onPin(match)}
        >
          {pinned ? '★' : '☆'}
        </button>
      </div>
    </div>
  )
}

/** Scroll `container` just enough to show `el`, with a little air, and nothing else. */
function revealIn(container: HTMLElement, el: HTMLElement): void {
  const box = container.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  const air = 6
  if (r.top < box.top) container.scrollTop -= box.top - r.top + air
  else if (r.bottom > box.bottom) container.scrollTop += r.bottom - box.bottom + air
}

/** The lines on screen as a table, for the card's CSV export. */
function linesTable(
  neuronId: NeuronId,
  lines: readonly NbLine[],
  method: NbMethod,
): TableValue {
  // The one column that differs by method: PPPM's rank, or CDS's score.
  const [scoreColumn, dtype, scoreOf] =
    method === 'pppm'
      ? (['pppmRank', 'i64', (m: NbMatch) => m.pppmRank] as const)
      : (['score', 'f64', (m: NbMatch) => m.normalizedScore] as const)
  const schema = tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    column('line', 'str'),
    column('collection', 'str'),
    column(scoreColumn, dtype),
    column('images', 'i64'),
    column('mirrored', 'bool'),
    column('slideCode', 'str'),
  )
  return tableFromRows(
    schema,
    lines.map((line) => ({
      [ID_COLUMN_NAME]: neuronId,
      line: line.line,
      collection: line.best.image.libraryName,
      [scoreColumn]: scoreOf(line.best) ?? null,
      images: line.images.length,
      mirrored: line.best.mirrored,
      slideCode: line.best.image.slideCode ?? '',
    })),
  )
}
