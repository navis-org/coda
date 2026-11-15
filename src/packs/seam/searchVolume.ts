/**
 * Where the search reads its voxels, and how one open end becomes a box of labelled supervoxels.
 *
 * `searchRun.ts` takes its three steps injected and never fetches; this is the half that does the
 * fetching for the two of them that read voxels. It turns a CAVE datastack into the addresses the
 * search needs and hands back a `box()` per end. The level-2 chunk counts are the node's own
 * step: they are keyed by root rather than by box, and `l2ChunkCounts` already memoises them.
 *
 * **It sits in the pack, not in `src/data`, because it has one caller.** Nothing in
 * `openSearchVolume` is about SEAM — it is "open this datastack's supervoxels at about this
 * resolution", and it would read perfectly well beside `supervoxelVolumeOf` in
 * `src/data/cave/volumes.ts`. The day a second datastack reader wants a box it should move there.
 * What it should **not** become is a `DataSource` method: `volumes.ts`' own header records that
 * decision, because turning supervoxels into neurons is a chunkedgraph lookup at a timestamp that
 * the reader cannot do and should not pretend to.
 *
 * ## Two requests, and only the first needs a token
 *
 * The supervoxels are not at the `graphene://` address at all. That address is the chunkedgraph,
 * whose own `info` names a `data_dir` bucket where the watershed voxels live, and the bucket is
 * public where the chunkedgraph is not. So this opens the volume once per run and reads boxes out
 * of it without a credential.
 *
 * ## Why the scale is asked for, not stated
 *
 * The ranker's manifest publishes `config.cutout_xy_nm`, and on Aedes it says 64 while the
 * volume's only scale is 32 nm. That is not a disagreement: `scaleNear` is what `caveclient` does
 * too — ask for a resolution and take the volume's nearest. Reading the number from the manifest
 * rather than pinning 32 here is what keeps this honest on a dataset with a real pyramid, where
 * the choice changes `min_dist_um` by a whole voxel.
 *
 * ## The run holds its own supervoxel map, and that is load-bearing
 *
 * A box is ~14,000 supervoxels and a neuron is hundreds of boxes, so the lookup is the second
 * biggest thing this file does. `rootsAtInstant` is the arm of `rootIds.ts` that does **not**
 * touch the shared store — its docstring says why asking that one per box is quadratic — and
 * `SearchVolume.roots` is the map it writes into instead. Overlap between neighbouring ends is
 * then free, and nothing of the run is kept past it.
 *
 * **Absence is remembered too**, as `0n`. A supervoxel the graph does not list is not going to
 * start appearing, and leaving it out of the map would mean re-asking for it in every later box
 * that holds it — which, since the whole premise is that boxes overlap, is the one unremovable
 * request per end.
 *
 * ## A supervoxel the graph does not list is root `0`
 *
 * The vendored `summarize_cutout` says `roots_u`: "root of each supervoxel (0 = none)", and
 * treats zero as no object at all. So an absent lookup is written as `0n` rather than dropped —
 * dropping one would shorten the array and silently shift every later supervoxel's root onto the
 * wrong label, which is the kind of failure that still ranks.
 */

import type { GrapheneSource } from '../../data/cave/graphene'
import { parseGrapheneSource } from '../../data/cave/graphene'
import { datastackRecord } from '../../data/cave/datastack'
import { supervoxelVolumeOf } from '../../data/cave/volumes'
import type { CaveRequestOptions } from '../../data/cave/client'
import type { RootsAt } from '../../data/cave/rootIds'
import { instantOf, rootsAtInstant } from '../../data/cave/rootIds'
import type { VolumeInfo, VolumeScale } from '../../data/precomputed/volume'
import { boxAround, openVolume, readLabelBox, scaleNear } from '../../data/precomputed/volume'
import type { CandidatePoolRequest } from '../../pyodide/cutoutSummary'
import type { EndToSearch } from './searchRun'
import type { TipRow } from './searchTips'

