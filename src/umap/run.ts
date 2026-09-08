/**
 * UMAP, in the tab.
 *
 * A compute backend in the shape `src/pyodide` established — the request type lives here with
 * the runner, and the *shaping* of a node's inputs into one lives in `nodes/lib/embedOps.ts`.
 * Nothing here knows what a neuron is.
 *
 * **Why this is JavaScript and not the Python bridge.** `umap-learn` requires `numba`, and
 * numba needs LLVM, which Pyodide does not ship — checked against the pinned lock rather than
 * recalled: v314.0.5 carries 356 packages and none of them is `numba`, `llvmlite`,
 * `pynndescent` or `umap-learn`. So the seventh Python capability could not have been this one
 * at any download budget. scikit-learn *is* there (t-SNE, PCA, MDS, all with
 * `metric='precomputed'`) at 4.4 MB plus scipy's 14.0 MB, which is the shape a different
 * answer to the same question would have taken.
 *
 * **What that costs in fidelity, said out loud.** `umap-js` is PAIR-code's reimplementation,
 * not a binding, so this cannot make the claim `docs/python-pyodide.md` makes about clustering
 * — "fastcore's linkage *is* SciPy's, checked on 60 trials". Two UMAP implementations do not
 * agree cell-for-cell and neither do two seeds of one implementation; what is reproducible is
 * *this* implementation at a fixed seed, which is what `UmapOptions.seed` is for and what makes
 * invariant 4 hold without a nonce param.
 *
 * **The library is dynamically imported**, so it stays out of the main chunk — elkjs, three and
 * sigma's doctrine, and the same one `canExport.ts` follows for the emitters.
 */

/** How far along, and what is happening. Both halves reach the node's status bar. */
type Report = (fraction: number, note?: string) => void

/**
 * A k-NN graph in exactly the form umap-js takes, which is umap-learn's.
 *
 * Every route into the Embedding node converges here — a score matrix, a table of feature
 * vectors and a k-NN table are three ways of writing one of these down, and UMAP consumes
 * nothing else. See `embedOps.ts` for the three adapters.
 *
 * Two conventions are load-bearing and neither is checkable from inside:
 *
 * - **Row `i` names itself first, at distance 0.** `smoothKNNDistance` sums from index *1*
 *   (`umap.ts:363`, and umap-learn's `smooth_knn_dist` does the same), because the reference
 *   convention is that a point is its own nearest neighbour. Hand it `k` real neighbours with
 *   no self and the closest one is silently dropped from every bandwidth search — a slightly
 *   wrong picture with nothing anywhere to say so.
 * - **Every row is exactly `k` long.** umap-js reads `knnIndices[0].length` in
 *   `computeMembershipStrengths` while `fuzzySimplicialSet` is handed `nNeighbors`, so a ragged
 *   set makes those two disagree about `log2(k)`. Short rows pad with `-1`, which the library
 *   already skips (`umap.ts:757`) — and which is the same value `knnTable` drops on the way out
 *   of NBLAST k-NN, so the two ends of that wire already meant the same thing by it.
 */
export interface KnnGraph {
  /** `n` rows of exactly `k` entries; row `i` starts with `i`, and `-1` pads a short row. */
  indices: number[][]
  /** Distances aligned with `indices`; `[i][0]` is 0. */
  distances: number[][]
  /** What each row is, in row order. */
  labels: string[]
}

export interface UmapOptions {
  /** umap-js's `nNeighbors`, **including** the point itself — so this is `KnnGraph`'s `k`. */
  nNeighbors: number
  minDist: number
  spread: number
  /** Seeds the one PRNG the library takes, which is what makes a run reproducible. */
  seed: number
  /** 0 means the library's own choice: 500 below 10,000 points, 200 above. */
  epochs: number
}

export interface UmapHooks {
  onProgress?: Report
  signal?: AbortSignal
}

