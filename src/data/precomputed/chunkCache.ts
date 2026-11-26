/**
 * Chunks already fetched, kept for the next box that wants them.
 *
 * ## Why a cutout reader needs one at all
 *
 * A precomputed chunk is big and a box is small. Aedes' segmentation stores 256 x 256 x 64
 * voxels to a chunk — **8.2 x 8.2 x 2.9 µm, 3.0 MB on the wire** — which is wider in xy than
 * most of what reads it. `seam:findMergeCandidates` reads two boxes per open end, a 6 µm one for the
 * search and a larger one for the assessor's patches, and measured on one neuron's 505 ends
 * (`pnpm probe:seam-tip-boxes`):
 *
 * | | chunk fetches | bytes |
 * |---|---|---|
 * | every read fetching its own chunks | 8,438 | 25.4 GB |
 * | distinct chunks the neuron touches | 945 | 2.8 GB |
 *
 * So nine fetches in ten were of bytes the run had already had in its hands. The two boxes of
 * one end overlap entirely — the patch box is drawn around contacts that are inside the search
 * box — and consecutive ends of a neuron are usually inside one chunk of each other.
 *
 * ## What it holds, and why that and not the decoded form
 *
 * The **bytes as fetched**, before decoding. A decoded chunk is several times larger — a 4.2 M
 * voxel chunk is 8.4 MB as a narrow index alone against 3.0 MB compressed — so the compressed
 * form keeps three times as much of the volume in the same budget.
 *
 * **It is a trade, not a free choice, and the second half of it only became visible once this
 * existed.** Cold, the decode was nothing: a box read of 8 chunks took ~900 ms for 24 MB, which
 * is the download at the bandwidth a single chunk measures on its own. Warm, the decode is the
 * *whole* of a hit — a fully cached search box still costs 89 ms and a patch box 247, about
 * 0.33 s an end, because what is held sits one layer below `decodeCompressedSegmentation`. Two
 * boxes of one end also decode the chunks they share, ~10 of them on Aedes, for the same reason.
 *
 * Three times the reach still looks like the better side of that at a budget whose curve does
 * not flatten (see `DEFAULT_CHUNK_BUDGET`), but a decoded tier is what is left on the table and
 * it should be weighed against measurements rather than assumed away.
 *
 * ## Bounded, and by bytes
 *
 * A count would be a budget in a unit nobody can reason about — chunk sizes differ per dataset
 * and per scale, and the same 32 chunks is 96 MB here and 400 MB on a volume with larger ones.
 * `docs/limits.md`' rule, applied to a cache: state a limit in the units of what it protects.
 *
 * Least-recently-used, because the access pattern is a walk: a run works through ends in the
 * order its table gives, and what it wants next is overwhelmingly what it wanted last. On that
 * neuron, a 512 MB cache answers 81% of fetches in the table's own order and 56% with the ends
 * sorted by score — locality is the reader's to spend, and a cache below the working set cannot
 * make a scattered walk local. One at or above it can, which is what the table on
 * `DEFAULT_CHUNK_BUDGET` is for.
 *
 * ## It is the caller's, not a module global
 *
 * Whoever makes one decides how long it lives and how big it is, and when it is dropped the
 * bytes go with it. A global would keep a run's working set alive for the session and give every
 * other reader in the tab a share of a budget none of them asked for.
 */

/**
 * A fetched chunk's bytes, by the key `chunkKeyOf` gives them.
 *
 * **A key, not a URL**, though on an unsharded volume it happens to be one. A sharded scale's
 * key is `base/scale#morton` — an address that was never fetched, because the bytes came out of
 * a shard by range. Calling the parameter a URL would make that coincidence look like a
 * contract, and the next person to improve the key (a second volume kind, a channel) would
 * break the unsharded *fetch* rather than a lookup.
 */
