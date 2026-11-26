/**
 * Where a fraction lands once a share of the progress bar has already been spent.
 *
 * Five cards in this pack do something up front — fetch a checkpoint, read a set's two files —
 * and then do their own work against the rest of the bar. All five wrote
 * `SHARE + (1 - SHARE) * x` by hand, and the fifth wrote plain `x`, so its bar jumped back to
 * nearly zero the moment the model finished and only caught up a tenth of the way in. That is
 * the symptom `openWindowModel.ts`' header already records in its own words ("makes the bar jump
 * backwards … which reads as a stalled download").
 *
 * **A leaf module, holding one expression and importing nothing.** It lived in
 * `openWindowModel.ts` for one round, which put `src/ml/session` and `src/ml/support` in the
 * module graph of `seam:loadMergeCandidates` — a node that opens no model and fetches two files over
 * HTTP. A shared arithmetic helper should not drag a GPU runtime behind it.
 */
export function afterShare(share: number, fraction: number): number {
  return share + (1 - share) * fraction
}
