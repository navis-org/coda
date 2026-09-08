/**
 * The ROI Viewer's params, decoded once for everyone who asks.
 *
 * `regionOptions` in `connectivityOps.ts` makes this argument for the same-named param on
 * `neuron.connectivity`, and it applies here with a demonstrated history behind it: `!== false`
 * is a claim about what an **absent** key means on a stored document, and this is the param that
 * shipped declared, documented and honoured by both emitters while the card ignored it entirely
 * (see `docs/widgets.md`). Four readers had their own copy of the reading — the card, the
 * outline loader, and both exporters — which is exactly the shape that let the two halves
 * disagree for as long as they did.
 *
 * Headless and in `nodes/lib` rather than on the node, because the exporters import from here
 * and must not pull a node definition in — the route `regionOptions` and `readUnpivotSpec`
 * already take.
 */

/**
 * Whether the card draws only the regions that tile the volume.
 *
 * Absent means the declared default, which is `true` — and is also the smaller of the two
 * downloads, so a graph saved before this param existed asks for what it always asked for.
 */
export function roisPrimaryOnly(params: Record<string, unknown>): boolean {
  return params['primaryOnly'] !== false
}
