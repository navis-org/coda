/**
 * Playback's movie: every compartment's voltage through the card's last run, made when Playback
 * opens rather than kept with the result.
 *
 * **Re-run, not recorded.** A movie is compartments × frames of float32 — tens of megabytes on a
 * large model — and nothing but this view reads it, so a Run does not pay for it. Opening Playback
 * replays the main run in a worker with every compartment recorded (`runMovieJob`); the trains are
 * seeded and the rest is the one the run kept, so the replay is the run.
 *
 * **A small cache keyed on what the movie replays**: the model and the job's `movieBasis`, its
 * timing and drive. So a Playback trace clicked — a record site, in the key, so the card goes stale
 * and its next Run is a new run — plays on from the movie it has rather than replaying an
 * identical one. Held weakly by the model, so a rebuilt or deleted one takes its movies with it;
 * views open at once keep theirs up to `KEPT_BYTES`.
 *
 * **Made only for a node that is up to date.** Planned from the card's params and inputs as they
 * are now, a stale card's movie would be of a run that never happened — unless one with the same
 * basis is already kept, which is then exactly as true as it was.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import type { CurrentClamp } from '../../biophys/solver'
import { errorMessage } from '../../core/errors'
import { visibleParams } from '../../core/node'
import { hashValue } from '../../core/hash'
import type { ParamValues } from '../../core/node'
import type { CellModelValue, Value } from '../../core/values'
import { runWorkerJob } from '../../data/workerJob'
import type { Movie, SimulateJob } from '../../packs/biophys/simulateJob'
import {
  MOVIE_BUDGET_BYTES,
  MOVIE_SWEEP,
  movieBasis,
  runMovieJob,
  sweepClamps,
} from '../../packs/biophys/simulateJob'
import type { RunPlan } from '../../packs/biophys/simulateOps'
import {
  injectedColumn,
  injectedCompartment,
  planRun,
  runInputs,
} from '../../packs/biophys/simulateOps'
import { simulateNode } from '../../packs/biophys/simulate'
import { formatNumber } from '../../style/format'
import { useGraphStore } from '../../store/graphStore'
import type { Firing } from './movie'

/**
 * A run's injected current as the Traces output's column has it: the clamps of the replayed sweep,
 * the first injected compartment (`injectedCompartment`), the `dt` its steps are counted in, and
 * the column's name (`injectedColumn`).
 */
export interface Stimulus {
  readonly clamps: readonly CurrentClamp[]
  readonly compartment: number
  readonly dt: number
  readonly label: string
}

export type MovieState =
  | { readonly status: 'waiting'; readonly reason: string }
  | {
      readonly status: 'running'
      readonly fraction: number
      readonly note?: string | undefined
    }
  | {
      readonly status: 'ready'
      readonly movie: Movie
      readonly firing: Firing
      /** Playback's traces as the card's run names them (`RunPlan.traces`). */
      readonly traces: RunPlan['traces']
      /**
       * The current the movie's run injects; undefined without injection. In the movie's basis, so
       * it is the movie's.
       */
      readonly stimulus: Stimulus | undefined
      /** Which sweep the movie replays, where the run has several: "sweep 1 of 12". */
      readonly sweep: string | undefined
    }
  | { readonly status: 'refused'; readonly reason: string }

/**
 * How many bytes of movie are kept at once: two at the budget a single movie may take, so two
 * full-size movies — a pinned view and an expanded one — never evict each other, and three or four
 * ordinary ones do not either.
 */
const KEPT_BYTES = 2 * MOVIE_BUDGET_BYTES

type Entry = { readonly movie: Movie; readonly firing: Firing }

/**
 * The movies made, by model **weakly** and then by basis: a model let go of — rebuilt, its node
 * deleted, its workflow closed — takes its movies with it. `order` remembers which was used last
 * (the model by weak reference, for the same reason), so past `KEPT_BYTES` the least recently
 * played go first.
 */
const kept = new WeakMap<CellModelValue, Map<string, Entry>>()
type Key = { readonly model: WeakRef<CellModelValue>; readonly basis: string }
let order: Key[] = []

const isKey = (key: Key, model: CellModelValue, basis: string) =>
  key.basis === basis && key.model.deref() === model

/** Move a movie to the newest end of `order`: made now, or played now. */
function touch(model: CellModelValue, basis: string): void {
  // Read on every render, frame ticks included: nothing to do when it is already the newest.
  const newest = order.at(-1)
  if (newest && isKey(newest, model, basis)) return
  order = [
    ...order.filter((key) => !isKey(key, model, basis)),
    { model: new WeakRef(model), basis },
  ]
}

