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
 */

import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

import { MEMORY_CATEGORIES } from '../../core/valueBytes'
import { useGraphStore } from '../../store/graphStore'
import { formatBytes, plural } from '../format'
import type { HeapUse, MemoryReading } from '../memoryReadout'
import {
  dropGeometry,
  dropResults,
  stopPythonRuntime,
  useMemoryReading,
} from '../memoryReadout'
import { Modal, ModalHeader } from '../Modal'

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

function Dialog({ onClose }: { onClose: () => void }) {
  const reading = useMemoryReading(true)
  return (
    <Modal className="overlay__panel memory" label="Memory" onClose={onClose}>
      <ModalHeader onClose={onClose}>Memory</ModalHeader>
      <div className="sources__body memory__body">
        {reading && (
          <>
            <TabSection reading={reading} />
            <WorkflowSection reading={reading} />
            <CacheSection reading={reading} />
          </>
        )}
        <p className="memory__foot">
          Per-workflow figures are Coda&rsquo;s estimate from the results themselves. A result
          two workflows share is counted once, under the first.
        </p>
        <p className="memory__foot">
          Memory consumption of 3D View, Neuroglancer and other viewers can&rsquo;t be measured.
          Closing a viewer frees the memory.
        </p>
      </div>
    </Modal>
  )
}

function TabSection({ reading }: { reading: MemoryReading }) {
  const { heap } = reading
  if (!heap) {
    return (
      <section className="memory__group">
        <h3>This tab</h3>
        <p className="memory__hint">
          This browser does not report how much memory a page is using, or where its limit is —
          Chrome and Edge do. Coda&rsquo;s own estimate of what it is holding is{' '}
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
        Tables, text and other objects count against this limit. The browser ends a tab that
        runs out, and one large step can do that well before the bar is full.
        {heap.level !== 'ok' && ' Drop results you no longer need below to move away from it.'}
      </p>
      <div className="memory__meter-row">
        <span>Arrays</span>
        <span />
        <span className="memory__figure">{formatBytes(reading.buffers)}</span>
      </div>
      <p className="memory__note">
        Geometry and matrix buffers do not count against that limit; they are bounded by this
        machine&rsquo;s memory instead.
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
  action: string
  disabled: boolean
  title?: string
  onAction: () => void
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
      <button
        type="button"
        className="btn"
        disabled={props.disabled}
        title={props.title}
        onClick={props.onAction}
      >
        {props.action}
      </button>
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
          detail="Skeletons and meshes kept so a re-run does not download them again, beyond what results above already hold."
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
              : 'Its heap only grows while it runs; stopping it gives the memory back, and the next Python step starts it again.'
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
