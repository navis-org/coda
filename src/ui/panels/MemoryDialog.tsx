/**
 * Memory — how close this tab is to its ceiling, and what is holding the bytes.
 *
 * For somebody pushing a browser as far as it goes: the question is never only "how much", it is
 * "which of these can I let go of". So the measurement (Chrome's, where there is one) comes first,
 * and below it the estimate broken down by workflow and by kind of result, each workflow with a
 * button that frees its results and the two caches that outlive them with one each.
 *
 * The numbers, where each comes from, and the three actions are `ui/memoryReadout.ts`; the
 * estimate is `core/valueBytes.ts`.
 *
 * A second tab answers the same question about disk: what Coda keeps in this browser between
 * sessions (`ui/storageReadout.ts`). It is a tab here rather than a dialog of its own because the
 * reader is the same person at the same moment — deciding what to let go of.
 */

import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

import { MEMORY_CATEGORIES } from '../../core/valueBytes'
import type { StoredUsage } from '../../data/idb'
import { LOCAL_STORAGE_BUDGET } from '../../store/persistence'
import { useGraphStore } from '../../store/graphStore'
import { formatBytes, plural } from '../../style/format'
import type { HeapUse, MemoryReading } from '../memoryReadout'
import {
  dropGeometry,
  dropResults,
  stopPythonRuntime,
  useMemoryReading,
} from '../memoryReadout'
import { Modal, ModalHeader } from '../Modal'
import type { StorageReading } from '../storageReadout'
import { clearDownloadedData, localTotal, measureStorage } from '../storageReadout'

/** Mounted once, in `App`, and opened by a store request — `PrivacyDialog`'s idiom exactly. */
export function MemoryDialog() {
  const request = useGraphStore((s) => s.memoryRequest)
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

/**
 * The heap-share bar, drawn by the status bar's chip and by the dialog. A `label` makes it a meter
 * a screen reader announces; without one it is decoration beside a figure that says the same.
 */
export function MemoryMeter({ heap, label }: { heap: HeapUse; label?: string }) {
  const a11y = label
    ? {
        role: 'meter',
        'aria-label': label,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': Math.round(heap.share * 100),
      }
    : { 'aria-hidden': true }
  return (
    <span className="memory__meter" data-level={heap.level} {...a11y}>
      <span style={{ width: `${heap.share * 100}%` }} />
    </span>
  )
}

const TABS = [
  { id: 'memory', label: 'Memory' },
  { id: 'storage', label: 'Storage' },
] as const

type TabId = (typeof TABS)[number]['id']

/**
 * Opens on Memory each time: the chip and the palette entry that open it both say Memory.
 *
 * The storage reading is held here rather than in its tab, so switching back to Storage shows the
 * figures already read instead of walking every database again.
 */
function Dialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabId>('memory')
  const [storage, setStorage] = useState<StorageReading>()
  return (
    <Modal className="overlay__panel memory" label="Memory" onClose={onClose}>
      <ModalHeader onClose={onClose}>Memory</ModalHeader>
      <div className="sources__tabs" role="tablist" aria-label="Memory or storage">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            className="sources__tab"
            aria-selected={entry.id === tab}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div
        className="sources__body memory__body"
        role="tabpanel"
        aria-label={TABS.find((entry) => entry.id === tab)?.label}
      >
        {tab === 'memory' ? (
          <MemoryTab />
        ) : (
          <StorageTab reading={storage} onReading={setStorage} />
        )}
      </div>
    </Modal>
  )
}

/** Its own component so the Python figure is asked for only while this tab is showing. */
function MemoryTab() {
  const reading = useMemoryReading(true)
  return (
    <>
      {reading && (
        <>
          <TabSection reading={reading} />
          <WorkflowSection reading={reading} />
          <CacheSection reading={reading} />
        </>
      )}
      <p className="memory__foot">
        The figures per workflow are Coda&rsquo;s own estimate. A result shared by two workflows
        is counted once, under the first.
      </p>
      <p className="memory__foot">
        Memory consumption of 3D View, Neuroglancer and other viewers can&rsquo;t be measured.
        Closing a viewer frees the memory.
      </p>
    </>
  )
}

