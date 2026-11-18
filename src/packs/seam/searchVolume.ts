/**
 * Where the search reads its voxels, and how one open end becomes a box of labelled supervoxels.
 *
 * `searchRun.ts` takes its three steps injected and never fetches; this is the half that does the
 * fetching for the two of them that read voxels. It turns a CAVE datastack into the addresses the
 * search needs and hands back a `box()` per end. The level-2 chunk counts are the node's own
 * step: they are keyed by root rather than by box, and `l2ChunkCounts` already memoises them.
 *
 * **Opening the volume and reading a box are shared; the rest is the search's.** A second
 * datastack reader came (`mergeAnchors.ts`), so "open this datastack's supervoxels" is
 * `findSupervoxels` in `src/data/cave/volumes.ts` — which also says why the supervoxels are two
 * requests away, only the first needing a token — and the rooted-box read is `rootedBox.ts`.
 * What stays here is the search's own state: its scale, its instant, its chunk plan. What it
 * should **not** become is a `DataSource` method: `volumes.ts`' own header records that decision,
 * because turning supervoxels into neurons is a chunkedgraph lookup at a timestamp that the reader
 * cannot do and should not pretend to.
 *
 * ## Why the scale is asked for, not stated
 *
 * The ranker's manifest publishes `config.cutout_xy_nm`, and on Aedes it says 64 while the
 * volume's scales are 16 and 32 nm (its bucket `info`, read 2026-11-16) — no 64. That is not a
 * disagreement: `scaleNear` is what `caveclient` does too — ask for a resolution and take the
 * volume's nearest, which on Aedes is 32. Reading the number from the manifest rather than pinning
 * 32 here is what keeps this honest on a dataset whose pyramid has the scale asked for, where the
 * choice changes `min_dist_um` by a whole voxel.
 *
 * The 16 nm scale is the chunkedgraph's own base (`graph.cv_mip`), and it is what a merge's
 * positions are in — `mergeAnchors.ts` reads that one, not this.
 */

import { findSupervoxels } from '../../data/cave/volumes'
import type { CaveRequestOptions } from '../../data/cave/client'
import { chunkCache } from '../../data/precomputed/chunkCache'
import type { ChunkPlan, ChunkPlanBoxes } from './chunkPlan'
import { chunkPlanFor } from './chunkPlan'
import type { Triple, VolumeScale } from '../../data/precomputed/volume'
import { boxAround, openVolume, scaleNear } from '../../data/precomputed/volume'
import type { CandidatePoolRequest } from '../../pyodide/cutoutSummary'
import type { BoxReader } from './rootedBox'
import { boxReader, labelledBox } from './rootedBox'
import type { EndToSearch } from './searchRun'
import type { TipRow } from './searchTips'

/**
 * The search's reader: a `BoxReader` at the run's instant (see `rootedBox.ts` for the memo and
 * the chunk cache, which is the run's single biggest saving), plus the search's scale and plan.
 */
export interface SearchVolume extends BoxReader {
  readonly scale: VolumeScale
  /**
   * Tell the cache which ends are coming, **in the order they will be searched**.
   *
   * Every end's two boxes are functions of its tip position, which is in the table before
   * anything is read — so the cache need not guess what to evict, and `chunkPlan.ts` says what
   * that is worth. Called per neuron, because a neuron's ends are what overlap.
   *
   * It is a method on the volume rather than a field the run assigns because the plan and the
   * cache have to be the same object's: the cache was built holding a reference to whatever the
   * current plan is, and a run that set one without the other would get a policy quietly
   * answering about last neuron's ends.
   */
  planEnds(tipsNm: readonly Triple[], reach: EndReach): void
  /** One end searched. Moves the plan on, so what it has passed stops being worth keeping. */
  endSearched(): void
}

/**
 * How far each of an end's two boxes reaches, which is all the plan needs beyond the positions.
 *
 * **Derived from `ChunkPlanBoxes`, not restated.** The volume supplies `base` and `scale`
 * itself, so a caller gives the rest — and spelling those three fields out again here was a
 * second declaration that type-checks whichever copy is stale: `planEnds` spreads
 * `{ base, scale, ...reach }`, and a spread is not excess-property-checked, so a field added to
 * one and not the other is dropped in silence. That is the failure `chunkPlan.ts` calls "quietly
 * useless rather than loudly wrong", arriving through the type system instead of the keys.
 */
export type EndReach = Omit<ChunkPlanBoxes, 'base' | 'scale'>

/** A materialization with no moment CAVE lists — the one a datastack with no chunkedgraph is read at. */
export function unlistedMaterialization(datastack: string, version: number): string {
  return (
    `Materialization ${version} of ${datastack} has no timestamp CAVE lists, so there is no ` +
    'moment to read the segmentation at. Point `Datastack` at a materialization the datastack ' +
    'lists.'
  )
}

