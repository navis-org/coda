/**
 * The checkboxes that say **which neurons a dataset means**, and the rules around them.
 *
 * `edgeParams.ts`' shape, for controls that are neither sockets nor a panel. What is worth
 * stating here is the *reason they sit on the dataset node at all*, because Coda already tried
 * the other arrangement and removed it.
 *
 * `FindNeuronsRequest` used to carry a `statuses` field with a `Traced` default, and Find
 * Neurons drew it as a **Status** box. It was taken out because the default reached backends
 * with no `status` column — filtering a CAVE datastack on a field it does not have and
 * returning nothing at all for a value nobody chose. See `findNeurons.ts`' header and
 * `FindNeuronsRequest.rows`.
 *
 * This is the same question asked one level up, and three differences make it safe. They are
 * **gated on the backend** (`DatasetBackend.population`), so they exist only where the columns
 * do. Each is **dropped again** if the dataset in hand publishes no such column
 * (`resolvePopulation`), which errs towards too many rows rather than none — the direction
 * somebody can see — and the node warns. And they are asked **once per dataset** rather than
 * once per query: "this graph is about male-CNS's classified neurons" is a property of the
 * dataset, and restating it on every Find Neurons below is how two of them come to disagree.
 *
 * **They are OR-ed.** Ticking a second box lets *more* rows through, not fewer — see
 * `PopulationFilter`, which is where that decision is recorded. Nothing in this file joins them;
 * it only says which are asked for.
 */

import type { ParamValues } from '../../core/node'
import type { CodaType, PopulationFilter, TableSchema } from '../../core/types'
import { datasetRef } from '../../core/types'
import type { DatasetValue } from '../../core/values'
import type { DataSource } from '../../data/source'
import { populationColumns, resolvePopulation } from '../../data/neuronFilter'
import { schemasFromType } from './datasetParam'

interface PopulationParamSpec {
  filter: PopulationFilter
  id: string
  label: string
  help: string
}

/**
 * One checkbox per filter, and the param id each is stored under.
 *
 * A table rather than three declarations, because five things iterate it — the node factory, the
 * card, `validate`, and both export emitters — and a fourth filter added as a declaration is a
 * fourth filter four of those five silently ignore.
 *
 * **None is `presentational`** and none is hidden behind `visibleIf`: each decides which neurons
 * every query below returns, so all belong in the provenance key (invariant 4). All three *are*
 * `advanced`, which is a different thing: the param still exists, is still stored and is still in
 * the key, it is only drawn in the inspector rather than on the card. What answers the old
 * complaint — that the arrangement this replaces was a default nobody could see — is
 * `populationSummary`, which puts the *effect* on the card in one line. Three checkboxes on a
 * 268px card said the same thing in more space and less clearly.
 */
const POPULATION_PARAMS: readonly PopulationParamSpec[] = [
  {
    filter: 'traced',
    id: 'tracedOnly',
    label: 'Traced only',
    help: 'Keep neurons whose status is "Traced" — the convention for a proofread body. Combined with the other two by OR, so ticking a second box lets more neurons through rather than fewer.',
  },
  {
    filter: 'typed',
    id: 'typedOnly',
    label: 'Typed only',
    help: 'Keep neurons carrying a cell type — any column whose name ends in "type", so a neuron named only in another dataset’s nomenclature still counts. Combined with the other two by OR.',
  },
  {
    filter: 'superclass',
    id: 'superclassOnly',
    label: 'Superclass only',
    help: 'Keep neurons with a superclass — the coarsest classification, which some datasets publish and others do not. Combined with the other two by OR.',
  },
]

/**
 * The three params, with this family's defaults.
 *
 * Built per family rather than shared, because the sensible starting population is a fact about
 * the dataset: hemibrain is well typed, where male-CNS classifies by superclass.
 * `DatasetFamily.population` is that table; a family naming none gets every box off, which is
 * the honest default for a dataset nobody has looked at.
 *
 * `absentMeans: false` on every one of them, whatever the default. A stored node with no key for
 * a param predates the control and asked for every neuron, so its default and its absent value
 * are different answers — which is exactly what `ParamBase.absentMeans` is for. Without it
 * `ParamField` falls back to `default` and a card draws a ticked box over a query that filters
 * nothing. See `docs/datasets.md`.
 */
export function populationParams(defaults: readonly PopulationFilter[] = []) {
  return POPULATION_PARAMS.map((spec) => ({
    id: spec.id,
    kind: 'boolean' as const,
    label: spec.label,
    help: spec.help,
    default: defaults.includes(spec.filter),
    absentMeans: false,
    // Inspector-only, with `populationSummary` reporting the effect on the card. Being
    // `advanced` is also what puts them in the card's own `… N more (N changed)` hint, which is
    // the standard way a node says it has settings somewhere else.
    advanced: true as const,
  }))
}

/**
 * Which filters a dataset node's params ask for.
 *
 * **Absent is off, whatever the default.** Those describe different nodes rather than
 * conflicting: `defaultParams` writes a default in when a node is *created* and never runs over
 * `deserializeGraph`, so a graph saved before a param existed holds no key for it — and it
 * queried every neuron when it was built. Reading absence as the declared default would change
 * what somebody else's published graph returns, and its provenance key with it, on nothing more
 * than opening the file. `absentMeans` above is what stops a *stored* node ever being read this
 * way twice; this is the reading itself.
 *
 * Declaration order, not param order, so two nodes asking for the same set produce the same
 * clause and the same key whichever way the boxes were ticked.
 */