function keep(model: CellModelValue, basis: string, entry: Entry): void {
  let byBasis = kept.get(model)
  if (!byBasis) kept.set(model, (byBasis = new Map()))
  byBasis.set(basis, entry)
  touch(model, basis)
  // Most recently used first, each kept while it fits — so a small movie survives a large one
  // that does not — and the newest always, whatever its size.
  let bytes = 0
  const alive: Key[] = []
  for (const key of [...order].reverse()) {
    const held = key.model.deref()
    const movies = held && kept.get(held)
    const entry = movies?.get(key.basis)
    if (!movies || !entry) continue
    const size = entry.movie.frames.byteLength
    if (alive.length > 0 && bytes + size > KEPT_BYTES) {
      movies.delete(key.basis)
      continue
    }
    bytes += size
    alive.unshift(key)
  }
  order = alive
}

type Plan =
  | {
      readonly model: CellModelValue
      readonly job: SimulateJob
      readonly basis: string
      readonly traces: RunPlan['traces']
      readonly stimulus: Stimulus | undefined
      readonly sweep: string | undefined
    }
  | { readonly refusal: string }

export interface MovieRequest {
  readonly nodeId: string
  readonly model: CellModelValue | undefined
  readonly params: ParamValues
  readonly record: Value | undefined
  readonly spikes: Value | undefined
  readonly current: Value | undefined
  readonly column: (paramId: string) => string | undefined
}

export function useMovie(request: MovieRequest): MovieState {
  const { nodeId, model, params, record, spikes, current: currentTable } = request
  const run = useGraphStore((s) => s.nodeOutput(nodeId, 'traces'))
  // `ok` to make a movie: a stale card's params are not the run's, and while it runs its output is
  // still the last run's — or a partial one — beside params that are already the next.
  const state = useGraphStore((s) => s.nodeInfo(nodeId).state)
  const current = state === 'ok'
  // Through a ref, read when the plan is made: `column` is a fresh closure each render, resolving
  // what `params` already says, and `params` is waited on through `planKey`.
  const latest = useRef(request)
  latest.current = request
  // What a run reads, by the provenance key's own rule — every visible param that is not
  // presentational — so ticking `Traces`, or any layout param added later, re-plans nothing.
  const planKey = hashValue(
    Object.fromEntries(
      visibleParams(simulateNode, params)
        .filter((p) => !p.presentational)
        .map((p) => [p.id, params[p.id]]),
    ),
  )
  // The job as the card stands, and what it would replay: the cache's key, and the job to make.
  const plan = useMemo((): Plan | undefined => {
    if (!model) return undefined
    const { params, column } = latest.current
    try {
      const { job, labels, traces, sweeps } = planRun(
        model,
        params,
        runInputs({ record, spikes, current: currentTable }, column, params),
        { replay: true },
      )
      // Of the sweep the movie replays (`MOVIE_SWEEP`); made here, so they keep their identity.
      const compartment = injectedCompartment(job)
      const stimulus =
        compartment === undefined
          ? undefined
          : {
              clamps: sweepClamps(job, MOVIE_SWEEP),
              compartment,
              dt: job.dt,
              label: injectedColumn(labels),
            }
      const sweep =
        sweeps && sweeps.cells.length > 1
          ? `sweep ${String(sweeps.cells[MOVIE_SWEEP])} of ${formatNumber(sweeps.cells.length)}`
          : undefined
      return { model, job, basis: movieBasis(job), traces, stimulus, sweep }
    } catch (error) {
      return { refusal: errorMessage(error) }
    }
  }, [model, planKey, record, spikes, currentTable])
  const ready = plan && 'basis' in plan ? plan : undefined
  const hit = ready && kept.get(ready.model)?.get(ready.basis)
  // Played now: the last to be evicted, by when it was used rather than when it was made.
  if (ready && hit) touch(ready.model, ready.basis)

  const [made, setMade] = useState<MovieState>({ status: 'waiting', reason: '' })

  useEffect(() => {
    if (!plan || !current || hit) return
    if ('refusal' in plan) {
      setMade({ status: 'refused', reason: plan.refusal })
      return
    }
    const { model, job, basis } = plan
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
        keep(model, basis, { movie, firing: job.firing })
        // Served from `kept` from here on; this only moves the view off its progress bar.
        if (!controller.signal.aborted) setMade({ status: 'waiting', reason: '' })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setMade({ status: 'refused', reason: errorMessage(error) })
      },
    )
    return () => controller.abort()
  }, [plan, current, hit])

  if (ready && hit) {
    return {
      status: 'ready',
      ...hit,
      traces: ready.traces,
      stimulus: ready.stimulus,
      sweep: ready.sweep,
    }
  }
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