/**
 * A seeded PRNG, because `Math.random` would break invariant 4.
 *
 * mulberry32: 32 bits of state, uniform enough for negative sampling and layout initialisation,
 * and short enough to read. The alternative was the `prando` umap-js's own tests use, which is a
 * dependency for four lines.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * How long a slice of the optimisation loop may run before yielding to the browser.
 *
 * Above a frame budget on purpose, and the yield below is why: a chain of `setTimeout(…, 0)`
 * hits Chrome's nested-timer clamp past five levels and costs about 4 ms of dead wall clock per
 * yield whatever the delay asked for. At 24 ms that is a sixth of the run spent waiting; the
 * shorter slices a smoother bar would want make it worse, not better. `scheduler.yield()` has
 * no such clamp and is used where the engine has it.
 */
const SLICE_MS = 24

/**
 * Hand the browser a turn, without paying the nested-timer clamp where it can be avoided.
 *
 * `scheduler.yield()` resumes on the same task queue with no minimum delay; `setTimeout` is the
 * fallback and is still a *task* rather than a microtask, which is the part that matters — an
 * `await Promise.resolve()` runs before the browser gets to paint, so the progress it reports
 * would be progress nobody sees.
 */
function yieldToBrowser(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0))
}

/** Where the fuzzy-set construction ends and the optimisation's own progress begins. */
const INIT_SHARE = 0.25

/**
 * Run UMAP over a k-NN graph, yielding to the browser as it goes.
 *
 * **Sliced rather than called**, which is `prefuseRun`'s arrangement and for its reasons: a bare
 * `fit()` is one synchronous call that reports nothing and cannot be cancelled, and this node is
 * `expensive` precisely because that call is long. `initializeFit` / `step()` is umap-js's own
 * public seam for it, so nothing here reaches inside the library.
 *
 * Returns the embedding row-major as `[x0, y0, x1, y1, …]` — a flat `Float64Array` rather than
 * the library's `number[][]`, for `PyResult`'s reason one layer over: `n` boxed two-element
 * arrays is `n` allocations to hand to a table builder that wants columns.
 */
export async function runUmap(
  graph: KnnGraph,
  options: UmapOptions,
  hooks: UmapHooks = {},
): Promise<Float64Array> {
  const report = hooks.onProgress ?? (() => undefined)
  const n = graph.labels.length

  report(0.02, 'loading UMAP')
  const { UMAP } = await import('umap-js')

  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: options.nNeighbors,
    minDist: options.minDist,
    spread: options.spread,
    random: mulberry32(options.seed),
    ...(options.epochs > 0 ? { nEpochs: options.epochs } : {}),
  })
  umap.setPrecomputedKNN(graph.indices, graph.distances)

  /*
   * The library needs an `X` of the right length and reads nothing out of it once the k-NN is
   * precomputed: `initializeFit` skips `nearestNeighbors`, `fuzzySimplicialSet` reads the graph
   * off `this`, and `makeSearchGraph` uses `X.length` alone. The values would matter only to
   * `transform()`, which projects *new* points into a fitted embedding and which nothing here
   * calls. Densifying real vectors to satisfy a signature would be the whole point of the
   * precomputed route thrown away — the connectivity case is hundreds of thousands of features
   * wide.
   *
   * A holey array rather than `n` empty ones, which is one allocation instead of `n` for a
   * value nothing reads. umap-js keeps it as `this.X` for the whole run.
   */
  const placeholder: number[][] = new Array<number[]>(n)

  report(0.05, `${n.toLocaleString()} points`)
  const total = umap.initializeFit(placeholder)
  throwIfAborted(hooks.signal)

  let epoch = 0
  let sliceStart = performance.now()
  while (epoch < total) {
    epoch = umap.step()
    if (performance.now() - sliceStart < SLICE_MS && epoch < total) continue
    throwIfAborted(hooks.signal)
    report(INIT_SHARE + (1 - INIT_SHARE) * (epoch / total), `epoch ${epoch} of ${total}`)
    await yieldToBrowser()
    sliceStart = performance.now()
  }

  const embedding = umap.getEmbedding()
  const out = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) {
    const point = embedding[i]
    out[i * 2] = point?.[0] ?? 0
    out[i * 2 + 1] = point?.[1] ?? 0
  }
  return out
}

/**
 * An aborted run must reject rather than resolve with what it had.
 *
 * `docs/adding-a-node.md`'s rule, and it matters more here than for a fetch: a half-optimised
 * UMAP is a picture, not an obviously-truncated one, so resolving with it would put a plausible
 * arrangement on screen under a node that reads as finished.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Cancelled')
}
