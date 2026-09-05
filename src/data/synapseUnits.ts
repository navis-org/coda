/**
 * What one row of a synapse point cloud *is*, named once.
 *
 * A backend does not hand back "the synapses". It hands back its own enumeration of them, and
 * the three in the tree enumerate different things — which was a silent disagreement until this
 * existed, because every one of them is a `PointsValue` with a `polarity` column and none of
 * them said what a row counted. Measured on the presynaptic side, which is where they diverge:
 *
 *  - **neuPrint** walks `(n)-[:Contains]->(:SynapseSet)-[:Contains]->(s:Synapse)`, and a neuron
 *    holds one `SynapseSet` per partner *neuron*, so a T-bar comes back once per partner it
 *    drives. On `male-cns:v1.0` body 10001 that is **4,491 rows for 1,015 T-bars**; on hemibrain
 *    it is 135,652 for 18,420, and on MANC 117,640 for 15,357.
 *  - **CAVE** stores predicted pre→post links, one row each with its own coordinate. There is no
 *    T-bar identity anywhere in the table — `pre_pt_supervoxel_id` is a supervoxel, not a site —
 *    so `sites` is not something a CAVE datastack can answer at all.
 *  - **CATMAID** answers `connectors/links/?relation_type=presynaptic_to`, which is one row per
 *    connector. Measured on FAFB skeleton 16: **1,709 rows, 1,709 distinct connectors**. So its
 *    natural unit is already the site, and `links` is what it cannot answer — the postsynaptic
 *    partner count per connector is a second POST to `connector/skeletons`.
 *
 * ## Why `sites` is what Automatic means wherever it is available
 *
 * neuPrint's extra rows carry no column that tells them apart. `neuprint/schema.ts` drops
 * `partnerId` from the synapse schema on purpose — resolving it turns one query into a heavy
 * join — so the 3,476 surplus rows on body 10001 are the same neuron, polarity, confidence and
 * *coordinate* repeated. They are duplicate points, not per-connection data, and they were
 * silently weighting a multi-partner T-bar 4–8× in syNBLAST and in every density measure.
 * Deduplicated, the count agrees with `n.pre`, with what Explore Dataset reports, and with
 * neuprint-python's own `fetch_synapses`, which carries the same `WITH DISTINCT n, s` and the
 * same comment.
 *
 * `links` stays reachable because a per-connection cloud is a real thing to want on a backend
 * whose rows carry a partner — which is CAVE's, and which is why its Automatic is `links`: it is
 * the only unit CAVE has, not a preference.
 *
 * ## The ids are shared across backends, deliberately
 *
 * `skeletonRoutes.ts`' reasoning exactly. They are stored in saved graphs and folded into
 * provenance keys (invariant 4), so an id here is as good as public API: rename one and every
 * graph pinned to it starts refusing.
 */

/**
 * Unit ids, as constants rather than string literals at each use site.
 *
 * The list a node offers and the branch a source takes are written in different files and are
 * the two halves of one decision — invariant 3's shape, one layer down.
 */
export const SYNAPSE_UNITS = {
  /** One row per synaptic connection: a presynaptic site repeats once per partner. */
  links: 'links',
  /** One row per synapse location, deduplicated. */
  sites: 'sites',
} as const

export type SynapseUnitId = (typeof SYNAPSE_UNITS)[keyof typeof SYNAPSE_UNITS]

/**
 * What a unit is called, in the one spelling every surface prints.
 *
 * `ROUTE_LABELS`' rule: a dropdown and a refusal reading two different phrases for one unit read
 * as two units — which is exactly what happened while the node and the source built their own
 * refusal sentences, one naming `sites` and the other `one row per site`. There is deliberately no
 * third reader: a `PointsValue` carries no unit, so nothing prints this after a run. See
 * `docs/nodes.md` on what that costs a syNBLAST fed two clouds counted differently.
 */
const UNIT_LABELS: Readonly<Record<SynapseUnitId, string>> = {
  links: 'one row per connection',
  sites: 'one row per site',
}

export function synapseUnitLabel(id: SynapseUnitId): string {
  return UNIT_LABELS[id]
}