/**
 * Open a datastack's supervoxel volume at the resolution the pipeline asks for, rooted at `at`
 * until the reader is moved (`forgetRoots`). The datastack's own refusals are
 * `findSupervoxels`'.
 */
export async function openSearchVolume(
  datastack: string,
  xyNm: number,
  /** Epoch ms, already resolved by the caller (`momentsOf`), who refuses one that cannot be. */
  at: number,
  options: CaveRequestOptions,
  /**
   * How much the run may spend holding chunks it has fetched, in bytes.
   *
   * A parameter rather than a constant read here, because the budget is a reader's decision —
   * `seam:suggestMerges` exposes it — and because a probe measuring what a cache is worth has to
   * be able to turn it off. Absent is `chunkCache`'s own default.
   */
  budget: { chunkBytes?: number } = {},
): Promise<SearchVolume> {
  const source = await findSupervoxels(datastack, options)
  const info = await openVolume(source.base, options)
  const scale = scaleNear(info, xyNm)
  // The closures below read only this, so a run's lifetime keeps no more of the source alive.
  const base = source.base
  /*
   * The plan and the cache are made together, the cache reading whichever plan is current
   * through the `let` below — captured by reference, since the eviction callback, `planEnds`
   * and `endSearched` are all in this scope. A run replaces the plan per neuron; until it does
   * there is none, and the cache is plain least-recently-used, which is the right answer for a
   * caller that has not said what is coming.
   */
  let plan: ChunkPlan | undefined
  const chunks = chunkCache(budget.chunkBytes, (key) => plan?.nextUse(key) ?? Infinity)
  return {
    ...boxReader({ ...source, info }, at, chunks),
    scale,
    planEnds(tipsNm, reach) {
      // Nothing to plan for a cache that holds nothing, and the plan is tens of thousands of
      // key builds per neuron — free to skip for a reader who set `Chunk cache` to 0.
      plan = chunks.budget > 0 ? chunkPlanFor(tipsNm, { base, scale, ...reach }) : undefined
    },
    endSearched() {
      plan?.advance()
    },
  }
}

/**
 * Whether a box can be cut around this end at all.
 *
 * `boxAroundAll` **throws** for a centre whose box lies wholly outside the volume — it clamps,
 * and an empty clamp is not a box. That is right for it and wrong for a run: one open end
 * outside the segmentation would abort a search of several hundred, after the expensive ones had
 * already been paid for, where every other unusable row is dropped and counted.
 *
 * The try/catch is deliberate and is the point: asking "would this clamp to nothing" any other
 * way means a second copy of the clamping rule here, and the two would come to disagree at the
 * edge of a volume — which is exactly where this is asked.
 */
export function boxFits(volume: SearchVolume, tip: TipRow, halfWidthNm: number): boolean {
  try {
    boxAround(volume.scale, [...tip.nm], halfWidthNm)
    return true
  } catch {
    return false
  }
}

/**
 * One open end, as `searchEnds` takes it.
 *
 * **The box is a function**, which is `EndToSearch`' whole reason: a 6 µm cutout is about 19 MB
 * and a neuron has hundreds of ends, so each is read, measured and dropped before the next. The
 * closure is made here, in a module-level function, so it holds its six parameters and not
 * whatever scope the caller happened to be in — CLAUDE.md's rule for a closure kept past its
 * build.
 */
export function endToSearch(
  volume: SearchVolume,
  tip: TipRow,
  at: number,
  halfWidthNm: number,
  options: CaveRequestOptions,
  /**
   * An accepted piece's path, read as the neuron's — `labelledBox`' `alias`, `aliasOf`.
   * Required for that parameter's reason: an end built without one compiles, reads its box
   * unaliased, and has the piece's own voxels as a candidate of the neuron it is part of.
   */
  alias: ReadonlyMap<bigint, bigint> | undefined,
): EndToSearch {
  // The neuron the end is asked about: the tip's own root, or the one it is being extended into.
  const queryRoot = BigInt(tip.seed ?? tip.neuronId)
  return {
    tip: at,
    queryRoot,
    ...(alias && alias.size > 0 ? { alsoQuery: [...alias.keys()] } : {}),
    box: () => readPool(volume, tip, queryRoot, halfWidthNm, options, alias),
  }
}

async function readPool(
  volume: SearchVolume,
  tip: TipRow,
  queryRoot: bigint,
  halfWidthNm: number,
  options: CaveRequestOptions,
  alias: ReadonlyMap<bigint, bigint> | undefined,
): Promise<CandidatePoolRequest> {
  const box = boxAround(volume.scale, [...tip.nm], halfWidthNm)
  const read = await labelledBox(volume, volume.scale, box, options, alias)
  return { ...read, queryRoot, endNm: [...tip.nm] }
}
