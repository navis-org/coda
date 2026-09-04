/**
 * The Synapses node's `Rows` control: what one point of the cloud counts.
 *
 * **The three backends enumerate synapses differently, and until this existed the node passed
 * whichever one along without saying so.** neuPrint returns a presynaptic site once per partner
 * neuron it drives — 4,491 rows for 1,015 T-bars on `male-cns:v1.0` body 10001 — where CAVE
 * returns predicted pre→post links and CATMAID returns connectors. Three different meanings for a
 * row, under one node, with nothing on the card distinguishing them. `data/synapseUnits.ts` holds
 * the measurements and why `sites` is what Automatic takes wherever it can be had.
 *
 * `skeletonParams.ts` is the template, down to the reasoning about a stored choice that cannot be
 * honoured — kept and reported, never substituted. What differs is where the answer comes from:
 * a skeleton route is a live question about a bucket somebody published, so its list is per
 * dataset and grows under the user as probes land. A unit is a property of the backend's
 * transport, known the moment a source is on the socket, which is why the list here is static and
 * why `synapseUnitProblem` can complain immediately rather than waiting for a peek.
 *
 * **Two transcriptions is where this stays.** The option builders are the same three conventions
 * twice — Automatic named after `[0]`, members listed only when there is a choice, a pinned entry
 * kept with one of three labels — and the drift has already cost one bug (see
 * `synapseUnitOptions`). A *third* pinned-choice control is the point at which they become one
 * `pinnedChoiceParam({ itemsFor, idOf, labelOf })` rather than a fourth copy, not the point at
 * which somebody notices.
 */

import type { EnumOption, InferContext, ParamDef } from '../../core/node'
import type { CodaType } from '../../core/types'
import type { ParamValues } from '../../core/node'
import { synapseUnitsOf } from '../../data/source'
import type { SynapseUnitId, SynapseUnits } from '../../data/synapseUnits'
import { asSynapseUnit, synapseUnitLabel, synapseUnitRefusal } from '../../data/synapseUnits'
import { sourceFromType } from './datasetParam'

/** Param ids, shared by the controls, the readers, `validate` and both exporters. */
export const SYNAPSE_UNIT_PARAM = 'synapseUnit'
export const MIN_CONFIDENCE_PARAM = 'minConfidence'

/**
 * The two controls read off a stored node, in the one spelling all three readers use.
 *
 * The node's `evaluate` and both exporters ask the same two questions, and the coercions had been
 * written out three times each — which is the boundary the export goldens exist to pin, so a drift
 * on absent or on a string-typed value would be invisible until somebody ran a notebook. `0` is
 * off for the confidence, and a `NaN` from a half-typed field is off too rather than a clause.
 */
export function pinnedSynapseUnit(params: ParamValues): SynapseUnitId | undefined {
  return asSynapseUnit(params[SYNAPSE_UNIT_PARAM])
}

export function minSynapseConfidence(params: ParamValues): number {
  return Number(params[MIN_CONFIDENCE_PARAM]) || 0
}

/** The units a Dataset socket's source can deliver, or undefined while nothing is wired. */
function unitsFromType(type: CodaType | undefined): SynapseUnits | undefined {
  return synapseUnitsOf(sourceFromType(type))
}

/**
 * The unit a node will actually fetch — the pinned one, or what Automatic resolves to.
 *
 * For readers that have the Dataset socket's type but not a live `DataSource` to hand, which is
 * both exporters. They branch on this, and writing that branch as "absent means sites" would have
 * made them a **third** decider of what Automatic means: reorder `NeuPrintSource.synapseUnits` and
 * the fetch, the dropdown label and both notebooks part company, with the goldens still green.
 * `undefined` here means nothing is wired to say, which the callers read as the neuPrint default
 * they are already restricted to.
 */
export function synapseUnitFor(
  type: CodaType | undefined,
  params: ParamValues,
): SynapseUnitId | undefined {
  return pinnedSynapseUnit(params) ?? unitsFromType(type)?.[0]
}

/**
 * The dropdown's entries.
 *
 * Automatic first and named after the unit it will actually take — `skeletonSourceOptions`'
 * rule, that "Automatic" alone is a provenance question mark on every graph anyone shares. The
 * named units are listed only when there is a choice, which today means only on neuPrint: one
 * unit is already the whole of what Automatic says, and offering CAVE a `sites` entry that
 * throws is a control whose only working setting is the default.
 */
function synapseUnitOptions(type: CodaType | undefined, chosen: string): EnumOption[] {
  const units = unitsFromType(type)
  const best = units?.[0]
  const options: EnumOption[] = [
    { value: '', label: best ? `Automatic (${synapseUnitLabel(best)})` : 'Automatic' },
  ]
  if (units && units.length > 1) {
    options.push(...units.map((u) => ({ value: u, label: synapseUnitLabel(u) })))
  }
  if (chosen && !options.some((o) => o.value === chosen)) {
    /*
     * Three different sentences, `skeletonSourceOptions`' set. A unit this source *does* serve but
     * which was not listed — every single-unit source, since a lone unit is already the whole of
     * what Automatic says — keeps its own label; one the source cannot serve says so; and one
     * whose source has not arrived yet says nothing, because "not available" while the Dataset
     * socket is still empty is how a perfectly good pinned choice comes to look broken. Dropping
     * the first of the three labelled CAVE's own `links` "not available here" while `validate`
     * said nothing was wrong — the two halves of one decision disagreeing on the card.
     */
    const served = units?.find((u) => u === chosen)
    options.push({
      value: chosen,
      label: served ? synapseUnitLabel(served) : units ? `${chosen} (not available here)` : chosen,
    })
  }
  return options
}

export function synapseUnitParam(): ParamDef {
  return {
    id: SYNAPSE_UNIT_PARAM,
    kind: 'enum',
    label: 'Rows',
    help:
      'What one point counts. A presynaptic site drives several partners, so “one row per ' +
      'connection” repeats it once each while “one row per site” returns it once. Backends ' +
      'differ in which they can answer; Automatic takes the one this source has.',
    default: '',
    options: (ctx: InferContext) =>
      synapseUnitOptions(ctx.inputs.dataset, String(ctx.params[SYNAPSE_UNIT_PARAM] ?? '')),
  }
}

/**
 * The edit-time complaint for a pinned unit this source cannot deliver.
 *
 * The sentence itself is `synapseUnitRefusal`'s, shared with the throw in `evaluate`, so the two
 * layers cannot describe one unit two ways — which they did while each built its own, one naming
 * `sites` and the other `one row per site`. Silent while no source is wired, for
 * `skeletonSourceProblem`'s reason: a refusal computed from nothing is one that clears itself a
 * moment later, and a card that flickers red on load teaches people to ignore it.
 */
export function synapseUnitProblem(
  type: CodaType | undefined,
  chosen: string,
): string | undefined {
  const units = unitsFromType(type)
  return units ? synapseUnitRefusal('This data source', asSynapseUnit(chosen), units) : undefined
}