/**
 * A stored param value as a unit id, or `undefined` for anything this build does not know.
 *
 * `asSkeletonRoute`'s narrowing and for its reason: a graph written by a later build can name a
 * unit this one has never heard of, and reading that as "nobody chose" is the same degradation
 * every other unknown param value gets.
 */
export function asSynapseUnit(raw: unknown): SynapseUnitId | undefined {
  const id = String(raw ?? '')
  return (Object.values(SYNAPSE_UNITS) as string[]).includes(id)
    ? (id as SynapseUnitId)
    : undefined
}

/**
 * A source's units, best first — the non-empty half of `DataSource.synapseUnits`.
 *
 * A tuple rather than an array because `[0]` is load-bearing twice (it is what Automatic takes
 * *and* what the dropdown prints), so a source declaring nothing has no honest answer to either.
 * Typed rather than checked: every declaration satisfies it through `as const`, and it is what
 * lets `resolveSynapseUnit` have no "said nothing" branch to disagree with `synapseUnitsOf` about.
 */
export type SynapseUnits = readonly [SynapseUnitId, ...SynapseUnitId[]]

/**
 * Why a pinned unit cannot be served, or `undefined` when it can.
 *
 * **One sentence with two renderers**, which is `UNIT_LABELS`' own rule applied to the layer
 * above it: the node's `validate` shows this at edit time and its `evaluate` throws it at run
 * time, and written separately the two promptly said `“sites”` and `“one row per site”` about the
 * same refusal. `canTracePaths` records the same incident for a predicate that had three readers
 * in three layers.
 */
export function synapseUnitRefusal(
  label: string,
  requested: SynapseUnitId | undefined,
  served: SynapseUnits,
): string | undefined {
  if (!requested || served.includes(requested)) return undefined
  return (
    `${label} cannot return synapses as “${synapseUnitLabel(requested)}” — it offers ` +
    `${served.map(synapseUnitLabel).join(', ')}. Set the Synapses node's Rows back to ` +
    `Automatic, which takes whichever unit this source has.`
  )
}

/**
 * The unit a fetch will use: the pinned one, or the source's own first choice.
 *
 * **One function rather than a check and a fallback**, because the two halves are the thing that
 * drifts: `served[0]` is what "Automatic" resolves to and it is also what the node's dropdown
 * *prints* as Automatic, so a source that ordered its list one way and branched the other would
 * have a control naming a unit it does not deliver.
 *
 * **Called once, by the node**, and not by each source — which is where it differs from
 * `requireSkeletonRoute`, whose per-source home is earned by a per-*dataset* half the source has
 * to answer anyway (CAVE still refuses `published` on an unflattened materialization). A unit
 * varies with nothing, so a copy inside each `fetchSynapses` was three re-derivations of a static
 * fact the one caller already held, discarding the return in all three — and a fourth place for a
 * new backend to forget. `SynapseRequest.unit` being required is what replaces them.
 *
 * A pinned unit the source cannot serve is an **error, never a substitution** —
 * `GeometryRequest.skeletonSource`'s rule. Answering with the other unit would silently change
 * what a row of the cloud counts, which is what a syNBLAST and every density measure read.
 */
export function resolveSynapseUnit(
  label: string,
  requested: SynapseUnitId | undefined,
  served: SynapseUnits,
): SynapseUnitId {
  const refusal = synapseUnitRefusal(label, requested, served)
  if (refusal) throw new Error(refusal)
  return requested ?? served[0]
}

/**
 * What a source says when `minConfidence` reaches it and it has nothing to apply it to.
 *
 * One sentence rather than each backend's own, which is the half of `requireSkeletonRoute`'s
 * docstring that is about *wording* — "two wordings of it in the two that did". Two callers
 * today: a CAVE datastack whose synapse table declares no score column, and the mock. Silence was
 * defensible only while the node's default was 1 and excluded nothing; a control that starts at
 * off is one somebody has set by the time it arrives here.
 */
export function confidenceIgnoredWarning(subject: string): string {
  return `${subject} has no per-synapse confidence, so Min confidence was ignored — every synapse is in the result.`
}
