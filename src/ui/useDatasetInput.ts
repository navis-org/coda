/**
 * What a widget body reads off its Dataset input: which dataset, its annotation chain, and whether
 * to wait. Shared by Explore Dataset and the Cortex gallery, which each load a dataset's whole
 * index outside Run and so need the same three rules — each learnt the hard way, and each easy to
 * lose in a second copy.
 *
 * **The value's dataset id when there is one, the type's otherwise — never one paired with the
 * other's chain.** A dataset node on "Latest" publishes no id until its listing lands, so the
 * type's can be absent or older than the value's, and an index fetched for one while carrying the
 * other's labels would be cached under a key claiming a pairing that never existed. Same reasoning
 * as `datasetRequest`, which exists so a call site cannot supply one without the other.
 *
 * **The chain comes off the value, not the type.** A dataset *type* carries the annotation
 * chain's schema; only the `DatasetValue` carries its table, because that table is a fetch
 * somebody's Run paid for. On a datastack that publishes a neuron table this is a labelling
 * improvement; on one that publishes none it is the difference between working and not, since
 * there the chain *is* the neuron list. That departs from "this widget loads independently of any
 * run", bounded to what cannot be had otherwise: with nothing wired, or before a run, it behaves
 * exactly as it always did.
 *
 * **A chain wired but not yet run means wait, not load.** The *type* says a chain is there the
 * moment the wire is drawn; only the value carries its table. Loading anyway downloads the whole
 * index under the unannotated key and then a second time under the annotated one the instant a
 * Run lands — on FlyWire that is 139,255 rows and about seven seconds thrown away, and both tables
 * are then retained for the life of the tab, since the shared entry map is never evicted. It is
 * also the *wrong* list to show: the labels are the backend's, which is the gap the chain was
 * wired to close. Read off the type rather than off the source's refusal, which once coupled this
 * empty state to the wording of one sentence in `src/data`.
 */

import type { InferContext } from '../core/node'
import type { PopulationFilter } from '../core/types'
import { datasetRef } from '../core/types'
import type { DatasetAnnotations, Value } from '../core/values'
import { isDatasetValue } from '../core/values'

export interface DatasetInput {
  sourceId: string | undefined
  datasetId: string | undefined
  annotations: DatasetAnnotations | undefined
  /** A chain is wired and has not run: wait rather than load the unlabelled index. */
  awaitingRun: boolean
  /** The dataset's population checkboxes, off the type — decided by checkboxes, not by a Run. */
  population: readonly PopulationFilter[] | undefined
}

export function useDatasetInput(
  ctx: InferContext,
  inputValues: Record<string, Value | undefined> | undefined,
): DatasetInput {
  const value = inputValues?.dataset
  const type = ctx.inputs.dataset
  const ref = isDatasetValue(value) ? value : datasetRef(type)
  const annotations = isDatasetValue(value) ? value.annotations : undefined
  const chainWired = type?.kind === 'dataset' && type.annotations !== undefined
  return {
    sourceId: ref?.sourceId,
    datasetId: ref?.datasetId,
    annotations,
    awaitingRun: chainWired && !annotations,
    population: datasetRef(type)?.population,
  }
}
