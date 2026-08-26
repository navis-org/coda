/**
 * The Zoo browser: workflows other people deposited, searchable, on a card each.
 *
 * Master–detail rather than a list that opens on click, and that is a deliberate departure from
 * "clicking an entry opens it". Opening replaces the canvas and resets the undo history, and a
 * community workflow is somebody else's document — the two questions a reader has before
 * committing to that are *what does this do* and *what will it ask me for*, and neither is
 * answerable from a name and one line. So a click selects and the panel answers both; Enter,
 * a double-click, and the button in the panel all open. The keyboard model is `NodeBrowser`'s,
 * because a modal with a search field on top should behave the same way twice.
 *
 * **Nothing here trusts what it downloaded.** The graph goes through `deserializeGraph` exactly
 * as a file or a share link does — validated, unknown node types dropped with a warning — and
 * the README renders through `MarkdownView` *without* `extended`, so no fences, no tables and
 * no images. That is the same rule a dataset blurb from a Custom node gets and for the same
 * reason: an image in a third-party document is a tracking pixel and a fence is a directive
 * some renderer may act on. Opening a workflow also runs only the cheap pass, which is what
 * makes "it opened" different from "it did something".
 *
 * The failure states are the design here rather than an afterthought, because this is the one
 * surface in Coda that cannot work offline. A stale cached index is shown *with its age* rather
 * than hidden; an index that cannot be reached at all says so and offers the repository.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { deserializeGraph } from '../../core/graph'
import type { ZooEntry } from '../../data/zoo/format'
import type { LoadedZooIndex } from '../../data/zoo/source'
import {
  loadZooGraph,
  loadZooIndex,
  loadZooReadme,
  zooEntryUrl,
  zooRepoUrl,
} from '../../data/zoo/source'
import { backendName } from '../../nodes/lib/datasetFamilies'
import { useGraphStore } from '../../store/graphStore'
import { formatAgo, plural } from '../format'
import { MarkdownView } from '../MarkdownView'
import { REPLACE_GRAPH_QUESTION, useReplaceConfirm } from '../replaceConfirm'
import { useListNav } from '../useListNav'
import { Highlight } from './Highlight'
import { fuzzyRank } from './fuzzy'
import { ZooThumbnail } from './ZooThumbnail'

export interface ZooBrowserProps {
  onClose: () => void
}

/** Chips beyond this are a second row nobody scans; the search field covers the tail. */
const MAX_TAGS = 12

/**
 * How long a selection has to settle before its README is fetched.
 *
 * Long enough that an arrow-key sweep through the list issues one request rather than one per
 * row passed over; short enough that a deliberate click does not feel like it is waiting.
 */
const README_DELAY_MS = 150

/**
 * What a workflow will ask the reader for, in words.
 *
 * `mock` is the case worth spelling out rather than naming: a workflow on the synthetic datasets
 * runs for anybody, immediately, with no account anywhere — which is the single most useful
 * thing a card can say, and "Requires: mock" says the opposite of it to someone who does not
 * already know what the mock source is.
 */
function requirementLabel(requires: string[]): { text: string; free: boolean } {
  const live = requires.filter((source) => source !== 'mock')
  if (live.length === 0) return { text: 'Runs with no token', free: true }
  return { text: `Needs ${live.map(backendName).join(' + ')}`, free: false }
}

