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
 * between the two languages. It *was* generic in the id type, because the two `selectionIds`
 * helpers did not agree about it: Python's answered exact decimal text for invariant 8's reason
 * and R's answered `number[]`, and reconciling them was said to belong nowhere near a helper
 * about which ids to export. They agree now — both answer text, because every id column they are
 * compared against is `str` — so the generic is a parameter no caller varies.
 */
export function profileExportPin(
  selection: readonly string[],
  groupBy: string | undefined,
): readonly string[] | undefined {
  return selection.length > 0 && !groupBy ? selection : undefined
}
