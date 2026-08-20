/**
 * Opening a workflow somebody sent you.
 *
 * The receiving half of the share feature: read the `#!` fragment once at boot, resolve it,
 * and hand the graph to `loadGraph` — which already gives it the lenient-load warnings, the
 * history reset and the fit request that every other open path gets.
 *
 * **It runs once per page load, and the guard is a ref rather than a dependency list.** The
 * fragment is cleared the moment it has been dealt with, so a second pass would find nothing —
 * but under `StrictMode` an effect runs twice in development, and the two passes would both
 * start a fetch before either had cleared anything.
 *
 * **The hash is cleared once it has been handled**, including when the user declines. Left in
 * place, a reload after ten minutes of editing silently throws that work away and reverts to
 * the shared graph, which is the single worst thing this feature could do. The link is not the
 * store; the Share dialog regenerates it on demand.
 *
 * **Two different confirmations, for two different questions**, and they are asked in this
 * order because only the first one can be answered without touching the network:
 *
 *  1. *Shall I fetch from this host?* — only for a bare `https://` link, whose destination the
 *     recipient cannot see. `gh://` and `gs://` name a known host in the link itself.
 *  2. *Shall I replace what is on your canvas?* — only when there is something to replace.
 *     `loadGraph` resets the history, and the autosave is the only copy of what is about to go.
 *
 * A fresh tab following a gist link therefore answers neither, which is the common case and the
 * one that has to be frictionless.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { LoadResult } from '../core/graph'
import { deserializeGraph } from '../core/graph'
import { errorMessage } from '../core/errors'
import type { ShareRef } from '../data/share/fragment'
import { hasShareFragment, parseShareFragment } from '../data/share/fragment'
import type { ShareTarget } from '../data/share/resolve'
import { resolveShareRef, shareTarget } from '../data/share/resolve'
import { useGraphStore } from '../store/graphStore'

export type ShareLoad =
  | { state: 'idle' }
  /** A bare https link, waiting on "fetch from this host?". */
  | { state: 'confirm-fetch'; ref: ShareRef; target: ShareTarget }
  | { state: 'loading'; target: ShareTarget }
  /** Resolved and parsed, waiting on "replace what is on the canvas?". */
  | { state: 'confirm-replace'; result: LoadResult; name: string }
  | { state: 'error'; message: string }

export interface ShareLinkState {
  load: ShareLoad
  /** Answer whichever question is being asked. */
  accept: () => void
  /** Decline, keep the canvas, and forget the link. */
  dismiss: () => void
}

/** Take the link out of the address bar, leaving path and query alone. */
function clearFragment(): void {
  if (typeof window === 'undefined') return
  const { pathname, search } = window.location
  window.history.replaceState(null, '', `${pathname}${search}`)
}

export function useShareLink(): ShareLinkState {
  const loadGraph = useGraphStore((s) => s.loadGraph)
  const [load, setLoad] = useState<ShareLoad>({ state: 'idle' })
  const started = useRef(false)

  /**
   * Deserialise, then either load or ask.
   *
   * The graph is read *before* the question is asked, so a link that was never going to open
   * says so instead of putting a replace-confirm in front of somebody over nothing.
   */
  const receive = useCallback(
    (json: string) => {
      let result: LoadResult
      try {
        result = deserializeGraph(json)
      } catch (err) {
        setLoad({
          state: 'error',
          message: `That link does not contain a Coda workflow: ${errorMessage(err)}`,
        })
        return
      }
      clearFragment()
      if (useGraphStore.getState().graph.nodes.length === 0) {
        loadGraph(result.graph, result.warnings)
        setLoad({ state: 'idle' })
        return
      }
      setLoad({
        state: 'confirm-replace',
        result,
        name: (result.graph.meta?.name ?? '').trim() || 'Untitled',
      })
    },
    [loadGraph],
  )

  const fetchRef = useCallback(
    (ref: ShareRef) => {
      setLoad({ state: 'loading', target: shareTarget(ref) })
      resolveShareRef(ref).then(receive, (err: unknown) => {
        clearFragment()
        setLoad({ state: 'error', message: errorMessage(err) })
      })
    },
    [receive],
  )

  useEffect(() => {
    if (started.current) return
    started.current = true
    if (typeof window === 'undefined') return
    const hash = window.location.hash
    if (!hasShareFragment(hash)) return

    let ref: ShareRef
    try {
      ref = parseShareFragment(hash)
    } catch (err) {
      clearFragment()
      setLoad({ state: 'error', message: errorMessage(err) })
      return
    }

    const target = shareTarget(ref)
    if (target.needsConfirm) setLoad({ state: 'confirm-fetch', ref, target })
    else fetchRef(ref)
  }, [fetchRef])

  /*
   * Read straight off `load` rather than through a functional updater. `accept` only ever runs
   * from a click, so the rendered `load` *is* the current state — and the updater form was what
   * forced the `queueMicrotask` that used to be here, since React may invoke an updater twice
   * and a fetch started from one is a fetch started twice.
   */
  const accept = useCallback(() => {
    if (load.state === 'confirm-fetch') fetchRef(load.ref)
    else if (load.state === 'confirm-replace') {
      loadGraph(load.result.graph, load.result.warnings)
      setLoad({ state: 'idle' })
    }
  }, [fetchRef, load, loadGraph])

  const dismiss = useCallback(() => {
    clearFragment()
    setLoad({ state: 'idle' })
  }, [])

  return { load, accept, dismiss }
}