export interface ChunkCache {
  /** The bytes for this key, or undefined. Reading one makes it the most recently used. */
  get(key: string): ArrayBuffer | undefined
  /**
   * Keep these bytes, evicting the least recently used until the budget holds.
   *
   * A buffer larger than the whole budget is **not** kept — holding it would evict everything
   * else to store something the next `set` evicts again.
   */
  set(key: string, bytes: ArrayBuffer): void
  /**
   * What is held, in bytes. For `pnpm probe:seam-tip-boxes` and for tests.
   *
   * **Not for the memory meter, which cannot see this.** `ByteLedger` is walked from
   * `geometryCache`'s `forEachHeldGeometry`, and nothing visits a chunk cache — so a run
   * holding the default budget is a figure the readout does not have.
   * `docs/backends-precomputed.md` records what that costs.
   */
  readonly bytes: number
  /** How many chunks were asked for, and how many of those were held. For a run's own report. */
  readonly asked: number
  readonly hits: number
  /**
   * What it was given to hold, in bytes.
   *
   * Carried so a caller can tell "this cache is missing" from "this cache was switched off":
   * at a budget of zero every `set` is refused and every `get` misses, so the counters alone
   * read as a cache doing badly rather than one a reader deliberately turned off. Advice aimed
   * at the first is noise in the second, and `docs/limits.md` records what a channel that
   * speaks when there is nothing to do teaches a reader to do with the next one.
   */
  readonly budget: number
}

/**
 * 512 MB.
 *
 * **The curve does not flatten, which is the thing to know before changing this.** A whole
 * neuron's working set is bounded — the 505-end neuron measured touches 945 distinct chunks,
 * 2.8 GB — so a cache big enough to hold it answers nine fetches in ten whatever order the ends
 * are visited in, and every budget below that is a bet on locality. Per tip, on that neuron:
 *
 * | budget | chunks | ends in table order | ends sorted by score |
 * |---|---|---|---|
 * | none | 0 | 72 MB | 72 MB |
 * | 192 MB | 64 | 17.6 MB | 43.3 MB |
 * | 385 MB | 128 | 14.9 MB | 36.4 MB |
 * | 512 MB | 170 | 13.4 MB | 31.6 MB |
 * | 771 MB | 256 | 11.9 MB | 25.0 MB |
 * | 1.5 GB | 512 | 7.4 MB | 12.4 MB |
 * | 2.8 GB | 945 | 5.6 MB | 5.6 MB |
 *
 * The second column is a run whose ends arrive in the order the open-end table gives, which is
 * roughly the order they lie along the neuron; the third is the same run with a `Sort` above it,
 * which scatters them. A reader who has sorted is paying for it here, and the budget is how they
 * can stop.
 *
 * So why 512 MB and not the 1.5 GB that is plainly faster: the failure this is bounded against
 * is not a slow tab but a dead one. `ArrayBuffer` bytes sit outside V8's JS heap, so
 * `jsHeapSizeLimit` does not bind and nothing in the browser refuses before the process does —
 * an out-of-memory loses the whole run, which on several hundred ends is worth more than the
 * minutes a larger cache saves. 512 MB is a few times the 133 MB the assessor's weights already
 * hold and is comfortable on a machine with 8 GB; past that is a decision about a particular
 * machine, which is why `seam:findMergeCandidates` exposes it rather than this file deciding.
 */
export const DEFAULT_CHUNK_BUDGET = 512 * 1024 * 1024

/**
 * When a chunk will next be wanted, for a caller that knows.
 *
 * **Least-recently-used is a guess about the future, and this reader does not have to guess.**
 * A run that searches open ends knows every end's position before it fetches anything, so it
 * knows which chunks each end will want and in what order — and with that, the best possible
 * policy is not LRU but Bélády's: evict whatever is wanted furthest away. Measured over one
 * 505-end neuron at a 512 MB budget, a tip read 13.7 MB under LRU and 9.3 MB under this; with
 * the ends sorted by score, 32.0 MB against 17.8.
 *
 * Return a position on whatever scale the caller counts in — tips, reads, anything ascending —
 * and `Infinity` for a chunk nothing will ask for again. Those are evicted first, which is the
 * "drop it once its last end has passed" rule arriving for free rather than as its own
 * mechanism.
 *
 * A key the plan does not recognise answers `Infinity`, so a planner that has drifted from the
 * reader degrades to evicting arbitrarily rather than to being wrong. See `chunkKeyOf`, which
 * exists to stop that drift.
 */
