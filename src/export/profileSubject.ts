/**
 * What a Neuron Profile export is *about* — the one place both emitters ask.
 *
 * The rule is a fact about `out.profile` rather than about either language, and it is subtle
 * enough to be worth exactly one home: **a pin under a grouping is one group's members**, so
 * exporting only those would make every group in the emitted frames the one that happened to be
 * pinned. Ungrouped, a pin *is* the subject and narrowing to it is right. Spelled out per
 * emitter, a third backend — or a change to what a pin means — has to find both copies, and the
 * one that is missed still emits perfectly plausible code.
 *
 * Widening is safe to prefer because it costs nothing: all three fetches behind `coda_profile`
 * take the id list whole, so a hundred neurons is the same three requests as one.
 *
 * Here rather than in `src/nodes/output/profile.ts` because it is export-only policy, and the
 * neighbours (`canExport.ts`, `order.ts`) are the other language-neutral export rules. If a
 * second per-node export rule ever lands beside it, move them both to their nodes instead —
 * two is where this directory starts being a grab bag.
 *
 * The caller formats — `pySelection` or `rVector` — because that is the only part that differs
 * between the two languages. Generic in the id type rather than fixed to `string`, because the
 * two `selectionIds` helpers do not agree about it: Python's answers exact decimal *text* for
 * invariant 8's reason, R's answers `number[]`. Reconciling those changes what the R exporter
 * emits and belongs nowhere near a helper about which ids to export.
 */
export function profileExportPin<Id>(
  selection: readonly Id[],
  groupBy: string | undefined,
): readonly Id[] | undefined {
  return selection.length > 0 && !groupBy ? selection : undefined
}
