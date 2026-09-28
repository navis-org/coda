/**
 * A source's dataset listing: the list, the request that fills it, and the peek that starts it.
 *
 * neuPrint, CAVE and CATMAID each kept the same three fields — the cached list, the in-flight
 * promise, a `listingRequested` flag — and repeated the same three rules, and the copies had
 * already diverged on retry: CATMAID's dropped a rejected promise, the other two cleared theirs in
 * a `finally`. Both happened to retry; the next copy need not have. The rules, once:
 *
 * 1. **Concurrent callers share one request.** The dataset picker, the Connections panel and every
 *    dataset node's inference can all ask at once on first load.
 *
 * 2. **A peek starts the fetch it cannot answer — once per instance, never once per peek.**
 *    `inferOutputs` may not await (invariant 2), so a peek that only ever said "I don't know"
 *    would leave a dataset node on "Latest" publishing a type with no dataset id in it until
 *    somebody pressed Run, and every column picker downstream on the canonical schema until then
 *    (`docs/gotchas.md` has the incident: the first Run of a session behaved differently from the
 *    second). But inference runs on every graph mutation, so a failed listing retried *from a
 *    peek* would be a request per keystroke — or, with no token, an auth-failure popup per
 *    keystroke. The flag is not cleared on failure.
 *
 * 3. **A failed listing is retried next time** by anybody who awaits one — the Connections panel,
 *    a node's `evaluate`. That is the recovery rule 2 leaves room for. The memo is
 *    `memoPromise`'s, so a rejection is never kept, under either variant.
 *
 * What a success is kept for is the source's choice (`keep`, `memoPromise`'s vocabulary): neuPrint
 * and CAVE re-fetch on every awaited call, which is how the Connections panel refreshes and how a
 * CAVE listing notices a materialization expiring; CATMAID keeps its project list for the session,
 * because `evaluate` lists on every Run and a community server's project list does not move under
 * one.
 *
 * The list is published here, **before** `reportSourceLearned`, so the re-inference that event
 * causes finds it — a loader reporting before its caller had stored the answer would re-infer
 * against the empty listing it was meant to replace. There is no reset: a source is one server for
 * its whole life (CAVE's included, one per deployment), so no listing can land as another's.
 *
 * 4. **A peek whose fetch needs a credential is gated on having one** (`credential`), and re-armed
 *    by the credential *changing*. Without a token the fetch can only fail, and neuPrint's client
 *    reports a missing token straight to the channel that opens the Connections dialog — so an
 *    ungated peek put that dialog in front of somebody who had only dragged a card onto the
 *    canvas, or asked the assistant a question. Returning early spends nothing, so the first
 *    peek after signing in is still the one that starts it; and a listing that failed under one
 *    token is asked again under the next, rule 2's once-per-instance being once per credential.
 *    Rules 2 and 4 together are `PeekGate`, which the sources' own peeks share.
 *
 * What stays in each source is what is genuinely its own: the loaders, neuPrint's merge-on-relist
 * (which keeps what discovery learned) and its `peekDataset`, which answers from per-dataset state
 * that exists before any listing; CAVE's kept failures.
 */

import { memoPromise, type Keep } from './memoPromise'
import { PeekGate } from './peekGate'
import { reportSourceLearned, type DatasetInfo } from './source'

export class DatasetListing {
  private readonly sourceId: string
  private readonly load: (signal?: AbortSignal) => Promise<DatasetInfo[]>
  private readonly keep: Keep
  private list: DatasetInfo[] | undefined
  /** The request in flight. */
  private readonly pending = new Map<'listing', Promise<DatasetInfo[]>>()
  /** Rules 2 and 4 in the header. */
  private readonly gate: PeekGate
  /** The credential the listing needs, where it needs one. */
  private readonly credential: (() => string | undefined) | undefined

  constructor(
    sourceId: string,
    load: (signal?: AbortSignal) => Promise<DatasetInfo[]>,
    options: {
      keep: Keep
      /** The credential the listing request needs, where it needs one. See rule 4. */
      credential?: () => string | undefined
    },
  ) {
    this.sourceId = sourceId
    this.load = load
    this.keep = options.keep
    this.gate = new PeekGate(options.credential)
    this.credential = options.credential
  }

  /** The listing, awaited. Retries after a failure; see `keep` for what it does after a success. */
  get(signal?: AbortSignal): Promise<DatasetInfo[]> {
    if (this.keep === 'resolved' && this.list) return Promise.resolve(this.list)
    return memoPromise(
      this.pending,
      'listing',
      () =>
        this.load(signal).then((list) => {
          this.list = list
          // `peek` answers differently from here on, and a dataset node's "Latest" resolves
          // through it — so anything already inferred against the empty listing is now wrong.
          reportSourceLearned(this.sourceId)
          return list
        }),
      // In flight only: a kept success is `list`, above, which `revise` can update.
      { keep: 'inflight' },
    )
  }

  /**
   * The listing if it has landed — and, the first time it has not, the request that makes it
   * land. Swallowed: a peek has no caller to report to, and a 401 already travels on its own
   * channel to the Connections panel.
   */
  peek(): DatasetInfo[] | undefined {
    // A landed listing is one account's, so it is not answered while signed out.
    if (this.credential && !this.credential()) return undefined
    if (!this.list && this.gate.open()) void this.get().catch(() => undefined)
    return this.list
  }

  /** One dataset from the landed listing. **Never starts a fetch** — call `peek` for that. */
  find(datasetId: string): DatasetInfo | undefined {
    return this.list?.find((dataset) => dataset.id === datasetId)
  }

  /**
   * Swap one dataset's info for a freshened one, as a new list. Answers whether it was listed.
   *
   * For what a source learns after the listing — CATMAID's regions, neuPrint's discovery — and
   * does not itself report, since each source decides whether an unlisted dataset is news.
   */
  revise(datasetId: string, next: (info: DatasetInfo) => DatasetInfo): boolean {
    if (!this.list?.some((dataset) => dataset.id === datasetId)) return false
    this.list = this.list.map((dataset) => (dataset.id === datasetId ? next(dataset) : dataset))
    return true
  }
}