export type NextUse = (key: string) => number

/**
 * A cache holding up to `budget` bytes of fetched chunks.
 *
 * With no `nextUse` it is least-recently-used, which is the right policy for a reader that
 * cannot see ahead. With one it is Bélády's, which is the best any policy can do.
 */
export function chunkCache(
  budget: number = DEFAULT_CHUNK_BUDGET,
  nextUse?: NextUse,
): ChunkCache {
  /*
   * A `Map` **is** the LRU: JavaScript maps iterate in insertion order, so deleting a key and
   * setting it again moves it to the end, and `keys().next()` is the oldest. No second structure
   * to keep in step with this one, which is where a hand-rolled list goes wrong.
   *
   * It is still the order `nextUse` falls back on: two chunks wanted at the same position, or
   * two the plan has never heard of, are separated by which was read longer ago.
   */
  const held = new Map<string, ArrayBuffer>()
  let bytes = 0
  let asked = 0
  let hits = 0

  /**
   * The one to drop: wanted furthest away, or the least recently read where nothing says.
   *
   * **The chunk just stored is a candidate like any other**, and where the plan says nothing
   * will want it again it is the one that goes. That is right rather than a waste: the read
   * that fetched it has already pasted it, and holding bytes with no next use is holding bytes
   * at the expense of bytes that have one.
   *
   * A scan of what is held rather than a heap. Held is a few hundred entries at the budgets
   * this is used at and an eviction happens once per fetched chunk, so the scan is thousands of
   * comparisons against a 3 MB download — and a heap would need re-keying every time the plan's
   * cursor moved, which is once per open end.
   */
  const worst = (): string | undefined => {
    if (!nextUse) return held.keys().next().value
    let victim: string | undefined
    let furthest = -Infinity
    for (const key of held.keys()) {
      const when = nextUse(key)
      /*
       * **`>`, not `>=`** — and the difference is the whole fallback policy. `held` iterates
       * oldest-first, so a `>=` lets every tie overwrite the victim and the *last* key seen
       * wins: the newest. That is MRU, which on a walk along a neuron evicts precisely the
       * chunk the next box is most likely to want.
       *
       * Ties are not a corner. Where the plan knows every key they happen only among chunks
       * wanted at the same end, and Bélády is indifferent — no loss either way. Where it knows
       * nothing they are **everything**: a plan not yet armed answers `Infinity` for every key
       * (`openSearchVolume` hands `(key) => plan?.nextUse(key) ?? Infinity` before the first
       * `planEnds`), and then this line alone decides whether the fallback is the LRU the
       * header promises or its exact opposite.
       */
      if (when > furthest) {
        furthest = when
        victim = key
      }
    }
    return victim
  }

  return {
    budget,
    get(key) {
      asked += 1
      const found = held.get(key)
      if (!found) return undefined
      hits += 1
      held.delete(key)
      held.set(key, found)
      return found
    },
    set(key, buffer) {
      if (held.has(key)) return
      // Bigger than the budget: see `ChunkCache.set`. Nothing is evicted for it either.
      if (buffer.byteLength > budget) return
      held.set(key, buffer)
      bytes += buffer.byteLength
      while (bytes > budget) {
        const victim = worst()
        if (victim === undefined) break
        const dropped = held.get(victim)!
        held.delete(victim)
        bytes -= dropped.byteLength
      }
    },
    get bytes() {
      return bytes
    },
    get asked() {
      return asked
    },
    get hits() {
      return hits
    },
  }
}