function TabSection({ reading }: { reading: MemoryReading }) {
  const { heap } = reading
  if (!heap) {
    return (
      <section className="memory__group">
        <h3>This tab</h3>
        <p className="memory__hint">
          This browser does not report how much memory a page is using or what its limit is
          (Chrome and Edge do). Coda estimates it is holding{' '}
          <strong>{formatBytes(reading.held)}</strong>, broken down below.
        </p>
      </section>
    )
  }
  return (
    <section className="memory__group">
      <h3>This tab</h3>
      <p className="memory__total">
        <strong>{formatBytes(heap.used)}</strong> in use, measured by the browser.
      </p>
      <div className="memory__meter-row">
        <span>Objects</span>
        <MemoryMeter heap={heap} label="Share of the heap limit" />
        <span className="memory__figure">
          {formatBytes(heap.objects)} of {formatBytes(heap.limit)}
        </span>
      </div>
      <p className="memory__note">
        Tables, text and other objects count against this limit. If a tab runs out, the browser
        closes it, and one large step can do that well before the bar is full.
        {heap.level !== 'ok' && ' Drop results you no longer need below to free some memory.'}
      </p>
      <div className="memory__meter-row">
        <span>Arrays</span>
        <span />
        <span className="memory__figure">{formatBytes(reading.buffers)}</span>
      </div>
      <p className="memory__note">
        Geometry and matrices do not count against that limit. They can use as much as this
        computer&rsquo;s memory allows.
      </p>
    </section>
  )
}

/** One line of the dialog: what it is, what it holds, and the button that frees it. */
function Row(props: {
  name: string
  tag?: string
  detail: ReactNode
  figure: string
  /** Absent for a row that only reports — something managed elsewhere, or cleaned up on its own. */
  action?: string
  disabled?: boolean
  title?: string
  onAction?: () => void
}) {
  return (
    <li className="memory__row">
      <div className="memory__what">
        <span className="memory__name">
          {props.name}
          {props.tag && <span className="memory__tag">{props.tag}</span>}
        </span>
        <span className="memory__detail">{props.detail}</span>
      </div>
      <span className="memory__figure">{props.figure}</span>
      {props.action ? (
        <button
          type="button"
          className="btn"
          disabled={props.disabled}
          title={props.title}
          onClick={props.onAction}
        >
          {props.action}
        </button>
      ) : (
        <span />
      )}
    </li>
  )
}

function WorkflowSection({ reading }: { reading: MemoryReading }) {
  const activeTabId = useGraphStore((s) => s.activeTabId)
  const busy = useGraphStore((s) => s.busy)
  return (
    <section className="memory__group">
      <h3>Open workflows</h3>
      <ul className="memory__list">
        {reading.workflows.map((workflow) => {
          const running = busy && workflow.id === activeTabId
          const parts = MEMORY_CATEGORIES.filter((c) => workflow.byCategory[c.id] > 0)
            .sort((a, b) => workflow.byCategory[b.id] - workflow.byCategory[a.id])
            .map((c) => `${c.label} ${formatBytes(workflow.byCategory[c.id])}`)
          return (
            <Row
              key={workflow.id}
              name={workflow.name}
              tag={workflow.id === activeTabId ? 'open' : undefined}
              detail={
                workflow.results === 0
                  ? 'No results held'
                  : [plural(workflow.results, 'result'), ...parts].join(' · ')
              }
              figure={formatBytes(workflow.bytes)}
              action="Drop results"
              disabled={workflow.results === 0 || running}
              title={
                running
                  ? 'Wait for the run to finish'
                  : 'Free these results. The next Run computes them again.'
              }
              onAction={() => dropResults(workflow.id)}
            />
          )
        })}
      </ul>
    </section>
  )
}

function CacheSection({ reading }: { reading: MemoryReading }) {
  const { python } = reading
  return (
    <section className="memory__group">
      <h3>Kept between runs</h3>
      <ul className="memory__list">
        <Row
          name="Downloaded geometry"
          detail="Skeletons and meshes kept so the next run does not download them again. Does not include what the results above hold."
          figure={formatBytes(reading.geometry)}
          action="Drop"
          disabled={reading.geometry === 0}
          onAction={dropGeometry}
        />
        <Row
          name="Python runtime"
          detail={
            python === undefined
              ? 'Not running.'
              : 'Its memory only grows while it runs. Stopping it frees that memory, and the next Python step starts it again.'
          }
          figure={python === undefined ? '—' : formatBytes(python)}
          action="Stop"
          disabled={python === undefined || reading.pythonBusy}
          title={reading.pythonBusy ? 'A Python step is running' : undefined}
          onAction={stopPythonRuntime}
        />
      </ul>
    </section>
  )
}

/**
 * A database row's line: how many, then what to know about them — or plainly none, where a count
 * of zero followed by where to manage them reads as a list that failed to load.
 */
