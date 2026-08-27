/**
 * "Which datastack is this node pointed at" — the port, the field, and the three refusals.
 *
 * Three nodes ask that question (`CAVE table`, `List CAVE tables`, `CAVE table info`), a fourth
 * surface answers it again on a card, and the notebook exporter answers it a fifth time. They all
 * apply the same rule — **a wired Dataset wins over the typed field**, then `splitDatasetId` — and
 * they all decline in the same three ways. Written out per node, the *wording* of those refusals
 * duplicated too, so fixing a sentence shipped on two nodes and not the third.
 *
 * `annotationParams.ts` is the precedent one socket over: a lib module owning a port, its
 * resolver and its validate helper together, because those three are one decision.
 *
 * **The port is a reference, and that is the load-bearing part.** It names a datastack rather than
 * consuming a dataset, which is what makes `Dataset → CAVE table → Dataset` legal — two edges
 * between one pair in opposite directions is a cycle at node granularity, and `topoSort` returned
 * both nodes as `cyclic` with no result and nothing naming the cause. Nothing circular is being
 * *computed*: this reads the datastack's **identity**, a function of the dataset node's params
 * alone. Declaring it in one place is what stops a fourth node dropping `reference: true` and
 * going dark for a reason no test spanning two nodes would catch.
 */

import type { ParamDef, PortDef } from '../../core/node'
import type { CodaType } from '../../core/types'
import { T, datasetRef } from '../../core/types'
import type { Value } from '../../core/values'
import { splitDatasetId } from '../../data/cave/spec'
import { foreignBackend } from './datasetParam'

/** The reference Dataset port. See the header on why `reference` is not optional here. */
export const CAVE_DATASET_INPUT: PortDef = {
  id: 'dataset',
  label: 'Dataset',
  type: T.dataset(),
  required: false,
  reference: true,
}

/**
 * The typed fallback. `help` is an argument because what the field means differs per node — on
 * `CAVE table` it is how you read a table out of a *different* datastack than the one being
 * annotated, which is a sentence the other two have no use for.
 */
export function caveDatastackParam(help: string): ParamDef {
  return {
    id: 'datastack',
    kind: 'string',
    label: 'Datastack',
    placeholder: 'flywire_fafb_public:783',
    help,
    default: '',
  }
}

/**
 * Which datastack and materialization, from a wire or from a field.
 *
 * Takes a `datasetId` rather than a context, because the callers hold different things: inference
 * has a `CodaType`, `evaluate` has a `DatasetValue`, and the card has neither. A shape covering
 * all three would be a union nobody can read; the one thing each can supply is the id.
 *
 * Through `splitDatasetId` either way, so there is one reader of the
 * `datastack:materialization` grammar rather than a spelling of it per caller.
 */
export function caveTarget(
  datasetId: string | undefined,
  params: Record<string, unknown>,
): { datastack: string; version: number } | undefined {
  const id = datasetId ?? String(params.datastack ?? '').trim()
  return id ? splitDatasetId(id) : undefined
}

/** `caveTarget` from an edit-time context's port type. */
export function caveTargetOfType(type: CodaType | undefined, params: Record<string, unknown>) {
  return caveTarget(datasetRef(type)?.datasetId, params)
}

/** `caveTarget` from a run-time port value. */
export function caveTargetOfValue(value: Value | undefined, params: Record<string, unknown>) {
  return caveTarget(value?.kind === 'dataset' ? value.datasetId : undefined, params)
}

/**
 * The three things wrong with "which datastack" that a card can see, worded for the card.
 *
 * Empty means nothing is wrong *yet* — a reference socket left unwired on purpose with the field
 * filled in is the ordinary case, and so is a wire whose type has not resolved (invariant 2).
 *
 * All three of these used to be thrown from `data/annotations/caveTable.ts` at Run instead, as
 * `"…" does not name a CAVE dataset. Expected datastack:materialization.` — a message about a
 * grammar, three layers below the field that caused it.
 */
export function caveDatastackIssues(
  inputType: CodaType | undefined,
  params: Record<string, unknown>,
): string[] {
  /*
   * The wire first, since it wins. This port names a datastack, so a Dataset from any other
   * backend used to be handed straight through as one: `male-cns:v1.0` split on the colon gives a
   * version of `v1.0`, and the message that came back was about the grammar rather than the wire.
   */
  const foreign = foreignBackend(inputType, 'cave')
  if (foreign) {
    return [
      `A ${foreign} dataset names no CAVE datastack — wire a CAVE Dataset here, or unwire ` +
        `this input and name the datastack instead`,
    ]
  }
  const datastack = String(params.datastack ?? '').trim()
  if (!inputType && !datastack) {
    return ['Name a datastack, e.g. flywire_fafb_public:783 — or wire one to the Dataset input']
  }
  /*
   * The typed half. `datastack:materialization` is the whole grammar and the field's help says
   * so, but the placeholder is the only thing that shows the colon — so a bare
   * `flywire_fafb_public` is the obvious thing to type. Only checked when nothing is wired, since
   * a wire makes the field inert and a stale value in an inert field is not worth reporting.
   */
  if (!inputType && !splitDatasetId(datastack)) {
    return [`"${datastack}" names no materialization — CAVE numbers them, e.g. ${datastack}:783`]
  }
  return []
}