export function populationFrom(params: ParamValues): PopulationFilter[] {
  return POPULATION_PARAMS.filter((spec) => params[spec.id] === true).map((spec) => spec.filter)
}

/** The population half of a `DatasetValue`, spread into it. Absent rather than an empty list. */
export function populationValue(params: ParamValues): Pick<DatasetValue, 'population'> {
  const population = populationFrom(params)
  return population.length > 0 ? { population } : {}
}

/**
 * Whether a filter can apply to this dataset at all.
 *
 * **An unknown schema means yes**, which is the column picker's rule one layer up: a schema that
 * has not arrived is not a schema without this column in it. `discoveredNeuronSchema` is what
 * makes "unknown" distinguishable from "the canonical fallback", and undefined is the safe
 * answer at every call site here.
 *
 * One function rather than the same `length > 0` written at each surface, because the two that
 * read it have to agree: `populationSummary` claims a filter is being applied and
 * `populationIssues` claims one is not, and they are the two halves of one statement.
 */
function populationApplies(filter: PopulationFilter, schema: TableSchema | undefined): boolean {
  return !schema || populationColumns(filter, schema).length > 0
}

/**
 * The filters this node is actually applying, by label, for the one line the card carries.
 *
 * **What is applied, not what is ticked**, and the difference is the whole reason this is not
 * just a filter over the params. A box ticked for a column the dataset does not publish is
 * dropped before the query is built, so a card reporting it would be making a false claim about
 * the neurons downstream — and the honest channel for that box is `populationIssues`, which
 * names it and says the run returns more rows than it looks like. The card says what is
 * happening; the warning says what is not.
 *
 * Empty means the card draws no line at all rather than an empty one: a dataset with no
 * narrowing is the ordinary case and has nothing to report.
 */
export function populationSummary(
  params: ParamValues,
  schema: TableSchema | undefined,
): string[] {
  return POPULATION_PARAMS.filter(
    (spec) => params[spec.id] === true && populationApplies(spec.filter, schema),
  ).map((spec) => spec.label)
}

/**
 * Filters this node asks for that its dataset cannot answer, as edit-time warnings.
 *
 * **Warnings, not refusals**, and the asymmetry with the request seam is deliberate: the filter
 * is dropped before the query is built, so the run returns *more* rows rather than none. What
 * that leaves is a box that is ticked and doing nothing — the silent no-op the old `Traced`
 * default was, except failing in the direction somebody can see. Saying so is the whole fix.
 *
 * The second message exists only because the filters are OR-ed: with every disjunct dropped
 * there is no clause at all, so a card showing two ticked boxes returns the entire dataset.
 */
export function populationIssues(
  schema: TableSchema | undefined,
  params: ParamValues,
  datasetId: string | undefined,
): string[] {
  const asked = populationFrom(params)
  if (asked.length === 0 || !schema) return []
  const dropped = asked.filter((f) => !populationApplies(f, schema))
  if (dropped.length === 0) return []

  const names = dropped
    .map((f) => POPULATION_PARAMS.find((spec) => spec.filter === f)?.label ?? f)
    .join(' and ')
  const where = datasetId ?? 'This dataset'
  return dropped.length === asked.length
    ? [
        `${where} publishes no column for "${names}", so it cannot narrow this dataset — ` +
          `every neuron the server has will come through. Clear the box to say so.`,
      ]
    : [`${where} publishes no column for "${names}", so only the other filters apply here.`]
}

/**
 * The dataset's **own** neuron schema, or undefined while that is not yet known.
 *
 * The distinction this draws is the one that decides whether a warning is true. `schemasFor` is a
 * synchronous peek that also *starts* the fetch (invariant 2), and until it lands it hands back
 * the source's own fallback — the canonical seven columns, which carry `status` and `type` and no
 * `superclass`. Read as this dataset's schema, that says male-CNS publishes no superclass, which
 * is false and stops being false a moment later: a control greys itself and a warning appears,
 * both for a fact nobody has looked up yet.
 *
 * So: **a schema that has not arrived is not a schema without these columns in it.** That is the
 * rule a column picker already follows, one layer over. Compared by object *identity* rather than
 * by contents, because the contents are legitimately identical for a dataset that turns out to
 * publish only the canonical columns — hemibrain very nearly is one — and a contents comparison
 * would call that dataset's real, discovered schema unknown forever.
 *
 * Undefined is the safe answer everywhere it is used: `populationIssues` says nothing, and the
 * card leaves every box enabled.
 */
export function discoveredNeuronSchema(
  source: DataSource,
  datasetId: string | undefined,
): TableSchema | undefined {
  if (!datasetId || !source.schemasFor) return undefined
  const schemas = source.schemasFor(datasetId)
  return schemas === source.schemas ? undefined : schemas.neurons
}

/**
 * The filters a dataset **type** asks for, resolved against the schema that type names.
 *
 * For the surfaces that hold a type and no value: both export emitters, which write a document
 * from a graph that may never have run. One function rather than one per language — the
 * *spellings* differ per exporter and are deliberately separate, but which filters apply is one
 * question with one answer, and two copies of it is how a notebook and an R document come to
 * narrow differently from each other.
 */
export function populationFromType(type: CodaType | undefined): PopulationFilter[] {
  return resolvePopulation(datasetRef(type)?.population, schemasFromType(type).neurons)
}
