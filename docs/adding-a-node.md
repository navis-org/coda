# Adding a node

Nodes are the main extension point. A node is declarative data plus two functions.

## The shape

```ts
import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import { isTableValue } from '../../core/values'

export const myNode = registerNode({
  type: 'core.myThing',        // namespaced, stable — it's persisted in graph files
  label: 'My Thing',
  category: 'table',           // input | query | table | analysis | output | utility
  description: 'One line, shown in the palette and as the header tooltip.',
  guide: 'Two or three sentences for the node guide. Required — see "Prose" below.',
  cost: 'cheap',               // see "Cost" below — this is not a cosmetic choice

  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],

  params: [
    { id: 'column', kind: 'column', label: 'Column', from: 'in', dtypes: NUMERIC_DTYPES, default: '' },
    { id: 'factor', kind: 'number', label: 'Factor', default: 1, min: 0, step: 0.1 },
  ],

  // Edit time. No data, no network, must not throw.
  inferOutputs: (ctx) => ({ out: T.table(ctx.schema('in')) }),

  // Edit time. Problems shown on the node as warnings.
  validate: (ctx) => (ctx.column('column') ? [] : ['Pick a numeric column']),

  // Run time. Gets realised values.
  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    const columnName = ctx.column('column')
    if (!columnName) throw new Error('No column selected')
    return { out: doTheThing(table, columnName, Number(ctx.params.factor)) }
  },
})
```

Then export it from [`src/nodes/index.ts`](../src/nodes/index.ts). That file is the node
pack; importing it registers everything.

## Prose

Two fields, read in two places at two different moments, and both are required.

`description` is **one line**, sized for a palette row and the node browser. Somebody reading it
already knows roughly what they want and is scanning for the name.

`guide` is **two or three sentences** for [the node guide](../nodes.html) (`nodes.html`), read by
somebody deciding whether this is the node at all. Say what it is for, what it hands on, and the
one thing that surprises people about it — the trade you made, the parameter that is not what it
looks like, the failure it is easy to walk into. It is prose, not markdown: the guide renders it
as a paragraph, and a subset parser there would be a second copy of `ui/markdown.ts` on a page
that deliberately imports nothing.

Collapsing the two would make one of them wrong: a palette row wrapping to four lines, or a guide
entry that says nothing. `nodeGuide.test.ts` fails a node that ships without a `guide`, or one
whose `guide` merely repeats its `description`.

Everything else on the guide page is derived — sockets, settings, defaults, the preview card, the
"seen in" cross-reference against the bundled examples. Adding a node is these two strings and
nothing else; see `src/nodeguide/data.ts`.

**A third length exists and is optional.** A node whose behaviour genuinely needs pages — NBLAST,
the clustering pair, anything with a non-obvious implicit rule — gets a markdown file at
`src/help/nodes/<type>.md`, which puts a `?` on its card opening an in-app document with figures
drawn from the registry. The file's existence *is* the switch; there is nothing to declare here.
Most nodes should not have one: if the surprising thing fits in `guide`, it belongs in `guide`.
See [docs/help.md](help.md).

## Cost

| | when it runs | use for |
|---|---|---|
| `cheap` | automatically, ~180ms after an edit | pure in-memory work on already-fetched data |
| `expensive` | only on **Run** | anything touching a backend, or heavy CPU |

Getting this wrong is the most user-visible mistake you can make: marking a query `cheap`
means every keystroke in a text field fires a request at a shared database.

## `inferOutputs` — the part that's easy to skip and shouldn't be

This runs on **every graph mutation**, with types only. It's what makes column pickers
downstream of your node work before anything has executed.

- Must be fast and **must not throw** — return the declared static type if inputs are
  missing or inconsistent.
- If your node changes the column set (aggregate, pivot, select, join), compute the new
  schema here. If it preserves it, pass the input schema through.
- Preserve `neurons`-ness when your node preserves the `neuronId` column — that's what keeps
  a filtered neuron table pluggable into `Connectivity Graph`:

```ts
inferOutputs: (ctx) => {
  const input = ctx.inputs.in
  if (!isTabular(input)) return { out: T.table() }
  return { out: input.kind === 'neurons' ? T.neurons(schemaOf(input)) : T.table(schemaOf(input)) }
}
```

### Keep the schema half and the value half together

If your node reshapes a table, write the schema computation and the data computation as a
pair in [`src/nodes/lib/tableOps.ts`](../src/nodes/lib/tableOps.ts):