export function ZooBrowser({ onClose }: ZooBrowserProps) {
  const [loaded, setLoaded] = useState<LoadedZooIndex | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [refreshing, setRefreshing] = useState(true)

  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | undefined>()

  const [readme, setReadme] = useState<{ slug: string; text?: string }>({ slug: '' })
  const [opening, setOpening] = useState<string | undefined>()
  const [openError, setOpenError] = useState<string | undefined>()

  const loadGraph = useGraphStore((s) => s.loadGraph)
  const confirm = useReplaceConfirm()

  const fetchIndex = useCallback((force: boolean) => {
    setRefreshing(true)
    setLoadError(undefined)
    void loadZooIndex({ force })
      .then((result) => setLoaded(result))
      .catch((err: unknown) => setLoadError((err as Error).message))
      .finally(() => setRefreshing(false))
  }, [])

  useEffect(() => fetchIndex(false), [fetchIndex])

  const workflows = useMemo(() => loaded?.index.workflows ?? [], [loaded])

  /**
   * Tags, most-used first.
   *
   * By frequency rather than alphabetically: the chips are a map of what is *in* the zoo, and
   * an alphabetical list puts whichever tag starts with "a" in front of the one on half the
   * entries. Ties break by name so the row does not reshuffle when two tags draw level.
   */
  const tags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of workflows) {
      for (const name of entry.tags) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TAGS)
  }, [workflows])

  const ranked = useMemo(() => {
    const scoped = tag ? workflows.filter((entry) => entry.tags.includes(tag)) : workflows
    return fuzzyRank(query, scoped, (entry) => [
      entry.name,
      entry.summary,
      entry.tags.join(' '),
      entry.authors.map((person) => person.name).join(' '),
    ])
  }, [query, tag, workflows])

  /**
   * The requirement sentence per entry, resolved once.
   *
   * It was computed inside the row map *and* again for the detail panel, so the selected entry
   * paid for it twice on every render and every other entry once per keystroke — a `filter`, a
   * `map` and a `join` each time, over a list that does not change between fetches.
   */
  const requirements = useMemo(() => {
    const byslug = new Map<string, { text: string; free: boolean }>()
    for (const entry of workflows) byslug.set(entry.slug, requirementLabel(entry.requires))
    return byslug
  }, [workflows])

  const nav = useListNav(ranked.length, ranked, onClose)
  const selected: ZooEntry | undefined = ranked[nav.activeIndex]?.item

  /*
   * The README follows the selection, one beat behind it.
   *
   * The delay is the point rather than a nicety: holding ArrowDown through the list would
   * otherwise start a request per entry passed over, all of them to the same host and all but
   * the last discarded. `live` still guards the landing, because a request already in flight
   * when the selection moves must not write its answer under a different entry.
   */
  useEffect(() => {
    if (!selected) return
    let live = true
    setReadme({ slug: selected.slug })
    const timer = setTimeout(() => {
      void loadZooReadme(selected)
        .then((text) => {
          if (live) setReadme({ slug: selected.slug, ...(text ? { text } : {}) })
        })
        .catch(() => {
          // A missing description is a thinner panel, not an error worth a banner.
        })
    }, README_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [selected])

  /**
   * Fetch, validate, and put it on the canvas.
   *
   * The replace-what-is-here question is asked on the button rather than through
   * `window.confirm`, matching the start page's cards — jsdom does not implement the browser
   * dialog, and a chrome prompt in front of a modal reads as a different application.
   */
  const open = (entry: ZooEntry) => {
    confirm.ask(entry.slug, () => {
      setOpening(entry.slug)
      setOpenError(undefined)
      void loadZooGraph(entry)
        .then((text) => {
          const { graph, warnings } = deserializeGraph(text)
          loadGraph(graph, warnings)
          onClose()
        })
        .catch((err: unknown) => setOpenError((err as Error).message))
        .finally(() => setOpening(undefined))
    })
  }

  /**
   * What the list says when it has no rows to show — or `undefined` when it has.
   *
   * One ladder rather than four sibling `{cond && …}` blocks. The chain form made the reader
   * recompute exhaustiveness from four overlapping guards, and it was not in fact exhaustive:
   * a refresh in flight over a non-empty zoo whose query matched nothing fell through every
   * branch and rendered a blank panel with no message at all.
   *
   * The error case deliberately does not take over the list when a *previous* copy is still in
   * hand — a failed Refresh with rows on screen is disclosed in the footer, beside the age.
   */
  const emptyState =
    ranked.length > 0 ? undefined : loadError && workflows.length === 0 ? (
      <>
        <p>{loadError}</p>
        <p>
          The Zoo lives at{' '}
          <a href={zooRepoUrl()} target="_blank" rel="noreferrer noopener">
            {zooRepoUrl().replace('https://', '')}
          </a>
          . Everything already on your canvas is untouched.
        </p>
      </>
    ) : refreshing && workflows.length === 0 ? (
      'Loading the Zoo…'
    ) : workflows.length === 0 ? (
      <>
        <p>The Zoo has no workflows in it yet.</p>
        <p>
          <a href={zooRepoUrl()} target="_blank" rel="noreferrer noopener">
            Deposit the first one
          </a>
          .
        </p>
      </>
    ) : (
      'Nothing matches.'
    )

  return (
    <div className="overlay" role="presentation" onPointerDown={onClose}>
      <div
        className="overlay__panel zoo"
        role="dialog"
        aria-modal="true"
        aria-label="Browse community workflows"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="zoo__search">
          <input
            className="node-browser__input"
            autoFocus
            placeholder="Search workflows…"
            aria-label="Search workflows"
            value={query}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              // Typing widens back to every tag, so a search can never come up empty because of
              // a chip the reader forgot was on. Same rule as the node browser's categories.
              if (e.target.value) setTag(undefined)
            }}
            onKeyDown={(e) => {
              if (nav.onKeyDown(e)) return
              if (e.key === 'Enter' && selected) {
                e.preventDefault()
                open(selected)
              }
            }}
          />
          <button
            type="button"
            className="chip-filter zoo__refresh"
            onClick={() => fetchIndex(true)}
            disabled={refreshing}
            title="Fetch the list again"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {tags.length > 0 && (
          <div className="zoo__tags" role="group" aria-label="Filter by tag">
            <button
              type="button"
              className="chip-filter"
              aria-selected={tag === undefined}
              onClick={() => setTag(undefined)}
            >
              All <span className="chip-filter__count">{workflows.length}</span>
            </button>
            {tags.map(([name, count]) => (
              <button
                key={name}
                type="button"
                className="chip-filter"
                aria-selected={tag === name}
                onClick={() => {
                  setTag(tag === name ? undefined : name)
                  setQuery('')
                }}
              >
                {name} <span className="chip-filter__count">{count}</span>
              </button>
            ))}
          </div>
        )}

        <div className="zoo__body">
          <div className="zoo__list" ref={nav.listRef} role="listbox" aria-label="Workflows">
            {emptyState && <div className="zoo__empty">{emptyState}</div>}

            {ranked.map(({ item, matches }, index) => {
              const requirement = requirements.get(item.slug)!
              return (
                <div
                  key={item.slug}
                  className="zoo-row"
                  role="option"
                  aria-selected={index === nav.activeIndex}
                  tabIndex={-1}
                  onClick={() => nav.setActiveIndex(index)}
                  onDoubleClick={() => open(item)}
                >
                  <ZooThumbnail layout={item.layout} width={128} height={72} />
                  <div className="zoo-row__text">
                    <strong>
                      <Highlight text={item.name} matches={matches} />
                    </strong>
                    <span className="zoo-row__summary">{item.summary}</span>
                    <span className="zoo-row__meta">
                      <span
                        className="zoo-row__requires"
                        data-free={requirement.free || undefined}
                      >
                        {requirement.text}
                      </span>
                      {' · '}
                      {plural(item.nodeCount, 'node')}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>

          {selected && (
            <div className="zoo__detail">
              <ZooThumbnail layout={selected.layout} width={300} height={168} />
              <h2 className="zoo__title">{selected.name}</h2>
              <p className="zoo__summary">{selected.summary}</p>

              <dl className="zoo__facts">
                <dt>Needs</dt>
                <dd>{requirements.get(selected.slug)?.text}</dd>
                {selected.authors.length > 0 && (
                  <>
                    <dt>{selected.authors.length === 1 ? 'Author' : 'Authors'}</dt>
                    <dd>
                      {selected.authors.map((person, i) => (
                        <span key={person.name}>
                          {i > 0 && ', '}
                          {person.github ? (
                            <a
                              href={`https://github.com/${person.github}`}
                              target="_blank"
                              rel="noreferrer noopener"
                            >
                              {person.name}
                            </a>
                          ) : (
                            person.name
                          )}
                        </span>
                      ))}
                    </dd>
                  </>
                )}
                {selected.updatedAt && (
                  <>
                    <dt>Updated</dt>
                    <dd>{formatAgo(Date.parse(selected.updatedAt))}</dd>
                  </>
                )}
                {selected.tags.length > 0 && (
                  <>
                    <dt>Tags</dt>
                    <dd>{selected.tags.join(', ')}</dd>
                  </>
                )}
              </dl>

              {readme.slug === selected.slug && readme.text && (
                /* Not `extended`: see the module note. A deposited README is third-party text. */
                <MarkdownView source={readme.text} className="zoo__readme" />
              )}

              {openError && <p className="zoo__error">{openError}</p>}

              <div className="zoo__actions">
                {confirm.confirming === selected.slug ? (
                  <>
                    {/* One sentence for all three surfaces that replace the canvas. This copy
                        had lost the undo clause, which is the only fact it exists to carry. */}
                    <span className="zoo__confirm-text">{REPLACE_GRAPH_QUESTION}</span>
                    <button type="button" className="btn" onClick={confirm.cancel}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => open(selected)}
                    >
                      Replace
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={opening === selected.slug}
                    onClick={() => open(selected)}
                  >
                    {opening === selected.slug ? 'Opening…' : 'Open on the canvas'}
                  </button>
                )}
                <a
                  className="zoo__source-link"
                  href={zooEntryUrl(selected)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  View on GitHub
                </a>
              </div>
            </div>
          )}
        </div>

        <div className="zoo__foot">
          <span>
            {loaded?.stale
              ? `Offline — showing a copy from ${formatAgo(loaded.savedAt)}, which may be missing newer workflows.`
              : loadError && workflows.length > 0
                ? `Could not refresh — showing the copy from ${formatAgo(loaded?.savedAt ?? Date.now())}.`
                : loaded
                  ? `${plural(workflows.length, 'workflow')} from ${zooRepoUrl().replace('https://github.com/', '')}`
                  : ''}
          </span>
          {loaded && loaded.dropped.length > 0 && (
            /* Named rather than swallowed: a dropped entry is a contributor's, and the only way
               anybody finds out is if the browser says so. */
            <span className="zoo__dropped" title={loaded.dropped.join('\n')}>
              {loaded.dropped.length === 1
                ? '1 entry could not be read'
                : `${loaded.dropped.length} entries could not be read`}
            </span>
          )}
          <a
            href={`${zooRepoUrl()}/blob/main/CONTRIBUTING.md`}
            target="_blank"
            rel="noreferrer noopener"
          >
            Contribute a workflow
          </a>
        </div>
      </div>
    </div>
  )
}
