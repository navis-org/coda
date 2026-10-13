/**
 * Playback's movie: every compartment's voltage through the card's last run, made when Playback
 * opens rather than kept with the result.
 *
 * **Re-run, not recorded.** A movie is compartments × frames of float32 — tens of megabytes on a
 * large model — and nothing but this view reads it, so a Run does not pay for it. Opening Playback
 * replays the main run in a worker with every compartment recorded (`runMovieJob`); the trains are
 * seeded and the rest is the one the run kept, so the replay is the run.
 *
 * **A small cache keyed on the run.** The card's `traces` value is the run's identity: a new Run
 * makes a new one, so an entry is right exactly while that value is — and held weakly by it, so a
 * deleted node's movie goes with its run. Reopening the view after a look elsewhere costs nothing,
 * and views open at once keep their movies up to `KEPT_BYTES`.
 *
 * **Only for a node that is up to date.** Planned from the card's params and inputs as they are
 * now, a stale card's movie would be of a run that never happened, beside traces of one that did.
 */

import { useEffect, useRef, useState } from 'react'

import { errorMessage } from '../../core/errors'
import type { ParamValues } from '../../core/node'
import type { CellModelValue, Value } from '../../core/values'
import { runWorkerJob } from '../../data/workerJob'
import type { Movie } from '../../packs/biophys/simulateJob'
import { MOVIE_BUDGET_BYTES, runMovieJob } from '../../packs/biophys/simulateJob'
import { planRun, runInputs } from '../../packs/biophys/simulateOps'
import { useGraphStore } from '../../store/graphStore'
import type { Firing } from './movie'

export type MovieState =
  | { readonly status: 'waiting'; readonly reason: string }
  | {
      readonly status: 'running'
      readonly fraction: number
      readonly note?: string | undefined
    }
  | { readonly status: 'ready'; readonly movie: Movie; readonly firing: Firing }
  | { readonly status: 'refused'; readonly reason: string }

/**
 * How many bytes of movie are kept at once: two at the budget a single movie may take, so two
 * full-size movies — a pinned view and an expanded one — never evict each other, and three or four
 * ordinary ones do not either.
 */
const KEPT_BYTES = 2 * MOVIE_BUDGET_BYTES

type Entry = { readonly movie: Movie; readonly firing: Firing }

/**
 * The movies made, keyed on the run each is of, **weakly**: a run the scheduler lets go of — its
 * node deleted, re-run, its workflow closed — takes its movie with it, and nothing here keeps it.
 * `order` remembers which was used last (by weak reference, for the same reason), so past
 * `KEPT_BYTES` the least recently played go first.
 */
const kept = new WeakMap<Value, Entry>()
let order: WeakRef<Value>[] = []

/** Move `run` to the newest end of `order`: made now, or played now. */
function touch(run: Value): void {
  // Read on every render, frame ticks included: nothing to do when it is already the newest.
  if (order.at(-1)?.deref() === run) return
  order = [...order.filter((ref) => ref.deref() !== run), new WeakRef(run)]
}

function keep(run: Value, entry: Entry): void {
  kept.set(run, entry)
  touch(run)
  // Most recently used first, each kept while it fits — so a small movie survives a large one
  // that does not — and the newest always, whatever its size.
  let bytes = 0
  const alive: WeakRef<Value>[] = []
  for (const ref of [...order].reverse()) {
    const key = ref.deref()
    const held = key && kept.get(key)
    if (!key || !held) continue
    const size = held.movie.frames.byteLength
    if (alive.length > 0 && bytes + size > KEPT_BYTES) {
      kept.delete(key)
      continue
    }
    bytes += size
    alive.unshift(ref)
  }
  order = alive
}

export interface MovieRequest {
  readonly nodeId: string
  readonly model: CellModelValue | undefined
  readonly params: ParamValues
  readonly record: Value | undefined
  readonly spikes: Value | undefined
  readonly column: (paramId: string) => string | undefined
}

export function useMovie(request: MovieRequest): MovieState {
  const { nodeId, model } = request
  const run = useGraphStore((s) => s.nodeOutput(nodeId, 'traces'))
  // `ok` and nothing else: a stale card's params are not the run's, and while it runs its output is
  // still the last run's — or a partial one — beside params that are already the next.
  const state = useGraphStore((s) => s.nodeInfo(nodeId).state)
  const current = state === 'ok'
  // What the job is planned from, read when it starts: none of it changes while the card stays
  // `ok`, so it is not what the effect waits on.
  const latest = useRef(request)
  latest.current = request
  const hit = current && run ? kept.get(run) : undefined
  // Played now: the last to be evicted, by when it was used rather than when it was made.
  if (hit && run) touch(run)

  const [made, setMade] = useState<MovieState>({ status: 'waiting', reason: '' })

  useEffect(() => {
    if (!model || !run || !current || hit) return
    const { params, record, spikes, column } = latest.current
    let job
    try {
      job = planRun(model, params, runInputs(record, spikes, column)).job
    } catch (error) {
      setMade({ status: 'refused', reason: errorMessage(error) })
      return
    }
    const controller = new AbortController()
    setMade({ status: 'running', fraction: 0 })
    runWorkerJob(
      // Written out here, where vite can see it — see `workerJob.ts`.
      () =>
        new Worker(new URL('../../packs/biophys/movie.worker.ts', import.meta.url), {
          type: 'module',
        }),
      job,
      {
        label: 'movie',
        here: runMovieJob,
        signal: controller.signal,
        onProgress: (fraction, note) => {
          if (!controller.signal.aborted) setMade({ status: 'running', fraction, note })
        },
      },
    ).then(
      (movie) => {
        keep(run, { movie, firing: job.firing })
        // Served from `kept` from here on; this only moves the view off its progress bar.
        if (!controller.signal.aborted) setMade({ status: 'waiting', reason: '' })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setMade({ status: 'refused', reason: errorMessage(error) })
      },
    )
    return () => controller.abort()
  }, [model, run, current, hit])

  if (hit) return { status: 'ready', ...hit }
  if (!model || !run)
    return { status: 'waiting', reason: 'Run the simulation to play it back.' }
  if (state === 'running') return { status: 'waiting', reason: 'The simulation is running.' }
  if (!current) {
    return {
      status: 'waiting',
      reason: 'The simulation has changed since it ran. Run it again to play it back.',
    }
  }
  return made
}