function counted(usage: StoredUsage | undefined, noun: string, rest: string): string {
  if (!usage) return 'Could not be read in this browser.'
  if (usage.entries === 0) return 'None yet.'
  return `${plural(usage.entries, noun)}. ${rest}`
}

/** A database's figure: Coda's estimate, so marked as one, and a dash where it could not be read. */
function stored(usage: StoredUsage | undefined): string {
  return usage ? `≈ ${formatBytes(usage.bytes)}` : '—'
}

/**
 * What Coda keeps in this browser between sessions, read the first time the tab opens.
 *
 * One button only, on the data cache — see `ui/storageReadout.ts` for why the rest only report.
 * Each row that is somebody's work names where it is managed instead, since a list a reader can
 * see but not act on is the moment they ask where to go.
 */
function StorageTab({
  reading,
  onReading,
}: {
  reading: StorageReading | undefined
  onReading: (next: StorageReading) => void
}) {
  const [clearing, setClearing] = useState(false)
  const read = reading !== undefined

  useEffect(() => {
    if (read) return
    let live = true
    void measureStorage().then((next) => {
      if (live) onReading(next)
    })
    return () => {
      live = false
    }
  }, [read, onReading])

  if (!reading) return <p className="memory__note">Counting what this browser holds…</p>

  const { site, persisted, local } = reading
  const openWorkflows = (reading.session?.bytes ?? 0) + (local?.autosave ?? 0) + reading.tab

  return (
    <>
      <section className="memory__group">
        <h3>This site</h3>
        {site ? (
          <p className="memory__total">
            <strong>{formatBytes(site.usage)}</strong> stored, measured by the browser, which
            allows this site up to {formatBytes(site.quota)}.
          </p>
        ) : (
          <p className="memory__hint">
            This browser does not report how much this site stores. The figures below are
            Coda&rsquo;s own estimate.
          </p>
        )}
        {persisted === true && (
          <p className="memory__note">The browser keeps this data until you clear it.</p>
        )}
        {persisted === false && (
          <p className="memory__note">
            The browser may delete this data if the computer runs low on disk space. To keep a
            workflow for certain, save it as a file.
          </p>
        )}
      </section>

      <section className="memory__group">
        <h3>Kept by Coda</h3>
        <ul className="memory__list">
          <Row
            name="Downloaded data"
            detail={counted(
              reading.cache,
              'item',
              'Neuron tables and dataset listings kept so the next session does not download them again.',
            )}
            figure={stored(reading.cache)}
            action="Clear"
            disabled={!reading.cache?.entries || clearing}
            title="Delete these. Anything that needs them downloads them again."
            onAction={() => {
              setClearing(true)
              void clearDownloadedData(reading)
                .then(onReading)
                .finally(() => setClearing(false))
            }}
          />
          <Row
            name="Open workflows"
            detail={`${
              reading.session?.entries ? `${plural(reading.session.entries, 'workflow')}. ` : ''
            }Copies of the workflows open in this and recently closed tabs, so a reload brings them back. Cleared automatically.`}
            figure={`≈ ${formatBytes(openWorkflows)}`}
          />
          {reading.shelves.map((shelf) => (
            <Row
              key={shelf.name}
              name={shelf.name}
              detail={counted(shelf.usage, shelf.noun, shelf.note)}
              figure={stored(shelf.usage)}
            />
          ))}
          <Row
            name="Sign-ins and keys"
            detail={
              !local
                ? 'Could not be read in this browser.'
                : local.services.length
                  ? `${local.services.join(', ')}. Manage them in Connections.`
                  : 'None stored.'
            }
            figure={local ? formatBytes(local.signIns) : '—'}
          />
          <Row
            name="Preferences"
            detail="Theme, panel layout, guides you have finished, and similar settings."
            figure={local ? formatBytes(local.preferences) : '—'}
          />
          {local && local.other > 0 && (
            <Row
              name="Other"
              detail="Stored on this site by something other than Coda."
              figure={formatBytes(local.other)}
            />
          )}
        </ul>
        {local && (
          <p className="memory__note">
            Autosaves, sign-ins and preferences share an allowance of{' '}
            {formatBytes(LOCAL_STORAGE_BUDGET)}, of which {formatBytes(localTotal(local))} is
            used. If it fills, the autosave stops being written.
          </p>
        )}
      </section>
      <p className="memory__foot">
        Sizes marked &asymp; are Coda&rsquo;s own estimate, read when this tab first opened. The
        browser&rsquo;s total also counts its own overhead, so the rows do not add up to it
        exactly.
      </p>
    </>
  )
}