/** Everything a box read needs, resolved once per run. */
export interface SearchVolume {
  /** The supervoxel volume's base URL — the bucket the chunkedgraph named. */
  readonly base: string
  readonly scale: VolumeScale
  readonly info: VolumeInfo
  /** The chunkedgraph, for the level-2 chunk counts the node asks for. */
  readonly graphene: GrapheneSource
  /**
   * The instant every box is read at, in epoch ms. **Resolved once, here** — a `RootsAt` that
   * names a materialization CAVE does not list has no instant, and resolving it per box would
   * make that an empty answer repeated hundreds of times instead of a refusal made before the
   * first byte. `openSearchVolume` is where it is refused.
   */
  readonly at: number
  /**
   * This run's supervoxel → root map, `0n` for one the graph does not list.
   *
   * 64-bit on both sides: a decimal string per supervoxel is what this would otherwise retain,
   * and at a run's scale (a ~14,000-supervoxel box per end, hundreds of ends) that is the larger
   * half of its memory. `0n` is also the "no object" the vendored `summarize_cutout` reads, so
   * absence needs no second sentinel.
   */
  readonly roots: Map<bigint, bigint>
}

/**
 * Open a datastack's supervoxel volume at the resolution the pipeline asks for.
 *
 * Refuses by name at each step rather than returning undefined: every one of these is a fact
 * about the datastack a reader picked, and "no candidates" is what a silent failure here would
 * look like.
 */
export async function openSearchVolume(
  datastack: string,
  xyNm: number,
  when: RootsAt,
  options: CaveRequestOptions,
): Promise<SearchVolume> {
  const record = await datastackRecord(datastack, options)
  const graphene = parseGrapheneSource(record.segmentation_source)
  if (!graphene) {
    throw new Error(
      `${datastack} publishes no \`graphene://\` segmentation, so it has no supervoxels to ` +
        'search. This node needs a chunkedgraph datastack.',
    )
  }
  const base = await supervoxelVolumeOf(record, options)
  if (!base) {
    throw new Error(
      `${datastack}'s chunkedgraph names no \`data_dir\`, so there is nowhere to read its ` +
        'supervoxels from.',
    )
  }
  /*
   * Refused here, before a box is read. An unresolvable instant makes every supervoxel resolve to
   * `0n`, so without this the run reads hundreds of 19 MB boxes, measures each one, and then
   * reports that no end had its own neuron in its box — true, and naming the wrong cause.
   * `staleRoots` takes the same decision in prose for the same reason.
   */
  const at = await instantOf(datastack, when, options)
  if (at === undefined) {
    const version = 'version' in when ? when.version : ''
    throw new Error(
      `Materialization ${version} of ${datastack} has no timestamp CAVE lists, so there is no ` +
        'instant to read the segmentation at. Point `Datastack` at a materialization the ' +
        'datastack lists.',
    )
  }
  const info = await openVolume(base, options)
  return { base, scale: scaleNear(info, xyNm), info, graphene, at, roots: new Map() }
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
 * Forget the run's supervoxel lookups.
 *
 * Called between neurons by the node. Overlap is what the map is for, and it is a fact about one
 * neuron's own ends — the tips of two different neurons are nowhere near each other, so carrying
 * the map across them keeps millions of entries that will never be asked for again. Nothing here
 * is a cache in the usual sense: `rootsAtInstant` keeps nothing of its own, by design.
 */
export function forgetRoots(volume: SearchVolume): void {
  volume.roots.clear()
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
): EndToSearch {
  const queryRoot = BigInt(tip.neuronId)
  return {
    tip: at,
    queryRoot,
    box: () => readPool(volume, tip, queryRoot, halfWidthNm, options),
  }
}

async function readPool(
  volume: SearchVolume,
  tip: TipRow,
  queryRoot: bigint,
  halfWidthNm: number,
  options: CaveRequestOptions,
): Promise<CandidatePoolRequest> {
  const box = boxAround(volume.scale, [...tip.nm], halfWidthNm)
  const read = await readLabelBox(volume.base, volume.scale, box, {
    ...options,
    info: volume.info,
  })
  const unknown = new BigUint64Array([...read.labels].filter((id) => !volume.roots.has(id)))
  if (unknown.length > 0) {
    const found = await rootsAtInstant(volume.graphene, volume.at, unknown, options)
    // Absence is written too: see the header on why re-asking is the cost that matters.
    for (let i = 0; i < unknown.length; i++) volume.roots.set(unknown[i]!, found[i]!)
  }
  const roots = BigUint64Array.from(read.labels, (id) => volume.roots.get(id)!)
  return {
    labels: read.labels,
    index: read.index,
    size: read.size,
    roots,
    queryRoot,
    resolutionNm: volume.scale.resolution,
    loVoxels: box.lo,
    endNm: [...tip.nm],
  }
}