```ts
export function myOpSchema(schema, params) { /* schema in, schema out */ }
export function myOpTable(table, params)   { /* values in, values out */ }
```

They **must agree**. If `myOpSchema` promises a `sum_weight` column and `myOpTable` emits
`total`, everything downstream breaks only *after* a run — the worst kind of bug to trace.
`tableOps.test.ts` asserts the agreement for every existing op; add a case for yours.

### When the columns *are* data values

There is one shape this cannot cover: a node whose output columns are named by the data
rather than by its params. `Pivot`'s wide table has one column per distinct value of the
Columns field, and `Cypher` gets its columns back from the server — neither is knowable
without running, and `inferOutputs` may not fetch.

That is what `observesOutputSchema: true` is for. The store feeds the node's last realised
table schema back in as `ctx.observed`, so `inferOutputs` returns `T.table(ctx.observed)` and
downstream pickers fill the moment it has run. Reach for it only when the shape genuinely
cannot be derived: it is empty before the first run and empty again after a reload, so
anything derivable must be derived instead.

## Params

| kind | notes |
|---|---|
| `number` / `int` | `min`, `max`, `step`. Drag-to-scrub in the UI. |
| `string` | `placeholder`, `multiline`. Debounced. |
| `boolean` | |
| `enum` | `options` is a static array **or** `(ctx) => EnumOption[]`, so it can read the upstream schema or dataset metadata (ROI lists, statuses). |
| `column` | Single column from input `from`, optionally restricted by `dtypes`. |
| `columns` | Ordered multi-select, rendered as chips. |
| `ids` | Opaque `string[]` a widget writes rather than a hand-typed field. Two shapes use it: a viewer's selection, and a **list somebody grows** — `out.table`'s filter clauses and `core.rename`'s remappings are JSON pairs stored this way, because the number of them is not known when the definition is written. A node doing that needs a custom body (`ui/nodes/nodeBodies.ts`) and a codec beside the op; see `nodes/lib/renames.ts`. |

Two flags worth knowing:

- `advanced: true` hides it from the node body; it still shows in the inspector. Use it to
  keep nodes compact without hiding functionality.
- `visibleIf: (params) => boolean` for conditional params. Hidden params are **excluded
  from the cache key**, so toggling an aggregation from `sum` to `count` doesn't leave a
  stale value column influencing freshness.

### Always resolve column params through the context

`ctx.column('id')` / `ctx.columns('id')` — never read `ctx.params.column` directly. The
resolver falls back to the first compatible column when the stored one has disappeared
upstream, and **infer, validate, evaluate and the cache key all use the same resolution**.
Reading the raw param bypasses that and desynchronises them.

## Determinism and the cache

The cache key is provenance — `(type, params, upstream keys)` — not data. So `evaluate`
must be deterministic for fixed inputs.

If your node depends on hidden mutable state (a live server whose contents changed), it
needs an explicit escape hatch: an `int` param the user can bump to force a re-run. See the
`refresh` param on [the Dataset node](../src/nodes/query/dataset.ts).

## Errors

Throw from `evaluate` with a message a scientist can act on. It lands on the node and in
the inspector, and downstream nodes go `blocked`.

```ts
throw new Error(`Column "${name}" not found. Available: ${names.join(', ')}`)
```

Include what was expected and what was available. `"invalid input"` costs someone ten
minutes.

## Long work

`evaluate` gets `ctx.signal` (an `AbortSignal`) and `ctx.progress(fraction, note)`.

- Check `signal.aborted` in long loops, or pass it to `fetch`.
- Report progress; it drives the hairline bar on the node.
- Aborted runs must reject, not resolve with partial data.

## Adding a dataset

A dataset does not need a node file. Add an entry to `DATASET_FAMILIES` in
[`src/nodes/lib/datasetFamilies.ts`](../src/nodes/lib/datasetFamilies.ts) and the factory builds
the node, its version dropdown and its body:

```ts
{
  key: 'malecns',          // node type is `dataset.malecns` — never change one that shipped
  sourceId: 'neuprint',
  family: 'male-cns',      // family half of a `family:version` dataset id
  label: 'MaleCNS',
  description: '…',
  guide: '…',              // the node guide's paragraph; the factory passes it through
  glyph: 'cns',            // brain | vnc | cns | optic | specimen
  // synthetic: true,      // generated in the browser: no Description companion, nobody to cite
}
```

Carry only presentation there. Versions, ROIs, schemas and neuron counts are read from the source
at runtime and must never be hard-coded — the table exists because node types have to be
registered before a saved graph is deserialised, not because the data is static.

## Companion nodes

A node can declare a second node that arrives already wired to it:

```ts
companion: { type: 'dataset.description', from: 'dataset', to: 'dataset', offset: { x: 0, y: 300 } }
```

Dataset nodes are the only user so far: a connectome is somebody's years of reconstruction work,
published with a request for attribution that a picker labelled "MaleCNS" gives no hint of, so the
credit arrives on the canvas and has to be dismissed rather than sought out.

Three properties to preserve if you add another:

- **A suggestion, not a fixture.** The companion is an ordinary node afterwards — delete it, move
  it, add it back from the palette. Nothing re-creates it and nothing may depend on it existing.
- **On add, never on load.** [`addNodeWithCompanion`](../src/core/companion.ts) is called from the
  store's `addNode` and from the starter builder. A file that grew a node every time it opened
  would be unusable.
- **One undo step.** Host and companion go in through a single `commit`.

It lives on the `NodeDefinition` because "this node comes with that one" is a fact about the node
pack rather than about React — the headless starter graphs go through the same function.

## Retiring a node

Set `hidden: true` rather than deleting it. Registration is what makes an old file load — an
unregistered type renders as "Unknown node" and drops its params — while `listableNodeDefs()`,
which the palette and browser read, leaves it out. `neuron.dataset` is the worked example.

## When the node needs its own UI

A node whose purpose is to be *looked at* rather than configured — Explore Dataset, the dataset nodes and
the Description card — can draw its own body instead of a list of param fields. Register a component in
[`src/ui/nodes/nodeBodies.ts`](../src/ui/nodes/nodeBodies.ts), keyed by node type:

```ts
export const NODE_BODIES: Record<string, NodeBodyEntry> = {
  'neuron.explore': { Component: ExploreBody, width: 520 },
}
```

A body that renders text a *source* supplied — the Description card is the one so far — must go
through [`MarkdownView`](../src/ui/MarkdownView.tsx) rather than building HTML. It parses to an
AST that becomes React elements, so nothing arriving over the network can become markup or a
live `javascript:` target.

Three rules:

- **The registry lives in the UI, not on the `NodeDefinition`.** A definition is in `src/nodes`
  and must stay headless; a React component in one breaks the boundary that keeps a non-browser
  consumer possible.
- **The body still uses real params.** It reads `node.params` and writes through `setParam`, so
  everything it changes is saved, undoable and part of the provenance key. Params it manages
  itself should be marked `advanced` so they do not also appear as fields in the inspector.
- **It renders in the card *and* in the full-size overlay** from one prop bundle, distinguished
  only by `compact`. Design for both, or it ships working in one — and set `expandable: true`
  only if there is something worth enlarging, since that is what puts the button on the node.

Widgets that write on every keystroke should follow Explore Dataset's split: filter locally and
immediately for the user, and commit to a param on a debounce so downstream staleness stays
meaningful. Anything purely about *viewing* — a page number, a zoom — belongs on a
`presentational: true` param so it cannot invalidate a result.

## Adding a data source

Implement [`DataSource`](../src/data/source.ts) and `registerSource(new MySource())`.

Optional methods are worth knowing about: `neuronIndex` supplies a dataset's whole neuron table
so Explore Dataset can browse it (implementations must cache and deduplicate — see
[`src/data/neuronIndex.ts`](../src/data/neuronIndex.ts)), and `fetchCoarseGeometry` returns the
cheapest possible mesh for one neuron, for thumbnails. Both may be omitted, and
`fetchCoarseGeometry` may resolve `undefined` to mean "nothing cheap here" — that becomes a
placeholder rather than an expensive download.

The non-negotiable bit: `schemas` is **static and synchronous**, because schema inference
runs at edit time. Map onto `CANONICAL_SCHEMAS` where the concept exists — nodes address
columns by name, so extra columns just give the user more to pick from. `peekDataset` is a
synchronous cache read that may return `undefined` before `listDatasets` resolves; that's
expected, and edit-time enums degrade to empty rather than blocking.

## Tests

- Table ops → a case in `tableOps.test.ts`, including the schema/value agreement check.
- New node in a pipeline → extend an example, or add a graph in `scheduler.test.ts`.
- Anything user-visible → the examples suite runs all three example graphs end to end and
  asserts they infer cleanly, have zero warnings, and produce non-empty output.
